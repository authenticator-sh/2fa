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
