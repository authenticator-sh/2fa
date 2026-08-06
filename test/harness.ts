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
      Object.assign(store, obj);
      return settle(undefined as void, callback);
    },
    remove(keys: string | string[], callback?: () => void) {
      for (const key of Array.isArray(keys) ? keys : [keys]) delete store[key];
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

/** Wipe all persisted state between scenarios so they cannot leak into each other. */
export async function resetState(): Promise<void> {
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
