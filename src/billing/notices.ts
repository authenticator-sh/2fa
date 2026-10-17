// The notifications the server sets behind the bell in the header
// (policy.notices): parsed defensively and kept per id on this browser — read
// once the bell has been opened with it in the list, closed for good with its
// cross. Who gets which is the server's (each has its own conditions, checked
// at every sync); here a notification is only held back where its button
// cannot work right now — a password already set, Pro already held.

import { clean, safeBannerUrl } from './banner';
import type { Notice } from './types';

/** The most a policy carries; the server allows no more. */
export const NOTICES_MAX = 10;

const READ_KEY = 'noticesRead';
const DISMISSED_KEY = 'noticesDismissed';

/** One notification of a signed policy; anything malformed is none rather than a broken one. */
export function readNotice(value: unknown): Notice | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,39}$/.test(v.id)) return null;
  const action =
    v.action === 'backup' || v.action === 'paywall' || v.action === 'url' || v.action === 'vault' || v.action === 'none' ? v.action : null;
  if (!action) return null;
  const url = action === 'url' ? safeBannerUrl(v.url) : null;
  if (action === 'url' && !url) return null;

  let text: Notice['text'] = null;
  if (v.text && typeof v.text === 'object') {
    const t = v.text as Record<string, unknown>;
    const title = clean(t.title, 120);
    const body = clean(t.body, 300);
    const cta = action === 'none' ? null : clean(t.cta, 40);
    if (typeof t.lang === 'string' && /^[a-z]{2,3}$/.test(t.lang) && title && body && (cta || action === 'none')) {
      const opensPaywall = action === 'backup' || action === 'paywall';
      const paywallTitle = opensPaywall ? clean(t.paywall_title, 80) : null;
      const paywallBody = opensPaywall ? clean(t.paywall_body, 300) : null;
      text = {
        lang: t.lang,
        title,
        body,
        cta,
        paywall_title: paywallTitle && paywallBody ? paywallTitle : null,
        paywall_body: paywallTitle && paywallBody ? paywallBody : null,
      };
    }
  }
  return { id: v.id, action, url, text };
}

/** policy.notices: each parsed on its own, so one malformed entry costs only itself; a repeated id is dropped. */
export function readNotices(value: unknown): Notice[] {
  if (!Array.isArray(value)) return [];
  const out: Notice[] = [];
  for (const entry of value.slice(0, NOTICES_MAX)) {
    const notice = readNotice(entry);
    if (notice && !out.some(n => n.id === notice.id)) out.push(notice);
  }
  return out;
}

export interface NoticeContext {
  language: string;
  /** Backup & Restore would offer "Turn on" here (offersCloudBackup): the backup button can work. */
  offersBackup: boolean;
  /** No Pro, nothing pending, and something to buy: the paywall button can work. */
  canBuy: boolean;
  /** No password protection yet: the vault button can work. */
  offersVault: boolean;
  dismissed: readonly string[];
}

/**
 * The notification as it shows here, with its words for the language on
 * screen, or null: closed, its button unable to work here now, or no words it
 * can show (backup and vault fall back to the shipped ones, the others need
 * their own in this language). Everything else about who sees it the server
 * has decided already.
 */
export function noticeToShow(notice: Notice, ctx: NoticeContext): Notice | null {
  if (ctx.dismissed.includes(notice.id)) return null;
  const text = notice.text && notice.text.lang === ctx.language ? notice.text : null;
  if (notice.action === 'backup') return ctx.offersBackup ? { ...notice, text } : null;
  if (notice.action === 'vault') return ctx.offersVault ? { ...notice, text } : null;
  if (!text) return null;
  if (notice.action === 'paywall') return ctx.canBuy ? { ...notice, text } : null;
  if (notice.action === 'url') return notice.url ? { ...notice, text } : null;
  return { ...notice, text };
}

/** The notifications to list behind the bell, in the server's order. */
export function noticesToShow(notices: readonly Notice[], ctx: NoticeContext): Notice[] {
  return notices.map(n => noticeToShow(n, ctx)).filter((n): n is Notice => n !== null);
}

/** Those the red dot is for: shown here and never yet in an opened bell. */
export function unreadNotices(shown: readonly Notice[], read: readonly string[]): Notice[] {
  return shown.filter(n => !read.includes(n.id));
}

async function readIds(key: string): Promise<string[]> {
  try {
    const stored = await chrome.storage.local.get(key);
    return Array.isArray(stored[key]) ? stored[key].filter((id: unknown): id is string => typeof id === 'string') : [];
  } catch {
    return [];
  }
}

async function addIds(key: string, ids: readonly string[]): Promise<void> {
  const list = await readIds(key);
  const added = ids.filter(id => !list.includes(id));
  if (!added.length) return;
  // The newest hundred: ids are the owner's, a few a month.
  await chrome.storage.local.set({ [key]: [...list, ...added].slice(-100) }).catch(() => {});
}

export const readReadNotices = (): Promise<string[]> => readIds(READ_KEY);
export const readDismissedNotices = (): Promise<string[]> => readIds(DISMISSED_KEY);

/** The bell was opened with these in the list: the dot goes out for them, on every popup of this browser. */
export const markNoticesRead = (ids: readonly string[]): Promise<void> => addIds(READ_KEY, ids);

/** Hides this one notification on this browser for good; a new id still shows, unread. */
export const dismissNotice = (id: string): Promise<void> => addIds(DISMISSED_KEY, [id]);

/** The storage keys this module keeps, for listeners that redraw on a change. */
export const NOTICE_KEYS = [READ_KEY, DISMISSED_KEY] as const;
