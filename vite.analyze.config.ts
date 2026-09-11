import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { visualizer } from 'rollup-plugin-visualizer'

// 体积分析专用：npm run build:analyze 生成 stats.html + stats.json（不影响正常 build）
export default defineConfig({
  plugins: [
    react(),
    visualizer({
      filename: 'stats.html',
      template: 'raw-data',
      gzipSize: true,
      json: true,
    }),
  ],
  clearScreen: false,
  server: { port: 5173, strictPort: true },
  envPrefix: 'TAURI_',
  build: { target: 'es2021', minify: 'esbuild', sourcemap: false },
})
