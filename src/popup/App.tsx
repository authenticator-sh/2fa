import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Settings, AlertTriangle, HelpCircle, Moon, Sun, Sparkles } from 'lucide-react';
import { useAccounts } from '@/hooks/useAccounts';
import { useVault } from '@/hooks/useVault';
import { AccountCard, type ViewMode } from '@/components/AccountCard';
import { SearchBar } from '@/components/SearchBar';
import { AddAccountModal } from '@/components/AddAccountModal';
import { ExportImport, importBackupText } from '@/components/ExportImport';
import { FAQ } from '@/components/FAQ';
import { EditAccountModal } from '@/components/EditAccountModal';
import { BackupReminder } from '@/components/BackupReminder';
import { UpdateModal } from '@/components/UpdateModal';
import { PromoBanner } from '@/components/PromoBanner';
import { Logo } from '@/components/Logo';
import { LanguageSelector } from '@/components/LanguageSelector';
import { SettingToggle } from '@/components/SettingToggle';
import { LockScreen } from '@/components/LockScreen';
import { VaultPrompt } from '@/components/VaultPrompt';
import { VaultSettings } from '@/components/VaultSettings';
import { VaultSetupModal } from '@/components/VaultSetupModal';
import { EmptyStateGuide } from '@/components/EmptyStateGuide';
import { getTimeSyncNotice, dismissTimeNotice } from '@/utils/time-sync';
import { createT, loadLanguage, type Language } from '@/utils/i18n';
import { addMultipleAccounts, getAccounts } from '@/utils/storage';
import { shouldShowBackupReminder, markBackupDone } from '@/utils/backup-reminder';
import { shouldShowVaultPrompt, markVaultPromptShown } from '@/utils/vault-prompt';
import { describeImport } from '@/utils/import-message';
import { confirmDialog, promptDialog, toast } from '@/utils/ui-feedback';
import { FeedbackHost } from '@/components/FeedbackHost';
import { shouldShowPromoBanner, recordFirstOpen } from '@/utils/promo-banner';
import { parseQRCode, generateRandomColor } from '@/utils/qr-parser';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { cleanSecret, loadTimeOffset } from '@/utils/totp';
import { getSuggestedAccountId, getBaseDomain, areSuggestionsEnabled, setSuggestionsEnabled } from '@/utils/suggestions';
import { isSyncEnabled, setSyncEnabled } from '@/utils/storage';
import { WHATS_NEW } from '@/utils/update-notes';
import type { Account } from '@/types';

// Straight to the Web Store review form: authenticator.sh/rate is a landing
// page, and every extra hop between "tapped 4 stars" and the review box costs
// reviews.
const REVIEW_URL = 'https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd/reviews';
const FEEDBACK_URL = 'https://authenticator.sh/rate';

function App() {
  const vault = useVault();
  const { accounts, loading, error, addAccount, deleteAccount, updateAccount, reorderAccounts, reload } =
    // Unknown vault state counts as locked. `enabled` starts as null while
    // storage is read, and `null === true` is false — so the account list used
    // to start loading in parallel with the vault check and could win the race,
    // painting live codes over a locked vault.
    useAccounts(vault.enabled === null || (vault.enabled && vault.locked));
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFAQ, setShowFAQ] = useState(false);
  const [faqOpenId, setFaqOpenId] = useState<string | null>(null);
  const [timeOffsetSec, setTimeOffsetSec] = useState<number | null>(null);
  const [language, setLanguage] = useState<Language>('en');
  const [darkMode, setDarkMode] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [showVaultPrompt, setShowVaultPrompt] = useState(false);
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [suggestionsOn, setSuggestionsOn] = useState(true);
  const [syncOn, setSyncOn] = useState(true);
  const [viewMode, setViewMode] = useState<ViewMode>('normal');
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  const [suggestedAccountId, setSuggestedAccountId] = useState<string | null>(null);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  const [showPromoBanner, setShowPromoBanner] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const draggedIdRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Load saved preferences
  useEffect(() => {
    chrome.storage.local.get(['language', 'darkMode', 'viewMode'], (result) => {
      if (result.language) {
        // Switch only once the chunk is in memory, otherwise the first paint
        // would be English and then visibly flip.
        loadLanguage(result.language).then(() => setLanguage(result.language));
      }
      if (result.darkMode) {
        setDarkMode(true);
      }
      if (result.viewMode) {
        setViewMode(result.viewMode);
      }
    });
  }, []);

  useEffect(() => {
    areSuggestionsEnabled().then(setSuggestionsOn);
    isSyncEnabled().then(setSyncOn);
  }, []);

  const handleSyncToggle = async () => {
    const next = !syncOn;
    setSyncOn(next);
    await setSyncEnabled(next);
    toast('success', t('vault.settings.saved'));
  };

  const handleSuggestionsToggle = async () => {
    const next = !suggestionsOn;
    setSuggestionsOn(next);
    await setSuggestionsEnabled(next);
    if (!next) setSuggestedAccountId(null);
  };

  // Show the "What's New" modal once after an update, if we have copy for it
  useEffect(() => {
    chrome.storage.local.get('pendingWhatsNew', (result) => {
      const version = result.pendingWhatsNew;
      if (version && WHATS_NEW[version]) {
        setWhatsNewVersion(version);
      }
    });
  }, []);

  const handleCloseWhatsNew = () => {
    if (whatsNewVersion) {
      chrome.storage.local.set({ lastSeenWhatsNewVersion: whatsNewVersion });
    }
    chrome.storage.local.remove('pendingWhatsNew');
    setWhatsNewVersion(null);
  };

  const handleLanguageChange = async (lang: Language) => {
    await loadLanguage(lang);
    setLanguage(lang);
    chrome.storage.local.set({ language: lang });
  };

  const handleThemeToggle = () => {
    const newDarkMode = !darkMode;
    setDarkMode(newDarkMode);
    chrome.storage.local.set({ darkMode: newDarkMode });
  };

  const t = createT(language);

  const filteredAccounts = useMemo(() => {
    if (!searchQuery) return accounts;
    const query = searchQuery.toLowerCase();
    return accounts.filter(
      (acc) =>
        acc.name.toLowerCase().includes(query) ||
        acc.issuer.toLowerCase().includes(query)
    );
  }, [accounts, searchQuery]);

  // Pinning a duplicate on top only pays off when the list is long enough to
  // scroll; with few accounts the badge highlight in the list is enough.
  const suggestedAccount = !searchQuery && suggestedAccountId && accounts.length >= 5
    ? accounts.find(acc => acc.id === suggestedAccountId) || null
    : null;

  const handleAddAccount = async (account: Account | Account[]) => {
    if (Array.isArray(account)) {
      const result = await addMultipleAccounts(account);
      reload();
      toast(result.added > 0 ? 'success' : 'info', describeImport(result, language));
    } else {
      await addAccount(account);
      toast('success', t('accounts.added'));
    }
  };

  const handleDeleteAccount = async (id: string) => {
    const account = accounts.find(a => a.id === id);
    const confirmed = await confirmDialog({
      title: t('accounts.deleteAccount'),
      body: t('accounts.deleteConfirmMsg', account?.issuer || '', account?.name || ''),
      confirmLabel: t('accounts.deleteAccount'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });

    if (confirmed) {
      await deleteAccount(id);
      toast('success', t('accounts.deleted'));
    }
  };

  const handleEditAccount = async (id: string, updates: Partial<Account>) => {
    await updateAccount(id, updates);
    toast('success', t('accounts.updated'));
  };

  const handleDragStart = (_e: React.DragEvent, id: string) => {
    draggedIdRef.current = id;
  };

  const handleDrop = async (_e: React.DragEvent, targetId: string) => {
    const draggedId = draggedIdRef.current;
    if (!draggedId || draggedId === targetId) {
      setDragOverId(null);
      return;
    }

    const newOrder = [...accounts.map(a => a.id)];
    const fromIndex = newOrder.indexOf(draggedId);
    const toIndex = newOrder.indexOf(targetId);
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, draggedId);

    await reorderAccounts(newOrder);
    draggedIdRef.current = null;
    setDragOverId(null);
  };

  const handleImportClick = () => {
    importInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
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
          const currentAccounts = await getAccounts();
          await markBackupDone(currentAccounts.length);
          setShowBackupReminder(false);
          reload();
          toast('success', t('import.success'));
        }
      }
    } catch (error) {
      console.error('Import failed:', error);
      toast(
        'error',
        error instanceof Error && error.name === 'WrongExportPasswordError'
          ? t('import.wrongPassword')
          : t('import.failed')
      );
    }

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
        }));

        const result = await addMultipleAccounts(accountsToAdd);
        reload();
        toast(result.added > 0 ? 'success' : 'info', describeImport(result, language));
      } else {
        throw new Error(t('addAccount.errorInvalidQR'));
      }
    } catch (error) {
      console.error('QR import failed:', error);
      const errorMessage = error instanceof Error ? error.message : String(error);
      toast('error', t('import.qrFailed', errorMessage));
    }
  };

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      if (!isInputFocused && !showAddModal && !showSettings && !showFAQ && searchInputRef.current) {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          searchInputRef.current.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, showSettings, showFAQ]);

  useEffect(() => {
    chrome.storage.local.get(['openCount', 'reviewDismissed'], (result) => {
      setReviewDismissed(!!result.reviewDismissed);
      if (result.reviewDismissed) return;
      const count = (result.openCount || 0) + 1;
      chrome.storage.local.set({ openCount: count });
    });
  }, []);

  // Happy users go straight to the Web Store review box; unhappy ones go to our
  // own feedback page instead, where the complaint reaches us rather than
  // becoming a public one-star review.
  const handleRate = (stars: number) => {
    chrome.storage.local.set({ reviewDismissed: true });
    setReviewDismissed(true);
    chrome.tabs.create({ url: stars >= 4 ? REVIEW_URL : FEEDBACK_URL });
  };

  // Check if backup reminder should be shown
  useEffect(() => {
    if (!loading && accounts.length > 0) {
      shouldShowBackupReminder(accounts.length).then(setShowBackupReminder);
    }
  }, [loading, accounts.length]);

  // Offer the password vault once there are enough accounts to be worth
  // protecting — see vault-prompt.ts for the reasoning behind the timing.
  useEffect(() => {
    if (loading || vault.enabled === null) return;
    shouldShowVaultPrompt(accounts.length, vault.enabled).then(show => {
      setShowVaultPrompt(show);
      if (show) markVaultPromptShown();
    });
  }, [loading, accounts.length, vault.enabled]);

  // Cross-promo banner — only for users active for at least a week
  useEffect(() => {
    recordFirstOpen().then(() => shouldShowPromoBanner().then(setShowPromoBanner));
  }, []);

  // Opens the settings panel rather than exporting straight away: since 1.10.0
  // the user has to choose between a password-protected and a plain file, and
  // silently writing the plain one would undo the vault for anyone who enabled it.
  const handleBackupFromReminder = () => {
    setShowSettings(true);
    setShowFAQ(false);
    setShowBackupReminder(false);
  };

  useEffect(() => {
    // Restore any persisted clock correction first so codes are already adjusted,
    // then run the network re-check which refines/clears it and decides the notice.
    loadTimeOffset().then(() => {
      getTimeSyncNotice().then(setTimeOffsetSec);
    });
  }, []);

  // Read the active tab's site (activeTab permission — granted for this popup invocation)
  useEffect(() => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      const url = tabs[0]?.url;
      if (!url) return;
      try {
        setCurrentDomain(new URL(url).hostname);
      } catch {
        // Non-http(s) tab (e.g. chrome://, file://) — no domain to suggest against.
      }
    });
  }, []);

  useEffect(() => {
    if (!currentDomain || accounts.length === 0) {
      setSuggestedAccountId(null);
      return;
    }
    getSuggestedAccountId(currentDomain, accounts).then(setSuggestedAccountId);
  }, [currentDomain, accounts, suggestionsOn]);

  // Nothing renders until we know whether there is a vault: the alternative is
  // a flash of either the account list or the "no accounts yet" empty state,
  // and on a 2FA app the latter reads as "my accounts are gone".
  if (vault.enabled === null) {
    return (
      <div className={`w-[400px] min-h-[500px] max-h-[600px] flex items-center justify-center bg-white dark:bg-dark-900 ${darkMode ? 'dark' : ''}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300" />
      </div>
    );
  }

  // A locked vault replaces the whole UI: no account list, no search, no
  // add button. useAccounts has already dropped the decrypted accounts from
  // state, so there is nothing here to leak.
  if (vault.enabled === true && vault.locked) {
    return (
      <div className={`w-[400px] min-h-[500px] max-h-[600px] overflow-hidden flex flex-col ${darkMode ? 'dark' : ''}`}>
        <div className="flex-1 flex flex-col bg-white dark:bg-dark-900 overflow-hidden">
          <div className="bg-white dark:bg-dark-900 border-b border-gray-200 dark:border-dark-700 p-4">
            <div className="flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Logo size={24} />
                <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('app.title')}</h1>
              </div>
              <div className="flex items-center gap-1">
                <button
                  onClick={handleThemeToggle}
                  className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
                  title={t('theme.toggle')}
                >
                  {darkMode ? <Sun className="text-yellow-400" size={18} /> : <Moon className="text-gray-600" size={18} />}
                </button>
                <LanguageSelector language={language} onLanguageChange={handleLanguageChange} />
              </div>
            </div>
          </div>
          <LockScreen language={language} onUnlock={vault.unlock} onRecovered={vault.refresh} />
          <FeedbackHost />
        </div>
      </div>
    );
  }

  return (
    <div className={`w-[400px] min-h-[500px] max-h-[600px] overflow-hidden flex flex-col ${darkMode ? 'dark' : ''}`}>
      <div className="flex-1 flex flex-col bg-white dark:bg-dark-900 overflow-hidden">

      {/* Header */}
      <div className="bg-white dark:bg-dark-900 border-b border-gray-200 dark:border-dark-700 p-4">
        <div className="flex items-center justify-between">
          <div className="flex items-center gap-2">
            <Logo size={24} />
            <h1 className="text-lg font-semibold text-gray-900 dark:text-gray-100">{t('app.title')}</h1>
          </div>
          <div className="flex items-center gap-1">
            <button
              onClick={handleThemeToggle}
              className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
              title={t('theme.toggle')}
            >
              {darkMode ? (
                <Sun className="text-yellow-400" size={18} />
              ) : (
                <Moon className="text-gray-600" size={18} />
              )}
            </button>
            <LanguageSelector
              language={language}
              onLanguageChange={handleLanguageChange}
            />
            <button
              onClick={() => {
                setShowFAQ(!showFAQ);
                setShowSettings(false);
                setFaqOpenId(null);
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                showFAQ ? 'bg-gray-200 dark:bg-dark-600' : 'hover:bg-gray-100 dark:hover:bg-dark-700'
              }`}
              title={t('header.faq')}
            >
              <HelpCircle className="text-gray-600 dark:text-gray-400" size={18} />
            </button>
            <button
              onClick={() => {
                setShowSettings(!showSettings);
                setShowFAQ(false);
              }}
              className={`p-1.5 rounded-lg transition-colors ${
                showSettings ? 'bg-gray-200 dark:bg-dark-600' : 'hover:bg-gray-100 dark:hover:bg-dark-700'
              }`}
              title={t('header.settings')}
            >
              <Settings className="text-gray-600 dark:text-gray-400" size={18} />
            </button>
          </div>
        </div>

        {!showSettings && !showFAQ && <SearchBar ref={searchInputRef} className="mt-3" value={searchQuery} onChange={setSearchQuery} placeholder={t('search.placeholder')} />}
      </div>

      {/* Error/Warning Messages */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 p-3 flex items-start gap-2">
          <AlertTriangle className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" size={16} />
          <div className="text-xs text-red-800 dark:text-red-300 flex-1">
            {error}
          </div>
        </div>
      )}

      {timeOffsetSec !== null && !error && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 p-3 flex items-start gap-2">
          <AlertTriangle className="text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" size={16} />
          <div className="text-xs text-yellow-800 dark:text-yellow-300 flex-1">
            <div>{t('warning.clockOff', Math.max(1, Math.round(timeOffsetSec / 60)))}</div>
            <div className="flex items-center gap-3 mt-1.5">
              <button
                onClick={() => {
                  setShowSettings(false);
                  setShowFAQ(true);
                  setFaqOpenId('time-sync');
                }}
                className="font-medium text-yellow-900 dark:text-yellow-200 underline underline-offset-2 hover:text-yellow-950 dark:hover:text-yellow-100"
              >
                {t('warning.howToFix')}
              </button>
              <button
                onClick={() => {
                  dismissTimeNotice(timeOffsetSec);
                  setTimeOffsetSec(null);
                }}
                className="text-yellow-700 dark:text-yellow-400 hover:text-yellow-900 dark:hover:text-yellow-200"
              >
                {t('warning.dismiss')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Backup Reminder */}
      {showBackupReminder && !error && timeOffsetSec === null && (
        <BackupReminder
          language={language}
          onExport={handleBackupFromReminder}
          onDismiss={() => setShowBackupReminder(false)}
        />
      )}

      {/* Offer password protection — never at the same time as another notice */}
      {showVaultPrompt && !showBackupReminder && !error && timeOffsetSec === null && !showSettings && !showFAQ && (
        <VaultPrompt
          language={language}
          onEnable={() => {
            setShowVaultPrompt(false);
            setShowVaultSetup(true);
          }}
          onDismiss={() => setShowVaultPrompt(false)}
        />
      )}

      {/* Settings Panel — a screen of its own: it takes the scrollable area and
          the account list is not rendered underneath it. Codes and settings
          sharing one scroll made the popup read as a single long page. */}
      {showSettings && (
        <div className="flex-1 overflow-y-auto p-4 bg-gray-50 dark:bg-dark-800">
          <h3 className="text-gray-900 dark:text-gray-100 font-medium mb-3 text-sm">{t('settings.backupRestore')}</h3>
          <ExportImport onImportComplete={reload} onExportComplete={() => setShowBackupReminder(false)} language={language} />

          <SettingToggle
            label={t('settings.sync')}
            hint={t('settings.syncHint')}
            checked={syncOn}
            onChange={handleSyncToggle}
          />

          <SettingToggle
            label={t('settings.suggested')}
            hint={t('settings.suggestedHint')}
            checked={suggestionsOn}
            onChange={handleSuggestionsToggle}
          />

          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('settings.viewMode')}</span>
            <div className="flex bg-gray-200 dark:bg-dark-600 rounded-lg p-0.5">
              {([['normal', 'settings.viewNormal'], ['compact', 'settings.viewCompact'], ['hidden', 'settings.viewHidden']] as const).map(([mode, key]) => (
                <button
                  key={mode}
                  onClick={() => { setViewMode(mode as ViewMode); chrome.storage.local.set({ viewMode: mode }); }}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                    viewMode === mode ? 'bg-white dark:bg-dark-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'
                  }`}
                >
                  {t(key)}
                </button>
              ))}
            </div>
          </div>

          <VaultSettings
            language={language}
            enabled={vault.enabled === true}
            autoLockMinutes={vault.autoLockMinutes}
            onEnableClick={() => setShowVaultSetup(true)}
            onChanged={() => {
              vault.refresh();
              reload();
            }}
            onLock={() => vault.lock()}
            onAutoLockChange={vault.setAutoLockMinutes}
          />
        </div>
      )}

      {/* FAQ Panel */}
      {showFAQ && <FAQ language={language} openId={faqOpenId} />}

      {/* Accounts List */}
      {!showSettings && (
      <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-dark-900">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300"></div>
          </div>
        ) : showFAQ ? (
          null
        ) : filteredAccounts.length === 0 ? (
          searchQuery ? (
            <div className="flex flex-col items-center justify-center h-[340px] text-center p-6">
              <Logo size={48} className="mb-3 opacity-30" />
              <h2 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">
                {t('accounts.noAccountsFound')}
              </h2>
              <p className="text-gray-500 dark:text-gray-400 text-xs mb-4">
                {t('accounts.tryDifferentSearch')}
              </p>
            </div>
          ) : (
            <EmptyStateGuide
              language={language}
              onAddAccount={() => setShowAddModal(true)}
              onImport={handleImportClick}
              onScanWithCamera={() =>
                chrome.tabs.create({ url: chrome.runtime.getURL('scan.html') })
              }
            />
          )
        ) : (
          <div className="bg-white dark:bg-dark-800 pb-20">
            {suggestedAccount && (
              <>
                {/* AccountCard must stay the last child so its own `last:after:hidden`
                    divider rule kicks in — the section strip below handles separation. */}
                <div>
                  <div className="px-4 pt-2.5 pb-1 flex items-center gap-1.5 text-[11px] font-medium text-[#4285F4]">
                    <Sparkles size={12} />
                    <span>{t('accounts.suggested')}</span>
                    {currentDomain && (
                      <span className="text-gray-400 dark:text-gray-500 font-normal truncate">
                        · {getBaseDomain(currentDomain)}
                      </span>
                    )}
                  </div>
                  <AccountCard
                    key={`suggested-${suggestedAccount.id}`}
                    account={suggestedAccount}
                    onDelete={handleDeleteAccount}
                    onEdit={setEditingAccount}
                    language={language}
                    viewMode={viewMode}
                    draggable={false}
                    currentDomain={currentDomain}
                  />
                </div>
                <div className="h-2 bg-gray-100 dark:bg-dark-900 border-y border-gray-200 dark:border-dark-700" />
              </>
            )}
            {filteredAccounts.map((account) => (
              <AccountCard
                key={account.id}
                account={account}
                onDelete={handleDeleteAccount}
                onEdit={setEditingAccount}
                language={language}
                viewMode={viewMode}
                draggable={!searchQuery}
                onDragStart={handleDragStart}
                onDragOver={() => setDragOverId(account.id)}
                onDrop={handleDrop}
                isDragOver={dragOverId === account.id}
                currentDomain={currentDomain}
                isSuggested={!searchQuery && suggestedAccountId === account.id}
              />
            ))}
            {showPromoBanner && !searchQuery && (
              <PromoBanner language={language} onDismiss={() => setShowPromoBanner(false)} />
            )}
          </div>
        )}
      </div>
      )}

      {/* Add Button (Floating Action Button) */}
      {!showSettings && !showFAQ && accounts.length > 0 && (
        <button
          onClick={() => setShowAddModal(true)}
          className="fixed bottom-4 right-4 w-14 h-14 bg-[#4285F4] hover:bg-[#3367D6] text-white rounded-full shadow-lg hover:shadow-xl transition-all flex items-center justify-center"
          title={t('accounts.addAccount')}
        >
          <Plus size={24} />
        </button>
      )}

      {/* Add Account Modal */}
      {showAddModal && (
        <AddAccountModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddAccount}
          language={language}
        />
      )}

      {/* Edit Account Modal */}
      {editingAccount && (
        <EditAccountModal
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSave={handleEditAccount}
          language={language}
        />
      )}

      {/* Password Vault Setup */}
      {showVaultSetup && (
        <VaultSetupModal
          language={language}
          onClose={() => setShowVaultSetup(false)}
          onEnabled={() => {
            vault.refresh();
            reload();
          }}
        />
      )}

      {/* What's New Modal */}
      {whatsNewVersion && (
        <UpdateModal
          version={whatsNewVersion}
          language={language}
          onClose={handleCloseWhatsNew}
          reviewDismissed={reviewDismissed}
          onRate={handleRate}
        />
      )}


      {/* Hidden Import Input */}
      <input
        ref={importInputRef}
        type="file"
        accept="application/json,image/*"
        onChange={handleImportFile}
        className="hidden"
      />

      <FeedbackHost />
      </div>
    </div>
  );
}

export default App;
