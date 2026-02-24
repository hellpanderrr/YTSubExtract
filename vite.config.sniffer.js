import { defineConfig } from 'vite';
import { resolve } from 'path';

// Sniffer - простой скрипт без зависимостей, не нужен nodePolyfills
export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    minify: 'terser',
    rollupOptions: {
      input: resolve(__dirname, 'src/content/sniffer.js'),
      output: {
        format: 'iife',
        entryFileNames: 'sniffer.js'
      }
    }
  }
});
