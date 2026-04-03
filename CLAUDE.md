# CLAUDE.md — Claude Session Manager

## Project Overview

A self-hosted web tool for browsing, searching, and auditing Claude Code conversation history. Designed for headless Linux servers.

## Tech Stack

- **Backend**: Node.js 18+, Express 4, TypeScript (ESM)
- **Frontend**: React 18, Vite 5, Tailwind CSS 3
- **Auth**: bcrypt + JWT (stored in ~/.claude-session-manager/auth.json)
- **Search**: MiniSearch (in-memory full-text index)
- **Live updates**: chokidar file watcher → SSE
- **i18n**: i18next (en/zh)

## Key Architecture Decisions

1. **Read-only access to ~/.claude** — The app NEVER writes to the Claude data directory. Deleted sessions are moved to ~/.claude-session-manager/trash/.
2. **Single process** — No database, no Redis. Everything runs in one Node.js process with in-memory caching.
3. **Embedded frontend** — `npm run build` produces dist/client/ which the Express server serves as static files. No separate nginx needed for dev.
4. **Path traversal security** — All project/session IDs are validated with `^[A-Za-z0-9_.-]+$` before use in file paths.

## JSONL Data Structure

Claude Code stores conversations in `~/.claude/projects/{encoded-path}/{session-uuid}.jsonl`. Each line is one JSON object:

```
{"type":"user","message":{"role":"user","content":"Hello"},"timestamp":"...","uuid":"...","sessionId":"...","cwd":"...","gitBranch":"..."}
{"type":"assistant","message":{"role":"assistant","content":[{"type":"text","text":"Hi!"},{"type":"tool_use","id":"...","name":"Bash","input":{"command":"ls"}}],"usage":{"input_tokens":100,"output_tokens":50}},"timestamp":"...","uuid":"..."}
{"type":"summary","summary":"User asked about...","timestamp":"...","sessionId":"..."}
```

Path encoding: `/home/user/project` → `-home-user-project` (forward slashes become dashes).

Sub-agent sessions are named `agent-{shortId}.jsonl`.

## File Layout

```
server/index.ts          — Express app entry point
server/auth/service.ts   — bcrypt + JWT logic
server/auth/middleware.ts — requireAuth middleware
server/parser/jsonl-reader.ts — JSONL streaming parser
server/parser/message-types.ts — TypeScript type definitions
server/services/session-manager.ts — Project/session CRUD
server/services/search-engine.ts — MiniSearch wrapper
server/services/file-watcher.ts — chokidar + SSE broadcast
server/routes/auth.ts    — POST /api/v1/auth/*
server/routes/sessions.ts — GET/DELETE /api/v1/projects/*, /api/v1/sessions/*
server/routes/search.ts  — GET /api/v1/search
src/App.tsx              — Auth gate → Login or Layout
src/components/Layout.tsx — Main shell with sidebar + content
src/components/ChatViewer.tsx — Message renderer with Markdown
src/components/AuditPanel.tsx — Command audit timeline
```

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
