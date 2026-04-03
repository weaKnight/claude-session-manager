# Claude Session Manager

[中文文档](README.zh-CN.md)

A lightweight, self-hosted web tool for browsing, searching, and auditing [Claude Code](https://docs.anthropic.com/en/docs/claude-code) conversation history. Designed for **headless Linux servers** with no desktop environment required.

## Why This Tool?

Claude Code stores all conversations as JSONL files in `~/.claude/projects/`. These raw files are difficult to read, search, or audit. Existing tools are either desktop-only (Tauri/Electron), CLI-only (generating static HTML), or require manual file uploads.

**Claude Session Manager** fills the gap: a single-binary web server that reads your Claude data directory, serves a modern UI, and protects access with password authentication — all without a desktop environment.

## Features

- **Web UI** — Browse projects, sessions, and messages from any browser
- **Full-text Search** — In-memory indexing across all conversations
- **Command Audit** — Dedicated panel showing every `Bash`, `Write`, `Edit` command Claude executed
- **Live Updates** — SSE-powered real-time refresh when sessions change
- **Authentication** — JWT + bcrypt password protection with brute-force lockout
- **Session Management** — Soft-delete (trash) and hard-delete with confirmation
- **Bilingual** — English and Chinese UI with one-click toggle
- **Dark Mode** — Automatic detection with manual override
- **Read-Only Mode** — Optional flag to prevent any modifications
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

### Option 3: systemd Service

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
| GET | `/api/v1/sessions/:pid/:sid/commands` | Get audit commands |
| DELETE | `/api/v1/sessions/:pid/:sid` | Soft-delete session |
| DELETE | `/api/v1/sessions/:pid/:sid?force=true` | Hard-delete session |
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
