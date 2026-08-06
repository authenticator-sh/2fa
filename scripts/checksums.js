// Writes SHA256SUMS-v<version>.txt for the contents of dist/.
//
// The site tells people they can rebuild a tag and compare the result against
// what ships on the Web Store (see "Verifying what we publish" on
// /how-it-works). That claim is only true if the sums file actually gets
// produced for every release, so this is a build step rather than something to
// remember by hand.
//
//   npm run checksums          write SHA256SUMS-v<version>.txt
//   npm run checksums -- --check   recompute and diff against that file
//
// Format is `<sha256>  <path>` with paths relative to dist/, sorted by byte
// order — the same layout sha256sum(1) reads, so `sha256sum -c` works on the
// file from inside dist/.

import { createHash } from "node:crypto";
import { readdirSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const DIST = join(ROOT, "dist");

function fail(message) {
  console.error(`checksums: ${message}`);
  process.exit(1);
}

function walk(dir) {
  const found = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

function readVersion(manifestPath, label) {
  let raw;
  try {
    raw = readFileSync(manifestPath, "utf8");
  } catch {
    fail(`no ${label} manifest at ${relative(ROOT, manifestPath)}`);
  }
  let version;
  try {
    version = JSON.parse(raw).version;
  } catch {
    fail(`${label} manifest is not valid JSON: ${relative(ROOT, manifestPath)}`);
  }
  if (!version) fail(`${label} manifest has no version`);
  return version;
}

try {
  if (!statSync(DIST).isDirectory()) throw new Error("not a directory");
} catch {
  fail("dist/ is missing — run `npm run build` first");
}

// A dist/ left over from an earlier version would produce a sums file named
// after the wrong release, which is worse than no sums file at all.
const version = readVersion(join(DIST, "manifest.json"), "built");
const sourceVersion = readVersion(join(ROOT, "public", "manifest.json"), "source");
if (version !== sourceVersion) {
  fail(
    `dist/ is stale: built ${version}, source says ${sourceVersion} — run \`npm run build\``
  );
}

const files = walk(DIST)
  .map((full) => relative(DIST, full))
  .sort((a, b) => Buffer.compare(Buffer.from(a), Buffer.from(b)));

if (files.length === 0) fail("dist/ is empty — run `npm run build` first");

const lines = files.map((rel) => {
  const hash = createHash("sha256").update(readFileSync(join(DIST, rel))).digest("hex");
  return `${hash}  ${rel}`;
});
const body = lines.join("\n") + "\n";

const outName = `SHA256SUMS-v${version}.txt`;
const outPath = join(ROOT, outName);

if (process.argv.includes("--check")) {
  let existing;
  try {
    existing = readFileSync(outPath, "utf8");
  } catch {
    fail(`${outName} does not exist yet — run \`npm run checksums\``);
  }

  const parse = (text) =>
    new Map(
      text
        .split("\n")
        .filter(Boolean)
        .map((line) => {
          const at = line.indexOf("  ");
          return [line.slice(at + 2), line.slice(0, at)];
        })
    );

  const want = parse(existing);
  const got = parse(body);
  const problems = [];

  for (const [path, hash] of got) {
    if (!want.has(path)) problems.push(`added:    ${path}`);
    else if (want.get(path) !== hash) problems.push(`changed:  ${path}`);
  }
  for (const path of want.keys()) {
    if (!got.has(path)) problems.push(`removed:  ${path}`);
  }

  if (problems.length > 0) {
    console.error(`checksums: dist/ does not match ${outName}`);
    for (const problem of problems.sort()) console.error(`  ${problem}`);
    process.exit(1);
  }
  console.log(`checksums: dist/ matches ${outName} (${got.size} files)`);
} else {
  writeFileSync(outPath, body);
  console.log(`checksums: wrote ${outName} (${lines.length} files)`);
}
