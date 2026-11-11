// The lock and its setup as the host around this interface draws them. The
// iPhone app (mobile/src/passcode) puts its own there: Face ID or Touch ID
// with a 6-digit passcode typed on a keypad, the way phone authenticators
// lock, where the extension has a typed password. The vault underneath is the
// same (utils/vault.ts): the passcode is its password. The extension and the
// Mac app register nothing and draw their own.
//
// A store with listeners: whether there is anything to offer changes after
// the screen is up (Face ID linked or not, found out from the device).

import { useSyncExternalStore, type ComponentType } from 'react';
import type { Language } from '@/utils/i18n';

export interface HostLockScreenProps {
  language: Language;
  onUnlock: (password: string) => Promise<void>;
  onRecovered: () => void;
}

export interface HostSetupProps {
  language: Language;
  onClose: () => void;
  onEnabled: () => void;
}

export interface HostSettingsProps {
  language: Language;
  enabled: boolean;
  autoLockMinutes: number;
  onEnableClick: () => void;
  onChanged: () => void;
  onLock: () => void;
  onAutoLockChange: (minutes: number) => void;
}

export interface HostVault {
  LockScreen: ComponentType<HostLockScreenProps>;
  Setup: ComponentType<HostSetupProps>;
  Settings: ComponentType<HostSettingsProps>;
  /**
   * Whether protection is worth offering now — the strip over the list, the
   * server's vault banner, the bell's. In the extension that is "the vault is
   * off"; on a phone also "on, but Face ID is not".
   */
  offers: boolean;
  /** The offer's words, in place of "Set a password". */
  offerText: () => { title: string; text: string; cta: string };
  /** Accounts before the strip shows (the extension waits for two). */
  minAccounts: number;
}

let host: HostVault | null = null;
/** Raised by the host to have the interface open its setup (`Setup`): its own offer's "Turn on". */
let setupRequests = 0;
const listeners = new Set<() => void>();

function notify(): void {
  for (const listener of listeners) listener();
}

export function setHostVault(next: HostVault | null): void {
  host = next;
  notify();
}

/**
 * Open the setup from outside the interface. Through the interface, not
 * beside it: turning the vault on rewrites the accounts it has on screen, and
 * only it knows to read them again.
 */
export function requestHostSetup(): void {
  setupRequests++;
  notify();
}

export function useHostSetupRequests(): number {
  return useSyncExternalStore(subscribe, () => setupRequests);
}

/** Change what is on offer without replacing the screens. */
export function setHostVaultOffers(offers: boolean): void {
  if (!host || host.offers === offers) return;
  setHostVault({ ...host, offers });
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => listeners.delete(listener);
}

/** The host's lock, outside React: whether one is registered decides who locks on leaving. */
export function getHostVault(): HostVault | null {
  return host;
}

export function useHostVault(): HostVault | null {
  return useSyncExternalStore(subscribe, () => host);
}
