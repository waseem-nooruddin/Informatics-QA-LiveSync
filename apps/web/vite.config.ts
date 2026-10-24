import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';

// BASE_PATH is set by the GitHub Pages workflow (e.g. "/qa-livesync/").
export default defineConfig({
  base: process.env.BASE_PATH ?? '/',
  plugins: [react(), tailwindcss()],
  server: { port: 5180, strictPort: true },
  build: {
    rollupOptions: {
      output: {
        manualChunks: { charts: ['recharts'], data: ['@supabase/supabase-js', '@tanstack/react-query'], react: ['react', 'react-dom', 'react-router-dom'] },
      },
    },
  },
});
