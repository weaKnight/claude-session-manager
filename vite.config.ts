import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';

// Vite configuration for Claude Session Manager
// Vite 构建配置
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, './src'),
    },
  },
  server: {
    host: '0.0.0.0',
    port: 5173,
    // Proxy API requests to backend during development
    // 开发模式下将 API 请求代理到后端
    proxy: {
      '/api': {
        target: 'http://localhost:3727',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
    sourcemap: false,
    rollupOptions: {
      output: {
        // Split heavy deps so the main bundle stays small and route-level
        // imports can warm caches independently.
        // 拆分重依赖，主 chunk 保持精简，路由级懒加载可独立缓存
        manualChunks: {
          markdown: ['marked', 'dompurify'],
          virt: ['react-virtuoso'],
          icons: ['lucide-react'],
        },
      },
    },
  },
});
