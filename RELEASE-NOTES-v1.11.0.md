## Groups

Give an account a group when you add or edit it, then filter the list by the
labels above it. Groups are derived from the accounts themselves — there is
nothing to create and nothing to delete, and a group disappears on its own once
its last account is gone.

A group is part of the account, so it travels with your backups and, when
password protection is on, it is encrypted along with everything else. The
filter you have selected is kept out of storage entirely while a vault is
configured: a group name says which services you hold, which is exactly what
the vault is there to keep off the disk.

Groups do **not** yet propagate to a device that already has the account. The
local/sync merge only ever adds records it has never seen, so accounts you
organise on one computer stay organised there. Adding a group to an account on
each device works today; proper field-level merging is coming.

## Also new

- **Three popup sizes.** Small, medium and large, in Settings — with a
  one-line compact row so more codes fit on screen.
- **The help section moved to the website and is now translated into all twenty
  languages.** It had only ever existed in five; everyone else got a translated
  heading over English answers — including on the "why are my codes wrong?"
  entry the clock warning links to, which is exactly when English is least
  useful. The help icon and that warning now open
  `authenticator.sh/<your language>/faq`, with every answer on one page instead
  of behind thirteen disclosures in a 400-pixel window. Taking the prose out of
  the extension is what made twenty languages affordable at all: the popup is
  **104 KB, smaller than the 133 KB that shipped in 1.10.0** despite everything
  else in this release.
- **Arabic reads right to left.** The interface now sets its writing direction
  from the language, and every margin, padding and offset in the UI was moved to
  its logical equivalent so the layout mirrors as a whole rather than leaving
  stray controls on the wrong side. Lines that mix Arabic with a Latin word —
  "Chrome", "Authenticator" — no longer come out in the wrong visual order with
  their punctuation at the far end.
- **Request a feature** from the "What's New" screen and the footer.

## Fixes

- **Deleting an account works the first time.** It reported success, the
  account came back, and only a second delete made it stick. Accounts are read
  as the union of this device's copy and the synced one — which is how a second
  computer's accounts appear — and the reload that follows a delete raced the
  sync write that removes it, so the record was still there and was treated as
  an account arriving from elsewhere. It was written back to disk, not merely
  redrawn. Deletions are now remembered, so the synced copy cannot undo one;
  for anyone whose sync writes were being rejected outright, deleting had never
  worked at all.
- **Enabling password protection can no longer lose your accounts.** If any
  step of the changeover failed, the rollback removed the vault metadata — the
  only copy of the key for the encrypted records that had already been written.
  IndexedDB being unavailable (blocked site data, a corrupted profile, a full
  disk) was enough to trigger it. The rollback now restores the accounts, and
  the steps that cannot invalidate a working vault no longer run before it is
  safe.
- **One damaged entry no longer makes a whole backup file unimportable.** The
  import rejected the entire file on the first entry with a missing name or id,
  taking every good account with it. Unusable entries are now skipped and
  counted, and the count is reported rather than rounded up to "successful".
  Account names could also be emptied in the edit dialog, which is what
  produced such a file in the first place; the field is now required.
- **A field of an unexpected type in an imported file can no longer blank the
  popup.** A group that was a number rather than text threw during render, and
  with no error boundary that left a white window on every open, permanently,
  with the data still on disk. Imports are now type-checked, and a render error
  falls back to a screen that offers to save your accounts to a file.
- **Sync no longer stops silently for anyone whose accounts are not in English.**
  Chunks were measured in UTF-16 code units against a limit Chrome counts in
  UTF-8 bytes, so Cyrillic and CJK accounts produced chunks over the 8 KB
  per-item quota and the write was rejected. A rejected write now also raises
  the warning in Settings, which previously only appeared when the chunk count
  ran over.
- **Deleting the last account in a group no longer leaves the popup with no way
  to add another.** The filter stayed selected, which suppressed both the setup
  guide and the add button while the chip strip that would have cleared it was
  gone.
- **Scanning with the camera while a group filter is on** now files the accounts
  into that group, as the in-popup QR paths already did — instead of adding
  them outside the filter, where they were simply not there when you came back.
- **"What's New" shows once.** Taking either link inside it opened a tab, which
  closes the popup without recording that the modal had been seen, so it
  returned on the next open — and the next.
- **The review prompt asks once.** It appeared inside the update modal and again
  as a card below the account list on the same screen, "Maybe later" only
  silenced the one you clicked, and ignoring the card brought it back on every
  open forever. It now stands down after three unanswered showings.
- **A group named with a `$` no longer garbles the message that mentions it.**
- The countdown ring is no longer drawn from the wrong radius — it reached empty
  about 12% early — and an account with a broken period no longer renders `NaN`
  inside it. The add form rejects such a period instead of saving it.
- Typing an existing group name in a different case now offers, and settles on,
  the group that already exists rather than quietly creating a second one that
  looks identical in the filter strip.
- The group badge no longer squeezes the account name down to a few characters
  on the compact row, or overflows it at the small popup size.

## Verifying this build

`SHA256SUMS-v1.11.0.txt` attached below lists the SHA-256 of every file in the
`dist/` directory produced by:

```
npm ci && npm run build
```

on **Node 20.9.0**, at this tag. The build is deterministic — two consecutive
runs from a clean tree produce identical hashes.

To check the published extension against this source, see
[Verifying the Chrome Web Store Build](extension/README.md#verifying-the-chrome-web-store-build).

## Security

The cryptography, storage model, threat model and permissions are documented at
[authenticator.sh/how-it-works](https://authenticator.sh/how-it-works). Report
vulnerabilities to security@authenticator.sh — see
[SECURITY.md](extension/SECURITY.md) for scope, response times and safe harbour.
