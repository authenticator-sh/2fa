// Background service worker for Authenticator extension
// Manifest V3 requires a service worker instead of background scripts

chrome.runtime.onInstalled.addListener((details) => {
  const supportedLanguages = ['en', 'zh', 'es', 'hi', 'ar', 'pt', 'ru', 'ja', 'de', 'fr', 'ko', 'it', 'tr', 'vi', 'pl', 'nl', 'id', 'th', 'uk', 'sv'];
  const browserLang = chrome.i18n.getUILanguage().split('-')[0];
  const lang = supportedLanguages.includes(browserLang) ? browserLang : 'en';

  chrome.runtime.setUninstallURL(`https://authenticator.sh/${lang}/uninstall`);

  if (details.reason === 'install') {
    chrome.tabs.create({ url: `https://authenticator.sh/${lang}/welcome` });
  }
});

export {};
