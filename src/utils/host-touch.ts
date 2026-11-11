// What a touch-screen host asks of this interface (the iPhone app,
// mobile/src/ios.ts and touch.ts). The extension and the Mac app register
// nothing and behave as they always have.
//
//   • The + button opens a menu where the finger is — scan a QR code, or type
//     a setup key — as phone authenticators do, instead of a full screen with
//     every way in.
//   • A row swiped sideways offers Edit and Delete: the host draws the swipe,
//     and asks the interface to edit or delete the account, through its own
//     paths (the delete asks first).

import { useSyncExternalStore } from 'react';

/** The + button's menu, in the host's words. */
export interface HostAddMenu {
  scan: () => string;
  key: () => string;
}

let addMenu: HostAddMenu | null = null;
const listeners = new Set<() => void>();

export function setHostAddMenu(menu: HostAddMenu | null): void {
  addMenu = menu;
  for (const listener of listeners) listener();
}

export function useHostAddMenu(): HostAddMenu | null {
  return useSyncExternalStore(
    listener => {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
    () => addMenu
  );
}

export interface AccountActions {
  edit: (id: string) => void;
  remove: (id: string) => void;
}

let actions: AccountActions | null = null;

/** The interface's ways to edit and delete an account, while it is showing the list. */
export function provideAccountActions(next: AccountActions | null): void {
  actions = next;
}

export function accountActions(): AccountActions | null {
  return actions;
}
