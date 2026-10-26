import { useCallback, useState, useMemo, useRef, useEffect } from 'react';
import { Plus, Settings, AlertTriangle, HelpCircle, Lightbulb, Moon, Sun, Sparkles, ArrowLeft, Copy, Pin, PinOff, FolderInput, CheckSquare, Share2, Pencil, Trash2, X, ChevronDown } from 'lucide-react';
import { ContextMenu, SEPARATOR, type MenuEntry } from '@/components/ContextMenu';
import { useAccounts } from '@/hooks/useAccounts';
import { useVault } from '@/hooks/useVault';
import { useFinishQuickFill } from '@/hooks/useFinishQuickFill';
import { AccountCard, type ViewMode } from '@/components/AccountCard';
import { SearchBar } from '@/components/SearchBar';
import { AddAccountModal } from '@/components/AddAccountModal';
import { ExportImport, importBackupText, importResultKind, importResultMessage } from '@/components/ExportImport';
import { importURIList, looksLikeURIList } from '@/utils/uri-import';
import { accountLabel } from '@/utils/account-label';
import { EditAccountModal } from '@/components/EditAccountModal';
import { ShareModal } from '@/components/ShareModal';
import { BackupReminder } from '@/components/BackupReminder';
import { UpdateModal } from '@/components/UpdateModal';
import { ReviewPrompt } from '@/components/ReviewPrompt';
import { Logo } from '@/components/Logo';
import { SettingToggle } from '@/components/SettingToggle';
import { SettingRow, SettingsSection, settingsButton } from '@/components/SettingsSection';
import { LockScreen } from '@/components/LockScreen';
import { VaultPrompt } from '@/components/VaultPrompt';
import { VaultSettings } from '@/components/VaultSettings';
import { VaultSetupModal } from '@/components/VaultSetupModal';
import { EmptyStateGuide, type GuidePath } from '@/components/EmptyStateGuide';
import { AccountsUnavailable } from '@/components/AccountsUnavailable';
import { RestoreBackups, RestoreOffer } from '@/components/RestoreBackups';
import { CloudBackupSettings } from '@/components/CloudBackupSettings';
import { ServerBanner } from '@/components/ServerBanner';
import { NotificationBell } from '@/components/NotificationBell';
import { GroupFilter } from '@/components/GroupFilter';
import { SupportFooter } from '@/components/SupportFooter';
import {
  getTimeSyncNotice,
  dismissTimeNotice,
  checkTimeSync,
  clockStatusOf,
  noticeFor,
  recheckClock,
  watchClock,
  type ClockStatus,
} from '@/utils/time-sync';
import { applyDocumentLanguage, createT, loadLanguage, resolveLanguage, type Language } from '@/utils/i18n';
import { settingsFromChanges } from '@/utils/settings-watch';
import { appearanceClass, cachedAppearance, readUiStyle, rememberAppearance, UI_STYLE_KEY, type UiStyle } from '@/utils/appearance';
import {
  chooseListView,
  groupsInOrder,
  matchesSearch,
  orderAfterUndo,
  pinnedFirst,
  readSortOrder,
  restoredOrder,
  sortAccounts,
  SORT_ORDER_KEY,
  type SortOrder,
} from '@/utils/list-view';
import { addMultipleAccounts, getAccounts, type GroupPlacement } from '@/utils/storage';
import { listBackupSummaries, type BackupSummary } from '@/utils/auto-backup';
import { shouldShowBackupReminder, markBackupDone } from '@/utils/backup-reminder';
import { shouldShowVaultPrompt, markVaultPromptShown } from '@/utils/vault-prompt';
import { describeImport, importErrorKind, importErrorMessage } from '@/utils/import-message';
import { confirmDialog, dismissToast, promptDialog, subscribe as subscribeFeedback, toast } from '@/utils/ui-feedback';
import { useStableCallback } from '@/hooks/useStableCallback';
import { SegmentedControl } from '@/components/SegmentedControl';
import { StylePicker } from '@/components/StylePicker';
import { FeedbackHost } from '@/components/FeedbackHost';
import { PaywallHost } from '@/components/PaywallHost';
import { ProSettings } from '@/components/ProSettings';
import { addWithLimit } from '@/billing/add';
import { subscribePaywall } from '@/billing/bridge';
import { dismissHeldAdd, finishHeldAdd, heldAddToMention } from '@/billing/held-add';
import { BILLING_KEYS, recentlySawPaywall } from '@/billing/state';
import { countOpen } from '@/billing/opens';
import { reasonOfKey, reportAddCancel, reportAddFail, reportAddStep, reportFirstOpen, reportOnboardView, watchOnboardScreen } from '@/billing/onboarding';
import { openedBySite } from '@/utils/site-opened';
import { hasPendingCheckout, syncBilling } from '@/billing/sync';
import { recordOpen, shouldShowReviewPrompt, snoozeReviewPrompt } from '@/utils/review-prompt';
import { clearUpdateBadge } from '@/utils/update-badge';
import { readActiveGroup, rememberActiveGroup, forgetActiveGroup } from '@/utils/active-group';
import { FEATURE_REQUEST_URL, helpUrl } from '@/utils/links';
import { parseQRCode, generateRandomColor, qrFailureKey } from '@/utils/qr-parser';
import { saveErrorMessage } from '@/utils/save-error';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { cleanSecret, isSteamAccount, loadTimeOffset, tryGenerateTOTP } from '@/utils/totp';
import { useEscapeLayer } from '@/hooks/useLayer';
import { isOwnSite, pageWorthScanning } from '@/utils/screen-capture';
import { getSuggestedAccountId, getBaseDomain, areSuggestionsEnabled, setSuggestionsEnabled } from '@/utils/suggestions';
import { isQuickFillEnabled, setQuickFillEnabled } from '@/utils/quick-fill';
import { isSyncEnabled, setSyncEnabled, hasSyncOverflowed } from '@/utils/storage';
import { WHATS_NEW } from '@/utils/update-notes';
import {
  cachedPopupSize,
  readPopupSize,
  rememberPopupSize,
  rootSizeStyle,
  type PopupSize,
} from '@/utils/popup-size';
import {
  detectHost,
  getOpenMode,
  openSidePanelNow,
  setOpenMode,
  sidePanelAvailable,
  type OpenMode,
} from '@/utils/open-mode';
import { claimPopoutWindow, isPopoutSiteMessage, openPopoutWindow, siteOfUrl } from '@/utils/popout';
import type { Account } from '@/types';

// Straight to the Web Store review form: authenticator.sh/rate is a landing
// page, and every extra hop between the prompt and the review box costs
// reviews.
const REVIEW_URL = 'https://chromewebstore.google.com/detail/2fa/ebhcbenbgjmaebpgbldimndmfomjmphd/reviews';

/**
 * The version, for the line at the foot of Settings.
 *
 * Read once at module load and wrapped, because it is rendered inside JSX and
 * a throw there takes the whole popup down with it — which is exactly how an
 * unguarded `.trim()` on a numeric field once did. An empty string simply
 * hides the line.
 */
const APP_VERSION = (() => {
  try {
    return chrome.runtime.getManifest().version || '';
  } catch {
    return '';
  }
})();

/**
 * Which of the three surfaces this document is: the action popup, the floating
 * window, or the side panel. Fixed for the life of the page — the same file is
 * served under three names — so it is read once here rather than held in state.
 */
const HOST = detectHost();

/**
 * The site the floating window was opened for, from its URL.
 *
 * The popup gets this from `activeTab`, which is granted by the click that
 * opened it. A window has no such grant and no active tab of its own, so the
 * service worker passes the hostname it read at click time; reading it here
 * costs no permission because it is our own URL.
 */
const LAUNCH_SITE = (() => {
  if (HOST !== 'window') return null;
  try {
    return new URLSearchParams(location.search).get('site');
  } catch {
    return null;
  }
})();

function App() {
  const vault = useVault();
  const {
    accounts,
    loading,
    error,
    heldCount,
    addAccount,
    deleteAccount,
    deleteAccounts,
    updateAccount,
    renameGroup,
    moveToGroup,
    restoreGroupPlacements,
    reorderGroups,
    reorderAccounts,
    reload,
  } =
    // Unknown vault state counts as locked. `enabled` starts as null while
    // storage is read, and `null === true` is false — so the account list used
    // to start loading in parallel with the vault check and could win the race,
    // painting live codes over a locked vault.
    useAccounts(vault.enabled === null || (vault.enabled && vault.locked));
  const [searchQuery, setSearchQuery] = useState('');
  // null — every account; '' — the ungrouped chip; otherwise a group name.
  const [activeGroup, setActiveGroup] = useState<string | null>(null);
  const [showAddModal, setShowAddModal] = useState(false);
  // Which tab the add form opens on: the QR one, unless the way in asked for the key.
  const [addTab, setAddTab] = useState<'manual' | 'qr'>('qr');
  /** The add dialog opens by scanning the page behind it (the first-run guide's own scan). */
  const [addScan, setAddScan] = useState(false);
  /** Opened by the welcome page, not by a click on the icon: no activeTab, so no capture of the tab. */
  const [openedBySiteState, setOpenedBySiteState] = useState(false);
  const [showSettings, setShowSettings] = useState(false);
  // Which branch of the first-run guide is open. Lives here, not in the guide,
  // because the header names it and holds the way back, as it does for Settings.
  const [openGuidePath, setOpenGuidePath] = useState<GuidePath | null>(null);
  const [timeOffsetSec, setTimeOffsetSec] = useState<number | null>(null);
  // Separate from the banner's state on purpose: the banner appears only for a
  // measured, uncorrected-looking clock, while this carries all three outcomes
  // — including "we could not check", which has nowhere else to be seen.
  const [clockStatus, setClockStatus] = useState<ClockStatus | null>(null);
  const [clockChecking, setClockChecking] = useState(false);
  const [language, setLanguage] = useState<Language>('en');
  // Seeded from the synchronous mirror, like the size below, so the first
  // paint is already in the chosen style and theme.
  const [darkMode, setDarkMode] = useState(() => cachedAppearance().dark);
  const [uiStyle, setUiStyle] = useState<UiStyle>(() => cachedAppearance().style);
  const [editingAccount, setEditingAccount] = useState<Account | null>(null);
  const [sharingAccount, setSharingAccount] = useState<Account | null>(null);
  const [dragOverId, setDragOverId] = useState<string | null>(null);
  const [showBackupReminder, setShowBackupReminder] = useState(false);
  const [showVaultPrompt, setShowVaultPrompt] = useState(false);
  const [showVaultSetup, setShowVaultSetup] = useState(false);
  const [suggestionsOn, setSuggestionsOn] = useState(true);
  const [quickFillOn, setQuickFillOn] = useState(true);
  const [syncOn, setSyncOn] = useState(true);
  const [syncOverflow, setSyncOverflow] = useState(false);
  // The automatic snapshots, described without their records. Read once here
  // rather than in each place that offers a restore, so the offer on the empty
  // list and the list in Settings can never disagree about what exists.
  const [backups, setBackups] = useState<BackupSummary[]>([]);
  const [viewMode, setViewMode] = useState<ViewMode>('normal');
  // Off unless asked for. The list is the one screen every user of this
  // extension already knows by heart, and a coloured circle appearing beside
  // forty-five rows is a change to it whether or not they wanted one — in the
  // compact row it also costs the account name 24px of the width this release
  // just spent getting back.
  const [showAvatars, setShowAvatars] = useState(false);
  const [sortOrder, setSortOrder] = useState<SortOrder>('manual');
  /** A confirmation or prompt is up — the page under it goes inert like under any overlay. */
  const [dialogOpen, setDialogOpen] = useState(false);
  const [paywallOpen, setPaywallOpen] = useState(false);
  // Seeded from the synchronous mirror so the window opens at the chosen size
  // instead of resizing once chrome.storage answers.
  const [popupSize, setPopupSize] = useState<PopupSize>(cachedPopupSize);
  const [openMode, setOpenModeState] = useState<OpenMode>('popup');
  const [currentDomain, setCurrentDomain] = useState<string | null>(null);
  /**
   * What the popup's tab says about "Scan the QR code on this page": worth
   * offering, not, or the page is popup.html itself — opened as a tab, by the
   * e2e suite or a bookmark — which says nothing. Pending until asked.
   */
  const [pageScan, setPageScan] = useState<'pending' | 'yes' | 'no' | 'self'>('pending');
  const [suggestedAccountId, setSuggestedAccountId] = useState<string | null>(null);
  const [whatsNewVersion, setWhatsNewVersion] = useState<string | null>(null);
  const [reviewDismissed, setReviewDismissed] = useState(false);
  const [openCount, setOpenCount] = useState<number | null>(null);
  const [showReviewPrompt, setShowReviewPrompt] = useState(false);
  const draggedIdRef = useRef<string | null>(null);
  /** A row is being dragged — the group chips then take it as a drop. */
  const [draggingAccount, setDraggingAccount] = useState(false);
  /**
   * Choosing accounts to move together. `target` is the group they go to when
   * the choosing began from "+" — a group that has no accounts yet, so it
   * cannot exist until some are picked. Null while not choosing.
   */
  const [selection, setSelection] = useState<{ ids: Set<string>; target: string | null } | null>(null);
  /** An account's right-click menu, and which of its two pages is showing. */
  const [cardMenu, setCardMenu] = useState<{
    account: Account;
    x: number;
    y: number;
    copy: () => void;
    page: 'main' | 'groups';
  } | null>(null);
  /** The selection bar's "Move to group" list, opened above its button. */
  const [selectionMenu, setSelectionMenu] = useState<{ x: number; y: number } | null>(null);
  /** The last account reported gone, so the save path and the effect below do not both say it. */
  const goneAccountRef = useRef<string | null>(null);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const importInputRef = useRef<HTMLInputElement>(null);
  const settingsButtonRef = useRef<HTMLButtonElement>(null);
  const headerBackRef = useRef<HTMLButtonElement>(null);
  /** The "Deleted · Undo" toast on screen, if any — it holds a whole account, secret included. */
  const undoToastRef = useRef<number | null>(null);
  /** The last single add the free limit stopped — still on the add screen when the page outlived Checkout. */
  const blockedAddIdRef = useRef<string | null>(null);
  /** The first billing check-in of this page has had its answer: what is still waiting can be said. */
  const firstBillingSyncDone = useRef(false);

  // Load saved preferences
  useEffect(() => {
    chrome.storage.local.get(['language', 'darkMode', UI_STYLE_KEY, 'viewMode', 'popupSize', 'showAvatars', SORT_ORDER_KEY], (result) => {
      // A stored language is a choice the user made and outranks everything.
      // Without one, follow the browser: twenty translated interfaces were
      // reachable only from a dropdown, so every install began in English no
      // matter who installed it.
      const language: Language = resolveLanguage(result.language);
      if (language !== 'en') {
        // Switch only once the chunk is in memory, otherwise the first paint
        // would be English and then visibly flip.
        loadLanguage(language).then(() => setLanguage(language));
      }
      const appearance = { style: readUiStyle(result[UI_STYLE_KEY]), dark: result.darkMode === true };
      setDarkMode(appearance.dark);
      setUiStyle(appearance.style);
      rememberAppearance(appearance);
      setShowAvatars(result.showAvatars === true);
      setSortOrder(readSortOrder(result[SORT_ORDER_KEY]));
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

  // The floating window names itself, rather than trusting whoever opened it to
  // have survived long enough to write the id down. See claimPopoutWindow: the
  // switch to window mode is usually made from the action popup, which Chrome
  // destroys the instant the new window takes focus — so the opener's write
  // never happened and the extension could never find this window again.
  useEffect(() => {
    if (HOST === 'window') void claimPopoutWindow();
  }, []);

  // Counted for the admin's "opened the extension" (billing/opens.ts): every
  // open of the popup, and a side panel or window coming back into view after
  // half an hour away — those stay open for days, and coming back is a use.
  useEffect(() => {
    void countOpen();
    void openedBySite().then(site => {
      setOpenedBySiteState(site);
      void reportFirstOpen(site);
    });
    if (HOST === 'popup') return;
    let hiddenAt: number | null = null;
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') {
        hiddenAt = Date.now();
        return;
      }
      if (hiddenAt !== null && Date.now() - hiddenAt >= 30 * 60_000) void countOpen();
      hiddenAt = null;
    };
    document.addEventListener('visibilitychange', onVisibility);
    return () => document.removeEventListener('visibilitychange', onVisibility);
  }, []);

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
    getOpenMode().then(setOpenModeState);
  }, []);

  // Every setting on this screen, followed as it changes in another open copy
  // of the app — see settings-watch.ts for what went wrong without it.
  useEffect(() => {
    if (!chrome.storage?.onChanged?.addListener) return;
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      const patch = settingsFromChanges(changes, areaName);
      const nextLanguage = patch.language;
      if (nextLanguage) loadLanguage(nextLanguage).then(() => setLanguage(nextLanguage));
      if (patch.darkMode !== undefined) {
        setDarkMode(patch.darkMode);
        rememberAppearance({ dark: patch.darkMode });
      }
      if (patch.uiStyle) {
        setUiStyle(patch.uiStyle);
        rememberAppearance({ style: patch.uiStyle });
      }
      if (patch.viewMode) setViewMode(patch.viewMode);
      if (patch.showAvatars !== undefined) setShowAvatars(patch.showAvatars);
      if (patch.sortOrder) setSortOrder(patch.sortOrder);
      if (patch.popupSize) {
        setPopupSize(patch.popupSize);
        rememberPopupSize(patch.popupSize);
      }
      if (patch.openMode) setOpenModeState(patch.openMode);
      if (patch.syncEnabled !== undefined) setSyncOn(patch.syncEnabled);
      if (patch.syncOverflow !== undefined) setSyncOverflow(patch.syncOverflow);
      if (patch.quickFill !== undefined) setQuickFillOn(patch.quickFill);
      if (patch.suggestions !== undefined) {
        setSuggestionsOn(patch.suggestions);
        if (!patch.suggestions) setSuggestedAccountId(null);
      }
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, []);

  /**
   * Turning sync on is an upload, and an upload can fail.
   *
   * This used to say "Saved" unconditionally. setSyncEnabled swallows a failed
   * push, the overflow flag that records one was read only when the popup
   * opened, and a rejected vault-metadata write escaped as an unhandled
   * rejection — so the switch showed on, the toast said saved, and nothing had
   * reached Google. The switch and the warning under it are now re-read from
   * the store afterwards, and the toast says what actually happened.
   *
   * `result === false` is for a setSyncEnabled that reports a failed push
   * itself; today's resolves to nothing and leaves the overflow flag as the
   * only record, which is read here either way.
   */
  const handleSyncToggle = async () => {
    const next = !syncOn;
    setSyncOn(next);
    let failed = false;
    try {
      const result: unknown = await setSyncEnabled(next);
      failed = result === false;
    } catch (error) {
      console.error('Could not change the sync setting:', error);
      failed = true;
    }

    let overflowed = false;
    try {
      const [on, overflow] = await Promise.all([isSyncEnabled(), hasSyncOverflowed()]);
      setSyncOn(on);
      setSyncOverflow(overflow);
      overflowed = on && overflow;
    } catch {
      // The switch keeps the state it was just given; the toast still reports.
    }

    if (next && (failed || overflowed)) {
      toast('error', t('settings.syncFailed'));
    } else if (failed) {
      toast('error', t('accounts.updateFailed'));
    } else {
      toast('success', t('vault.settings.saved'));
    }
  };

  // The service worker watches this key and adds or removes the menu item
  // itself, so nothing here has to reach into it.
  //
  // A refused write puts the switch back and says so. It used to be left
  // showing the new position over a store that still held the old one, and
  // the rejection went nowhere — the first sign was the next open disagreeing.
  const handleQuickFillToggle = async () => {
    const next = !quickFillOn;
    setQuickFillOn(next);
    try {
      await setQuickFillEnabled(next);
    } catch (error) {
      console.error('Could not change the quick fill setting:', error);
      setQuickFillOn(!next);
      toast('error', t('settings.saveFailed'));
    }
  };

  const handleSuggestionsToggle = async () => {
    const next = !suggestionsOn;
    setSuggestionsOn(next);
    try {
      await setSuggestionsEnabled(next);
    } catch (error) {
      console.error('Could not change the suggestions setting:', error);
      setSuggestionsOn(!next);
      toast('error', t('settings.saveFailed'));
      return;
    }
    if (!next) setSuggestedAccountId(null);
  };

  const handleSortOrderChange = (order: SortOrder) => {
    setSortOrder(order);
    // Only the choice is written — never the sorted list, nor anything about
    // the services in it — so it can sit in plain local storage beside the
    // view mode even when the accounts themselves are behind a password.
    chrome.storage.local.set({ [SORT_ORDER_KEY]: order }).catch(() => {});
  };

  // The search box is not rendered without accounts, and a query typed before
  // the last one was deleted would otherwise survive invisibly — the next
  // account added lands straight into "no accounts found", with no box on
  // screen to clear.
  useEffect(() => {
    if (accounts.length === 0 && searchQuery) setSearchQuery('');
  }, [accounts.length, searchQuery]);

  /**
   * Read the snapshot list, and re-read it after a restore.
   *
   * Not gated on the account list being empty: the same summaries are what
   * Settings lists at any time, and a read of seven index entries costs
   * nothing next to opening the popup.
   */
  const loadBackups = useCallback(() => {
    listBackupSummaries()
      .then(setBackups)
      .catch(error => console.warn('Could not list the automatic copies:', error));
  }, []);

  useEffect(loadBackups, [loadBackups]);

  /** After a restore: the list, the snapshot counts, and the reminder state. */
  const handleRestored = useCallback(() => {
    reload();
    loadBackups();
  }, [reload, loadBackups]);

  /**
   * The newest snapshot that holds anything, or null.
   *
   * This is the whole condition for offering a restore where an empty list is:
   * a first run has no snapshots, so a new user is never told they might have
   * lost something, and someone whose list emptied out is never told they are
   * new.
   */
  const recoverable = useMemo(
    () => backups.find(backup => backup.accountCount > 0) ?? null,
    [backups]
  );

  // Show the "What's New" modal once after an update, if we have copy for it
  useEffect(() => {
    // The dot on the toolbar icon only asked for this open. The modal stays
    // armed until it is closed; the dot does not need to.
    clearUpdateBadge().catch(() => {});
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

  /**
   * Switching surface takes effect on the next icon click, which is a strange
   * thing to be told when you just clicked something — so the chosen surface is
   * opened straight away and the one being left closes itself. The service
   * worker re-points the toolbar icon on its own; it watches the same key.
   */
  const handleOpenModeChange = async (mode: OpenMode) => {
    if (mode === openMode) return;
    setOpenModeState(mode);
    await setOpenMode(mode);

    let opened = true;
    if (mode === 'window') {
      await openPopoutWindow(currentDomain ?? undefined);
    } else if (mode === 'sidepanel') {
      // Needs Chrome 116 and a user gesture. Both hold here, but a refusal is
      // survivable: the panel opens on the next click of the icon either way.
      opened = await openSidePanelNow();
    }

    // The popup and the window can dismiss themselves once the replacement is
    // up. The side panel cannot, and does not need to — it is not in the way.
    //
    // `opened` is what stops this closing over nothing: on Chrome 114 and 115
    // the panel exists but cannot be opened from script, so the popup used to
    // vanish and leave the screen empty. Staying put means the setting is
    // visibly applied and the next click of the icon opens the panel.
    if (opened && mode !== HOST && HOST !== 'sidepanel') window.close();
  };

  const handlePopupSizeChange = (size: PopupSize) => {
    setPopupSize(size);
    rememberPopupSize(size);
    chrome.storage.local.set({ popupSize: size });
  };

  const handleDarkModeChange = (dark: boolean) => {
    setDarkMode(dark);
    rememberAppearance({ dark });
    chrome.storage.local.set({ darkMode: dark });
  };

  const handleThemeToggle = () => handleDarkModeChange(!darkMode);

  const handleUiStyleChange = (style: UiStyle) => {
    setUiStyle(style);
    rememberAppearance({ style });
    chrome.storage.local.set({ [UI_STYLE_KEY]: style });
  };

  const rootTheme = appearanceClass({ style: uiStyle, dark: darkMode });

  const t = createT(language);

  // A quick fill that stopped at the lock screen goes into the page once the
  // list is readable, instead of leaving the user to copy and paste it.
  useFinishQuickFill(accounts, vault.enabled !== null && !(vault.enabled && vault.locked) && !loading, t);

  // Groups are derived from the accounts rather than stored alongside them:
  // nothing to migrate, nothing to keep in sync, and a group disappears by
  // itself once its last account is gone. Their order rides on the accounts
  // too — see reorderGroups.
  const groups = useMemo(() => groupsInOrder(accounts, language), [accounts, language]);

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
      list = list.filter(acc => matchesSearch(acc, searchQuery));
    }

    return pinnedFirst(sortAccounts(list, sortOrder, language));
  }, [accounts, searchQuery, activeGroup, sortOrder, language]);

  // A filter is a claim about the whole list, so the pinned suggestion — which
  // ignores it — is dropped while one is active, the same as during a search.
  const isFiltered = Boolean(searchQuery) || activeGroup !== null;

  // Dragging rewrites the manual order, so it is only offered while that order
  // is the one on screen. See handleDrop for why it is also off while filtered.
  const canReorder = !isFiltered && sortOrder === 'manual';

  const listView = chooseListView({
    loading,
    total: accounts.length,
    shown: filteredAccounts.length,
    failed: Boolean(error),
    held: heldCount,
  });

  // Only while the guide itself is what is on screen: Settings has the header
  // to itself, and the branch stays open underneath for the way back.
  const guidePath = !showSettings && listView === 'empty' ? openGuidePath : null;

  // "Add your first account" on screen: reported once per open (billing/onboarding.ts).
  const onboardSeen = useRef(false);
  useEffect(() => {
    if (listView !== 'empty' || showSettings || onboardSeen.current) return;
    onboardSeen.current = true;
    void openedBySite().then(site => reportOnboardView(site));
  }, [listView, showSettings]);

  // The question itself on screen — not a branch of it, Settings or the add
  // dialog over it — watched for how long, and how it ends (billing/onboarding.ts).
  // A reload of the list is not leaving it: the popup reloads once as it opens,
  // a few dozen milliseconds in, and every first look ended there as "away".
  const chooserWasOnScreen = useRef(false);
  const chooserOnScreen =
    listView === 'loading'
      ? chooserWasOnScreen.current
      : listView === 'empty' && !showSettings && !openGuidePath && !showAddModal;
  chooserWasOnScreen.current = chooserOnScreen;
  const chooserLeftFor = useRef<'settings' | 'add' | 'away'>('away');
  chooserLeftFor.current = showSettings ? 'settings' : showAddModal ? 'add' : 'away';
  useEffect(() => {
    if (!chooserOnScreen) return;
    let stop: ReturnType<typeof watchOnboardScreen> | null = null;
    let gone = false;
    void openedBySite().then(site => {
      if (!gone) stop = watchOnboardScreen(site);
    });
    return () => {
      gone = true;
      stop?.(chooserLeftFor.current);
    };
  }, [chooserOnScreen]);

  /** Back out of a branch of the guide, from its own button or the header's arrow. */
  const leaveGuidePath = () => {
    if (openGuidePath) void reportAddCancel('guide', openGuidePath.id);
    setOpenGuidePath(null);
  };

  // The row that opened the branch is gone once its steps are up, so focus
  // moves to the way out instead of falling back to <body>.
  useEffect(() => {
    if (openGuidePath) headerBackRef.current?.focus();
  }, [openGuidePath]);

  // The guide is for an empty list. Once something is stored the branch is
  // over, and an emptied list later should start from the question again.
  useEffect(() => {
    if (accounts.length > 0) setOpenGuidePath(null);
  }, [accounts.length]);

  // Pinning a duplicate on top only pays off when the list is long enough to
  // scroll; with few accounts the badge highlight in the list is enough.
  // Not while choosing: the same row twice, ticked in one place and not the other.
  const suggestedAccount = !isFiltered && !selection && suggestedAccountId && accounts.length >= 5
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

  /**
   * False when the free limit stopped the add and the person left the
   * paywall without Pro: the add screen stays open with what they typed.
   */
  const handleAddAccount = async (
    account: Account | Account[],
    batch?: { index: number; total: number },
    unsupported = 0,
    via: 'form' | 'qr' = 'form'
  ): Promise<boolean> => {
    if (Array.isArray(account)) {
      const added = await addWithLimit('migration', origin => addMultipleAccounts(account, origin, { continuesBatch: (batch?.index ?? 1) > 1 }));
      if (!added) {
        void reportAddFail('qr', 'limit');
        return false;
      }
      if (added.added === 0 && !added.updated) void reportAddFail('qr', 'all_already_here');
      const result = { ...added, unsupported };
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
      return true;
    }
    // Kept if the person goes on to Checkout, and added once Pro is on: in the
    // popup this page is gone by then, and with it what was typed or scanned.
    const added = await addWithLimit(via, origin => addAccount(account, origin), { hold: [account] });
    const flow = via === 'qr' ? 'qr' : 'manual';
    if (added === null) {
      blockedAddIdRef.current = account.id;
      void reportAddFail(flow, 'limit');
      return false;
    }
    // A seed already in the list is skipped, and saying "Account added" over
    // a list that did not change sends the user looking for a row that is
    // not there.
    if (!added) {
      void reportAddFail(flow, 'duplicate');
      toast('info', t('accounts.alreadyExists'));
      return true;
    }
    revealAccount(account);
    toast('success', account.group ? t('accounts.addedToGroup', account.group) : t('accounts.added'));
    return true;
  };

  /**
   * The + button and the empty list's "Add account". Opens even with no room
   * left: the limit is met on Add, once the account is typed or scanned
   * (handleAddAccount), and nothing on the way there mentions it.
   */
  const openAddAccount = (tab: 'manual' | 'qr' = 'qr', scan = false) => {
    setAddTab(tab);
    setAddScan(scan);
    setShowAddModal(true);
  };

  /**
   * Put a deleted account back, where it was.
   *
   * Through the same add as any other account, so the tombstone the delete
   * left is lifted by the write itself (writeAccounts forgets the markers of
   * whatever a save adds) — no second path into storage that could disagree
   * with the first. Same id, name, group, colour and creation time: it is the
   * object the list held. Then the manual order is put back around it.
   */
  const undoDelete = async (account: Account, previousIds: string[]) => {
    try {
      // Never counted against the limit: putting back what was just deleted.
      const added = await addAccount(account, { kind: 'undo' });
      if (added) {
        const order = restoredOrder((await getAccounts()).map(a => a.id), account.id, previousIds);
        // Best-effort: the account is back either way, and at the top of the
        // list is a smaller problem than a failure message over a success.
        if (order) await reorderAccounts(order).catch(error => console.warn('Could not restore the position:', error));
      }
      revealAccount(account);
      toast('success', t('accounts.restored'));
    } catch (error) {
      // A vault locked in the meantime, a refused write. The offer is made
      // again rather than lost with the toast that carried it.
      console.error('Could not undo the delete:', error);
      undoToastRef.current = toast('error', t('accounts.undoFailed'), {
        action: { label: t('recovery.retry'), run: () => void undoDelete(account, previousIds) },
      });
    }
  };

  const handleDeleteAccount = useStableCallback(async (id: string) => {
    const account = accounts.find(a => a.id === id);
    // Taken before the dialog: the list can change while it is open, and the
    // position to restore is the one the user saw.
    const previousIds = accounts.map(a => a.id);
    const confirmed = await confirmDialog({
      title: t('accounts.deleteAccount'),
      body: t('accounts.deleteConfirmMsg', account ? accountLabel(account) : ''),
      warning: t('delete.warning'),
      note: t('delete.cannotUndo'),
      confirmLabel: t('accounts.deleteAccount'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });

    if (!confirmed) return;
    try {
      await deleteAccount(id);
    } catch (error) {
      // Silence here read as a delete that worked and an account that came back.
      console.error('Could not delete the account:', error);
      toast('error', t('accounts.deleteFailed'));
      return;
    }

    // Deleting is one click from an account the user may have no other way
    // back into — the site's 2FA stays on — so it can be taken back for a few
    // seconds. Without the object in hand (a row that was never in this list)
    // there is nothing to put back, and the plain notice is all there is.
    if (undoToastRef.current !== null) dismissToast(undoToastRef.current);
    undoToastRef.current = account
      ? toast('success', t('accounts.deleted'), {
          action: {
            label: t('common.undo'),
            run: () => {
              undoToastRef.current = null;
              void undoDelete(account, previousIds);
            },
          },
        })
      : toast('success', t('accounts.deleted'));
  });

  const handleEditAccount = async (id: string, updates: Partial<Account>) => {
    let found: boolean | void;
    try {
      found = await updateAccount(id, updates);
    } catch (error) {
      console.error('Could not save the changes:', error);
      toast('error', t('accounts.updateFailed'));
      // Rethrown so the edit form stays open with what was typed.
      throw error;
    }
    // Deleted in another window while this one had it open. "Changes saved"
    // over a row that is not in the list sends the user looking for it; the
    // modal closes itself once onSave resolves.
    if (found === false) {
      if (goneAccountRef.current !== id) toast('info', t('accounts.notFound'));
      goneAccountRef.current = id;
      return;
    }
    // Only when the group was actually touched: an edit that leaves it alone
    // cannot have moved the account out of the current filter.
    if ('group' in updates) revealAccount(updates);
    toast('success', t('accounts.updated'));
  };

  // From the chip's right-click menu. A group is only a name the accounts
  // share, so both of these are one edit to every account that carries it.
  const handleRenameGroup = async (name: string) => {
    const typed = await promptDialog({
      title: t('groups.rename'),
      defaultValue: name,
      placeholder: t('groups.placeholder'),
      confirmLabel: t('groups.renameButton'),
      cancelLabel: t('common.cancel'),
    });
    const to = typed?.trim();
    if (!to || to === name) return;
    try {
      await renameGroup(name, to);
    } catch (error) {
      console.error('Could not rename the group:', error);
      toast('error', t('accounts.updateFailed'));
      return;
    }
    // The filter follows the group. Left on the old name it would point at a
    // group that no longer exists and be reset to "All" — the renamed group
    // gone from view at the moment the user expects to see it.
    if (activeGroup === name) handleGroupChange(to);
    toast('success', t('groups.renamed'));
  };

  const handleDeleteGroup = async (name: string) => {
    // The body says outright that the accounts stay. "Delete" next to a group
    // of 2FA accounts reads as deleting them, and nobody should have to find
    // out by trying.
    const confirmed = await confirmDialog({
      title: t('groups.delete'),
      body: t('groups.deleteBody', name),
      confirmLabel: t('groups.delete'),
      cancelLabel: t('common.cancel'),
      danger: true,
    });
    if (!confirmed) return;
    let before: GroupPlacement[];
    try {
      before = await renameGroup(name, undefined);
    } catch (error) {
      console.error('Could not delete the group:', error);
      toast('error', t('accounts.updateFailed'));
      return;
    }
    if (activeGroup === name) handleGroupChange(null);
    toast('success', t('groups.deleted'), {
      action: { label: t('common.undo'), run: () => void undoGroupEdit(before) },
    });
  };

  /** Put accounts back where a group edit found them. */
  const undoGroupEdit = async (before: GroupPlacement[]) => {
    try {
      await restoreGroupPlacements(before);
    } catch (error) {
      console.error('Could not undo the group change:', error);
      toast('error', t('accounts.updateFailed'));
    }
  };

  /**
   * Move accounts into a group, or out of every group, with an Undo: thirty
   * accounts sent to the wrong group should not cost thirty edits to put back.
   * False when the write failed, so a selection is kept to try again.
   */
  const moveAccounts = async (ids: string[], group: string | undefined): Promise<boolean> => {
    let before: GroupPlacement[];
    try {
      before = await moveToGroup(ids, group);
    } catch (error) {
      console.error('Could not move the accounts:', error);
      toast('error', t('accounts.updateFailed'));
      return false;
    }
    if (before.length > 0) {
      toast('success', group ? t('accounts.moved', group) : t('accounts.movedOut'), {
        action: { label: t('common.undo'), run: () => void undoGroupEdit(before) },
      });
    }
    return true;
  };

  const askNewGroupName = async (confirmLabel: string): Promise<string | null> => {
    const typed = await promptDialog({
      title: t('groups.new'),
      placeholder: t('groups.placeholder'),
      confirmLabel,
      cancelLabel: t('common.cancel'),
    });
    return typed?.trim() || null;
  };

  const moveToNewGroup = async (ids: string[]) => {
    const name = await askNewGroupName(t('groups.create'));
    if (name) await moveAccounts(ids, name);
  };

  // The "+" on the strip. A group is a name accounts share, so it cannot exist
  // empty: creating one is naming it and then choosing what goes in. On the
  // whole list, whatever was filtered — the accounts for a new group are
  // rarely all in one old one.
  const handleCreateGroup = async () => {
    const name = await askNewGroupName(t('groups.chooseAccounts'));
    if (!name) return;
    handleGroupChange(null);
    setSelection({ ids: new Set(), target: name });
  };

  const handleToggleSelect = useStableCallback((id: string) => {
    setSelection(current => {
      if (!current) return current;
      const ids = new Set(current.ids);
      if (ids.has(id)) ids.delete(id);
      else ids.add(id);
      return { ...current, ids };
    });
  });

  const finishSelection = async (group: string | undefined) => {
    if (!selection || selection.ids.size === 0) return;
    setSelectionMenu(null);
    if (await moveAccounts([...selection.ids], group)) setSelection(null);
  };

  useEscapeLayer(() => setSelection(null), selection !== null);

  /**
   * Put back what a delete of several accounts removed, where it was — the
   * same add an undone single delete goes through, never counted against the
   * limit, then the order the list had.
   */
  const undoDeleteMany = async (restored: Account[], previousIds: string[]) => {
    try {
      await addMultipleAccounts(restored, { kind: 'undo' });
      const order = orderAfterUndo((await getAccounts()).map(a => a.id), previousIds);
      if (order) await reorderAccounts(order).catch(error => console.warn('Could not restore the order:', error));
      toast('success', t('accounts.restored'));
    } catch (error) {
      console.error('Could not undo the delete:', error);
      undoToastRef.current = toast('error', t('accounts.undoFailed'), {
        action: { label: t('recovery.retry'), run: () => void undoDeleteMany(restored, previousIds) },
      });
    }
  };

  /**
   * The selection bar's Delete. The dialog names the accounts and the button
   * carries the count: "Select all", then Delete, is a whole list of 2FA
   * accounts one confirmation away, and the number is what makes that visible.
   * Undo puts all of them back, as a single delete's does.
   */
  const handleDeleteSelected = async () => {
    if (!selection || selection.ids.size === 0) return;
    const chosen = accounts.filter(account => selection.ids.has(account.id));
    if (chosen.length === 0) return;
    const previousIds = accounts.map(account => account.id);
    const names = chosen.slice(0, 5).map(account => accountLabel(account)).join(', ');
    const confirmed = await confirmDialog({
      title: t('select.deleteTitle'),
      body: t('select.deleteBody', chosen.length > 5 ? `${names} +${chosen.length - 5}` : names),
      warning: t('delete.warning'),
      note: t('delete.cannotUndo'),
      confirmLabel: t('select.deleteConfirm', chosen.length),
      cancelLabel: t('common.cancel'),
      danger: true,
    });
    if (!confirmed) return;
    let removed: number;
    try {
      removed = await deleteAccounts(chosen.map(account => account.id));
    } catch (error) {
      console.error('Could not delete the accounts:', error);
      toast('error', t('accounts.deleteFailed'));
      return;
    }
    setSelection(null);
    if (removed === 0) return;
    if (undoToastRef.current !== null) dismissToast(undoToastRef.current);
    undoToastRef.current = toast('success', t('select.deleted', removed), {
      action: {
        label: t('common.undo'),
        run: () => {
          undoToastRef.current = null;
          void undoDeleteMany(chosen, previousIds);
        },
      },
    });
  };

  const handleCardMenu = useStableCallback((account: Account, x: number, y: number, copy: () => void) => {
    setCardMenu({ account, x, y, copy, page: 'main' });
  });

  const togglePin = async (account: Account) => {
    try {
      await updateAccount(account.id, { pinned: account.pinned ? undefined : true });
    } catch (error) {
      console.error('Could not pin the account:', error);
      toast('error', t('accounts.updateFailed'));
    }
  };

  /**
   * Every group to pick from, then "No group" and a new one. `current` ticks
   * the account's own group ('' for none); undefined — a selection of many —
   * ticks nothing.
   */
  const groupPickerItems = (
    current: string | undefined,
    onPick: (group: string | undefined) => void,
    onNew: () => void
  ): MenuEntry[] => [
    ...groups.map(group => ({
      label: group.name,
      checked: current === undefined ? undefined : current === group.name,
      onSelect: () => onPick(group.name),
    })),
    {
      label: t('groups.ungrouped'),
      checked: current === undefined ? undefined : current === '',
      onSelect: () => onPick(undefined),
    },
    SEPARATOR,
    { label: t('groups.newEllipsis'), icon: Plus, onSelect: onNew },
  ];

  const cardMenuItems = (menu: NonNullable<typeof cardMenu>): MenuEntry[] => {
    const { account } = menu;
    const close = () => setCardMenu(null);
    if (menu.page === 'groups') {
      return groupPickerItems(
        account.group?.trim() ?? '',
        group => {
          close();
          void moveAccounts([account.id], group);
        },
        () => {
          close();
          void moveToNewGroup([account.id]);
        }
      );
    }
    // A record whose secret makes no code has nothing to copy or share; the
    // rest of the menu is what its row offers too.
    const valid = tryGenerateTOTP(account) !== null;
    const entries: MenuEntry[] = [];
    if (valid) entries.push({ label: t('menu.copy'), icon: Copy, onSelect: () => { close(); menu.copy(); } });
    entries.push(
      {
        label: account.pinned ? t('menu.unpin') : t('menu.pin'),
        icon: account.pinned ? PinOff : Pin,
        onSelect: () => {
          close();
          void togglePin(account);
        },
      },
      // Stays open on its second page: the groups.
      { label: t('menu.moveToGroup'), icon: FolderInput, onSelect: () => setCardMenu({ ...menu, page: 'groups' }) },
      {
        label: t('menu.select'),
        icon: CheckSquare,
        onSelect: () => {
          close();
          setSelection({ ids: new Set([account.id]), target: null });
        },
      },
      SEPARATOR
    );
    if (valid && !isSteamAccount(account)) {
      entries.push({ label: t('share.title'), icon: Share2, onSelect: () => { close(); setSharingAccount(account); } });
    }
    entries.push(
      { label: t('edit.title'), icon: Pencil, onSelect: () => { close(); setEditingAccount(account); } },
      {
        label: t('accounts.deleteAccount'),
        icon: Trash2,
        danger: true,
        onSelect: () => {
          close();
          void handleDeleteAccount(account.id);
        },
      }
    );
    return entries;
  };

  // Stable for the life of the page, so the memoised rows are not all redrawn
  // on every render of the popup. They took inline arrows before — a new
  // function per row per render — which made AccountCard's memo a no-op.
  const handleDragStart = useCallback((_e: React.DragEvent, id: string) => {
    draggedIdRef.current = id;
    setDraggingAccount(true);
  }, []);

  const handleDragOver = useCallback((_e: React.DragEvent, id: string) => {
    // The same id again on every pointer move: setState with an unchanged
    // value is dropped by React, so this does not re-render per event.
    setDragOverId(id);
  }, []);

  const handleDragLeave = useCallback((id: string) => {
    setDragOverId(current => (current === id ? null : current));
  }, []);

  /** Whichever way a drag ends — a drop, a drop outside the list, Esc. */
  const handleDragEnd = useCallback(() => {
    draggedIdRef.current = null;
    setDragOverId(null);
    setDraggingAccount(false);
  }, []);

  const handleDrop = useStableCallback(async (_e: React.DragEvent, targetId: string) => {
    const draggedId = draggedIdRef.current;
    // Cleared before the write rather than after it: the write can take a
    // moment, and it can fail — either way the marker must not outlive the drop.
    handleDragEnd();
    if (!draggedId || draggedId === targetId) return;

    const newOrder = [...accounts.map(a => a.id)];
    const fromIndex = newOrder.indexOf(draggedId);
    const toIndex = newOrder.indexOf(targetId);
    if (fromIndex === -1 || toIndex === -1) return;
    newOrder.splice(fromIndex, 1);
    newOrder.splice(toIndex, 0, draggedId);

    try {
      await reorderAccounts(newOrder);
    } catch (error) {
      // Unreported, a refused write left the rows where the user dropped them
      // until the next reload put them back — an order that quietly undid itself.
      console.error('Could not save the new order:', error);
      toast('error', t('accounts.reorderFailed'));
      reload();
    }
  });

  const handleImportClick = () => {
    void reportAddStep('import', 'picker');
    importInputRef.current?.click();
  };

  const handleImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (!file) return;
    // Cleared on every way out, so the same file can be picked again — after
    // turning on Pro in the paywall it stopped, the likeliest next step.
    const input = e.target;
    try {
      await importFile(file);
    } finally {
      input.value = '';
    }
  };

  const importLinks = async (text: string, flow: 'import' | 'paste') => {
    const outcome = await addWithLimit('uri', origin => importURIList(text, language, origin));
    if (!outcome) {
      void reportAddFail(flow, 'limit');
      return;
    }
    if (outcome.kind === 'error' || !outcome.added) void reportAddFail(flow, outcome.kind === 'error' ? 'links_error' : 'links_nothing_added');
    if (outcome.added !== undefined) {
      await markBackupDone((await getAccounts()).length);
      setShowBackupReminder(false);
      reload();
    }
    toast(outcome.kind, outcome.message);
  };

  // The first-run guide's own way to the box Settings → Paste links opens: the
  // same dialog, so that nobody holding a list of links has to find Settings first.
  const handlePasteLinks = async () => {
    const text = await promptDialog({
      title: t('import.pasteTitle'),
      body: t('import.pasteBody'),
      placeholder: 'otpauth://totp/…',
      multiline: true,
      confirmLabel: t('settings.import'),
      cancelLabel: t('common.cancel'),
    });
    if (!text || !text.trim()) {
      void reportAddCancel('paste', 'dialog');
      return;
    }
    void reportAddStep('paste', 'submitted');
    try {
      await importLinks(text, 'paste');
    } catch (error) {
      console.error('Import failed:', error);
      void reportAddFail('paste', importErrorKind(error));
      toast('error', importErrorMessage(error, language));
    }
  };

  const importFile = async (file: File) => {
    let text = '';

    try {
      if (file.type.startsWith('image/')) {
        void reportAddStep('import', 'image');
        await handleQRImport(file);
      } else if (((text = await file.text()), looksLikeURIList(text))) {
        // The .txt this extension writes has to come back in through the input
        // the onboarding points at, not only through the one in Settings.
        void reportAddStep('import', 'links');
        await importLinks(text, 'import');
      } else {
        void reportAddStep('import', 'backup');
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
        // Null: the password prompt cancelled, or the paywall closed — the two are not told apart here.
        if (!imported) void reportAddCancel('import', 'backup_stopped');
        else if (!imported.added && !(imported as { updated?: number }).updated) void reportAddFail('import', 'backup_nothing_added');
        if (imported) {
          const currentAccounts = await getAccounts();
          await markBackupDone(currentAccounts.length);
          setShowBackupReminder(false);
          reload();
          // Entries that could no longer be read are named rather than rounded
          // up to "successful" — a restore that quietly dropped rows is the one
          // case where the user needs to go looking for another copy.
          toast(importResultKind(imported), importResultMessage(imported, language));
        }
      }
    } catch (error) {
      console.error('Import failed:', error);
      void reportAddFail('import', importErrorKind(error));
      // The same wording as Settings → Import: an encrypted Aegis or 2FAS
      // export, or an Alibaba Cloud backup, each needs its own next step.
      toast('error', importErrorMessage(error, language));
    }
  };

  const handleQRImport = async (file: File) => {
    let text: string | null;
    try {
      text = await decodeQrFromImage(file);
    } catch (error) {
      // createImageBitmap rejects a file it cannot open — a HEIC photo, a
      // truncated download — with a DOMException written for the console, and
      // that sentence used to be the toast: "The source image could not be
      // decoded.", in English, whatever language the popup was in.
      console.error('Could not open the image:', error);
      void reportAddFail('import', 'image_unreadable');
      toast('error', t('import.imageUnreadable'));
      return;
    }
    if (!text) {
      void reportAddFail('import', 'no_qr');
      toast('error', t('addAccount.errorNoQr'));
      return;
    }

    let parsed;
    try {
      parsed = parseQRCode(text);
    } catch (error) {
      console.error('QR import failed:', error);
      void reportAddFail('import', reasonOfKey(qrFailureKey(text, error)));
      // Understood, and refused on purpose — saying "invalid QR" here would
      // send the user off to re-export a code that can never work.
      toast('error', t(qrFailureKey(text, error)));
      return;
    }
    if (!parsed) {
      void reportAddFail('import', reasonOfKey(qrFailureKey(text)));
      toast('error', t(qrFailureKey(text)));
      return;
    }

    const accountsToAdd: Account[] = parsed.accounts.map((accountData, index) => ({
      id: Date.now().toString() + index + Math.random().toString(36).substring(7),
      name: accountData.name,
      issuer: accountData.issuer,
      secret: cleanSecret(accountData.secret),
      algorithm: accountData.algorithm,
      digits: accountData.digits,
      period: accountData.period,
      ...(accountData.type ? { type: accountData.type } : {}),
      createdAt: Date.now() + index,
      color: generateRandomColor(),
    }));

    let result;
    try {
      const migration = parsed.type === 'migration';
      const continuesBatch = migration && (parsed.batch?.index ?? 1) > 1;
      const added = await addWithLimit(migration ? 'migration' : 'qr', origin => addMultipleAccounts(accountsToAdd, origin, { continuesBatch }), {
        hold: migration ? undefined : accountsToAdd,
      });
      if (!added) {
        void reportAddFail('import', 'limit');
        return;
      }
      if (added.added === 0 && !added.updated) void reportAddFail('import', 'all_already_here');
      result = { ...added, unsupported: parsed.skipped ?? 0 };
    } catch (error) {
      console.error('Could not save the scanned accounts:', error);
      void reportAddFail('import', 'save_failed');
      toast('error', saveErrorMessage(error, t));
      return;
    }
    reload();
    // A split Google Authenticator export is the common case for anyone with
    // more than ten accounts, and stopping after the first code is the
    // default mistake. Say which code this was.
    const more = parsed.batch && parsed.batch.index < parsed.batch.total
      ? ` ${t('import.qrBatch', parsed.batch.index, parsed.batch.total)}`
      : '';
    toast(result.added > 0 ? 'success' : 'info', describeImport(result, language) + more);
  };

  // Anything that covers the whole app. Two things depend on knowing: the
  // type-to-search shortcut, which used to send the first letter someone typed
  // into a search box hidden behind the What's New modal, and `inert`, which
  // keeps Tab and the mouse out of the list underneath — without it a second
  // full-screen view could be opened on top of the first from behind it.
  //
  // A confirmation counts too. It is drawn over everything, but the page under
  // it stayed live: Tab walked out of "Delete account?" into the list behind
  // it, and a screen reader could read and press the rows it was covering.
  const overlayOpen = Boolean(
    showAddModal || editingAccount || sharingAccount || showVaultSetup || whatsNewVersion || dialogOpen || paywallOpen
  );
  /** A right-click menu or the selection bar's list is open — it has the keys. */
  const menuOpen = cardMenu !== null || selectionMenu !== null;

  useEffect(() => subscribeFeedback(state => setDialogOpen(state.dialog !== null)), []);
  useEffect(
    () =>
      subscribePaywall(request => {
        setPaywallOpen(request !== null);
        // No rating ask right after the money ask — also when one was already
        // on screen before the paywall opened.
        if (request) {
          setShowReviewPrompt(false);
        }
      }),
    []
  );

  // Edit and Share each hold a whole decrypted account for as long as they are
  // open — secret included — and an idle lock in a window or side panel
  // arrives while one of them is. useAccounts drops its own copies; these are
  // the two nobody else owns.
  //
  // The Undo toast is a third: it holds the account it would put back.
  useEffect(() => {
    if (vault.enabled === true && vault.locked) {
      setEditingAccount(null);
      setSharingAccount(null);
      setSelection(null);
      setCardMenu(null);
      setSelectionMenu(null);
      if (undoToastRef.current !== null) {
        dismissToast(undoToastRef.current);
        undoToastRef.current = null;
      }
    }
  }, [vault.enabled, vault.locked]);

  // The same two views, when their account is deleted in another window. Left
  // open, Edit saved into nothing and said "Changes saved", and Share kept
  // handing out codes for an account the user had just removed.
  //
  // Only against a list that was really read: while loading, behind a lock, or
  // after a failed read the list is empty for reasons that say nothing about
  // this account.
  useEffect(() => {
    if (loading || error || vaultHidingAccounts) return;
    const gone = (account: Account | null) =>
      account !== null && !accounts.some(existing => existing.id === account.id);
    const goneEditing = gone(editingAccount);
    const goneSharing = gone(sharingAccount);
    if (!goneEditing && !goneSharing) return;

    const id = (goneEditing ? editingAccount : sharingAccount)!.id;
    if (goneEditing) setEditingAccount(null);
    if (goneSharing) setSharingAccount(null);
    if (goneAccountRef.current !== id) toast('info', t('accounts.notFound'));
    goneAccountRef.current = id;
    // `t` is rebuilt every render; the language changing is no reason to re-check.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [accounts, loading, error, vaultHidingAccounts, editingAccount, sharingAccount]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement;
      const isInputFocused = target.tagName === 'INPUT' || target.tagName === 'TEXTAREA';
      const listUp = !overlayOpen && !showSettings && !menuOpen;

      // Down from the search box into the list, and up and down its rows; Enter
      // on a row copies it, as a click does, and Enter in the search box copies
      // the first match — type three letters, press Enter, paste.
      if (listUp && (event.key === 'ArrowDown' || event.key === 'ArrowUp' || event.key === 'Enter')) {
        const search = searchInputRef.current;
        const rows = [...document.querySelectorAll<HTMLElement>('[data-ui="account-list"] [data-row-action]')];
        const fromSearch = target === search;
        const at = rows.indexOf(target);
        if (rows.length > 0 && (fromSearch || at !== -1)) {
          if (event.key === 'Enter') {
            if (fromSearch && search?.value.trim()) {
              event.preventDefault();
              rows[0].click();
            }
            return;
          }
          event.preventDefault();
          if (event.key === 'ArrowDown') rows[fromSearch ? 0 : Math.min(at + 1, rows.length - 1)].focus();
          else if (at <= 0) search?.focus();
          else rows[at - 1].focus();
          return;
        }
      }

      // Every full-screen view has to be listed: the search box is mounted
      // behind them, and typing the first letter of a share label used to move
      // focus there — the characters landed in a filter the user could not see
      // and found applied to their list once the view closed.
      if (!isInputFocused && listUp && searchInputRef.current) {
        if (event.key.length === 1 && !event.ctrlKey && !event.metaKey && !event.altKey) {
          searchInputRef.current.focus();
        }
      }
    };

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [overlayOpen, showSettings, menuOpen]);

  useEffect(() => {
    chrome.storage.local.get('reviewDismissed', (result) => setReviewDismissed(!!result.reviewDismissed));
    recordOpen().then(setOpenCount);
  }, []);

  // Held back until the accounts have loaded: an empty list during loading looks
  // exactly like "never finished setup", which is who the prompt must skip.
  useEffect(() => {
    if (loading || openCount === null) return;
    // Not in the week after a paywall: asking for a rating straight after
    // asking for money reads as the same request twice.
    Promise.all([shouldShowReviewPrompt(openCount, accounts.length), recentlySawPaywall()]).then(([due, paywalled]) =>
      setShowReviewPrompt(due && !paywalled)
    );
  }, [loading, openCount, accounts.length]);

  const handleSnoozeReview = async () => {
    setShowReviewPrompt(false);
    if (openCount !== null) await snoozeReviewPrompt(openCount);
  };

  // Everyone who takes the prompt lands in the same place: the Web Store review
  // box. Asking for a rating inside the popup and then routing only the happy
  // answers to the store is review gating — the kind of thing an extension
  // holding people's 2FA secrets cannot afford to be delisted over. Whoever
  // wants to complain still has "Help & support" in the footer, and "Request a
  // feature" at the end of Settings.
  const handleRate = async () => {
    setReviewDismissed(true);
    setShowReviewPrompt(false);
    // Awaited before the tab is opened: creating a tab tears this page down, and
    // a dismissal that never reached disk means asking again someone who has
    // already left a review.
    await chrome.storage.local.set({ reviewDismissed: true }).catch(() => {});
    // The rating block lives inside the "What's New" modal too, and that modal
    // is re-armed from storage until it is explicitly closed — a rating is one
    // of the two things that count as closing it, the other being "Got it".
    // Following a link out of the modal is not one of them.
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
    shouldShowVaultPrompt(accounts.length, vault.enabled).then(setShowVaultPrompt);
  }, [loading, accounts.length, vault.enabled]);

  // The vault offer is the notice up top that gives way to all the others — an
  // error, the clock warning, the backup reminder — so
  // its three showings are counted when it is on screen, not when it is due.
  // Counted when due, someone with a backup reminder up on every open spent all
  // three without once seeing the offer.
  const vaultPromptVisible =
    showVaultPrompt && !showBackupReminder && !error && timeOffsetSec === null && !showSettings;
  // The server's vault banner asks what VaultPrompt asks, so never both at once.
  const offersVaultBanner = vault.enabled === false && accounts.length > 0 && !vaultPromptVisible;
  const vaultPromptCounted = useRef(false);
  useEffect(() => {
    if (!vaultPromptVisible || vaultPromptCounted.current) return;
    vaultPromptCounted.current = true;
    markVaultPromptShown();
  }, [vaultPromptVisible]);

  /**
   * The account a blocked add was adding when the person went to Checkout
   * (billing/held-add.ts): added once Pro is on, and said so. Until then,
   * after this page's first check-in, the person is told once that it is
   * waiting, with the way to let it go. Nothing while the vault is locked —
   * the add waits for the unlock.
   */
  const settleHeldAdd = useStableCallback(async () => {
    if (vault.enabled === null || (vault.enabled && vault.locked)) return;
    const done = await finishHeldAdd();
    if (done) {
      if (done.added + done.updated === 0) return;
      reload();
      revealAccount(done.accounts[0]);
      // Still on the add screen with that same account (side panel, floating
      // window): it is in the list now, so the screen has done its job.
      if (showAddModal && done.accounts.some(a => a.id === blockedAddIdRef.current)) setShowAddModal(false);
      toast('success', t('billing.heldAdded', accountLabel(done.accounts[0]!)));
      return;
    }
    if (!firstBillingSyncDone.current) return;
    const waiting = await heldAddToMention();
    if (!waiting) return;
    toast('info', t('billing.heldWaiting', accountLabel(waiting[0]!)), {
      action: { label: t('billing.heldDiscard'), run: () => void dismissHeldAdd() },
    });
  });

  // Pro arriving — from this page's check-in, a key typed in another window,
  // the service worker — is what finishes it.
  useEffect(() => {
    if (!chrome.storage?.onChanged?.addListener) return;
    const onChanged = (changes: Record<string, { newValue?: unknown }>, areaName: string) => {
      if (areaName === 'local' && changes[BILLING_KEYS.entitlement]?.newValue) void settleHeldAdd();
    };
    chrome.storage.onChanged.addListener(onChanged);
    return () => chrome.storage.onChanged.removeListener(onChanged);
  }, [settleHeldAdd]);

  // And so is an unlock, if Pro came while the vault was locked.
  useEffect(() => {
    if (vault.enabled === false || (vault.enabled === true && !vault.locked)) void settleHeldAdd();
  }, [vault.enabled, vault.locked, settleHeldAdd]);

  // The daily billing check-in, after the list is on screen — never before it.
  // A purchase started from this install is looked for on every open for a
  // day, and again whenever this page comes back into view: in the side panel
  // or the floating window the person returns here from the checkout tab.
  useEffect(() => {
    const run = async () => {
      await syncBilling({ force: await hasPendingCheckout() });
      firstBillingSyncDone.current = true;
      await settleHeldAdd();
    };
    const idle = (window as Window & { requestIdleCallback?: (cb: () => void) => number }).requestIdleCallback;
    const handle = idle ? idle(() => void run()) : window.setTimeout(() => void run(), 500);
    const onVisible = () => {
      if (document.visibilityState !== 'visible') return;
      void hasPendingCheckout().then(pending => {
        if (pending) void syncBilling({ force: true });
      });
    };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', onVisible);
    return () => {
      if (!idle) window.clearTimeout(handle);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', onVisible);
    };
  }, []);

  // Opens the settings panel rather than exporting straight away: since 1.10.0
  // the user has to choose between a password-protected and a plain file, and
  // silently writing the plain one would undo the vault for anyone who enabled it.
  const handleBackupFromReminder = () => {
    setShowSettings(true);
    setShowBackupReminder(false);
  };

  useEffect(() => {
    // Every reading lands here, not only the one taken on open: the side panel
    // and the floating window stay open for days, and watchClock goes on
    // measuring for them — again after a failure, when the network returns,
    // when the page is shown. Read once on mount, the banner and the Settings
    // line described the clock as it was when the page opened, and a failed
    // check on open left them saying "unknown" for good.
    let cancelled = false;
    const stopWatching = watchClock((result) => {
      if (cancelled) return;
      setClockStatus(clockStatusOf(result));
      noticeFor(result)
        .then((notice) => {
          if (!cancelled) setTimeOffsetSec(notice);
        })
        .catch(() => {});
    });
    // Restore any persisted clock correction first so codes are already adjusted,
    // then run the network re-check which refines/clears it and decides the notice.
    loadTimeOffset()
      .then(() => checkTimeSync())
      .catch(() => {});
    return () => {
      cancelled = true;
      stopWatching();
    };
  }, []);

  // Which site to suggest an account for, and where that comes from differs by
  // surface. The popup asks the active tab: `activeTab` is granted by the click
  // that opened it, which is why this needs no host permission. The floating
  // window has no such grant and no tab of its own, so the service worker hands
  // it the hostname — in the URL when the window is created, by message when an
  // already-open one is raised. The side panel gets neither: it outlives any
  // one click and reading its window's tab would need the `tabs` permission,
  // which is a "read your browsing history" warning this feature is not worth.
  useEffect(() => {
    if (HOST === 'sidepanel') return;

    if (HOST === 'window') {
      if (LAUNCH_SITE) setCurrentDomain(LAUNCH_SITE);
      if (!chrome.runtime?.onMessage?.addListener) return;
      const onMessage = (message: unknown) => {
        if (isPopoutSiteMessage(message)) setCurrentDomain(message.site);
      };
      chrome.runtime.onMessage.addListener(onMessage);
      return () => chrome.runtime.onMessage.removeListener(onMessage);
    }

    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      // siteOfUrl, not `new URL(url).hostname`: a chrome://extensions tab has
      // the hostname "extensions", which is not a site to suggest against and
      // used to be handed to the floating window in its URL as one.
      const site = siteOfUrl(tabs[0]?.url);
      if (site) setCurrentDomain(site);
      // A real popup is in no tab; popup.html opened as one is, and the tab
      // it would read is itself.
      chrome.tabs.getCurrent((self) => {
        setPageScan(self ? 'self' : pageWorthScanning(tabs[0]?.url) ? 'yes' : 'no');
      });
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
      <div style={rootSizeStyle(HOST, popupSize)} className={`flex items-center justify-center bg-white dark:bg-dark-900 ${rootTheme}`}>
        <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300" />
      </div>
    );
  }

  // A locked vault replaces the whole UI: no account list, no search, no
  // add button. useAccounts has already dropped the decrypted accounts from
  // state, and the effect above drops the two views that hold one of their
  // own, so there is nothing here to leak.
  if (vault.enabled === true && vault.locked) {
    return (
      <div style={rootSizeStyle(HOST, popupSize)} className={`overflow-hidden flex flex-col ${rootTheme}`}>
        <div className="flex-1 flex flex-col bg-white dark:bg-dark-900 overflow-hidden">
          <div className="bg-white dark:bg-dark-900 border-b border-gray-200 dark:border-dark-700 p-4">
            <div className="flex items-center justify-between">
              {/* min-w-0 + truncate + flex-shrink-0, all three: nothing here could
                  shrink and nothing could ellipsize, so a long title pushed the icon
                  row past the right edge and the root's overflow-hidden cut the gear
                  off. At the 320px popup the title has ~124px, which "Authenticator"
                  fills to 118. Four locales need more, measured: tr 151, ru
                  146, uk 140, fr 137. The logo is 20px rather than 24 for the same
                  budget, and because 24px next to 18px text reads as hanging low. */}
              <div className="flex items-center gap-2 min-w-0">
                <Logo bare size={20} className="flex-shrink-0" />
                <h1 className="truncate text-lg font-semibold tracking-[-0.02em] text-gray-900 dark:text-gray-100">{t('app.title')}</h1>
              </div>
              <div className="flex items-center gap-1 flex-shrink-0">
                <button
                  onClick={handleThemeToggle}
                  className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
                  title={t('theme.toggle')}
                  aria-label={t('theme.toggle')}
                  aria-pressed={darkMode}
                >
                  {darkMode ? <Sun className="text-yellow-400" size={18} /> : <Moon className="text-gray-600" size={18} />}
                </button>
              </div>
            </div>
          </div>
          <LockScreen language={language} onUnlock={vault.unlock} onRecovered={vault.refresh} />
          <SupportFooter language={language} onLanguageChange={handleLanguageChange} />
          <FeedbackHost />
          <PaywallHost language={language} />
        </div>
      </div>
    );
  }

  // React 18 does not know the attribute, so it is spread as a string rather
  // than passed as a boolean it would refuse to render.
  const behindOverlay = (overlayOpen ? { inert: '' } : {}) as { inert?: string };

  return (
    <div style={rootSizeStyle(HOST, popupSize)} className={`overflow-hidden flex flex-col ${rootTheme}`}>
      <div data-ui="app-column" className="flex-1 flex flex-col bg-white dark:bg-dark-900 overflow-hidden">
      {/* display:contents, so this changes nothing about the layout and only
          carries `inert` for everything a full-screen view covers. It has to
          close before the views themselves, which are rendered further down
          inside this same column. */}
      <div className="contents" {...behindOverlay}>

      {/* Header */}
      {/* With the chips up, the header's own bottom padding stacks on the strip's
          top padding — trimmed so search and chips read as one block. */}
      <div data-ui="header" className={`flex-shrink-0 bg-white dark:bg-dark-900 p-4 ${showGroupFilter ? 'pb-2' : 'border-b border-gray-200 dark:border-dark-700'}`}>
        <div className="flex items-center justify-between">
          {/* min-w-0 + truncate + flex-shrink-0, all three: nothing here could
              shrink and nothing could ellipsize, so a long title pushed the icon
              row past the right edge and the root's overflow-hidden cut the gear
              off. At the 320px popup the title had ~124px beside four icons,
              which "Authenticator" fills to 118, and four locales need more,
              measured: tr 151, ru 146, uk 140, fr 137. With the language moved
              to the footer there are three icons and 34px more, which is what
              lets those four through. The logo is 20px rather than 24 for the
              same budget, and because 24px next to 18px text reads as hanging
              low. It is the bare disc: on the white header the logo's white
              tile only shrank the visible mark to 17px. */}
          {/* Settings is a screen, not an overlay, so the header says which
              screen you are on and offers the way back. A gear that stays lit
              does not read as "press again to leave" — people looked for a
              back control and there wasn't one.

              An open branch of the first-run guide is the same kind of place,
              so it gets the same header: the row that was picked becomes the
              title, instead of repeating itself in a smaller one below. */}
          <div className="flex items-center gap-2 min-w-0">
            {showSettings || guidePath ? (
              <button
                ref={headerBackRef}
                onClick={() => {
                  if (!showSettings) {
                    leaveGuidePath();
                    return;
                  }
                  setShowSettings(false);
                  // The arrow goes with the screen; the gear that opened it
                  // stays, and is where the keyboard picks up again.
                  settingsButtonRef.current?.focus();
                }}
                aria-label={t('common.back')}
                title={t('common.back')}
                className="-ms-1 -me-1 flex-shrink-0 rounded-lg p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-dark-700 dark:hover:text-gray-100"
              >
                <ArrowLeft size={20} className="rtl:rotate-180" />
              </button>
            ) : (
              <Logo bare size={20} className="flex-shrink-0" />
            )}
            {/* A guide row is a sentence, not a name. With three icons beside it
                the title had 242px at the default 400px popup, and two lines at
                16px held 79 of the 80 rows there (4 rows, 20 languages,
                measured); the theme switch now steps aside on these screens
                (see below), which gives the title 34px more. What still does
                not fit, mostly at 320px, ends in an ellipsis rather than
                pushing the gear out — which two of the branches send people to.
                The negative margin keeps the header the height it has with one
                line, so opening a branch does not move everything under it. */}
            <h1
              className={`font-semibold text-gray-900 dark:text-gray-100 ${
                guidePath ? '-my-1.5 line-clamp-2 text-base leading-tight' : 'truncate text-lg tracking-[-0.02em]'
              }`}
              title={guidePath ? t(guidePath.label) : undefined}
            >
              {showSettings ? t('header.settings') : guidePath ? t(guidePath.label) : t('app.title')}
            </h1>
          </div>
          <div className="flex items-center gap-1 flex-shrink-0">
            {/* The server's notifications (NotificationBell), there only while
                one of them is for this install — the server decides who, new
                installs included. Not inside a branch of the guide, whose
                title needs the room. With it the icons are four again, and at
                320px the longest titles end in an ellipsis. */}
            {!guidePath && (
              <NotificationBell language={language} offersVault={vault.enabled === false} onVault={() => setShowVaultSetup(true)} />
            )}
            {/* Not while a branch of the guide is open: someone following steps
                with a phone in the other hand is not choosing a theme, and the
                title — a whole sentence there — needs the room. Help and
                Settings stay: the steps send people to both. */}
            {!guidePath && (
              <button
                onClick={handleThemeToggle}
                className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
                title={t('theme.toggle')}
                aria-label={t('theme.toggle')}
                aria-pressed={darkMode}
              >
                {darkMode ? (
                  <Sun className="text-yellow-400" size={18} />
                ) : (
                  <Moon className="text-gray-600" size={18} />
                )}
              </button>
            )}
            {/* Opens the help page rather than a panel: the answers live on the
                site now, in the reader's own language and with room to be read. */}
            <button
              onClick={() => chrome.tabs.create({ url: helpUrl(language) })}
              className="p-1.5 rounded-lg transition-colors hover:bg-gray-100 dark:hover:bg-dark-700"
              title={t('header.faq')}
              aria-label={t('header.faq')}
            >
              <HelpCircle className="text-gray-600 dark:text-gray-400" size={18} />
            </button>
            <button
              ref={settingsButtonRef}
              onClick={() => setShowSettings(!showSettings)}
              aria-label={t('header.settings')}
              aria-pressed={showSettings}
              className={`p-1.5 rounded-lg transition-colors ${
                showSettings ? 'bg-gray-200 dark:bg-dark-600' : 'hover:bg-gray-100 dark:hover:bg-dark-700'
              }`}
              title={t('header.settings')}
            >
              <Settings className="text-gray-600 dark:text-gray-400" size={18} />
            </button>
          </div>
        </div>

        {/* Nothing to search until something is stored, and in the empty
            state the box is 44px of the pane the setup guide needs. */}
        {!showSettings && accounts.length > 0 && <SearchBar ref={searchInputRef} className="mt-3" value={searchQuery} onChange={setSearchQuery} placeholder={t('search.placeholder')} clearLabel={t('search.clear')} />}
      </div>

      {/* Error/Warning Messages */}
      {error && (
        <div className="bg-red-50 dark:bg-red-900/20 border-b border-red-200 dark:border-red-800 p-3 flex items-start gap-2">
          <AlertTriangle className="text-red-600 dark:text-red-400 flex-shrink-0 mt-0.5" size={16} />
          <div className="text-xs text-red-800 dark:text-red-300 flex-1">
            {t(error)}
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

      {timeOffsetSec !== null && !error && !showSettings && (
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
      {/* Not over Settings: its own Export button is on that screen, four lines
          below, and the strip's button only opens the screen you are on. */}
      {showBackupReminder && !error && timeOffsetSec === null && !showSettings && (
        <BackupReminder
          language={language}
          onExport={handleBackupFromReminder}
          onDismiss={() => setShowBackupReminder(false)}
        />
      )}

      {/* Offer password protection — never at the same time as another notice */}
      {vaultPromptVisible && (
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
        <div className="flex-1 flex flex-col min-h-0 bg-gray-50 dark:bg-dark-800">
          {/* Sections run from what protects the codes, through what keeps them,
              to how they look and where they show up — and every one is built
              from the same parts (see SettingsSection). A new setting goes into
              the section it belongs to, not onto the end. */}
          <div className="flex-1 overflow-y-auto p-4 space-y-5">
            {/* Above everything, when the server's banner stands here (ServerBanner). */}
            <ServerBanner language={language} place="settings" offersVault={offersVaultBanner} hasAccounts={accounts.length > 0} onVault={() => setShowVaultSetup(true)} />

            {/* First, and only when there is something to say (see ProSettings). */}
            <ProSettings language={language} />

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

            <SettingsSection title={t('settings.backupRestore')}>
              <div className="p-3">
                <ExportImport onImportComplete={reload} onExportComplete={() => setShowBackupReminder(false)} language={language} />
              </div>

              {/* Always here, whatever state the list is in: the copies are most
                  useful to someone who knew about them before they needed them. */}
              <RestoreBackups backups={backups} language={language} onRestored={handleRestored} />
              <CloudBackupSettings language={language} onRestored={handleRestored} />

              <SettingToggle
                label={t('settings.sync')}
                hint={t('settings.syncHint')}
                checked={syncOn}
                onChange={handleSyncToggle}
              >
                {syncOn && syncOverflow && (
                  <p className="mt-1.5 flex items-start gap-1.5 text-[11px] text-yellow-700 dark:text-yellow-500">
                    <AlertTriangle size={12} className="mt-0.5 flex-shrink-0" />
                    {t('settings.syncOverflow')}
                  </p>
                )}
              </SettingToggle>
            </SettingsSection>

            {/* How it looks, before what the list shows: the style and light or
                dark are independent, and the header's sun/moon is the same
                switch as the second row. */}
            <SettingsSection title={t('settings.sectionAppearance')}>
              <SettingRow label={t('settings.style')}>
                <StylePicker
                  label={t('settings.style')}
                  value={uiStyle}
                  dark={darkMode}
                  labels={{ classic: t('settings.styleClassic'), apple: t('settings.styleApple') }}
                  onChange={handleUiStyleChange}
                />
              </SettingRow>
              <SettingRow
                label={t('settings.theme')}
                control={
                  <SegmentedControl
                    label={t('settings.theme')}
                    value={darkMode ? 'dark' : 'light'}
                    options={[
                      ['light', t('settings.themeLight')],
                      ['dark', t('settings.themeDark')],
                    ]}
                    onChange={mode => handleDarkModeChange(mode === 'dark')}
                  />
                }
              />
            </SettingsSection>

            <SettingsSection title={t('settings.sectionList')}>
              <SettingRow
                label={t('settings.viewMode')}
                control={
                  <SegmentedControl
                    label={t('settings.viewMode')}
                    value={viewMode}
                    options={[
                      ['normal', t('settings.viewNormal')],
                      ['compact', t('settings.viewCompact')],
                      ['hidden', t('settings.viewHidden')],
                    ]}
                    onChange={mode => {
                      setViewMode(mode);
                      chrome.storage.local.set({ viewMode: mode });
                    }}
                  />
                }
              />

              {/* The hint is said here, where the choice is made: a drag handle
                  that simply stops appearing reads as a bug. */}
              <SettingRow
                label={t('settings.sort')}
                hint={t('settings.sortHint')}
                control={
                  <SegmentedControl
                    label={t('settings.sort')}
                    value={sortOrder}
                    options={[
                      ['manual', t('settings.sortManual')],
                      ['service', t('settings.sortService')],
                      ['name', t('settings.sortName')],
                    ]}
                    onChange={handleSortOrderChange}
                  />
                }
              />

              <SettingToggle
                label={t('settings.avatars')}
                hint={t('settings.avatarsHint')}
                checked={showAvatars}
                onChange={() => {
                  const next = !showAvatars;
                  setShowAvatars(next);
                  chrome.storage.local.set({ showAvatars: next });
                }}
              />
            </SettingsSection>

            <SettingsSection title={t('settings.sectionBrowser')}>
              <SettingRow
                label={t('settings.openIn')}
                hint={t('settings.openInHint')}
                control={
                  <SegmentedControl
                    label={t('settings.openIn')}
                    value={openMode}
                    options={[
                      ['popup', t('settings.openInPopup')],
                      ['window', t('settings.openInWindow')],
                      // Chrome 114 added the side panel; older browsers are not
                      // offered a mode that would leave the icon doing nothing.
                      ...(sidePanelAvailable() ? [['sidepanel', t('settings.openInSidePanel')] as const] : []),
                    ]}
                    onChange={mode => void handleOpenModeChange(mode)}
                  />
                }
              />

              {/* Only the popup is sized by its document; the other two are sized by
                  dragging their edges, so the preset would control nothing there. */}
              {HOST === 'popup' && (
                <SettingRow
                  label={t('settings.popupSize')}
                  control={
                    <SegmentedControl
                      label={t('settings.popupSize')}
                      value={popupSize}
                      options={[
                        ['small', t('settings.sizeSmall')],
                        ['medium', t('settings.sizeMedium')],
                        ['large', t('settings.sizeLarge')],
                      ]}
                      onChange={handlePopupSizeChange}
                    />
                  }
                />
              )}

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
            </SettingsSection>

            {/* The clock, stated plainly — including when we could not check it.
                Codes depend on it, and a check that quietly stopped running is
                indistinguishable from a healthy one without a line like this. */}
            <SettingsSection title={t('settings.sectionDiagnostics')}>
              <SettingRow
                label={t('settings.clock')}
                tone={clockStatus?.state === 'off' ? 'warn' : undefined}
                hint={
                  clockChecking
                    ? t('settings.clockChecking')
                    : clockStatus === null || clockStatus.state === 'unknown'
                      ? t('settings.clockUnknown')
                      : clockStatus.state === 'ok'
                        ? t('settings.clockOk')
                        : t(
                            clockStatus.corrected ? 'settings.clockOff' : 'settings.clockOffUncorrected',
                            Math.max(1, Math.round(Math.abs(clockStatus.offsetSeconds) / 60))
                          )
                }
                control={
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
                    className={settingsButton.link}
                  >
                    {t('settings.clockRecheck')}
                  </button>
                }
              />
            </SettingsSection>

            {/* The last thing on the screen: the public board for ideas. It
                used to be in the footer of every screen. */}
            <div className="space-y-2 text-center">
              <button
                onClick={() => chrome.tabs.create({ url: FEATURE_REQUEST_URL })}
                className={`${settingsButton.link} inline-flex items-center gap-1.5`}
              >
                <Lightbulb size={13} />
                {t('common.requestFeature')}
              </button>

              {/* Selectable on purpose: the first thing a support reply asks for is
                  the version, and reading it off chrome://extensions means leaving
                  the popup to answer. */}
              {APP_VERSION && (
                <p className="select-text text-[11px] text-gray-500 dark:text-gray-400">
                  {t('settings.version', APP_VERSION)}
                  <span aria-hidden="true"> · </span>
                  <button
                    onClick={handleRate}
                    className="underline hover:text-gray-600 dark:hover:text-gray-300"
                  >
                    {t('settings.rateUs')}
                  </button>
                </p>
              )}
            </div>
          </div>
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
          onRename={handleRenameGroup}
          onDelete={handleDeleteGroup}
          onCreate={() => void handleCreateGroup()}
          onReorder={names =>
            void reorderGroups(names).catch(error => {
              console.error('Could not save the group order:', error);
              toast('error', t('accounts.reorderFailed'));
            })
          }
          // A row dropped on a chip joins that group — or leaves every group,
          // on "No group".
          onDropAccount={
            draggingAccount
              ? group => {
                  const id = draggedIdRef.current;
                  if (id) void moveAccounts([id], group || undefined);
                }
              : null
          }
          language={language}
        />
      )}

      {/* Accounts List */}
      {!showSettings && (
      // A column under the setup guide only, so an open branch can grow to the
      // pane's height and keep its buttons on the bottom edge. A percentage
      // height would not do it: the popup's root has a min and a max height
      // and no height, so there is nothing for a percentage to resolve against.
      // For the same reason the list's white cannot stretch itself down to the
      // FAB, so the pane takes the list's colour: two codes otherwise sat on a
      // white strip over a grey void.
      <div
        data-ui="list-pane"
        className={`flex-1 overflow-y-auto ${
          listView === 'list' ? 'bg-white dark:bg-dark-800' : 'bg-gray-50 dark:bg-dark-900'
        } ${listView === 'empty' ? 'flex flex-col' : ''}`}
      >
        {listView === 'loading' ? (
          <div className="flex items-center justify-center h-full">
            <div className="animate-spin rounded-full h-8 w-8 border-2 border-gray-300 dark:border-dark-600 border-t-gray-900 dark:border-t-gray-300"></div>
          </div>
        ) : listView !== 'list' ? (
          // The order lives in chooseListView: accounts on screen outrank the
          // explanations of why there might be none, and with no accounts at
          // all the setup guide wins whatever the filter says.
          listView === 'unavailable' ? (
            // Not a new user: the records are on disk, they just cannot be read
            // right now. Showing the setup guide here was the app saying "you
            // have no accounts" to someone whose accounts are intact.
            <AccountsUnavailable
              heldCount={heldCount}
              failed={Boolean(error)}
              language={language}
              onRetry={reload}
              onImport={handleImportClick}
              restore={
                recoverable && (
                  <RestoreOffer
                    backup={recoverable}
                    language={language}
                    onRestored={handleRestored}
                    variant="inline"
                  />
                )
              }
            />
          ) : listView === 'noResults' ? (
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
                className="text-xs font-medium text-accent-600 dark:text-accent-400 hover:underline"
              >
                {t('accounts.clearFilters')}
              </button>
            </div>
          ) : (
            <>
              {/* Only when a snapshot actually holds accounts — otherwise this
                  is a first run and the guide below is the whole answer. */}
              {recoverable && (
                <RestoreOffer
                  backup={recoverable}
                  language={language}
                  onRestored={handleRestored}
                />
              )}
              <EmptyStateGuide
                language={language}
                openPath={openGuidePath}
                onOpenPath={setOpenGuidePath}
                onBack={leaveGuidePath}
                onScanScreen={() => openAddAccount('qr', true)}
                // The popup decides from its own tab (pageWorthScanning). The
                // window and the side panel cannot read one, and neither can a
                // popup.html open as a tab; they go by the welcome page's mark,
                // and by the site the window was handed.
                canScanPage={
                  HOST === 'popup' && pageScan !== 'self'
                    ? pageScan === 'yes'
                    : !openedBySiteState && !(currentDomain && isOwnSite(currentDomain))
                }
                onEnterKey={() => openAddAccount('manual')}
                onImport={handleImportClick}
                onPasteLinks={() => void handlePasteLinks()}
                onScanWithCamera={() =>
                  chrome.tabs.create({ url: chrome.runtime.getURL('scan.html') })
                }
                onScanWithImage={() =>
                  chrome.tabs.create({ url: chrome.runtime.getURL('scan.html?mode=image') })
                }
              />
            </>
          )
        ) : (
          <div data-ui="account-list" className="bg-white dark:bg-dark-800 pb-20">
            {/* The server's banner, when it stands over the accounts. Not in a
                filtered view, where it would push the result down, and not
                under the What's New modal, which is an ask of its own. */}
            {!isFiltered && whatsNewVersion === null && (
              <ServerBanner language={language} place="accounts" offersVault={offersVaultBanner} hasAccounts={accounts.length > 0} onVault={() => setShowVaultSetup(true)} />
            )}
            {suggestedAccount && (
              <>
                {/* AccountCard must stay the last child so its own `last:after:hidden`
                    divider rule kicks in — the section strip below handles separation. */}
                <div>
                  <div className="px-4 pt-2.5 pb-1 flex items-center gap-1.5 text-[11px] font-medium text-accent-600 dark:text-accent-400">
                    <Sparkles size={12} />
                    <span>{t('accounts.suggested')}</span>
                    {currentDomain && (
                      <span className="text-gray-500 dark:text-gray-400 font-normal truncate">
                        · {getBaseDomain(currentDomain)}
                      </span>
                    )}
                  </div>
                  <AccountCard
                    key={`suggested-${suggestedAccount.id}`}
                    account={suggestedAccount}
                    onDelete={handleDeleteAccount}
                    onEdit={setEditingAccount}
                    onShare={setSharingAccount}
                    language={language}
                    viewMode={viewMode}
                    showAvatar={showAvatars}
                    draggable={false}
                    currentDomain={currentDomain}
                    // Same account, same badge: pinned at the top it was the one
                    // place the group did not show, so the row above and the row
                    // below disagreed about it.
                    showGroup={activeGroup === null}
                    onMenu={handleCardMenu}
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
                onShare={setSharingAccount}
                language={language}
                viewMode={viewMode}
                showAvatar={showAvatars}
                // handleDrop rewrites the order of the full list, so dragging
                // inside a filtered view would reorder against indices the user
                // cannot see. Off while filtered, as it already is while searching,
                // and off while the list is sorted — a drop there would move a
                // row the sort puts straight back.
                draggable={canReorder && !selection}
                onDragStart={handleDragStart}
                onDragOver={handleDragOver}
                onDrop={handleDrop}
                onDragLeave={handleDragLeave}
                onDragEnd={handleDragEnd}
                isDragOver={dragOverId === account.id}
                currentDomain={currentDomain}
                // Matches the condition that decides the pinned card above, so
                // the badge and the pin never disagree about whether a
                // suggestion is being shown.
                isSuggested={!isFiltered && suggestedAccountId === account.id}
                showGroup={activeGroup === null}
                onMenu={handleCardMenu}
                selecting={selection !== null}
                selected={selection?.ids.has(account.id) ?? false}
                onToggleSelect={handleToggleSelect}
              />
            ))}
            {/* At most one card under the list: the review ask, while it is due.
                It retires permanently once taken — an ask that stayed below
                someone's codes would read as an ad break.

                Nothing while the "What's New" modal is up: it carries the same
                pitch, so the card behind it is the identical ask twice on one
                screen — and on the 1.11.0 rollout that modal opens for everyone
                at once. */}
            {!isFiltered && whatsNewVersion === null && showReviewPrompt && (
              <ReviewPrompt language={language} onRate={handleRate} onSnooze={handleSnoozeReview} />
            )}
          </div>
        )}
      </div>
      )}

      {/* Not on the working screen: once there are codes to read, the bar only
          takes space from them. It belongs where someone is likely to be stuck —
          an empty list, settings, and the lock screen. */}
      {(accounts.length === 0 || showSettings) && (
        <SupportFooter language={language} onLanguageChange={handleLanguageChange} />
      )}

      {/* Choosing accounts: the bar takes the "+" button's place, since adding
          an account in the middle of a selection is not what anyone is doing. */}
      {selection && !showSettings && (() => {
        const shown = filteredAccounts.map(account => account.id);
        const allShown = shown.length > 0 && shown.every(id => selection.ids.has(id));
        const count = selection.ids.size;
        return (
          <div
            data-ui="selection-bar"
            className="fixed inset-x-0 bottom-0 z-40 flex items-center gap-2 border-t border-gray-200 bg-white px-3 py-2.5 shadow-[0_-4px_12px_rgba(0,0,0,0.06)] dark:border-dark-700 dark:bg-dark-900 anim-rise"
          >
            <button
              onClick={() => setSelection(null)}
              aria-label={t('common.cancel')}
              title={t('common.cancel')}
              className="flex-shrink-0 rounded-full p-1.5 text-gray-500 hover:bg-gray-100 dark:text-gray-400 dark:hover:bg-dark-700"
            >
              <X size={18} aria-hidden />
            </button>
            <span role="status" className="min-w-0 flex-1 truncate text-sm text-gray-700 dark:text-gray-200">
              {selection.target && count === 0 ? t('select.pickFor', selection.target) : t('select.count', count)}
            </span>
            <button
              onClick={() =>
                setSelection(current => {
                  if (!current) return current;
                  const ids = new Set(current.ids);
                  for (const id of shown) {
                    if (allShown) ids.delete(id);
                    else ids.add(id);
                  }
                  return { ...current, ids };
                })
              }
              className="flex-shrink-0 px-1 text-xs font-medium text-accent-600 hover:underline dark:text-accent-400"
            >
              {allShown ? t('select.none') : t('select.all')}
            </button>
            {/* Not while filling a new group: that selection is for moving. */}
            {!selection.target && (
              <button
                disabled={count === 0}
                onClick={() => void handleDeleteSelected()}
                aria-label={t('select.delete')}
                title={t('select.delete')}
                className="flex-shrink-0 rounded-lg p-1.5 text-red-600 transition-colors hover:bg-red-50 disabled:opacity-40 dark:text-red-400 dark:hover:bg-red-900/20"
              >
                <Trash2 size={18} aria-hidden />
              </button>
            )}
            <button
              disabled={count === 0}
              onClick={event => {
                if (selection.target) {
                  void finishSelection(selection.target);
                  return;
                }
                const rect = event.currentTarget.getBoundingClientRect();
                setSelectionMenu({ x: rect.left, y: rect.top });
              }}
              aria-haspopup={selection.target ? undefined : 'menu'}
              className="flex max-w-[45%] flex-shrink-0 items-center gap-1 rounded-lg bg-accent-600 px-3 py-1.5 text-sm font-medium text-white transition-colors hover:bg-accent-700 disabled:opacity-50"
            >
              <span className="truncate">
                {selection.target ? t('select.moveHere', selection.target) : t('menu.moveToGroup')}
              </span>
              {!selection.target && <ChevronDown size={14} aria-hidden className="flex-shrink-0" />}
            </button>
          </div>
        );
      })()}

      {selectionMenu && selection && (
        <ContextMenu
          x={selectionMenu.x}
          y={selectionMenu.y}
          above
          items={groupPickerItems(
            undefined,
            group => void finishSelection(group),
            () => {
              setSelectionMenu(null);
              const ids = [...selection.ids];
              void askNewGroupName(t('groups.create')).then(async name => {
                if (name && (await moveAccounts(ids, name))) setSelection(null);
              });
            }
          )}
          onClose={() => setSelectionMenu(null)}
        />
      )}

      {cardMenu && (
        <ContextMenu
          // Keyed by page so the groups page measures and focuses afresh.
          key={cardMenu.page}
          x={cardMenu.x}
          y={cardMenu.y}
          items={cardMenuItems(cardMenu)}
          onClose={returnFocus => {
            const id = cardMenu.account.id;
            setCardMenu(null);
            if (returnFocus) {
              document
                .querySelector<HTMLElement>(`[data-account-id="${CSS.escape(id)}"] [data-row-action]`)
                ?.focus();
            }
          }}
        />
      )}

      {/* Add Button (Floating Action Button) */}
      {!showSettings && accounts.length > 0 && !selection && (
        <button
          onClick={() => openAddAccount()}
          className="fixed bottom-4 end-4 w-14 h-14 bg-accent-600 hover:bg-accent-700 text-white rounded-full shadow-lg hover:shadow-xl transition-all flex items-center justify-center"
          title={t('accounts.addAccount')}
          aria-label={t('accounts.addAccount')}
        >
          <Plus size={24} aria-hidden />
        </button>
      )}
      </div>

      {/* Add Account Modal */}
      {showAddModal && (
        <AddAccountModal
          onClose={() => setShowAddModal(false)}
          onAdd={handleAddAccount}
          language={language}
          groups={groups.map(group => group.name)}
          defaultGroup={activeGroup ?? ''}
          initialTab={addTab}
          scanScreen={addScan}
          // Closed first: the file picker and the paste box report into the
          // list, and the result belongs on screen, not behind this dialog.
          onImport={() => {
            setShowAddModal(false);
            handleImportClick();
          }}
          onPasteLinks={() => {
            setShowAddModal(false);
            void handlePasteLinks();
          }}
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
          accounts={accounts}
        />
      )}

      {/* Share codes by link */}
      {sharingAccount && (
        <ShareModal
          account={sharingAccount}
          language={language}
          onClose={() => setSharingAccount(null)}
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
        accept="application/json,text/plain,image/*,.maFile,.2fas"
        onChange={handleImportFile}
        className="hidden"
      />

      <FeedbackHost />
      <PaywallHost language={language} />
      </div>
    </div>
  );
}

export default App;
