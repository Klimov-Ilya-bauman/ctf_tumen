import { defineConfig } from 'vitest/config'
import react from '@vitejs/plugin-react'

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  publicDir: mode === 'mock' ? '.mock-public' : false,
  build: {
    outDir: 'dist',
    assetsDir: 'assets',
    sourcemap: false,
  },
  server: {
    proxy:
      mode === 'mock'
        ? undefined
        : { '/api': process.env.SLOPDNS_API_PROXY ?? 'http://localhost:8080' },
  },
  test: {
    environment: 'jsdom',
    setupFiles: ['./src/test/setup.ts'],
    css: false,
    restoreMocks: true,
    testTimeout: 30000,
    hookTimeout: 30000,
  },
}))
