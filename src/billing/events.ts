// The events this install reports — billing, and the way to a first account
// (onboarding.ts) — and nothing else.
//
// The list below is closed: an event not named here cannot be recorded, and
// its properties are cut to short scalars. None of them can carry an account's
// name, issuer, secret or the site it belongs to — what leaves the machine is
// what MONETIZATION.md §3.7 and the privacy policy say, and the test in
// test/billing.test.ts holds this file to it.
//
// Events wait in chrome.storage.local and go out with the next sync, so a
// person who is offline loses nothing and waits for nothing.

import { withLock } from '@/utils/write-lock';
import { BILLING_KEYS } from './state';

export const EVENT_NAMES = [
  'limit_warn_seen',
  'limit_blocked',
  'paywall_view',
  'paywall_close',
  'plan_select',
  'checkout_open',
  'import_partial',
  'license_activate',
  'license_recover',
  'pro_settings_view',
  // The way to a first account (onboarding.ts): kinds and counts only.
  'first_open',
  'onboard_view',
  'onboard_pick',
  // How the first look at that screen ended, and after how many seconds.
  'onboard_leave',
  'add_step',
  'add_fail',
  'add_cancel',
  'account_added',
  'first_code',
  // The welcome page's button asked the extension to open (background/site-open.ts).
  'site_open',
  // The server's banner (billing/banner.ts), each with its id, action and place;
  // the notifications behind the bell (billing/notices.ts) send them too, place 'bell'.
  'banner_view',
  'banner_click',
  'banner_close',
  // The bell opened: how many notifications it held, how many unread.
  'bell_open',
  // Sharing codes by link (ShareModal): the window opened, a link made — for
  // how many minutes, with a password or not, whose label — or refused, and
  // the link copied. Never the account, the label's text or the link.
  'share_open',
  'share_create',
  'share_fail',
  'share_copy',
] as const;

export type EventName = (typeof EVENT_NAMES)[number];
export type EventProps = Record<string, string | number | boolean | null>;

export interface QueuedEvent {
  id: string;
  n: EventName;
  t: number;
  p?: EventProps;
}

const QUEUE_LIMIT = 200;
const EVENTS_LOCK = 'authenticator-billing-events';

/** Props cut to what the server accepts: ≤ 12 keys, snake_case names, short scalars. */
export function sanitizeProps(props: EventProps | undefined): EventProps | undefined {
  if (!props) return undefined;
  const out: EventProps = {};
  for (const [key, value] of Object.entries(props)) {
    if (Object.keys(out).length >= 12) break;
    if (!/^[a-z][a-z_]{0,31}$/.test(key)) continue;
    if (typeof value === 'string') out[key] = value.slice(0, 64);
    else if (typeof value === 'number' && Number.isFinite(value)) out[key] = value;
    else if (typeof value === 'boolean' || value === null) out[key] = value;
  }
  return Object.keys(out).length ? out : undefined;
}

async function readQueue(): Promise<QueuedEvent[]> {
  try {
    const found = await chrome.storage.local.get(BILLING_KEYS.events);
    const queue = found[BILLING_KEYS.events];
    return Array.isArray(queue) ? (queue as QueuedEvent[]) : [];
  } catch {
    return [];
  }
}

/** Records an event for the next sync. Never throws: reporting must not break the thing reported. */
export async function track(name: EventName, props?: EventProps): Promise<void> {
  if (!(EVENT_NAMES as readonly string[]).includes(name)) return;
  try {
    await withLock(EVENTS_LOCK, async () => {
      const queue = await readQueue();
      const event: QueuedEvent = { id: crypto.randomUUID(), n: name, t: Date.now() };
      const p = sanitizeProps(props);
      if (p) event.p = p;
      queue.push(event);
      // Oldest first to go: a long offline stretch keeps the latest picture.
      const trimmed = queue.length > QUEUE_LIMIT ? queue.slice(queue.length - QUEUE_LIMIT) : queue;
      await chrome.storage.local.set({ [BILLING_KEYS.events]: trimmed });
    });
  } catch (error) {
    console.warn('billing: could not queue event', name, error);
  }
}

/** Up to `max` queued events, oldest first. */
export async function peekEvents(max = 50): Promise<QueuedEvent[]> {
  const queue = await readQueue();
  return queue
    .filter(e => e && typeof e.id === 'string' && (EVENT_NAMES as readonly string[]).includes(e.n))
    .slice(0, max);
}

/** Drops the events the server acknowledged, plus anything no longer sendable. */
export async function ackEvents(ids: readonly string[]): Promise<void> {
  const done = new Set(ids);
  await withLock(EVENTS_LOCK, async () => {
    const queue = await readQueue();
    const rest = queue.filter(e => e && typeof e.id === 'string' && !done.has(e.id) && (EVENT_NAMES as readonly string[]).includes(e.n));
    await chrome.storage.local.set({ [BILLING_KEYS.events]: rest });
  });
}
