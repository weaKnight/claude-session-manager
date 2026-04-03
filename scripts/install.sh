#!/bin/bash
# Claude Session Manager — Quick Install Script
# Claude 会话管理器 — 快速安装脚本

set -e

echo "╔══════════════════════════════════════════════╗"
echo "║   Claude Session Manager — Install Script    ║"
echo "╚══════════════════════════════════════════════╝"
echo ""

# Check Node.js / 检查 Node.js
if ! command -v node &> /dev/null; then
    echo "ERROR: Node.js 18+ is required but not found."
    echo "Install: https://nodejs.org/ or use nvm"
    exit 1
fi

NODE_VERSION=$(node -v | sed 's/v//' | cut -d. -f1)
if [ "$NODE_VERSION" -lt 18 ]; then
    echo "ERROR: Node.js 18+ required (found v$(node -v))"
    exit 1
fi

echo "✓ Node.js $(node -v) detected"

# Check if ~/.claude exists / 检查 ~/.claude 是否存在
if [ ! -d "$HOME/.claude" ]; then
    echo "WARNING: ~/.claude directory not found."
    echo "Claude Code must have been used at least once."
    echo "Continuing anyway..."
fi

# Install dependencies / 安装依赖
echo ""
echo "Installing dependencies..."
npm install

# Build / 构建
echo ""
echo "Building..."
npm run build

echo ""
echo "╔══════════════════════════════════════════════╗"
echo "║            Installation Complete!            ║"
echo "╚══════════════════════════════════════════════╝"
echo ""
echo "Start the server:"
echo "  npm start"
echo ""
echo "Or with custom options:"
echo "  npm start -- --port 8080 --host 0.0.0.0"
echo ""
echo "First visit: set your password at http://localhost:3727"
echo ""
