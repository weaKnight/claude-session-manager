# Claude 会话管理器

一个轻量级、自托管的 Web 工具，用于浏览、搜索和审计 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的会话历史。专为**无桌面环境的 Linux 服务器**设计。

## 为什么需要这个工具？

Claude Code 将所有会话以 JSONL 文件存储在 `~/.claude/projects/` 目录下。这些原始文件难以阅读、搜索或审计。现有工具要么依赖桌面环境（Tauri/Electron），要么是命令行工具（生成静态 HTML），或者需要手动上传文件。

**Claude Session Manager** 填补了这一空白：一个单文件 Web 服务器，读取你的 Claude 数据目录，提供现代化 UI，并通过密码认证保护访问——完全不需要桌面环境。

## 功能特性

- **Web 界面** — 从任何浏览器浏览项目、会话和消息
- **全文搜索** — 对所有会话内容建立内存索引
- **命令审计** — 专用面板展示 Claude 执行的每个 `Bash`、`Write`、`Edit` 命令
- **实时更新** — 基于 SSE 的实时刷新，会话变更即时同步
- **安全认证** — JWT + bcrypt 密码保护，暴力破解锁定
- **会话管理** — 软删除（回收站）和硬删除（需二次确认）
- **双语界面** — 中英文一键切换
- **暗色模式** — 自动检测，支持手动切换
- **只读模式** — 可选标志，防止任何修改操作
- **Docker 部署** — 一条命令 `docker compose up` 即可部署

## 快速开始

### 方式一：直接运行

```bash
git clone https://github.com/YOUR_USERNAME/claude-session-manager.git
cd claude-session-manager
npm install
npm run build
npm start
```

打开 `http://your-server:3727`，首次访问时设置密码。

### 方式二：Docker（推荐）

```bash
git clone https://github.com/YOUR_USERNAME/claude-session-manager.git
cd claude-session-manager
docker compose up -d
```

### 方式三：systemd 服务

```bash
npm run build
sudo cp scripts/csm.service /etc/systemd/system/
sudo systemctl edit --full csm.service  # 设置 User= 和路径
sudo systemctl enable --now csm.service
```

## 命令行参数

```bash
npm start -- --port 8080          # 自定义端口
npm start -- --host 127.0.0.1     # 仅绑定本地
npm start -- --claude-dir /path    # 自定义 .claude 目录
npm start -- --read-only true      # 禁用删除操作
```

## 架构

```
~/.claude/projects/**/*.jsonl  →  JSONL 解析器  →  Express API  →  React SPA
                                      ↓                ↓
                                MiniSearch 索引    SSE 事件
                                      ↓                ↓
                                  搜索 API        实时更新
```

**技术栈**：Node.js + Express（后端），React + Vite + Tailwind（前端），MiniSearch（搜索），chokidar（文件监控），bcrypt + JWT（认证）。

## API 接口

所有接口（除 `/api/v1/auth/*`）均需要 `Authorization: Bearer <token>` 头。

| 方法 | 接口 | 描述 |
|------|------|------|
| GET | `/api/v1/auth/status` | 检查是否需要初始设置 |
| POST | `/api/v1/auth/setup` | 首次密码设置 |
| POST | `/api/v1/auth/login` | 登录获取 JWT |
| GET | `/api/v1/projects` | 列出所有项目 |
| GET | `/api/v1/projects/:id/sessions` | 列出项目的会话 |
| GET | `/api/v1/sessions/:pid/:sid` | 获取完整会话内容 |
| GET | `/api/v1/sessions/:pid/:sid/commands` | 获取审计命令 |
| DELETE | `/api/v1/sessions/:pid/:sid` | 软删除会话 |
| DELETE | `/api/v1/sessions/:pid/:sid?force=true` | 硬删除会话 |
| GET | `/api/v1/search?q=query` | 全文搜索 |
| GET | `/api/v1/events` | SSE 实时更新 |
| GET | `/api/v1/stats` | 使用统计 |

## 安全性

- **密码哈希**：bcrypt 12 轮
- **JWT Token**：可配置过期时间（默认 24 小时）
- **速率限制**：5 次登录失败 → 锁定 15 分钟
- **路径遍历防护**：所有 ID 参数白名单验证
- **XSS 防护**：DOMPurify 过滤所有渲染内容
- **只读数据访问**：永远不写入 `~/.claude` 目录
- **Helmet.js**：所有响应附带安全头

### HTTPS 配置

生产环境建议使用反向代理配置 TLS：

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

    # SSE 支持
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

## 开发

```bash
npm run dev          # 同时启动服务器和客户端（热重载）
npm run dev:server   # 仅服务器（端口 3727）
npm run dev:client   # 仅 Vite 开发服务器（端口 5173，代理到 3727）
npm run typecheck    # TypeScript 类型检查
npm run lint         # ESLint 代码检查
```

## 项目结构

```
├── server/              # 后端（Express + TypeScript）
│   ├── auth/            # 认证模块（bcrypt、JWT、中间件）
│   ├── parser/          # JSONL 解析引擎
│   ├── routes/          # API 路由处理
│   ├── services/        # 业务逻辑（会话、搜索、监控）
│   └── utils/           # 配置、日志
├── src/                 # 前端（React + TypeScript）
│   ├── components/      # UI 组件
│   ├── hooks/           # 自定义 React Hooks
│   ├── i18n/            # 翻译文件（中文、英文）
│   ├── styles/          # 设计系统 CSS
│   └── utils/           # API 客户端
├── Dockerfile
├── docker-compose.yml
└── CLAUDE.md            # Claude Code 迭代上下文
```

## 参与贡献

1. Fork 本仓库
2. 创建功能分支 (`git checkout -b feature/amazing`)
3. 提交更改 (`git commit -m '添加新功能'`)
4. 推送分支 (`git push origin feature/amazing`)
5. 发起 Pull Request

## 许可证

MIT — 详见 [LICENSE](LICENSE)

## 致谢

灵感来源于社区工具：
- [claude-code-history-viewer](https://github.com/jhlee0409/claude-code-history-viewer) — 功能全面的桌面应用
- [claude-code-log](https://github.com/daaain/claude-code-log) — Python CLI HTML 导出工具
- [clog](https://github.com/HillviewCap/clog) — 浏览器端 JSONL 查看器
