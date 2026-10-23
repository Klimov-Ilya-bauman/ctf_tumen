import { defineConfig } from 'astro/config';

export default defineConfig({
  server: {
    host: true,
  },
  vite: {
    server: {
      proxy: {
        '/api': {
          target: 'http://127.0.0.1:3000',
          changeOrigin: true,
        },
      },
    },
  },
});
