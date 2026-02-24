import { defineConfig } from 'vite';
import { resolve } from 'path';
import { nodePolyfills } from 'vite-plugin-node-polyfills';

export default defineConfig({
  build: {
    outDir: 'dist',
    emptyOutDir: false,
    target: 'esnext',
    minify: 'terser',
    rollupOptions: {
      input: resolve(__dirname, 'src/content/content.js'),
      output: {
        format: 'iife',
        entryFileNames: 'content.js',
        inlineDynamicImports: true
      }
    }
  },
  plugins: [
    nodePolyfills({
      include: ['path', 'stream', 'util', 'events', 'buffer', 'http', 'https', 'zlib', 'process', 'url', 'assert', 'timers', 'os', 'tty', 'vm', 'net', 'tls', 'fs', 'child_process'],
      globals: {
        Buffer: true,
        global: true,
        process: true,
      },
    })
  ]
});