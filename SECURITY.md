# Security Policy

We take the security of 2FA Authenticator seriously. Because this extension stores TOTP secrets, any vulnerability has direct impact on user account security across third-party services. We appreciate responsible disclosure and will work with researchers in good faith.

## Reporting a Vulnerability

**Please do not report security issues through public GitHub issues, the Chrome Web Store reviews, or social media.**

Instead, email **security@authenticator.sh** with:

- A description of the issue
- Steps to reproduce (PoC if possible)
- The version of the extension affected
- Your name / handle if you would like public credit

You will receive an acknowledgment within **72 hours**. We aim to provide an initial assessment within **7 days** and a fix or mitigation timeline within **14 days**, depending on severity.

If you do not receive a response within 72 hours, please follow up — your message may have been filtered.

## Scope

**In scope:**
- The browser extension code (manifest, popup, service worker, utilities)
- The share page at `authenticator.sh/s` and the link format it reads
- Build and release pipeline of the extension
- Storage and handling of TOTP secrets, account metadata, and backups
- Cryptographic implementation choices
- Third-party dependency vulnerabilities affecting the extension
- The billing check-in and licenses: what the extension sends to `api.authenticator.sh`, and how it verifies the policy and license tokens it receives

**Out of scope:**
- Issues in third-party services that the extension generates codes for
- Vulnerabilities in Chrome itself or the underlying OS
- Social engineering of extension users
- Physical access attacks
- Denial of service

## Share Links

Sharing an account's codes produces a link of the form `authenticator.sh/s#…`.
Its security rests on properties that are invariants of the design, not
conveniences — a change that breaks one of them is a vulnerability, and a
report that one is already broken is exactly the kind of report we want:

- **No secret is transmitted.** A link carries pre-computed TOTP codes for a
  bounded window (one hour at most), never the account's secret key.
- **Nothing is uploaded or stored.** The payload lives in the URL fragment,
  which browsers do not send to a server. There is no database of shares; the
  page is static and receives nothing.
- **The page runs no third-party code.** `/s` is hand-written HTML, CSS and
  JavaScript served from our own origin under
  `Content-Security-Policy: default-src 'none'` with `script-src 'self'`, and
  it is deliberately not part of the site's React application. Its only network
  request is to our own `/api/time`, which sends nothing about the caller. Any
  script on that page that could read `location.hash` is a vulnerability.
- **The fragment leaves the address bar immediately.** It is moved into
  `sessionStorage` (tab-scoped, not synced) before anything else happens, so it
  is not carried into synced browsing history. One slot per link, named by a
  random id kept in that history entry's state, so several links opened in one
  tab do not read each other.
- **A password is a second factor, not a second lock.** With one, the
  decryption key is derived from the password together with random bytes
  carried in the link (PBKDF2-HMAC-SHA256, 600 000 iterations); neither the
  link alone nor the password alone can open it.
- **Expiry is not enforced by us.** A link stops working because it contains no
  further codes. Accordingly there is no revocation, and we make no claim of
  any.

## Billing and licenses

Since 1.14.0 the extension checks in with `api.authenticator.sh` for the free
plan's account limit and for Pro. These are invariants; breaking one is a
vulnerability:

- **Nothing about an account leaves the device in a form we can read.** The
  check-in carries the closed list of fields in the README ("What is sent to
  our server") — a count of accounts, never a name, issuer, secret, code or
  site. The one exception is cloud backup, below, which the user turns on and
  which sends only ciphertext.
- **The limit can only stop an addition.** No billing state can hide, lock,
  remove or alter an account, or block showing codes, export, backups,
  restoring or sync.
- **No signed policy, no limit.** Until a policy signed by a key the build
  trusts has been received for this installation, nothing is limited; after
  that, the limit is checked offline from the last such policy. An unreachable
  or misbehaving server can never lock anyone out.
- **Tokens are verified, not trusted.** Policies and licenses are ES256 JWS
  checked with WebCrypto against the public keys compiled into the build
  (`src/billing/keys.ts`); a store build trusts the production key only
  (`scripts/check-bundle.ts` refuses a store build carrying any other).

### Cloud backup

Pro's cloud backup (`src/billing/cloud-backup.ts`, server `/v1/backup/*`) is
off until the user turns it on. Its invariants:

- **The server never holds a key.** Copies are encrypted in the browser with
  AES-256-GCM under a key derived (HKDF-SHA256) from a 20-symbol recovery code
  generated in the browser (~101 bits). The code is never sent to our server.
  The server stores ciphertext, its size and time, the license, the sending
  installation, `kid` — the first 8 bytes of a SHA-256 over the code with a
  fixed prefix — and the SHA-256 of `auth`, a separate HKDF output of the code.
  Neither opens a copy.
- **The vault is not bypassed.** With password protection on, this profile's
  stored code is encrypted under a key derived from the vault's master key,
  from the moment protection is turned on, in local storage and in sync.
- **Fetching, writing and deleting need the code.** The list of copies (times,
  sizes, `kid`) is given to an installation holding the license (paid up or
  not) or to the license key; a copy itself, an upload and turning off need
  `auth` as well; starting over without the code needs the license key. An
  install id alone — it leaves the browser in the uninstall link — reaches no
  ciphertext and can neither add nor delete copies.
- **One code per license.** The server refuses a copy under any code but the
  license's current one, so every listed copy opens with the same code.
- **Restoring only adds**, through the same merge as the automatic snapshots,
  and is never gated on Pro being active.

A way to read a copy without the recovery code, to read another license's
copies without its key, to delete or replace copies without the code or the
license key, or to make an installation upload in the clear, is a
vulnerability.

A way to get Pro without paying by editing the open-source code is not a
vulnerability — the limit is not DRM. A way for one person to obtain or use
*another* person's license, or to make someone else's installation limited,
is.

## Supported Versions

Only the latest published version of the extension on the Chrome Web Store receives security fixes. We strongly recommend keeping the extension up to date.

## Disclosure Policy

- We follow **coordinated disclosure**. Please give us a reasonable window (typically 90 days, or sooner if a fix ships) before public disclosure.
- We will credit reporters in release notes unless you prefer to remain anonymous.
- We do not currently offer a paid bug bounty, but we deeply appreciate good-faith research.

## Safe Harbor

We will not pursue legal action against researchers who:

- Make a good-faith effort to comply with this policy
- Avoid privacy violations, data destruction, and service disruption
- Do not access or modify data beyond what is necessary to demonstrate the issue
- Do not exploit the vulnerability beyond confirming its existence
- Report the issue promptly and do not disclose it publicly before coordination

## Verifying Releases

The extension is open source. To verify that a published Chrome Web Store build matches the source code, see the build instructions in [README.md](README.md).

## Contact

- Security: security@authenticator.sh
- General: https://authenticator.sh
