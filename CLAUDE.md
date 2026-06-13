# CLAUDE.md — Claude Session Manager

## Project Overview

A self-hosted web tool for browsing, searching, and auditing Claude Code **and OpenAI Codex CLI** conversation history. Designed for headless Linux servers. Codex sessions are recognized, merged into the project view by working directory, and support the same browse / view / paginate / audit / search / delete / restore / token-stats features as Claude sessions. See [docs/architecture.md](docs/architecture.md) for the dual-source data flow.

## Tech Stack

- **Backend**: Node.js 18+, Express 4, TypeScript (ESM)
- **Frontend**: React 18, Vite 5, Tailwind CSS 3
- **Auth**: bcrypt + JWT (stored in ~/.claude-session-manager/auth.json)
- **Search**: MiniSearch (in-memory full-text index, indexes Claude + Codex)
- **Live updates**: chokidar file watcher → SSE (watches ~/.claude/projects + ~/.codex/sessions)
- **Sources**: Claude Code (`~/.claude/projects`) + OpenAI Codex CLI (`~/.codex/sessions`); toggle Codex via `--codex-dir` / `CSM_CODEX_DIR` (empty disables)
- **i18n**: i18next (en/zh)
- **Process manager (prod)**: PM2 app `csm` (see docs/architecture.md "Operations")

## Key Architecture Decisions

1. **Read-only access to ~/.claude and ~/.codex** — The app NEVER writes to either data directory. Deleted sessions (both sources) are moved to ~/.claude-session-manager/trash/.
2. **Single process, layered caching** — No database, no Redis. One Node.js process backed by in-memory mirrors plus persistent on-disk caches under `~/.claude-session-manager/cache/` (meta, offsets, search). See [docs/architecture.md](docs/architecture.md) for the data flow and why each cache exists.
3. **Embedded frontend** — `npm run build` produces dist/client/ which the Express server serves as static files. No separate nginx needed for dev.
4. **Path traversal security** — All project/session IDs are validated with `^[A-Za-z0-9_.-]+$` before use in file paths. Codex trash-restore additionally enforces a destination whitelist (must resolve under `~/.codex/sessions` or `~/.claude/projects`).
5. **Dual-source via one view model** — Codex's different on-disk format and layout are normalized by `codex-reader.ts` into the SAME `ParsedSession` / `ContentBlock` / `SessionMeta` types Claude uses, so routes and React components stay source-agnostic. `SessionMeta.source` ('claude' | 'codex') tags origin; `locateSession()` resolves which source owns a given id.

## JSONL Data Structure

Claude Code stores conversations in `~/.claude/projects/{encoded-path}/{session-uuid}.jsonl`. Each line is one JSON object:

```
{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"...","uuid":"...","sessionId":"...","cwd":"...","gitBranch":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"},{"type":"tool_use","id":"...","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":100,"output_tokens":50}},"timestamp":"...","uuid":"..."}
{"type":"summary","summary":"User asked about...","timestamp":"...","sessionId":"..."}
```

Path encoding: `/home/user/project` → `-home-user-project` (forward slashes become dashes).

Sub-agent sessions are named `agent-{shortId}.jsonl`.

### Codex JSONL (different format)

Codex CLI stores conversations in `~/.codex/sessions/YYYY/MM/DD/rollout-<ts>-<uuid>.jsonl` — a date-tree layout with **no project directories** (the working directory lives inside the file). Each line is a `{timestamp, type, payload}` envelope, not a Claude-style message record:

```
{"timestamp":"...","type":"session_meta","payload":{"id":"<uuid>","cwd":"/path","cli_version":"...","model_provider":"openai"}}
{"timestamp":"...","type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"..."}]}}
{"timestamp":"...","type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{...}","call_id":"..."}}
{"timestamp":"...","type":"event_msg","payload":{"type":"token_count","info":{"total_token_usage":{"input_tokens":1,"output_tokens":1}}}}
```

`codex-reader.ts` maps these onto Claude's view model: `response_item` message/reasoning/function_call(_output)/custom_tool_call → text / tool_use / tool_result blocks; the last `token_count.total_token_usage` → `totalTokens`. Projects are synthesized by encoding the `cwd` with the same scheme as Claude, so a directory used by both tools shows as one merged project (`ProjectInfo.sources`). Message uuids are synthetic (`c-<n>`, one per emitted line) since Codex lines have no uuid.

## File Layout

```
server/index.ts                    — Express entry + bootstrap (ensureCacheDirs → watcher → loadIndex/buildIndex → reconcile; persistIndex on shutdown)
server/auth/service.ts             — bcrypt + JWT logic; rotates JWT secret on password change
server/auth/middleware.ts          — requireAuth middleware
server/parser/jsonl-reader.ts      — Claude JSONL parser: full parse, sliced parse (seek-by-byte), meta-only parse + offset anchors, command extraction
server/parser/codex-reader.ts      — Codex JSONL parser: maps ~/.codex/sessions/ rollout-*.jsonl ({timestamp,type,payload} envelope) onto the same ParsedSession/ContentBlock models; cwd→project encoding, synthetic c-N uuids, token usage from event_msg token_count.total_token_usage, streaming search-text extraction
server/parser/message-types.ts     — TypeScript type definitions (SessionMeta.source: 'claude'|'codex')
server/services/session-manager.ts — Project/session CRUD (source-aware: locateSession resolves Claude vs Codex), sliced pagination, trash (Codex restore via sidecar + path-traversal whitelist), invalid-session scan + batch delete, cache invalidation
server/services/codex-index.ts     — Scans the Codex date-tree, parses meta, groups sessions by encoded cwd into projects; own mtime-keyed cache (cache/meta/codex-index.json) + sessionId→filePath resolution + listCodexFilesSnapshot for search
server/services/trash-meta.ts      — Trash sidecar (trash/.trash-meta.json): records source + originalPath per deleted session so Codex sessions restore to their date-tree path; atomic writes
server/services/invalid-detector.ts — Pure classifier: flags sessions as empty/too_short/no_user_input/corrupt per criteria
server/services/meta-cache.ts      — Persistent per-project session metadata cache (cache/meta/{projectId}.json, keyed by mtime+size)
server/services/offset-cache.ts    — Byte-offset sidecars for seek-based pagination (cache/offsets/, anchors every 100 msgs)
server/services/search-engine.ts   — MiniSearch index over Claude + Codex sessions (doc.source tags origin): load/build/reconcile + incremental updates (onFileEvent / onCodexFileEvent) + debounced persist (cache/search/)
server/services/file-watcher.ts    — chokidar (Claude projects + Codex sessions tree) → cache invalidation + search delta + SSE broadcast
server/utils/config.ts             — Env/CLI config, paths (claudeDir + codexDir), client-dist resolution (Node + Bun single-binary)
server/utils/cache-paths.ts        — Centralized cache/ directory layout under appDataDir (incl. codex-index.json)
server/utils/etag.ts               — Weak ETag / 304 conditional-request helpers (derived from mtime+size)
server/utils/logger.ts             — Leveled logger
server/routes/auth.ts              — /api/v1/auth/* (status, setup, login, change-password)
server/routes/sessions.ts          — /api/v1/projects/*, /api/v1/sessions/* (paged detail, /messages cursor slices, /commands, sessions/scan-invalid + batch-delete, trash + trash/batch-delete)
server/routes/search.ts            — GET /api/v1/search
src/App.tsx                        — Auth gate → Login or Layout
src/components/Layout.tsx          — Main shell with sidebar + content
src/components/Login.tsx           — First-time password setup + login
src/components/ProjectTree.tsx     — Project list (file-manager style)
src/components/SessionList.tsx     — Sessions of selected project with metadata; Codex badge; "clean up invalid sessions" entry
src/components/ChatViewer.tsx      — Virtualized (react-virtuoso) message renderer; 3 view modes; cursor-based paging
src/components/DialogUserRow.tsx   — Single user-message row (sanitized Markdown)
src/components/AuditPanel.tsx      — Virtualized tool_use command timeline
src/components/SearchPanel.tsx     — Full-text search UI; Codex badge on results
src/components/TrashPanel.tsx      — Deleted-session restore / empty trash / multi-select batch permanent delete; Codex badge
src/components/ChangePasswordModal.tsx — Change password (triggers server JWT-secret rotation)
src/components/InvalidSessionsModal.tsx — Scan → preview (reason badges) → select → batch soft-delete invalid sessions
src/hooks/useAuth.ts               — Auth state + login/logout
src/hooks/useSSE.ts                — Subscribe to SSE live file-change events (events may carry source: 'codex')
src/utils/api.ts                   — HTTP client with JWT auth; SessionMeta/SearchResult/TrashItem carry optional source
src/i18n/{index.ts,en.json,zh.json} — i18next setup + translation resources
```

> Full data-flow, caching, and pagination design lives in [docs/architecture.md](docs/architecture.md).

## Development Commands

```bash
npm run dev              # Full dev mode (server + client hot reload)
npm run build            # Production build
npm start                # Start production server
npm run typecheck        # TS check
```

## Common Tasks

- **Add a new API endpoint**: Create handler in server/routes/, register in server/index.ts
- **Add a new UI component**: Create in src/components/, import in Layout.tsx
- **Add a translation key**: Add to both src/i18n/en.json and src/i18n/zh.json
- **Change design tokens**: Edit CSS variables in src/styles/design-system.css

## Code Style

- All code has bilingual comments (English + Chinese)
- ESM modules (`import/export`, not `require`)
- Strict TypeScript
- Functional React components with hooks
