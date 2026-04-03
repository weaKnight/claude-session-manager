# Multi-stage build for Claude Session Manager
# 多阶段构建 Claude 会话管理器

# --- Stage 1: Build / 构建阶段 ---
FROM node:20-alpine AS builder

WORKDIR /app
COPY package.json package-lock.json* ./
RUN npm ci --ignore-scripts

COPY . .
RUN npm run build

# --- Stage 2: Production / 生产阶段 ---
FROM node:20-alpine AS runner

WORKDIR /app

# Install production dependencies only / 仅安装生产依赖
COPY package.json package-lock.json* ./
RUN npm ci --omit=dev --ignore-scripts && npm cache clean --force

# Copy built artifacts / 复制构建产物
COPY --from=builder /app/dist ./dist

# Create non-root user / 创建非 root 用户
RUN addgroup --system --gid 1001 csm && \
    adduser --system --uid 1001 csm && \
    mkdir -p /home/csm/.claude-session-manager && \
    chown -R csm:csm /home/csm

USER csm

# Default environment / 默认环境变量
ENV NODE_ENV=production
ENV CSM_PORT=3727
ENV CSM_HOST=0.0.0.0

EXPOSE 3727

# Health check / 健康检查
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD wget -qO- http://localhost:3727/api/v1/auth/status || exit 1

CMD ["node", "dist/server/index.js"]
