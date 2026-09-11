import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

// Tauri 约定：端口固定 5173，环境变量前缀 TAURI_
export default defineConfig({
  plugins: [react()],
  clearScreen: false,
  server: {
    port: 5173,
    strictPort: true,
  },
  envPrefix: 'TAURI_',
  build: {
    target: 'es2021',
    minify: 'esbuild',
    sourcemap: false,
  },
})
