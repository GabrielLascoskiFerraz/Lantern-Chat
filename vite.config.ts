import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';

const fluentEmojiAssetsDir = path.resolve(
  __dirname,
  'node_modules',
  '@lobehub',
  'fluent-emoji-3d',
  'assets'
);

const fluentEmojiAssetsPlugin = (): Plugin => ({
  name: 'lantern-fluent-emoji-assets',
  configureServer(server) {
    server.middlewares.use('/fluent-emoji-3d', (request, response, next) => {
      const requestPath = decodeURIComponent((request.url || '').split('?')[0]).replace(/^\/+/, '');
      if (!/^[0-9a-f-]+\.webp$/u.test(requestPath)) {
        next();
        return;
      }

      const filePath = path.join(fluentEmojiAssetsDir, requestPath);
      if (!filePath.startsWith(`${fluentEmojiAssetsDir}${path.sep}`) || !fs.existsSync(filePath)) {
        next();
        return;
      }

      response.statusCode = 200;
      response.setHeader('Content-Type', 'image/webp');
      response.setHeader('Cache-Control', 'public, max-age=31536000, immutable');
      fs.createReadStream(filePath).pipe(response);
    });
  },
  writeBundle() {
    if (!fs.existsSync(fluentEmojiAssetsDir)) {
      throw new Error('Os ativos do Fluent Emoji 3D não foram encontrados. Execute npm install.');
    }

    fs.cpSync(
      fluentEmojiAssetsDir,
      path.resolve(__dirname, 'dist-renderer', 'fluent-emoji-3d'),
      { recursive: true }
    );
  }
});

export default defineConfig({
  root: path.resolve(__dirname, 'renderer'),
  base: './',
  plugins: [fluentEmojiAssetsPlugin()],
  build: {
    outDir: path.resolve(__dirname, 'dist-renderer'),
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined;
          if (id.includes('@fluentui') || id.includes('@griffel')) return 'ui-vendor';
          if (id.includes('/react/') || id.includes('/react-dom/')) return 'react-vendor';
          if (id.includes('/zustand/')) return 'state-vendor';
          return 'vendor';
        }
      }
    }
  },
  server: {
    port: 5173,
    strictPort: true
  }
});
