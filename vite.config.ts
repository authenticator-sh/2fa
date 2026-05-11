import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'path';
import { copyFileSync, mkdirSync, readFileSync, writeFileSync, readdirSync, existsSync } from 'fs';

// Plugin to copy files after build
function copyFilesPlugin() {
  return {
    name: 'copy-files',
    writeBundle() {
      // Ensure dist directory exists
      mkdirSync(resolve(__dirname, 'dist'), { recursive: true });

      // Copy and rename HTML file, fix paths
      let htmlContent = readFileSync(resolve(__dirname, 'dist/src/popup/index.html'), 'utf-8');
      htmlContent = htmlContent.replace(/src="\/popup\.js"/g, 'src="./popup.js"');
      htmlContent = htmlContent.replace(/href="\/popup\.css"/g, 'href="./popup.css"');
      writeFileSync(resolve(__dirname, 'dist/popup.html'), htmlContent);

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
  build: {
    outDir: 'dist',
    rollupOptions: {
      input: {
        popup: resolve(__dirname, 'src/popup/index.html'),
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
