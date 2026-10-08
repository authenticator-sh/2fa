import { useId, useRef, useState } from 'react';
import { useEscapeLayer } from '@/hooks/useLayer';
import { ClipboardPaste, Download, Link2, Lock, Share2, Unlock, Upload } from 'lucide-react';
import { settingsButton } from '@/components/SettingsSection';
import {
  exportAccounts,
  getAccounts,
  importAccountList,
  addMultipleAccounts,
  quarantinedCount,
} from '@/utils/storage';
import { ImportRejectedError, isEncryptedMaFile, readImportFile, type ImportFile, type ImportReport } from '@/utils/import-formats';
import { addWithLimit } from '@/billing/add';
import { adoptLegacyFromBackup, backupPredatesBilling, installPredatesBilling } from '@/billing/legacy';
import { markBackupDone } from '@/utils/backup-reminder';
import { parseQRCode, generateRandomColor, qrFailureKey, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { saveErrorMessage } from '@/utils/save-error';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { cleanSecret } from '@/utils/totp';
import { createT, type Language } from '@/utils/i18n';
import { MIN_PASSWORD_LENGTH } from '@/utils/crypto';
import {
  describeFileImport,
  describeImport,
  fileImportKind,
  importErrorKind, importErrorMessage,
} from '@/utils/import-message';
import { reportAddFail, reportAddStep } from '@/billing/onboarding';
import { importURIList, looksLikeURIList } from '@/utils/uri-import';
import { confirmDialog, promptDialog, toast } from '@/utils/ui-feedback';
import {
  backupFileName,
  buildEncryptedBackupFile,
  buildPlainBackupFile,
  buildURIBackupFile,
  uriBackupFileName,
  downloadBackupFile,
  isEncryptedBackupFile,
  readEncryptedBackupFile,
} from '@/utils/backup-file';
import { buildCxfFile, cxfExportable, cxfFileName, isCxfFile, readCxf } from '@/utils/cxf';
import type { Account } from '@/types';

interface ExportImportProps {
  onImportComplete: () => void;
  onExportComplete?: () => void;
  language: Language;
}

/**
 * Reads a backup file of any supported shape. Encrypted files are prompted for
 * separately so the caller doesn't need to know the format up front.
 *
 * Aegis, 2FAS, Bitwarden, FreeOTP+, andOTP, Raivo and Authy-dump JSON are read
 * by importAccounts, which tells them apart by shape (see import-formats.ts).
 *
 * Returns null when the user cancelled at the password prompt, otherwise the
 * result — including how many entries were unreadable or unsupported, which
 * the caller must report rather than round up to "import successful". Throws
 * ImportRejectedError for a file that cannot be imported at all; say it with
 * importErrorMessage.
 */
export async function importBackupText(
  text: string,
  promptForPassword: () => Promise<string | null> | string | null,
  /** Only to recognise an encrypted Steam Desktop Authenticator .maFile. */
  fileName?: string
): Promise<(ImportReport & { leftOut: number }) | null> {
  const read = await readBackupText(text, promptForPassword, fileName);
  if (!read) return null;
  // Read (and decrypted) once, written through the limit: choosing "add the
  // ones that fit" in the paywall runs the write again, not the password prompt.
  if (read.predatesBilling) await adoptLegacyFromBackup();
  return addWithLimit('file', origin => importAccountList(read.entries, origin, read.from));
}

/**
 * A backup file's entries, decrypted if it needs a password, without writing
 * anything. Null when the password prompt was dismissed.
 */
async function readBackupText(
  text: string,
  promptForPassword: () => Promise<string | null> | string | null,
  fileName?: string
): Promise<{ entries: unknown[]; from: Partial<Omit<ImportFile, 'entries'>>; predatesBilling: boolean } | null> {
  // Checked first: it is not JSON, so every reader below would call it an
  // unknown format, and the way out is a step in SDA, not in this app.
  if (isEncryptedMaFile(text, fileName)) throw new ImportRejectedError('steam-encrypted');

  // Checked before our own plain format because a CXF document is also just
  // JSON: readImportFile would find no `accounts` array, throw "invalid
  // format", and tell someone migrating from another vendor that their file is
  // broken when it is the one file we most want to accept.
  if (isCxfFile(text)) {
    // With its count of unusable secrets: dropped silently, a file holding
    // nothing but those came back as an empty list and "Import successful!".
    const { accounts, unreadable, unsupported } = readCxf(text);
    return { entries: accounts, from: { unreadable, unsupported }, predatesBilling: false };
  }

  if (!isEncryptedBackupFile(text)) {
    let file: ImportFile;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
      file = readImportFile(parsed);
    } catch (error) {
      // Not JSON at all is the likeliest shape of another app's sealed backup;
      // the same message importAccounts gives (utils/storage.ts).
      if (error instanceof ImportRejectedError) throw error;
      throw new ImportRejectedError('unknown-format');
    }
    return { entries: file.entries, from: file, predatesBilling: backupPredatesBilling(parsed) };
  }

  const password = await promptForPassword();
  if (!password) return null;
  let envelope: unknown = null;
  try {
    envelope = JSON.parse(text);
  } catch {
    // isEncryptedBackupFile already vouched for it; the date is only a hint.
  }
  return {
    entries: await readEncryptedBackupFile(text, password),
    from: {},
    predatesBilling: backupPredatesBilling(envelope),
  };
}

/**
 * How many were added, and every other count that is not zero: already here,
 * unreadable, unsupported. "Import successful!" used to be said whatever the
 * file held — including for a second import of the same file, which added
 * nothing.
 */
export function importResultMessage(result: ImportReport, language: Language): string {
  return describeFileImport(result, language);
}

/** The toast colour for a result: green only when the whole file went in. */
export function importResultKind(result: ImportReport): 'success' | 'info' {
  return fileImportKind(result);
}

/**
 * What to say when importing a QR image fails.
 *
 * Never the error's own text. That used to go straight into the toast, so an
 * iPhone HEIC photo or a truncated download — which createImageBitmap rejects
 * with "The source image could not be decoded." — was reported in English to
 * users of all twenty languages, as a sentence about "the source image" that
 * does not say what to do.
 */
export function qrImportErrorMessage(error: unknown, language: Language): string {
  const t = createT(language);
  // Understood, and refused on purpose — saying "invalid QR" here would send
  // the user off to re-export a code that can never work.
  if (error instanceof UnsupportedOTPTypeError) return t(qrFailureKey('', error));
  // What the browser's image decoder throws: a DOMException, named for the
  // decode failure rather than for anything the user did.
  const name = error && typeof error === 'object' ? String((error as { name?: unknown }).name ?? '') : '';
  if (
    (typeof DOMException !== 'undefined' && error instanceof DOMException) ||
    ['InvalidStateError', 'EncodingError', 'NotSupportedError'].includes(name)
  ) {
    return t('import.imageUnreadable');
  }
  return saveErrorMessage(error, t);
}

export function ExportImport({ onImportComplete, onExportComplete, language }: ExportImportProps) {
  const t = createT(language);

  const [showExportChoice, setShowExportChoice] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportPasswordConfirm, setExportPasswordConfirm] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  /**
   * Set synchronously, unlike `busy`: two Enters in the password field land in
   * the same frame, before React has re-rendered with the button disabled, and
   * each started its own export — two files, each encrypted separately.
   */
  const exporting = useRef(false);
  const importInputRef = useRef<HTMLInputElement>(null);
  const exportButtonRef = useRef<HTMLButtonElement>(null);
  const titleId = useId();

  const runExport = async (format: 'encrypted' | 'plain' | 'cxf' | 'uri') => {
    if (exporting.current) return;
    exporting.current = true;
    setBusy(true);
    setExportError(null);
    try {
      const accounts: Account[] = JSON.parse(await exportAccounts());
      // What is on disk, not what a second call to the same function returns.
      // The guard used to compare exportAccounts() against getAccounts() — and
      // exportAccounts() *is* getAccounts(), stringified, so the two sides
      // could only ever differ on a race. Records the vault is holding back
      // (see quarantinedCount) are exactly the ones a backup must not omit
      // silently, and they were invisible to it: the popup showed the amber
      // "held" banner while Export cheerfully said "Exported 3 accounts" for a
      // profile holding four. Someone who then wipes the profile has lost one.
      const heldBack = quarantinedCount();

      // Never let a partial export masquerade as a full one.
      if (heldBack > 0) {
        const proceed = await confirmDialog({
          title: t('export.plainConfirmTitle'),
          body: t('export.warningPartial', accounts.length, accounts.length + heldBack),
          confirmLabel: t('common.confirm'),
          cancelLabel: t('common.cancel'),
          danger: true,
        });
        if (!proceed) return;
      }

      // Built before anything is written: it is the only format that can
      // legitimately leave an account out, and "your backup is incomplete" is
      // a question, not a notification delivered once the plaintext file is
      // already on disk.
      const uri = format === 'uri' ? buildURIBackupFile(accounts) : null;

      if (uri && uri.skipped > 0) {
        const proceed = await confirmDialog({
          title: t('export.plainConfirmTitle'),
          body: t('export.warningPartial', accounts.length - uri.skipped, accounts.length),
          confirmLabel: t('common.confirm'),
          cancelLabel: t('common.cancel'),
          danger: true,
        });
        if (!proceed) return;
      }

      // CXF has no way to say "Steam Guard", so those accounts cannot go in.
      // Asked before, like the text export, for the same reason.
      const cxfSkipped = format === 'cxf' ? accounts.length - cxfExportable(accounts).length : 0;
      if (cxfSkipped > 0) {
        const proceed = await confirmDialog({
          title: t('export.plainConfirmTitle'),
          body: t('export.warningPartial', accounts.length - cxfSkipped, accounts.length),
          confirmLabel: t('common.confirm'),
          cancelLabel: t('common.cancel'),
          danger: true,
        });
        if (!proceed) return;
      }

      const contents =
        format === 'encrypted'
          ? await buildEncryptedBackupFile(accounts, exportPassword, { legacy: await installPredatesBilling() })
          : format === 'cxf'
            ? buildCxfFile(accounts)
            : uri
              ? uri.text
              : buildPlainBackupFile(accounts, { legacy: await installPredatesBilling() });

      downloadBackupFile(
        contents,
        format === 'cxf' ? cxfFileName() : uri ? uriBackupFileName() : backupFileName(format === 'encrypted'),
        uri ? 'text/plain' : 'application/json'
      );

      await markBackupDone(accounts.length);
      onExportComplete?.();
      closeExportChoice();
      if (uri && uri.skipped > 0) {
        // Said again after the fact, so the count survives into the toast the
        // user can still read once the dialog is gone.
        toast('info', t('export.uriSkipped', accounts.length - uri.skipped, uri.skipped));
      } else if (cxfSkipped > 0) {
        toast('info', t('export.cxfSkippedSteam', accounts.length - cxfSkipped, cxfSkipped));
      } else {
        toast(
          'success',
          format === 'encrypted'
            ? t('export.encryptedDone', accounts.length)
            : t('export.success', accounts.length)
        );
      }
    } catch (error) {
      console.error('Export failed:', error);
      setExportError(t('export.failed'));
    } finally {
      exporting.current = false;
      setBusy(false);
    }
  };

  function closeExportChoice() {
    setShowExportChoice(false);
    setExportPassword('');
    setExportPasswordConfirm('');
    setExportError(null);
    // Back to the button that opened it. The window is not a component of its
    // own, so this is done here rather than by useReturnFocus.
    setTimeout(() => exportButtonRef.current?.focus(), 0);
  }

  // Escape closes it, as it does every other dialog in the app — as a layer, so
  // an Escape meant for a confirmation raised over it closes only that.
  // Without this the only exit was a button that could be off screen.
  useEscapeLayer(closeExportChoice, showExportChoice);

  const handleEncryptedExport = () => {
    if (exporting.current) return;
    if (exportPassword.length < MIN_PASSWORD_LENGTH) {
      setExportError(t('vault.setup.tooShort'));
      return;
    }
    // Typed twice, as when protection is switched on: this password is the
    // only way into the file, and one slipped key on a field of dots made a
    // backup nobody could ever open — found out on the day it was needed.
    if (exportPassword !== exportPasswordConfirm) {
      setExportError(t('vault.setup.mismatch'));
      return;
    }
    runExport('encrypted');
  };

  /**
   * A list of otpauth:// URIs — pasted, or read out of a .txt.
   *
   * The report is assembled clause by clause rather than rounded to "import
   * successful": a run that added twelve accounts, could not read two lines and
   * refused one counter-based token has to say all three, and line numbers are
   * the most that can be said about a line holding a live secret.
   */
  // Thin: the work lives in uri-import so the other file input gets the same
  // behaviour instead of a second copy that drifts.
  const runURIImport = async (text: string): Promise<void> => {
    const outcome = await addWithLimit('uri', origin => importURIList(text, language, origin));
    // The limit stopped it and the person closed the paywall: nothing to report.
    if (!outcome) return;
    if (outcome.added !== undefined) {
      // The count after the import, as the popup's own file input records it:
      // with 0 here, thirty days later every account read as added since the
      // backup and the reminder asked again for accounts nobody had added.
      // Best-effort: the accounts are already in. A bookkeeping read that fails
      // here must not skip the refresh and the report, or turn a finished import
      // into "Failed to import accounts" in the file path below.
      await getAccounts().then(list => markBackupDone(list.length)).catch(() => {});
      onImportComplete();
    }
    toast(outcome.kind, outcome.message);
  };

  const handlePasteImport = async () => {
    const text = await promptDialog({
      title: t('import.pasteTitle'),
      body: t('import.pasteBody'),
      placeholder: 'otpauth://totp/…',
      multiline: true,
      confirmLabel: t('settings.import'),
      cancelLabel: t('common.cancel'),
    });
    if (!text || !text.trim()) return;
    void reportAddStep('settings_paste', 'submitted');
    await runURIImport(text);
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    let text = '';

    try {
      if (file.type.startsWith('image/')) {
        await handleQRImport(file);
      } else if (((text = await file.text()), looksLikeURIList(text))) {
        await runURIImport(text);
      } else {
        const imported = await importBackupText(text, () =>
          promptDialog({
            title: t('import.passwordTitle'),
            body: t('import.passwordText'),
            password: true,
            confirmLabel: t('common.ok'),
            cancelLabel: t('common.cancel'),
          }),
          file.name
        );
        if (imported) {
          await getAccounts().then(list => markBackupDone(list.length)).catch(() => {});
          onImportComplete();
          toast(importResultKind(imported), importResultMessage(imported, language));
        }
      }
    } catch (error) {
      console.error('Import failed:', error);
      void reportAddFail('settings_import', importErrorKind(error));
      toast('error', importErrorMessage(error, language));
    }

    // Reset input value to allow importing the same file again
    e.target.value = '';
  };

  const handleQRImport = async (file: File) => {
    try {
      let result: string | null;
      try {
        result = await decodeQrFromImage(file);
      } catch (error) {
        // The image itself could not be opened — HEIC, a truncated file, a
        // format Chrome does not decode. Not the same as "no QR in it".
        console.error('QR image could not be decoded:', error);
        toast('error', t('import.imageUnreadable'));
        return;
      }
      if (!result) {
        toast('error', t('addAccount.errorNoQr'));
        return;
      }

      const parsed = parseQRCode(result);
      if (parsed) {
        // Prepare all accounts from QR code
        const accountsToAdd: Account[] = parsed.accounts.map((accountData, index) => ({
          id: Date.now().toString() + index + Math.random().toString(36).substring(7),
          name: accountData.name,
          issuer: accountData.issuer,
          secret: cleanSecret(accountData.secret),
          algorithm: accountData.algorithm,
          digits: accountData.digits,
          period: accountData.period,
          ...(accountData.type ? { type: accountData.type } : {}),
          createdAt: Date.now() + index, // Ensure unique timestamps
          color: generateRandomColor(),
        }));

        // Add all accounts at once
        let importResult;
        try {
          const added = await addWithLimit(parsed.type === 'migration' ? 'migration' : 'qr', origin =>
            addMultipleAccounts(accountsToAdd, origin)
          );
          if (!added) return;
          importResult = { ...added, unsupported: parsed.skipped ?? 0 };
        } catch (error) {
          console.error('Could not save the scanned accounts:', error);
          toast('error', saveErrorMessage(error, t));
          return;
        }
        onImportComplete();
        const summary = describeImport(importResult, language);
        const more = parsed.batch && parsed.batch.index < parsed.batch.total
          ? ` ${t('import.qrBatch', parsed.batch.index, parsed.batch.total)}`
          : '';
        toast(importResult.added > 0 ? 'success' : 'info', summary + more);
      } else {
        // An authenticator code whose payload is damaged is not "invalid".
        toast('error', t(qrFailureKey(result)));
      }
    } catch (error) {
      console.error('QR import failed:', error);
      void reportAddFail('settings_import', 'qr_failed');
      toast('error', qrImportErrorMessage(error, language));
    }
  };

  return (
    <>
      <div className="flex gap-2">
        <button
          ref={exportButtonRef}
          onClick={() => setShowExportChoice(true)}
          className={`${settingsButton.secondary} flex-1 py-2`}
        >
          <Upload size={14} />
          {t('settings.export')}
        </button>

        {/* A real button, as on the Add screen and the scanner page: a label
            around a display:none input takes no focus, so Import could not be
            reached from the keyboard at all. */}
        <button
          type="button"
          onClick={() => importInputRef.current?.click()}
          className={`${settingsButton.secondary} flex-1 py-2`}
        >
          <Download size={14} />
          {t('settings.import')}
        </button>
        <input
          ref={importInputRef}
          type="file"
          accept="application/json,text/plain,image/*,.maFile"
          onChange={handleImport}
          className="hidden"
          tabIndex={-1}
          aria-hidden="true"
        />
      </div>

      {/* Third input, and the one the other two could not cover: a link that
          arrived as text. Until now it had to be taken apart by hand. */}
      <button
        onClick={handlePasteImport}
        className={`${settingsButton.link} mx-auto mt-2.5 flex items-center gap-1.5`}
      >
        <ClipboardPaste size={14} />
        {t('import.paste')}
      </button>

      {showExportChoice && (
        <div
          className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
          onClick={closeExportChoice}
        >
          {/* max-h-full + overflow-y-auto, and a way out that is not the button:
              a fourth format card took this past 600px, which is the tallest a
              Chrome popup can be. Centred flex overflows in both directions at
              once, so the title and Cancel both left the screen and neither
              could be scrolled to. */}
          <div
            role="dialog"
            aria-modal="true"
            aria-labelledby={titleId}
            onClick={event => event.stopPropagation()}
            className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-sm w-full max-h-full overflow-y-auto shadow-xl p-5"
          >
            <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
              {t('export.chooseTitle')}
            </h2>

            <div className="border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-2">
              <div className="flex items-center gap-1.5 mb-1">
                <Lock className="text-green-600 dark:text-green-400" size={14} />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('export.encrypted')}
                </span>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{t('export.encryptedHint')}</p>
              <input
                type="password"
                value={exportPassword}
                onChange={e => {
                  setExportPassword(e.target.value);
                  if (exportError) setExportError(null);
                }}
                onKeyDown={e => e.key === 'Enter' && handleEncryptedExport()}
                placeholder={t('export.password')}
                aria-label={t('export.password')}
                autoComplete="new-password"
                autoFocus
                className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent-500 mb-2"
              />
              <input
                type="password"
                value={exportPasswordConfirm}
                onChange={e => {
                  setExportPasswordConfirm(e.target.value);
                  if (exportError) setExportError(null);
                }}
                onKeyDown={e => e.key === 'Enter' && handleEncryptedExport()}
                placeholder={t('export.passwordConfirm')}
                aria-label={t('export.passwordConfirm')}
                autoComplete="new-password"
                className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-accent-500 mb-2"
              />
              <button
                onClick={handleEncryptedExport}
                disabled={busy || !exportPassword || !exportPasswordConfirm}
                className="w-full bg-accent-600 hover:bg-accent-700 text-white font-medium text-xs py-1.5 rounded-md transition-colors disabled:opacity-50"
              >
                {t('settings.export')}
              </button>
            </div>

            <div className="border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Unlock className="text-gray-500 dark:text-gray-400" size={14} />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('export.plain')}
                </span>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{t('export.plainHint')}</p>
              <button
                onClick={() => runExport('plain')}
                disabled={busy}
                className="w-full text-xs font-medium py-1.5 rounded-md border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors disabled:opacity-50"
              >
                {t('settings.export')}
              </button>
            </div>

            <div className="border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Link2 className="text-gray-500 dark:text-gray-400" size={14} />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('export.uri')}
                </span>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{t('export.uriHint')}</p>
              <button
                onClick={() => runExport('uri')}
                disabled={busy}
                className="w-full text-xs font-medium py-1.5 rounded-md border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors disabled:opacity-50"
              >
                {t('settings.export')}
              </button>
            </div>

            <div className="border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Share2 className="text-gray-500 dark:text-gray-400" size={14} />
                <span className="text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t('export.cxf')}
                </span>
              </div>
              <p className="text-[11px] text-gray-500 dark:text-gray-400 mb-2">{t('export.cxfHint')}</p>
              <button
                onClick={() => runExport('cxf')}
                disabled={busy}
                className="w-full text-xs font-medium py-1.5 rounded-md border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors disabled:opacity-50"
              >
                {t('settings.export')}
              </button>
            </div>

            {exportError && <p role="alert" className="text-xs text-red-600 dark:text-red-400 mb-2">{exportError}</p>}

            <button
              onClick={closeExportChoice}
              className="w-full text-xs text-gray-500 dark:text-gray-400 hover:underline py-1"
            >
              {t('common.cancel')}
            </button>
          </div>
        </div>
      )}
    </>
  );
}
