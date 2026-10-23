import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// В dev-режиме /api и /ws проксируются на запущенный стек (nginx из docker compose),
// чтобы клиент, как и в проде, ходил только на свой origin.
const backend = process.env.BACKEND_URL ?? 'http://localhost:8080'

export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/api': { target: backend, changeOrigin: true },
      '/ws': {
        target: backend,
        ws: true,
        changeOrigin: true,
        // бэкенд сверяет Origin с Host у WS-апгрейда
        configure: (proxy) => proxy.on('proxyReqWs', (req) => req.setHeader('origin', backend)),
      },
    },
  },
  build: {
    target: 'es2022',
  },
})
