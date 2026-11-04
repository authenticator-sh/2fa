// A first-run row that the host around this interface adds to the chooser
// (EmptyStateGuide). The Mac app (desktop/src/desktop.ts) puts "In the Chrome
// extension" there when it finds the extension's accounts on the Mac: the
// screen that moves them is otherwise offered once, and after that only from
// the menu bar. The extension registers none.
//
// A store with listeners rather than a value read at render: the Mac app knows
// whether to offer the row only after looking through the browsers' profiles,
// which can finish after the chooser is on screen.

import { useSyncExternalStore } from 'react';

export interface HostRow {
  /** Where the codes are, in the words of the chooser's question. */
  label: () => string;
  /** What picking it will have the person do. */
  sub: () => string;
  run: () => void;
}

let row: HostRow | null = null;
const listeners = new Set<() => void>();

export function setHostRow(next: HostRow | null): void {
  row = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

export function useHostRow(): HostRow | null {
  return useSyncExternalStore(subscribe, () => row);
}
