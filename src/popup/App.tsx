import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Settings, AlertTriangle, HelpCircle, Moon, Sun } from 'lucide-react';
import { Html5Qrcode } from 'html5-qrcode';
import { useAccounts } from '@/hooks/useAccounts';
import { AccountCard, type ViewMode } from '@/components/AccountCard';
import { SearchBar } from '@/components/SearchBar';
import { AddAccountModal } from '@/components/AddAccountModal';
import { ExportImport } from '@/components/ExportImport';
import { FAQ } from '@/components/FAQ';
import { ReviewPrompt } from '@/components/ReviewPrompt';
import { EditAccountModal } from '@/components/EditAccountModal';
import { BackupReminder } from '@/components/BackupReminder';
import { Logo } from '@/components/Logo';
import { LanguageSelector } from '@/components/LanguageSelector';
import { getTimeSyncMessage } from '@/utils/time-sync';
import { createT, type Language } from '@/utils/i18n';
import { importAccounts, addMultipleAccounts, exportAccounts, getAccounts } from '@/utils/storage';
import { shouldShowBackupReminder, markBackupDone } from '@/utils/backup-reminder';
import { parseQRCode, generateRandomColor } from '@/utils/qr-parser';
import { cleanSecret } from '@/utils/totp';
import type { Account } from '@/types';

function App() {
  const { accounts, loading, error, addAccount, deleteAccount, updateAccount, reorderAccounts, reload } = useAccounts();
  const [searchQuery, setSearchQuery] = useState('');
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [showFAQ, setShowFAQ] = useState(false);
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const [timeWarning, setTimeWarning] = useState<string | null>(null);
  const [language, setLanguage] = useState<Language>('en');
  const [darkMode, setDarkMode] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('normal');
  const draggedIdRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Load saved preferences
  useEffect(() => {
    chrome.storage.local.get(['language', 'darkMode', 'viewMode'], (result) => {
      if (result.language) {
        setLanguage(result.language);
      }
      if (result.darkMode) {
        setDarkMode(true);
      }
      if (result.viewMode) {
        setViewMode(result.viewMode);
      }
    });
  }, []);

  const handleLanguageChange = (lang: Language) => {
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

  const handleAddAccount = async (account: Account | Account[]) => {
    if (Array.isArray(account)) {
      await addMultipleAccounts(account);
      reload();
    } else {
      await addAccount(account);
    }
  };

  const handleDeleteAccount = async (id: string) => {
    const account = accounts.find(a => a.id === id);
    const confirmMessage = t('accounts.deleteConfirmMsg', account?.issuer || '', account?.name || '');

    if (confirm(confirmMessage)) {
      await deleteAccount(id);
    }
  };

  const handleEditAccount = async (id: string, updates: Partial<Account>) => {
    await updateAccount(id, updates);
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
        const text = await file.text();
        await importAccounts(text);
        const currentAccounts = await getAccounts();
        await markBackupDone(currentAccounts.length);
        setShowBackupReminder(false);
        reload();
        alert(t('import.success'));
      }
    } catch (error) {
      console.error('Import failed:', error);
      alert(t('import.failed'));
    }

    e.target.value = '';
  };

  const handleQRImport = async (file: File) => {
    try {
      const html5QrCode = new Html5Qrcode('qr-reader-import-app');
      const result = await html5QrCode.scanFile(file, false);

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

        await addMultipleAccounts(accountsToAdd);
        reload();
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
      if (result.reviewDismissed) return;
      const count = (result.openCount || 0) + 1;
      chrome.storage.local.set({ openCount: count });
      if (count === 5) {
        setShowReviewPrompt(true);
      }
    });
  }, []);

  // Check if backup reminder should be shown
  useEffect(() => {
    if (!loading && accounts.length > 0) {
      shouldShowBackupReminder(accounts.length).then(setShowBackupReminder);
    }
  }, [loading, accounts.length]);

  const handleBackupFromReminder = async () => {
    try {
      const data = await exportAccounts();
      const accountsData = JSON.parse(data);
      const currentAccounts = await getAccounts();

      const exportData = {
        version: '2.0',
        exportDate: new Date().toISOString(),
        accountCount: accountsData.length,
        accounts: accountsData
      };

      const blob = new Blob([JSON.stringify(exportData, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = `authenticator-backup-${Date.now()}.json`;
      a.click();
      URL.revokeObjectURL(url);

      await markBackupDone(currentAccounts.length);
      setShowBackupReminder(false);
    } catch (err) {
      console.error('Backup from reminder failed:', err);
    }
  };

  useEffect(() => {
    getTimeSyncMessage().then(message => {
      if (message) {
        setTimeWarning(message);
      }
    });
  }, []);

  return (
    <div className={`w-[400px] min-h-[500px] max-h-[600px] overflow-hidden flex flex-col ${darkMode ? 'dark' : ''}`}>
      <div className="flex-1 flex flex-col bg-white dark:bg-dark-900 overflow-hidden">
      <div id="qr-reader-import-app" className="hidden"></div>

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

      {timeWarning && !error && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 p-3 flex items-start gap-2">
          <AlertTriangle className="text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" size={16} />
          <div className="text-xs text-yellow-800 dark:text-yellow-300 flex-1">
            {timeWarning}
          </div>
        </div>
      )}

      {/* Backup Reminder */}
      {showBackupReminder && !error && !timeWarning && (
        <BackupReminder
          language={language}
          onExport={handleBackupFromReminder}
          onDismiss={() => setShowBackupReminder(false)}
        />
      )}

      {/* Settings Panel */}
      {showSettings && (
        <div className="p-4 bg-gray-50 dark:bg-dark-800 border-b border-gray-200 dark:border-dark-600">
          <h3 className="text-gray-900 dark:text-gray-100 font-medium mb-3 text-sm">{t('settings.backupRestore')}</h3>
          <ExportImport onImportComplete={reload} onExportComplete={() => setShowBackupReminder(false)} language={language} />

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
        </div>
      )}

      {/* FAQ Panel */}
      {showFAQ && <FAQ language={language} />}

      {/* Accounts List */}
      <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-dark-900">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300"></div>
          </div>
        ) : showFAQ ? (
          null
        ) : filteredAccounts.length === 0 ? (
          <div className="flex flex-col items-center justify-center h-[340px] text-center p-6">
            <Logo size={48} className="mb-3 opacity-30" />
            <h2 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">
              {searchQuery ? t('accounts.noAccountsFound') : t('accounts.noAccounts')}
            </h2>
            {searchQuery ? (
              <p className="text-gray-500 dark:text-gray-400 text-xs mb-4">{t('accounts.tryDifferentSearch')}</p>
            ) : (
              <>
                <div className="bg-blue-50 dark:bg-blue-900/20 rounded-lg p-3 mb-4 text-left max-w-xs">
                  <p className="text-xs text-gray-700 dark:text-gray-300 mb-2 font-medium">{t('accounts.howToAdd')}</p>
                  <ol className="text-xs text-gray-600 dark:text-gray-400 space-y-1 list-decimal list-inside">
                    <li>{t('accounts.step1')}</li>
                    <li>{t('accounts.step2')}</li>
                    <li>{t('accounts.step3')}</li>
                    <li>{t('accounts.step4')}</li>
                  </ol>
                </div>
                <div className="flex flex-col items-center gap-2">
                  <button
                    onClick={() => setShowAddModal(true)}
                    className="bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2 px-4 rounded-lg transition-colors"
                  >
                    {t('accounts.addAccount')}
                  </button>
                  <div className="flex items-center gap-2 text-xs text-gray-500 dark:text-gray-400">
                    <span>{t('accounts.or')}</span>
                    <button
                      onClick={handleImportClick}
                      className="text-[#4285F4] hover:text-[#3367D6] font-medium hover:underline"
                    >
                      {t('accounts.importFromBackup')}
                    </button>
                  </div>
                </div>
              </>
            )}
          </div>
        ) : (
          <div className="bg-white dark:bg-dark-800 pb-20">
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
              />
            ))}
          </div>
        )}
      </div>

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

      {/* Review Prompt */}
      {showReviewPrompt && (
        <ReviewPrompt
          onClose={() => setShowReviewPrompt(false)}
          language={language}
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
      </div>
    </div>
  );
}

export default App;
