import type { Account } from '@/types';

const STORAGE_KEY = 'accountUsageByDomain';
const ENABLED_KEY = 'suggestionsEnabled';
const GENERIC_SECOND_LEVEL = new Set(['co', 'com', 'org', 'net', 'gov', 'edu', 'ac']);

type UsageMap = Record<string, Record<string, number>>;

/** On by default — the suggestion is the main reason to use this on desktop. */
export async function areSuggestionsEnabled(): Promise<boolean> {
  const result = await chrome.storage.local.get(ENABLED_KEY);
  return result[ENABLED_KEY] !== false;
}

export async function setSuggestionsEnabled(enabled: boolean): Promise<void> {
  await chrome.storage.local.set({ [ENABLED_KEY]: enabled });
  // Turning the feature off means the per-site usage history stops being
  // collected AND what was already collected goes away — someone switching
  // this off is objecting to the record existing, not just to the highlight.
  if (!enabled) {
    await chrome.storage.local.remove(STORAGE_KEY);
  }
}

// Strips subdomains down to a registrable domain. Good enough for a usage
// heuristic (not security-sensitive) — doesn't consult a real public suffix list,
// so exotic multi-part TLDs beyond the common co.uk-style pattern may over-strip.
export function getBaseDomain(hostname: string): string {
  const parts = hostname.split('.').filter(Boolean);
  if (parts.length <= 2) return hostname;

  const tld = parts[parts.length - 1];
  const sld = parts[parts.length - 2];
  if (tld.length === 2 && GENERIC_SECOND_LEVEL.has(sld) && parts.length >= 3) {
    return parts.slice(-3).join('.');
  }
  return parts.slice(-2).join('.');
}

async function getUsageMap(): Promise<UsageMap> {
  return new Promise((resolve) => {
    chrome.storage.local.get(STORAGE_KEY, (result) => resolve(result[STORAGE_KEY] || {}));
  });
}

export async function recordAccountUsage(hostname: string, accountId: string): Promise<void> {
  if (!(await areSuggestionsEnabled())) return;

  const domain = getBaseDomain(hostname);
  const usage = await getUsageMap();
  usage[domain] = usage[domain] || {};
  usage[domain][accountId] = (usage[domain][accountId] || 0) + 1;
  await new Promise<void>((resolve) => chrome.storage.local.set({ [STORAGE_KEY]: usage }, () => resolve()));
}

export async function getSuggestedAccountId(hostname: string, accounts: Account[]): Promise<string | null> {
  if (!hostname || accounts.length === 0) return null;
  if (!(await areSuggestionsEnabled())) return null;
  const domain = getBaseDomain(hostname);

  const usage = await getUsageMap();
  const domainUsage = usage[domain];
  if (domainUsage) {
    const validEntries = Object.entries(domainUsage).filter(([id]) => accounts.some(acc => acc.id === id));
    if (validEntries.length > 0) {
      validEntries.sort((a, b) => b[1] - a[1]);
      return validEntries[0][0];
    }
  }

  // No usage history yet for this domain — fall back to a text-match heuristic
  // between the domain name and the account's issuer/name.
  const domainCore = domain.split('.')[0].toLowerCase();
  if (domainCore.length < 3) return null;

  const match = accounts.find(acc => {
    const issuer = acc.issuer.toLowerCase();
    const name = acc.name.toLowerCase();
    return (issuer.length >= 3 && (issuer.includes(domainCore) || domainCore.includes(issuer))) ||
      (name.length >= 3 && name.includes(domainCore));
  });

  return match?.id || null;
}
