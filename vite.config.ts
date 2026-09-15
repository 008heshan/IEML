import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Tauri 期望固定端口；前端单独跑时也用同一个
const host = process.env.TAURI_DEV_HOST;

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // Tauri 需要固定端口且失败即报错，避免静默换端口导致壳连不上
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    host: host || false,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  build: {
    target: 'chrome105',
    minify: 'esbuild',
    sourcemap: false,
    chunkSizeWarningLimit: 600,
  },
});
