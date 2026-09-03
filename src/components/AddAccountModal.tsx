import { useState, useRef, useEffect } from 'react';
import { Upload, Monitor, Loader2, Camera, ChevronDown } from 'lucide-react';
import type { Account } from '@/types';
import { validateSecret, cleanSecret } from '@/utils/totp';
import { parseQRCode, parseOTPAuthURL, generateRandomColor, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { captureCurrentTab } from '@/utils/screen-capture';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { ModalHeader } from './ModalHeader';
import { GroupInput } from './GroupInput';
import { createT, type Language } from '@/utils/i18n';
import { looksLikeURIList } from '@/utils/uri-import';

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

/** Every text field on this form. */
const FIELD =
  'w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 outline-none transition-all placeholder-gray-400 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 dark:border-dark-600 dark:bg-dark-900 dark:text-gray-100 dark:placeholder-gray-500';

export function AddAccountModal({ onClose, onAdd, language, groups = [], defaultGroup = '' }: AddAccountModalProps) {
  const t = createT(language);
  const [tab, setTab] = useState<'manual' | 'qr'>('qr');
  const [name, setName] = useState('');
  const [issuer, setIssuer] = useState('');
  const [group, setGroup] = useState(defaultGroup);
  const [secret, setSecret] = useState('');
  const [algorithm, setAlgorithm] = useState<'SHA1' | 'SHA256' | 'SHA512'>('SHA1');
  const [digits, setDigits] = useState<number>(6);
  const [period, setPeriod] = useState(30);
  const [error, setError] = useState('');
  const fileInputRef = useRef<HTMLInputElement>(null);
  const [showAdvanced, setShowAdvanced] = useState(false);
  // Folded away by default. Someone pasting a key they already have does not
  // need four lines telling them where to get one, and open by default it
  // pushed the Add button off the bottom of the modal.
  const [showKeyHelp, setShowKeyHelp] = useState(false);
  const [isDragging, setIsDragging] = useState(false);
  const [scanning, setScanning] = useState(false);
  /** A save in flight — the form stays open and the button stays busy. */
  const [saving, setSaving] = useState(false);
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

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (saving) return;
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

    // Awaited, and its failure shown.
    //
    // This was `onAdd(account); onClose();` — the promise dropped on the floor
    // and the modal closed regardless. A vault that locked while the form was
    // open, a storage write refused by quota, a concurrent write: every one of
    // them ended with the modal gone, no message, and nothing saved. The user
    // had just typed a seed off an enrolment page that only shows it once. The
    // QR branch of this same component has always awaited inside a try/catch;
    // only the hand-typed path did not.
    setSaving(true);
    try {
      await onAdd(account);
      onClose();
    } catch (err) {
      console.error('Could not save the account:', err);
      setError(t('addAccount.errorSaveFailed'));
    } finally {
      setSaving(false);
    }
  };

  const handleClose = () => {
    onClose();
  };

  /**
   * The secret field also accepts a whole otpauth:// link.
   *
   * Someone holding one link opens "Add account", and until now the only thing
   * here was a form asking for the pieces separately — so they took the URL
   * apart by hand to fill it in. The parser that reads QR codes reads exactly
   * this string; the field just had to offer it. Anything that is not a link
   * stays a secret, as before.
   */
  const handleSecretChange = (value: string) => {
    setSecret(value);
    const trimmed = value.trim();
    // Same predicate the two file inputs use, imported rather than re-typed:
    // three copies of "is this a list of links" is how they stop agreeing.
    if (!looksLikeURIList(trimmed)) return;

    // One form holds one account. A migration link holds however many the user
    // exported, so saying where they go is more use than failing quietly.
    if (/^otpauth-migration:\/\//i.test(trimmed)) {
      setError(t('addAccount.pastedMigration'));
      return;
    }

    try {
      const parsed = parseOTPAuthURL(trimmed);
      if (!parsed) return;
      setName(parsed.name);
      // "Unknown" is what the parser invents for a link with no issuer at all;
      // it is not a name to put in front of the user as if they had typed it.
      setIssuer(parsed.issuer === 'Unknown' ? '' : parsed.issuer);
      setSecret(parsed.secret);
      setAlgorithm(parsed.algorithm);
      setDigits(parsed.digits);
      setPeriod(parsed.period);
      setError('');
      // Opened, not applied silently: a link carrying 8 digits or a 60-second
      // period has just changed settings the user never touched, and finding
      // that out later — from codes that do not work — is worse than seeing it.
      if (parsed.algorithm !== 'SHA1' || parsed.digits !== 6 || parsed.period !== 30) {
        setShowAdvanced(true);
      }
    } catch (error) {
      // Understood and refused, not unreadable: the existing message says so.
      if (error instanceof UnsupportedOTPTypeError) setError(t('addAccount.errorHotp'));
    }
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
        // The scanned text is never shown. A QR that failed to parse is still
        // a QR somebody pointed at their secrets: a migration payload that
        // could not be read is base64 of real seeds, and an otpauth:// link
        // whose secret we rejected carries that secret in the query string.
        // Printing the first hundred characters put both on screen, in the one
        // flow people screen-share and screenshot for support. It also handed
        // a crafted code a hundred characters of attacker-chosen text inside
        // the extension's own chrome.
        console.error('Failed to parse QR code (content withheld)');
        setError(t('addAccount.errorInvalidQR'));
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
      className="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-dark-800"
      role="dialog"
      aria-modal="true"
      aria-label={t('addAccount.title')}
      onDragOver={handleModalDragOver}
      onDrop={handleModalDrop}
    >
      <ModalHeader title={t('addAccount.title')} back={t('common.back')} onBack={handleClose} />

      {/* max-w-md so the form does not stretch into a wide window or side
          panel; in the popup it simply fills it. */}
      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-md p-4">
          {/* The same segmented control Settings uses for view mode and popup
              size, only full width: a solid blue tab competed with the blue
              Add button for the eye, and this is a switch, not the action. */}
          <div className="mb-4 flex rounded-lg bg-gray-200 p-0.5 dark:bg-dark-600">
            {([['manual', 'addAccount.manual'], ['qr', 'addAccount.qrCode']] as const).map(([id, key]) => (
              <button
                key={id}
                onClick={() => handleTabChange(id)}
                className={`flex-1 rounded-md py-1.5 text-sm font-medium transition-colors ${
                  tab === id
                    ? 'bg-white text-gray-900 shadow-sm dark:bg-dark-800 dark:text-gray-100'
                    : 'text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-200'
                }`}
              >
                {t(key)}
              </button>
            ))}
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
                  className={FIELD}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t('addAccount.secretKey')}
                </label>
                <input
                  type="text"
                  value={secret}
                  onChange={(e) => handleSecretChange(e.target.value)}
                  placeholder={t('addAccount.secretKeyPlaceholder')}
                  className={`${FIELD} font-mono placeholder:font-sans`}
                />
                {/* The heading is the toggle, so the string is reused with its
                    trailing colon trimmed — in every language, rather than
                    twenty edited files. */}
                <button
                  type="button"
                  onClick={() => setShowKeyHelp(!showKeyHelp)}
                  className="mt-2 flex items-center gap-1 text-xs font-medium text-[#4285F4] transition-colors hover:text-[#3367D6]"
                >
                  <ChevronDown
                    size={13}
                    className={`transition-transform ${showKeyHelp ? 'rotate-180' : ''}`}
                  />
                  {t('addAccount.whereToFind').replace(/[:\uff1a]\s*$/, '')}
                </button>
                {showKeyHelp && (
                  <div className="mt-2 bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3">
                    <ul className="text-xs text-blue-800 dark:text-blue-400 space-y-1 list-disc list-inside">
                      <li>{t('addAccount.tipCantScan')}</li>
                      <li>{t('addAccount.tipKeyExample')} <code className="bg-blue-100 dark:bg-blue-900/40 px-1 py-0.5 rounded">JBSWY3DPEHPK3PXP</code></li>
                      <li>{t('addAccount.tipKeyLength')}</li>
                      {/* The field parses a pasted link (handleSecretChange), and
                          nothing else on the form said so — people were taking
                          the link apart by hand to fill in the pieces. */}
                      <li>{t('addAccount.tipPasteLink')}</li>
                    </ul>
                  </div>
                )}
              </div>

              {/* Advanced Settings Toggle */}
              <div>
                {/* The same chevron as the help above it: two disclosures a
                    line apart drawn in two different ways read as two
                    different kinds of control. */}
                <button
                  type="button"
                  onClick={() => setShowAdvanced(!showAdvanced)}
                  className="flex items-center gap-1 text-xs font-medium text-gray-600 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-200"
                >
                  <ChevronDown
                    size={13}
                    className={`transition-transform ${showAdvanced ? 'rotate-180' : ''}`}
                  />
                  {t('addAccount.advanced')}
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
                      className={FIELD}
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
                      className={FIELD}
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
                      onChange={(e) => setDigits(parseInt(e.target.value))}
                      className={FIELD}
                    >
                      <option value="6">6</option>
                      {digits !== 6 && digits !== 8 && <option value={digits}>{digits}</option>}
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
                      className={FIELD}
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
                disabled={saving}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] disabled:opacity-60 text-white font-medium text-sm py-2.5 rounded-lg transition-colors flex items-center justify-center gap-2"
              >
                {saving && <Loader2 size={16} className="animate-spin" />}
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
                {/* A real button, not a styled span in a label: the input it
                    opens is display:none, so neither the input nor the label
                    could take focus and the only way to this — the way in for
                    anyone whose camera cannot read a code — was the mouse. */}
                <input
                  ref={fileInputRef}
                  type="file"
                  accept="image/*"
                  onChange={handleQRUpload}
                  className="hidden"
                />
                <button
                  type="button"
                  onClick={() => fileInputRef.current?.click()}
                  className="inline-block bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-1.5 px-5 rounded-lg transition-colors"
                >
                  {t('addAccount.chooseImage')}
                </button>
              </div>

              {/* Scan from screen */}
              <div className="relative flex items-center justify-center">
                <div className="absolute inset-0 flex items-center">
                  <div className="w-full border-t border-gray-200 dark:border-dark-600"></div>
                </div>
                <span className="relative bg-gray-50 dark:bg-dark-800 px-3 text-xs text-gray-500 dark:text-gray-400">{t('accounts.or')}</span>
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
