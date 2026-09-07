## Your code, without opening anything

Right-click the field asking for your 2FA code and choose **Insert 2FA code**,
or press ⌘⇧Y / Ctrl+Shift+Y. The code goes into the field. No popup, no
copy-paste, nothing typed by hand.

Which account it uses is decided from what the site has already taught it: the
account you have used on that domain before, or — the first time — the one whose
name matches the domain, and only when exactly one does. When neither holds it
does not guess. The popup opens with the question still attached, so the account
you pick there is recorded as an answer about this site rather than as the
incidental copy an ordinary popup visit produces, and the next right-click on
that domain fills it directly.

**Nothing of ours runs in a page until you ask it to.** There is no content
script and no host permission in the manifest. What fills the field is injected
for that one invocation, under the `activeTab` grant your own click provides,
and it leaves nothing behind when it returns: no listener, no global, nothing
that survives the navigation. Between two uses this extension has no presence in
any page at all. The menu item shows up only on editable fields on http(s)
pages, and turning the feature off in Settings removes the item entirely.

**It fills the box you were looking at.** Right-clicking a field focuses it, so
the caret is usually the whole answer. The keyboard shortcut can be pressed with
focus anywhere, so it falls back to scoring the fields that are actually there —
`autocomplete="one-time-code"` first, then the names, ids and placeholders that
mean "code" — and it treats the row of six single-digit boxes some sites use as
the one field it is. If nothing plausible is on the page, the code goes to the
clipboard and says so. If even the clipboard is refused, the code is shown for
you to type. Three outcomes, each of them visible; what it will not do is put a
code somewhere you did not see it go.

**A code with less than two seconds left is not the one you want.** It waits for
the next one instead. Most servers accept the previous window, but not all do,
and a form that submits itself on the last digit gives you no chance to notice.
A sign-in rejected that way looks exactly like an authenticator generating wrong
codes, which is the most common complaint made about every one of them.

A locked vault sends you to the popup to type your password. An extension asking
for that password inside a web page is precisely the shape of the attack
password protection exists to defend against, and it is not a habit worth
teaching anyone. A record whose secret cannot generate a code goes the same way,
because the popup names that account and offers the fix, and a notice in the
page could only repeat it with less to go on.

## Your codes, when the clock is wrong

The extension has checked your device clock since 1.9.0 and quietly adjusted
your codes when it drifted. That check had stopped working — for everyone.

It asked two independent time services and only trusted an answer both agreed
on. One of them, `worldtimeapi.org`, went off the air. With a pair, one silence
is enough: no agreement, no measurement, no warning, and no adjustment. Nothing
in the extension could say so, because "could not check" was recorded as "the
clock is fine".

Worse was what it left behind. A correction measured while the service was
still up was stored with no expiry, and it could only be replaced by another
successful measurement — which could no longer happen. So anyone who saw our
warning, fixed their clock, and moved on kept generating codes shifted by the
old drift. Indefinitely. There was no way to see it and no way to clear it.

**What changed**

- Three independent time sources instead of two. Any two agreeing is enough, so
  one going offline no longer takes the feature with it.
- A correction now carries the moment it was measured and expires after 48
  hours. Corrections written by earlier versions carry no timestamp, so they
  are discarded on the first launch after this update — if your codes have been
  rejected for weeks, this release is the fix.
- Settings now show what the clock check actually found, including "could not
  be checked", with a button to check again. A check that stops running is
  visible now instead of looking healthy.
- The warning no longer claims your codes were adjusted when they were too far
  out to adjust safely.

## Twenty languages nobody was being shown

The interface has shipped in twenty languages for a while. It opened in English
for everyone, because the only way to reach the other nineteen was a dropdown in
Settings — and a person who cannot read the English interface is not likely to
go hunting through it for the language menu.

It now opens in whatever language the browser is already in, which the browser
tells us and which costs no permission to ask for. Regional variants resolve to
the language we ship: `pt-BR` and `pt-PT` both get Portuguese, every Spanish
variant gets Spanish. A language we have no translation for still gets English.

If you have ever picked a language in Settings, that choice is untouched and
always wins. If you have not, and your browser is not in English, the extension
will now be in your language — the picker in Settings puts it back in one click.

## Clocks that move backwards

The same defect — comparing against `Date.now()` with no lower bound — sat in
five other places. A clock that jumps backwards (a dead CMOS battery, a
dual-boot machine, a VM resume, someone changing the date) makes every elapsed
time negative, and a negative number is smaller than every threshold, so the
deadline never arrives.

- **Auto-lock could be switched off by winding the clock back.** The idle
  deadline is the only thing enforcing it. It now locks when the elapsed time
  is not trustworthy, rather than handing out the key.
- **One snapshot written from a fast clock could stop the daily backup for
  good** — and pin recovery to that stale snapshot, which could never be
  evicted. A stamp from the future now sinks to the bottom of the pile instead
  of becoming a permanent "latest", and a snapshot whose age cannot be trusted
  counts as due rather than as recent.
- **A profile whose first sync read landed on a fast clock would never push to
  sync again**, leaving no off-device copy while the interface said sync was
  on. That window now heals itself.
- **Deletions recorded on a wrong clock** could age out the moment the clock
  was corrected, bringing deleted accounts back from sync.
- **A reminder snoozed on a wrong clock** could be snoozed for a decade. The
  backup reminder was one of them.

## A password change that some devices never accepted

Changing the vault password re-wraps the master key and syncs the new wrapping.
Every other device has to adopt it — otherwise the new password is rejected
there while the old one goes on opening the vault, which is a backdoor on every
device that missed the change.

Which copy won was decided by a wall clock. A machine whose clock ran ahead
therefore outranked every later change made anywhere else, permanently: it kept
its own stale wrapping, refused the new password, and accepted the old one for
good. Metadata now carries a write counter, and the clock is only a tiebreak.
The counter is optional, so a device still running an older version keeps
ordering writes exactly the way it does today.

## Password protection kept its promise for about a day

Turning on password protection scrubs the record of which sites you use codes
on — that record is exactly the metadata a stolen profile should not give up.
Nothing stopped the next copied code from writing it straight back to disk,
including while the vault was locked. With protection on, that history now
lives in memory only, and any copy already on disk is removed on sight.

## Unlock with a passkey instead of typing your password

If you turned on password protection, you can now open your codes with Touch ID,
Windows Hello, or your phone — whatever already unlocks your other passkeys.

It works through the WebAuthn PRF extension, which asks the passkey for 32
deterministic bytes and uses them to wrap the same master key your password
wraps. That is the whole reason it was cheap to add: the two-level key design
from 1.10.0 means a new way in is a new wrapper around one unchanged key, not a
re-encryption of every account, backup and export.

Three things worth being explicit about.

**A passkey is added, never substituted.** Your password and your recovery code
keep working exactly as before, and nothing removes them. A wiped phone, a reset
laptop or a password manager that dropped the credential costs you a
convenience, not your accounts. A design where the passkey were the only way in
would have created a brand-new way to lose every seed, which is the objection
this feature would have deserved to fail on.

**It costs no new permission.** The manifest still declares `storage`,
`activeTab`, `contextMenus` and `scripting`, with no host permissions. An
extension page is allowed to use WebAuthn under its own origin; only claiming a
website's identity would have required more, and there is no reason for a local
vault to claim anyone's domain.

**It opens in a small window of its own, not in the popup.** Chrome destroys the
popup the moment it loses focus, and the fingerprint prompt takes focus by
definition — inside the popup the window would simply vanish mid-ceremony. A
window rather than a tab keeps it feeling like a confirmation dialog.

Nothing is stored that could be used against you: the metadata holds the
credential id, a salt, and the master key wrapped under the passkey. Not the
master key, and not the value the authenticator returns.

The window closes itself once you have confirmed, and the popup notices
immediately rather than waiting to be reopened — it listens for the unlock rather
than checking once when it opens. The first build of this did neither: the codes
were unlocked, and the popup went on showing its lock screen until you closed and
reopened it.

If you have auto-lock set to **every open** — the strictest setting, and the one
most likely to be chosen by anyone who wants this feature — the key deliberately
never reaches storage that a second window could read. On that setting the first
build of this feature could not register a passkey at all, and unlocking with one
did nothing visible: the window unlocked a vault the popup could not see. The key
now crosses once, expires after two minutes, is deleted the moment it is read,
and is thrown away when you lock. What that setting promises still holds: the key
does not outlive the popup that used it.

Support in the wild is uneven — solid on Android, Windows 11 25H2 and up,
macOS 15+, iOS 18.4+, absent on Firefox for Android — so the setting hides
itself where the browser cannot do it, and an authenticator that cannot derive a
key says so instead of leaving a wrapper that opens nothing behind.

## Export your codes in a format everyone else can read

There is now a third export option: **Credential Exchange Format**, the FIDO
Alliance interchange format that Apple, Google, 1Password, Bitwarden and
Dashlane have been converging on. Apple ships it in iOS and macOS 26.

CXF covers TOTP secrets, not only passkeys, which makes this the first export
this extension has ever produced that another vendor can read without a
custom parser — and the first import that can accept one. Files are recognised
automatically; you do not choose a format when importing.

Two details that decide whether an interchange format is real or decorative:

- The secret is written as plain RFC 4648 Base32, byte for byte as stored. Any
  re-encoding step here would be a silent generator of permanently wrong codes,
  so a test asserts the exact string.
- Real files from password managers put a TOTP credential inside the same login
  item as the password. Import walks every credential of every item rather than
  assuming one each, or it would quietly drop the 2FA half of every file it was
  built to accept.

One malformed entry never costs the file: unreadable rows are counted and
reported, the rest import. Someone moving 200 accounts off a dead provider is
the worst possible person to hand an all-or-nothing parser.

The protocol half of the standard, CXP, is deliberately not implemented — it
negotiates provider-to-provider transfers through the operating system, which an
extension cannot do. The format is a file, and files are what export and import
already move.

## Also in this release

- The backup reminder now appears when automatic snapshots cannot be written at
  all — a profile with IndexedDB blocked had no automatic backups and no sign
  of it.
- The sync guard that protects an existing cloud copy from being replaced by a
  new device can now re-arm. It was a one-way latch: once a profile had seen
  content in sync, signing out of Chrome or switching account left the guard
  permanently off.
- QR links with an uppercase scheme (`OTPAUTH://TOTP/…`) and links with no
  slash before the query are accepted instead of rejected as invalid.
- Labels like `Acme:alice:b@example.com` keep everything after the first colon
  instead of being silently truncated.
- A one-character secret is refused instead of producing a confident,
  permanently wrong code from an empty key.

## Under the hood

`npm run check:deps` talks to every time source the extension depends on, using
the extension's own parsers, and fails if fewer than two are usable. It
runs on every push and once a week, which is the actual fix for the class of bug
this release is mostly about: reading the code could never have caught it.

The extension and the code generator on authenticator.sh now share a fixture of
TOTP vectors, and both test suites assert against it. They compute codes through
completely different implementations, and a review found nine ways they had
already drifted apart — including one that produced a code from a secret the
other refused outright. The website's generator also corrects for clock drift
now, so the page you open to check the extension can no longer disagree with it.

`docs/review-checklist.md` records what this release cost to find, as the
questions that would have found it sooner.
