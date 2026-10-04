// The account limit, decided here and nowhere else.
//
// Pure and synchronous on purpose: the decision is made from what is already
// on this machine — the last policy and license the server signed — so the
// network is never on the path between a user and their own accounts
// (MONETIZATION.md §1, invariants 3 and 4).
//
// It only ever answers "may these accounts be added". Nothing in this module
// can hide, lock or remove an account, and nothing calls it on the way to
// showing codes, exporting, backing up, restoring or syncing.

/** The policy fields the gate reads; the whole token is described in ./types. */
export interface GatePolicy {
  free_limit: number | null;
  warn_at: number | null;
  /** Imports are not counted against the limit (policy ui.import_free). */
  import_free: boolean;
}

export interface GateSnapshot {
  /**
   * Null until the server has spoken — and then there is no limit (invariant
   * 4) — and again once it has been silent for SERVER_SILENCE_MS.
   */
  policy: GatePolicy | null;
  /** A license this install holds that has not expired. */
  entitled: boolean;
}

export const UNGATED: GateSnapshot = { policy: null, entitled: true };

/**
 * How long the server's last signed word stands without a new one. Past it
 * the install has no limit until the next successful check-in: a corporate
 * proxy, a blocked API or an outage would otherwise leave a paywall nobody
 * can pay through (owner's call, 2026-10-03; invariant 4 carried forward).
 */
export const SERVER_SILENCE_MS = 14 * 86_400_000;

/**
 * Whether the server has not answered for so long that its limit lapses.
 * `lastHeardAt` is when it last did (ms), on this machine's clock. A time in
 * the future — the clock was moved back since — counts as now: it neither
 * stretches the wait past fourteen days of the clock as it reads today nor
 * cuts it short. Unknown is not silence.
 */
export function serverSilent(lastHeardAt: number | null, now: number): boolean {
  if (lastHeardAt === null || !Number.isFinite(lastHeardAt) || !Number.isFinite(now)) return false;
  return now - Math.min(lastHeardAt, now) >= SERVER_SILENCE_MS;
}

/** How many more accounts may be added to a list of `count`. Infinity = no limit. */
export function remainingSlots(gate: GateSnapshot, count: number): number {
  if (gate.entitled) return Infinity;
  const limit = gate.policy?.free_limit;
  if (limit === null || limit === undefined) return Infinity;
  return Math.max(0, limit - Math.max(0, count));
}

/**
 * Thrown from inside the storage mutation, before anything is written, when
 * the new accounts do not fit. Carries what the paywall and the partial-import
 * dialog need to say what happened.
 */
export class AccountLimitError extends Error {
  constructor(
    /** Accounts already stored. */
    readonly count: number,
    /** New accounts this operation would have added, after de-duplication. */
    readonly wouldAdd: number,
    /** How many of them fit. */
    readonly remaining: number,
    readonly limit: number,
    /** Accounts already here that the same operation would have updated — never limited. */
    readonly updated = 0,
  ) {
    super(`account limit: ${count} + ${wouldAdd} > ${limit}`);
    this.name = 'AccountLimitError';
  }
}

/**
 * Where an addition comes from. Every write that can add an account names
 * one, so a new way in cannot skip the limit by forgetting to ask for it.
 *
 * - `user`: the person is adding accounts — form, QR, link, file, scan page.
 * - `undo`: putting back an account deleted a moment ago. Never limited: a
 *   person over the limit (legacy, or a lapsed Pro) who deletes by mistake
 *   must get the account back.
 * - `import`: accounts brought over from elsewhere — a backup or another app's
 *   file, a list of links, a Google Authenticator export — when the policy
 *   lets imports in free (ui.import_free, decided in billing/add.ts). Someone
 *   moving their accounts in meets no paywall on the way; the next account
 *   they add themselves does (owner's call, 2026-10-02).
 */
export type AddOrigin =
  | { kind: 'user'; gate: GateSnapshot; take?: number }
  | { kind: 'undo' }
  | { kind: 'import' };

/**
 * How many of `added` new accounts this operation may keep, or an error.
 * `take` is the number the person agreed to — what fits for free, or none at
 * all when only the `updated` accounts already here should go through.
 */
export function admit(origin: AddOrigin, count: number, added: number, updated = 0): number {
  if (origin.kind !== 'user' || added === 0) return added;
  const remaining = remainingSlots(origin.gate, count);
  if (added <= remaining) return added;
  if (origin.take !== undefined) return Math.max(0, Math.min(origin.take, remaining));
  throw new AccountLimitError(
    count,
    added,
    Number.isFinite(remaining) ? remaining : added,
    origin.gate.policy?.free_limit ?? 0,
    updated,
  );
}
