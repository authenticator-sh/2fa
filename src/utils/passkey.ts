// The WebAuthn half of unlocking the vault with a passkey instead of a password.
//
// This module only runs ceremonies and returns bytes. It holds no key material
// and knows nothing about the vault; wrapping the master key with what comes
// back is vault.ts's job.
//
// Two facts about the environment shape everything here.
//
// 1. No new permission is required, and none is taken. An extension page may
//    claim a relying party id matching its own origin — `chrome-extension://<id>`
//    — without host permissions; claiming a *website's* RP id is what needs them.
//    So `rp.id` is deliberately left unset and the browser fills in our own
//    origin. Two permissions in the manifest is a selling point, and a passkey
//    that unlocks a local vault has no business asserting anyone's domain.
//
// 2. The ceremony cannot run in the popup. Chrome destroys the popup the moment
//    it loses focus, and the platform authenticator prompt — Touch ID, Windows
//    Hello, a phone over caBLE — takes focus by definition. The promise from
//    navigator.credentials dies with the page and the user sees the popup
//    vanish. Mozilla documents the same failure for extension popups. Callers
//    must therefore run these from a full extension page; src/passkey/ is that
//    page, opened in its own small window by openPasskeyCeremony below.
//
// PRF support is uneven across platforms in 2026 — solid on Android, Windows 11
// 25H2 and up, macOS 15+, iOS 18.4+, absent on Firefox for Android. Every entry
// point here reports "not available" rather than throwing, because the setting
// that offers this has to be able to hide itself.

import { fromBase64, toBase64 } from './crypto';

/** Salt for the PRF evaluation. Stored per vault, not secret. */
export const PRF_SALT_BYTES = 32;

// --- where the ceremony runs ----------------------------------------------

/** Roughly the popup's own footprint, so it reads as a dialog. */
const CEREMONY_WINDOW = { width: 440, height: 580 };

/**
 * Open the ceremony in its own browser window.
 *
 * A window rather than a tab because a tab is a heavier interruption for what is
 * a one-shot confirmation, and rather than the action popup because the popup
 * cannot host the ceremony at all: Chrome dismisses it the moment focus moves to
 * the authenticator prompt, and the prompt takes focus by definition — a
 * separate OS window for Windows Hello, browser-level UI for a passkey chooser.
 * Mozilla documents the same failure for extension popups.
 *
 * Neither `chrome.windows` nor `chrome.tabs` needs a permission for this; the
 * `tabs` permission only governs reading tab contents.
 */
export function openPasskeyCeremony(mode: 'register' | 'unlock'): void {
  const url = chrome.runtime.getURL(`passkey.html?mode=${mode}`);

  if (chrome.windows?.create) {
    chrome.windows.create({ url, type: 'popup', focused: true, ...CEREMONY_WINDOW }).catch(() => {
      // Some window managers refuse the geometry rather than the window. A tab
      // still completes the ceremony, so degrade instead of dead-ending the
      // only path into a locked vault.
      chrome.tabs.create({ url });
    });
    return;
  }

  chrome.tabs.create({ url });
}

export class PasskeyUnsupportedError extends Error {
  constructor() {
    super('Passkeys with PRF are not available here');
    this.name = 'PasskeyUnsupportedError';
  }
}

export class PasskeyCancelledError extends Error {
  constructor() {
    super('The passkey prompt was dismissed');
    this.name = 'PasskeyCancelledError';
  }
}

/** No PRF output came back, so there is nothing to wrap a key with. */
export class PasskeyNoPrfError extends Error {
  constructor() {
    super('This authenticator did not return a PRF result');
    this.name = 'PasskeyNoPrfError';
  }
}

interface PrfExtensionResults {
  prf?: {
    enabled?: boolean;
    results?: { first?: ArrayBuffer };
  };
}

export function isPasskeyApiAvailable(): boolean {
  return (
    typeof window !== 'undefined' &&
    typeof window.PublicKeyCredential === 'function' &&
    typeof navigator !== 'undefined' &&
    !!navigator.credentials
  );
}

/**
 * Whether a platform authenticator is present at all. Used only to decide
 * whether to offer the setting — a false answer here is not a hard refusal,
 * since a security key or a phone can still serve.
 */
export async function hasPlatformAuthenticator(): Promise<boolean> {
  if (!isPasskeyApiAvailable()) return false;
  try {
    return await window.PublicKeyCredential.isUserVerifyingPlatformAuthenticatorAvailable();
  } catch {
    return false;
  }
}

export function newPrfSalt(): string {
  return toBase64(crypto.getRandomValues(new Uint8Array(PRF_SALT_BYTES)));
}

function prfResultOf(credential: PublicKeyCredential): Uint8Array | null {
  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  const first = results?.prf?.results?.first;
  return first ? new Uint8Array(first) : null;
}

/** A dismissed prompt is a user decision, not a failure to report as an error. */
function translate(error: unknown): Error {
  if (error instanceof Error && (error.name === 'NotAllowedError' || error.name === 'AbortError')) {
    return new PasskeyCancelledError();
  }
  if (error instanceof Error && error.name === 'NotSupportedError') {
    return new PasskeyUnsupportedError();
  }
  return error instanceof Error ? error : new Error(String(error));
}

export interface RegisteredPasskey {
  credentialId: string;
  prfOutput: Uint8Array;
}

/**
 * Create a passkey for this extension and get its PRF output for `prfSalt`.
 *
 * Creation-time PRF evaluation only landed in recent Chrome, and several CTAP
 * 2.0/2.1 keys never return a value at create time. So a missing result is not
 * treated as failure: we immediately run an assertion, which is the path every
 * platform supports. That costs the user a second prompt during setup only.
 */
export async function registerPasskey(prfSalt: string, label: string): Promise<RegisteredPasskey> {
  if (!isPasskeyApiAvailable()) throw new PasskeyUnsupportedError();

  const salt = fromBase64(prfSalt);

  let credential: PublicKeyCredential;
  try {
    credential = (await navigator.credentials.create({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        // `rp.id` omitted on purpose — see the note at the top of this file.
        rp: { name: 'Authenticator' },
        user: {
          // Random, and never linked to anything the user typed. This handle is
          // stored by the authenticator and may sync to a password manager; a
          // real name or email here would leak which services the vault holds
          // to whatever shows the passkey list.
          id: crypto.getRandomValues(new Uint8Array(16)),
          name: label,
          displayName: label,
        },
        pubKeyCredParams: [
          { type: 'public-key', alg: -7 }, // ES256
          { type: 'public-key', alg: -257 }, // RS256
        ],
        authenticatorSelection: {
          // Discoverable where it is cheap, so a synced passkey opens the vault
          // on a second device; the credential id is stored either way, so a
          // non-discoverable one still works through allowCredentials.
          residentKey: 'preferred',
          // This replaces a password. An authenticator that would hand over the
          // PRF output on presence alone is not an acceptable substitute.
          userVerification: 'required',
        },
        extensions: { prf: { eval: { first: salt } } } as AuthenticationExtensionsClientInputs,
        timeout: 120_000,
      },
    })) as PublicKeyCredential;
  } catch (error) {
    throw translate(error);
  }

  if (!credential) throw new PasskeyCancelledError();

  const credentialId = toBase64(new Uint8Array(credential.rawId));
  const atCreation = prfResultOf(credential);
  if (atCreation) return { credentialId, prfOutput: atCreation };

  const results = credential.getClientExtensionResults() as PrfExtensionResults;
  // `enabled: false` is the authenticator saying it will never do PRF. Running
  // an assertion against it would prompt the user a second time only to fail,
  // and would leave a useless passkey behind either way.
  if (results?.prf && results.prf.enabled === false) {
    throw new PasskeyNoPrfError();
  }

  const prfOutput = await evaluatePrf(credentialId, prfSalt);
  return { credentialId, prfOutput };
}

/**
 * Ask an existing passkey for its PRF output. This is the unlock path, and the
 * only thing that can produce the key that opens the vault.
 */
export async function evaluatePrf(credentialId: string, prfSalt: string): Promise<Uint8Array> {
  if (!isPasskeyApiAvailable()) throw new PasskeyUnsupportedError();

  let assertion: PublicKeyCredential;
  try {
    assertion = (await navigator.credentials.get({
      publicKey: {
        challenge: crypto.getRandomValues(new Uint8Array(32)),
        allowCredentials: [{ type: 'public-key', id: fromBase64(credentialId) as BufferSource }],
        userVerification: 'required',
        extensions: {
          prf: { eval: { first: fromBase64(prfSalt) } },
        } as AuthenticationExtensionsClientInputs,
        timeout: 120_000,
      },
    })) as PublicKeyCredential;
  } catch (error) {
    throw translate(error);
  }

  if (!assertion) throw new PasskeyCancelledError();

  const prfOutput = prfResultOf(assertion);
  if (!prfOutput) throw new PasskeyNoPrfError();
  return prfOutput;
}
