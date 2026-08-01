import type jsQRType from 'jsqr';

// Longest-side pixel targets to try, in order. Different resolutions change
// jsQR's binarization and catch QR codes a single pass misses — especially
// small QRs inside large screenshots. Sizes above the source are skipped
// (upscaling adds no information).
const SCALE_TARGETS = [2000, 1600, 1024, 640];

function decodeAtSize(
  decode: typeof jsQRType,
  bitmap: ImageBitmap,
  w: number,
  h: number
): string | null {
  const canvas = document.createElement('canvas');
  canvas.width = w;
  canvas.height = h;
  const ctx = canvas.getContext('2d', { willReadFrequently: true });
  if (!ctx) return null;
  ctx.drawImage(bitmap, 0, 0, w, h);
  const { data } = ctx.getImageData(0, 0, w, h);
  // attemptBoth also decodes light-on-dark ("inverted") QR codes.
  const result = decode(data, w, h, { inversionAttempts: 'attemptBoth' });
  return result?.data ?? null;
}

/**
 * Decodes a QR code from an image (a File/Blob or a data-URL string), returning
 * the raw decoded text or null if no QR is found. Runs jsQR directly on the
 * pixel data via an offscreen canvas — no DOM element required — and retries at
 * several resolutions, which recognizes screenshots far more reliably than
 * html5-qrcode's scanFile did.
 */
export async function decodeQrFromImage(source: File | Blob | string): Promise<string | null> {
  // Loaded on demand so jsQR stays out of the initial popup bundle — it's only
  // needed when the user actually scans a QR code.
  const { default: decode } = await import('jsqr');

  const blob = typeof source === 'string' ? await (await fetch(source)).blob() : source;
  const bitmap = await createImageBitmap(blob);
  try {
    const longest = Math.max(bitmap.width, bitmap.height);

    // Always try the source at its native size (capped at the largest target),
    // then progressively smaller passes.
    const targets = [Math.min(longest, SCALE_TARGETS[0])];
    for (const target of SCALE_TARGETS) {
      if (target < longest && !targets.includes(target)) targets.push(target);
    }

    for (const target of targets) {
      const scale = target / longest;
      const w = Math.max(1, Math.round(bitmap.width * scale));
      const h = Math.max(1, Math.round(bitmap.height * scale));
      const decoded = decodeAtSize(decode, bitmap, w, h);
      if (decoded) return decoded;
    }
    return null;
  } finally {
    bitmap.close?.();
  }
}
