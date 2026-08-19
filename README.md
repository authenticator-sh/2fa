# 2FA Authenticator

A privacy-focused TOTP authenticator for Chrome. We operate no servers, collect no analytics and receive none of your data. Accounts are stored by the browser, and optionally synced through your own Google account — see [Where your data lives](#where-your-data-lives).

- **Chrome Web Store:** [2FA Authenticator](https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd)
- **Website:** [authenticator.sh](https://authenticator.sh)
- **Security policy:** [authenticator.sh/security](https://authenticator.sh/security)
- **Privacy policy:** [authenticator.sh/privacy](https://authenticator.sh/privacy)
- **Feature requests:** [authenticator.featurebase.app](https://authenticator.featurebase.app)

## Features

- TOTP code generation (SHA-1, SHA-256, SHA-512; 6 to 10 digits, 7 included — it is issued in the wild). Counter-based HOTP is deliberately refused rather than stored as TOTP, which would look healthy and never once be valid.
- QR code import from image upload, the visible tab, or a camera
- Right-click a code field on any site to insert the code for it, without opening the popup (see [Inserting a code into a page](#inserting-a-code-into-a-page))
- **Optional password protection** — AES-256-GCM encryption of every account
  record and backup, with a recovery code so a forgotten password is not a
  dead end (see [Password protection](#password-protection))
- **Passkey unlock** — open a password-protected vault with Touch ID, Windows
  Hello or your phone through the WebAuthn PRF extension, with no new permission
  (see [Unlocking with a passkey](#unlocking-with-a-passkey))
- **Password-protected backup files** on export
- Automatic local backups in IndexedDB with rotation (7 latest)
- Export and import for cross-device migration, including
  [Credential Exchange Format](#credential-exchange-format) — the FIDO Alliance
  interchange format other password managers and authenticators can read
- 20 UI languages, chosen from the browser's own language on first open and overridable in Settings
- Works fully offline — the popup makes no network request to render

## Permissions

The extension requests the **minimum permissions** required for its functionality:

| Permission   | Reason                                                                          |
|--------------|---------------------------------------------------------------------------------|
| `storage`    | Store accounts and settings in `chrome.storage` (local, session and optional sync) |
| `activeTab`  | Read the current tab's hostname to highlight the matching account, capture the tab for QR scanning, and — only when you pick the right-click item — insert a code into that tab |
| `contextMenus` | Add the single "Insert 2FA code" item to the right-click menu on text fields |
| `scripting`  | Run the insert routine in the tab, for that one invocation, under the `activeTab` grant the click provides |

Camera scanning needs no manifest permission: it uses the browser's standard
camera prompt on an extension page, granted per extension origin and revocable
in site settings. It is never requested until the scanner is opened.

The extension does **not** request:
- `host_permissions` of any kind
- Content scripts — nothing of this extension is declared to run on any page,
  and nothing of it is running on a page you have not invoked it from
- `tabs`, `cookies`, `webRequest`, or any other broad permissions

This means the extension **cannot read or modify any page on its own**. Two
things happen on your instruction and nowhere else: under `activeTab` it reads
the active tab's hostname while the popup is open, to highlight the account
matching that site — switchable off in Settings, which also erases the history
it collected — and it inserts a code into a page when you pick it out of the
right-click menu.

### Inserting a code into a page

Right-clicking a text field offers one item, "Insert 2FA code" — removable in
Settings. The same action has a keyboard shortcut, `Ctrl+Shift+Y`
(`⌘⇧Y` on macOS), which can be changed or cleared at
`chrome://extensions/shortcuts`. Choosing either is what grants `activeTab`: for
that one invocation, in that one tab, the extension may put the code for the
site into the field you clicked. The grant ends with the invocation, nothing is
left behind in the page, and no code of ours runs there again until you ask
again.

Which account is chosen is deliberately conservative. An account you have
already used *on that site* wins — inserted into a field there, or picked when
this asked you which account the site wanted. Failing that, the site's name has
to match exactly one account. Anything less certain — several plausible
accounts, none at all, or a locked vault — opens the popup and lets you pick,
because these forms often submit themselves on the last digit and a wrong code
spends one of the few attempts the service allows.

A code copied out of the popup is deliberately not treated as evidence about
the site behind it. Codes get copied for things that are not the page at all —
a VPN client, an SSH prompt, a phone — so a copy never displaces the account a
site names, and never authorises inserting anything on its own.

If the field will not take the code — some sites build their inputs in ways no
insertion survives — it is copied to your clipboard instead and a note in the
page says so. The fallback is the point: the worst case is the paste you would
have done anyway.

## Password protection

Password protection is **optional and off by default**. With it off, account
records are stored unencrypted in `chrome.storage.local`, protected by the OS
user account and the Chrome profile — the same model as most authenticator
extensions. With it on:

| Property            | Value                                                          |
|---------------------|----------------------------------------------------------------|
| Cipher              | AES-256-GCM (random 96-bit IV per record)                      |
| Key derivation      | PBKDF2-HMAC-SHA256, 600,000 iterations, 128-bit random salt    |
| Master key          | 256-bit random, generated once; the password only wraps it     |
| Fingerprints        | HMAC-SHA256 under an HKDF subkey of the master key             |
| Unlocked key store  | `chrome.storage.session` (memory only, cleared on browser exit) |
| Auto-lock           | Every open / 5 / 15 / 60 min idle / until browser closes       |

Design notes:

- **Two-level keys.** Data is never encrypted with a password-derived key
  directly. A random master key encrypts the records; PBKDF2 output only wraps
  that master key. Changing the password rewrites 32 bytes rather than
  re-encrypting every record — the bulk rewrite is where data gets lost.
- **Recovery code.** A 160-bit code independently wraps the same master key, so
  a forgotten password is recoverable. It is shown once, must be typed back to
  confirm, and is rotated after each use.
- **What is encrypted.** The entire account record except its `id` and
  fingerprint — including the service name, so a stolen profile leaks no
  metadata about which services the user has accounts with.
- **Backups too.** IndexedDB snapshots store the already-encrypted records.
  Enabling the vault wipes every pre-existing cleartext copy (local, sync and
  all snapshots) after a decrypt-and-compare round trip verifies the encrypted
  data reads back identically. Verification happens before anything is deleted.
- **Export files** carry their own salt and a password chosen at export time,
  independent of the vault, so a backup stays openable on a machine that has no
  vault configured.

**Threat model.** This protects data at rest: a stolen profile directory, an
infostealer that exfiltrates browser data, or account records reaching Google's
servers through Chrome sync. It does **not** protect against malware running as
the user while the vault is unlocked, or a keylogger capturing the password.

Crypto lives in [`src/utils/crypto.ts`](src/utils/crypto.ts) and
[`src/utils/vault.ts`](src/utils/vault.ts); no cryptographic primitive is
hand-rolled — all of it is WebCrypto.

## Unlocking with a passkey

Available once password protection is on, and off until you add one. A passkey
becomes a **third wrapper around the same master key**, alongside the password
and the recovery code.

| Property           | Value                                                        |
|--------------------|--------------------------------------------------------------|
| Mechanism          | WebAuthn `prf` extension, `eval.first` over a 256-bit stored salt |
| Key derivation     | HKDF-SHA256 over the 32-byte PRF output, `info` = `authenticator-vault-passkey-v1` |
| Relying party      | the extension's own origin; **no host permissions**          |
| User verification  | `required` — presence alone must not release the wrapper     |
| Stored in metadata | credential id, PRF salt, wrapped master key. Never the master key or the PRF output |

Design notes:

- **Additive, never exclusive.** `attachPasskey` only ever adds a wrapper;
  nothing in the codebase removes `wrappedByPassword` or `wrappedByRecovery`. A
  lost passkey costs convenience, not accounts — a passkey-only vault would be a
  new way to destroy every seed.
- **Verified before it is written.** The wrapper is built, unwrapped again and
  compared byte for byte with the key it came from, all in memory. Only a match
  reaches storage, so an authenticator that cannot reproduce its own PRF output
  never leaves behind a wrapper that opens nothing.
- **A password change does not break it.** Only the password wrapper is rebuilt;
  the master key is unchanged, so the passkey keeps working. Covered by a test,
  because the failure would have been silent until the day it mattered.
- **It runs in its own window.** [`src/passkey/`](src/passkey/) is a full
  extension page, opened with `chrome.windows.create({type: 'popup'})` — no
  permission required. Chrome destroys the action popup on focus loss and the
  authenticator prompt takes focus, so the ceremony cannot complete inside the
  popup at all; a window keeps it a dialog rather than an opened tab, and falls
  back to a tab if the window is refused.
- **Uneven platform support is expected.** PRF is solid on Android, Windows 11
  25H2+, macOS 15+ and iOS 18.4+, and absent on Firefox for Android. The setting
  hides itself where the API is missing and reports the case where an
  authenticator declines PRF rather than failing obscurely.
- **The popup listens instead of polling.** The ceremony happens in another
  context, so the popup subscribes to `chrome.storage.onChanged`: a session
  change re-reads the lock state, and a `vault_meta` change re-reads whether a
  passkey is registered. Without this the popup sat on its lock screen with the
  vault already unlocked behind it until it was closed and reopened, and the
  settings panel kept offering to add a passkey that already existed. After a
  successful unlock the ceremony window also tries `chrome.action.openPopup()`
  — best effort, since it needs a user gesture that the biometric prompt may
  have outlived and does not exist before Chrome 127 — and then closes itself.
- **A one-shot hand-off crosses the context boundary.** The ceremony page is a
  separate JS context, and with auto-lock on *every open* the unlocked key is
  deliberately never written to `chrome.storage.session` — so without a hand-off,
  registering a passkey is impossible on that setting and unlocking with one
  silently does nothing. Both were reproduced before the fix. `stageKeyHandoff`
  and `consumeKeyHandoff` pass the key once, under a separate session key, with a
  two-minute expiry; it is deleted on first read, refused when stale, and cleared
  by `lock()`. That keeps what auto-lock *every open* actually promises — the key
  does not outlive the popup that used it — while letting a biometric prompt in
  another window count as the authentication event for exactly one popup.

Implementation: [`src/utils/passkey.ts`](src/utils/passkey.ts) (ceremonies only,
holds no key material) and the passkey functions in
[`src/utils/vault.ts`](src/utils/vault.ts).

## Credential Exchange Format

CXF is the FIDO Alliance's JSON interchange format for credentials. It covers
TOTP secrets as well as passkeys, which makes it the first format this extension
can both write and read that other vendors also speak.

- **Export**: a third option next to the plain and password-protected files.
- **Import**: recognised automatically, so there is no format to choose.
- **The secret** is written as plain RFC 4648 Base32, byte for byte as stored. A
  test asserts the exact string, because a re-encoding bug here produces
  confidently wrong codes rather than a visible failure.
- **Every credential of every item** is examined on import. Password managers
  put a TOTP credential in the same login item as the password; walking only the
  first would drop the 2FA half of the file.
- **One bad row never costs the file.** Unreadable entries are counted and
  reported; the rest import.

CXP, the protocol half of the standard, is deliberately not implemented: it
negotiates provider-to-provider transfer through the operating system, which an
extension cannot do. Implementation: [`src/utils/cxf.ts`](src/utils/cxf.ts).

## Building from Source

### Prerequisites

- Node.js 20.x LTS
- npm 10.x

### Build

```bash
npm ci
npm run build
```

The resulting `dist/` directory is the unpacked extension.

### Load in Chrome (development)

1. Open `chrome://extensions/`
2. Enable **Developer mode**
3. Click **Load unpacked** and select the `dist/` directory

### Development

```bash
npm run dev
```

### Tests

```bash
npm test
```

End-to-end scenarios for the storage and vault paths — enabling, locking,
password change, recovery-code reset, encrypted export, disabling — run against
real WebCrypto with `chrome.storage` and IndexedDB mocked. These cover the code
where a bug means permanent loss of a user's 2FA seeds, so they run the real
modules rather than stubs.

The passkey suite covers the wrapper rather than the WebAuthn ceremony, which
cannot run under Node: a stand-in PRF output proves that adding a passkey never
removes the password or recovery wrapper, that a password change and a
recovery-code reset both leave it working, and that neither the master key nor
the PRF output is ever written to metadata.

## Verifying the Chrome Web Store Build

To verify that the version published on the Chrome Web Store was built from this source code:

1. Download the `.crx` for the published version from the Chrome Web Store
2. Unzip it to a directory
3. Check out this repository at the matching git tag (e.g. `v1.11.0`)
4. Run `npm ci && npm run build` using **Node 20 LTS**
5. Compare the `dist/` directory contents with the unzipped `.crx`

Differences should only exist in:
- File ordering inside zips
- Whitespace differences in minified output across Node patch versions

For each release we publish `SHA256SUMS-v<version>.txt` — a SHA-256 for every file in the produced `dist/` — in [GitHub Releases](https://github.com/authenticator-sh/2fa/releases). It is in `sha256sum` format, so you can check your own build against it directly:

```bash
cd dist && sha256sum -c ../SHA256SUMS-v1.12.0.txt   # shasum -a 256 -c on macOS
```

## Architecture

```
src/
├── background/
│   ├── service-worker.ts    # MV3 service worker: install/uninstall URLs, menu, shortcut
│   ├── quick-fill.ts        # Right-click flow: pick account, generate, inject
│   └── quick-fill-page.ts   # The only code that ever runs in a page (injected on demand)
├── popup/
│   ├── App.tsx              # Main UI
│   └── index.tsx
├── scan/
│   └── App.tsx              # Camera QR scanner (own tab — see the file header)
├── passkey/
│   └── App.tsx              # Passkey ceremony (own tab — the popup dies on focus loss)
├── components/              # React components
├── hooks/
│   ├── useAccounts.ts       # Account state + auto-backup
│   ├── useVault.ts          # Lock/unlock state
│   └── useTOTP.ts           # TOTP refresh loop
├── utils/
│   ├── crypto.ts            # WebCrypto primitives (PBKDF2, AES-GCM, HKDF)
│   ├── vault.ts             # Vault lifecycle: unlock, auto-lock, recovery, passkey
│   ├── passkey.ts           # WebAuthn PRF ceremonies (no key material)
│   ├── storage.ts           # Local-primary storage, encryption layer, retry
│   ├── backup-file.ts       # Plain and password-protected export formats
│   ├── cxf.ts               # Credential Exchange Format read/write
│   ├── auto-backup.ts       # IndexedDB backup rotation (7 latest)
│   ├── vault-prompt.ts      # When to offer password protection
│   ├── time-sync.ts         # Optional clock-drift check
│   ├── totp.ts              # TOTP via OTPAuth
│   ├── qr-parser.ts         # QR decoding
│   ├── migration-parser.ts  # Google Authenticator export parser
│   ├── suggestions.ts       # Which account belongs to the site you are on
│   └── screen-capture.ts    # captureVisibleTab wrapper (activeTab only)
└── types/
```

## Network Access

The extension sends **nothing about you anywhere**. The only automatic request is the cached clock check below; everything else happens because you clicked something. In full, the outbound HTTPS calls are:

| URL                                         | When                          | Purpose                        |
|---------------------------------------------|-------------------------------|--------------------------------|
| `https://www.authenticator.sh/welcome`      | First install                 | Opens welcome page in a new tab |
| `https://www.authenticator.sh/uninstall`    | After uninstall (Chrome API)  | Opens feedback page            |
| `https://chromewebstore.google.com/.../reviews` | User takes the rating prompt | Opens the Web Store review form |
| `https://www.authenticator.sh/support`      | User clicks "Help & support"  | Opens the support page         |
| `https://www.authenticator.sh/faq` (or `/<lang>/faq`) | User clicks the help icon, or "How do I fix this?" on the clock warning | Opens the answers, in the popup's language |
| `https://authenticator.featurebase.app`     | User clicks "Request a feature" | Opens the public feature board |
| `https://chromewebstore.google.com/detail/password-manager/...` | User clicks the cross-promo banner | Opens our other extension's listing |
| `https://time.akamai.com/?iso`              | Popup open (optional, cached) | Clock drift detection for TOTP |
| `https://timeapi.io/api/time/current/zone?timeZone=UTC` | Popup open (optional, cached) | Clock drift detection for TOTP |
| `https://cloudflare.com/cdn-cgi/trace`      | Popup open (optional, cached) | Clock drift detection for TOTP |

Camera scanning uses `getUserMedia` on an extension page opened in a tab. That
needs no manifest permission — it goes through the browser's standard camera
prompt, granted per extension origin and revocable in site settings. It is
never requested until the user opens the scanner.

The clock-drift requests are unauthenticated GETs that carry no user data and
are cached. Any two of the three agreeing is enough, so one host going offline
does not disable the check — and when none of them can be reached, Settings
says so rather than reporting a clock it never measured. No fonts, scripts, or styles are loaded from remote
hosts — everything needed to render the popup is bundled.

## Where your data lives

| Store | Contents | Default |
|-------|----------|---------|
| `chrome.storage.local` | Accounts (encrypted when password protection is on), settings, and — only while password protection is off — the per-site usage history | Always used; primary |
| `chrome.storage.session` | The unlocked master key, the selected group filter and the per-site usage history — memory only, cleared when the browser closes | Only while unlocked |
| `chrome.storage.sync` | A copy of the accounts and the vault metadata, replicated by Chrome **through the user's own Google account** | On, switchable off |
| IndexedDB | Seven rolling snapshots, in the same form as the primary store | Always used |

Two consequences worth stating plainly:

- **With password protection off, accounts sit in sync in the clear**, which
  means Chrome replicates them to Google. That is the user's own Google account
  and we never see them, but it is not "on the device only". Turning password
  protection on encrypts them before they are ever handed to sync; turning sync
  off in Settings stops the replication and removes what is already there.
- **The per-site usage history is not covered by the vault** while it is being
  collected. Enabling password protection deletes it, and it can be switched off
  independently.

We operate no servers and receive no user data on any path.

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.

Report security issues to **security@authenticator.sh** — please do **not** open a public issue for security bugs.

## Contributing

Bug reports and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

## Technology

- React 18, TypeScript, Tailwind CSS
- Vite (build)
- [OTPAuth](https://github.com/hectorm/otpauth) (TOTP/HOTP)
- [jsQR](https://github.com/cozmo/jsQR) (QR decoding, lazy-loaded)
- Lucide React (icons)

## License

[MIT](LICENSE)
