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
 */
export function describeImport(outcome: ImportOutcome, language: Language): string {
  const t = createT(language);

  if (outcome.added === 0) return t('import.qrNothingNew');
  if (outcome.skipped > 0) return t('import.qrSuccessPartial', outcome.added, outcome.skipped);
  return t('import.qrSuccess', outcome.added);
}
