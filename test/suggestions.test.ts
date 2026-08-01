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
}
