// Other apps' real backup files, from Aegis's importer tests: fetched pinned to
// one commit and cached in the gitignored test/fixtures/.aegis/, never
// committed — Aegis is GPL.

import { mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export const AEGIS_COMMIT = 'd6f4e5925a97e4e91593f1542085eae03432a759';
const CACHE = fileURLToPath(new URL('./fixtures/.aegis/', import.meta.url));

/** The files, from the cache or the network; null when neither has them all. */
export async function aegisFiles(names: string[]): Promise<Map<string, Uint8Array> | null> {
  const files = new Map<string, Uint8Array>();
  mkdirSync(CACHE, { recursive: true });
  for (const name of names) {
    const path = `${CACHE}${AEGIS_COMMIT.slice(0, 8)}-${name}`;
    if (!existsSync(path)) {
      try {
        const response = await fetch(
          `https://raw.githubusercontent.com/beemdevelopment/Aegis/${AEGIS_COMMIT}/app/src/test/resources/com/beemdevelopment/aegis/importers/${name}`
        );
        if (!response.ok) return null;
        writeFileSync(path, new Uint8Array(await response.arrayBuffer()));
      } catch {
        return null;
      }
    }
    files.set(name, new Uint8Array(readFileSync(path)));
  }
  return files;
}
