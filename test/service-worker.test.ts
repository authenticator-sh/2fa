// The service worker's own listeners, driven the way Chrome drives them.
//
// What these pin down is timing rather than logic: which call happens inside
// the user's gesture and which after it, which of two overlapping runs wins,
// which event raises the dot. None of it is visible in a unit that is simply
// awaited, so the worker module is loaded whole against a browser that
// enforces the rules that broke it — `sidePanel.open` refused once the
// listener's synchronous run is over, a menu that rejects a duplicate id.

import { areas, check, dropStorageListenersAfter, flush, resetState, scenario, storageListenerCount, withLatency } from './harness';

type Listener = (...args: any[]) => unknown;
const listeners: Record<string, Listener[]> = {};
const event = (name: string) => ({
  addListener: (fn: Listener) => {
    (listeners[name] = listeners[name] || []).push(fn);
  },
  removeListener() {},
  hasListener: () => false,
});

/**
 * Chrome's notion of a user action in a service worker: the listener's own
 * synchronous run and nothing after it. Every listener for the event runs
 * inside it; anything they defer runs outside.
 */
let inGesture = false;
function dispatch(name: string, ...args: unknown[]): void {
  inGesture = true;
  try {
    for (const fn of listeners[name] || []) fn(...args);
  } finally {
    inGesture = false;
  }
}

const panelOpens: unknown[] = [];
const panelRefusals: unknown[] = [];
const windowsCreated: unknown[] = [];
const injected: any[] = [];
const menu = new Map<string, any>();
let duplicateIds = 0;

/** How the page answers an injection; replaced per scenario. */
let answer: (target: any, args: any) => string = () => 'filled';

function installWorkerMocks(): void {
  const c = (globalThis as any).chrome;
  Object.assign(c.runtime, {
    onInstalled: event('runtime.onInstalled'),
    onStartup: event('runtime.onStartup'),
    onMessage: event('runtime.onMessage'),
    setUninstallURL() {},
    getURL: (path: string) => `chrome-extension://test/${path}`,
    sendMessage: async () => undefined,
  });
  c.tabs = { create: async () => ({}) };
  c.contextMenus = {
    onClicked: event('contextMenus.onClicked'),
    // Asynchronous like the real one, so two syncs can interleave around it.
    removeAll: () => new Promise<void>((resolve) => setTimeout(() => { menu.clear(); resolve(); }, 1)),
    create(item: any) {
      if (menu.has(item.id)) duplicateIds += 1;
      menu.set(item.id, item);
    },
  };
  c.commands = { onCommand: event('commands.onCommand') };
  c.action = {
    onClicked: event('action.onClicked'),
    setPopup: async () => {},
    setBadgeText: async () => {},
    setBadgeBackgroundColor: async () => {},
    openPopup: async () => { throw new Error('No popup'); },
  };
  c.sidePanel = {
    setPanelBehavior: async () => {},
    open: async (options: unknown) => {
      if (!inGesture) {
        panelRefusals.push(options);
        throw new Error('`sidePanel.open()` may only be called in response to a user gesture.');
      }
      panelOpens.push(options);
    },
  };
  c.windows = {
    onRemoved: event('windows.onRemoved'),
    onBoundsChanged: event('windows.onBoundsChanged'),
    getLastFocused: async () => ({ id: 3 }),
    getCurrent: async () => ({ id: 3 }),
    get: async () => { throw new Error('No window'); },
    create: async (options: unknown) => { windowsCreated.push(options); return { id: 99 }; },
  };
  c.scripting = {
    async executeScript({ target, args }: any) {
      injected.push({ target, args: args[0] });
      return [{ result: answer(target, args[0]) }];
    },
  };
}

/** performance.now, not Date.now: some scenarios pin the wall clock. */
async function until(condition: () => boolean, ms = 3000): Promise<boolean> {
  const deadline = performance.now() + ms;
  while (!condition()) {
    if (performance.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
  return true;
}

function clearRecords(): void {
  panelOpens.length = 0;
  panelRefusals.length = 0;
  windowsCreated.length = 0;
  injected.length = 0;
}

const GITHUB: any = { id: 'a1', name: 'alice@example.com', issuer: 'GitHub', secret: 'JBSWY3DPEHPK3PXP', algorithm: 'SHA1', digits: 6, period: 30, createdAt: 1 };

export async function run(): Promise<void> {
  installWorkerMocks();
  const realFetch = (globalThis as any).fetch;
  // No network in the checks: a time source that fails fast leaves the local
  // clock in charge, which is all quick fill needs here.
  (globalThis as any).fetch = async () => { throw new Error('offline'); };

  const listenersBefore = storageListenerCount();
  try {
    await resetState();
    await import('@/background/service-worker');
    await flush();

    await runSidePanel();
    await runMenuSync();
    await runFrameFallback();
    await runBilling();
  } finally {
    // The worker is gone once its suite is over, as it is when Chrome stops it.
    dropStorageListenersAfter(listenersBefore);
    // What its listeners had already started (a billing check-in after an
    // account write) finishes against the offline fetch, not a later suite's.
    await new Promise((resolve) => setTimeout(resolve, 100));
    await resetState();
    (globalThis as any).fetch = realFetch;
  }
}

async function runSidePanel(): Promise<void> {
  const storage = await import('@/utils/storage');
  await chrome.storage.local.set({ openMode: 'sidepanel' });
  await flush();

  scenario('Side panel mode: the toolbar icon, when its own toggle is off');
  clearRecords();
  dispatch('action.onClicked', { id: 7, windowId: 3, url: 'https://github.com/' });
  await flush();
  check('the panel opens, from inside the click', panelOpens.length === 1, JSON.stringify(panelOpens));
  check('rather than a floating window', windowsCreated.length === 0);

  scenario('Side panel mode: quick fill with a question that is certain');
  // The shortcut on a new tab: no address to match, so nothing can ever be
  // filled and the only useful thing is the app itself.
  clearRecords();
  dispatch('commands.onCommand', 'quick-fill', { id: 7, windowId: 3 });
  await until(() => panelOpens.length > 0 || injected.length > 0 || panelRefusals.length > 0);
  await flush();
  check('the panel opens', panelOpens.length === 1, JSON.stringify({ panelOpens, panelRefusals }));
  check('in the window the shortcut came from', (panelOpens[0] as any)?.windowId === 3);
  check('and no "open the extension" notice is put on the page', injected.every((call) => call.args.code !== null));

  scenario('Side panel mode: quick fill that simply works');
  // The common case must not be disturbed: a panel sliding open beside the
  // form on every fill is noise, and takes the focus the fill relies on.
  await storage.saveAccounts([GITHUB]);
  clearRecords();
  answer = () => 'filled';
  dispatch('commands.onCommand', 'quick-fill', { id: 7, windowId: 3, url: 'https://github.com/login' });
  const filled = await until(() => injected.length > 0);
  await flush();
  check('the code is filled', filled && typeof injected[0]?.args.code === 'string');
  check('and the panel is left alone', panelOpens.length === 0 && panelRefusals.length === 0);

  // Changes are followed without a restart of the worker.
  scenario('The mode the listeners act on follows the setting');
  await chrome.storage.local.set({ openMode: 'window' });
  await flush();
  clearRecords();
  dispatch('commands.onCommand', 'quick-fill', { id: 7, windowId: 3 });
  await until(() => windowsCreated.length > 0 || injected.length > 0);
  await flush();
  check('window mode does not open a panel', panelOpens.length === 0);
  check('it opens the floating window instead', windowsCreated.length === 1);

  await chrome.storage.local.set({ openMode: 'popup' });
  await flush();
  await resetState();
}

async function runMenuSync(): Promise<void> {
  const qf = await import('@/background/quick-fill');

  scenario('Menu syncs that overlap');
  // Real storage takes time, and two syncs in flight together used to run
  // removeAll, removeAll, create, create.
  const restore = withLatency(3);
  try {
    await chrome.storage.local.set({ quickFillEnabled: true });
    menu.clear();
    duplicateIds = 0;
    await Promise.all([qf.syncContextMenu(), qf.syncContextMenu()]);
    check('no duplicate id is created', duplicateIds === 0, String(duplicateIds));
    check('and there is exactly one item', menu.size === 1);

    // The toggle switched off while a sync that had already read "on" was
    // still on its way to create the item.
    const first = qf.syncContextMenu();
    await new Promise((resolve) => setTimeout(resolve, 5));
    areas.local.quickFillEnabled = false;
    const second = qf.syncContextMenu();
    await Promise.all([first, second]);
    check('switched off means no item, whatever was in flight', menu.size === 0, String(menu.size));
  } finally {
    restore();
  }
  await resetState();
}

async function runFrameFallback(): Promise<void> {
  const storage = await import('@/utils/storage');
  await storage.saveAccounts([GITHUB]);

  scenario('A right-click in a frame quick fill cannot enter');
  clearRecords();
  answer = (target) => {
    if (target.frameIds) throw new Error('Cannot access contents of the frame');
    return 'copied';
  };
  dispatch(
    'contextMenus.onClicked',
    { menuItemId: 'quick-fill', frameId: 5, pageUrl: 'https://github.com/login' },
    { id: 7, windowId: 3, url: 'https://github.com/login' }
  );
  await until(() => injected.length >= 2);
  await flush();
  const top = injected.find((call) => !call.target.frameIds);
  check('the top frame is asked instead', !!top);
  check('and may not pick a field of its own', top?.args.mayGuess === false, JSON.stringify(top?.args));
  answer = () => 'filled';
  await resetState();
}

async function runBilling(): Promise<void> {
  const state = await import('@/billing/state');
  const realFetch = (globalThis as any).fetch;
  let syncs = 0;
  (globalThis as any).fetch = async (url: unknown) => {
    if (String(url).endsWith('/v1/sync')) syncs += 1;
    throw new Error('offline');
  };
  try {
    scenario('Accounts from another computer that predate billing arrive after the install');
    await resetState();
    const install = await state.ensureInstall({ reason: 'install' });
    check('the install starts out new', !install.legacy);
    syncs = 0;
    // What a computer that never ran 1.14 left in sync, downloaded a moment later.
    await chrome.storage.sync.set({ authenticator_accounts_0: [{ ...GITHUB, id: 'old-1', createdAt: 1 }] });
    const turned = await until(() => areas.local.billingInstall?.legacy === true);
    check('it turns legacy when they arrive', turned && areas.local.billingInstall?.legacySrc === 'sync-accounts', JSON.stringify(areas.local.billingInstall));
    check('and tells the server at once', await until(() => syncs > 0));

    scenario('A page about to close asks the worker to send its billing events');
    await resetState();
    syncs = 0;
    let answered = false;
    const message = { type: 'authenticator:billing-sync' };
    dispatch('runtime.onMessage', message, { id: (chrome.runtime as any).id, url: 'https://example.com/' }, () => (answered = true));
    await flush();
    check('not for a web page', !answered && syncs === 0);
    dispatch('runtime.onMessage', message, { id: (chrome.runtime as any).id, url: 'chrome-extension://test/popup.html' }, () => (answered = true));
    check('the popup is answered', answered);
    check('and the check-in is made', await until(() => syncs === 1));
  } finally {
    (globalThis as any).fetch = realFetch;
    await new Promise((resolve) => setTimeout(resolve, 50));
    await resetState();
  }
}
