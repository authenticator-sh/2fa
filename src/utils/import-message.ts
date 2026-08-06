import { createT, type Language } from './i18n';

export interface ImportOutcome {
  added: number;
  skipped: number;
  total: number;
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

  // Nothing was added, so there is no group to report either.
  if (outcome.added === 0) return t('import.qrNothingNew');

  if (group) {
    return outcome.skipped > 0
      ? t('import.qrSuccessPartialGroup', outcome.added, group, outcome.skipped)
      : t('import.qrSuccessGroup', outcome.added, group);
  }

  if (outcome.skipped > 0) return t('import.qrSuccessPartial', outcome.added, outcome.skipped);
  return t('import.qrSuccess', outcome.added);
}
