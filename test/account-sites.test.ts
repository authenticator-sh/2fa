import { check, resetState, scenario } from './harness';

const base = { algorithm: 'SHA1', digits: 6, period: 30 };
const MAIN: any = { ...base, id: 'main', name: 'me', issuer: 'Main', secret: 'JBSWY3DPEHPK3PXP', createdAt: 1, sites: ['main.com'] };
const SUB1: any = { ...base, id: 'sub1', name: 'me', issuer: 'Main', secret: 'KRSXG5CTMVRXEZLU', createdAt: 2, sites: ['sub1.main.com'] };
const SUB2: any = { ...base, id: 'sub2', name: 'admin', issuer: 'Main', secret: 'GEZDGNBVGY3TQOJQ', createdAt: 3, sites: ['sub2.main.com'] };
const GITHUB: any = { ...base, id: 'gh', name: 'alice', issuer: 'GitHub', secret: 'MFRGGZDFMZTWQ2LK', createdAt: 4 };
const VPN: any = { ...base, id: 'vpn', name: 'alice', issuer: 'Mullvad', secret: 'NBSWY3DPO5XXE3DE', createdAt: 5 };

export async function run(): Promise<void> {
  const sites = await import('@/utils/account-sites');
  const s = await import('@/utils/suggestions');

  scenario('A website as typed is stored as its hostname');
  for (const [input, expected] of [
    ['example.com', 'example.com'],
    ['  Example.COM  ', 'example.com'],
    ['https://sub.example.com/login?next=/', 'sub.example.com'],
    ['www.example.com', 'example.com'],
    ['http://www.example.com:8080/', 'example.com'],
    ['example.com.', 'example.com'],
    ['shop.example.co.uk', 'shop.example.co.uk'],
    ['localhost', 'localhost'],
    ['192.168.1.10', '192.168.1.10'],
    ['bücher.de', 'xn--bcher-kva.de'],
  ] as const) {
    check(`${JSON.stringify(input)} → ${expected}`, sites.normalizeSite(input) === expected, String(sites.normalizeSite(input)));
  }
  for (const input of ['', 'example', 'co.uk', 'github.io', 'two words.com', 'ftp://example.com', 'javascript:alert(1)', 42, null]) {
    check(`${JSON.stringify(input)} is refused`, sites.normalizeSite(input) === null, String(sites.normalizeSite(input)));
  }
  check(
    'a list is cleaned, deduplicated and capped',
    JSON.stringify(sites.normalizeSiteList(['A.com', 'a.com', 'nope', 7, 'www.b.com', ...Array.from({ length: 30 }, (_, i) => `s${i}.com`)]).slice(0, 3)) ===
      JSON.stringify(['a.com', 'b.com', 's0.com']) && sites.normalizeSiteList(Array.from({ length: 30 }, (_, i) => `s${i}.com`)).length === sites.MAX_SITES
  );
  check('anything but an array is no sites', sites.normalizeSiteList('a.com').length === 0);

  scenario('Each subdomain gets its own account, the parent covers the rest');
  const all = [MAIN, SUB1, SUB2, GITHUB, VPN];
  const ids = (host: string) => sites.accountsForSite(host, all).map(a => a.id).join(',');
  check('sub1.main.com → only the sub1 account', ids('sub1.main.com') === 'sub1', ids('sub1.main.com'));
  check('sub2.main.com → only the sub2 account', ids('sub2.main.com') === 'sub2', ids('sub2.main.com'));
  check('main.com → only the main account', ids('main.com') === 'main', ids('main.com'));
  check('www.main.com is main.com', ids('www.main.com') === 'main', ids('www.main.com'));
  check('a subdomain without its own account falls back to the parent', ids('sub3.main.com') === 'main', ids('sub3.main.com'));
  check('deeper under sub1 is still sub1', ids('a.sub1.main.com') === 'sub1', ids('a.sub1.main.com'));
  check('a look-alike domain matches nothing', ids('evilmain.com') === '' && ids('main.com.evil.net') === '');
  check(
    'without the parent account, a sibling gets nothing',
    sites.accountsForSite('sub3.main.com', [SUB1, SUB2]).length === 0
  );

  await resetState();
  scenario('The popup pins what the user tied to the site');
  {
    const result = await s.getSiteSuggestions('sub1.main.com', all);
    check('the sub1 account, and it is marked as set by hand', result.ids.join() === 'sub1' && result.explicit);
  }
  {
    const two = [{ ...GITHUB, sites: ['github.com'] }, { ...VPN, id: 'gh2', sites: ['github.com'] }];
    const result = await s.getSiteSuggestions('github.com', two);
    check('two accounts on one site are both pinned, in list order', result.ids.join() === 'gh,gh2' && result.explicit, result.ids.join());
    await s.recordAccountUsage('github.com', 'gh2', 'site');
    const after = await s.getSiteSuggestions('github.com', two);
    check('the one used there before goes first', after.ids.join() === 'gh2,gh', after.ids.join());
  }
  {
    // GitHub's issuer would match github.com by name, but the user said this
    // account belongs elsewhere.
    const moved = [{ ...GITHUB, sites: ['github.example.org'] }, VPN];
    const result = await s.getSiteSuggestions('github.com', moved);
    check('an account tied to another site is not guessed here', result.ids.length === 0, result.ids.join());
  }
  {
    // The email's case: sub2 must not be offered on sub1 because its issuer
    // reads like the parent domain.
    const result = await s.getSiteSuggestions('sub1.main.com', [SUB2, GITHUB]);
    check('a sibling subdomain\'s account is not guessed by name', result.ids.length === 0, result.ids.join());
  }
  {
    const result = await s.getSiteSuggestions('github.com', [GITHUB, VPN]);
    check('accounts with no sites are guessed as before', result.ids.join() === 'gh' && !result.explicit);
  }

  scenario('Sites count with suggestions switched off');
  await s.setSuggestionsEnabled(false);
  check('still pinned', (await s.getSiteSuggestions('sub2.main.com', all)).ids.join() === 'sub2');
  check('still filled', (await s.getFillCandidate('sub2.main.com', all))?.accountId === 'sub2');
  check('the guess is off', (await s.getSiteSuggestions('github.com', [GITHUB])).ids.length === 0);
  await s.setSuggestionsEnabled(true);

  await resetState();
  scenario('Right-click fills the account tied to the site without asking');
  {
    const fill = await s.getFillCandidate('sub1.main.com', all);
    check('one account on the site → filled', fill?.accountId === 'sub1' && fill.source === 'site', JSON.stringify(fill));
    const two = [{ ...GITHUB, sites: ['github.com'] }, { ...VPN, id: 'gh2', sites: ['github.com'] }];
    check('two, never used → ask', (await s.getFillCandidate('github.com', two)) === null);
    await s.recordAccountUsage('github.com', 'gh2', 'site');
    check('two, one used there → that one', (await s.getFillCandidate('github.com', two))?.accountId === 'gh2');
    check(
      'a site beats what was learned for another account',
      (await s.getFillCandidate('github.com', [{ ...GITHUB, sites: ['github.com'] }, { ...VPN, id: 'gh2' }]))?.accountId === 'gh'
    );
  }

  scenario('Ticking a site from the account menu');
  check('adds the exact host', JSON.stringify(sites.toggleSite(GITHUB, 'www.GitHub.com')) === '["github.com"]');
  check('and takes it away again', sites.toggleSite({ sites: ['github.com'] }, 'github.com') === undefined);
  check('keeps the others', JSON.stringify(sites.toggleSite({ sites: ['a.com', 'b.com'] }, 'a.com')) === '["b.com"]');
  check('ticked only for the exact host', sites.hasExactSite(MAIN, 'www.main.com') && !sites.hasExactSite(MAIN, 'sub3.main.com'));

  await resetState();
  scenario('Sites are saved, cleared, exported and imported');
  {
    const storage = await import('@/utils/storage');
    await storage.saveAccounts([{ ...GITHUB }]);
    await storage.updateAccount('gh', { sites: ['github.com', 'gist.github.com'] });
    let saved = (await storage.getAccounts())[0];
    check('saved', JSON.stringify(saved.sites) === '["github.com","gist.github.com"]');
    await storage.updateAccount('gh', { sites: undefined });
    saved = (await storage.getAccounts())[0];
    check('cleared without leaving the key behind', !('sites' in saved));

    const { normalizeEntry } = await import('@/utils/import-formats');
    const parsed = normalizeEntry({ ...GITHUB, sites: ['WWW.GitHub.com', 'nonsense'] }, 0) as any;
    check('import keeps valid sites only', JSON.stringify(parsed.account?.sites) === '["github.com"]', JSON.stringify(parsed));
    const { buildPlainBackupFile } = await import('@/utils/backup-file');
    const file = buildPlainBackupFile([{ ...GITHUB, sites: ['github.com'] }]);
    check('the backup file carries them', file.includes('"github.com"'));
    await resetState();
    await storage.importAccounts(file, { kind: 'import' });
    check('and reading it back restores them', JSON.stringify((await storage.getAccounts())[0]?.sites) === '["github.com"]', JSON.stringify(await storage.getAccounts()));
  }

  scenario('Sync carries sites like any other edit');
  {
    const { planCloudMerge, sameSyncedFields } = await import('@/utils/cloud-merge');
    check('a different list is a different version', !sameSyncedFields({ ...GITHUB, sites: ['a.com'] }, { ...GITHUB, sites: ['b.com'] }));
    check('an empty list and none are the same', sameSyncedFields({ ...GITHUB, sites: [] }, { ...GITHUB }));
    const seedKey = (secret: string) => secret;
    const plan = planCloudMerge({
      local: [{ ...GITHUB, updatedAt: 5_000 }],
      localDeleted: {},
      remotes: [{ accounts: [{ ...GITHUB, id: 'x', sites: ['github.com'], updatedAt: 6_000 }], deleted: {} }],
      seedKey,
      hashOf: key => `h:${key}`,
      usedIds: new Set(),
    });
    check('a newer edit brings its sites', JSON.stringify(plan?.accounts[0]?.sites) === '["github.com"]', JSON.stringify(plan?.accounts[0]));
    const cleared = planCloudMerge({
      local: [{ ...GITHUB, sites: ['github.com'], updatedAt: 5_000 }],
      localDeleted: {},
      remotes: [{ accounts: [{ ...GITHUB, id: 'x', updatedAt: 6_000 }], deleted: {} }],
      seedKey,
      hashOf: key => `h:${key}`,
      usedIds: new Set(),
    });
    check('and a newer edit that removed them removes them', cleared !== null && !('sites' in cleared.accounts[0]));
  }

  await resetState();
}
