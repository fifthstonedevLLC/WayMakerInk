import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/* The portal is a single-page app behind nginx `try_files … /index.html`, so
   every route resolves to the same document. `base: '/'` keeps the built asset
   URLs absolute, which is what makes /r/WMI-ABC123 load its scripts from /assets
   rather than from /r/assets. */
export default defineConfig({
  plugins: [react()],
  base: '/',
  build: {
    outDir: 'dist',
    sourcemap: true,
    /* The chunk that matters is supabase-js; splitting it out means a portal
       code change does not re-download it. */
    rollupOptions: {
      output: {
        manualChunks: {
          supabase: ['@supabase/supabase-js'],
          react: ['react', 'react-dom', 'react-router-dom']
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
