// The one way the interface adds accounts the person brought.
//
// It reads the limit, lets storage enforce it, and when storage refuses it
// opens the paywall instead of an error — with, for an import that only
// partly fits, the choice to take what fits for free.

import type { Account } from '@/types';
import type { AddOrigin, GateSnapshot } from './gate';
import { AccountLimitError } from './gate';
import { openPaywall, type PaywallTrigger } from './bridge';
import { track } from './events';
import { holdBlockedAdd } from './held-add';
import { addedBy, reportAccountAdded, type AddVia } from './onboarding';
import { loadGate, readInstall, readPolicy } from './state';
import { hasPendingCheckout, syncBilling } from './sync';

/**
 * How long after opening checkout a blocked add first asks the server whether
 * it was paid: as long as a purchase is looked for at all (sync.ts
 * PENDING_CHECKOUT_MS). A confirmation that takes hours — a bank's own check,
 * a webhook retried — must not end in a second purchase.
 */
const RECENT_CHECKOUT_MS = 24 * 3_600_000;

/**
 * With a purchase from this install opened recently and still unconfirmed,
 * asks the server once more before the paywall opens: someone who just paid
 * and came straight back must not be offered — and buy — Pro a second time.
 * After an abandoned checkout each blocked add waits on that one request, for
 * a day; the price of never selling Pro twice.
 */
async function freshGateIfPaying() {
  if (!(await hasPendingCheckout(Date.now(), RECENT_CHECKOUT_MS))) return null;
  await syncBilling({ force: true, urgent: true });
  return loadGate();
}

async function importPartialAllowed(): Promise<boolean> {
  const install = await readInstall();
  const policy = install ? await readPolicy(install.id) : null;
  return policy?.ui.import_partial ?? true;
}

/** Paths that bring existing accounts over rather than add a new one. */
const IMPORTS: ReadonlySet<PaywallTrigger> = new Set(['migration', 'file', 'uri']);

/** Whether an import goes in whatever the limit (policy ui.import_free; no policy, no limit anyway). */
const importsFree = (gate: GateSnapshot) => gate.policy?.import_free !== false;

/**
 * Runs `run` with the current limit. Returns what it returned, or null if the
 * limit stopped it and the person did not take the free part or turn on Pro.
 * Errors other than the limit propagate unchanged.
 *
 * An import (`options.import`, by default the import triggers) is not limited
 * while the policy says so: the paywall waits for the first account the
 * person adds themselves.
 *
 * `options.hold` is the account a single add was adding. If the person goes
 * on to Checkout it is kept (billing/held-add.ts) and added once Pro is on —
 * from the popup, which Checkout's tab closes, as from anywhere else.
 */
export async function addWithLimit<T>(
  trigger: AddVia,
  run: (origin: AddOrigin) => Promise<T>,
  options: { import?: boolean; hold?: Account[] } = {}
): Promise<T | null> {
  const result = await addWithinLimit(trigger, run, options);
  // Every way in passes here, so this is where an account is counted as added.
  void reportAccountAdded(trigger, addedBy(result));
  return result;
}

async function addWithinLimit<T>(
  trigger: AddVia,
  run: (origin: AddOrigin) => Promise<T>,
  options: { import?: boolean; hold?: Account[] }
): Promise<T | null> {
  const gate = await loadGate();
  if ((options.import ?? IMPORTS.has(trigger)) && importsFree(gate)) return run({ kind: 'import' });
  try {
    return await run({ kind: 'user', gate });
  } catch (error) {
    if (!(error instanceof AccountLimitError)) throw error;
    const fresh = await freshGateIfPaying();
    if (fresh?.entitled) return run({ kind: 'user', gate: fresh });
    await track('limit_blocked', {
      source: trigger,
      requested: error.wouldAdd,
      count: error.count,
      limit: error.limit,
    });
    const allowPartial = error.wouldAdd > 1 && error.remaining > 0 && (await importPartialAllowed());
    const hold = options.hold;
    const result = await openPaywall({
      trigger,
      limit: { count: error.count, wouldAdd: error.wouldAdd, remaining: error.remaining, limit: error.limit },
      allowPartial,
      beforeCheckout: hold && hold.length > 0 ? () => holdBlockedAdd(hold) : null,
    });
    if (result === 'activated') return run({ kind: 'user', gate: await loadGate() });
    if (result === 'partial') {
      const out = await run({ kind: 'user', gate: await loadGate(), take: error.remaining });
      await track('import_partial', { offered: error.wouldAdd, imported: error.remaining });
      return out;
    }
    // The limit is on new accounts. Improvements the same file brings to
    // accounts already here (a card becoming Steam Guard, say) go through
    // whatever the person chose, with no new account added.
    if (error.updated > 0) return run({ kind: 'user', gate: await loadGate(), take: 0 });
    return null;
  }
}
