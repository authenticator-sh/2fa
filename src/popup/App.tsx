import { useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Settings, AlertTriangle, HelpCircle, Moon, Sun, Sparkles } from 'lucide-react';
import { useAccounts } from '@/hooks/useAccounts';
import { useVault } from '@/hooks/useVault';
import { AccountCard, type ViewMode } from '@/components/AccountCard';
import { SearchBar } from '@/components/SearchBar';
import { AddAccountModal } from '@/components/AddAccountModal';
import { ExportImport, importBackupText, importResultMessage } from '@/components/ExportImport';
import { EditAccountModal } from '@/components/EditAccountModal';
import { BackupReminder } from '@/components/BackupReminder';
import { UpdateModal } from '@/components/UpdateModal';
import { PromoBanner } from '@/components/PromoBanner';
import { ReviewPrompt } from '@/components/ReviewPrompt';
import { Logo } from '@/components/Logo';
import { LanguageSelector } from '@/components/LanguageSelector';
import { SettingToggle } from '@/components/SettingToggle';
import { LockScreen } from '@/components/LockScreen';
import { VaultPrompt } from '@/components/VaultPrompt';
import { VaultSettings } from '@/components/VaultSettings';
import { VaultSetupModal } from '@/components/VaultSetupModal';
import { EmptyStateGuide } from '@/components/EmptyStateGuide';
import { AccountsUnavailable } from '@/components/AccountsUnavailable';
import { GroupFilter } from '@/components/GroupFilter';
import { SupportFooter } from '@/components/SupportFooter';
import { getTimeSyncNotice, dismissTimeNotice, getClockStatus, recheckClock, type ClockStatus } from '@/utils/time-sync';
import { applyDocumentLanguage, createT, detectLanguage, loadLanguage, type Language } from '@/utils/i18n';
import { addMultipleAccounts, getAccounts } from '@/utils/storage';
import { shouldShowBackupReminder, markBackupDone } from '@/utils/backup-reminder';
import { shouldShowVaultPrompt, markVaultPromptShown } from '@/utils/vault-prompt';
import { describeImport } from '@/utils/import-message';
import { confirmDialog, promptDialog, toast } from '@/utils/ui-feedback';
import { FeedbackHost } from '@/components/FeedbackHost';
import { shouldShowPromoBanner, recordFirstOpen } from '@/utils/promo-banner';
import { recordOpen, shouldShowReviewPrompt, snoozeReviewPrompt } from '@/utils/review-prompt';
import { readActiveGroup, rememberActiveGroup, forgetActiveGroup } from '@/utils/active-group';
import { helpUrl } from '@/utils/links';
import { parseQRCode, generateRandomColor, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { cleanSecret, loadTimeOffset } from '@/utils/totp';
import { getSuggestedAccountId, getBaseDomain, areSuggestionsEnabled, setSuggestionsEnabled } from '@/utils/suggestions';
import { isQuickFillEnabled, setQuickFillEnabled } from '@/utils/quick-fill';
import { isSyncEnabled, setSyncEnabled, hasSyncOverflowed } from '@/utils/storage';
import { WHATS_NEW } from '@/utils/update-notes';
import {
  cachedPopupSize,
  popupSizeStyle,
  readPopupSize,
  rememberPopupSize,
  type PopupSize,
} from '@/utils/popup-size';
import type { Account } from '@/types';

// Straight to the Web Store review form: authenticator.sh/rate is a landing
// page, and every extra hop between the prompt and the review box costs
// reviews.
const REVIEW_URL = 'https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd/reviews';

function App() {
  const vault = useVault();
  const { accounts, loading, error, heldCount, addAccount, deleteAccount, updateAccount, reorderAccounts, reload } =
    // Unknown vault state counts as locked. `enabled` starts as null while
    // storage is read, and `null === true` is false — so the account list used
    // to start loading in parallel with the vault check and could win the race,
    // painting live codes over a locked vault.
    useAccounts(vault.enabled === null || (vault.enabled && vault.locked));
  const [searchQuery, setSearchQuery] = useState('');
  // null — every account; '' — the ungrouped chip; otherwise a group name.
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  const [timeOffsetSec, setTimeOffsetSec] = useState<number | null>(null);
  // Separate from the banner's state on purpose: the banner appears only for a
  // measured, uncorrected-looking clock, while this carries all three outcomes
  // — including "we could not check", which has nowhere else to be seen.
  const [clockStatus, setClockStatus] = useState<ClockStatus | null>(null);
  const [clockChecking, setClockChecking] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  const [darkMode, setDarkMode] = useState(false);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [showVaultPrompt, setShowVaultPrompt] = useState(false);
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [suggestionsOn, setSuggestionsOn] = useState(true);
  const [quickFillOn, setQuickFillOn] = useState(true);
  const [syncOn, setSyncOn] = useState(true);
  const [syncOverflow, setSyncOverflow] = useState(false);
  const [viewMode, setViewMode] = useState<ViewMode>('normal');
  // Seeded from the synchronous mirror so the window opens at the chosen size
  // instead of resizing once chrome.storage answers.
  const [popupSize, setPopupSize] = useState<PopupSize>(cachedPopupSize);
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  const [suggestedAccountId, setSuggestedAccountId] = useState<string | null>(null);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  const [showPromoBanner, setShowPromoBanner] = useState(false);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const draggedIdRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);

  // Load saved preferences
  useEffect(() => {
    chrome.storage.local.get(['language', 'darkMode', 'viewMode', 'popupSize'], (result) => {
      // A stored language is a choice the user made and outranks everything.
      // Without one, follow the browser: twenty translated interfaces were
      // reachable only from a dropdown, so every install began in English no
      // matter who installed it.
      const language: Language = result.language || detectLanguage();
      if (language !== 'en') {
        // Switch only once the chunk is in memory, otherwise the first paint
        // would be English and then visibly flip.
        loadLanguage(language).then(() => setLanguage(language));
      }
      if (result.darkMode) {
        setDarkMode(true);
      }
      if (result.viewMode) {
        setViewMode(result.viewMode);
      }
      // chrome.storage is the source of truth; refresh the mirror from it in
      // case another device synced a different choice.
      const storedSize = readPopupSize(result.popupSize);
      if (storedSize) {
        setPopupSize(storedSize);
        rememberPopupSize(storedSize);
      }
    });
  }, []);

  // Mirrors the layout for right-to-left languages and names the language for
  // the font stack and screen readers. Runs on every change, including the
  // first paint's default of English.
  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  // Separate from the preferences read above: where this one lives depends on
  // whether a vault is configured, so it goes through its own module.
  useEffect(() => {
    readActiveGroup().then(group => {
      if (group !== null) setActiveGroup(group);
    });
  }, []);

  useEffect(() => {
    areSuggestionsEnabled().then(setSuggestionsOn);
    isQuickFillEnabled().then(setQuickFillOn);
    isSyncEnabled().then(setSyncOn);
    hasSyncOverflowed().then(setSyncOverflow);
  }, []);

  const handleSyncToggle = async () => {
    const next = !syncOn;
    setSyncOn(next);
    await setSyncEnabled(next);
    toast('success', t('vault.settings.saved'));
  };

  // The service worker watches this key and adds or removes the menu item
  // itself, so nothing here has to reach into it.
  const handleQuickFillToggle = async () => {
    const next = !quickFillOn;
    setQuickFillOn(next);
    await setQuickFillEnabled(next);
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

  const handlePopupSizeChange = (size: PopupSize) => {
    setPopupSize(size);
    rememberPopupSize(size);
    chrome.storage.local.set({ popupSize: size });
  };

  const handleThemeToggle = () => {
    const newDarkMode = !darkMode;
    setDarkMode(newDarkMode);
    chrome.storage.local.set({ darkMode: newDarkMode });
  };

  const t = createT(language);

  // Groups are derived from the accounts rather than stored alongside them:
  // nothing to migrate, nothing to keep in sync, and a group disappears by
  // itself once its last account is gone.
  const groups = useMemo(() => {
    const counts = new Map<string, number>();
    for (const account of accounts) {
      const name = account.group?.trim();
      if (name) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return [...counts.entries()]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([name, count]) => ({ name, count }));
  }, [accounts]);

  const ungroupedCount = useMemo(
    () => accounts.filter(account => !account.group?.trim()).length,
    [accounts]
  );

  const filteredAccounts = useMemo(() => {
    let list = accounts;

    if (activeGroup !== null) {
      list = list.filter(acc => (acc.group?.trim() ?? '') === activeGroup);
    }

    if (searchQuery) {
      const query = searchQuery.toLowerCase();
      list = list.filter(
        (acc) =>
          acc.name.toLowerCase().includes(query) ||
          acc.issuer.toLowerCase().includes(query)
      );
    }

    return list;
  }, [accounts, searchQuery, activeGroup]);

  // A filter is a claim about the whole list, so the pinned suggestion — which
  // ignores it — is dropped while one is active, the same as during a search.
  const isFiltered = Boolean(searchQuery) || activeGroup !== null;

  // Pinning a duplicate on top only pays off when the list is long enough to
  // scroll; with few accounts the badge highlight in the list is enough.
  const suggestedAccount = !isFiltered && suggestedAccountId && accounts.length >= 5
    ? accounts.find(acc => acc.id === suggestedAccountId) || null
    : null;

  // The strip carries its own bottom border, so the header drops its own while
  // the strip is up — two hairlines a chip's height apart read as clutter.
  //
  // Kept up while a filter is active even after its last group is gone: the
  // strip is the only control that can clear one, so hiding it on
  // `groups.length === 0` is how a user ends up staring at an empty list with
  // nothing on screen that explains it.
  const showGroupFilter =
    !showSettings && !loading && (groups.length > 0 || activeGroup !== null);

  const handleGroupChange = (group: string | null) => {
    setActiveGroup(group);
    rememberActiveGroup(group);
  };

  // useAccounts empties the list while the vault is locked or still unknown, so
  // an empty `accounts` in that state says nothing about what the user has.
  const vaultHidingAccounts = vault.enabled === null || (vault.enabled === true && vault.locked);

  /**
   * Drop the filter when it would hide an account the user just created.
   *
   * Adding while filtered normally inherits the filter, so the new account stays
   * in view. It does not when the user clears the prefilled group, when a QR
   * batch carries a different one, or when an edit moves an account out of the
   * group being shown. Each of those ends with a success toast and no visible
   * row, which on a 2FA app reads as the account having been lost.
   */
  const revealAccount = (account: Pick<Account, 'group'> | undefined) => {
    if (activeGroup === null || !account) return;
    if ((account.group?.trim() ?? '') === activeGroup) return;
    handleGroupChange(null);
  };

  // A filter left pinned to a group that no longer exists renders an empty list,
  // which on a 2FA app reads as lost accounts. Only ever runs once the accounts
  // are really loaded — resetting during the load or behind a locked vault would
  // throw away the choice on every open.
  //
  // The guard is the locked vault specifically, not `accounts.length === 0`:
  // deleting the last account in a group is exactly when the stale filter has to
  // go, and skipping that case left the popup with no chip strip (no groups), no
  // empty-state guide (`isFiltered`) and no add button — permanently, since the
  // filter is persisted.
  useEffect(() => {
    if (loading || activeGroup === null || vaultHidingAccounts) return;
    const stillExists = activeGroup === ''
      ? ungroupedCount > 0
      : groups.some(group => group.name === activeGroup);
    if (!stillExists) {
      setActiveGroup(null);
      forgetActiveGroup();
    }
  }, [loading, activeGroup, groups, ungroupedCount, vaultHidingAccounts]);

  const handleAddAccount = async (
    account: Account | Account[],
    batch?: { index: number; total: number }
  ) => {
    if (Array.isArray(account)) {
      const result = await addMultipleAccounts(account);
      reload();
      revealAccount(account[0]);
      // One batch carries one group, so the first entry speaks for all of them.
      // Worth naming: a scan started from inside a filtered list inherits that
      // filter silently, and "added" alone leaves the user to work out why the
      // accounts are nowhere to be seen once they clear the filter.
      const more = batch && batch.index < batch.total
        ? ` ${t('import.qrBatch', batch.index, batch.total)}`
        : '';
      toast(
        result.added > 0 ? 'success' : 'info',
        describeImport(result, language, account[0]?.group) + more
      );
    } else {
      await addAccount(account);
      revealAccount(account);
      toast('success', account.group ? t('accounts.addedToGroup', account.group) : t('accounts.added'));
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
    // Only when the group was actually touched: an edit that leaves it alone
    // cannot have moved the account out of the current filter.
    if ('group' in updates) revealAccount(updates);
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
          // Entries that could no longer be read are named rather than rounded
          // up to "successful" — a restore that quietly dropped rows is the one
          // case where the user needs to go looking for another copy.
          toast(
            imported.unreadable > 0 ? 'info' : 'success',
            importResultMessage(imported, language)
          );
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
        // A split Google Authenticator export is the common case for anyone with
        // more than ten accounts, and stopping after the first code is the
        // default mistake. Say which code this was.
        const more = parsed.batch && parsed.batch.index < parsed.batch.total
          ? ` ${t('import.qrBatch', parsed.batch.index, parsed.batch.total)}`
          : '';
        toast(result.added > 0 ? 'success' : 'info', describeImport(result, language) + more);
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

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';

      if (!isInputFocused && !showAddModal && !showSettings && searchInputRef.current) {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          searchInputRef.current.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [showAddModal, showSettings]);

  useEffect(() => {
    chrome.storage.local.get('reviewDismissed', (result) => setReviewDismissed(!!result.reviewDismissed));
    recordOpen().then(setOpenCount);
  }, []);

  // Held back until the accounts have loaded: an empty list during loading looks
  // exactly like "never finished setup", which is who the prompt must skip.
  useEffect(() => {
    if (loading || openCount === null) return;
    shouldShowReviewPrompt(openCount, accounts.length).then(setShowReviewPrompt);
  }, [loading, openCount, accounts.length]);

  const handleSnoozeReview = async () => {
    setShowReviewPrompt(false);
    if (openCount !== null) await snoozeReviewPrompt(openCount);
  };

  // Everyone who takes the prompt lands in the same place: the Web Store review
  // box. Asking for a rating inside the popup and then routing only the happy
  // answers to the store is review gating — the kind of thing an extension
  // holding people's 2FA secrets cannot afford to be delisted over. Whoever
  // wants to complain still has "Help & support" and "Request a feature" in the
  // footer of every screen.
  const handleRate = async () => {
    setReviewDismissed(true);
    setShowReviewPrompt(false);
    // Awaited before the tab is opened: creating a tab tears this page down, and
    // a dismissal that never reached disk means asking again someone who has
    // already left a review.
    await chrome.storage.local.set({ reviewDismissed: true }).catch(() => {});
    // The rating block lives inside the "What's New" modal too, and that modal
    // is re-armed from storage until it is explicitly closed.
    handleCloseWhatsNew();
    chrome.tabs.create({ url: REVIEW_URL });
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
    setShowBackupReminder(false);
  };

  useEffect(() => {
    // Restore any persisted clock correction first so codes are already adjusted,
    // then run the network re-check which refines/clears it and decides the notice.
    loadTimeOffset().then(() => {
      getTimeSyncNotice().then(setTimeOffsetSec);
      getClockStatus().then(setClockStatus);
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
      <div style={popupSizeStyle(popupSize)} className={`flex items-center justify-center bg-white dark:bg-dark-900 ${darkMode ? 'dark' : ''}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300" />
      </div>
    );
  }

  // A locked vault replaces the whole UI: no account list, no search, no
  // add button. useAccounts has already dropped the decrypted accounts from
  // state, so there is nothing here to leak.
  if (vault.enabled === true && vault.locked) {
    return (
      <div style={popupSizeStyle(popupSize)} className={`overflow-hidden flex flex-col ${darkMode ? 'dark' : ''}`}>
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
          <SupportFooter language={language} />
          <FeedbackHost />
        </div>
      </div>
    );
  }

  return (
    <div style={popupSizeStyle(popupSize)} className={`overflow-hidden flex flex-col ${darkMode ? 'dark' : ''}`}>
      <div className="flex-1 flex flex-col bg-white dark:bg-dark-900 overflow-hidden">

      {/* Header */}
      {/* With the chips up, the header's own bottom padding stacks on the strip's
          top padding — trimmed so search and chips read as one block. */}
      <div className={`flex-shrink-0 bg-white dark:bg-dark-900 p-4 ${showGroupFilter ? 'pb-2' : 'border-b border-gray-200 dark:border-dark-700'}`}>
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
            {/* Opens the help page rather than a panel: the answers live on the
                site now, in the reader's own language and with room to be read. */}
            <button
              onClick={() => chrome.tabs.create({ url: helpUrl(language) })}
              className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
              title={t('header.faq')}
            >
              <HelpCircle className="text-gray-600 dark:text-gray-400" size={18} />
            </button>
            <button
              onClick={() => setShowSettings(!showSettings)}
              className={`p-1.5 rounded-lg transition-colors ${
                showSettings ? 'bg-gray-200 dark:bg-dark-600' : 'hover:bg-gray-100 dark:hover:bg-dark-700'
              }`}
              title={t('header.settings')}
            >
              <Settings className="text-gray-600 dark:text-gray-400" size={18} />
            </button>
          </div>
        </div>

        {!showSettings && <SearchBar ref={searchInputRef} className="mt-3" value={searchQuery} onChange={setSearchQuery} placeholder={t('search.placeholder')} />}
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

      {/* Only when a list is actually shown: with nothing readable the panel
          below carries the whole explanation and a banner would just repeat it. */}
      {heldCount > 0 && accounts.length > 0 && !showSettings && (
        <div className="flex items-start gap-2 border-b border-amber-200 bg-amber-50 p-3 dark:border-amber-800 dark:bg-amber-900/20">
          <AlertTriangle className="mt-0.5 flex-shrink-0 text-amber-600 dark:text-amber-400" size={16} />
          <div className="flex-1 text-xs text-amber-800 dark:text-amber-300">
            {t('held.banner', heldCount)}
          </div>
        </div>
      )}

      {timeOffsetSec !== null && !error && (
        <div className="bg-yellow-50 dark:bg-yellow-900/20 border-b border-yellow-200 dark:border-yellow-800 p-3 flex items-start gap-2">
          <AlertTriangle className="text-yellow-600 dark:text-yellow-400 flex-shrink-0 mt-0.5" size={16} />
          <div className="text-xs text-yellow-800 dark:text-yellow-300 flex-1">
            <div>
              {t(
                clockStatus && !clockStatus.corrected ? 'warning.clockOffUncorrected' : 'warning.clockOff',
                Math.max(1, Math.round(timeOffsetSec / 60))
              )}
            </div>
            <div className="flex items-center gap-3 mt-1.5">
              <button
                onClick={() => chrome.tabs.create({ url: helpUrl(language, 'time-sync') })}
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
      {showVaultPrompt && !showBackupReminder && !error && timeOffsetSec === null && !showSettings && (
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

          {syncOn && syncOverflow && (
            <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-yellow-700 dark:text-yellow-500">
              <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
              {t('settings.syncOverflow')}
            </p>
          )}

          {/* The clock, stated plainly — including when we could not check it.
              Codes depend on it, and a check that quietly stopped running is
              indistinguishable from a healthy one without a line like this. */}
          <div className="mt-3 flex items-start justify-between gap-2">
            <div className="text-[11px] text-gray-600 dark:text-gray-400">
              <div className="font-medium text-gray-700 dark:text-gray-300">{t('settings.clock')}</div>
              <div className={clockStatus?.state === 'off' ? 'text-yellow-700 dark:text-yellow-500' : ''}>
                {clockChecking
                  ? t('settings.clockChecking')
                  : clockStatus === null || clockStatus.state === 'unknown'
                    ? t('settings.clockUnknown')
                    : clockStatus.state === 'ok'
                      ? t('settings.clockOk')
                      : t(
                          clockStatus.corrected ? 'settings.clockOff' : 'settings.clockOffUncorrected',
                          Math.max(1, Math.round(Math.abs(clockStatus.offsetSeconds) / 60))
                        )}
              </div>
            </div>
            <button
              onClick={async () => {
                setClockChecking(true);
                try {
                  const status = await recheckClock();
                  setClockStatus(status);
                  setTimeOffsetSec(await getTimeSyncNotice());
                } finally {
                  setClockChecking(false);
                }
              }}
              disabled={clockChecking}
              className="flex-shrink-0 text-[11px] font-medium text-blue-600 dark:text-blue-400 hover:underline disabled:opacity-50"
            >
              {t('settings.clockRecheck')}
            </button>
          </div>

          <SettingToggle
            label={t('settings.suggested')}
            hint={t('settings.suggestedHint')}
            checked={suggestionsOn}
            onChange={handleSuggestionsToggle}
          />

          <SettingToggle
            label={t('settings.quickFill')}
            hint={t('settings.quickFillHint')}
            checked={quickFillOn}
            onChange={handleQuickFillToggle}
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

          <div className="mt-4 flex items-center justify-between">
            <span className="text-sm text-gray-700 dark:text-gray-300">{t('settings.popupSize')}</span>
            <div className="flex bg-gray-200 dark:bg-dark-600 rounded-lg p-0.5">
              {([['small', 'settings.sizeSmall'], ['medium', 'settings.sizeMedium'], ['large', 'settings.sizeLarge']] as const).map(([size, key]) => (
                <button
                  key={size}
                  onClick={() => handlePopupSizeChange(size)}
                  className={`text-xs font-medium px-2.5 py-1 rounded-md transition-colors ${
                    popupSize === size ? 'bg-white dark:bg-dark-800 text-gray-900 dark:text-gray-100 shadow-sm' : 'text-gray-500 dark:text-gray-400'
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

      {/* Group filter — appears only once the user has actually named a group,
          so nothing changes for anyone who has not. Sits outside the scroll
          area: a filter that scrolls out of view is a filter you forget is on. */}
      {showGroupFilter && (
        <GroupFilter
          groups={groups}
          ungroupedCount={ungroupedCount}
          totalCount={accounts.length}
          active={activeGroup}
          onChange={handleGroupChange}
          language={language}
        />
      )}

      {/* Accounts List */}
      {!showSettings && (
      <div className="flex-1 overflow-y-auto bg-gray-50 dark:bg-dark-900">
        {loading ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300"></div>
          </div>
        ) : filteredAccounts.length === 0 ? (
          // `accounts.length > 0` has to win: with no accounts at all the answer
          // is the setup guide, whatever the filter says. Otherwise someone who
          // deletes their last account while filtered gets "no results" and no
          // way to add anything.
          error || heldCount > 0 ? (
            // Not a new user: the records are on disk, they just cannot be read
            // right now. Showing the setup guide here was the app saying "you
            // have no accounts" to someone whose accounts are intact.
            <AccountsUnavailable
              heldCount={heldCount}
              failed={Boolean(error)}
              language={language}
              onRetry={reload}
              onImport={handleImportClick}
            />
          ) : isFiltered && accounts.length > 0 ? (
            <div className="flex flex-col items-center justify-center h-[340px] text-center p-6">
              <Logo size={48} className="mb-3 opacity-30" />
              <h2 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">
                {t('accounts.noAccountsFound')}
              </h2>
              <p className="text-gray-500 dark:text-gray-400 text-xs mb-4">
                {searchQuery ? t('accounts.tryDifferentSearch') : t('accounts.emptyGroup')}
              </p>
              {/* The chip strip can be scrolled away and the search box can be
                  off-screen behind a long list; one button that undoes both is
                  the only thing guaranteed to be where the empty result is. */}
              <button
                onClick={() => {
                  setSearchQuery('');
                  handleGroupChange(null);
                }}
                className="text-xs font-medium text-[#4285F4] hover:underline"
              >
                {t('accounts.clearFilters')}
              </button>
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
                    // Same account, same badge: pinned at the top it was the one
                    // place the group did not show, so the row above and the row
                    // below disagreed about it.
                    showGroup={activeGroup === null}
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
                // handleDrop rewrites the order of the full list, so dragging
                // inside a filtered view would reorder against indices the user
                // cannot see. Off while filtered, as it already is while searching.
                draggable={!isFiltered}
                onDragStart={handleDragStart}
                onDragOver={() => setDragOverId(account.id)}
                onDrop={handleDrop}
                isDragOver={dragOverId === account.id}
                currentDomain={currentDomain}
                // Matches the condition that decides the pinned card above, so
                // the badge and the pin never disagree about whether a
                // suggestion is being shown.
                isSuggested={!isFiltered && suggestedAccountId === account.id}
                showGroup={activeGroup === null}
              />
            ))}
            {/* At most one card under the list. The review ask wins while it is
                due: it retires permanently once taken, whereas the promo has
                every later open to itself — and stacking two asks below
                someone's codes reads as an ad break.

                Nothing while the "What's New" modal is up: it carries the same
                pitch, so the card behind it is the identical ask twice on one
                screen — and on the 1.11.0 rollout that modal opens for everyone
                at once. */}
            {!isFiltered && whatsNewVersion === null &&
              (showReviewPrompt ? (
                <ReviewPrompt language={language} onRate={handleRate} onSnooze={handleSnoozeReview} />
              ) : showPromoBanner ? (
                <PromoBanner language={language} onDismiss={() => setShowPromoBanner(false)} />
              ) : null)}
          </div>
        )}
      </div>
      )}

      {/* Not on the working screen: once there are codes to read, the bar only
          takes space from them. It belongs where someone is likely to be stuck —
          an empty list, settings, and the lock screen. */}
      {(accounts.length === 0 || showSettings) && (
        <SupportFooter language={language} />
      )}

      {/* Add Button (Floating Action Button) */}
      {!showSettings && accounts.length > 0 && (
        <button
          onClick={() => setShowAddModal(true)}
          className="fixed bottom-4 end-4 w-14 h-14 bg-[#4285F4] hover:bg-[#3367D6] text-white rounded-full shadow-lg hover:shadow-xl transition-all flex items-center justify-center"
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
          groups={groups.map(group => group.name)}
          defaultGroup={activeGroup ?? ''}
        />
      )}

      {/* Edit Account Modal */}
      {editingAccount && (
        <EditAccountModal
          account={editingAccount}
          onClose={() => setEditingAccount(null)}
          onSave={handleEditAccount}
          language={language}
          groups={groups.map(group => group.name)}
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
          onSnoozeReview={handleSnoozeReview}
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
