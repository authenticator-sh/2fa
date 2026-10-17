// The banners the server sets (policy.banner — one, or a list with one per
// place): parsed defensively, decided by a pure function, and closed per id —
// closing one banner never hides the next.

import type { Banner } from './types';

/**
 * Where a url banner may lead — the server checks the same list
 * (server/src/lib/policy/defaults.ts). Checked here as well: a 2FA extension
 * must not become a way to send its users somewhere, whatever signed it.
 */
export const BANNER_URL_HOSTS = ['authenticator.sh', 'www.authenticator.sh', 'chromewebstore.google.com', 'microsoftedge.microsoft.com'];

/** What a policy from before the banner was the server's means: cloud backup, top of Settings, shipped words. */
export const SHIPPED_BANNER: Banner = { id: 'backup', action: 'backup', place: 'settings', url: null, text: null };

const DISMISSED_KEY = 'bannersDismissed';
/** 1.15.0 before banners were the server's kept one flag, for the backup banner. */
const LEGACY_DISMISSED_KEY = 'cloudBackupBannerDismissed';

export function safeBannerUrl(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 500) return null;
  try {
    const url = new URL(value);
    if (url.protocol !== 'https:' || url.username || url.password || url.port || !BANNER_URL_HOSTS.includes(url.hostname)) return null;
    return url.toString();
  } catch {
    return null;
  }
}

/** One line of server text: control characters become spaces; empty or too long is none. */
export function clean(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.replace(/[\u0000-\u001f\u007f]/g, ' ').trim();
  return text.length > 0 && text.length <= max ? text : null;
}

/** The banner of a signed policy; anything malformed is no banner rather than a broken one. */
export function readBanner(value: unknown): Banner | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(v.id)) return null;
  const action = v.action === 'backup' || v.action === 'paywall' || v.action === 'url' || v.action === 'vault' ? v.action : null;
  const place = v.place === 'accounts' ? 'accounts' : v.place === 'settings' || v.place === undefined ? 'settings' : null;
  if (!action || !place) return null;
  const url = action === 'url' ? safeBannerUrl(v.url) : null;
  if (action === 'url' && !url) return null;

  let text: Banner['text'] = null;
  if (v.text && typeof v.text === 'object') {
    const t = v.text as Record<string, unknown>;
    const title = clean(t.title, 120);
    const cta = clean(t.cta, 40);
    if (typeof t.lang === 'string' && /^[a-z]{2,3}$/.test(t.lang) && title && cta) {
      const opensPaywall = action === 'backup' || action === 'paywall';
      const paywallTitle = opensPaywall ? clean(t.paywall_title, 80) : null;
      const paywallBody = opensPaywall ? clean(t.paywall_body, 300) : null;
      text = {
        lang: t.lang,
        eyebrow: clean(t.eyebrow, 60),
        title,
        cta,
        paywall_title: paywallTitle && paywallBody ? paywallTitle : null,
        paywall_body: paywallTitle && paywallBody ? paywallBody : null,
      };
    }
  }
  return { id: v.id, action, place, url, text };
}

/**
 * policy.banner as a list: a single banner or a list of them, each parsed on
 * its own so one malformed entry costs only itself. A second banner for a
 * place already taken is dropped; the server never sends one.
 */
export function readBanners(value: unknown): Banner[] {
  const list = Array.isArray(value) ? value.slice(0, 10) : value ? [value] : [];
  const out: Banner[] = [];
  for (const entry of list) {
    const banner = readBanner(entry);
    if (banner && !out.some(b => b.place === banner.place || b.id === banner.id)) out.push(banner);
  }
  return out;
}

export interface BannerContext {
  place: Banner['place'];
  language: string;
  /** Backup & Restore would offer "Turn on" here (offersCloudBackup). */
  offersBackup: boolean;
  /** No Pro, nothing pending, and something to buy. */
  canBuy: boolean;
  /** Accounts on screen, no password protection, and no VaultPrompt asking the same. */
  offersVault: boolean;
  dismissed: readonly string[];
}

/**
 * The banner to show in `place`, with its words for the language on screen,
 * or null. Words in another language are never shown: the backup and vault
 * banners fall back to the shipped ones, the others to nothing.
 */
export function bannerToShow(banner: Banner | null, ctx: BannerContext): Banner | null {
  if (!banner || banner.place !== ctx.place || ctx.dismissed.includes(banner.id)) return null;
  const text = banner.text && banner.text.lang === ctx.language ? banner.text : null;
  if (banner.action === 'backup') return ctx.offersBackup ? { ...banner, text } : null;
  if (banner.action === 'vault') return ctx.offersVault ? { ...banner, text } : null;
  if (!text) return null;
  if (banner.action === 'paywall') return ctx.canBuy ? { ...banner, text } : null;
  return banner.url ? { ...banner, text } : null;
}

/** The first of the server's banners to show in `ctx.place` (see bannerToShow). */
export function pickBanner(banners: readonly Banner[], ctx: BannerContext): Banner | null {
  for (const banner of banners) {
    const shown = bannerToShow(banner, ctx);
    if (shown) return shown;
  }
  return null;
}

export async function readDismissedBanners(): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get([DISMISSED_KEY, LEGACY_DISMISSED_KEY]);
    const list = Array.isArray(stored[DISMISSED_KEY]) ? stored[DISMISSED_KEY].filter((id: unknown): id is string => typeof id === 'string') : [];
    return stored[LEGACY_DISMISSED_KEY] === true && !list.includes(SHIPPED_BANNER.id) ? [...list, SHIPPED_BANNER.id] : list;
  } catch {
    return [];
  }
}

/** Hides this one banner on this browser for good; any other id still shows. */
export async function dismissBanner(id: string): Promise<void> {
  const list = await readDismissedBanners();
  if (list.includes(id)) return;
  // The newest hundred: ids are the owner's, a few a year.
  await chrome.storage.local.set({ [DISMISSED_KEY]: [...list, id].slice(-100) }).catch(() => {});
}
