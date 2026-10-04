// The shapes the billing server sends. This is the extension's copy of
// server/src/contract.ts — the server is a separate, private repository —
// and must stay in step with it; unknown fields are ignored, missing ones are
// read as absent.

export type PlanKind = 'sub' | 'life' | 'pass';

export interface DisplayPrice {
  kind: PlanKind;
  interval: 'month' | 'year' | null;
  pass_days: number | null;
  /** Minor units of `currency`; divide by 10^exp. */
  amount: number;
  currency: string;
  exp: 0 | 2 | 3;
  /** USD shown where checkout will convert to the local currency. */
  approx: boolean;
}

export interface Policy {
  pid: string;
  free_limit: number | null;
  warn_at: number | null;
  paywall: {
    copy: string;
    plans: string[];
    default_plan: string;
    trial_days: number;
    promo_codes: boolean;
    /**
     * A title and body written on the server, in one interface language. Shown
     * instead of the shipped `copy` when that language is the one on screen.
     */
    text: { lang: string; title: string; body: string } | null;
  };
  prices: Record<string, DisplayPrice>;
  ui: { pro_in_settings: boolean; import_partial: boolean; import_free: boolean };
  exps: { id: string; layer: string; var: string }[];
  /** When the server signed it (seconds), if it said. */
  iat: number | null;
}

export interface Entitlement {
  lid: string;
  kind: 'life' | 'comp' | 'sub' | 'pass';
  features: string[];
  /** When access ends (ms), null for lifetime. */
  until: number | null;
  key_hint: string;
  /** When this token stops being believed (ms) — sooner than `until`. */
  expiresAt: number;
}

/**
 * - `sync-accounts`: accounts that came through Chrome sync were made before
 *   billing — the person's other computer never ran 1.14 (MONETIZATION.md §3.1).
 */
export type LegacySource = 'update' | 'existing-data' | 'sync-marker' | 'backup-file' | 'sync-accounts';

export interface InstallRecord {
  id: string;
  createdAt: number;
  /** When this install came to be, if it happened after billing shipped. */
  installedAt: number | null;
  legacy: boolean;
  legacySrc: LegacySource | null;
}

/** Error codes the API answers with (server/src/contract.ts ApiErrorCode). */
export type ApiErrorCode =
  | 'bad_request'
  | 'rate_limited'
  | 'unknown_install'
  | 'plan_unavailable'
  | 'invalid_key'
  | 'license_inactive'
  | 'device_limit'
  | 'no_license'
  | 'payments_unavailable'
  /** Checkout: the plan's price is not the one this install's last policy showed. */
  | 'price_changed'
  | 'internal'
  | 'network';
