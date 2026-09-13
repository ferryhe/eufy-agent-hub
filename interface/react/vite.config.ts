import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import { fileURLToPath } from 'node:url'
const resident = process.env.EUFY_VITE_RESIDENT_URL || 'http://127.0.0.1:3187'
export default defineConfig({
  root: fileURLToPath(new URL('.', import.meta.url)), base: '/app/', plugins: [react()],
  // The resident intentionally checks both Host and Origin. The local proxy
  // presents the resident origin instead of weakening those checks for Vite.
  server: { proxy: { '/api': { target: resident, changeOrigin: true, configure: proxy => proxy.on('proxyReq', request => request.setHeader('origin', resident)) }, '/status': { target: resident, changeOrigin: true, configure: proxy => proxy.on('proxyReq', request => request.setHeader('origin', resident)) }, '/locales': { target: resident, changeOrigin: true, configure: proxy => proxy.on('proxyReq', request => request.setHeader('origin', resident)) } } },
  build: { outDir: '../app-dist', emptyOutDir: true },
})
