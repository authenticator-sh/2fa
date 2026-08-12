## Password protection (optional, off by default)

Lock your codes behind a password. They are encrypted on your device with
AES-256-GCM; the password only wraps a random master key, and a recovery code
wraps the same key independently — so a forgotten password never means losing
your accounts.

Turning it on removes every cleartext copy: local storage, sync, and all seven
backup snapshots. Nothing is written until you have confirmed you saved the
recovery code.

## Also new

- **Scan QR codes with your camera.** Point it at your phone's Google
  Authenticator export screen and every account comes across at once. This
  needs no manifest permission — the browser asks when you open the scanner,
  and the video never leaves your machine.
- **Password-protected backup files**, so a stolen backup is worthless without
  the password.
- **Sync can be switched off**, which removes the accounts and the wrapped
  master key from Google's servers rather than just ceasing to add to them.
- **The suggested-account highlight can be switched off**, and doing so erases
  the per-site history it had collected.
- **Rebuilt onboarding** around where your codes are now, with step-by-step
  instructions for each case rather than four generic steps.
- The popup no longer loads a web font from a third-party host, and ships one
  language instead of twenty — it opens noticeably faster.

## Fixes

- Accounts are no longer lost when a storage read fails. A failed read used to
  become an empty list, and since every change is a read-then-write, the next
  click wrote that empty list to disk.
- Reordering no longer deletes accounts missing from a stale list.
- Records that fail to decrypt are quarantined and preserved rather than
  dropped and then erased by the next save.
- Sync is split across several keys. A single key caps at 8 KB, which silently
  stopped syncing past roughly 44 accounts — about 22 with encryption on.
- Changing your password now propagates to your other devices instead of
  leaving the old password working there.
- TOTP secrets are no longer written to the browser console by the QR and
  migration parsers.

## Verifying this build

`SHA256SUMS-v1.10.0.txt` attached below lists the SHA-256 of every file in the
`dist/` directory produced by:

```
npm ci && npm run build
```

on **Node 20.9.0**, at this tag. The build is deterministic — two consecutive
runs from a clean tree produce identical hashes.

To check the published extension against this source, see
[Verifying the Chrome Web Store Build](README.md#verifying-the-chrome-web-store-build).

## Security

The cryptography, storage model, threat model and permissions are documented at
[authenticator.sh/how-it-works](https://authenticator.sh/how-it-works). Report
vulnerabilities to security@authenticator.sh — see
[SECURITY.md](SECURITY.md) for scope, response times and safe harbour.
