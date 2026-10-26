// Every user-facing string key. Split out of i18n.ts so the per-language
// files under locales/ can be type-checked without importing the loader.

type TranslationKeys = {
  // Header
  'app.title': string;
  'header.faq': string;
  'header.settings': string;
  'header.language': string;

  // The bell in the header and its notifications (NotificationBell)
  'notices.title': string;
  'notices.empty': string;
  'notices.new': string;

  // Search
  'search.placeholder': string;

  // Popup size
  'settings.popupSize': string;
  'settings.sizeSmall': string;
  'settings.sizeMedium': string;
  'settings.sizeLarge': string;

  // Where the icon opens the app: popup, floating window or side panel
  'settings.openIn': string;
  'settings.openInPopup': string;
  'settings.openInWindow': string;
  'settings.openInSidePanel': string;
  'settings.openInHint': string;

  // Groups
  'groups.all': string;
  'groups.ungrouped': string;
  'groups.field': string;
  'groups.placeholder': string;
  'groups.optional': string;
  'groups.clear': string;
  'groups.hint': string;
  'groups.rename': string;
  'groups.renameButton': string;
  'groups.delete': string;
  'groups.deleteBody': string;
  'groups.renamed': string;
  'groups.deleted': string;
  'groups.new': string;
  'groups.newEllipsis': string;
  'groups.chooseAccounts': string;
  'groups.create': string;
  'menu.copy': string;
  'menu.pin': string;
  'menu.unpin': string;
  'menu.pinned': string;
  'menu.moveToGroup': string;
  'menu.select': string;
  'select.count': string;
  'select.pickFor': string;
  'select.all': string;
  'select.none': string;
  'select.moveHere': string;
  'select.delete': string;
  'select.deleteTitle': string;
  'select.deleteBody': string;
  'select.deleteConfirm': string;
  'select.deleted': string;
  'accounts.moved': string;
  'accounts.movedOut': string;

  // Accounts
  'accounts.noAccountsFound': string;
  'accounts.tryDifferentSearch': string;
  'accounts.addAccount': string;
  'accounts.or': string;
  'accounts.importFromBackup': string;
  'accounts.copied': string;
  'accounts.copyFailed': string;
  'accounts.checkingTime': string;
  'accounts.invalidSecret': string;
  'scan.batchMore': string;
  'scan.batchBody': string;
  'scan.batchLast': string;
  'scan.scanNext': string;
  'import.qrBatch': string;
  'held.title': string;
  'held.body': string;
  'held.banner': string;
  'recovery.title': string;
  'recovery.body': string;
  'recovery.retry': string;
  'recovery.saveCopy': string;
  'accounts.clickToCopy': string;
  'accounts.suggested': string;
  'onboarding.title': string;
  'onboarding.question': string;
  'onboarding.ga.label': string;
  'onboarding.ga.sub': string;
  'onboarding.ga.steps': string;
  'onboarding.ga.more': string;
  'onboarding.ga.noCamera': string;
  'onboarding.new.label': string;
  'onboarding.new.sub': string;
  'onboarding.new.steps': string;
  'onboarding.new.more': string;
  'onboarding.manual.label': string;
  'onboarding.manual.sub': string;
  // One row for another app and a backup file (2026-10-27): the two were
  // 1 % each of first picks and took two of five rows.
  'onboarding.move.label': string;
  'onboarding.move.sub': string;
  'onboarding.move.steps': string;
  'onboarding.move.more': string;
  'onboarding.page.scan': string;
  'onboarding.new.noQr': string;
  'onboarding.asked.label': string;
  'onboarding.asked.steps': string;

  // Settings
  'settings.backupRestore': string;
  'settings.export': string;
  'settings.import': string;
  'settings.sync': string;
  'settings.syncHint': string;
  'settings.syncOverflow': string;
  'settings.clock': string;
  'settings.clockOk': string;
  'settings.clockOff': string;
  'settings.clockOffUncorrected': string;
  'settings.clockUnknown': string;
  'settings.clockRecheck': string;
  'settings.clockChecking': string;
  'settings.suggested': string;
  'settings.suggestedHint': string;
  'settings.quickFill': string;
  'settings.quickFillHint': string;
  'settings.viewMode': string;
  'settings.viewNormal': string;
  'settings.viewCompact': string;
  'settings.viewHidden': string;

  // Add Account Modal - errors
  'addAccount.errorNameRequired': string;
  'addAccount.errorInvalidSecret': string;
  'addAccount.errorInvalidQR': string;
  'addAccount.errorHotp': string;
  /** A code understood and refused: an OTP kind or parameters (MD5, 4 digits) we cannot generate */
  'addAccount.errorUnsupportedCode': string;
  /** An otpauth:// or migration QR whose payload cannot be read */
  'addAccount.errorDamagedQR': string;
  'addAccount.pastedMigration': string;
  'addAccount.errorScanFailed': string;
  'addAccount.errorNoQr': string;
  'addAccount.errorNameMissing': string;
  'addAccount.errorSecretMissing': string;
  'addAccount.errorSecretIsCode': string;
  'addAccount.errorSecretShort': string;
  'addAccount.errorSecretChars': string;
  'addAccount.errorNoQrScreen': string;
  'addAccount.missWhere': string;
  'addAccount.missPhone': string;
  'addAccount.moving': string;
  'addAccount.importFile': string;
  'addAccount.errorScreenHint': string;
  'addAccount.errorNoAccess': string;
  'addAccount.errorDropImage': string;

  // Add Account Modal - tips
  'addAccount.whereToFind': string;
  'addAccount.tipCantScan': string;
  'addAccount.tipKeyExample': string;
  'addAccount.tipKeyLength': string;
  'addAccount.tipPasteLink': string;
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
  'addAccount.codeType': string;
  'addAccount.codeTypeTotp': string;
  'addAccount.codeTypeSteam': string;
  'addAccount.cancel': string;
  'addAccount.add': string;
  'addAccount.uploadQR': string;
  'addAccount.dragDropQR': string;
  'addAccount.orClickToUpload': string;

  // Warnings
  'warning.timeSync': string;
  'warning.howToFix': string;
  'warning.clockOff': string;
  'warning.clockOffUncorrected': string;
  'warning.dismiss': string;

  // Delete confirmation
  'delete.confirm': string;
  'delete.warning': string;
  'delete.cannotUndo': string;

  // Review prompt
  'review.pitch': string;
  'review.rateStars': string;
  'review.later': string;

  // Theme
  'theme.toggle': string;

  // Update modal
  'update.title': string;
  'update.whatsNew': string;
  'update.gotIt': string;
  'update.feature.suggestedAccount': string;
  'update.feature.qrScanning': string;
  'update.feature.timeSync': string;
  'update.feature.autoLanguage': string;
  'update.feature.clockSources': string;
  'update.feature.groups': string;
  'update.feature.appearance': string;
  'update.feature.quickFill': string;
  'update.feature.pasteLinks': string;
  'update.feature.uriExport': string;
  'update.feature.accountInitials': string;
  'update.feature.passkeyUnlock': string;
  'update.feature.cxfExport': string;
  'update.learnMore': string;


  // Right-click fill
  'quickFill.menu': string;
  'quickFill.copied': string;
  'quickFill.manual': string;
  'quickFill.openApp': string;
  'quickFill.inserted': string;

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
  'vault.passkey.title': string;
  'vault.passkey.hint': string;
  'vault.passkey.add': string;
  'vault.passkey.remove': string;
  'vault.passkey.on': string;
  'vault.passkey.unlockButton': string;
  'vault.passkey.unsupported': string;
  'vault.passkey.failed': string;
  'vault.passkey.cancelled': string;
  'vault.passkey.confirmRegister': string;
  'vault.passkey.confirmUnlock': string;
  'vault.passkey.done': string;
  'vault.passkey.labelDefault': string;
  'vault.passkey.needsUnlock': string;

  'vault.recover.title': string;
  'vault.recover.text': string;
  'vault.recover.placeholder': string;
  'vault.recover.newPassword': string;
  'vault.recover.submit': string;
  'vault.recover.invalid': string;
  'vault.recover.back': string;
  'vault.recover.rotated': string;
  'vault.recover.passkeyRemoved': string;

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
  'export.cxf': string;
  'export.cxfHint': string;
  'settings.avatars': string;
  'settings.avatarsHint': string;
  'settings.version': string;
  'settings.rateUs': string;
  'export.uri': string;
  'export.uriHint': string;
  'export.uriSkipped': string;
  /** "{0}" accounts written to a CXF file, "{1}" Steam Guard accounts CXF cannot carry */
  'export.cxfSkippedSteam': string;
  'import.paste': string;
  'import.pasteTitle': string;
  'import.pasteBody': string;
  'import.uriUnreadable': string;
  'import.uriHotp': string;
  'import.uriUnsupported': string;
  'import.uriBatchSkipped': string;
  'import.uriCapped': string;
  'import.uriNothing': string;
  'export.password': string;
  'export.encryptedDone': string;

  'import.passwordTitle': string;
  'import.passwordText': string;
  'import.wrongPassword': string;
  'import.backupDamaged': string;

  'common.cancel': string;
  'common.back': string;
  'common.support': string;
  'common.requestFeature': string;

  'update.feature.vault': string;
  'update.feature.encryptedExport': string;
  'update.feature.recovery': string;
  'update.feature.suggestedToggle': string;
  'update.feature.cameraScan': string;
  'import.qrNothingNew': string;
  'import.qrSuccessPartial': string;
  'import.qrSuccessGroup': string;
  'import.qrSuccessPartialGroup': string;
  'common.ok': string;
  'common.confirm': string;
  'accounts.added': string;
  'accounts.addedToGroup': string;
  'accounts.updated': string;
  'accounts.deleted': string;
  'accounts.alreadyExists': string;
  'accounts.updateFailed': string;
  'accounts.deleteFailed': string;
  'import.qrSkipped': string;
  'load.recovering': string;
  'load.fromBackup': string;
  'load.failed': string;
  'scan.saveFailedTitle': string;
  'scan.refusedTitle': string;
  'scan.errorBody': string;
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
  'scan.deniedStep1': string;
  'scan.deniedStep2': string;
  'scan.deniedStep3': string;
  'scan.dismissedTitle': string;
  'scan.dismissedBody': string;
  'scan.allowLabel': string;
  'scan.waitingHint': string;
  'scan.systemTitle': string;
  'scan.systemBody': string;
  'scan.busyTitle': string;
  'scan.busyBody': string;
  'scan.noCameraTitle': string;
  'scan.noCameraBody': string;
  'scan.lockedTitle': string;
  'scan.lockedBody': string;
  'scan.errorTitle': string;
  'scan.selectCamera': string;
  'scan.uploadHint': string;
  'accounts.emptyGroup': string;
  'accounts.clearFilters': string;
  'edit.nameRequired': string;
  'addAccount.errorInvalidPeriod': string;
  /** A save that failed after the form was filled in — see AddAccountModal. */
  'addAccount.errorSaveFailed': string;
  'import.successUnreadable': string;

  // Sharing codes by link. `share.title` is also the card button's tooltip.
  'share.title': string;
  /** {0} — the chosen duration, from share.minutes or share.hour */
  'share.intro': string;
  'share.label': string;
  'share.duration': string;
  /** "{0} min" */
  'share.minutes': string;
  'share.hour': string;
  'share.password': string;
  'share.passwordHint': string;
  'share.create': string;
  'share.creating': string;
  'share.scan': string;
  'share.copy': string;
  'share.copied': string;
  /** "Works until {0}" — a clock time */
  'share.validUntil': string;
  'share.passwordReminder': string;
  'share.caution': string;
  'share.failed': string;
  'share.periodTooShort': string;
  'share.done': string;
  // Restoring from the automatic daily snapshots
  'restore.title': string;
  'restore.hint': string;
  'restore.none': string;
  'restore.older': string;
  /** "{0} account(s)" — what one snapshot holds */
  'restore.count': string;
  'restore.ageToday': string;
  /** "{0} day(s) ago" */
  'restore.ageDays': string;
  'restore.ageUnknown': string;
  'restore.action': string;
  'restore.busy': string;
  'restore.done': string;
  'restore.nothingNew': string;
  'restore.held': string;
  'restore.failed': string;
  'restore.gone': string;
  'restore.locked': string;
  'restore.confirmTitle': string;
  /** "{0}" — how long ago the snapshot was taken */
  'restore.confirmBody': string;
  'restore.offerTitle': string;
  'restore.offerBody': string;
  'restore.offerAction': string;
  'update.feature.shareCodes': string;
  'update.feature.openIn': string;
  'update.feature.restoreBackups': string;
  'update.feature.accountMenu': string;
  'update.feature.groupTools': string;
  'update.feature.pinAccounts': string;
  'update.feature.importApps': string;
  'update.feature.keyboard': string;
  'edit.secretHint': string;
  'edit.secretDuplicate': string;
  'accounts.notFound': string;
  'accounts.reorderFailed': string;
  'settings.syncFailed': string;
  'import.imageUnreadable': string;
  'crash.title': string;
  'crash.body': string;
  'crash.reload': string;
  'crash.saveCopy': string;
  /** "Camera {0}" — a camera the browser reports without a name */
  'scan.cameraN': string;
  'recovery.saveCopyFailed': string;
  /** "{0} accounts added." — a file or a pasted list, never a QR */
  'import.fileAdded': string;
  /** "{0}" accounts in the file the list already held */
  'import.fileAlreadyHere': string;
  'import.fileEmpty': string;
  /** "{0}" entries with no usable secret */
  'import.fileUnreadable': string;
  /** "{0}" entries of a code type or parameters we refuse: HOTP, MD5, 4 digits… */
  'import.fileUnsupported': string;
  'import.unknownFormat': string;
  'import.nothingReadable': string;
  'import.onlyUnsupported': string;
  /** "{0}" — the app that encrypted the file: Aegis, 2FAS, Bitwarden */
  'import.encryptedElsewhere': string;
  /** An encrypted Steam Desktop Authenticator .maFile or manifest */
  'import.steamEncrypted': string;
  /** Accounts already in the list that an import switched from TOTP to Steam Guard codes. */
  'import.steamUpdated': string;

  // Deleting can be taken back for a few seconds
  'common.undo': string;
  'accounts.restored': string;
  'accounts.undoFailed': string;

  // Names for controls that are only an icon — read out by screen readers
  'common.close': string;
  'a11y.showPassword': string;
  'a11y.showKey': string;
  'search.clear': string;

  /** Placeholder of the second field in the password-protected export. */
  'export.passwordConfirm': string;

  // The order of the account list
  'settings.sort': string;
  'settings.sortManual': string;
  'settings.sortService': string;
  'settings.sortName': string;
  'settings.sortHint': string;

  /** A switch in Settings whose new value could not be written. */
  'settings.saveFailed': string;

  // The titles over the groups in Settings. Backup uses settings.backupRestore.
  'settings.sectionSecurity': string;
  'settings.sectionList': string;
  // Appearance: the style (classic, or the Apple-like one stored as 'apple') and light or dark
  'settings.sectionAppearance': string;
  'settings.style': string;
  'settings.styleClassic': string;
  'settings.styleApple': string;
  'settings.theme': string;
  'settings.themeLight': string;
  'settings.themeDark': string;
  'settings.sectionBrowser': string;
  'settings.sectionDiagnostics': string;
};

// Strings that count something carry plural blocks —
// "{0, plural, one {# account} other {# accounts}}" — rather than "account(s)";
// see parsePluralBlocks in i18n.ts. They are still one string per key, so every
// language must still define every key.


/** The paywall, Pro in Settings and the free-limit hints (billing/). */
type BillingTranslationKeys = {
  'paywall.back': string;
  'paywall.default.title': string;
  'paywall.default.body': string;
  'paywall.support.title': string;
  'paywall.support.body': string;
  'paywall.private.title': string;
  'paywall.private.body': string;
  'paywall.everything.title': string;
  'paywall.everything.body': string;
  'paywall.importOver': string;
  'paywall.importNoRoom': string;
  'paywall.backup.title': string;
  'paywall.backup.body': string;
  'paywall.benefitUnlimited': string;
  'paywall.benefitPrivate': string;
  'paywall.benefitBackup': string;
  'paywall.backupAuto': string;
  'paywall.backupRestore': string;
  'paywall.planMonth': string;
  'paywall.planYear': string;
  'paywall.planLife': string;
  'paywall.planPass': string;
  'paywall.perMonth': string;
  'paywall.perYear': string;
  'paywall.once': string;
  'paywall.yearNote': string;
  'paywall.lifeNote': string;
  'paywall.passNote': string;
  'paywall.monthNote': string;
  'paywall.save': string;
  'paywall.trial': string;
  'paywall.continue': string;
  'paywall.opening': string;
  'paywall.checkoutOpened': string;
  'paywall.addFree': string;
  'paywall.haveKey': string;
  'paywall.keyPlaceholder': string;
  'paywall.activate': string;
  'paywall.restore': string;
  'paywall.restoreHint': string;
  'paywall.emailPlaceholder': string;
  'paywall.send': string;
  'paywall.restoreSent': string;
  'paywall.legal': string;
  'paywall.unavailable': string;
  'paywall.retry': string;
  'billing.error.network': string;
  'billing.error.invalidKey': string;
  'billing.error.inactive': string;
  'billing.error.deviceLimit': string;
  'billing.error.payments': string;
  'billing.error.rateLimited': string;
  'billing.error.generic': string;
  'billing.activated': string;
  'paywall.priceChanged': string;
  'billing.heldAdded': string;
  'billing.heldWaiting': string;
  'billing.heldDiscard': string;
  'pro.title': string;
  'pro.statusFree': string;
  'pro.statusUnlimitedFree': string;
  'pro.statusLife': string;
  'pro.statusSub': string;
  'pro.statusPass': string;
  'pro.statusComp': string;
  'pro.keyHint': string;
  'pro.get': string;
  'pro.support': string;
  'pro.supportHint': string;
  'pro.manage': string;
  'pro.removeHere': string;
  'pro.removeConfirmTitle': string;
  'pro.removeConfirmBody': string;
  'pro.removeConfirm': string;
  'pro.removed': string;
  'pro.pending': string;
  'pro.checkNow': string;
  'cloud.title': string;
  'cloud.teaser': string;
  'cloud.hintOff': string;
  'cloud.turnOn': string;
  'cloud.needCode': string;
  'cloud.codeLabel': string;
  'cloud.continue': string;
  'cloud.wrongCode': string;
  'cloud.damaged': string;
  'cloud.failed': string;
  'cloud.lostCode': string;
  'cloud.startOverTitle': string;
  'cloud.startOverBody': string;
  'cloud.startOverConfirm': string;
  'cloud.onLast': string;
  'cloud.onNoCopy': string;
  'cloud.lapsed': string;
  'cloud.backupNow': string;
  'cloud.backingUp': string;
  'cloud.backedUp': string;
  'cloud.thisBrowser': string;
  'cloud.otherBrowser': string;
  'cloud.restoreConfirmTitle': string;
  'cloud.restoreConfirmBody': string;
  'cloud.turnOff': string;
  'cloud.turnOffTitle': string;
  'cloud.turnOffBody': string;
  'cloud.turnOffConfirm': string;
  'cloud.turnedOff': string;
  'cloud.setup.title': string;
  'cloud.setup.text': string;
  'cloud.setup.download': string;
  'cloud.setup.warning': string;
  'cloud.setup.confirm': string;
  'cloud.setup.mismatch': string;
  'cloud.setup.finish': string;
  'cloud.setup.working': string;
  'cloud.setup.done': string;
  'cloud.loading': string;
  'cloud.listFailed': string;
  'cloud.lastFailed': string;
  'cloud.noLicenseHere': string;
  'cloud.keyRestoreLink': string;
  'cloud.find': string;
  'cloud.noCopies': string;
  'cloud.resetHint': string;
  'cloud.showCode': string;
  'cloud.hideCode': string;
  'cloud.nothing': string;
  'cloud.setup.taken': string;
  'scan.limitTitle': string;
  'scan.limitBody': string;
};

/** A complete set of strings for one language. */
export type TranslationStrings = TranslationKeys & VaultTranslationKeys & BillingTranslationKeys;

export type TranslationKey = keyof TranslationStrings;
