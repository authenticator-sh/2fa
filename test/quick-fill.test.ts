import { areas, check, resetState, scenario } from './harness';

const GITHUB: any = { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 };
const AWS: any = { id: 'a2', name: 'bob@example.com', issuer: 'Amazon Web Services', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 };
const ACCOUNTS = [GITHUB, AWS];

// The account a site names, and one that has nothing to do with any site: a
// VPN whose code is typed into a desktop client, with whatever tab happened to
// be open behind the popup.
const VERCEL: any = { id: 'v1', name: 'alice', issuer: 'Vercel', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 3 };
const VPN: any = { id: 'v2', name: 'alice', issuer: 'Mullvad', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 4 };
const DESK = [VERCEL, VPN];

export async function run(): Promise<void> {
  const s = await import('@/utils/suggestions');
  const pref = await import('@/utils/quick-fill');

  await resetState();
  scenario('Choosing an account to insert without asking');

  const one = await s.getFillCandidate('github.com', ACCOUNTS);
  check('a single issuer match is enough to fill', one?.accountId === 'a1' && one.source === 'text');
  check('an unrelated site is left to the user', (await s.getFillCandidate('unrelated-domain.com', ACCOUNTS)) === null);

  // Both accounts are named <someone>@example.com, so the text heuristic has
  // two answers and no way to rank them. The popup may show its first guess;
  // inserting one of them into a form that submits itself would spend an
  // attempt on a coin flip.
  check('an ambiguous match refuses to guess', (await s.getFillCandidate('example.com', ACCOUNTS)) === null);
  check('the popup still shows its best guess there', (await s.getSuggestedAccountId('example.com', ACCOUNTS)) === 'a1');

  check('nothing to fill from an empty list', (await s.getFillCandidate('github.com', [])) === null);
  check('nothing to fill without a hostname', (await s.getFillCandidate('', ACCOUNTS)) === null);

  scenario('A code copied while a page happened to be open');

  // The reported symptom: on Vercel, copy the code for a VPN that runs on the
  // desktop and has no connection to the site. The copy says where the popup
  // was, not where the code went.
  await s.recordAccountUsage('vercel.com', VPN.id);
  check('the account the site names keeps the suggestion', (await s.getSuggestedAccountId('vercel.com', DESK)) === VERCEL.id);
  const named = await s.getFillCandidate('vercel.com', DESK);
  check('and is what gets inserted', named?.accountId === VERCEL.id && named?.source === 'text');

  // Repetition does not turn it into evidence about the site either: it is the
  // same act, and the same thing unknown about it.
  await s.recordAccountUsage('vercel.com', VPN.id);
  await s.recordAccountUsage('vercel.com', VPN.id);
  check('nor does copying it again and again', (await s.getSuggestedAccountId('vercel.com', DESK)) === VERCEL.id);

  // Where nothing else says anything, a copy is still the only thing we know.
  await s.recordAccountUsage('some-saas.com', VPN.id);
  check('on a site nothing names, a copy is still worth showing', (await s.getSuggestedAccountId('some-saas.com', DESK)) === VPN.id);
  check('but never worth inserting unasked', (await s.getFillCandidate('some-saas.com', DESK)) === null);

  scenario('An account actually used on the site');

  await s.recordAccountUsage('some-saas.com', VPN.id, 'site');
  const used = await s.getFillCandidate('some-saas.com', DESK);
  check('one use on the page is enough to fill', used?.accountId === VPN.id && used?.source === 'history');

  // And it outranks the name, because the user's own behaviour on the site
  // beats a guess made from its address.
  await s.recordAccountUsage('vercel.com', VPN.id, 'site');
  check('it outranks the account the site names', (await s.getSuggestedAccountId('vercel.com', DESK)) === VPN.id);
  check('for insertion too', (await s.getFillCandidate('vercel.com', DESK))?.accountId === VPN.id);

  scenario('Two accounts on the same service');

  await resetState();
  // Neither name settles which of the two belongs here, so a copy made on the
  // site is allowed to break that tie — it is a choice between accounts the
  // site already names, not a stray code from a desktop client.
  await s.recordAccountUsage('example.com', 'a2');
  check('a copy picks between the accounts the site names', (await s.getSuggestedAccountId('example.com', ACCOUNTS)) === 'a2');
  check('but still does not authorise inserting one', (await s.getFillCandidate('example.com', ACCOUNTS)) === null);

  scenario('History written before this release');

  await resetState();
  // Older versions stored a bare count, and every one of those was a popup
  // copy — so that is what they have to be read as, not as use on the site.
  areas.local.accountUsageByDomain = { 'vercel.com': { [VPN.id]: 9 } };
  check('a bare count reads as copies, not as use here', (await s.getSuggestedAccountId('vercel.com', DESK)) === VERCEL.id);
  check('and does not fill on its own', (await s.getFillCandidate('vercel.com', DESK))?.accountId === VERCEL.id);

  scenario('The question quick fill leaves for the popup');

  await resetState();
  check('no question, no answer', !(await pref.takePickPrompt('vercel.com')));
  await pref.notePickPrompt('vercel.com');
  check('a different site cannot claim it', !(await pref.takePickPrompt('other.com')));
  await pref.notePickPrompt('vercel.com');
  check('the site asked about can', await pref.takePickPrompt('vercel.com'));
  check('and only once', !(await pref.takePickPrompt('vercel.com')));

  scenario('Suggestions switched off');

  await s.setSuggestionsEnabled(false);
  check('no account is chosen for the page', (await s.getFillCandidate('github.com', ACCOUNTS)) === null);
  await s.setSuggestionsEnabled(true);

  scenario('The menu item preference');

  check('the menu item is offered by default', await pref.isQuickFillEnabled());
  await pref.setQuickFillEnabled(false);
  check('turning it off is remembered', !(await pref.isQuickFillEnabled()));
  check('and is visible to the service worker', areas.local[pref.QUICK_FILL_ENABLED_KEY] === false);
  await pref.setQuickFillEnabled(true);
  check('turning it back on works', await pref.isQuickFillEnabled());
}
