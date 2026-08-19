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
  | 'update.feature.quickFill';

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
};
