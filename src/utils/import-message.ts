import { createT, type Language } from './i18n';
import { ImportRejectedError } from './import-formats';

export interface ImportOutcome {
  added: number;
  skipped: number;
  total: number;
  /**
   * Entries the code carried that could not be added at all — counter-based
   * (HOTP) or damaged. A Google Authenticator export with two of those among
   * ten used to report "8 added" and leave the user believing that was all.
   */
  unsupported?: number;
  /** Accounts already here that the scan switched to Steam Guard codes. */
  updated?: number;
}

/**
 * Phrase the result of a QR import honestly.
 *
 * Accounts already present are skipped by secret, so a rescan of something the
 * user already has adds nothing. Reporting that as "0 account(s) imported" reads
 * like a failure, and reporting the scanned count instead of the added count —
 * which the popup used to do — claims an import that never happened.
 *
 * `group` names where they landed. It matters most when the scan inherited the
 * active filter rather than a field someone filled in: without it the only
 * signal that a group was applied is the accounts being absent from an
 * unfiltered list later.
 */
export function describeImport(outcome: ImportOutcome, language: Language, group?: string): string {
  const t = createT(language);
  const note = outcome.unsupported ? ` ${t('import.qrSkipped', outcome.unsupported)}` : '';
  return summary(outcome, t, group) + note;
}

function summary(outcome: ImportOutcome, t: ReturnType<typeof createT>, group?: string): string {
  // A Steam Guard entry for a seed the list held as plain TOTP changes that
  // card rather than adding one; "nothing was added" alone would hide it.
  const updated = outcome.updated ? t('import.steamUpdated', outcome.updated) : '';

  // Nothing was added, so there is no group to report either.
  if (outcome.added === 0) return updated || t('import.qrNothingNew');
  return updated ? `${addedClause(outcome, t, group)} ${updated}` : addedClause(outcome, t, group);
}

function addedClause(outcome: ImportOutcome, t: ReturnType<typeof createT>, group?: string): string {
  if (group) {
    return outcome.skipped > 0
      ? t('import.qrSuccessPartialGroup', outcome.added, group, outcome.skipped)
      : t('import.qrSuccessGroup', outcome.added, group);
  }

  if (outcome.skipped > 0) return t('import.qrSuccessPartial', outcome.added, outcome.skipped);
  return t('import.qrSuccess', outcome.added);
}

/** The counts a file import produces. `unreadable` and `unsupported` are optional
 *  for callers that report those themselves, line by line. */
export interface FileImportOutcome {
  added: number;
  alreadyHere: number;
  /** Accounts already here switched to Steam Guard codes by the file. */
  updated?: number;
  unreadable?: number;
  unsupported?: number;
}

/**
 * Phrase the result of importing a file or a pasted list, clause by clause.
 *
 * Not describeImport: that one says "from QR code", which is wrong for a
 * backup file or a pasted list of links. And not the old "Import successful!",
 * which was said for every file whatever it held — re-importing the same backup
 * added nothing and still said it, and a file whose every secret was unusable
 * added nothing and said it too. Every count that is not zero is named.
 */
export function describeFileImport(outcome: FileImportOutcome, language: Language): string {
  const t = createT(language);
  const unreadable = outcome.unreadable ?? 0;
  const unsupported = outcome.unsupported ?? 0;
  const updated = outcome.updated ?? 0;
  const parts: string[] = [];

  if (outcome.added > 0) {
    parts.push(t('import.fileAdded', outcome.added));
    if (outcome.alreadyHere > 0) parts.push(t('import.fileAlreadyHere', outcome.alreadyHere));
  } else if (updated > 0) {
    if (outcome.alreadyHere > 0) parts.push(t('import.fileAlreadyHere', outcome.alreadyHere));
  } else if (outcome.alreadyHere > 0) {
    parts.push(t('import.qrNothingNew'));
  } else if (unreadable === 0 && unsupported === 0) {
    parts.push(t('import.fileEmpty'));
  }
  if (updated > 0) parts.push(t('import.steamUpdated', updated));

  if (unreadable > 0) parts.push(t('import.fileUnreadable', unreadable));
  if (unsupported > 0) parts.push(t('import.fileUnsupported', unsupported));
  return parts.join(' ');
}

/** Green only when everything in the file is now in the list. */
export function fileImportKind(outcome: FileImportOutcome): 'success' | 'info' {
  return (outcome.added > 0 || (outcome.updated ?? 0) > 0) && !outcome.unreadable && !outcome.unsupported
    ? 'success'
    : 'info';
}

/**
 * What to say when a file import fails as a whole.
 *
 * Each refusal says what to do next. "Please check the file format" was the
 * answer to all of them — including to someone holding a perfectly good Aegis
 * backup that only needs exporting again without a password, and to someone
 * holding an Alibaba Cloud backup that no app but Alibaba's will ever open.
 */
export function importErrorMessage(error: unknown, language: Language): string {
  const t = createT(language);
  if (error instanceof ImportRejectedError) {
    switch (error.reason) {
      case 'encrypted':
        return t('import.encryptedElsewhere', error.app ?? '');
      case 'steam-encrypted':
        // Not "export it again": SDA has no export. The encryption is removed
        // in SDA itself, and the same file then imports.
        return t('import.steamEncrypted');
      case 'only-unsupported':
        return t('import.onlyUnsupported');
      case 'nothing-readable':
        return t('import.nothingReadable');
      case 'unknown-format':
        return t('import.unknownFormat');
    }
  }
  if (error instanceof Error && error.name === 'WrongExportPasswordError') return t('import.wrongPassword');
  if (error instanceof Error && error.name === 'DamagedBackupFileError') return t('import.backupDamaged');
  if (error instanceof Error && error.name === 'VaultLockedError') return t('restore.locked');
  return t('import.failed');
}

/** The kind of a whole-file failure, for the report of where adds go wrong (billing/onboarding.ts) — never its words. */
export function importErrorKind(error: unknown): string {
  if (error instanceof ImportRejectedError) return error.reason;
  if (error instanceof Error && error.name === 'WrongExportPasswordError') return 'wrong_password';
  if (error instanceof Error && error.name === 'DamagedBackupFileError') return 'damaged';
  if (error instanceof Error && error.name === 'VaultLockedError') return 'locked';
  return 'failed';
}
