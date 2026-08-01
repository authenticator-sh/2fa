# 2FA Authenticator

A privacy-focused TOTP/HOTP authenticator for Chrome. We operate no servers, collect no analytics and receive none of your data. Accounts are stored by the browser, and optionally synced through your own Google account — see [Where your data lives](#where-your-data-lives).

- **Chrome Web Store:** [2FA Authenticator](https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd)
- **Website:** [authenticator.sh](https://authenticator.sh)
- **Security policy:** [authenticator.sh/security](https://authenticator.sh/security)

## Features

- TOTP and HOTP code generation (SHA-1, SHA-256, SHA-512; 6 or 8 digits)
- QR code import from image upload, the visible tab, or a camera
- **Optional password protection** — AES-256-GCM encryption of every account
  record and backup, with a recovery code so a forgotten password is not a
  dead end (see [Password protection](#password-protection))
- **Password-protected backup files** on export
- Automatic local backups in IndexedDB with rotation (7 latest)
- Export and import for cross-device migration
- 20 UI languages
- Works fully offline — the popup makes no network request to render

## Permissions

The extension requests the **minimum permissions** required for its functionality:

| Permission   | Reason                                                                          |
|--------------|---------------------------------------------------------------------------------|
| `storage`    | Store accounts and settings in `chrome.storage` (local, session and optional sync) |
| `activeTab`  | Read the current tab's hostname to highlight the matching account, and capture the tab for QR scanning |

Camera scanning needs no manifest permission: it uses the browser's standard
camera prompt on an extension page, granted per extension origin and revocable
in site settings. It is never requested until the scanner is opened.

The extension does **not** request:
- `host_permissions` of any kind
- Content scripts on web pages
- `tabs`, `cookies`, `webRequest`, or any other broad permissions

This means the extension **cannot read or modify the content of any page** you
visit. Under `activeTab` it does read the active tab's hostname when the popup
is open, to highlight the account matching that site; that behaviour can be
switched off in Settings, which also erases the history it collected.

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

## Verifying the Chrome Web Store Build

To verify that the version published on the Chrome Web Store was built from this source code:

1. Download the `.crx` for the published version from the Chrome Web Store
2. Unzip it to a directory
3. Check out this repository at the matching git tag (e.g. `v1.10.0`)
4. Run `npm ci && npm run build` using **Node 20 LTS**
5. Compare the `dist/` directory contents with the unzipped `.crx`

Differences should only exist in:
- File ordering inside zips
- Whitespace differences in minified output across Node patch versions

For each release we publish a SHA256 hash of the produced `dist/` directory in [GitHub Releases](https://github.com/authenticator-sh/2fa/releases).

## Architecture

```
src/
├── background/
│   └── service-worker.ts    # Minimal MV3 service worker (welcome/uninstall URL only)
├── popup/
│   ├── App.tsx              # Main UI
│   └── index.tsx
├── scan/
│   └── App.tsx              # Camera QR scanner (own tab — see the file header)
├── components/              # React components
├── hooks/
│   ├── useAccounts.ts       # Account state + auto-backup
│   ├── useVault.ts          # Lock/unlock state
│   └── useTOTP.ts           # TOTP refresh loop
├── utils/
│   ├── crypto.ts            # WebCrypto primitives (PBKDF2, AES-GCM, HKDF)
│   ├── vault.ts             # Vault lifecycle: unlock, auto-lock, recovery
│   ├── storage.ts           # Local-primary storage, encryption layer, retry
│   ├── backup-file.ts       # Plain and password-protected export formats
│   ├── auto-backup.ts       # IndexedDB backup rotation (7 latest)
│   ├── vault-prompt.ts      # When to offer password protection
│   ├── time-sync.ts         # Optional clock-drift check
│   ├── totp.ts              # TOTP via OTPAuth
│   ├── qr-parser.ts         # QR decoding
│   ├── migration-parser.ts  # Google Authenticator export parser
│   └── screen-capture.ts    # captureVisibleTab wrapper (activeTab only)
└── types/
```

## Network Access

The extension makes **no automatic network requests** during normal use. The only outbound HTTPS calls are:

| URL                                         | When                          | Purpose                        |
|---------------------------------------------|-------------------------------|--------------------------------|
| `https://authenticator.sh/welcome`          | First install                 | Opens welcome page in a new tab |
| `https://authenticator.sh/uninstall`        | After uninstall (Chrome API)  | Opens feedback page            |
| `https://authenticator.sh/rate`             | User rates the extension      | Opens the review page          |
| `https://worldtimeapi.org/api/timezone/...` | Popup open (optional, cached) | Clock drift detection for TOTP |
| `https://timeapi.io/api/time/current/zone`  | Fallback if the above fails   | Clock drift detection for TOTP |

Camera scanning uses `getUserMedia` on an extension page opened in a tab. That
needs no manifest permission — it goes through the browser's standard camera
prompt, granted per extension origin and revocable in site settings. It is
never requested until the user opens the scanner.

The clock-drift requests are unauthenticated GETs that carry no user data, are
cached, and fail silently. No fonts, scripts, or styles are loaded from remote
hosts — everything needed to render the popup is bundled.

## Where your data lives

| Store | Contents | Default |
|-------|----------|---------|
| `chrome.storage.local` | Accounts (encrypted when password protection is on), settings, per-site usage history | Always used; primary |
| `chrome.storage.session` | The unlocked master key, memory only, cleared when the browser closes | Only while unlocked |
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
