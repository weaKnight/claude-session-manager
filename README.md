# Claude Session Manager

[中文文档](README.zh-CN.md)

A lightweight, self-hosted web tool for browsing, searching, and auditing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) conversation history. Designed for **headless Linux servers** with no desktop environment required.

## Why This Tool?

Claude Code stores all conversations as JSONL files in `~/.claude/projects/`. These raw files are difficult to read, search, or audit. Existing tools are either desktop-only (Tauri/Electron), CLI-only (generating static HTML), or require manual file uploads.

**Claude Session Manager** fills the gap: a single-binary web server that reads your Claude data directory, serves a modern UI, and protects access with password authentication — all without a desktop environment.

## Features

### Browse & Read
- **Premium Web UI** — Generous spacing, gradient brand accents, JetBrains Mono code, dark mode with auto-detection
- **4 Chat View Modes** — Switch between **Full** (everything), **Dialog** (user + assistant only), **Compact** (user prompts + commands), and **Changes** (file diffs only)
- **Markdown Rendering** — GitHub-flavored Markdown with syntax-highlighted code blocks, sanitized via DOMPurify
- **Tool Use Inspection** — Expandable `Bash`, `Edit`, `Write`, `Read` blocks with input/output preview
- **Sub-Agent Support** — Detects and labels `agent-*.jsonl` sessions with a dedicated badge
- **Progressive Rendering** — Pages large sessions (50 messages at a time) for snappy loading

### Search & Audit
- **Full-text Search** — MiniSearch in-memory index across every conversation, with highlighted snippets
- **Command Audit Panel** — Chronological timeline of every tool call (`Bash`, `Write`, `Edit`, `Read`, `Glob`, `Grep`...) with per-tool filtering, error counts, and expandable input/output
- **Executive Dashboard** — Stats view with KPI cards (projects, sessions, messages) and a top-projects breakdown chart

### Live & Safe
- **Live Updates** — SSE-powered real-time refresh when JSONL files change on disk (chokidar watcher)
- **Authentication** — JWT + bcrypt (12 rounds) password protection, 5-failure lockout, configurable token expiry
- **Soft-Delete + Trash** — Deleted sessions move to `~/.claude-session-manager/trash/` and can be restored or permanently purged
- **Read-Only Data Access** — `~/.claude` is **never** written to; all delete operations target the trash directory
- **Path Traversal Protection** — Strict whitelist validation on every project/session ID

### UX
- **Bilingual UI** — English / 中文 one-click toggle (i18next)
- **Dark Mode** — System-preference detection with manual override
- **Read-Only Mode** — `--read-only true` flag to disable all delete operations (recommended for shared deployments)
- **Docker Ready** — One-command deployment with `docker compose up`

## Quick Start

### Option 1: Direct Run

```bash
git clone https://github.com/YOUR_USERNAME/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
npm start
```

Open `http://your-server:3727` and set your password on first visit.

### Option 2: Docker (Recommended)

```bash
git clone https://github.com/YOUR_USERNAME/claude-session-manager.git
cd claude-session-manager
docker compose up -d
```

> **Docker is read-only by default.** The container mounts your host `~/.claude` directory **read-only** for safety, so delete and trash operations are disabled inside Docker — you can browse, search, and audit, but not modify. To enable write operations, edit `docker-compose.yml` and remove the `:ro` suffix from the volume mount, then restart with `docker compose up -d --force-recreate`. The host `~/.claude` data is never modified by the app even with writes enabled — only the trash directory under `~/.claude-session-manager/` is touched.

### Option 3: PM2 (Recommended for non-Docker hosts)

[PM2](https://pm2.keymetrics.io/) is the simplest way to keep the server running, restart it on crashes, and bring it back automatically after a reboot. An `ecosystem.config.cjs` ships in the repo root.

```bash
# 1. Install PM2 globally (one time)
npm install -g pm2

# 2. Build the app
npm run build

# 3. Start under PM2
pm2 start ecosystem.config.cjs

# 4. Persist the process list and enable boot autostart
pm2 save
pm2 startup           # follow the printed sudo command
```

After this, the server will start automatically on every reboot.

**Common PM2 commands:**

```bash
pm2 status            # Show all managed processes
pm2 logs csm          # Tail combined logs (Ctrl+C to exit)
pm2 logs csm --err    # Errors only
pm2 restart csm       # Restart after a build
pm2 reload csm        # Zero-downtime reload
pm2 stop csm          # Stop without removing
pm2 delete csm        # Remove from PM2 entirely
pm2 monit             # Live CPU/memory dashboard
```

**Updating to a new version:**

```bash
git pull
npm install
npm run build
pm2 reload csm        # Or: pm2 restart csm
```

To customize port, host, JWT secret, or read-only mode, edit the `env` block in `ecosystem.config.cjs` and run `pm2 reload csm`.

### Option 4: systemd Service

```bash
npm run build
sudo cp scripts/csm.service /etc/systemd/system/
sudo systemctl edit --full csm.service  # Set User= and paths
sudo systemctl enable --now csm.service
```

## CLI Options

```bash
npm start -- --port 8080          # Custom port
npm start -- --host 127.0.0.1     # Bind to localhost only
npm start -- --claude-dir /path    # Custom .claude directory
npm start -- --read-only true      # Disable delete operations
```

## Architecture

```
~/.claude/projects/**/*.jsonl  →  JSONL Parser  →  Express API  →  React SPA
                                      ↓                ↓
                               MiniSearch Index    SSE Events
                                      ↓                ↓
                                 Search API      Live Updates
```

**Stack**: Node.js + Express (backend), React + Vite + Tailwind (frontend), MiniSearch (search), chokidar (file watching), bcrypt + JWT (auth).

## API Reference

All endpoints (except `/api/v1/auth/*`) require `Authorization: Bearer <token>`.

| Method | Endpoint | Description |
|--------|----------|-------------|
| GET | `/api/v1/auth/status` | Check if setup is required |
| POST | `/api/v1/auth/setup` | First-time password setup |
| POST | `/api/v1/auth/login` | Login and receive JWT |
| GET | `/api/v1/projects` | List all projects |
| GET | `/api/v1/projects/:id/sessions` | List sessions for a project |
| GET | `/api/v1/sessions/:pid/:sid` | Get full session with messages |
| GET | `/api/v1/sessions/:pid/:sid/commands` | Get audit commands (Bash/Edit/Write...) |
| DELETE | `/api/v1/sessions/:pid/:sid` | Soft-delete session (move to trash) |
| DELETE | `/api/v1/sessions/:pid/:sid?force=true` | Hard-delete session (skip trash) |
| GET | `/api/v1/trash` | List soft-deleted sessions |
| POST | `/api/v1/trash/:fileName/restore` | Restore a session from trash |
| DELETE | `/api/v1/trash` | Empty the trash permanently |
| GET | `/api/v1/search?q=query` | Full-text search |
| GET | `/api/v1/events` | SSE live updates |
| GET | `/api/v1/stats` | Usage statistics |

## Security

- **Password hashing**: bcrypt with 12 rounds
- **JWT tokens**: Configurable expiry (default 24h)
- **Rate limiting**: 5 failed logins → 15-minute lockout
- **Path traversal protection**: Whitelist validation on all IDs
- **XSS prevention**: DOMPurify for all rendered content
- **Read-only data access**: `~/.claude` is never written to
- **Helmet.js**: Security headers on all responses

### HTTPS Setup

For production, use a reverse proxy with TLS:

```nginx
server {
    listen 443 ssl;
    server_name csm.example.com;
    ssl_certificate /path/to/cert.pem;
    ssl_certificate_key /path/to/key.pem;

    location / {
        proxy_pass http://127.0.0.1:3727;
        proxy_set_header Host $host;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
    }

    # SSE support
    location /api/v1/events {
        proxy_pass http://127.0.0.1:3727;
        proxy_set_header Connection '';
        proxy_http_version 1.1;
        chunked_transfer_encoding off;
        proxy_buffering off;
        proxy_cache off;
    }
}
```

## Development

```bash
npm run dev          # Start both server + client with hot reload
npm run dev:server   # Server only (port 3727)
npm run dev:client   # Vite dev server only (port 5173, proxies to 3727)
npm run typecheck    # TypeScript type checking
npm run lint         # ESLint
```

## Project Structure

```
├── server/              # Backend (Express + TypeScript)
│   ├── auth/            # Authentication (bcrypt, JWT, middleware)
│   ├── parser/          # JSONL parsing engine
│   ├── routes/          # API route handlers
│   ├── services/        # Business logic (sessions, search, watcher)
│   └── utils/           # Config, logger
├── src/                 # Frontend (React + TypeScript)
│   ├── components/      # UI components
│   ├── hooks/           # Custom React hooks
│   ├── i18n/            # Translation files (en, zh)
│   ├── styles/          # Design system CSS
│   └── utils/           # API client
├── Dockerfile
├── docker-compose.yml
└── CLAUDE.md            # Context for Claude Code iteration
```

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing`)
3. Commit your changes (`git commit -m 'Add amazing feature'`)
4. Push to the branch (`git push origin feature/amazing`)
5. Open a Pull Request

## License

MIT — see [LICENSE](LICENSE)

## Acknowledgments

Inspired by the community tools:
- [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) — Desktop app with comprehensive features
- [claude-code-log](https://github.com/daaain/claude-code-log) — Python CLI for HTML export
- [clog](https://github.com/HillviewCap/clog) — Browser-based JSONL viewer
