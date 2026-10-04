// The paywall as a request any module can make — the popup, the add dialog,
// the importer, the scan page — and <PaywallHost/> renders. The same shape as
// utils/ui-feedback.ts, for the same reason: the callers are spread across
// components that share no parent worth threading a callback through.

export type PaywallTrigger = 'form' | 'qr' | 'migration' | 'file' | 'uri' | 'scan' | 'settings';

export interface LimitContext {
  /** Accounts already stored. */
  count: number;
  /** New accounts the blocked operation would have added. */
  wouldAdd: number;
  /** How many of them fit in the free plan. */
  remaining: number;
  limit: number;
}

/**
 * - `partial`: the person chose to add only what fits for free.
 * - `activated`: a key was entered and Pro is on — the blocked add can go ahead.
 * - `checkout`: Stripe Checkout was opened in a tab.
 * - `closed`: nothing happened.
 */
export type PaywallResult = 'partial' | 'activated' | 'checkout' | 'closed';

export interface PaywallRequest {
  id: number;
  trigger: PaywallTrigger;
  limit: LimitContext | null;
  allowPartial: boolean;
  /**
   * Run as Checkout is about to open, before the tab takes focus — the last
   * moment a popup is still alive. The blocked add keeps its account here
   * (billing/held-add.ts). Must not throw.
   */
  beforeCheckout: (() => Promise<void>) | null;
  resolve: (result: PaywallResult) => void;
}

let current: PaywallRequest | null = null;
let nextId = 1;
const listeners = new Set<(request: PaywallRequest | null) => void>();

function emit(): void {
  for (const listener of listeners) listener(current);
}

export function subscribePaywall(listener: (request: PaywallRequest | null) => void): () => void {
  listeners.add(listener);
  listener(current);
  return () => listeners.delete(listener);
}

/** Shows the paywall; resolves when it closes. A second request replaces the first. */
export function openPaywall(options: {
  trigger: PaywallTrigger;
  limit?: LimitContext | null;
  allowPartial?: boolean;
  beforeCheckout?: (() => Promise<void>) | null;
}): Promise<PaywallResult> {
  current?.resolve('closed');
  return new Promise(resolve => {
    const id = nextId++;
    current = {
      id,
      trigger: options.trigger,
      limit: options.limit ?? null,
      allowPartial: options.allowPartial ?? false,
      beforeCheckout: options.beforeCheckout ?? null,
      resolve: result => {
        if (current?.id === id) {
          current = null;
          emit();
        }
        resolve(result);
      },
    };
    emit();
  });
}
