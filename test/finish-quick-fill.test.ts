// A quick fill that has to go through our own window — the vault was locked,
// or the site named no single account — used to end with the code on the
// clipboard and the user pasting it into the field they had just right-clicked.
// The window now finishes the fill itself. These pin down that it does, and
// every way it must not: into a tab that has moved on, from a request long
// stale, twice from two windows, or for an account the site did not name.

import { areas, check, flush, resetState, scenario } from './harness';

const GITHUB: any = { id: 'g1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 };
const AWS: any = { id: 'a1', name: 'bob@example.com', issuer: 'Amazon Web Services', secret: 'KRSXG5CTMVRXEZLU', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 };
const ACCOUNTS = [GITHUB, AWS];
const PASSWORD = 'correct horse battery staple';

/** Mid-slot, so no fill waits out the last two seconds of a code. */
const NOW = Date.UTC(2026, 8, 29, 12, 0, 10);

const t = (key: string, ...args: (string | number)[]) => `${key}${args.length ? `:${args.join(',')}` : ''}`;

interface Injection {
  target: any;
  args: any;
}

export async function run(): Promise<void> {
  const realNow = Date.now;
  (Date as any).now = () => NOW;
  const chrome = (globalThis as any).chrome;

  // The tab the fill was asked for, and what it shows now.
  let tabUrl: string | undefined = 'https://github.com/login';
  let pageAnswer = 'filled';
  const injections: Injection[] = [];
  chrome.tabs = {
    async get(tabId: number) {
      if (tabId !== 7 || tabUrl === undefined) throw new Error('No tab with id: ' + tabId);
      return { id: tabId, url: tabUrl };
    },
  };
  chrome.scripting = {
    async executeScript({ target, args }: any) {
      injections.push({ target, args: args[0] });
      return [{ result: args[0].code === null ? 'shown' : pageAnswer }];
    },
  };

  try {
    const storage = await import('@/utils/storage');
    const vault = await import('@/utils/vault');
    const totp = await import('@/utils/totp');
    const pref = await import('@/utils/quick-fill');
    const finish = await import('@/utils/finish-quick-fill');
    const { runQuickFill } = await import('@/background/quick-fill');
    const request = () => areas.session[pref.FILL_REQUEST_KEY] as any;

    scenario('A locked vault leaves the fill for the window to finish');
    await resetState();
    await storage.saveAccounts(ACCOUNTS);
    await (await storage.prepareVault(PASSWORD)).commit();
    await flush();
    await vault.lock();
    injections.length = 0;
    await runQuickFill({ tabId: 7, frameId: 3, pageUrl: 'https://github.com/login' });
    check('the request is left in session storage', !!request(), JSON.stringify(request()));
    check('with the tab and frame', request()?.tabId === 7 && request()?.frameId === 3);
    check('marked as a lock, not a question', request()?.locked === true);
    check('and nowhere but session', !JSON.stringify(areas.local).includes('quickFillRequest'));
    check('no code went into the page while locked', injections.every(i => i.args.code === null));

    scenario('Unlocking finishes it');
    await vault.unlockWithPassword(PASSWORD);
    const accounts = await storage.getAccounts();
    injections.length = 0;
    const done = await finish.finishLockedFill(accounts, t as any);
    check('the fill ran', done?.outcome === 'filled', JSON.stringify(done));
    check('for the account the site names', done?.account.id === 'g1');
    check('into the right tab and frame', injections.length === 1 && injections[0].target.tabId === 7 &&
      JSON.stringify(injections[0].target.frameIds) === '[3]', JSON.stringify(injections.map(i => i.target)));
    check('with the current code', injections[0]?.args.code === totp.generateCodeAt(GITHUB, NOW));
    check('finding the field by its caret, not by page focus', injections[0]?.args.caretOnly === true);
    check('leaving the clipboard to the window', injections[0]?.args.clipboard === false);
    check('the request is used up', !request());
    injections.length = 0;
    check('a second window has nothing left to do', (await finish.finishLockedFill(accounts, t as any)) === null);
    check('and did nothing', injections.length === 0);

    // From here on the vault is out of the way: what is being tested is the
    // window's side, which is the same either way.
    await storage.disableVault(PASSWORD);
    await flush();

    scenario('Two windows unlocked at once fill the page once');
    await pref.noteFillRequest({ hostname: 'github.com', tabId: 7, locked: true });
    injections.length = 0;
    const [one, two] = await Promise.all([
      finish.finishLockedFill(ACCOUNTS, t as any),
      finish.finishLockedFill(ACCOUNTS, t as any),
    ]);
    check('exactly one of them filled', [one, two].filter(Boolean).length === 1, JSON.stringify([one, two]));
    check('one injection', injections.length === 1, String(injections.length));
    check('the shortcut has no frame, so every frame is asked', injections[0]?.target.allFrames === true);

    scenario('Nothing goes into a tab that has moved on');
    await pref.noteFillRequest({ hostname: 'github.com', tabId: 7, locked: true });
    tabUrl = 'https://evil.example/login';
    injections.length = 0;
    const moved = await finish.finishLockedFill(ACCOUNTS, t as any);
    check('another site in the tab: no fill', moved?.outcome === null, JSON.stringify(moved));
    check('nothing injected', injections.length === 0);

    await pref.noteFillRequest({ hostname: 'github.com', tabId: 7, locked: true });
    tabUrl = undefined;
    const closed = await finish.finishLockedFill(ACCOUNTS, t as any);
    check('the tab gone: no fill', closed?.outcome === null && injections.length === 0);
    tabUrl = 'https://github.com/login';

    scenario('A request that has gone stale is not acted on');
    await pref.noteFillRequest({ hostname: 'github.com', tabId: 7, locked: true });
    (Date as any).now = () => NOW + 3 * 60 * 1000;
    const stale = await finish.finishLockedFill(ACCOUNTS, t as any);
    const stalePick = await finish.finishPickedFill(GITHUB, t as any);
    (Date as any).now = () => NOW;
    check('three minutes later, not after an unlock', stale === null);
    check('nor after a pick', stalePick === null);
    check('nothing injected', injections.length === 0);

    scenario('A site that names no single account waits for the pick');
    await pref.noteFillRequest({ hostname: 'example.org', tabId: 7, locked: true });
    tabUrl = 'https://example.org/2fa';
    const unsure = await finish.finishLockedFill(ACCOUNTS, t as any);
    check('the unlock does not guess', unsure === null && injections.length === 0);
    check('the request stays for the pick', !!request());
    const picked = await finish.finishPickedFill(AWS, t as any);
    check('the pick fills it', picked === 'filled', String(picked));
    check('with the picked account\'s code', injections[0]?.args.code === totp.generateCodeAt(AWS, NOW));
    check('and uses it up', !request());
    injections.length = 0;
    check('a later copy fills nothing', (await finish.finishPickedFill(AWS, t as any)) === null && injections.length === 0);
    tabUrl = 'https://github.com/login';

    scenario('A question, not a lock, is never answered by the unlock');
    await pref.noteFillRequest({ hostname: 'github.com', tabId: 7, locked: false });
    check('the unlock leaves it alone', (await finish.finishLockedFill(ACCOUNTS, t as any)) === null && injections.length === 0);
    check('and it is still there for the pick', !!request());
    await pref.takeFillRequest();

    scenario('A page with no field tells the window to copy instead');
    await pref.noteFillRequest({ hostname: 'github.com', tabId: 7, locked: true });
    pageAnswer = 'missed';
    const miss = await finish.finishLockedFill(ACCOUNTS, t as any);
    check('the window hears it was missed', miss?.outcome === 'missed', JSON.stringify(miss));
    pageAnswer = 'filled';

    scenario('A site with no question leaves a question-free request');
    injections.length = 0;
    await runQuickFill({ tabId: 7, pageUrl: 'https://unknown-site.example/verify' });
    check('handing over for a question records it as one', request()?.locked === false, JSON.stringify(request()));
  } finally {
    (Date as any).now = realNow;
    delete chrome.tabs;
    delete chrome.scripting;
  }
}
