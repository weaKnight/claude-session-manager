/**
 * PM2 ecosystem config / PM2 进程管理配置
 *
 * Usage / 使用：
 *   npm run build                       # Build first / 先构建
 *   pm2 start ecosystem.config.cjs      # Start / 启动
 *   pm2 save                            # Persist process list / 保存进程列表
 *   pm2 startup                         # Generate boot script / 生成开机自启脚本
 *
 * Common commands / 常用命令：
 *   pm2 status                          # View status / 查看状态
 *   pm2 logs csm                        # Tail logs / 查看日志
 *   pm2 restart csm                     # Restart / 重启
 *   pm2 reload csm                      # Zero-downtime reload / 零停机重载
 *   pm2 stop csm                        # Stop / 停止
 *   pm2 delete csm                      # Remove from PM2 / 从 PM2 移除
 */

module.exports = {
  apps: [
    {
      name: 'csm',
      script: './dist/server/index.js',
      cwd: __dirname,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      watch: false,
      max_memory_restart: '512M',
      min_uptime: '10s',
      max_restarts: 10,
      restart_delay: 3000,
      kill_timeout: 5000,

      // Environment / 环境变量
      env: {
        NODE_ENV: 'production',
        CSM_PORT: '3727',
        CSM_HOST: '0.0.0.0',
        // CSM_SECRET: 'your-jwt-secret-here',
        // CSM_READ_ONLY: 'true',
        // CSM_CLAUDE_DIR: '/home/youruser/.claude',
      },

      // Logs / 日志
      out_file: './logs/csm-out.log',
      error_file: './logs/csm-error.log',
      log_date_format: 'YYYY-MM-DD HH:mm:ss',
      merge_logs: true,
    },
  ],
};
