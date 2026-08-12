import { useState, useRef, useEffect } from 'react';
import { X, Upload, Monitor, Loader2, Camera } from 'lucide-react';
import type { Account } from '@/types';
import { validateSecret, cleanSecret } from '@/utils/totp';
import { parseQRCode, generateRandomColor, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { captureCurrentTab } from '@/utils/screen-capture';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { GroupInput } from './GroupInput';
import { createT, type Language } from '@/utils/i18n';

interface AddAccountModalProps {
  onClose: () => void;
  /**
   * `batch` says which code of a split Google Authenticator export this was, so
   * the parent can tell the user there are more to scan. The modal closes on
   * success, so it cannot say so itself.
   */
  onAdd: (
    account: Account | Account[],
    batch?: { index: number; total: number }
  ) => Promise<void>;
  language: Language;
  /** Existing group names, offered as suggestions — the field stays free text. */
  groups?: string[];
  /** Group to prefill, so adding from inside a filtered list lands in it. */
  defaultGroup?: string;
}

export function AddAccountModal({ onClose, onAdd, language, groups = [], defaultGroup = '' }: AddAccountModalProps) {
  const t = createT(language);
  const [tab, setTab] = useState<'manual' | 'qr'>('qr');
  const [name, setName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [group, setGroup] = useState(defaultGroup);
  const [secret, setSecret] = useState('');
  const [algorithm, setAlgorithm] = useState<'SHA1' | 'SHA256' | 'SHA512'>('SHA1');
  const [digits, setDigits] = useState<6 | 8>(6);
  const [period, setPeriod] = useState(30);
  const [error, setError] = useState('');
  const [showAdvanced, setShowAdvanced] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  const errorRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (error && errorRef.current) {
      errorRef.current.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
    }
  }, [error]);

  // What the manual form's own field was set to.
  const typedGroup = group.trim() ? { group: group.trim() } : {};

  // The QR tab has no group field — a scan adds the accounts and closes the
  // modal in one click, so any field there would have to be filled before the
  // thing it applies to exists, and grouping is easy enough to do afterwards by
  // editing. What a scan does inherit is the group the list was filtered to:
  // scanning from inside "Work" and having the accounts land outside it looks
  // like the scan silently failed, because they are not in the visible list.
  const filteredGroup = defaultGroup.trim() ? { group: defaultGroup.trim() } : {};

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    if (!name || !secret) {
      setError(t('addAccount.errorNameRequired'));
      return;
    }

    if (!validateSecret(secret)) {
      setError(t('addAccount.errorInvalidSecret'));
      return;
    }

    // Emptying the number field gives parseInt('') === NaN, which saved an
    // account whose code never changes and never works. Nothing downstream can
    // recover from it, so it is caught here.
    if (!Number.isFinite(period) || period < 1) {
      setError(t('addAccount.errorInvalidPeriod'));
      return;
    }

    const account: Account = {
      id: Date.now().toString() + Math.random().toString(36).substring(7),
      name,
      issuer: issuer || name,
      secret: cleanSecret(secret),
      algorithm,
      digits,
      period,
      createdAt: Date.now(),
      color: generateRandomColor(),
      ...typedGroup,
    };

    onAdd(account);
    onClose();
  };

  const handleClose = () => {
    onClose();
  };

  const handleTabChange = (newTab: 'manual' | 'qr') => {
    setTab(newTab);
    setError('');
  };

  const processQRFile = async (file: File) => {
    try {
      setError('');
      const result = await decodeQrFromImage(file);

      if (!result) {
        setError(t('addAccount.errorNoQr'));
        return;
      }

      const parsed = parseQRCode(result);
      if (parsed) {
        // Parsed QR data contains the secret; not logged.

        // Handle migration (multiple accounts)
        if (parsed.type === 'migration' && parsed.accounts.length > 1) {
          // Prepare all accounts from migration
          const accountsToAdd: Account[] = parsed.accounts.map((accountData, index) => ({
            id: Date.now().toString() + index + Math.random().toString(36).substring(7),
            name: accountData.name,
            issuer: accountData.issuer,
            secret: cleanSecret(accountData.secret),
            algorithm: accountData.algorithm,
            digits: accountData.digits,
            period: accountData.period,
            createdAt: Date.now() + index,
            color: generateRandomColor(),
            ...filteredGroup,
          }));

          // Add all accounts through onAdd to ensure state updates
          await onAdd(accountsToAdd, parsed.batch);
          console.log(`Successfully added ${accountsToAdd.length} accounts from migration`);
          onClose();
          return;
        }

        // Handle single account (either from regular URL or single migration entry)
        const accountData = parsed.accounts[0];
        const account: Account = {
          id: Date.now().toString() + Math.random().toString(36).substring(7),
          name: accountData.name,
          issuer: accountData.issuer,
          secret: cleanSecret(accountData.secret),
          algorithm: accountData.algorithm,
          digits: accountData.digits,
          period: accountData.period,
          createdAt: Date.now(),
          color: generateRandomColor(),
          ...filteredGroup,
        };
        await onAdd(account);
        onClose();
      } else {
        console.error('Failed to parse QR code (content withheld)');
        setError(
          `${t('addAccount.errorInvalidQR')}.\n` +
          `Scanned: ${result.substring(0, 100)}${result.length > 100 ? '...' : ''}`
        );
      }
    } catch (err) {
      console.error('QR scan error:', err);
      if (err instanceof UnsupportedOTPTypeError) {
        setError(t('addAccount.errorHotp'));
        return;
      }
      const errorMessage = err instanceof Error ? err.message : String(err);
      setError(t('addAccount.errorScanFailed', errorMessage));
    }
  };

  const handleQRUpload = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    await processQRFile(file);
  };

  const handleDragOver = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(true);
  };

  const handleDragLeave = (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);
  };

  const handleDrop = async (e: React.DragEvent) => {
    e.preventDefault();
    e.stopPropagation();
    setIsDragging(false);

    const file = e.dataTransfer.files?.[0];
    if (file && file.type.startsWith('image/')) {
      await processQRFile(file);
    } else {
      setError(t('addAccount.errorDropImage'));
    }
  };


  const handleScanFromScreen = async () => {
    try {
      setError('');
      setScanning(true);
      const dataUrl = await captureCurrentTab();

      // Convert the captured data URL into a File for the QR decoder.
      const response = await fetch(dataUrl);
      const blob = await response.blob();
      const file = new File([blob], 'screenshot.png', { type: 'image/png' });

      await processQRFile(file);
    } catch (err) {
      console.error('Screen scan failed:', err);
      // captureVisibleTab throws on restricted pages (chrome://, Web Store,
      // PDFs, other extensions). Show an actionable hint instead of the raw
      // system error, which reads as "it just broke".
      setError(t('addAccount.errorScreenHint'));
    } finally {
      setScanning(false);
    }
  };

  // Prevent default drag behavior on the entire modal to avoid browser opening the file
  const handleModalDragOver = (e: React.DragEvent) => {
    e.preventDefault();
  };

  const handleModalDrop = (e: React.DragEvent) => {
    e.preventDefault();
  };

  return (
    <div
      className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4"
      onDragOver={handleModalDragOver}
      onDrop={handleModalDrop}
    >
      <div className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white dark:bg-dark-800 border-b border-gray-200 dark:border-dark-600 p-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('addAccount.title')}</h2>
          <button
            onClick={handleClose}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-1"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4">
          <div className="flex gap-2 mb-4">
            <button
              onClick={() => handleTabChange('manual')}
              className={`flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-all ${
                tab === 'manual'
                  ? 'bg-[#4285F4] text-white'
                  : 'bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-dark-600'
              }`}
            >
              {t('addAccount.manual')}
            </button>
            <button
              onClick={() => handleTabChange('qr')}
              className={`flex-1 py-2 px-4 rounded-lg font-medium text-sm transition-all ${
                tab === 'qr'
                  ? 'bg-[#4285F4] text-white'
                  : 'bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-300 hover:text-gray-900 dark:hover:text-gray-100 hover:bg-gray-200 dark:hover:bg-dark-600'
              }`}
            >
              {t('addAccount.qrCode')}
            </button>
          </div>

          {tab === 'manual' ? (
            <form onSubmit={handleSubmit} className="space-y-4">
              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t('addAccount.accountName')}
                </label>
                <input
                  type="text"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                  placeholder={t('addAccount.accountNamePlaceholder')}
                  className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500"
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t('addAccount.secretKey')}
                </label>
                <input
                  type="text"
                  value={secret}
                  onChange={(e) => setSecret(e.target.value)}
                  placeholder={t('addAccount.secretKeyPlaceholder')}
                  className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm font-mono rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500"
                />
                <div className="mt-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                  <p className="text-xs text-blue-900 dark:text-blue-300 font-medium mb-1">{t('addAccount.whereToFind')}</p>
                  <ul className="text-xs text-blue-800 dark:text-blue-400 space-y-1 list-disc list-inside">
                    <li>{t('addAccount.tipCantScan')}</li>
                    <li>{t('addAccount.tipKeyExample')} <code className="bg-blue-100 dark:bg-blue-900/40 px-1 py-0.5 rounded">JBSWY3DPEHPK3PXP</code></li>
                    <li>{t('addAccount.tipKeyLength')}</li>
                  </ul>
                </div>
              </div>

              {/* Advanced Settings Toggle */}
              <div>
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-200 font-medium hover:underline"
                >
                  {showAdvanced ? `▼ ${t('addAccount.advanced')}` : `▶ ${t('addAccount.advanced')}`}
                </button>
              </div>

              {showAdvanced && (
                <div className="space-y-4 pt-2">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      {t('addAccount.issuer')}
                    </label>
                    <input
                      type="text"
                      value={issuer}
                      onChange={(e) => setIssuer(e.target.value)}
                      placeholder={t('addAccount.issuerPlaceholder')}
                      className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500"
                    />
                  </div>

                  <div className="grid grid-cols-3 gap-3">
                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      {t('addAccount.algorithm')}
                    </label>
                    <select
                      value={algorithm}
                      onChange={(e) => setAlgorithm(e.target.value as any)}
                      className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all"
                    >
                      <option value="SHA1">SHA1</option>
                      <option value="SHA256">SHA256</option>
                      <option value="SHA512">SHA512</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      {t('addAccount.digits')}
                    </label>
                    <select
                      value={digits}
                      onChange={(e) => setDigits(parseInt(e.target.value) as any)}
                      className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all"
                    >
                      <option value="6">6</option>
                      <option value="8">8</option>
                    </select>
                  </div>

                  <div>
                    <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                      {t('addAccount.period')}
                    </label>
                    <input
                      type="number"
                      value={period}
                      onChange={(e) => setPeriod(parseInt(e.target.value))}
                      className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all"
                    />
                  </div>
                  </div>
                </div>
              )}

              {/* Last field before the button: the only optional one on this
                  form, and an empty box above the name and the secret reads as
                  another thing that has to be filled in. */}
              <GroupInput
                inputId="add-account-group"
                value={group}
                onChange={setGroup}
                groups={groups}
                language={language}
              />

              {error && (
                <div ref={errorRef} className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                </div>
              )}

              <button
                type="submit"
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
              >
                {t('addAccount.add')}
              </button>
            </form>
          ) : (
            <div className="space-y-3">

              {/* Drag and Drop Upload Area */}
              <div
                onDragOver={handleDragOver}
                onDragLeave={handleDragLeave}
                onDrop={handleDrop}
                className={`border-2 border-dashed rounded-lg p-4 text-center transition-all ${
                  isDragging
                    ? 'border-[#4285F4] bg-blue-50 dark:bg-blue-900/20'
                    : 'border-gray-300 dark:border-dark-500 hover:border-gray-400 dark:hover:border-dark-400'
                }`}
              >
                <Upload className="mx-auto mb-2 text-gray-400 dark:text-gray-500" size={28} />
                <p className="text-gray-600 dark:text-gray-300 text-sm mb-1 font-medium">
                  {isDragging ? t('addAccount.dragDropQR') : t('addAccount.uploadQR')}
                </p>
                <p className="text-gray-500 dark:text-gray-400 text-xs mb-2.5">
                  {t('addAccount.orClickToUpload')}
                </p>
                <label className="inline-block">
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleQRUpload}
                    className="hidden"
                  />
                  <span className="inline-block bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-1.5 px-5 rounded-lg cursor-pointer transition-colors">
                    {t('addAccount.chooseImage')}
                  </span>
                </label>
              </div>

              {/* Scan from screen */}
              <div className="relative flex items-center justify-center">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200 dark:border-dark-600"></div>
                </div>
                <span className="relative bg-white dark:bg-dark-800 px-3 text-xs text-gray-500 dark:text-gray-400">{t('accounts.or')}</span>
              </div>

              <button
                onClick={() => chrome.tabs.create({ url: chrome.runtime.getURL('scan.html') })}
                className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 hover:bg-gray-50 dark:hover:bg-dark-600 text-gray-700 dark:text-gray-200 font-medium text-sm transition-all"
              >
                <Camera size={16} />
                {t('addAccount.scanWithCamera')}
              </button>

              <button
                onClick={handleScanFromScreen}
                disabled={scanning}
                className="w-full flex items-center justify-center gap-2 py-2 px-4 rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 hover:bg-gray-50 dark:hover:bg-dark-600 text-gray-700 dark:text-gray-200 font-medium text-sm transition-all disabled:opacity-50"
              >
                {scanning ? (
                  <Loader2 size={16} className="animate-spin" />
                ) : (
                  <Monitor size={16} />
                )}
                {t('addAccount.scanFromScreen')}
              </button>

              {/* Info */}
              <div className="bg-blue-50 dark:bg-blue-900/20 border border-blue-200 dark:border-blue-800 rounded-lg p-2">
                <p className="text-blue-700 dark:text-blue-300 text-xs">
                  <span className="font-semibold">{t('addAccount.tipLabel')}</span> {t('addAccount.tipScanInfo')}
                </p>
              </div>

              {/* Error Display */}
              {error && (
                <div ref={errorRef} className="bg-red-50 dark:bg-red-900/20 border border-red-200 dark:border-red-800 rounded-lg p-3">
                  <p className="text-red-600 dark:text-red-400 text-sm">{error}</p>
                </div>
              )}
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
