# Claude 会话管理器

[English](README.md)

一个轻量级、自托管的 Web 工具，用于浏览、搜索和审计 [Claude Code](https://docs.anthropic.com/en/docs/claude-code) 的会话历史。专为**无桌面环境的 Linux 服务器**设计。

## 为什么需要这个工具？

Claude Code 将所有会话以 JSONL 文件存储在 `~/.claude/projects/` 目录下。这些原始文件难以阅读、搜索或审计。现有工具要么依赖桌面环境（Tauri/Electron），要么是命令行工具（生成静态 HTML），或者需要手动上传文件。

**Claude Session Manager** 填补了这一空白：一个单文件 Web 服务器，读取你的 Claude 数据目录，提供现代化 UI，并通过密码认证保护访问——完全不需要桌面环境。

## 功能特性

### 浏览与阅读
- **高级 Web 界面** — 宽松的留白布局、渐变品牌色、JetBrains Mono 等宽字体、自动暗色模式
- **4 种聊天视图模式** — 自由切换 **完整模式**（全部消息）、**对话模式**（仅用户与助手）、**精简模式**（用户提示 + 命令）、**变更模式**（仅文件 diff）
- **Markdown 渲染** — GitHub 风格 Markdown，代码块语法高亮，DOMPurify 消毒防 XSS
- **工具调用查看** — 可展开 `Bash`、`Edit`、`Write`、`Read` 等工具的输入与输出
- **子代理识别** — 自动检测并标记 `agent-*.jsonl` 子代理会话，带专属徽章
- **渐进式渲染** — 大型会话每页 50 条消息，加载迅速

### 搜索与审计
- **全文搜索** — MiniSearch 内存索引覆盖全部会话，命中片段高亮展示
- **命令审计面板** — 按时间线展示每一次工具调用（`Bash`、`Write`、`Edit`、`Read`、`Glob`、`Grep`...），支持按工具筛选、统计错误数、展开输入与输出详情
- **执行仪表盘** — 统计视图含 KPI 卡片（项目数、会话数、消息数）和 Top 项目分布图

### 实时与安全
- **实时更新** — SSE 推送结合 chokidar 文件监听，磁盘上的 JSONL 变化即时同步到 UI
- **身份认证** — JWT + bcrypt（12 轮）密码保护，5 次失败锁定，可配置 token 过期时间
- **软删除 + 回收站** — 删除的会话进入 `~/.claude-session-manager/trash/`，可恢复或永久清空
- **只读数据访问** — **永远不写入** `~/.claude` 目录，所有删除都只操作回收站
- **路径遍历防护** — 所有项目/会话 ID 走严格白名单校验

### 用户体验
- **双语界面** — 中文 / English 一键切换（i18next）
- **暗色模式** — 跟随系统偏好，可手动切换
- **只读模式** — `--read-only true` 参数禁用所有删除操作（共享部署推荐）
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

> **Docker 默认只读。** 出于安全考虑，容器以**只读方式**挂载宿主机的 `~/.claude` 目录，因此 Docker 内**只能查看内容**，删除和回收站操作被禁用——你可以浏览、搜索、审计，但不能修改。如需启用写操作，请编辑 `docker-compose.yml`，移除卷挂载末尾的 `:ro` 后缀，然后执行 `docker compose up -d --force-recreate` 重建容器。即使开启写权限，应用也**永远不会修改宿主机的 `~/.claude` 数据**——所有删除都只写入 `~/.claude-session-manager/` 下的回收站目录。

### 方式三：PM2（非 Docker 主机推荐）

[PM2](https://pm2.keymetrics.io/) 是保持服务常驻、崩溃自动重启、开机自启的最简单方案。仓库根目录已自带 `ecosystem.config.cjs` 配置文件。

```bash
# 1. 全局安装 PM2（仅需一次）
npm install -g pm2

# 2. 构建应用
npm run build

# 3. 用 PM2 启动
pm2 start ecosystem.config.cjs

# 4. 保存进程列表 + 启用开机自启
pm2 save
pm2 startup           # 按提示执行打印出的 sudo 命令
```

至此，服务器将在每次重启后自动启动。

**PM2 常用命令：**

```bash
pm2 status            # 查看所有进程状态
pm2 logs csm          # 查看实时日志（Ctrl+C 退出）
pm2 logs csm --err    # 仅查看错误日志
pm2 restart csm       # 构建后重启
pm2 reload csm        # 零停机重载
pm2 stop csm          # 停止但保留进程
pm2 delete csm        # 从 PM2 中完全移除
pm2 monit             # 实时 CPU / 内存监控面板
```

**更新到新版本：**

```bash
git pull
npm install
npm run build
pm2 reload csm        # 或：pm2 restart csm
```

如需自定义端口、主机、JWT secret 或只读模式，编辑 `ecosystem.config.cjs` 中的 `env` 块，然后执行 `pm2 reload csm`。

### 方式四：预编译二进制（无需 Node）

适合不想装 Node.js 的用户。使用 [Bun](https://bun.sh/) 跨平台编译，每个平台产出单文件可执行程序，二进制内已嵌入 Node 兼容运行时；运行时只需可执行文件 + 同目录的 `dist/client/`。

**构建全部 5 个平台**（构建机需 Bun ≥ 1.1，Bun 自带跨平台编译能力）：

```bash
npm install -g bun           # 一次性安装
npm run build:binaries       # 构建 linux x64/arm64、darwin x64/arm64、windows x64
```

产物在 `release/` 目录：

```
release/
├── csm-linux-x64.tar.gz       (~38 MB)
├── csm-linux-arm64.tar.gz     (~38 MB)
├── csm-darwin-x64.tar.gz      (~24 MB)
├── csm-darwin-arm64.tar.gz    (~22 MB)
└── csm-windows-x64.zip        (~40 MB)
```

每个压缩包内的结构：

```
csm-{os}-{arch}/
├── csm[.exe]        可执行文件（解压后 60–110 MB）
├── dist/client/     打包后的 SPA 静态资源
└── README.txt
```

**目标机器上运行：**

```bash
tar -xzf csm-linux-x64.tar.gz
cd csm-linux-x64
./csm                              # 或：./csm --port 8080 --read-only true
```

然后浏览器访问 `http://your-server:3727`，首次访问时设置密码。

**只构建单个平台：**

```bash
npm run build:binaries -- linux-arm64    # 或 darwin-arm64、windows-x64 等
```

> **说明**：二进制默认读取同级目录的 `dist/client/`。如需指定其他位置，启动前设置 `CSM_CLIENT_DIST=/绝对/路径/到/client` 即可。`--port`、`--host`、`--claude-dir`、`--read-only` 等参数与 npm 启动方式完全一致。

### 方式五：systemd 服务

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
| GET | `/api/v1/sessions/:pid/:sid/commands` | 获取审计命令（Bash/Edit/Write...） |
| DELETE | `/api/v1/sessions/:pid/:sid` | 软删除会话（移入回收站） |
| DELETE | `/api/v1/sessions/:pid/:sid?force=true` | 硬删除会话（跳过回收站） |
| GET | `/api/v1/trash` | 列出回收站中的会话 |
| POST | `/api/v1/trash/:fileName/restore` | 从回收站恢复会话 |
| DELETE | `/api/v1/trash` | 清空回收站（永久删除） |
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
