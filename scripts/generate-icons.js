import { writeFileSync } from 'fs';
import { resolve, dirname } from 'path';
import { fileURLToPath } from 'url';
import { mkdirSync } from 'fs';

const __dirname = dirname(fileURLToPath(import.meta.url));

// Minimal PNG files (1x1 pixel) as base64
const minimalPNG = {
  16: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAABAAAAAQCAYAAAAf8/9hAAAAE0lEQVR42mNgYGD4z0AEYBw5AADXvw/5FUf7HQAAAABJRU5ErkJggg==', 'base64'),
  48: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAYAAABXAvmHAAAAGUlEQVR42u3BAQ0AAADCIPunNsc3YAAAAOAGCfQAAafmWFUAAAAASUVORK5CYII=', 'base64'),
  128: Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAIAAAACACAYAAADDPmHLAAAANUlEQVR42u3BAQ0AAADCIPunNsc3YAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAADgBgP8AAGQHcXOAAAAAElFTkSuQmCC', 'base64')
};

const iconsDir = resolve(__dirname, '../public/icons');

// Create icons directory if it doesn't exist
try {
  mkdirSync(iconsDir, { recursive: true });
} catch (e) {
  // Directory exists
}

// Generate icon files
Object.entries(minimalPNG).forEach(([size, buffer]) => {
  const filename = resolve(iconsDir, `icon${size}.png`);
  writeFileSync(filename, buffer);
  console.log(`Created ${filename}`);
});

console.log('\nPlaceholder icons created successfully!');
console.log('For better icons, convert public/icons/icon.svg to PNG using:');
console.log('- Online tool: https://cloudconvert.com/svg-to-png');
console.log('- Or ImageMagick: convert icon.svg -resize 16x16 icon16.png');
