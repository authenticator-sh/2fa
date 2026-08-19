// Probes every time source the extension depends on, using the extension's own
// fetchers.
//
//   npm run check:deps
//
// This exists because of a bug that cost months of silence: the clock check
// required two sources to agree, one of them (worldtimeapi.org) went dead, and
// nothing anywhere could tell. The code was correct; the world had changed.
// Reading code cannot catch that — only talking to the hosts can.
//
// So this does not mock anything. It calls the real SOURCES from time-sync.ts,
// which means it fails not only when a host dies, but also when one quietly
// changes its response shape and the parser stops understanding it.
//
// Exit status is the point: non-zero if fewer than two sources work, because
// two agreeing sources is exactly what the feature needs to do anything at all.
// Run it before a release, and on a schedule.

import { SOURCES } from "../src/utils/time-sync";

// Real Chrome sends this from the popup. The hosts have to answer it, or the
// browser drops the response before our code ever sees it — a failure mode that
// is invisible from curl without the header.
const ORIGIN = "chrome-extension://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa";

const TIMEOUT_MS = 5000;
// This machine's clock is the reference. Anything further out is either a
// broken source or a broken dev machine, and both are worth stopping for.
const SANE_SKEW_MS = 60_000;

interface Outcome {
  name: string;
  url: string;
  ok: boolean;
  rttMs?: number;
  skewMs?: number;
  cors?: string;
  problem?: string;
}

/** Does this host let a chrome-extension:// page read the response at all? */
async function corsVerdict(url: string): Promise<{ ok: boolean; detail: string }> {
  try {
    const response = await fetch(url, {
      headers: { Origin: ORIGIN },
      cache: "no-store",
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    const allow = response.headers.get("access-control-allow-origin");
    if (allow === "*" || allow === ORIGIN) return { ok: true, detail: allow };
    if (allow === null) return { ok: false, detail: "no ACAO header" };
    return { ok: false, detail: `ACAO is ${allow}` };
  } catch (error) {
    return { ok: false, detail: `unreachable (${(error as Error).message})` };
  }
}

async function probe(source: (typeof SOURCES)[number]): Promise<Outcome> {
  const base = { name: source.name, url: source.url };

  let serverMs: number;
  const t0 = Date.now();
  try {
    serverMs = await source.fetchServerMs(AbortSignal.timeout(TIMEOUT_MS));
  } catch (error) {
    return { ...base, ok: false, problem: (error as Error).message };
  }
  const t1 = Date.now();

  const skewMs = serverMs - (t0 + t1) / 2;
  if (!Number.isFinite(serverMs) || Math.abs(skewMs) > SANE_SKEW_MS) {
    return { ...base, ok: false, rttMs: t1 - t0, skewMs, problem: `implausible time (${Math.round(skewMs / 1000)}s off)` };
  }

  const cors = await corsVerdict(source.url);
  return {
    ...base,
    ok: cors.ok,
    rttMs: t1 - t0,
    skewMs,
    cors: cors.detail,
    problem: cors.ok ? undefined : `CORS: ${cors.detail}`,
  };
}

const outcomes = await Promise.all(SOURCES.map(probe));

for (const outcome of outcomes) {
  const mark = outcome.ok ? "ok  " : "DEAD";
  const detail = outcome.ok
    ? `${outcome.rttMs}ms rtt, ${Math.round(outcome.skewMs ?? 0)}ms skew, ACAO ${outcome.cors}`
    : outcome.problem;
  console.log(`${mark} ${outcome.name.padEnd(12)} ${detail}`);
  if (!outcome.ok) console.log(`     ${outcome.url}`);
}

const working = outcomes.filter((o) => o.ok).length;
console.log(`\ncheck-deps: ${working}/${outcomes.length} sources usable`);

if (working < 2) {
  console.error(
    "check-deps: FAILED — the clock check needs two agreeing sources, so it is currently doing nothing for every user."
  );
  process.exit(1);
}
if (working < outcomes.length) {
  console.error("check-deps: a source is down — replace it before the pool drops to one.");
  process.exit(1);
}
