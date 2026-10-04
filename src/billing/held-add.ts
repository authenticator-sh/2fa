// A blocked add, kept through Checkout and finished once Pro is on.
//
// In the popup — where the app opens by default — the browser closes the page
// the moment Checkout's tab takes focus, and the account the person had just
// typed or scanned lived only in that page. After paying they had to find the
// key or the QR code again; a sign-up page that shows its QR once had already
// moved on. Now the paywall keeps the account here before the tab opens, and
// whichever window sees Pro arrive adds it, through the same storage path as
// any add (MONETIZATION.md §3.4: after the purchase the same account goes in
// without being entered again).
//
// Kept in chrome.storage.session only: memory, gone when the browser closes,
// never on disk and never in sync. Under password protection it is sealed
// with the vault's own key, so a vault that locks while the person pays does
// not leave the secret readable here; it is added after the next unlock.
// Dropped after a day, when the browser restarts, or when the person says not
// to add it.

import type { Account } from '@/types';
import { decryptJson, encryptJson } from '@/utils/crypto';
import { addMultipleAccounts } from '@/utils/storage';
import { deriveKeys, getMasterKeyBytes, getVaultMeta, VaultLockedError } from '@/utils/vault';
import { withLock } from '@/utils/write-lock';
import { AccountLimitError } from './gate';
import { loadGate } from './state';

export const HELD_ADD_KEY = 'billingHeldAdd';
/** How long a blocked add waits for Pro. */
export const HELD_ADD_MS = 24 * 3_600_000;
const HELD_ADD_LOCK = 'authenticator-billing-held-add';

interface HeldAdd {
  /** When the paywall kept it (ms). */
  at: number;
  /** The accounts' ids, so a page can tell its own add; not secret — a sealed record keeps its id in the clear too. */
  ids: string[];
  /** The accounts, without password protection. */
  accounts?: Account[];
  /** Under password protection: the accounts sealed with that vault's data key. */
  sealed?: { vault: string; enc: string };
  /** The person has been told it is waiting for Pro. */
  told?: boolean;
}

export interface FinishedAdd {
  /** New accounts written; 0 when the same seed was added meanwhile. */
  added: number;
  /** Accounts already here that the add changed (a card becoming Steam Guard). */
  updated: number;
  accounts: Account[];
}

function sessionArea(): chrome.storage.StorageArea | null {
  try {
    return chrome.storage?.session ?? null;
  } catch {
    return null;
  }
}

function isAccountList(value: unknown): value is Account[] {
  return (
    Array.isArray(value) &&
    value.length > 0 &&
    value.every(a => !!a && typeof a === 'object' && typeof a.id === 'string' && typeof a.secret === 'string' && typeof a.name === 'string')
  );
}

function readRecord(value: unknown): HeldAdd | null {
  if (!value || typeof value !== 'object') return null;
  const v = value as Record<string, unknown>;
  if (typeof v.at !== 'number' || !Number.isFinite(v.at)) return null;
  if (!Array.isArray(v.ids) || !v.ids.every(id => typeof id === 'string')) return null;
  const sealed = v.sealed as Record<string, unknown> | undefined;
  const hasSealed = !!sealed && typeof sealed.vault === 'string' && typeof sealed.enc === 'string';
  if (!hasSealed && !isAccountList(v.accounts)) return null;
  return {
    at: v.at,
    ids: v.ids as string[],
    ...(hasSealed ? { sealed: { vault: sealed!.vault as string, enc: sealed!.enc as string } } : { accounts: v.accounts as Account[] }),
    told: v.told === true,
  };
}

/** The held add, if there is one and it is not past its day. A record in the future (clock moved back) is kept. */
async function readHeld(now = Date.now()): Promise<HeldAdd | null> {
  const area = sessionArea();
  if (!area) return null;
  const raw = (await area.get(HELD_ADD_KEY))[HELD_ADD_KEY];
  if (raw === undefined) return null;
  const held = readRecord(raw);
  if (!held || now - held.at >= HELD_ADD_MS) {
    await area.remove(HELD_ADD_KEY);
    return null;
  }
  return held;
}

/**
 * The accounts in a held add; null when they can no longer be read (the vault
 * that sealed them is gone). Throws VaultLockedError while it is locked.
 */
async function openHeld(held: HeldAdd): Promise<Account[] | null> {
  if (held.accounts) return held.accounts;
  if (!held.sealed) return null;
  const meta = await getVaultMeta();
  if (!meta || meta.vaultId !== held.sealed.vault) return null;
  const masterKey = await getMasterKeyBytes();
  if (!masterKey) throw new VaultLockedError();
  const { dataKey } = await deriveKeys(masterKey);
  const accounts = await decryptJson<unknown>(held.sealed.enc, dataKey);
  return isAccountList(accounts) ? accounts : null;
}

/**
 * Keeps the accounts of an add the limit stopped, for when Pro arrives. Called
 * by the paywall as Checkout opens — never throws, and does nothing it cannot
 * finish quickly. One at a time: a later blocked add replaces it.
 */
export async function holdBlockedAdd(accounts: Account[]): Promise<void> {
  try {
    const area = sessionArea();
    if (!area || accounts.length === 0) return;
    const record: HeldAdd = { at: Date.now(), ids: accounts.map(a => a.id) };
    const meta = await getVaultMeta();
    if (meta) {
      const masterKey = await getMasterKeyBytes();
      // Locked: nothing could have been added a moment ago either.
      if (!masterKey) return;
      const { dataKey } = await deriveKeys(masterKey);
      record.sealed = { vault: meta.vaultId, enc: await encryptJson(accounts, dataKey) };
    } else {
      record.accounts = accounts;
    }
    await area.set({ [HELD_ADD_KEY]: record });
  } catch (error) {
    console.warn('billing: could not keep the blocked add', error);
  }
}

/**
 * Adds the held accounts if this install is now Pro, through the same storage
 * path and duplicate check as any add, and forgets them. Null when there is
 * nothing held, Pro has not arrived, or the vault is locked — the add keeps
 * waiting in each of those. Never throws.
 */
export async function finishHeldAdd(): Promise<FinishedAdd | null> {
  try {
    return await withLock(HELD_ADD_LOCK, async () => {
      const held = await readHeld();
      if (!held) return null;
      const gate = await loadGate();
      if (!gate.entitled) return null;
      const accounts = await openHeld(held);
      if (!accounts) {
        await sessionArea()?.remove(HELD_ADD_KEY);
        return null;
      }
      const result = await addMultipleAccounts(accounts, { kind: 'user', gate });
      await sessionArea()?.remove(HELD_ADD_KEY);
      return { added: result.added, updated: result.updated, accounts };
    });
  } catch (error) {
    // Locked, or the license lapsed in between: still held, tried again later.
    if (!(error instanceof VaultLockedError) && !(error instanceof AccountLimitError)) {
      console.warn('billing: could not finish the blocked add', error);
    }
    return null;
  }
}

/**
 * The held accounts, the first time the person is to be told they are waiting
 * for Pro, and never again for the same add. Null otherwise, or while the
 * vault is locked.
 */
export async function heldAddToMention(): Promise<Account[] | null> {
  try {
    return await withLock(HELD_ADD_LOCK, async () => {
      const held = await readHeld();
      if (!held || held.told) return null;
      const accounts = await openHeld(held);
      if (!accounts) return null;
      await sessionArea()?.set({ [HELD_ADD_KEY]: { ...held, told: true } });
      return accounts;
    });
  } catch {
    return null;
  }
}

/** Whether these accounts are the ones held for Pro. */
export async function isHeld(ids: readonly string[]): Promise<boolean> {
  try {
    const held = await readHeld();
    return !!held && ids.length > 0 && ids.every(id => held.ids.includes(id));
  } catch {
    return false;
  }
}

/**
 * The person does not want it added after all. Sent at once, not after
 * waiting for the lock: a popup closed right after the click would otherwise
 * take the request with it.
 */
export async function dismissHeldAdd(): Promise<void> {
  try {
    await sessionArea()?.remove(HELD_ADD_KEY);
  } catch {
    // Session storage dies with the browser anyway.
  }
}
