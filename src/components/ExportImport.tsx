import { Download, Upload } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { exportAccounts, importAccounts, addMultipleAccounts } from '@/utils/storage';
import { markBackupDone } from '@/utils/backup-reminder';
import { parseQRCode, generateRandomColor } from '@/utils/qr-parser';
import { cleanSecret } from '@/utils/totp';
import { createT, type Language } from '@/utils/i18n';
import type { Account } from '@/types';

interface ExportImportProps {
  onImportComplete: () => void;
  onExportComplete?: () => void;
  language: Language;
}

export function ExportImport({ onImportComplete, onExportComplete, language }: ExportImportProps) {
  const t = createT(language);
  const handleExport = async () => {
    try {
      const data = await exportAccounts();
      const accounts = JSON.parse(data);

      // Validate that all accounts were exported
      const { getAccounts } = await import('@/utils/storage');
      const currentAccounts = await getAccounts();

      if (accounts.length !== currentAccounts.length) {
        const proceed = confirm(
          `⚠️ ${t('export.warningPartial', accounts.length, currentAccounts.length)}`
        );
        if (!proceed) return;
      }

      // Create enhanced export with metadata
      const exportData = {
        version: '2.0',
        exportDate: new Date().toISOString(),
        accountCount: accounts.length,
        accounts
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `authenticator-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      await markBackupDone(accounts.length);
      onExportComplete?.();
      alert(`✓ ${t('export.success', accounts.length)}`);
    } catch (error) {
      console.error('Export failed:', error);
      alert(t('export.failed'));
    }
  };

  const handleImport = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;

    try {
      // Check if it's an image file (for QR code)
      if (file.type.startsWith('image/')) {
        await handleQRImport(file);
      } else {
        // Assume it's a JSON file
        const text = await file.text();
        await importAccounts(text);
        await markBackupDone(0); // Mark as backed up to suppress reminder
        onImportComplete();
        alert(t('import.success'));
      }
    } catch (error) {
      console.error('Import failed:', error);
      alert(t('import.failed'));
    }

    // Reset input value to allow importing the same file again
    e.target.value = '';
  };

  const handleQRImport = async (file: File) => {
    try {
      const html5QrCode = new Html5Qrcode('qr-reader-import');
      const result = await html5QrCode.scanFile(file, false);

      console.log('QR code scanned successfully:', result);

      const parsed = parseQRCode(result);
      if (parsed) {
        console.log('Parsed QR data:', parsed);

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
        await addMultipleAccounts(accountsToAdd);
        onImportComplete();
        alert(t('import.qrSuccess', accountsToAdd.length));
      } else {
        throw new Error(t('addAccount.errorInvalidQR'));
      }
    } catch (error) {
      console.error('QR import failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      alert(t('import.qrFailed', errorMessage));
    }
  };

  return (
    <>
      {/* Hidden div for QR code scanning */}
      <div id="qr-reader-import" className="hidden"></div>

      <div className="flex gap-2">
        <button
          onClick={handleExport}
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
    </>
  );
}
