// Where the selected group filter is kept.
//
// It looks like an ordinary UI preference, but the value is a group name the
// user typed — "Crypto", "Work — Acme". The vault's promise is that a stolen
// profile leaks no metadata about which services someone holds, which is why
// prepareVault scrubs the per-site usage history before it commits. Writing the
// active group to chrome.storage.local would put a slice of the same
// information straight back on disk, in the clear, and leave it there while the
// vault is locked.
//
// So with a vault configured the filter lives in chrome.storage.session:
// memory-backed, gone when the browser closes, and already the vault's own home
// for state that must not be written down. Without a vault there is nothing to
// protect and the filter survives restarts, which is what makes it worth having.

import { isVaultEnabled } from './vault';

const ACTIVE_GROUP_KEY = 'activeGroup';

function hasSessionStorage(): boolean {
  return typeof chrome !== 'undefined' && !!chrome.storage && !!chrome.storage.session;
}

/**
 * The stored filter, or null for "all accounts".
 *
 * Reads session first: while a vault is on that is the only place the value is
 * written, and a stale local copy from before the vault was enabled must not
 * win over it.
 */
export async function readActiveGroup(): Promise<string | null> {
  if (hasSessionStorage()) {
    try {
      const session = await chrome.storage.session.get(ACTIVE_GROUP_KEY);
      // '' is the ungrouped filter and a legitimate stored value, so this tests
      // the type rather than truthiness.
      if (typeof session[ACTIVE_GROUP_KEY] === 'string') return session[ACTIVE_GROUP_KEY];
    } catch {
      // Session storage unavailable in this context — fall through to local.
    }
  }

  if (await isVaultEnabled()) return null;

  const local = await chrome.storage.local.get(ACTIVE_GROUP_KEY);
  return typeof local[ACTIVE_GROUP_KEY] === 'string' ? local[ACTIVE_GROUP_KEY] : null;
}

/** Persist the filter, or clear it when `group` is null. */
export async function rememberActiveGroup(group: string | null): Promise<void> {
  if (group === null) {
    await forgetActiveGroup();
    return;
  }

  const vaultOn = await isVaultEnabled();

  if (vaultOn && hasSessionStorage()) {
    // Clear any copy written before the vault was turned on, then keep it in
    // memory only.
    await chrome.storage.local.remove(ACTIVE_GROUP_KEY).catch(() => {});
    await chrome.storage.session.set({ [ACTIVE_GROUP_KEY]: group }).catch(() => {});
    return;
  }

  if (vaultOn) {
    // Chrome older than 102 has no session storage. The filter is a convenience;
    // the vault's guarantee is not. Drop the preference rather than write a
    // group name next to an encrypted store.
    await chrome.storage.local.remove(ACTIVE_GROUP_KEY).catch(() => {});
    return;
  }

  await chrome.storage.local.set({ [ACTIVE_GROUP_KEY]: group });
}

/** Remove the filter from both stores. */
export async function forgetActiveGroup(): Promise<void> {
  await chrome.storage.local.remove(ACTIVE_GROUP_KEY).catch(() => {});
  if (hasSessionStorage()) {
    await chrome.storage.session.remove(ACTIVE_GROUP_KEY).catch(() => {});
  }
}
