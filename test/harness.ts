// Minimal test harness: in-memory chrome.storage and IndexedDB so the storage
// and vault modules can run under Node exactly as they do in the browser.
//
// Install the mocks BEFORE importing anything from src/ — those modules read
// `chrome` at call time but the import graph is easier to reason about if the
// globals are already in place.

type Store = Record<string, any>;

export const areas = { local: {} as Store, sync: {} as Store, session: {} as Store };
export let backupRows: any[] = [];

/**
 * Fault injection.
 *
 * The failures that matter here are the ones the browser produces and we never
 * see in development: IndexedDB refusing to open on a profile with site data
 * blocked, a storage write rejected by quota. Both have already cost users their
 * accounts, so both need to be reachable from a test.
 */
export const faults = {
  /** `indexedDB.open` fires onerror instead of onsuccess. */
  indexedDB: false,
  /** `chrome.storage.local.set` rejects for any write touching this key. */
  failLocalSetFor: null as string | null,
  /** `chrome.storage.local.get` rejects when this key is requested. */
  failLocalGetFor: null as string | null,
  /** `chrome.storage.sync.set` rejects, as it does when a value is over quota. */
  failSyncSet: false,
};

export function resetFaults(): void {
  faults.indexedDB = false;
  faults.failLocalSetFor = null;
  faults.failLocalGetFor = null;
  faults.failSyncSet = false;
}

// chrome.storage accepts either a callback or returns a promise, and the source
// uses both styles depending on the module. A mock that only honours one of
// them leaves the other caller awaiting forever.
/**
 * Listeners registered through chrome.storage.onChanged.
 *
 * Real Chrome fires these on every write, and the popup now depends on them: a
 * passkey ceremony runs in another context, so the only way a live popup learns
 * it was unlocked is a change event. Without emission here that wiring would be
 * untestable, which is how it shipped broken the first time.
 */
type ChangeListener = (changes: Record<string, { oldValue?: unknown; newValue?: unknown }>, areaName: string) => void;
const changeListeners: ChangeListener[] = [];

function emitChanges(
  name: 'local' | 'sync' | 'session',
  changes: Record<string, { oldValue?: unknown; newValue?: unknown }>
): void {
  if (Object.keys(changes).length === 0) return;
  for (const listener of [...changeListeners]) {
    setTimeout(() => listener(changes, name), 0);
  }
}

function makeArea(store: Store, name: 'local' | 'sync' | 'session') {
  const settle = <T>(value: T, callback?: (value: T) => void): Promise<T> => {
    if (callback) {
      setTimeout(() => callback(value), 0);
    }
    return Promise.resolve(value);
  };

  const rejectionFor = (obj: Store): Error | null => {
    if (name === 'local' && faults.failLocalSetFor && faults.failLocalSetFor in obj) {
      return new Error(`Simulated failure writing ${faults.failLocalSetFor}`);
    }
    if (name === 'sync' && faults.failSyncSet) {
      return new Error('QUOTA_BYTES_PER_ITEM quota exceeded');
    }
    return null;
  };

  return {
    get(keys: string | string[] | null | undefined, callback?: (items: Store) => void) {
      if (
        name === 'local' &&
        faults.failLocalGetFor &&
        (Array.isArray(keys) ? keys : [keys]).includes(faults.failLocalGetFor)
      ) {
        return Promise.reject(new Error(`Simulated failure reading ${faults.failLocalGetFor}`));
      }
      // null/undefined means "everything", which is how the source enumerates
      // the sync chunks. Treating it as a key name made every chunked read and
      // every cleanup silently return nothing.
      if (keys === null || keys === undefined) {
        return settle({ ...store }, callback);
      }
      const wanted = Array.isArray(keys) ? keys : [keys];
      const items: Store = {};
      for (const key of wanted) {
        if (key in store) items[key] = store[key];
      }
      return settle(items, callback);
    },
    set(obj: Store, callback?: () => void) {
      const rejection = rejectionFor(obj);
      if (rejection) return Promise.reject(rejection);
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const key of Object.keys(obj)) {
        changes[key] = { oldValue: store[key], newValue: obj[key] };
      }
      Object.assign(store, obj);
      emitChanges(name, changes);
      return settle(undefined as void, callback);
    },
    remove(keys: string | string[], callback?: () => void) {
      const changes: Record<string, { oldValue?: unknown; newValue?: unknown }> = {};
      for (const key of Array.isArray(keys) ? keys : [keys]) {
        if (key in store) changes[key] = { oldValue: store[key], newValue: undefined };
        delete store[key];
      }
      emitChanges(name, changes);
      return settle(undefined as void, callback);
    },
  };
}

const later = (fn: () => void) => setTimeout(fn, 0);

export function installMocks(): void {
  (globalThis as any).chrome = {
    storage: {
      local: makeArea(areas.local, 'local'),
      sync: makeArea(areas.sync, 'sync'),
      session: makeArea(areas.session, 'session'),
      onChanged: {
        addListener(listener: ChangeListener) {
          changeListeners.push(listener);
        },
        removeListener(listener: ChangeListener) {
          const at = changeListeners.indexOf(listener);
          if (at >= 0) changeListeners.splice(at, 1);
        },
      },
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };

  (globalThis as any).indexedDB = {
    open() {
      const request: any = {};
      if (faults.indexedDB) {
        later(() => {
          request.error = new Error('Simulated IndexedDB failure');
          request.onerror?.();
        });
        return request;
      }
      later(() => {
        request.result = {
          objectStoreNames: { contains: () => true },
          createObjectStore: () => ({ createIndex: () => {} }),
          close() {},
          transaction() {
            const tx: any = {};
            const store = {
              add(value: any) {
                const r: any = {};
                backupRows.push(value);
                later(() => {
                  r.onsuccess?.();
                  tx.oncomplete?.();
                });
                return r;
              },
              getAll() {
                const r: any = { result: [...backupRows] };
                later(() => r.onsuccess?.());
                return r;
              },
              get(id: string) {
                const r: any = { result: backupRows.find(x => x.id === id) };
                later(() => r.onsuccess?.());
                return r;
              },
              delete(id: string) {
                backupRows = backupRows.filter(x => x.id !== id);
              },
              clear() {
                backupRows = [];
              },
            };
            tx.objectStore = () => store;
            later(() => tx.oncomplete?.());
            return tx;
          },
        };
        request.onsuccess?.();
      });
      return request;
    },
  };
}

/**
 * Let fire-and-forget work settle. Writes to chrome.storage.sync are
 * deliberately not awaited by saveAccounts — a quota rejection must not fail
 * the local save — so assertions about sync need to yield first.
 */
export async function flush(): Promise<void> {
  // A sync push is several awaits deep (enabled check, chunk write, stale-key
  // cleanup), so one turn of the loop is not enough to see it land.
  for (let i = 0; i < 10; i++) {
    await new Promise(resolve => setTimeout(resolve, 0));
  }
}

/** Every sync key currently holding accounts, chunked or legacy. */
export function syncAccountKeys(): string[] {
  return Object.keys(areas.sync).filter(key => key.startsWith('authenticator_accounts'));
}

/**
 * Present this profile as one that has already seen chrome.storage.sync work.
 *
 * Storage holds pushes back while the sync area is empty AND has never been
 * observed to hold anything, because on a real profile that state is
 * indistinguishable from "the download has not arrived yet" — and writing into
 * it replaces the cloud copy. Scenarios about an existing install would
 * otherwise all be testing the first-run hold instead of what they are about.
 *
 * Scenarios that DO want the fresh-profile behaviour skip this (see
 * `resetStateFreshProfile`).
 */
export function markSyncEstablished(): void {
  areas.local.syncObserved = true;
}

/** Wipe all persisted state between scenarios so they cannot leak into each other. */
export async function resetState(): Promise<void> {
  await resetStateFreshProfile();
  markSyncEstablished();
}

/** As `resetState`, but leaves the profile looking newly installed. */
export async function resetStateFreshProfile(): Promise<void> {
  for (const store of Object.values(areas)) {
    for (const key of Object.keys(store)) delete store[key];
  }
  backupRows = [];
  resetFaults();
  const { clearKeyCache } = await import('@/utils/vault');
  clearKeyCache();
  const { resetQuarantine } = await import('@/utils/storage');
  resetQuarantine();
}

export function setBackupRows(rows: any[]): void {
  backupRows = rows;
}

// --- assertions -----------------------------------------------------------

let failures = 0;
let currentScenario = '';

export function scenario(name: string): void {
  currentScenario = name;
  console.log(`\n${name}`);
}

export function check(description: string, condition: boolean, detail = ''): void {
  if (condition) {
    console.log(`  ok   ${description}`);
  } else {
    failures++;
    console.log(`  FAIL ${description}${detail ? ` — ${detail}` : ''}`);
  }
}

export async function throwsNamed(name: string, fn: () => Promise<unknown>): Promise<boolean> {
  try {
    await fn();
    return false;
  } catch (error: any) {
    return error?.name === name;
  }
}

export function failureCount(): number {
  return failures;
}

export function currentScenarioName(): string {
  return currentScenario;
}
