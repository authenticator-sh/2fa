# Releasing

Written after 1.12.0, where the built `dist/`, the checksums file and the packed
zip were each produced at a different hour from a different tree, and the tag
that is supposed to tie them together was not pushed at all — `git push` does
not carry tags, and nothing complained.

Three things must describe one build: the git tag, `SHA256SUMS-v<version>.txt`
and the zip uploaded to the Web Store. [README.md](../README.md) and the
"Verifying what we publish" section on the site both tell people to rebuild the
tag and compare it against the sums. Every step below exists to keep that claim
true; the order is not cosmetic.

## Before you start

- `package.json` and `public/manifest.json` carry the same new version.
  `scripts/checksums.js` refuses to write a file when `dist/` and the source
  disagree, which is how a sums file named after the wrong release is avoided.
- `RELEASE-NOTES-v<version>.md` exists and covers **everything the update modal
  announces**. Whoever arrives from GitHub sees only this file — no site page,
  no modal. In 1.12.0 the headline feature was missing from it entirely.
- `src/utils/update-notes.ts` has an entry for the version: one short line per
  change, biggest first.
- The site is ready in the same release: `EXTENSION_VERSION` and
  `RELEASE_VERSIONS` in `src/product.ts` / `src/releases.ts`, and
  `src/i18n/whats-new/<version>/` in all twenty languages.

## 1. One build pass, and no rebuild after it

```bash
npm ci
npm run verify                 # typecheck, tests, and a live probe of every external service
npm run build
npm run checksums              # writes SHA256SUMS-v<version>.txt from dist/
npm run checksums -- --check   # re-verify dist/ against that file
```

`npm run verify` includes `check:deps`, which talks to the real time sources. A
red run there means users are affected right now — it is not a formality to
skip because the code did not change.

From here until the tag is pushed, do not run `npm run build` again. A rebuild
produces a `dist/` that no longer matches the sums file, and nothing downstream
notices except the person who tries to verify the release six months later.

## 2. Package from that same `dist/`

```bash
rm -f authenticator-v<version>.zip authenticator-v<version>.crx
cd dist && zip -r -X -q ../authenticator-v<version>.zip . && cd ..
```

`rm` first: `zip` updates an existing archive in place rather than replacing it,
so a stale file quietly survives inside the new one. Zipping from *inside*
`dist/` is what puts `manifest.json` at the root, which is the only layout the
Web Store accepts.

The `.crx` is for people who install outside the store, and Chrome packs it from
the command line — no GUI step:

```bash
"/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" \
  --pack-extension="$PWD/dist" \
  --pack-extension-key="$PWD/authenticator-key.pem" --no-message-box
mv dist.crx authenticator-v<version>.crx
```

`authenticator-key.pem` is the extension's identity: the same key means the same
extension id, and losing it means everyone installing outside the store has to
install a stranger. It is `.gitignore`d (`*.pem`) and must stay that way.

## 3. Commit, tag, and push both

The release commit carries the version bump and the notes. The tag is annotated,
with a two-line summary of what the release is:

```bash
git commit                     # version bump + release notes + the work itself
git tag -a v<version>
git push origin main
git push origin v<version>     # separate command — `git push` does not do this
```

The tag must point at the commit the build came from, because "check out the
matching tag and rebuild" is a published instruction. Documentation-only commits
afterwards are fine and do not move the tag — `dist/` does not contain them.

## 4. Deploy the site

Only now. `src/banner.ts` puts `/releases/tag/v<version>` on every page in every
locale, and `pnpm check:links` fails when that URL 404s. The extension's own
"learn more" link points at the site by version and is redirected to the newest
page when the site has not published that version yet — so the site may lead the
store, but the tag must never lag the site.

## 5. Chrome Web Store

Upload `authenticator-v<version>.zip` and submit for review.

If the permissions in `public/manifest.json` changed, the form asks for a
justification per permission and the review is a slower, human one — days to
weeks rather than hours. Current text is in the appendix below; keep it in sync
with what the code actually does, because a reviewer checks.

## 6. GitHub Release

Create it from the tag, body from `RELEASE-NOTES-v<version>.md`, with three
assets attached:

- `SHA256SUMS-v<version>.txt`
- `authenticator-v<version>.zip`
- `authenticator-v<version>.crx`

All three are `.gitignore`d — the release is the only place they exist. A tag
without a release renders as a bare page of source archives, which leaves the
sums promise in the README and on the site unbacked and the site's own banner
pointing at nothing worth reading.

```bash
gh release create v<version> --title "v<version>" \
  --notes-file RELEASE-NOTES-v<version>.md \
  SHA256SUMS-v<version>.txt authenticator-v<version>.zip authenticator-v<version>.crx
```

Publishing before the store approves is fine, and usually better: the tag and
the banner are already public, and the sums are the thing people are told to
check. Say in the body that the store rollout follows separately, so someone
seeing this version here and an older one in their browser reads it as a review
queue rather than a broken update.

## If review rejects

Most rejections are about the listing — justifications, disclosures, wording —
and cost nothing here. If one demands a code change, the version is spent: the
Web Store will not take a second upload under the same number. Edit the release
to say it never reached the store, and cut the next patch version. Do not move a
tag that has been pushed.

## Appendix: permission justifications

The store keeps these per permission, 1,000 characters each, and asks again
whenever the permission set changes. They are here so the next release does not
have to reconstruct them from the code.

**contextMenus.** Quick fill. The extension adds a single right-click menu item,
"Insert 2FA code", which puts the current TOTP code into the login form the user
is looking at, instead of making them open the popup and copy it by hand.
`chrome.contextMenus` is the only API that can create that item, and it is used
for nothing else: one item, plus a submenu listing the user's own saved accounts
when the site cannot be matched to exactly one of them. The menu is created by
the service worker from data the user entered themselves; nothing about the page
or their browsing is read to build it, and no item is added for advertising,
promotion or any other purpose. The click on that item is also the user gesture
that authorises everything the feature then does, which is why this is a menu
item and not something that happens on its own.

**storage.** Everything the extension holds is the user's own: their TOTP
accounts and the settings that describe how to show them. `chrome.storage.local`
is the primary copy; `chrome.storage.session` holds the unlocked vault key for as
long as the user's auto-lock setting allows, so it never touches disk;
`chrome.storage.sync` is an optional second copy, off unless the user turns it on
and removed from Google's servers when they turn it off. Nothing about the pages
they visit is stored, and nothing is sent anywhere - the extension has no server
and no analytics. Without this permission the extension cannot remember a single
account between one click of the toolbar icon and the next, which is the whole
function.

**activeTab.** Two things, both started by the user's own click on the toolbar
icon. The hostname of the tab they were on is read so the account for that site
is offered first instead of making them search a list of a hundred; only the
hostname is used, and it is not stored or transmitted. And "Scan QR from screen"
captures that one visible tab, so somebody enrolling in 2FA can scan the code on
screen without photographing their own monitor. Both are limited to the tab that
was active when the click happened and to that one invocation - activeTab grants
nothing before the click and nothing after the tab navigates. The extension
declares no host permissions, so there is no access to any other tab, and no
browsing history is readable at all.

**sidePanel.** New in 1.13.0. Settings gained an "Open as" choice: the toolbar
icon can open the app in the usual popup, in a small floating window, or in
Chrome's side panel. A popup closes the instant it loses focus, which is wrong
for reading a code off the screen while typing it into a form on the page behind
it - the popup is gone before the code has been used. The side panel stays open
while the user moves between tabs. `chrome.sidePanel` is only used to register
the extension's own page as the panel's content and to open it on the user's
click; the panel shows the same account list as the popup and nothing else. It
reads no page and grants no access to one - the panel deliberately does not even
suggest the account for the current site, because that would need the `tabs`
permission. The option is hidden entirely on Chrome versions without a side
panel.

**scripting.** The same quick-fill feature has to put the generated code into the
field on the page, and `chrome.scripting.executeScript` is the only way to do
that. It runs once per user action - the right-click item above or its keyboard
shortcut - on that single tab, under the activeTab grant the user's own click
provides. The extension declares no host permissions and registers no content
scripts: nothing is injected until the user asks for a code, and the injected
function leaves nothing behind when it returns - no listeners, no globals, no
state. In the page it inspects input and textarea attributes
(autocomplete="one-time-code", name, id, placeholder) to find the box that should
receive the code, writes the code there and dispatches the events a form needs to
notice it. If no field accepts it, the code goes to the clipboard instead. It
never reads values the user has typed, page text or credentials, and it sends
nothing anywhere - the extension has no analytics and no server.
