// Keys must exist in every locale file under `utils/locales/`.
type UpdateHighlightKey =
  | 'update.feature.suggestedAccount'
  | 'update.feature.qrScanning'
  | 'update.feature.timeSync'
  | 'update.feature.vault'
  | 'update.feature.encryptedExport'
  | 'update.feature.recovery'
  | 'update.feature.suggestedToggle';

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
  ],
};
