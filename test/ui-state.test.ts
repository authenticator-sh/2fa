// The decisions the popup makes about what to put on screen.
//
// Each of these was wrong in a way a user reported or would have: a search typo
// answered with "you need a different password", an invalid key the edit
// screen would not let anyone fix, settings that disagreed between two open
// windows, a record with `issuer: null` crashing the popup at the first
// keystroke. The React around them is thin; the rules are here.

import { areas, check, resetState, scenario } from './harness';

const GOOD = 'JBSWY3DPEHPK3PXP';
const OTHER = 'KRSXG5CTMVRXEZLU';

export async function run(): Promise<void> {
  const { chooseListView, matchesSearch } = await import('@/utils/list-view');
  const { checkReplacementSecret, needsNewSecret } = await import('@/utils/secret-edit');
  const { settingsFromChanges } = await import('@/utils/settings-watch');
  const { resolveLanguage } = await import('@/utils/i18n');
  const { saveErrorKey } = await import('@/utils/save-error');
  const { VaultLockedError } = await import('@/utils/vault');

  scenario('A search with no results says so, whatever else is wrong');
  {
    const base = { loading: false, total: 12, shown: 0, failed: false, held: 0 };
    check('plain case: no results', chooseListView(base) === 'noResults');
    check(
      'one record held from another vault does not turn a typo into "need a different password"',
      chooseListView({ ...base, held: 1 }) === 'noResults'
    );
    check(
      'a list recovered from the automatic backup still answers a search with "no results"',
      chooseListView({ ...base, failed: true }) === 'noResults'
    );
    check('rows to show are shown', chooseListView({ ...base, shown: 3, held: 2, failed: true }) === 'list');
    check('loading wins over everything', chooseListView({ ...base, loading: true }) === 'loading');
    check(
      'nothing readable and records held: the unavailable panel, not the setup guide',
      chooseListView({ ...base, total: 0, held: 4 }) === 'unavailable'
    );
    check('nothing readable after a failed read: unavailable', chooseListView({ ...base, total: 0, failed: true }) === 'unavailable');
    check('a new user gets the setup guide', chooseListView({ ...base, total: 0 }) === 'empty');
  }

  scenario('Search reads records from older builds without throwing');
  {
    const legacy = { name: 'GitHub', issuer: null } as any;
    let threw = false;
    let matched = false;
    try {
      matched = matchesSearch(legacy, 'git');
      matchesSearch({ name: undefined, issuer: 'Google' } as any, 'goo');
    } catch {
      threw = true;
    }
    check('issuer: null does not throw', !threw);
    check('and the name still matches', matched);
    check('case-insensitive on the issuer', matchesSearch({ name: 'x', issuer: 'Amazon' }, 'AMA'));
    check('an unrelated query does not match', !matchesSearch({ name: 'x', issuer: 'Amazon' }, 'zzz'));
  }

  await resetState();
  scenario('Suggestions survive a record with no issuer');
  {
    const { getSuggestedAccountId } = await import('@/utils/suggestions');
    const accounts: any[] = [
      { id: 'n', name: 'Mail', issuer: null, secret: OTHER, createdAt: 1 },
      { id: 'g', name: 'me', issuer: 'GitHub', secret: GOOD, createdAt: 2 },
    ];
    let result: string | null = null;
    let threw = false;
    try {
      result = await getSuggestedAccountId('github.com', accounts);
    } catch {
      threw = true;
    }
    check('no throw', !threw);
    check('the good account is still suggested', result === 'g', String(result));
  }

  scenario('An invalid key can be replaced from the edit screen');
  {
    check('a key otpauth cannot use is offered for editing', needsNewSecret({ secret: 'not a key!' }));
    check('a non-string key is offered for editing', needsNewSecret({ secret: 42 as any }));
    check('a working key stays read-only', !needsNewSecret({ secret: GOOD }));

    const others = [
      { id: 'broken', secret: 'not a key!' },
      { id: 'other', secret: OTHER },
    ];
    const ok = checkReplacementSecret(' jbsw-y3dp ehpk-3pxp ', 'broken', others);
    check('grouped, lowercase input is cleaned like the add form does', 'secret' in ok && ok.secret === GOOD);

    const bad = checkReplacementSecret('ABC', 'broken', others);
    check('too short a key is refused with the add form\'s message', 'error' in bad && bad.error === 'addAccount.errorInvalidSecret');
    const junk = checkReplacementSecret('1234567890123456', 'broken', others);
    check('non-base32 is refused', 'error' in junk && junk.error === 'addAccount.errorInvalidSecret');
    const empty = checkReplacementSecret('   ', 'broken', others);
    check('blank is refused', 'error' in empty);

    const dup = checkReplacementSecret(OTHER.toLowerCase() + '==', 'broken', others);
    check(
      'a key another account holds is refused — storage would fold the two rows into one',
      'error' in dup && dup.error === 'edit.secretDuplicate'
    );
    const self = checkReplacementSecret(OTHER, 'other', others);
    check('an account is not a duplicate of itself', 'secret' in self);
  }

  await resetState();
  scenario('The replacement key reaches storage and produces codes');
  {
    const storage = await import('@/utils/storage');
    const { isUsableSecret } = await import('@/utils/totp');
    areas.local['authenticator_accounts'] = [
      { id: 'b', name: 'Bank', issuer: 'Bank', secret: 'N0T-A-K3Y!', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 },
      { id: 'o', name: 'Other', issuer: 'Other', secret: OTHER, algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 },
    ];
    const before = await storage.getAccounts();
    const broken = before.find(account => account.id === 'b');
    check('the broken record is listed', !!broken && needsNewSecret(broken));

    const checked = checkReplacementSecret(GOOD, 'b', before);
    if ('secret' in checked) await storage.updateAccount('b', { secret: checked.secret });
    const after = await storage.getAccounts();
    const fixed = after.find(account => account.id === 'b');
    check('same account, same id, now usable', !!fixed && isUsableSecret(fixed.secret) && fixed.secret === GOOD);
    check('its name is kept', fixed?.name === 'Bank');
    check('nothing else was lost', after.length === 2);
  }

  scenario('Settings changed in another window are picked up');
  {
    const local = (changes: Record<string, unknown>) =>
      settingsFromChanges(
        Object.fromEntries(Object.entries(changes).map(([key, newValue]) => [key, { newValue }])),
        'local'
      );

    check('the sync area is not read as settings', Object.keys(settingsFromChanges({ darkMode: { newValue: true } }, 'sync')).length === 0);
    check('an unrelated key yields nothing', Object.keys(local({ authenticator_accounts: [] })).length === 0);
    check('language', local({ language: 'ru' }).language === 'ru');
    check('a removed language falls back to the browser\'s', local({ language: undefined }).language === resolveLanguage(undefined));
    check('an unknown language code is not applied', local({ language: 'xx' }).language === resolveLanguage(undefined));
    check('dark mode on', local({ darkMode: true }).darkMode === true);
    check('dark mode removed means off', local({ darkMode: undefined }).darkMode === false);
    check('the other style', local({ uiStyle: 'apple' }).uiStyle === 'apple');
    check('a removed style means classic', local({ uiStyle: undefined }).uiStyle === 'classic');
    check('an unknown style means classic', local({ uiStyle: 'neon' }).uiStyle === 'classic');
    check('view mode', local({ viewMode: 'compact' }).viewMode === 'compact');
    check('a junk view mode falls back to normal', local({ viewMode: 'huge' }).viewMode === 'normal');
    check('avatars', local({ showAvatars: true }).showAvatars === true);
    check('a junk popup size is ignored', !('popupSize' in local({ popupSize: 'giant' })));
    check('popup size', local({ popupSize: 'large' }).popupSize === 'large');
    check('open mode', local({ openMode: 'sidepanel' }).openMode === 'sidepanel');
    check('sync off', local({ syncEnabled: false }).syncEnabled === false);
    check('sync key removed means the default, on', local({ syncEnabled: undefined }).syncEnabled === true);
    check('sync overflow is followed', local({ syncOverflow: true }).syncOverflow === true);
    check('quick fill off', local({ quickFillEnabled: false }).quickFill === false);
    check('suggestions off', local({ suggestionsEnabled: false }).suggestions === false);
  }

  scenario('Every page opens in the language chosen in the popup');
  {
    check('a stored language wins', resolveLanguage('uk') === 'uk');
    check('a stored code we do not ship is no choice', resolveLanguage('klingon') === resolveLanguage(null));
    check('a non-string is no choice', resolveLanguage(7) === resolveLanguage(null));
  }

  scenario('A failed scan save is kept as a key, not a sentence');
  {
    check('a locked vault says to unlock', saveErrorKey(new VaultLockedError()) === 'restore.locked');
    check('anything else is the generic save failure', saveErrorKey(new Error('Refusing to save 12 accounts over 22')) === 'addAccount.errorSaveFailed');
  }

  scenario('New strings carry their placeholder in every language');
  {
    const langs = ['ar', 'de', 'en', 'es', 'fr', 'hi', 'id', 'it', 'ja', 'ko', 'nl', 'pl', 'pt', 'ru', 'sv', 'th', 'tr', 'uk', 'vi', 'zh'];
    const missing: string[] = [];
    for (const lang of langs) {
      const strings = (await import(`../src/utils/locales/${lang}.ts`)).default as Record<string, string>;
      if (!strings['scan.cameraN']?.includes('{0}')) missing.push(lang);
    }
    check('"Camera {0}" keeps its number everywhere', missing.length === 0, missing.join(', '));
  }
}
