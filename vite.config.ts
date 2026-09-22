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
    /*
     * ★★ 2026-09-23（用户：「**清理一下构建的废弃产物**」）：
     *
     *   查下来 `dist/assets/` 里积了 **5 个没人引用的旧文件**
     *   （历次构建换过内容哈希名的 bundle）—— 它们会跟着打包进 exe，
     *   白占体积，也让人分不清哪个才是当前的。
     *
     *   ★ 显式写死 `emptyOutDir: true`，**不依赖默认值**：
     *     默认行为受"outDir 在不在项目根目录下"影响，而这里的产物同时被
     *     Tauri 读取（`frontendDist: ../dist`）—— 构建顺序一变就可能留下上上次的东西。
     */
    emptyOutDir: true,
  },
});
