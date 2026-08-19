import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';

// Plugin to copy files after build
function copyFilesPlugin() {
  return {
    name: 'copy-files',
    writeBundle() {
      // Ensure dist directory exists
      mkdirSync(resolve(__dirname, 'dist'), { recursive: true });

      // Rewrite absolute asset URLs to relative paths and move HTML to dist root.
      const rewriteAbsoluteAssets = (html: string) =>
        html
          .replace(/(src|href)="\/([^"]+)"/g, '$1="./$2"');

      const popupHtml = rewriteAbsoluteAssets(
        readFileSync(resolve(__dirname, 'dist/src/popup/index.html'), 'utf-8')
      );
      writeFileSync(resolve(__dirname, 'dist/popup.html'), popupHtml);

      const scanHtml = rewriteAbsoluteAssets(
        readFileSync(resolve(__dirname, 'dist/src/scan/index.html'), 'utf-8')
      );
      writeFileSync(resolve(__dirname, 'dist/scan.html'), scanHtml);

      const passkeyHtml = rewriteAbsoluteAssets(
        readFileSync(resolve(__dirname, 'dist/src/passkey/index.html'), 'utf-8')
      );
      writeFileSync(resolve(__dirname, 'dist/passkey.html'), passkeyHtml);

      // The generated HTML has been rewritten and moved to the dist root; the
      // nested copy would otherwise ship as dead weight inside the package.
      rmSync(resolve(__dirname, 'dist/src'), { recursive: true, force: true });

      // Copy manifest.json
      copyFileSync(
        resolve(__dirname, 'public/manifest.json'),
        resolve(__dirname, 'dist/manifest.json')
      );

      // Create icons directory
      mkdirSync(resolve(__dirname, 'dist/icons'), { recursive: true });

      // Copy icons
      ['icon16.png', 'icon48.png', 'icon128.png'].forEach(icon => {
        try {
          copyFileSync(
            resolve(__dirname, 'public/icons', icon),
            resolve(__dirname, 'dist/icons', icon)
          );
        } catch (e) {
          console.log(`Icon ${icon} not found, skipping`);
        }
      });

      // Copy any bundled images (none at present — the welcome page is hosted
      // at authenticator.sh/welcome and no longer ships with the extension)
      const imagesDir = resolve(__dirname, 'public/images');
      if (existsSync(imagesDir)) {
        const destImages = resolve(__dirname, 'dist/images');
        mkdirSync(destImages, { recursive: true });
        readdirSync(imagesDir).forEach((file) => {
          copyFileSync(resolve(imagesDir, file), resolve(destImages, file));
        });
      }

      // Copy translations to _locales
      const translationsDir = resolve(__dirname, 'public/translations');
      if (existsSync(translationsDir)) {
        const locales = readdirSync(translationsDir);
        locales.forEach(locale => {
          const localePath = resolve(translationsDir, locale);
          const destPath = resolve(__dirname, 'dist/_locales', locale);
          mkdirSync(destPath, { recursive: true });
          const files = readdirSync(localePath);
          files.forEach(file => {
            copyFileSync(
              resolve(localePath, file),
              resolve(destPath, file)
            );
          });
        });
      }
    },
  };
}

export default defineConfig({
  plugins: [react(), copyFilesPlugin()],
  // Everything under public/ is placed deliberately by copyFilesPlugin —
  // manifest to the root, icons to icons/, translations to _locales/. Letting
  // Vite also mirror public/ verbatim shipped a second, unused 488 KB copy of
  // every translation file inside the extension package.
  publicDir: false,
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
        scan: resolve(__dirname, 'src/scan/index.html'),
        // Keyed 'passkey-page' rather than 'passkey': the chunk name comes from
        // this key, and 'passkey' collides with src/utils/passkey.ts — rollup
        // resolves it by renaming one of them to passkey2.js, which works only
        // as long as the entry happens to win the name.
        'passkey-page': resolve(__dirname, 'src/passkey/index.html'),
        'background/service-worker': resolve(__dirname, 'src/background/service-worker.ts'),
      },
      output: {
        entryFileNames: '[name].js',
        chunkFileNames: '[name].js',
        assetFileNames: '[name].[ext]',
      },
    },
  },
  resolve: {
    alias: {
      '@': resolve(__dirname, './src'),
    },
  },
});
