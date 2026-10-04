import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync, rmSync } from 'fs';

// Plugin to copy files after build
function copyFilesPlugin(): Plugin {
  // Where this build actually writes. It used to be hardcoded as dist/, so
  // `vite build --outDir elsewhere` put the bundle elsewhere but then read and
  // rewrote the HTML in the real dist/ — a trial build clobbered the last
  // release build. Taken from the resolved config so --outDir is honoured.
  let outDir = resolve(__dirname, 'dist');
  const out = (...parts: string[]) => resolve(outDir, ...parts);

  return {
    name: 'copy-files',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
    },
    writeBundle() {
      // Ensure the output directory exists
      mkdirSync(outDir, { recursive: true });

      // Rewrite absolute asset URLs to relative paths and move HTML to the output root.
      const rewriteAbsoluteAssets = (html: string) =>
        html
          .replace(/(src|href)="\/([^"]+)"/g, '$1="./$2"');

      const popupHtml = rewriteAbsoluteAssets(
        readFileSync(out('src/popup/index.html'), 'utf-8')
      );
      writeFileSync(out('popup.html'), popupHtml);
      // The same document under two more names: the floating window and the
      // side panel. The page tells which it is from its file name (see
      // utils/open-mode.ts), so these must stay byte-identical copies rather
      // than become entries of their own.
      writeFileSync(out('window.html'), popupHtml);
      writeFileSync(out('sidepanel.html'), popupHtml);

      const scanHtml = rewriteAbsoluteAssets(
        readFileSync(out('src/scan/index.html'), 'utf-8')
      );
      writeFileSync(out('scan.html'), scanHtml);

      const passkeyHtml = rewriteAbsoluteAssets(
        readFileSync(out('src/passkey/index.html'), 'utf-8')
      );
      writeFileSync(out('passkey.html'), passkeyHtml);

      // The generated HTML has been rewritten and moved to the output root; the
      // nested copy would otherwise ship as dead weight inside the package.
      rmSync(out('src'), { recursive: true, force: true });

      // Copy manifest.json
      copyFileSync(
        resolve(__dirname, 'public/manifest.json'),
        out('manifest.json')
      );

      // Create icons directory
      mkdirSync(out('icons'), { recursive: true });

      // Copy icons
      ['icon16.png', 'icon48.png', 'icon128.png'].forEach(icon => {
        try {
          copyFileSync(
            resolve(__dirname, 'public/icons', icon),
            out('icons', icon)
          );
        } catch (e) {
          console.log(`Icon ${icon} not found, skipping`);
        }
      });

      // Copy any bundled images (none at present — the welcome page is hosted
      // at authenticator.sh/welcome and no longer ships with the extension)
      const imagesDir = resolve(__dirname, 'public/images');
      if (existsSync(imagesDir)) {
        const destImages = out('images');
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
          const destPath = out('_locales', locale);
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

// Which billing server this build talks to and which signing keys it trusts
// (src/billing/config.ts, src/billing/keys.ts). A plain `vite build` is a
// store build: production server, production key only. Development points at
// a local or preview server with BILLING_ENV=preview BILLING_API=http://localhost:3100;
// the e2e build uses BILLING_ENV=test and the key under test/fixtures.
const BILLING_ENV = process.env.BILLING_ENV ?? 'production';
if (!['production', 'preview', 'test'].includes(BILLING_ENV)) {
  throw new Error(`BILLING_ENV must be production, preview or test (got ${BILLING_ENV})`);
}

export default defineConfig({
  plugins: [react(), copyFilesPlugin()],
  define: {
    __BILLING_ENV__: JSON.stringify(BILLING_ENV),
    __BILLING_API__: JSON.stringify(process.env.BILLING_API ?? ''),
    // Ignored by a store build (src/billing/config.ts); test builds move the release day.
    __BILLING_RELEASE__: JSON.stringify(process.env.BILLING_RELEASE ?? ''),
  },
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
