// Keys must exist in every locale file under `utils/locales/`.
type UpdateHighlightKey =
  | 'update.feature.suggestedAccount'
  | 'update.feature.qrScanning'
  | 'update.feature.timeSync'
  | 'update.feature.autoLanguage'
  | 'update.feature.clockSources'
  | 'update.feature.passkeyUnlock'
  | 'update.feature.cxfExport'
  | 'update.feature.vault'
  | 'update.feature.encryptedExport'
  | 'update.feature.recovery'
  | 'update.feature.suggestedToggle'
  | 'update.feature.cameraScan'
  | 'update.feature.groups'
  | 'update.feature.appearance'
  | 'update.feature.quickFill'
  | 'update.feature.pasteLinks'
  | 'update.feature.uriExport'
  | 'update.feature.accountInitials'
  | 'update.feature.shareCodes'
  | 'update.feature.openIn'
  | 'update.feature.restoreBackups'
  | 'update.feature.accountMenu'
  | 'update.feature.groupTools'
  | 'update.feature.pinAccounts'
  | 'update.feature.importApps'
  | 'update.feature.keyboard';

// Maps an extension version to the changelog bullets shown in the "What's New"
// modal right after that version is installed. Versions with no entry here
// simply don't trigger the modal.
export const WHATS_NEW: Record<string, UpdateHighlightKey[]> = {
  '1.8.0': ['update.feature.suggestedAccount'],
  '1.9.0': ['update.feature.qrScanning', 'update.feature.timeSync'],
  '1.10.0': [
    'update.feature.vault',
    'update.feature.encryptedExport',
    'update.feature.recovery',
    'update.feature.suggestedToggle',
    'update.feature.cameraScan',
  ],
  '1.11.0': ['update.feature.groups', 'update.feature.appearance'],
  // One short line each, biggest change first. The detail — and the answer to
  // "what can this thing see?" — is on the site, one click away: a modal that
  // has to be scrolled to reach the rating block is a modal nobody finishes.
  '1.12.0': [
    'update.feature.quickFill',
    'update.feature.passkeyUnlock',
    'update.feature.cxfExport',
    'update.feature.clockSources',
    'update.feature.autoLanguage',
  ],
  // Sharing first: it is the one change here that gives the extension a
  // reason to be mentioned to someone who does not have it. Then moving in
  // and moving out, then the thing that makes a long list readable.
  '1.13.0': [
    'update.feature.shareCodes',
    'update.feature.pasteLinks',
    'update.feature.uriExport',
    // Above the initials because it changes what the extension *is* for the
    // people it matters to — a window that does not vanish — where a coloured
    // letter changes how the same list looks.
    'update.feature.openIn',
    'update.feature.accountInitials',
  ],
  // A patch release earns a modal only when it changes what the app can do for
  // someone in trouble. This one does: the daily copies have existed since
  // 1.10.0 and nothing could reach them, so nobody knew they were there.
  '1.13.2': ['update.feature.restoreBackups'],
  // 1.14.0 has no entry on purpose: it ships the paywall dark, and everyone who
  // updates predates it, so there is nothing new for them to be shown — Pro is
  // not announced inside the extension. What the extension now sends is said
  // where it has to be: the privacy policy, the README and the store listing.
  //
  // 1.15.0 has no entry either: its one change for everyone, the second
  // style, is in Settings for whoever looks, and cloud backup is Pro, which is
  // not announced inside the extension.
  //
  // 1.15.2 is a patch number with a modal, because it changes how the list is
  // handled every day. The right-click menu first: it is where most of the rest
  // is found. Then groups, which until now could only be set one account at a
  // time from Edit; then pinning; then the import that brings people over.
  // The keyboard last — it helps the people who look for it.
  '1.15.2': [
    'update.feature.accountMenu',
    'update.feature.groupTools',
    'update.feature.pinAccounts',
    'update.feature.importApps',
    'update.feature.keyboard',
  ],
};
