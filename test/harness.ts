// Minimal test harness: in-memory chrome.storage and IndexedDB so the storage
// and vault modules can run under Node exactly as they do in the browser.
//
// Install the mocks BEFORE importing anything from src/ — those modules read
// `chrome` at call time but the import graph is easier to reason about if the
// globals are already in place.

type Store = Record<string, any>;

export const areas = { local: {} as Store, sync: {} as Store, session: {} as Store };
export let backupRows: any[] = [];

// chrome.storage accepts either a callback or returns a promise, and the source
// uses both styles depending on the module. A mock that only honours one of
// them leaves the other caller awaiting forever.
function makeArea(store: Store) {
  const settle = <T>(value: T, callback?: (value: T) => void): Promise<T> => {
    if (callback) {
      setTimeout(() => callback(value), 0);
    }
    return Promise.resolve(value);
  };

  return {
    get(keys: string | string[], callback?: (items: Store) => void) {
      const wanted = Array.isArray(keys) ? keys : [keys];
      const items: Store = {};
      for (const key of wanted) {
        if (key in store) items[key] = store[key];
      }
      return settle(items, callback);
    },
    set(obj: Store, callback?: () => void) {
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
      local: makeArea(areas.local),
      sync: makeArea(areas.sync),
      session: makeArea(areas.session),
    },
    runtime: { getManifest: () => ({ version: 'test' }) },
  };

  (globalThis as any).indexedDB = {
    open() {
      const request: any = {};
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
  await new Promise(resolve => setTimeout(resolve, 0));
}

/** Wipe all persisted state between scenarios so they cannot leak into each other. */
export async function resetState(): Promise<void> {
  for (const store of Object.values(areas)) {
    for (const key of Object.keys(store)) delete store[key];
  }
  backupRows = [];
  const { clearKeyCache } = await import('@/utils/vault');
  clearKeyCache();
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
