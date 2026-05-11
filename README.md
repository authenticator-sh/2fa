# 2FA Authenticator

A privacy-focused TOTP/HOTP authenticator for Chrome. All secrets stay in your browser — no servers, no tracking, no telemetry.

- **Chrome Web Store:** [2FA Authenticator](https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd)
- **Website:** [authenticator.sh](https://authenticator.sh)
- **Security policy:** [authenticator.sh/security](https://authenticator.sh/security)

## Features

- TOTP and HOTP code generation (SHA-1, SHA-256, SHA-512; 6 or 8 digits)
- QR code import from image upload or visible tab
- Automatic local backups in IndexedDB with rotation
- Export and import for cross-device migration
- 20 UI languages
- Works fully offline

## Permissions

The extension requests the **minimum permissions** required for its functionality:

| Permission   | Reason                                                                |
|--------------|-----------------------------------------------------------------------|
| `storage`    | Store account secrets and settings locally in `chrome.storage`        |
| `activeTab`  | Allow QR scan from the current tab (only after explicit user action)  |

The extension does **not** request:
- `host_permissions` of any kind
- Content scripts on web pages
- `tabs`, `cookies`, `webRequest`, or any other broad permissions

This means the extension **cannot read or modify any website** you visit.

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

## Verifying the Chrome Web Store Build

To verify that the version published on the Chrome Web Store was built from this source code:

1. Download the `.crx` for the published version from the Chrome Web Store
2. Unzip it to a directory
3. Check out this repository at the matching git tag (e.g. `v1.7.0`)
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
├── components/              # React components
├── hooks/
│   ├── useAccounts.ts       # Account state + auto-backup
│   └── useTOTP.ts           # TOTP refresh loop
├── utils/
│   ├── storage.ts           # Dual storage (sync + local fallback) with retry
│   ├── auto-backup.ts       # IndexedDB backup rotation (7 latest)
│   ├── time-sync.ts         # Optional clock-drift check
│   ├── totp.ts              # TOTP via OTPAuth
│   ├── qr-parser.ts         # QR decoding
│   ├── migration-parser.ts  # Google Authenticator export parser
│   └── screen-capture.ts    # captureVisibleTab wrapper (activeTab only)
└── types/
```

## Network Access

The extension makes **no automatic network requests** during normal use. The only outbound HTTPS calls are:

| URL                                          | When                                | Purpose                             |
|----------------------------------------------|-------------------------------------|-------------------------------------|
| `https://authenticator.sh/<lang>/welcome`    | First install                       | Opens welcome page in a new tab     |
| `https://authenticator.sh/<lang>/uninstall`  | After uninstall (Chrome API)        | Opens feedback page                 |
| `https://authenticator.sh/rate`              | User clicks "Leave Feedback"        | Opens feedback form                 |
| `https://worldtimeapi.org/api/timezone/...`  | User opens popup (optional)         | Clock drift detection for TOTP      |

All TOTP secrets, account data, and backups stay on the device.

## Security

See [SECURITY.md](SECURITY.md) for the responsible disclosure policy.

Report security issues to **security@authenticator.sh** — please do **not** open a public issue for security bugs.

## Contributing

Bug reports and pull requests are welcome. Please read [CONTRIBUTING.md](CONTRIBUTING.md) before submitting.

## Technology

- React 18, TypeScript, Tailwind CSS
- Vite (build)
- [OTPAuth](https://github.com/hectorm/otpauth) (TOTP/HOTP)
- [html5-qrcode](https://github.com/mebjas/html5-qrcode) (QR scanning)
- Lucide React (icons)

## License

[MIT](LICENSE)
