import { areas, check, resetState, scenario } from './harness';

const acc = (id: string, issuer: string, extra: Record<string, unknown> = {}): any => ({
  id, name: 'alice', issuer, secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1, ...extra,
});

export async function run(): Promise<void> {
  const l = await import('@/utils/lookalike');
  const c = await import('@/utils/site-check');
  const s = await import('@/utils/suggestions');

  const GITHUB = acc('gh', 'GitHub');
  const PAYPAL = acc('pp', 'PayPal');
  const MS = acc('ms', 'Microsoft');
  const AWS = acc('aws', 'Amazon Web Services');
  const STEAM = acc('st', 'Steam');
  const GOOGLE = acc('go', 'Google');
  const ALL = [GITHUB, PAYPAL, MS, AWS, STEAM, GOOGLE];
  const kind = async (host: string, account: any, all = ALL) => (await c.checkSite(host, account, all))?.kind ?? null;

  await resetState();
  scenario('A page dressed up as the account’s site is caught');
  for (const [host, account, expected] of [
    ['githuh.com', GITHUB, 'typo'],
    ['gihtub.com', GITHUB, 'typo'],
    ['githubb.io', GITHUB, 'typo'],
    ['g1thub.com', GITHUB, 'homoglyph'],
    ['xn--gthub-n4a.com', GITHUB, 'homoglyph'], // gіthub with a Cyrillic і
    ['paypa1.com', PAYPAL, 'homoglyph'],
    ['pay-pal.com', PAYPAL, null], // only the issuer to go on: "My Bank" may live at my-bank.com
    ['xn--gthub-n2e.com', GITHUB, 'homoglyph'], // Cyrillic і
    ['xn--pypal-4ve.com', PAYPAL, 'homoglyph'], // Cyrillic а
    ['rnicrosoft.com', MS, 'homoglyph'],
    ['github-login.com', GITHUB, 'lure'],
    ['login-github.net', GITHUB, 'lure'],
    ['secure-paypal-verify.com', PAYPAL, 'lure'],
    ['githubverify.com', GITHUB, 'lure'],
    ['github-com.xyz', GITHUB, 'lure'],
    ['microsoft-account.support', MS, 'lure'],
    ['github.com.verify-session.xyz', GITHUB, 'embedded'],
    ['stearn.com', STEAM, 'homoglyph'],
    ['steam-trade-confirm.com', STEAM, null], // "trade" is not a lure word: quiet is the safe side of a guess
  ] as const) {
    const got = await kind(host, account);
    check(`${host} → ${expected ?? 'quiet'}`, got === expected, String(got));
  }

  scenario('…and nothing else is');
  for (const [host, account] of [
    ['github.com', GITHUB],
    ['gist.github.com', GITHUB],
    ['github.io', GITHUB],
    ['github.co', GITHUB], // same name, other domain: quick fill asks, no alarm
    ['githubusercontent.com', GITHUB],
    ['githubstatus.com', GITHUB],
    ['gitlab.com', GITHUB],
    ['login.microsoftonline.com', MS],
    ['live.com', MS],
    ['microsoft.com', MS],
    ['signin.aws.amazon.com', AWS],
    ['amazon.de', AWS],
    ['d-123.awsapps.com', AWS],
    ['amazonaws.com', AWS],
    ['steamcommunity.com', STEAM],
    ['store.steampowered.com', STEAM],
    ['accounts.google.com', GOOGLE],
    ['googleusercontent.com', GOOGLE],
    ['google-analytics.com', GOOGLE],
    ['paypal-community.com', PAYPAL],
    ['paypalobjects.com', PAYPAL],
    ['vercel.com', GITHUB],
    ['example.com', GITHUB],
    ['192.168.1.10', GITHUB],
    ['localhost', GITHUB],
  ] as const) {
    const got = await kind(host, account);
    check(`${host} for ${account.issuer}: quiet`, got === null, String(got));
  }

  scenario('Issuers that name no brand are never imitated');
  for (const issuer of ['vpn', 'Login', 'Admin portal', 'My Bank', 'Company', 'Work', 'x']) {
    const got = await kind('login-portal-secure.com', acc('g', issuer), [acc('g', issuer)]);
    check(`"${issuer}" → quiet on login-portal-secure.com`, got === null, String(got));
  }

  scenario('Another account’s real name is not a fake of this one');
  const STRIPE = acc('sp', 'Stripe');
  const STRIKE = acc('sk', 'Strike');
  check('strike.me warns for Stripe when no Strike account', (await kind('strike.me', STRIPE, [STRIPE])) === 'typo');
  check('but not when the user also has Strike', (await kind('strike.me', STRIPE, [STRIPE, STRIKE])) === null);

  scenario('The account’s own sites count, by hand or by use');
  const CORP = acc('corp', 'Okta', { sites: ['acme.okta.com'] });
  check('a tied site is never warned on', (await kind('acme.okta.com', CORP, [CORP])) === null);
  const SELF = acc('self', 'Self-hosted', { sites: ['vault.mycorp-tools.dev'] });
  check('a typo of a tied domain is caught', (await kind('mycorp-tool.dev', SELF, [SELF])) === 'typo');
  check('its sibling subdomains are fine', (await kind('git.mycorp-tools.dev', SELF, [SELF])) === null);
  await s.recordAccountUsage('portal.examplebank.com', 'eb', 'site');
  const BANK = acc('eb', 'EB');
  check('a site the code was inserted on counts', (await kind('examplebank-secure.com', BANK, [BANK])) === 'lure');
  check('and the site itself is fine', (await kind('www.examplebank.com', BANK, [BANK])) === null);
  await s.recordAccountUsage('www.paypal.com', 'pp', 'site');
  check('pay-pal.com is caught once paypal.com is where the account is used', (await kind('pay-pal.com', PAYPAL, [PAYPAL])) === 'homoglyph');
  const cap = await c.checkSite('examplebank-secure.com', BANK, [BANK]);
  check('the warning names where it was used', cap?.like === 'examplebank.com' && cap.basis === 'site', JSON.stringify(cap));

  scenario('“It’s the real site” is remembered');
  check('warned before', (await kind('github-login.com', GITHUB)) === 'lure');
  await c.trustSite('github-login.com', 'gh');
  check('not after', (await kind('github-login.com', GITHUB)) === null);
  check('only for that account', (await kind('github-login.com', acc('gh2', 'GitHub'), [acc('gh2', 'GitHub')])) === 'lure');

  await resetState();
  await s.setSuggestionsEnabled(false);
  await c.trustSite('github-login.com', 'gh');
  check('even with suggestions off', (await kind('github-login.com', GITHUB)) === null);
  await s.setSuggestionsEnabled(true);

  scenario('It can be switched off');
  await resetState();
  check('on by default', await c.isSiteWarnEnabled());
  await c.setSiteWarnEnabled(false);
  check('off: quiet', (await kind('githuh.com', GITHUB)) === null);
  await c.setSiteWarnEnabled(true);
  check('back on', (await kind('githuh.com', GITHUB)) === 'typo');

  scenario('Quick fill does not type a name-only match into another domain the account was never used on');
  await resetState();
  check('github.com fills from the name', (await s.getFillCandidate('github.com', [GITHUB]))?.accountId === 'gh');
  await s.recordAccountUsage('github.com', 'gh', 'site');
  check('used on github.com: github.co asks', (await s.getFillCandidate('github.co', [GITHUB])) === null);
  check('github.com still fills', (await s.getFillCandidate('github.com', [GITHUB]))?.accountId === 'gh');

  scenario('The daily count says nothing but counts');
  await resetState();
  await c.countCodeUse('copy', 'github.com', GITHUB, false);
  await s.recordAccountUsage('github.com', 'gh', 'site');
  await c.countCodeUse('fill', 'github.com', GITHUB, false);
  await c.countCodeUse('copy', 'vercel.com', GITHUB, false);
  const day = areas.local.codeSitesDaily;
  check('counted by kind', day?.copy === 2 && day?.fill === 1, JSON.stringify(day));
  check('and by where', day?.unknown === 1 && day?.here === 1 && day?.elsewhere === 1, JSON.stringify(day));
  areas.local.codeSitesDaily = { ...day, day: '2000-01-01' };
  await c.countCodeUse('copy', 'github.com', GITHUB, false);
  const queued = (areas.local.billingEvents ?? []) as any[];
  const sent = queued.find(e => e.n === 'code_sites');
  check('the turned day is sent as one event', !!sent && sent.p.copy === 2 && !('day' in sent.p), JSON.stringify(sent));
  check('without a site in it', !JSON.stringify(sent ?? {}).includes('github'));

  scenario('Punycode is read as the letters it stands for');
  check('xn--gthub-n2e.com decodes', l.decodeHost('xn--gthub-n2e.com') === 'gіthub.com', l.decodeHost('xn--gthub-n2e.com'));
  check('xn--pple-43d.com decodes', l.decodeHost('xn--pple-43d.com') === 'аpple.com', l.decodeHost('xn--pple-43d.com'));
  check('a plain host is left alone', l.decodeHost('github.com') === 'github.com');
}
