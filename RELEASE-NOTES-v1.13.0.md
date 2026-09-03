## Hand someone a code without handing over the account

Share on an account, pick how long, and you get a link that shows that
account's live codes to whoever opens it — in any browser, with nothing to
install. A QR code to point a phone at, and the link itself to paste.

**Your secret key is not in the link.** TOTP codes are a function of the key
and the clock, so the codes for the next hour can be worked out now and sent on
their own. What travels is a run of finished codes and nothing else: the key
never leaves this device, and the person you sent it to cannot make a code for
the hour after the one you gave them.

**The time limit is arithmetic, not a promise.** Five minutes, fifteen, thirty
or an hour — and an hour is the ceiling, not a default you can raise. When the
run is used up the page has nothing left to show, whether or not we are still
running, whether or not the page was saved offline. There is no revocation
because there is nothing to revoke.

**A password, if the link is going somewhere you do not trust.** Without one,
anyone holding the link can read the codes — that is what a link is. With one,
neither half is enough on its own: the key is derived from the password *and*
the sixteen random bytes in the link, so a leaked link is useless and an
overheard password is useless. Say the password out loud rather than sending it
under the link.

**No server, and no permission of its own.** Nothing is uploaded when a link is made:
the whole payload rides in the URL fragment, which browsers do not send to the
host. The page at `authenticator.sh/s` is five static files — markup,
stylesheet, the app, the codec and twenty languages of strings — under a policy
that allows nothing but this origin: no framework, no fonts, no analytics,
nothing that could read the fragment. It makes one request, to ask what time it is, so
that a recipient with a wrong clock still reads the right code. Sharing needs
no permission the extension did not already have — the manifest does change in
this release, but for the side panel below, not for this.

The extension and that page share no code, so a fixture of real links pins them
together: six of them, byte for byte, with the codes they must decode to. Both
repositories carry it and both fail loudly if one side drifts.

An account whose key cannot produce a code cannot be shared. Counter-based
(HOTP) tokens never come up: this extension refuses to store one at all, on
every path in, because a counter that moves when it is used has no run of codes
to compute in advance.

**You choose the name above the code.** It starts as the account's own, and it
is a plain field: shorten it, write who the code is for, or clear it entirely
when whoever opens the link has no business knowing which service it belongs
to. It is part of the encrypted payload like everything else, and the field
clamps to the payload's own 64-byte limit as you type — so the page prints
exactly what was typed, in any script rather than only in Latin.

**The page itself belongs to the site now.** Same header, same card, same ring
around the code as the generator at authenticator.sh/generator — a live 2FA
code on a page that looks like nothing else you have seen from us is a code you
have no reason to trust. It is still those same five files under the same
policy: the site's chrome is restated by hand there
rather than imported, because importing it would mean running the site's
bundle on the one page that must not.

**Several links, one tab.** Two share addresses differ only after the `#`,
which browsers treat as a move inside the same document — no reload, and the
page had no reason to re-read the address. Send three codes at once and the
second link opened on top of the first showed the first one's code. The page
now follows the address bar, and each link's payload is filed under its own
history entry, so back and forward land on the code they were opened with.

## Bring a hundred accounts over in one paste

Paste a list of `otpauth://` links and every one of them becomes an account.
One link, a list of them, or a Google Authenticator migration link mixed in —
the same field reads all three.

Until now there was no way to paste a link at all, not even a single one. The
ways in were a QR image, the camera, a screenshot of a tab, and a form asking
for the secret by hand; anyone arriving with a text URI had to pick `secret`,
`issuer` and `digits` out of it themselves. That is the hole this closes, and
batch import is what it looks like when you have more than a couple of accounts
to move.

**It reports what it actually did.** Not "import successful" — added twelve,
three were already here, lines 4 and 9 could not be read, line 7 is a
counter-based token that cannot be stored. Line numbers and nothing else: every
one of those lines carries a live secret, so none of them is echoed back to you
or written to a log. Above 500 lines it stops and says how many it left, rather
than quietly importing a prefix of your accounts.

A `.txt` file of the same links works the same way, through the Import button.

## And take them out again the same way

Export now offers plain `otpauth://` links, one per line, in a text file. No
format to understand, nothing about us in it — almost any authenticator can
read it.

What the export writes is exactly what the import reads, and a test holds the
two together: an account with a colon in its name, a non-Latin issuer, eight
digits and a sixty-second period all survive the trip out and back. An account
whose secret cannot produce a code is left out of the file rather than written
as a link that would fail silently wherever it landed, and the count of those
is part of the message.

The file is unencrypted, like the plain JSON export beside it. It is for a
place you control.

## A list you can read

**Accounts can carry a coloured initial.** Off by default, in Settings —
the account list is the screen you already know by heart, and it should not
rearrange itself because we shipped something. The colour is mostly not new:
one has been stamped on every account added through the QR and manual paths
since the beginning, and nothing ever drew it. The ones that arrived without
it — CXF imports, backups written before colours existed — get a stable colour
derived from their own text.

It is not a favicon, and that is deliberate. Fetching those means one network
request per service, which tells whoever answers it which sites you hold 2FA
for. This popup makes no network requests; an initial needs no permission, no
bytes and no network, and it works for every account rather than only the
recognised ones.

**Full names on hover, everywhere.** Every view truncates the name, and the
narrow window truncates it hard enough that two accounts on one service used to
look identical. Now the whole name is a hover away — including on a broken
account, the one row that is your only handle on a record you cannot otherwise
fix.

**The compact row gives its width back to the name.** At the 320px window the
fixed furniture of that row left about ten characters for the account. Tighter
padding, tighter gaps and no drag handle return roughly forty pixels of it.
Reordering stays a job for the other views.

## The camera scanner is no longer a dead end

The scanner page had exactly one way to succeed — the webcam reads the code —
and nothing to offer when it did not. A laptop camera that cannot focus on a
phone screen 30cm away is common, and the person it happened to was left with a
blurry preview, a retry button, and a support link. That is how we heard about
it.

**A picture of the code now works everywhere the camera does.** A Choose Image
button sits under the live preview and on every failure card — permission
denied, no camera, camera error. A picture can also be dropped anywhere on the
page, or pasted with Ctrl+V; a screenshot is on the clipboard already, and
saving it to a file first was the longest possible path to the same pixels.

**Pick which camera, when there is more than one.** The page used to take the
browser's default device, which on a machine with a virtual camera (OBS, a
phone-link tool) can be a black or frozen frame with no way out. With more than
one camera a dropdown lists them by name.

**Dense codes decode again.** A full Google Authenticator export runs about a
hundred modules across, and the scanner's downscaled decoding pass could bottom
out below what jsQR resolves. About once a second a frame now runs at native
resolution, so the dense codes that most need the camera get a fair read.

**The viewfinder tells the truth.** The guide square was drawn much smaller
than the area the decoder actually reads, teaching people to hold the code
smaller — and so blurrier — than it had to be. It is now close to the real
crop. And the hint
under the preview lost its icon: laid out exactly like the buttons around it,
it read as a third button that did nothing when clicked.

The first-run guide's Google Authenticator path now points its fallback step at
the scanner page's own Choose Image, and covers "the camera cannot read it",
not just "there is no camera".

## The codes can stay on screen

Settings → **Open as** now has three answers instead of one: the popup, a
floating window, or Chrome's side panel.

A popup closes the instant it loses focus. That is fine when you copy a code
and paste it, and wrong for everything else — reading a code off the screen
while typing it into a form, signing in on a second window, walking someone
through a login on a call. Every one of those ends with the popup gone before
the code has been used. The window and the side panel stay open while you move
between tabs and applications, so the code is still there when you look back.

**The window remembers where you left it.** Its size and position are stored
and reused, and if a window manager refuses geometry saved on a monitor that is
no longer attached, the window opens at the default size rather than not at
all. There is only ever one: clicking the icon again brings the existing window
forward instead of opening a second, and two clicks in the same instant now
make one window rather than two, one of which the extension could never find
again.

**It still knows which site you are on.** A floating window has no active tab
of its own, so the hostname of the page the icon was clicked on is handed to
it — the account for that site floats to the top exactly as it does in the
popup.

The side panel needs Chrome 114. On anything older the choice is not offered
at all, rather than shown and doing nothing — and a mode stored before a
browser downgrade is repaired rather than applied, because a side panel that
cannot open with the popup already cleared is a toolbar icon that does nothing
at all. The size presets apply to the popup only, so they are hidden in the
other two; those are sized by dragging their edges.

**What the side panel cannot do.** It has no active tab of its own and reading
one would need the `tabs` permission — "read your browsing history" in the
install dialog — so the panel does not suggest the account for the site you are
on. The popup and the floating window both do.

Quick fill knows about this too. With the popup unset, `chrome.action.openPopup`
has nothing to open, so a quick fill that needs to ask you something opens the
floating window itself rather than telling you to open an app the click was
already trying to open. In side-panel mode Chrome will only open a panel inside
the gesture that asked for it, and by then the decision has taken several
asynchronous steps — so there the notice on the page stands, and one click of
the icon opens the panel.

## One way back from everywhere

The popup had two kinds of "somewhere else". Settings had no way out at all
except the gear it was opened with, lit but silent — people looked for a back
control and there wasn't one. The modals floated over the app with a cross in a
different place each time. Neither read as a step you could return from.

- **Add account, Edit and Share are screens now**, with the app's own header
  and a back arrow where the logo sits. Settings names itself in that header
  too, and the arrow sits exactly where the logo did, so the title row does not
  shift as you enter it. Escape leaves any of the three — two of them had no
  keyboard way out at all in a window or a side panel — and while one is open
  the list behind it is inert, so Tab cannot walk into it and a second screen
  cannot be opened on top of the first.
- **The first-run guide fits on one screen.** Each path's fallback steps fold
  away behind one line, and that line asks the question they answer — "No
  camera on this computer?", "The site won't show a QR code?" — rather than
  saying "other options", which told nobody what was inside. The button that
  ends each path rides the bottom of the pane instead of sitting below a
  screenful of fallbacks four people in five will never need; at 320×400 it
  used to be entirely below the fold, which is a button most people never
  found.
- **The "where to find your secret key" help is folded away** in Add account.
  Somebody pasting a key they already have does not need four lines about
  where to get one, and open by default it pushed the Add button off the
  bottom of the form.
- **No search box with nothing to search.** On an empty vault it was 44 pixels
  of the pane the setup guide needed.

## Quieter changes worth knowing about

- **Auto-lock now actually locks.** A popup is destroyed when it loses focus,
  so "lock after five minutes" was enforced by the app being gone. A floating
  window or a side panel stays open for hours, so the timer is enforced there
  on its own — and locking in one surface locks the others, because the lock
  state is read from session storage rather than kept per page.
- **An open window follows what happens elsewhere.** Scan an account on the
  scanner page and it appears in the window or panel you left open, without
  reopening it. Deleting and editing propagate the same way.
- **The Secret Key field takes a whole `otpauth://` link.** Paste one and the
  name, issuer, algorithm, digits and period fill themselves in, with Advanced
  opened when any of them is not the default. Nothing on the form said the
  field would do this, and people were taking links apart by hand.
- **The delete confirmation says what it is deleting**, once, instead of
  repeating a name that was the same on both sides of a colon: "Delete
  lenagjeka: lenagjeka?" is now "Delete lenagjeka?", with the warning in a box
  of its own.
- **The export dialog scrolls**, and closes on Escape or a click outside. A
  fourth format card had pushed its title and its Cancel button off the bottom
  of a 600px popup with no way to reach either.
- **"What's new" has a close button** and answers Escape, and following a link
  out of it no longer counts as dismissing it.
- The share page at `authenticator.sh/s` follows the address bar: two links
  differ only after the `#`, which the browser treats as staying on the same
  page, so the second of three codes sent together used to show the first one's
  digits. Each link's payload is filed under its own history entry, so back and
  forward land on the code they were opened with, and the page no longer waits
  on a clock check that never answers.

## Fixes

- **Arabic**: the settings switches drew their knob outside the track. A CSS
  transform does not mirror under right-to-left, so the knob was pushed the
  full length of the track in the wrong direction.
- **The header fits again.** Nothing in it could shrink and nothing could
  ellipsize, so in languages with a longer name for this app — Turkish, French,
  German, Russian, Ukrainian — the title pushed the icons past the edge and the
  settings gear was cut off. The title now ellipsizes and the icons stay put.
- The logo is 20px rather than 24, which fits the text beside it better and
  gives the title back a little room.
- The device-clock row in Settings was built to different rules than the rows
  around it — a smaller, bolder label that read as a heading rather than as
  another entry. It now matches its neighbours.
- Settings ends with the version number, selectable, so answering "which
  version are you on?" no longer means leaving the popup — with a link beside it
  to the store listing, for anyone who has been meaning to leave a review and
  has never had anywhere to click.
