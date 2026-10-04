// Build-time billing configuration.
//
// Injected by vite.config.ts `define` from the BILLING_ENV and BILLING_API
// environment variables of the build. The unit tests run without Vite, where
// the globals do not exist, and behave as a test build.

declare const __BILLING_ENV__: string | undefined;
declare const __BILLING_API__: string | undefined;
declare const __BILLING_RELEASE__: string | undefined;

export type BillingEnv = 'production' | 'preview' | 'test';

function readEnv(): BillingEnv {
  const value = typeof __BILLING_ENV__ !== 'undefined' ? __BILLING_ENV__ : 'test';
  return value === 'production' || value === 'preview' ? value : 'test';
}

export const BILLING_ENV: BillingEnv = readEnv();

/** The billing API. A store build always talks to the production host. */
export const API_ORIGIN: string =
  BILLING_ENV === 'production'
    ? 'https://api.authenticator.sh'
    : (typeof __BILLING_API__ !== 'undefined' && __BILLING_API__) || 'http://localhost:3100';

const STORE_RELEASE_DATE = Date.parse('2026-10-04T00:00:00Z');

/**
 * A development or test build may move the date (BILLING_RELEASE=2026-01-01):
 * the e2e and stack suites run before release day, and every account they
 * make "today" would otherwise read as made before billing and turn the
 * install legacy. A store build always uses the date written here.
 */
function readReleaseDate(): number {
  if (BILLING_ENV === 'production' || typeof __BILLING_RELEASE__ === 'undefined' || !__BILLING_RELEASE__) return STORE_RELEASE_DATE;
  const at = Date.parse(__BILLING_RELEASE__);
  return Number.isFinite(at) ? at : STORE_RELEASE_DATE;
}

/**
 * Exports made before this date come from installs that predate the paywall,
 * so importing one marks the install legacy, and so do accounts arriving
 * through Chrome sync that were made before it (MONETIZATION.md §3.1). Set to
 * the day 1.14.0 is published; see docs/releasing.md.
 */
export const BILLING_RELEASE_DATE = readReleaseDate();

/** First version that talks to the billing server. */
export const BILLING_FIRST_VERSION = '1.14.0';
