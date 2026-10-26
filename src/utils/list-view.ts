// What the account list area shows, and which accounts a search keeps.
//
// Pulled out of the popup so the order of the cases can be tested: it is the
// order that went wrong, not any one case.

import type { Account } from '@/types';

export type ListView =
  /** Still reading. */
  | 'loading'
  /** Rows to show. */
  | 'list'
  /** Accounts exist, but the search or group filter hides all of them. */
  | 'noResults'
  /** Nothing readable, but this is not a new user — records are held, or the read failed. */
  | 'unavailable'
  /** Nothing at all: the first-run guide. */
  | 'empty';

export interface ListViewInput {
  loading: boolean;
  /** Every account that was read. */
  total: number;
  /** What survives the search and the group filter. */
  shown: number;
  /** The read failed — including when the list on screen came from a backup. */
  failed: boolean;
  /** Records on disk this device cannot decrypt. */
  held: number;
}

/**
 * Accounts on screen outrank every explanation of why there might not be any.
 *
 * The "cannot be read" panel used to be checked first, on `error || heldCount`,
 * and both of those can be true while a perfectly good list is loaded: a device
 * holding one record from another vault, or a list recovered from the automatic
 * backup. A search that matched nothing then told the user they needed a
 * different password and offered Retry and Restore — for a typo — and the one
 * button that would have helped, Clear filters, was not on screen.
 */
export function chooseListView({ loading, total, shown, failed, held }: ListViewInput): ListView {
  if (loading) return 'loading';
  if (shown > 0) return 'list';
  // `shown` can only be below `total` because a filter removed rows.
  if (total > 0) return 'noResults';
  if (failed || held > 0) return 'unavailable';
  return 'empty';
}

/**
 * Whether an account matches what was typed in the search box.
 *
 * Read defensively: a record written by an older build or another exporter can
 * carry `issuer: null`, and `null.toLowerCase()` inside the render threw the
 * popup onto the crash screen at the first keystroke.
 *
 * The group counts too: with forty accounts, "work" is how people look for the
 * ones they filed under Work, and a search that ignored the one label they
 * chose themselves answered "no accounts found".
 */
export function matchesSearch(account: Pick<Account, 'name' | 'issuer' | 'group'>, query: string): boolean {
  const needle = query.toLowerCase();
  if (!needle) return true;
  return (
    String(account.name ?? '').toLowerCase().includes(needle) ||
    String(account.issuer ?? '').toLowerCase().includes(needle) ||
    (typeof account.group === 'string' && account.group.toLowerCase().includes(needle))
  );
}

/**
 * How the list is ordered.
 *
 * 'manual' is the order the user dragged the rows into, and the default: it is
 * what every existing install already has on screen. The other two are views
 * over it, never written back — switching to "by service" and back returns the
 * hand-made order untouched.
 */
export type SortOrder = 'manual' | 'service' | 'name';

export const SORT_ORDERS: readonly SortOrder[] = ['manual', 'service', 'name'];

/** Where the choice is kept. Local, like every other setting on the Settings screen. */
export const SORT_ORDER_KEY = 'sortOrder';

/** A stored value, or 'manual' for anything this build does not know. */
export function readSortOrder(value: unknown): SortOrder {
  return SORT_ORDERS.includes(value as SortOrder) ? (value as SortOrder) : 'manual';
}

const collators = new Map<string, Intl.Collator>();

function collatorFor(language: string): Intl.Collator {
  let collator = collators.get(language);
  if (!collator) {
    // Base sensitivity so "github" and "GitHub" sit together, numeric so
    // "Server 2" comes before "Server 10".
    collator = new Intl.Collator(language, { sensitivity: 'base', numeric: true });
    collators.set(language, collator);
  }
  return collator;
}

const text = (value: unknown) => (typeof value === 'string' ? value.trim() : '');

/**
 * The list in the chosen order.
 *
 * Collated in the interface language: code-point order puts "Ä" after "Z" and
 * every lowercase name after every capitalised one. Ties keep their manual
 * order, so two accounts on one service stay the way the user arranged them.
 * An account with no issuer sorts by its name under "service" — most imports
 * that lack one put the service in the name.
 */
export function sortAccounts<T extends Pick<Account, 'name' | 'issuer'>>(
  accounts: readonly T[],
  order: SortOrder,
  language: string
): T[] {
  if (order === 'manual') return [...accounts];
  const collator = collatorFor(language);
  const primary = (account: T) =>
    order === 'service' ? text(account.issuer) || text(account.name) : text(account.name) || text(account.issuer);
  const secondary = (account: T) => (order === 'service' ? text(account.name) : text(account.issuer));
  return accounts
    .map((account, index) => ({ account, index }))
    .sort(
      (a, b) =>
        collator.compare(primary(a.account), primary(b.account)) ||
        collator.compare(secondary(a.account), secondary(b.account)) ||
        a.index - b.index
    )
    .map(entry => entry.account);
}

/**
 * Pinned accounts first, each part in the order it came in.
 *
 * Applied after the sort, so a pin wins over every order — the reason to pin
 * an account is that it should not move when the sort does.
 */
export function pinnedFirst<T extends Pick<Account, 'pinned'>>(accounts: readonly T[]): T[] {
  const pinned = accounts.filter(account => account.pinned === true);
  if (pinned.length === 0) return [...accounts];
  return [...pinned, ...accounts.filter(account => account.pinned !== true)];
}

export interface GroupCount {
  name: string;
  count: number;
}

/**
 * The groups for the chip strip, in the order the user arranged them.
 *
 * A group stands where its lowest-ranked account puts it (see
 * Account.groupRank). Groups without a rank — every group before anyone
 * dragged a chip, and a group just created — follow, alphabetically.
 */
export function groupsInOrder(
  accounts: readonly Pick<Account, 'group' | 'groupRank'>[],
  language: string
): GroupCount[] {
  const groups = new Map<string, { count: number; rank: number }>();
  for (const account of accounts) {
    const name = typeof account.group === 'string' ? account.group.trim() : '';
    if (!name) continue;
    const entry = groups.get(name) ?? { count: 0, rank: Infinity };
    entry.count++;
    if (typeof account.groupRank === 'number' && account.groupRank < entry.rank) entry.rank = account.groupRank;
    groups.set(name, entry);
  }
  const collator = collatorFor(language);
  return [...groups.entries()]
    .sort(([a, x], [b, y]) => (x.rank === y.rank ? collator.compare(a, b) : x.rank - y.rank))
    .map(([name, { count }]) => ({ name, count }));
}

/** `names` with `moved` taken out and put back in front of `before` — or last, for null. */
export function movedBefore(names: readonly string[], moved: string, before: string | null): string[] {
  const rest = names.filter(name => name !== moved);
  const at = before === null ? rest.length : rest.indexOf(before);
  if (at === -1) return [...names];
  return [...rest.slice(0, at), moved, ...rest.slice(at)];
}

/**
 * The order to write after an undone delete of several accounts puts them
 * back: the order the list had before the delete, for every account still
 * here, with anything added since — another window, a scan — first, where
 * new accounts go. Null when the list is already in that order.
 */
export function orderAfterUndo(currentIds: readonly string[], previousIds: readonly string[]): string[] | null {
  const current = new Set(currentIds);
  const previous = new Set(previousIds);
  const next = [...currentIds.filter(id => !previous.has(id)), ...previousIds.filter(id => current.has(id))];
  return next.every((id, i) => id === currentIds[i]) ? null : next;
}

/**
 * The order to write after an undone delete puts an account back.
 *
 * Re-adding puts it at the top, so it would come back first in a list it was
 * taken from the middle of. It goes back after the nearest account that stood
 * before it and still exists — not at its old index, which counts rows another
 * window may have added or deleted in the meantime. Null when it is already
 * where it belongs, or no longer in the list at all.
 */
export function restoredOrder(currentIds: readonly string[], id: string, previousIds: readonly string[]): string[] | null {
  if (!currentIds.includes(id)) return null;
  const without = currentIds.filter(existing => existing !== id);
  const before = previousIds.slice(0, Math.max(0, previousIds.indexOf(id)));
  let at = 0;
  for (let i = before.length - 1; i >= 0; i--) {
    const found = without.indexOf(before[i]);
    if (found !== -1) {
      at = found + 1;
      break;
    }
  }
  const next = [...without.slice(0, at), id, ...without.slice(at)];
  return next.every((value, i) => value === currentIds[i]) ? null : next;
}
