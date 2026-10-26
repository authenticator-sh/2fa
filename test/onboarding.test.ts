// The way to a first account (src/billing/onboarding.ts): what is reported,
// what the uninstall address says, and that none of it can carry an account.

import { areas, check, resetState, scenario } from './harness';

function clearBilling(): void {
  for (const key of Object.keys(areas.local)) if (key.startsWith('billing')) delete areas.local[key];
}

export async function run(): Promise<void> {
  const onboarding = await import('@/billing/onboarding');
  const events = await import('@/billing/events');
  const state = await import('@/billing/state');
  const { addWithLimit } = await import('@/billing/add');
  const storage = await import('@/utils/storage');

  const runtime = chrome.runtime as unknown as Record<string, unknown>;
  const realSet = runtime.setUninstallURL;
  const realSend = runtime.sendMessage;
  let uninstallUrl = '';
  const asked: unknown[] = [];
  runtime.setUninstallURL = (url: string) => {
    uninstallUrl = url;
  };
  runtime.sendMessage = async (message: unknown) => {
    asked.push(message);
    return true;
  };

  try {
    scenario('Kinds are cut to what the stage and the props allow');
    check('camelCase and dashes become snake_case', onboarding.slug('steam-encrypted') === 'steam_encrypted' && onboarding.slug('errorNoQr') === 'error_no_qr');
    check('a message key gives its last part', onboarding.reasonOfKey('addAccount.errorInvalidSecret') === 'error_invalid_secret');
    check('nothing usable is "unknown"', onboarding.slug('—') === 'unknown');
    check('at most 24 characters', onboarding.slug('a'.repeat(40)).length === 24);
    check('what an add wrote: a boolean add, a batch, a links import', onboarding.addedBy(true) === 1 && onboarding.addedBy(false) === 0 && onboarding.addedBy({ added: 3 }) === 3 && onboarding.addedBy({ kind: 'info' }) === 0 && onboarding.addedBy(null) === 0);

    scenario('The uninstall address carries the install and its stage');
    check('without an id, the bare page', onboarding.uninstallUrl(null, 'opened') === onboarding.UNINSTALL_FEEDBACK_URL);
    check('with one, the id and the stage', onboarding.uninstallUrl('abc', 'fail:qr:error_no_qr') === `${onboarding.UNINSTALL_FEEDBACK_URL}?i=abc&s=fail%3Aqr%3Aerror_no_qr`);
    check('no stage, no &s=', onboarding.uninstallUrl('abc') === `${onboarding.UNINSTALL_FEEDBACK_URL}?i=abc`);
    check('until an account, the latest step wins', onboarding.stageMayMove('fail:qr:x', 'pick:ga') && onboarding.stageMayMove(undefined, 'installed'));
    check('after one, only the first code moves it', !onboarding.stageMayMove('added:qr', 'fail:qr:duplicate') && onboarding.stageMayMove('added:qr', 'used'));
    check('and after that, nothing', !onboarding.stageMayMove('used', 'added:qr'));

    scenario('A new install reports each step at once, and the uninstall address follows it');
    {
      await resetState();
      clearBilling();
      const install = await state.ensureInstall({ reason: 'install' });
      await onboarding.markInstalled();
      check('a fresh install starts as "installed"', uninstallUrl.endsWith(`?i=${install.id}&s=installed`), uninstallUrl);

      asked.length = 0;
      await onboarding.reportFirstOpen();
      await onboarding.reportFirstOpen();
      let queued = await events.peekEvents();
      check('the first open is reported once', queued.filter(e => e.n === 'first_open').length === 1);
      check('with the seconds since install', typeof queued.find(e => e.n === 'first_open')?.p?.secs === 'number');
      check('and sent through the worker straight away', asked.length === 1);
      check('the stage is "opened"', uninstallUrl.endsWith('&s=opened'), uninstallUrl);

      await onboarding.reportOnboardView();
      await onboarding.reportOnboardView();
      await onboarding.reportOnboardView(true);
      queued = await events.peekEvents();
      check('the empty screen is reported once, and once more for the welcome page', queued.filter(e => e.n === 'onboard_view').length === 2 && queued.filter(e => e.n === 'onboard_view' && e.p?.site).length === 1);
      await onboarding.reportOnboardPick('ga');
      await onboarding.reportAddStep('guide', 'ga_go');
      await onboarding.reportAddFail('camera', 'camera_denied');
      check('a failure is the stage while there is no account', uninstallUrl.endsWith('&s=fail%3Acamera%3Acamera_denied'), uninstallUrl);
      await onboarding.reportOnboardView();
      check('back on the empty screen, the stage follows though no event is sent', uninstallUrl.endsWith('&s=onboard') && (await events.peekEvents()).filter(e => e.n === 'onboard_view').length === 2, uninstallUrl);
      check('steps a moment apart are not each a check-in', asked.length === 1, String(asked.length));

      // Half a minute on: past the short wait a first account gets.
      const kept = areas.local.billingOnboarding as { flushedAt: number };
      areas.local.billingOnboarding = { ...kept, flushedAt: kept.flushedAt - 30_000 };
      await storage.addAccount({ id: 'a1', name: 'n', issuer: 'i', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 } as never, { kind: 'import' });
      const added = await addWithLimit('form', origin =>
        storage.addAccount({ id: 'a2', name: 'n2', issuer: 'i2', secret: 'GEZDGNBVGY3TQOJQ', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 2 } as never, origin)
      );
      // Reported without being awaited by the add; give it its turn.
      await new Promise(resolve => setTimeout(resolve, 20));
      queued = await events.peekEvents();
      const accountAdded = queued.find(e => e.n === 'account_added');
      check('an add through the limit is counted', added === true && accountAdded?.p?.via === 'form' && accountAdded.p.n === 1 && accountAdded.p.first === true);
      check('the first account is a moment worth a check-in of its own', asked.length === 2, String(asked.length));
      check('the stage moves to added', uninstallUrl.endsWith('&s=added%3Aform'), uninstallUrl);

      await onboarding.reportAddFail('qr', 'duplicate');
      check('a later failure does not move it back', uninstallUrl.endsWith('&s=added%3Aform'), uninstallUrl);
      await onboarding.reportCodeUsed('copy');
      await onboarding.reportCodeUsed('fill');
      queued = await events.peekEvents();
      check('the first code is reported once', queued.filter(e => e.n === 'first_code').length === 1 && queued.find(e => e.n === 'first_code')?.p?.via === 'copy');
      check('and is the last stage', uninstallUrl.endsWith('&s=used'), uninstallUrl);

      const names = new Set(queued.map(e => e.n));
      check('every one of them made it into the queue', ['first_open', 'onboard_view', 'onboard_pick', 'add_step', 'add_fail', 'account_added', 'first_code'].every(n => names.has(n as never)));
      const json = JSON.stringify(queued);
      check('and nothing of an account is in it', !json.includes('JBSWY3DPEHPK3PXP') && !json.includes('GEZDGNBVGY3TQOJQ') && !json.includes('"n2"') && !json.includes('"i2"'));
    }

    scenario('An install updated from an older version has no first moments and no stage');
    {
      await resetState();
      clearBilling();
      await state.ensureInstall({ reason: 'install' });
      uninstallUrl = '';
      await onboarding.reportFirstOpen();
      await onboarding.reportOnboardPick('ga');
      await onboarding.reportCodeUsed('copy');
      const queued = await events.peekEvents();
      check('no first open or first code — the first after an update is not a first', !queued.some(e => e.n === 'first_open' || e.n === 'first_code'));
      check('the steps themselves are still reported', queued.some(e => e.n === 'onboard_pick'));
      check('and the uninstall address is not touched', uninstallUrl === '');
    }

    scenario('A followed install that is no longer new reports, but waits for its daily check-in');
    {
      await resetState();
      clearBilling();
      const install = await state.ensureInstall({ reason: 'install' });
      await onboarding.markInstalled();
      areas.local.billingInstall = { ...(areas.local.billingInstall as object), installedAt: Date.now() - 4 * 24 * 3_600_000, createdAt: Date.now() - 4 * 24 * 3_600_000 };
      asked.length = 0;
      await onboarding.reportFirstOpen();
      check('queued', (await events.peekEvents()).some(e => e.n === 'first_open'));
      check('not sent on its own', asked.length === 0);
      check('the uninstall address still follows', uninstallUrl.endsWith(`?i=${install.id}&s=opened`), uninstallUrl);
    }
    scenario("A check-in a moment ago — the install's own, the paywall's — counts as the send");
    {
      await resetState();
      clearBilling();
      await state.ensureInstall({ reason: 'install' });
      await onboarding.markInstalled();
      areas.local.billingLastSync = { at: Date.now() - 5_000, ok: true, nextAfterMs: 86_400_000 };
      asked.length = 0;
      await onboarding.reportFirstOpen();
      check('no second check-in on top of it', asked.length === 0);
      areas.local.billingLastSync = { at: Date.now() - 60_000, ok: true, nextAfterMs: 86_400_000 };
      await onboarding.reportCodeUsed('copy');
      check('a key moment a minute later goes', asked.length === 1, String(asked.length));
    }

    scenario('The first look at the empty screen: how long, and how it ended');
    {
      await resetState();
      clearBilling();
      await state.ensureInstall({ reason: 'install' });
      await onboarding.markInstalled();

      // A port pair, as Chrome makes one: what the page posts reaches the
      // worker's end, and either end dropping is the other's disconnect.
      type Listener = (value?: unknown) => void;
      type FakePort = { name: string; sender?: { id?: string; url?: string }; onMessage: { addListener: (f: Listener) => void }; onDisconnect: { addListener: (f: Listener) => void }; postMessage: (m: unknown) => void; disconnect: () => void };
      const extras = ['id', 'getURL', 'connect', 'onConnect'] as const;
      const saved = Object.fromEntries(extras.map(key => [key, runtime[key]]));
      let onConnect: ((port: FakePort) => void) | null = null;
      let senderUrl = 'chrome-extension://self/popup.html';
      let page: FakePort | null = null;
      runtime.id = 'self';
      runtime.getURL = (path: string) => `chrome-extension://self/${path}`;
      runtime.onConnect = { addListener: (fn: (port: FakePort) => void) => (onConnect = fn) };
      runtime.connect = ({ name }: { name: string }) => {
        const toPage = { message: [] as Listener[], gone: [] as Listener[] };
        const toWorker = { message: [] as Listener[], gone: [] as Listener[] };
        let open = true;
        const drop = (side: Listener[]) => () => {
          if (!open) return;
          open = false;
          side.forEach(f => f());
        };
        const worker: FakePort = {
          name,
          sender: { id: 'self', url: senderUrl },
          onMessage: { addListener: f => toWorker.message.push(f) },
          onDisconnect: { addListener: f => toWorker.gone.push(f) },
          postMessage: m => toPage.message.forEach(f => f(m)),
          disconnect: drop(toPage.gone),
        };
        page = {
          name,
          onMessage: { addListener: f => toPage.message.push(f) },
          onDisconnect: { addListener: f => toPage.gone.push(f) },
          postMessage: m => open && toWorker.message.forEach(f => f(m)),
          disconnect: drop(toWorker.gone),
        };
        onConnect?.(worker);
        return page;
      };
      const settle = () => new Promise(resolve => setTimeout(resolve, 20));
      const leaves = async () => (await events.peekEvents()).filter(e => e.n === 'onboard_leave');

      try {
        onboarding.registerOnboardScreen();
        onboarding.watchOnboardScreen();
        await settle();
        check('the page holds a port while the screen is up', page !== null);
        // The popup closing: Chrome drops the page's end.
        (page as FakePort | null)?.disconnect();
        await settle();
        let left = await leaves();
        check('a popup closed on the screen is reported as "close"', left.length === 1 && left[0].p?.end === 'close' && typeof left[0].p?.secs === 'number', JSON.stringify(left));
        check('without the welcome page’s mark', left[0]?.p?.site === undefined);

        page = null;
        onboarding.watchOnboardScreen();
        await settle();
        check('once reported, the next look holds no port', page === null);

        const stop = onboarding.watchOnboardScreen(true);
        await settle();
        await onboarding.reportOnboardPick('move');
        stop('away');
        await settle();
        left = await leaves();
        const fromSite = left.find(e => e.p?.site === true);
        check('a pick ends the welcome page’s look, with the way picked', left.length === 2 && fromSite?.p?.end === 'pick' && fromSite.p.option === 'move', JSON.stringify(left));

        clearBilling();
        await onboarding.markInstalled();
        const before = (await leaves()).length;
        senderUrl = 'https://example.com/';
        onboarding.watchOnboardScreen();
        await settle();
        (page as FakePort | null)?.disconnect();
        await settle();
        check('a port from outside the extension is not listened to', (await leaves()).length === before);

        await onboarding.reportOnboardLeave({ shownAt: Date.now() - 5 * 3_600_000, site: false, end: 'settings' });
        const forgotten = (await leaves()).slice(-1)[0];
        check('Settings is an end of its own, and a forgotten popup counts an hour at most', forgotten?.p?.end === 'settings' && forgotten.p.secs === 3_600, JSON.stringify(forgotten));
      } finally {
        for (const key of extras) runtime[key] = saved[key];
      }
    }
  } finally {
    runtime.setUninstallURL = realSet;
    runtime.sendMessage = realSend;
  }

  scenario('The page scan is offered only where a page could hold a setup QR code');
  {
    const { pageWorthScanning } = await import('@/utils/screen-capture');
    check('an ordinary site', pageWorthScanning('https://github.com/settings/security'));
    check('a local page', pageWorthScanning('http://localhost:3000/2fa'));
    check('not without an address — the welcome page opened the popup, nothing was granted', !pageWorthScanning(undefined));
    check('not on our welcome page', !pageWorthScanning('https://www.authenticator.sh/welcome'));
    check('not anywhere on our site', !pageWorthScanning('https://authenticator.sh/ru/faq'));
    check('not on a browser page', !pageWorthScanning('chrome://newtab/'));
    check('but a look-alike domain is someone else\'s page', pageWorthScanning('https://notauthenticator.sh/setup'));
  }
}
