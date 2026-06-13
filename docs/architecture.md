# Architecture — Claude Session Manager

This document explains the runtime architecture, with emphasis on the
performance work that lets a single Node process serve **1.9 GB+** of `.jsonl`
conversation history without re-reading files on every request.

For the file-by-file map, see [`../CLAUDE.md`](../CLAUDE.md). This doc covers the
*why* and the *data flow*; CLAUDE.md covers *where*.

## 1. Topology

```
                ┌──────────────────────────────────────────────────────┐
   ~/.claude/   │  Node process (single, no DB)                         │
   projects/    │                                                       │
   *.jsonl ─────┼─► chokidar watcher ─► invalidation + SSE broadcast    │
       ▲        │                         │            │                │
       │ read   │   ┌─────────────────────┘            └─► browser (SSE)│
       │ only   │   ▼                                                    │
       │        │  caches (in-memory mirror + persistent on disk)       │
       │        │   • meta-cache    → cache/meta/{projectId}.json        │
       │        │   • offset-cache  → cache/offsets/{proj}__{sess}.json  │
       │        │   • search index  → cache/search/{index,manifest}.json │
       │        │                                                        │
       │        │  Express API (/api/v1/*) ──► React SPA (Virtuoso)      │
       └────────┤                                                        │
   writes never │  cache/ + trash/ + auth.json live in                  │
   touch source │  ~/.claude-session-manager/  (NOT ~/.claude)           │
                └──────────────────────────────────────────────────────┘
```

**Hard invariant:** the app only ever *reads* `~/.claude`. All app state
(caches, trash, auth) lives under `~/.claude-session-manager/`. Deletes move
files to `trash/`; with a read-only source mount the original is preserved and
still tracked in trash. See `server/services/session-manager.ts`.

## 2. The performance problem

A naive implementation re-streams a whole `.jsonl` (tens of MB) for every list,
detail, and audit request. With thousands of sessions and multi-GB files this
makes list views and deep scrolling unusable. Three caches plus seek-based
pagination remove the repeated full scans. All three caches share the same
**self-consistency rule**: an entry is valid only while the source file's
`mtimeMs` **and** `size` match the values captured when the entry was written.
Any mismatch ⇒ the entry is ignored and rebuilt. No content hashing is needed.

## 3. Caching layers

### 3.1 Meta cache — `server/services/meta-cache.ts`

Per-**project** JSON file at `cache/meta/{projectId}.json`, holding one entry
per session: `{ mtimeMs, size, meta }`. `listSessions()` calls `getOrParseMeta`
per file; on a hit (stat matches) it returns cached `SessionMeta` without
touching the `.jsonl`.

Design choices worth keeping:
- **One file per project, not per session** — keeps the inode count flat as the
  workspace grows past thousands of sessions.
- **In-memory mirror** (`indexCache`) so repeated `listSessions()` calls don't
  re-read the JSON.
- **Atomic writes** via `writeFile(tmp)` + `rename` to avoid torn reads.
- **Per-project save lock** serializes concurrent writes (a Promise chain in
  `saveLocks`); callers mark the index dirty and a single `saveProjectIndex`
  flushes the batch.

Side effect: when `getOrParseMeta` parses a file it also refreshes that
session's **offset sidecar** (§3.2). A schema-version bump (`SCHEMA_VERSION`)
silently invalidates the whole file.

### 3.2 Offset cache (byte-offset sidecars) — `server/services/offset-cache.ts`

Stores periodic `{ uuid → byteOffset }` **anchors** per session at
`cache/offsets/{projectId}__{sessionId}.json`, so paginated reads can `seek`
straight to a cursor's byte position instead of linear-scanning the file head
every page. This is what turns deep scroll from O(file) into O(page).

- Anchors are sampled every **`ANCHOR_EVERY = 100`** *visible* messages, produced
  as a side effect of `parseSessionMeta` (`jsonl-reader.ts`).
- The default page size is **200**, a multiple of 100, so every `nextCursor`
  lands exactly on an anchor. Non-aligned cursors simply miss and fall back to a
  file-head scan — correct, just slower.
- Byte offsets are computed as `Buffer.byteLength(line, 'utf-8') + 1` (the
  trailing `\n`). This assumes `\n` line endings (always true for jsonl) and is
  self-consistent with `createReadStream({ start })` reads.

> **Import-cycle note:** `ANCHOR_EVERY` and the anchor shape are intentionally
> duplicated between `offset-cache.ts` and `jsonl-reader.ts` (as
> `META_ANCHOR_EVERY` / `MetaAnchor`) to avoid a circular import. If you change
> the cadence, change it in **both** places.

### 3.3 Search index — `server/services/search-engine.ts`

In-memory MiniSearch index persisted to `cache/search/{index,manifest}.json`.
The `manifest` records `perFile: { absPath → {mtimeMs, size, id} }` to drive
incremental reconcile.

Lifecycle:
1. **Boot:** `loadIndex()` (MiniSearch `loadJSON`) → if missing/stale-schema,
   `buildIndex()` (full walk) → `reconcile()` against the live filesystem to
   absorb changes that happened while the process was down.
2. **Live:** chokidar `add/change/unlink` → `onFileEvent` does incremental
   `discard` + `add` (searchable within ~1s).
3. **Persist:** writes are **debounced** — `PERSIST_DEBOUNCE_MS = 30s` settle
   window, capped by `PERSIST_MAX_WAIT_MS = 60s` so a chatty session still
   flushes. `persistIndex()` also runs on graceful shutdown.

Indexed text is capped at 50 000 chars per session; fields are boosted
(`summary ×2`, `projectName ×1.5`) with fuzzy + prefix matching.

### 3.4 Codex index — `server/services/codex-index.ts`

Codex has no project directories and stores the working dir *inside* each file's
`session_meta` line, so we cannot group sessions before parsing. The index parses
every Codex file's meta once into a single `cache/meta/codex-index.json`
(keyed by absolute path + `mtimeMs` + `size` + `SCHEMA_VERSION`) and derives two
in-memory maps: `cwd → sessions` (for the project view) and `sessionId → filePath`
(for resolution). `listCodexProjects` / `listCodexSessions` / `resolveCodexPath` /
`listCodexFilesSnapshot` feed the session manager and search engine.

- **Why a separate cache** — the per-project meta cache (§3.1) can't be keyed before
  the cwd is known; the Codex index solves the chicken-and-egg by scanning first.
- **Offset sidecars reused** — pagination anchors (§3.2) are stored under the same
  `{projectId}__{sessionId}` key (projectId = encoded cwd), so seek-based paging works
  identically for Codex.
- **SCHEMA_VERSION** — bump it whenever `SessionMeta` content changes; otherwise
  unchanged files keep serving stale meta (this caused the "Codex tokens show 0" bug;
  see §12).

## 4. Sliced pagination & the API contract

Three read paths coexist (see `server/routes/sessions.ts`):

| Endpoint | Returns | Use |
|---|---|---|
| `GET /sessions/:p/:s` | `{ meta, messages(first page), nextCursor }` | default detail load |
| `GET /sessions/:p/:s?full=true` | full `ParsedSession` | legacy / export |
| `GET /sessions/:p/:s/messages?after=<uuid>&limit=200` | `{ messages, nextCursor }` | infinite scroll |

`parseSessionSlice` (`jsonl-reader.ts`) is the core primitive:
- `afterUuid` omitted → first `limit` messages.
- `afterUuid` provided → `getSessionMessages` looks up the offset sidecar; on an
  anchor hit it passes `seekFromByte` so the stream starts mid-file, then scans
  forward to `afterUuid` and collects `limit` more.
- `nextCursor` = uuid of the last returned message when more remain, else `null`.
- `limit` is clamped to `[1, 500]`; only `user/assistant/system` messages are
  emitted (same visible-message contract as `parseSessionFile`).

**Cursor/anchor coupling:** anchors are placed only on *visible* messages, and
slices emit only visible messages — so any `nextCursor` the client sends back is
guaranteed to be a uuid we could have anchored. Keep these two contracts in sync.

## 5. Conditional requests (ETag) — `server/utils/etag.ts`

The session-detail and commands endpoints emit a **weak ETag** derived from the
source file's `mtime` + `size` (no content hashing). `handleConditional` returns
`304` when `If-None-Match` / `If-Modified-Since` match, short-circuiting before
any parse. ETag suffixes (`-page`, `-cmd`) keep the two response shapes from
colliding.

## 6. Live updates & invalidation — `server/services/file-watcher.ts`

chokidar watches `~/.claude/projects` (`.jsonl` only, `depth: 2`,
`awaitWriteFinish` debounce). On each event, **invalidation is file-level, not
project-level**, so one busy session doesn't blow away a whole project's cache:

```
file event ─► invalidateSessionCache  (evict meta entry, mark dirty, save)
           ─► evictOffsets            (drop stale sidecar; rebuilt on next read)
           ─► search onFileEvent      (incremental discard+add, debounced persist)
           ─► broadcast SSE           (browser refetches the affected session)
```

The browser subscribes via `useSSE` and refetches only what changed.

## 7. Frontend rendering

`ChatViewer.tsx` and `AuditPanel.tsx` use **`react-virtuoso`** to virtualize long
message/command lists (only visible rows mount). `ChatViewer` pages via the
`/messages?after=` cursor endpoint as the user scrolls, so memory stays bounded
regardless of session size. `ChatViewer` has 3 view modes: Full, Compact
(user + commands), Changes (file diffs). `DialogUserRow` is split out so its
sanitized-Markdown HTML can be reasoned about in isolation.

## 8. Cache layout on disk

```
~/.claude-session-manager/
├── auth.json                       # bcrypt hash + JWT secret
├── trash/
│   ├── {proj}__{sess}__{ts}.jsonl  # deleted sessions (both sources)
│   └── .trash-meta.json            # source + originalPath per trash item (restore)
└── cache/
    ├── meta/{projectId}.json                 # §3.1  Claude meta cache
    ├── meta/codex-index.json                 # Codex: cwd grouping + id→path (keyed by abs-path+mtime+size)
    ├── offsets/{projectId}__{sessionId}.json # §3.2  (both sources)
    └── search/{index.json, manifest.json}    # §3.3  (Claude + Codex)
```

`cache-paths.ts` is the single source of truth for these paths; `ensureCacheDirs`
(called first in bootstrap) creates them idempotently. The whole `cache/` tree is
disposable — delete it and the next boot rebuilds everything.

## 9. Bootstrap sequence — `server/index.ts`

```
ensureCacheDirs()
  → startWatcher()                       # begin watching before index work
  → loadIndex() || buildIndex()          # warm or cold start
  → reconcile()                          # absorb offline changes
  → app.listen(port, host)
  ...
  → persistIndex()                       # on SIGINT/SIGTERM, flush dirty index
```

## 10. Invariants to preserve

When changing this area, keep these true (they are load-bearing):

1. **Read-only source.** Never write under `~/.claude`. App state goes in
   `~/.claude-session-manager/`.
2. **Stat-based validity.** Every cache entry is validated by `mtimeMs + size`.
   If you add a cache, follow the same rule and bump its `SCHEMA_VERSION` on
   shape changes.
3. **Anchor/page-size alignment.** `ANCHOR_EVERY` must divide the default page
   size, and the duplicated constant in `jsonl-reader.ts` must match.
4. **Visible-message contract.** `parseSessionMeta` (anchors),
   `parseSessionSlice` (emit), and `parseSessionFile` must agree on which roles
   are "visible".
5. **File-level invalidation.** Watcher events evict a single session, not the
   project, to avoid cache stampedes.
6. **Atomic writes.** All cache persistence uses `writeFile(tmp)` + `rename`.
7. **Path-traversal guard.** All project/session IDs pass `^[A-Za-z0-9_.-]+$`
   (`isValidId`) before touching the filesystem. Trash restore additionally
   resolves the destination and asserts it is under a whitelisted root
   (`~/.codex/sessions` or `~/.claude/projects`) — never trust the sidecar's
   `originalPath` blindly.
8. **Source-agnostic downstream.** Routes and React components must not branch on
   source; `locateSession()` + `SessionMeta.source` are the only places that know
   Claude vs Codex. New read paths should go through `locateSession`.
9. **SSE must bypass compression.** `text/event-stream` is excluded from the
   `compression()` middleware — gzip buffering otherwise stalls EventSource and
   kills all live updates (see Operations / Gotchas).

## 11. Operations (production) / 运维

Production runs under **PM2** as app `csm` (`PM2_HOME=/root/.pm2`), executing
`dist/server/index.js`, logging to `logs/csm-{out,error}.log` (NOT /tmp).

- **Deploy a change:** `npm run build` then `pm2 restart csm`. A running PM2
  process holds the old `dist` in memory — rebuilding alone changes nothing until
  restart. Never `nohup npm start` — it fights PM2 for port 3727 (EADDRINUSE) and
  spawns zombie instances.
- **Health:** `pm2 list` (a fast-climbing ↺ restart count = crash loop); `pm2 logs csm`.

## 12. Gotchas log / 踩坑记录

Hard-won traps from building the Codex integration — read before touching these areas:

1. **Stale cache after a meta-shape change.** Adding token usage to `SessionMeta`
   did nothing in prod until `codex-index`'s `SCHEMA_VERSION` was bumped 1→2:
   unchanged source files (same mtime/size) kept serving pre-feature `totalTokens:0`.
   Bump the cache's `SCHEMA_VERSION` whenever you change what it stores.
2. **SSE killed by gzip.** `compression()` buffered `text/event-stream`, so browsers
   (which send `Accept-Encoding: gzip`) never received events — UI showed OFFLINE and
   nothing live-updated (e.g. sidebar counts stale after delete). `curl -N` masked it
   (no gzip). Fix: `compression({ filter })` skips `/api/v1/events`.
3. **`token_count.info` is usually populated.** An early too-small sample suggested it
   was "often null" and tokens were abandoned as unreliable — wrong. The last
   `token_count.info.total_token_usage` is the session's cumulative usage.
4. **Killing a tsx server.** `pkill -f 'tsx server/index.ts'` does NOT match the real
   process (tsx's child is `node --require .../tsx/preflight.cjs --import ...`). Kill by
   PID via `ss -ltnp | grep ':<port>'`. Survivors cause EADDRINUSE and silent old-code.
5. **Verify pushes against the remote.** Trust `git ls-remote origin refs/heads/master`
   vs local HEAD, not a push command's printed "success" line.
