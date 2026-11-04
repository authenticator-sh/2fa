// Cloud sync: how this device's list and the other devices' copies become one.
//
// Every device with cloud backup on sends its whole list, encrypted, to the
// license's copies (billing/cloud-backup.ts). Sync is reading the newest copy
// of each OTHER device and folding it in here. No server-side state, no
// operation log: a copy is a device's complete answer to "what do you hold",
// with two things that make it mergeable —
//
//   - each account's `updatedAt`, when it was last changed (types/index.ts);
//   - `deleted`, the hashes of the seeds the device deleted since it started
//     syncing, each with when (utils/tombstones.ts).
//
// Per seed, the newest of everything said about it wins: an edit newer than
// this device's version replaces its fields; a deletion newer than every
// version removes it; an account this device lacks is added unless a deletion
// newer than it says it is gone. Absence alone never deletes anything — a copy
// missing an account is a device that never had it, or an older build. That is
// the line between sync and the bug of 09-18, where a merge that only added
// brought deleted accounts back, and the one between sync and a wipe: nothing
// here can remove an account except a marker made by a deletion.
//
// Records from before sync carry no `updatedAt`. Two of those never overwrite
// one another — the same account named "Work" on one computer and "Mail" on
// another stays so until one of them is edited — because their only stamp is
// `createdAt`, which says when each device got the account, not which name is
// the newer one. A deletion still wins over one: it is a recent, explicit act.
//
// Pure, so it is tested without storage; storage.ts runs it inside the
// accounts lock on a fresh read and does the writing.

import type { Account } from '@/types';
import { normalizeSiteList } from './account-sites';

/**
 * The fields sync carries. Not `id` (each device's own), `createdAt` or the
 * place in the list — and not `secret`, which is what makes two records one
 * account: its spelling may differ between devices (`JBSW Y3DP` and
 * `JBSWY3DP`), and comparing it would call the same account two versions that
 * replace each other on every sync, forever.
 */
export const SYNCED_FIELDS = [
  'name',
  'issuer',
  'algorithm',
  'digits',
  'period',
  'type',
  'color',
  'group',
  'groupRank',
  'pinned',
  'sites',
] as const satisfies readonly (keyof Account)[];

type SyncedField = (typeof SYNCED_FIELDS)[number];

/** Optional fields: absent and `undefined` are the same, and a remote absence clears them here. */
const OPTIONAL_FIELDS = ['type', 'color', 'group', 'groupRank', 'pinned', 'sites'] as const satisfies readonly SyncedField[];

const value = (account: Account, field: SyncedField): unknown => {
  const v = account[field];
  // `pinned: false` and no `pinned` are one state.
  if (field === 'pinned') return v === true ? true : undefined;
  // A list, compared by what it says: one string, since a hostname has no
  // spaces. An empty list and none are one state too.
  if (field === 'sites') {
    const sites = normalizeSiteList(v);
    return sites.length ? sites.join(' ') : undefined;
  }
  return v === null ? undefined : v;
};

/** Whether two versions of an account say the same, for everything sync carries. */
export function sameSyncedFields(a: Account, b: Account): boolean {
  return SYNCED_FIELDS.every(field => value(a, field) === value(b, field));
}

/** A stamp sync trusts: a finite positive number. */
function stamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

/** When this version was last changed, as far as anyone can tell. */
export function versionStamp(account: Account): number {
  return stamp(account.updatedAt) ?? stamp(account.createdAt) ?? 0;
}

/** Equal stamps on two different versions: the same answer on every device, whichever it is. */
function tieBreak(account: Account): string {
  return JSON.stringify(SYNCED_FIELDS.map(field => value(account, field) ?? null));
}

/** Whether `incoming` should replace `here`. */
function newer(incoming: Account, here: Account): boolean {
  // Only an edit made since sync existed overrides anything (see the header).
  if (stamp(incoming.updatedAt) === undefined) return false;
  const a = versionStamp(incoming);
  const b = versionStamp(here);
  if (a !== b) return a > b;
  return !sameSyncedFields(incoming, here) && tieBreak(incoming) > tieBreak(here);
}

export interface RemoteCopy {
  /** Readable accounts of the other device's copy. */
  accounts: Account[];
  /** Seed hash -> when it was deleted there. */
  deleted: Record<string, number>;
}

export interface MergeInput {
  /** This device's list, read under the accounts lock. */
  local: Account[];
  /** This device's own deletion marks. */
  localDeleted: Record<string, number>;
  /** The other devices' newest copies, newest first. */
  remotes: RemoteCopy[];
  /** The key two records are the same seed under (storage.ts's secretKey). */
  seedKey: (secret: string) => string;
  /** The deletion-mark hash of a seed key, computed beforehand; undefined for one not computed. */
  hashOf: (seedKey: string) => string | undefined;
  /** Ids already taken on this device, unreadable records' included. */
  usedIds: ReadonlySet<string>;
  /**
   * Seeds not to add even when a copy has them: ones deleted here between the
   * caller's first read and this one, whose marks it read too early to see.
   */
  skipAdd?: (seedKey: string) => boolean;
  /**
   * Deletions older than this do not remove this device's own accounts — they
   * still keep the account out when it is not here. This device's sync start:
   * before it, deleting on another device left this one alone, and joining
   * must not take away what it has had all along.
   */
  removalSince?: number;
}

export interface MergePlan {
  /** The list to write: new accounts first, in the order they came, then this device's, updated. */
  accounts: Account[];
  added: number;
  updated: number;
  /** Accounts of this device a newer deletion removes, each with the moment of that deletion. */
  removed: { account: Account; at: number }[];
}

/**
 * This device's list with the other devices' copies folded in, or null when
 * nothing changes — so nothing is written, and nothing is sent back.
 */
export function planCloudMerge(input: MergeInput): MergePlan | null {
  const { seedKey, hashOf } = input;

  // The newest deletion of each seed anyone knows of.
  const deletions = new Map<string, number>();
  const noteDeletion = (hash: string, at: unknown) => {
    const when = stamp(at);
    if (when === undefined) return;
    deletions.set(hash, Math.max(deletions.get(hash) ?? 0, when));
  };
  for (const [hash, at] of Object.entries(input.localDeleted)) noteDeletion(hash, at);
  for (const remote of input.remotes) for (const [hash, at] of Object.entries(remote.deleted)) noteDeletion(hash, at);
  const deletedAt = (key: string): number | undefined => {
    const hash = hashOf(key);
    return hash === undefined ? undefined : deletions.get(hash);
  };

  // The newest version of each seed among the copies.
  const best = new Map<string, Account>();
  const order: string[] = [];
  for (const remote of input.remotes) {
    for (const account of remote.accounts) {
      const key = seedKey(account.secret);
      if (!key) continue;
      const seen = best.get(key);
      if (!seen) {
        best.set(key, account);
        order.push(key);
      } else if (newer(account, seen) || (stamp(seen.updatedAt) === undefined && stamp(account.updatedAt) !== undefined)) {
        best.set(key, account);
      }
    }
  }

  const removed: MergePlan['removed'] = [];
  const kept: Account[] = [];
  const here = new Set<string>();
  let updated = 0;
  for (const account of input.local) {
    const key = seedKey(account.secret);
    here.add(key);
    let version = account;
    const incoming = best.get(key);
    if (incoming && newer(incoming, account)) version = adopt(account, incoming);
    const gone = deletedAt(key);
    // A deletion wins over an older version, and only an older one: an account
    // re-added after it was deleted elsewhere is newer than that deletion.
    if (gone !== undefined && gone > versionStamp(version) && gone >= (input.removalSince ?? 0)) {
      removed.push({ account, at: gone });
      continue;
    }
    if (version !== account) updated++;
    kept.push(version);
  }

  const usedIds = new Set(input.usedIds);
  for (const account of kept) usedIds.add(account.id);
  const fresh: Account[] = [];
  for (const key of order) {
    if (here.has(key) || input.skipAdd?.(key)) continue;
    const incoming = best.get(key)!;
    const gone = deletedAt(key);
    if (gone !== undefined && gone > versionStamp(incoming)) continue;
    let id = incoming.id;
    for (let n = 1; !id || usedIds.has(id); n++) id = `${incoming.id || 'synced'}-synced${n > 1 ? `-${n}` : ''}`;
    usedIds.add(id);
    // Its stamp travels with it: the account is as new as its last edit, not
    // as new as its arrival here, so an older deletion elsewhere still loses
    // and a newer one still wins.
    const added: Account = { ...incoming, id };
    const at = stamp(incoming.updatedAt);
    if (at === undefined) delete added.updatedAt;
    fresh.push(added);
  }

  if (fresh.length === 0 && updated === 0 && removed.length === 0) return null;
  return { accounts: [...fresh, ...kept], added: fresh.length, updated, removed };
}

/**
 * This device's account with another device's newer edit: its own id, creation
 * time and secret spelling kept — and Steam Guard, once either side knows it.
 * A Steam seed read as TOTP is what a build before Steam support makes of it,
 * and its six digits are codes Steam never accepts (storage.ts becomesSteam):
 * a rename made on such a build must not flatten the account back.
 */
function adopt(local: Account, incoming: Account): Account {
  if (local.type === 'steam' && incoming.type !== 'steam') {
    const next = adopt(local, { ...incoming, type: 'steam', algorithm: local.algorithm, digits: local.digits, period: local.period });
    return next;
  }
  const next: Account = {
    ...local,
    name: incoming.name,
    issuer: incoming.issuer,
    algorithm: incoming.algorithm,
    digits: incoming.digits,
    period: incoming.period,
    updatedAt: versionStamp(incoming),
  };
  for (const field of OPTIONAL_FIELDS) {
    const v = value(incoming, field);
    if (v === undefined) delete next[field];
    else (next as unknown as Record<string, unknown>)[field] = field === 'sites' ? String(v).split(' ') : v;
  }
  return next;
}
