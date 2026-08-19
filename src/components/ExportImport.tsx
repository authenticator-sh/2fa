import { useState } from 'react';
import { Download, Lock, Share2, Unlock, Upload } from 'lucide-react';
import {
  exportAccounts,
  importAccounts,
  importAccountList,
  addMultipleAccounts,
  getAccounts,
  type ImportResult,
} from '@/utils/storage';
import { markBackupDone } from '@/utils/backup-reminder';
import { parseQRCode, generateRandomColor, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { cleanSecret } from '@/utils/totp';
import { createT, type Language } from '@/utils/i18n';
import { MIN_PASSWORD_LENGTH } from '@/utils/crypto';
import { describeImport } from '@/utils/import-message';
import { confirmDialog, promptDialog, toast } from '@/utils/ui-feedback';
import {
  backupFileName,
  buildEncryptedBackupFile,
  buildPlainBackupFile,
  downloadBackupFile,
  isEncryptedBackupFile,
  readEncryptedBackupFile,
} from '@/utils/backup-file';
import { buildCxfFile, cxfFileName, isCxfFile, readCxfFile } from '@/utils/cxf';
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
 * Returns null when the user cancelled at the password prompt, otherwise the
 * result — including how many entries were unreadable, which the caller must
 * report rather than round up to "import successful".
 */
export async function importBackupText(
  text: string,
  promptForPassword: () => Promise<string | null> | string | null
): Promise<ImportResult | null> {
  // Checked before our own plain format because a CXF document is also just
  // JSON: importAccounts would find no `accounts` array, throw "invalid
  // format", and tell someone migrating from another vendor that their file is
  // broken when it is the one file we most want to accept.
  if (isCxfFile(text)) {
    return await importAccountList(readCxfFile(text));
  }

  if (!isEncryptedBackupFile(text)) {
    return await importAccounts(text);
  }

  const password = await promptForPassword();
  if (!password) return null;

  return await importAccountList(await readEncryptedBackupFile(text, password));
}

/** "Restored" plus, if any entry was beyond saving, how many and that they were skipped. */
export function importResultMessage(result: ImportResult, language: Language): string {
  const t = createT(language);
  return result.unreadable > 0
    ? t('import.successUnreadable', result.unreadable)
    : t('import.success');
}

export function ExportImport({ onImportComplete, onExportComplete, language }: ExportImportProps) {
  const t = createT(language);

  const [showExportChoice, setShowExportChoice] = useState(false);
  const [exportPassword, setExportPassword] = useState('');
  const [exportError, setExportError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const runExport = async (format: 'encrypted' | 'plain' | 'cxf') => {
    setBusy(true);
    setExportError(null);
    try {
      const accounts: Account[] = JSON.parse(await exportAccounts());
      const currentAccounts = await getAccounts();

      // Existing safety net: never let a partial export masquerade as a full one.
      if (accounts.length !== currentAccounts.length) {
        const proceed = await confirmDialog({
          title: t('export.plainConfirmTitle'),
          body: t('export.warningPartial', accounts.length, currentAccounts.length),
          confirmLabel: t('common.confirm'),
          cancelLabel: t('common.cancel'),
          danger: true,
        });
        if (!proceed) return;
      }

      const contents =
        format === 'encrypted'
          ? await buildEncryptedBackupFile(accounts, exportPassword)
          : format === 'cxf'
            ? buildCxfFile(accounts)
            : buildPlainBackupFile(accounts);

      downloadBackupFile(
        contents,
        format === 'cxf' ? cxfFileName() : backupFileName(format === 'encrypted')
      );

      await markBackupDone(accounts.length);
      onExportComplete?.();
      setShowExportChoice(false);
      setExportPassword('');
      toast(
        'success',
        format === 'encrypted'
          ? t('export.encryptedDone', accounts.length)
          : t('export.success', accounts.length)
      );
    } catch (error) {
      console.error('Export failed:', error);
      setExportError(t('export.failed'));
    } finally {
      setBusy(false);
    }
  };

  const handleEncryptedExport = () => {
    if (exportPassword.length < MIN_PASSWORD_LENGTH) {
      setExportError(t('vault.setup.tooShort'));
      return;
    }
    runExport('encrypted');
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      if (file.type.startsWith('image/')) {
        await handleQRImport(file);
      } else {
        const imported = await importBackupText(await file.text(), () =>
          promptDialog({
            title: t('import.passwordTitle'),
            body: t('import.passwordText'),
            password: true,
            confirmLabel: t('common.ok'),
            cancelLabel: t('common.cancel'),
          })
        );
        if (imported) {
          await markBackupDone(0); // Mark as backed up to suppress reminder
          onImportComplete();
          toast(
            imported.unreadable > 0 ? 'info' : 'success',
            importResultMessage(imported, language)
          );
        }
      }
    } catch (error) {
      console.error('Import failed:', error);
      toast('error', error instanceof Error && error.name === 'WrongExportPasswordError'
        ? t('import.wrongPassword')
        : t('import.failed'));
    }

    // Reset input value to allow importing the same file again
    e.target.value = '';
  };

  const handleQRImport = async (file: File) => {
    try {
      const result = await decodeQrFromImage(file);
      if (!result) {
        throw new Error(t('addAccount.errorNoQr'));
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
          createdAt: Date.now() + index, // Ensure unique timestamps
          color: generateRandomColor(),
        }));

        // Add all accounts at once
        const importResult = await addMultipleAccounts(accountsToAdd);
        onImportComplete();
        const summary = describeImport(importResult, language);
        const more = parsed.batch && parsed.batch.index < parsed.batch.total
          ? ` ${t('import.qrBatch', parsed.batch.index, parsed.batch.total)}`
          : '';
        toast(importResult.added > 0 ? 'success' : 'info', summary + more);
      } else {
        throw new Error(t('addAccount.errorInvalidQR'));
      }
    } catch (error) {
      console.error('QR import failed:', error);
      if (error instanceof UnsupportedOTPTypeError) {
        // Understood, and refused on purpose — saying "invalid QR" here would
        // send the user off to re-export a code that can never work.
        toast('error', t('addAccount.errorHotp'));
        return;
      }
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast('error', t('import.qrFailed', errorMessage));
    }
  };

  return (
    <>
      <div className="flex gap-2">
        <button
          onClick={() => setShowExportChoice(true)}
          className="flex-1 flex items-center justify-center gap-1.5 bg-white dark:bg-dark-700 hover:bg-gray-50 dark:hover:bg-dark-600 text-gray-700 dark:text-gray-200 font-medium text-sm py-2 px-3 rounded-lg border border-gray-300 dark:border-dark-500 hover:border-gray-400 dark:hover:border-dark-400 transition-all"
        >
          <Upload size={16} />
          {t('settings.export')}
        </button>

        <label className="flex-1 flex items-center justify-center gap-1.5 bg-white dark:bg-dark-700 hover:bg-gray-50 dark:hover:bg-dark-600 text-gray-700 dark:text-gray-200 font-medium text-sm py-2 px-3 rounded-lg border border-gray-300 dark:border-dark-500 hover:border-gray-400 dark:hover:border-dark-400 transition-all cursor-pointer">
          <Download size={16} />
          {t('settings.import')}
          <input
            type="file"
            accept="application/json,image/*"
            onChange={handleImport}
            className="hidden"
          />
        </label>
      </div>

      {showExportChoice && (
        <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
          <div className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-sm w-full shadow-xl p-5">
            <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100 mb-3">
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
                onChange={e => setExportPassword(e.target.value)}
                onKeyDown={e => e.key === 'Enter' && handleEncryptedExport()}
                placeholder={t('export.password')}
                autoFocus
                className="w-full px-2.5 py-1.5 text-xs rounded-md border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 text-gray-900 dark:text-gray-100 focus:outline-none focus:ring-1 focus:ring-[#4285F4] mb-2"
              />
              <button
                onClick={handleEncryptedExport}
                disabled={busy || !exportPassword}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-xs py-1.5 rounded-md transition-colors disabled:opacity-50"
              >
                {t('settings.export')}
              </button>
            </div>

            <div className="border border-gray-200 dark:border-dark-600 rounded-lg p-3 mb-3">
              <div className="flex items-center gap-1.5 mb-1">
                <Unlock className="text-gray-400" size={14} />
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
                <Share2 className="text-gray-400" size={14} />
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

            {exportError && <p className="text-xs text-red-600 dark:text-red-400 mb-2">{exportError}</p>}

            <button
              onClick={() => {
                setShowExportChoice(false);
                setExportPassword('');
                setExportError(null);
              }}
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
