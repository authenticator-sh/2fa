// Renders the images the README and the GitHub repository page show:
// the wordmark banner (light and dark), and the social preview card GitHub
// puts on a link to this repository.
//
//   npm run brand-assets
//
// They are PNGs rather than SVGs on purpose. An SVG wordmark is rendered with
// whatever font the reader happens to have, so the lockup's proportions change
// from machine to machine; rasterising here fixes them once. The mark is the
// same one as `public/icons/icon.svg`, minus the white plate that only exists
// so the icon reads inside Chrome's toolbar — on a README the plate is
// invisible on a light background and a white slab on a dark one.
//
// Output goes to .github/assets/. The screenshot beside them is not generated:
// it is the product shot from the website, trimmed and resized by hand.

import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { mkdirSync } from "node:fs";
import sharp from "sharp";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = join(ROOT, ".github", "assets");

// The key glyph from public/icons/icon.svg, drawn in a 28×28 box.
const KEY =
  "M21.015,6.986c0,2.627-1.449,4.916-3.593,6.108c3.991,15.362,3.991,15.362,3.991,15.362s-13.619,0-14.144,0" +
  "c4.145-14.989,0,0,4.145-14.989C8.853,12.433,7.042,9.92,7.042,6.986C7.042,3.127,10.169,0,14.028,0" +
  "C17.888,0,21.015,3.127,21.015,6.986z";

const FONT =
  '"Google Sans","Product Sans",-apple-system,"Helvetica Neue",Helvetica,Arial,sans-serif';

// The mark at `size` pixels, its top-left corner at (x, y). The glyph keeps the
// share of the disc it has in the toolbar icon (140 of 250), which is why it is
// scaled by 6 here rather than the 5 the icon uses inside its white plate.
function mark(x, y, size) {
  const s = size / 300;
  return `<g transform="translate(${x},${y}) scale(${s})">
    <circle cx="150" cy="150" r="150" fill="url(#disc)"/>
    <g transform="translate(150,150) scale(6) translate(-14,-14)" fill="#fff">
      <path d="${KEY}"/>
    </g>
  </g>`;
}

const DISC = `<linearGradient id="disc" x1="0" y1="0" x2="0" y2="1">
    <stop offset="0" stop-color="#4a90f7"/>
    <stop offset="1" stop-color="#1a73e8"/>
  </linearGradient>`;

// Drawn on a canvas wider than the lockup and trimmed afterwards, so the
// wordmark's real width decides the image rather than a guess at it.
function banner(color) {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="900" height="140" viewBox="0 0 900 140">
  <defs>${DISC}</defs>
  ${mark(0, 26, 88)}
  <text x="114" y="96" font-family='${FONT}' font-size="68" font-weight="500" fill="${color}">Authenticator</text>
</svg>`;
}

function socialPreview() {
  return `<svg xmlns="http://www.w3.org/2000/svg" width="1280" height="640" viewBox="0 0 1280 640">
  <defs>
    ${DISC}
    <linearGradient id="bg" x1="0" y1="0" x2="0.6" y2="1">
      <stop offset="0" stop-color="#ffffff"/>
      <stop offset="1" stop-color="#eaf1fe"/>
    </linearGradient>
  </defs>
  <rect width="1280" height="640" fill="url(#bg)"/>
  <circle cx="1180" cy="90" r="260" fill="#4285f4" opacity="0.06"/>
  <circle cx="120" cy="600" r="200" fill="#4285f4" opacity="0.05"/>
  ${mark(340, 120, 96)}
  <text x="460" y="200" font-family='${FONT}' font-size="76" font-weight="500" fill="#202124">Authenticator</text>
  <text x="640" y="312" text-anchor="middle" font-family='${FONT}' font-size="38" fill="#3c4043">Open-source TOTP codes in Chrome</text>
  <text x="640" y="382" text-anchor="middle" font-family='${FONT}' font-size="30" fill="#5f6368">No servers · No analytics · No host permissions</text>
  <rect x="490" y="442" width="300" height="4" rx="2" fill="#4285f4" opacity="0.35"/>
  <text x="640" y="518" text-anchor="middle" font-family='${FONT}' font-size="26" fill="#80868b">github.com/authenticator-sh/2fa</text>
</svg>`;
}

async function writeBanner(name, color) {
  const png = await sharp(Buffer.from(banner(color)), { density: 144 })
    .png()
    .toBuffer();
  await sharp(png)
    .trim({ threshold: 0 })
    .png({ compressionLevel: 9 })
    .toFile(join(OUT, name));
  console.log(`✓ ${name}`);
}

mkdirSync(OUT, { recursive: true });

await writeBanner("banner-light.png", "#202124");
await writeBanner("banner-dark.png", "#e6edf3");

await sharp(Buffer.from(socialPreview()))
  .png({ compressionLevel: 9 })
  .toFile(join(OUT, "social-preview.png"));
console.log("✓ social-preview.png");
