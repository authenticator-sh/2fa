// What the paywall and the Pro settings can ask the server to do.
//
// Each one needs the network and says so plainly when it is not there. None
// of them is on the path to showing or adding an account.

import { BillingApiError, post } from './api';
import { track } from './events';
import { verifyToken } from './jws';
import {
  BILLING_KEYS,
  ensureInstall,
  readEntitlementPayload,
  storeTokens,
  writeSyncedLicenseKey,
} from './state';
import { SYNC_LOCK, syncBilling } from './sync';
import type { Entitlement } from './types';

/**
 * Opens Stripe Checkout for `plan` in a new tab.
 *
 * Everything that must outlive the page is written before the tab opens — the
 * pending mark, the events, and whatever the caller does in `beforeOpen`: a
 * popup is closed by the browser the moment another window takes focus, and
 * what it had not written by then is lost. With the mark, the next time the
 * extension opens it asks the server straight away whether the purchase went
 * through.
 *
 * A `price_changed` refusal is thrown, not retried: the person agreed to the
 * price on screen, and the new one has to be shown before they pay it.
 */
export async function startCheckout(
  plan: string,
  trigger: string,
  options: {
    beforeOpen?: () => Promise<void>;
    /** The price the person saw: the server charges exactly it, or answers price_changed. */
    shown?: { amount: number; currency: string; approx: boolean };
  } = {}
): Promise<void> {
  const install = await ensureInstall();
  const shown = options.shown ? { shown: { amount: options.shown.amount, currency: options.shown.currency.toLowerCase(), approx: options.shown.approx } } : {};
  const create = () =>
    post<{ url: string; checkout_id: string }>('/v1/checkout', { iid: install.id, plan, trigger, ...shown }, 15_000);

  let result: { url: string; checkout_id: string };
  try {
    result = await create();
  } catch (error) {
    // The server has not seen this install yet, or its policy changed since:
    // check in once and try again.
    if (error instanceof BillingApiError && (error.code === 'unknown_install' || error.code === 'plan_unavailable')) {
      await syncBilling({ force: true });
      result = await create();
    } else {
      throw error;
    }
  }

  await chrome.storage.local.set({
    [BILLING_KEYS.pendingCheckout]: { id: result.checkout_id, at: Date.now(), plan },
  });
  await track('checkout_open', { plan, trigger });
  await options.beforeOpen?.();
  await chrome.tabs.create({ url: result.url });
}

/** Holds the sync lock, so a sync running at the same moment cannot overwrite what this stores. */
async function withSyncLock<T>(fn: () => Promise<T>): Promise<T> {
  const locks = (navigator as Navigator & { locks?: LockManager }).locks;
  if (!locks || typeof locks.request !== 'function') return fn();
  return locks.request(SYNC_LOCK, () => fn()) as Promise<T>;
}

async function storeEntitlement(iid: string, token: string): Promise<Entitlement> {
  const verified = await verifyToken(token, iid);
  const entitlement = verified ? readEntitlementPayload(verified) : null;
  if (!entitlement) throw new BillingApiError('internal', 200);
  await storeTokens({ entitlement: token });
  await chrome.storage.local.remove(BILLING_KEYS.pendingCheckout);
  return entitlement;
}

/** Activates a license key typed on this install. */
export async function activateLicenseKey(key: string): Promise<Entitlement> {
  const install = await ensureInstall();
  try {
    const entitlement = await withSyncLock(async () => {
      const { entitlement: token } = await post<{ entitlement: string }>('/v1/license/activate', {
        iid: install.id,
        key: key.trim(),
        method: 'key',
      });
      return storeEntitlement(install.id, token);
    });
    // Lets this person's other Chrome profiles pick Pro up by themselves.
    await writeSyncedLicenseKey(key.trim());
    await track('license_activate', { method: 'key', ok: true });
    return entitlement;
  } catch (error) {
    await track('license_activate', {
      method: 'key',
      ok: false,
      error: error instanceof BillingApiError ? error.code : 'internal',
    });
    throw error;
  }
}

/** Mails the key to the address it was bought with. The answer is the same whether or not it was. */
export async function recoverLicense(email: string): Promise<void> {
  const install = await ensureInstall();
  await post('/v1/license/recover', { iid: install.id, email: email.trim() });
  await track('license_recover');
}

/** "Remove Pro from this device": frees the seat for another computer. */
export async function deactivateLicense(): Promise<void> {
  const install = await ensureInstall();
  await withSyncLock(async () => {
    await post('/v1/license/deactivate', { iid: install.id });
    await storeTokens({ entitlement: null });
  });
  // Otherwise the synced key would put Pro straight back on at the next sync.
  await writeSyncedLicenseKey(null);
}

/** Stripe's customer portal for the license this install holds. */
export async function openBillingPortal(): Promise<void> {
  const install = await ensureInstall();
  const { url } = await post<{ url: string }>('/v1/portal', { iid: install.id });
  await chrome.tabs.create({ url });
}
