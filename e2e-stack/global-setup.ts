// Brings the stack up once for the run (see playwright.stack.config.ts), or
// takes the one named by STACK_API / STACK_SITE / STACK_WEBHOOK_SECRET.

import { spawn, spawnSync, type ChildProcess } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(fileURLToPath(new URL('.', import.meta.url)), '..');
export const STATE_FILE = join(ROOT, '.stack-build', 'stack-state.json');
export const BUILD_DIR = join(ROOT, '.stack-build', 'extension');

export interface StackState {
  api: string;
  site: string;
  webhookSecret: string;
  serverDir: string;
}

/** KEY=value lines; enough for the .env.local files these projects keep. */
export function readDotEnv(path: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of readFileSync(path, 'utf8').split('\n')) {
    const m = line.match(/^([A-Z0-9_]+)=(.*)$/);
    if (m) out[m[1]!] = m[2]!.replace(/^"|"$/g, '');
  }
  return out;
}

function run(cmd: string, args: string[], cwd: string, env: NodeJS.ProcessEnv): void {
  const r = spawnSync(cmd, args, { cwd, env, stdio: 'inherit' });
  if (r.status !== 0) throw new Error(`${args.join(' ')} failed in ${cwd}`);
}

async function waitFor(url: string, what: string, child?: ChildProcess): Promise<void> {
  const until = Date.now() + 300_000;
  while (Date.now() < until) {
    if (child && child.exitCode !== null) {
      throw new Error(`${what} exited (code ${child.exitCode}) — is a next dev already running in that folder? Point STACK_SERVER_DIR / STACK_SITE_DIR at another checkout (a git worktree) if so.`);
    }
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 1000));
  }
  throw new Error(`${what} did not come up at ${url}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const serverDir = resolve(ROOT, process.env.STACK_SERVER_DIR ?? '../server');
  const siteDir = resolve(ROOT, process.env.STACK_SITE_DIR ?? '../site');
  const serverEnv = readDotEnv(join(serverDir, '.env.local'));
  const stripeKey = serverEnv.STRIPE_SECRET_KEY ?? '';
  if (!/^(sk|rk)_test_/.test(stripeKey)) throw new Error('the stack test needs a Stripe test key in ../server/.env.local');

  const apiPort = Number(process.env.STACK_API_PORT ?? 3300);
  const sitePort = Number(process.env.STACK_SITE_PORT ?? 3400);
  const api = process.env.STACK_API ?? `http://localhost:${apiPort}`;
  const site = process.env.STACK_SITE ?? `http://localhost:${sitePort}`;
  const external = !!process.env.STACK_API;
  const webhookSecret = external ? (process.env.STACK_WEBHOOK_SECRET ?? '') : `whsec_${randomBytes(24).toString('hex')}`;
  if (!webhookSecret) throw new Error('STACK_API is set: set STACK_WEBHOOK_SECRET to the secret that server checks webhooks with');

  const node = process.execPath;
  const children: ChildProcess[] = [];
  let pglite: string | null = null;

  if (!external) {
    pglite = mkdtempSync(join(tmpdir(), 'authenticator-stack-db-'));
    // The server's own .env.local is read by Next as well; these win over it.
    const env: NodeJS.ProcessEnv = {
      ...process.env,
      ...serverEnv,
      NODE_ENV: 'development',
      PGLITE_DIR: pglite,
      SITE_ORIGIN: site,
      STRIPE_WEBHOOK_SECRET: webhookSecret,
      // Empty on purpose: the admin's development mode (password "admin").
      ADMIN_PASSWORD_HASH: '',
      ADMIN_TOTP_SECRET: '',
      ADMIN_SESSION_SECRET: '',
    };
    delete env.DATABASE_URL;
    delete env.PREVIEW_DATABASE_URL;

    const tsx = join(serverDir, 'node_modules/tsx/dist/cli.mjs');
    run(node, [tsx, 'scripts/stripe-catalog.ts'], serverDir, env);
    run(node, [tsx, 'scripts/e2e-seed.ts'], serverDir, env);
    // Regional prices as production has them: tier-1 currencies, tier 2/3 prices and their rules (sandbox; today's rates).
    run(node, [tsx, 'scripts/regional-prices.ts', '--write'], serverDir, env);

    // Their output goes to .stack-build/*.log: the first place to look when a step fails on the server side.
    mkdirSync(join(ROOT, '.stack-build'), { recursive: true });
    const log = (name: string) => openSync(join(ROOT, '.stack-build', `${name}.log`), 'w');
    const server = spawn(node, [join(serverDir, 'node_modules/next/dist/bin/next'), 'dev', '--port', String(apiPort)], { cwd: serverDir, env, stdio: ['ignore', log('server'), log('server-err')] });
    children.push(server);
    const siteEnv: NodeJS.ProcessEnv = { PATH: process.env.PATH, HOME: process.env.HOME, NEXT_PUBLIC_API_ORIGIN: api };
    const siteProc = spawn(node, [join(siteDir, 'node_modules/next/dist/bin/next'), 'dev', '--port', String(sitePort)], { cwd: siteDir, env: siteEnv, stdio: ['ignore', log('site'), log('site-err')] });
    children.push(siteProc);
    try {
      await waitFor(`${api}/v1/health`, 'the server', server);
      await waitFor(`${site}/pro/success`, 'the site', siteProc);
    } catch (error) {
      // A failed setup gets no teardown: stop what was started, or it holds the ports.
      for (const child of children) child.kill('SIGTERM');
      rmSync(pglite, { recursive: true, force: true });
      throw error;
    }
  }

  // The extension, trusting the preview signing key the local server signs with.
  // The release day moved back: the accounts these tests make "today" must
  // not read as made before billing (src/billing/config.ts).
  run(
    node,
    [join(ROOT, 'node_modules/vite/bin/vite.js'), 'build', '--outDir', BUILD_DIR, '--emptyOutDir', '--logLevel', 'warn'],
    ROOT,
    { ...process.env, BILLING_ENV: 'preview', BILLING_API: api, BILLING_RELEASE: '2026-01-01' }
  );

  // The Stripe key stays in ../server/.env.local; the tests read it from there.
  const state: StackState = { api, site, webhookSecret, serverDir };
  writeFileSync(STATE_FILE, JSON.stringify(state));

  return async () => {
    for (const child of children) child.kill('SIGTERM');
    rmSync(STATE_FILE, { force: true });
    if (pglite) rmSync(pglite, { recursive: true, force: true });
  };
}
