// Every user-facing string key. Split out of i18n.ts so the per-language
// files under locales/ can be type-checked without importing the loader.

type TranslationKeys = {
  // Header
  'app.title': string;
  'header.faq': string;
  'header.settings': string;
  'header.language': string;

  // Search
  'search.placeholder': string;

  // Accounts
  'accounts.noAccounts': string;
  'accounts.noAccountsFound': string;
  'accounts.tryDifferentSearch': string;
  'accounts.howToAdd': string;
  'accounts.step1': string;
  'accounts.step2': string;
  'accounts.step3': string;
  'accounts.step4': string;
  'accounts.addAccount': string;
  'accounts.or': string;
  'accounts.importFromBackup': string;
  'accounts.copied': string;
  'accounts.clickToCopy': string;
  'accounts.suggested': string;

  // Settings
  'settings.backupRestore': string;
  'settings.export': string;
  'settings.import': string;
  'settings.sync': string;
  'settings.syncHint': string;
  'settings.suggested': string;
  'settings.suggestedHint': string;
  'settings.viewMode': string;
  'settings.viewNormal': string;
  'settings.viewCompact': string;
  'settings.viewHidden': string;

  // FAQ
  'faq.title': string;
  'faq.contact': string;
  'faq.haveQuestions': string;

  // Add Account Modal - errors
  'addAccount.errorNameRequired': string;
  'addAccount.errorInvalidSecret': string;
  'addAccount.errorInvalidQR': string;
  'addAccount.errorScanFailed': string;
  'addAccount.errorNoQr': string;
  'addAccount.errorScreenHint': string;
  'addAccount.errorDropImage': string;

  // Add Account Modal - tips
  'addAccount.whereToFind': string;
  'addAccount.tipCantScan': string;
  'addAccount.tipKeyExample': string;
  'addAccount.tipKeyLength': string;
  'addAccount.chooseImage': string;
  'addAccount.tipLabel': string;
  'addAccount.tipScanInfo': string;

  // Export/Import
  'export.warningPartial': string;
  'export.success': string;
  'export.failed': string;
  'import.success': string;
  'import.failed': string;
  'import.qrSuccess': string;
  'import.qrFailed': string;

  // Account actions
  'accounts.deleteAccount': string;
  'accounts.deleteConfirmMsg': string;

  // Add Account Modal
  'addAccount.title': string;
  'addAccount.manual': string;
  'addAccount.qrCode': string;
  'addAccount.accountName': string;
  'addAccount.accountNamePlaceholder': string;
  'addAccount.issuer': string;
  'addAccount.issuerPlaceholder': string;
  'addAccount.secretKey': string;
  'addAccount.secretKeyPlaceholder': string;
  'addAccount.advanced': string;
  'addAccount.algorithm': string;
  'addAccount.digits': string;
  'addAccount.period': string;
  'addAccount.cancel': string;
  'addAccount.add': string;
  'addAccount.uploadQR': string;
  'addAccount.dragDropQR': string;
  'addAccount.orClickToUpload': string;

  // Warnings
  'warning.timeSync': string;
  'warning.howToFix': string;
  'warning.clockOff': string;
  'warning.dismiss': string;

  // Delete confirmation
  'delete.confirm': string;
  'delete.warning': string;
  'delete.cannotUndo': string;

  // Review prompt
  'review.title': string;
  'review.subtitle': string;
  'review.later': string;
  'review.thanksLow': string;

  // Theme
  'theme.toggle': string;

  // Update modal
  'update.title': string;
  'update.whatsNew': string;
  'update.gotIt': string;
  'update.feature.suggestedAccount': string;
  'update.feature.qrScanning': string;
  'update.feature.timeSync': string;
  'promo.text': string;
  'promo.cta': string;

  // Edit account
  'edit.title': string;
  'edit.save': string;

  // Scan from screen
  'addAccount.scanFromScreen': string;
  'addAccount.errorScreenCapture': string;

  // Backup reminder
  'backup.reminderTitle': string;
  'backup.reminderText': string;
  'backup.export': string;
  'backup.remindLater': string;
};

type VaultTranslationKeys = {
  'vault.prompt.title': string;
  'vault.prompt.text': string;
  'vault.prompt.enable': string;
  'vault.prompt.later': string;

  'vault.setup.title': string;
  'vault.setup.why1': string;
  'vault.setup.why2': string;
  'vault.setup.why3': string;
  'vault.setup.password': string;
  'vault.setup.confirm': string;
  'vault.setup.mismatch': string;
  'vault.setup.tooShort': string;
  'vault.setup.cannotRecover': string;
  'vault.setup.continue': string;
  'vault.setup.working': string;

  'vault.strength.weak': string;
  'vault.strength.fair': string;
  'vault.strength.good': string;
  'vault.strength.strong': string;

  'vault.recovery.title': string;
  'vault.recovery.text': string;
  'vault.recovery.warning': string;
  'vault.recovery.download': string;
  'vault.recovery.confirm': string;
  'vault.recovery.mismatch': string;
  'vault.recovery.finish': string;

  'vault.done.title': string;
  'vault.done.text': string;
  'vault.done.askTitle': string;
  'vault.done.tryHint': string;

  'vault.lock.title': string;
  'vault.lock.subtitle': string;
  'vault.lock.password': string;
  'vault.lock.unlock': string;
  'vault.lock.wrong': string;
  'vault.lock.forgot': string;

  'vault.recover.title': string;
  'vault.recover.text': string;
  'vault.recover.placeholder': string;
  'vault.recover.newPassword': string;
  'vault.recover.submit': string;
  'vault.recover.invalid': string;
  'vault.recover.back': string;
  'vault.recover.rotated': string;

  'vault.settings.title': string;
  'vault.settings.on': string;
  'vault.settings.off': string;
  'vault.settings.enable': string;
  'vault.settings.disable': string;
  'vault.settings.disableConfirm': string;
  'vault.settings.changePassword': string;
  'vault.settings.currentPassword': string;
  'vault.settings.newPassword': string;
  'vault.settings.saved': string;
  'vault.settings.lockNow': string;
  'vault.settings.autoLock': string;
  'vault.settings.autoLockEveryOpen': string;
  'vault.settings.autoLockMins': string;
  'vault.settings.autoLockBrowser': string;

  'export.chooseTitle': string;
  'export.encrypted': string;
  'export.encryptedHint': string;
  'export.plain': string;
  'export.plainHint': string;
  'export.password': string;
  'export.encryptedDone': string;

  'import.passwordTitle': string;
  'import.passwordText': string;
  'import.wrongPassword': string;

  'common.cancel': string;

  'update.feature.vault': string;
  'update.feature.encryptedExport': string;
  'update.feature.recovery': string;
  'update.feature.suggestedToggle': string;
  'update.feature.cameraScan': string;
  'import.qrNothingNew': string;
  'import.qrSuccessPartial': string;
  'common.ok': string;
  'common.confirm': string;
  'accounts.added': string;
  'accounts.updated': string;
  'accounts.deleted': string;
  'export.plainConfirmTitle': string;
  'addAccount.scanWithCamera': string;
  'scan.title': string;
  'scan.hint': string;
  'scan.starting': string;
  'scan.retry': string;
  'scan.done': string;
  'scan.scanAnother': string;
  'scan.addedBody': string;
  'scan.deniedTitle': string;
  'scan.deniedBody': string;
  'scan.noCameraTitle': string;
  'scan.noCameraBody': string;
  'scan.lockedTitle': string;
  'scan.lockedBody': string;
  'scan.errorTitle': string;
};

/** A complete set of strings for one language. */
export type TranslationStrings = TranslationKeys & VaultTranslationKeys;

export type TranslationKey = keyof TranslationStrings;
