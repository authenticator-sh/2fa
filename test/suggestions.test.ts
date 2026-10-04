import { areas, check, resetState, scenario } from './harness';

const ACCOUNTS: any[] = [
  { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
  { id: 'a2', name: 'bob@example.com', issuer: 'Amazon Web Services', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
];

export async function run(): Promise<void> {
  const s = await import('@/utils/suggestions');

  await resetState();
  scenario('Account suggestions');

  check('base domain strips subdomains', s.getBaseDomain('accounts.google.com') === 'google.com');
  check('base domain keeps co.uk-style suffixes', s.getBaseDomain('shop.example.co.uk') === 'example.co.uk');
  check('and com.au-style ones', s.getBaseDomain('my.bank.com.au') === 'bank.com.au');

  check('are on by default', await s.areSuggestionsEnabled());
  check('match a site by issuer name', (await s.getSuggestedAccountId('github.com', ACCOUNTS)) === 'a1');
  check('do not match an unrelated site', (await s.getSuggestedAccountId('unrelated-domain.com', ACCOUNTS)) === null);

  scenario('Suggestions learn from use');
  await s.recordAccountUsage('example.com', 'a2');
  check('a recorded account wins on that site', (await s.getSuggestedAccountId('example.com', ACCOUNTS)) === 'a2');
  check('usage is stored per site', 'accountUsageByDomain' in areas.local);

  scenario('Turning suggestions off');
  await s.setSuggestionsEnabled(false);
  check('no suggestion is returned', (await s.getSuggestedAccountId('github.com', ACCOUNTS)) === null);
  // Switching this off is a privacy choice, not a display preference — the
  // history it collected has to go too.
  check('the collected history is erased', !('accountUsageByDomain' in areas.local));
  await s.recordAccountUsage('example.com', 'a2');
  check('no new history is recorded while off', !('accountUsageByDomain' in areas.local));

  await s.setSuggestionsEnabled(true);
  check('re-enabling works', await s.areSuggestionsEnabled());
  // The learned preference for a2 on example.com is gone for good. What comes
  // back is the text heuristic, which matches a1 because its account name is an
  // address at that domain — a fresh guess, not the erased history.
  check('the learned preference does not come back', (await s.getSuggestedAccountId('example.com', ACCOUNTS)) === 'a1');

  await resetState();
  scenario('A public zone is not one site');
  // The old rule knew co/com/org/net/gov/edu/ac and nothing else, so every
  // Korean government service was "go.kr" and every GitHub Pages site was
  // "github.io" — one history for all of them, and a code inserted unasked on
  // a site the account had never been used on.
  for (const [host, expected] of [
    ['www.hometax.go.kr', 'hometax.go.kr'],
    ['www.gov24.go.kr', 'gov24.go.kr'],
    ['www.bank.or.kr', 'bank.or.kr'],
    ['login.nta.go.jp', 'nta.go.jp'],
    ['mail.example.ne.jp', 'example.ne.jp'],
    ['www.impots.gouv.fr', 'impots.gouv.fr'],
    ['www.canada.gc.ca', 'canada.gc.ca'],
    ['www.ird.govt.nz', 'ird.govt.nz'],
    ['www.sat.gob.mx', 'sat.gob.mx'],
    ['evil.github.io', 'evil.github.io'],
    ['deep.page.evil.github.io', 'evil.github.io'],
    ['evil.vercel.app', 'evil.vercel.app'],
    ['evil.herokuapp.com', 'evil.herokuapp.com'],
    ['bucket.s3.amazonaws.com', 'bucket.s3.amazonaws.com'],
    ['shop.example.com.np', 'example.com.np'],
  ] as const) {
    const got = s.getBaseDomain(host);
    check(`${host} → ${expected}`, got === expected, got);
  }
  check('a suffix on its own is left as it is', s.getBaseDomain('github.io') === 'github.io');
  check('ordinary .com sites are unchanged', s.getBaseDomain('login.github.com') === 'github.com');
  check('an address is not trimmed to two octets', s.getBaseDomain('192.168.1.10') === '192.168.1.10');

  // The end-to-end symptom: an account used on one government site offered
  // for insertion on another.
  await s.recordAccountUsage('www.hometax.go.kr', 'a2', 'site');
  check('history on one go.kr site fills there', (await s.getFillCandidate('www.hometax.go.kr', ACCOUNTS))?.accountId === 'a2');
  check('but not on a neighbour in the same zone', (await s.getFillCandidate('www.gov24.go.kr', ACCOUNTS)) === null);
}
