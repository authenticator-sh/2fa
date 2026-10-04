// Checks the built extension, not the source.
//
//   npm run check:bundle              checks dist/
//   npm run check:bundle -- <dir>     checks another build (e.g. the e2e one)
//
// The unit tests read src/, and a few of them pin properties of the bundle by
// looking at the source with a regex (see runWorkerLanguage in
// test/quick-fill.test.ts). That catches the mistake as it was written the last
// time, not the next way to make it: the bundler decides what actually ends up
// in the worker, and it does so across files the regex never looks at.
//
// Two classes of breakage only show up in a real browser and are cheap to rule
// out here instead:
//
// 1. Chrome refuses `import()` in a service worker outright ("import() is
//    disallowed on ServiceWorkerGlobalScope"). A dynamic import anywhere in the
//    worker's static graph — its own file or any chunk it pulls in — fails at
//    run time, and quietly: the worker still starts, the feature is just gone.
//    That is how the right-click item stayed English in every language. So this
//    walks the worker's static `import … from` / `export … from` graph over the
//    emitted files and fails if any reachable file contains `import(`, calls
//    loadLanguage (visible only in unminified builds), or is one of the full
//    locale tables (which the worker must not carry — see background/strings).
//
// 2. A package Chrome refuses to load, or loads with a blank page: the manifest,
//    the default locale that its __MSG_…__ placeholders resolve against, the
//    icons it names, and every HTML page the extension opens — from the manifest
//    and from the chrome.runtime.getURL('….html') calls in src/ — together with
//    the scripts and styles each page references.
//
// Exit status is the point: non-zero on any problem, so CI can run it after the
// build.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { basename, dirname, join, posix, relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUT = resolve(ROOT, process.argv[2] ?? "dist");

const problems: string[] = [];
const problem = (message: string) => problems.push(message);

function readText(path: string): string | null {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function walk(dir: string): string[] {
  const found: string[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...walk(full));
    else if (entry.isFile()) found.push(full);
  }
  return found;
}

const rel = (path: string) => relative(OUT, path).split("\\").join("/");

// --- manifest -----------------------------------------------------------------

if (!existsSync(OUT)) {
  console.error(`check:bundle: ${OUT} does not exist — build first`);
  process.exit(1);
}

const manifestText = readText(join(OUT, "manifest.json"));
let manifest: any = null;
if (manifestText === null) problem("manifest.json is missing");
else {
  try {
    manifest = JSON.parse(manifestText);
  } catch (error) {
    problem(`manifest.json is not JSON (${(error as Error).message})`);
  }
}

// --- locales --------------------------------------------------------------------

// The manifest's own name and description are __MSG_…__ placeholders. Chrome
// refuses to load a package whose default locale is missing, and shows the raw
// placeholder for a key the default locale lacks.
const defaultLocale: string = manifest?.default_locale ?? "en";
const defaultMessagesPath = join(OUT, "_locales", defaultLocale, "messages.json");
let defaultMessages: Record<string, unknown> | null = null;
const defaultMessagesText = readText(defaultMessagesPath);
if (defaultMessagesText === null) problem(`${rel(defaultMessagesPath)} is missing`);
else {
  try {
    defaultMessages = JSON.parse(defaultMessagesText);
  } catch (error) {
    problem(`${rel(defaultMessagesPath)} is not JSON (${(error as Error).message})`);
  }
}
if (defaultLocale !== "en" && !isFile(join(OUT, "_locales", "en", "messages.json"))) {
  problem("_locales/en/messages.json is missing");
}
if (manifestText !== null && defaultMessages) {
  // Chrome matches message names case-insensitively.
  const known = new Set(Object.keys(defaultMessages).map((key) => key.toLowerCase()));
  for (const [, key] of manifestText.matchAll(/__MSG_(\w+)__/g)) {
    if (!known.has(key.toLowerCase())) {
      problem(`manifest uses __MSG_${key}__, which ${rel(defaultMessagesPath)} does not define`);
    }
  }
}

// --- icons ----------------------------------------------------------------------

if (manifest) {
  const icons = new Set<string>();
  const collect = (value: unknown) => {
    if (typeof value === "string") icons.add(value);
    else if (value && typeof value === "object") Object.values(value).forEach(collect);
  };
  collect(manifest.icons);
  collect(manifest.action?.default_icon);
  if (icons.size === 0) problem("manifest names no icons");
  for (const icon of icons) {
    if (!isFile(join(OUT, icon))) problem(`icon ${icon} (named in the manifest) is missing`);
  }
}

// --- pages ----------------------------------------------------------------------

// Pages the manifest points Chrome at, plus every page the code opens by name.
// The second set is read from src/ rather than listed here: a list would be one
// more thing to forget when a page is added, and the code is what users hit.
const pages = new Set<string>();
if (manifest) {
  for (const page of [
    manifest.action?.default_popup,
    manifest.side_panel?.default_path,
    manifest.options_page,
    manifest.options_ui?.page,
    manifest.devtools_page,
    manifest.chrome_url_overrides?.newtab,
  ]) {
    if (typeof page === "string") pages.add(page);
  }
}
for (const file of walk(join(ROOT, "src"))) {
  if (!/\.(ts|tsx)$/.test(file)) continue;
  const source = readFileSync(file, "utf8");
  for (const [, page] of source.matchAll(/['"`]([a-z][\w-]*\.html)\b/g)) pages.add(page);
}
if (pages.size === 0) problem("found no HTML pages to check");
for (const page of [...pages].sort()) {
  const html = readText(join(OUT, page));
  if (html === null) {
    problem(`page ${page} is missing`);
    continue;
  }
  // Every local script and stylesheet the page loads. A dangling one is a blank
  // page in the browser and nothing at all in the build log.
  let scripts = 0;
  for (const [, attr, url] of html.matchAll(/\b(src|href)="([^"]+)"/g)) {
    if (/^(?:[a-z]+:|#|\/\/)/i.test(url)) continue;
    if (attr === "src") scripts++;
    const target = posix.normalize(posix.join(posix.dirname(page), url.split(/[?#]/)[0]));
    if (target.startsWith("..") || target.startsWith("/")) {
      problem(`${page} references ${url}, outside the package`);
    } else if (!isFile(join(OUT, target))) {
      problem(`${page} references ${url}, which is missing`);
    }
  }
  if (scripts === 0) problem(`${page} loads no script`);
}

// --- service worker -------------------------------------------------------------

// Full locale tables are emitted as <code>.js chunks (chunkFileNames '[name].js'
// in vite.config.ts), named after src/utils/locales/<code>.ts.
const localeChunks = new Set(
  readdirSync(join(ROOT, "src/utils/locales"))
    .filter((name) => name.endsWith(".ts"))
    .map((name) => `${basename(name, ".ts")}.js`)
);

const workerPath: string | undefined = manifest?.background?.service_worker;
if (manifest && !workerPath) problem("manifest declares no background.service_worker");
if (workerPath) {
  if (manifest.background.type !== "module") {
    // Rollup emits ES modules; a classic worker cannot `import` at all.
    problem(`background.type is ${JSON.stringify(manifest.background.type)}, not "module"`);
  }

  // Static edges only: `import … from "x"`, bare `import "x"`, `export … from "x"`.
  // The optional `\s*` covers both minified (`from"x"`) and formatted output.
  // The lookbehinds keep keys like "settings.import" in the string tables from
  // reading as a bare `import "…"`.
  const STATIC_EDGE =
    /(?<![\w$."'])(?:import|export)\b[^;"'`()]*?\bfrom\s*(["'])([^"']+)\1|(?<![\w$."'])import\s*(["'])([^"']+)\3/g;
  const DYNAMIC_IMPORT = /(?<![\w$.])import\s*\(/;

  const seen = new Set<string>();
  const queue: Array<{ path: string; via: string[] }> = [
    { path: resolve(OUT, workerPath), via: [] },
  ];
  while (queue.length > 0) {
    const { path, via } = queue.shift()!;
    if (seen.has(path)) continue;
    seen.add(path);
    const chain = [...via, rel(path)].join(" → ");

    const code = readText(path);
    if (code === null) {
      problem(`service worker imports ${rel(path)}, which is missing (${chain})`);
      continue;
    }
    const at = code.search(DYNAMIC_IMPORT);
    if (at !== -1) {
      const excerpt = code.slice(Math.max(0, at - 40), at + 60).replace(/\s+/g, " ");
      problem(
        `service worker reaches import() — Chrome refuses it there (${chain}): …${excerpt}…`
      );
    }
    if (/\bloadLanguage\s*\(/.test(code)) {
      problem(`service worker reaches a loadLanguage() call (${chain})`);
    }
    if (dirname(path) === OUT && localeChunks.has(basename(path))) {
      problem(`service worker bundles the full locale table ${rel(path)} (${chain})`);
    }

    for (const match of code.matchAll(STATIC_EDGE)) {
      const specifier = match[2] ?? match[4];
      if (!specifier.startsWith(".") && !specifier.startsWith("/")) {
        // A bare specifier cannot be resolved by the browser at all.
        problem(`service worker imports the bare specifier "${specifier}" (${chain})`);
        continue;
      }
      const target = specifier.startsWith("/")
        ? join(OUT, specifier)
        : resolve(dirname(path), specifier);
      queue.push({ path: target, via: [...via, rel(path)] });
    }
  }
  console.log(`service worker graph: ${[...seen].map(rel).join(", ")}`);
}

// --- billing: a store build trusts production and nothing else --------------------
//
// The signing keys a build trusts and the server it talks to are chosen at
// build time (src/billing/config.ts, keys.ts). A store build carrying the
// preview or test key would accept licenses signed by a key that sits in a
// developer's .secrets folder or in this repository; one pointed at localhost
// would never reach the server at all. Both are one wrong environment variable
// away, so the built code is searched for them. Pass `--billing=test` or
// `--billing=preview` for builds that are meant to carry them.

{
  const billingFlag = process.argv.find(arg => arg.startsWith("--billing="))?.slice("--billing=".length);
  const allowed = billingFlag ?? (OUT.endsWith(".e2e-build") ? "test" : "production");
  const forbidden: [string, string][] =
    allowed === "production"
      ? [
          ["test-only", "the test signing key"],
          ["prev-2026", "the preview signing key"],
          ["localhost:3100", "the local billing server"],
          ["127.0.0.1:3199", "the e2e billing server"],
        ]
      : [];
  const scripts = walk(OUT).filter(path => path.endsWith(".js"));
  for (const [needle, what] of forbidden) {
    const hit = scripts.find(path => (readText(path) ?? "").includes(needle));
    if (hit) problem(`store build carries ${what} ("${needle}") in ${rel(hit)}`);
  }
  if (allowed === "production" && !scripts.some(path => (readText(path) ?? "").includes("https://api.authenticator.sh"))) {
    problem("store build does not talk to https://api.authenticator.sh");
  }
  console.log(`billing: checked as a ${allowed} build`);
}

// --- verdict --------------------------------------------------------------------

console.log(`pages: ${[...pages].sort().join(", ")}`);
if (problems.length > 0) {
  console.error(`\ncheck:bundle: ${problems.length} problem(s) in ${OUT}`);
  for (const message of problems) console.error(`  ✗ ${message}`);
  process.exit(1);
}
console.log(`check:bundle: ${OUT} looks loadable`);
