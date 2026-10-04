// The few strings the service worker shows, in all twenty languages.
//
// The worker cannot load a language on demand — Chrome refuses `import()` in a
// service worker — so whatever it needs has to be in its bundle. It used to
// import every full table for that: twenty files, over 700 KB of source and
// most of the worker's size, parsed on every wake (each shortcut press, each
// menu click, each storage change) to use four strings out of each.
//
// Copied from the tables in utils/locales, not written here: those remain the
// one place a translation is edited. test/quick-fill.test.ts compares every
// entry below with its table and fails on any difference, and the keys are
// typed, so a string added to the worker without being added here does not
// compile.

import type { TranslationKey } from '@/utils/i18n-keys';
import type { Language } from '@/utils/language';

export const WORKER_KEYS = ['quickFill.menu', 'quickFill.copied', 'quickFill.manual', 'quickFill.openApp'] as const;

export type WorkerKey = (typeof WORKER_KEYS)[number] & TranslationKey;

export const WORKER_STRINGS: Record<Language, Record<WorkerKey, string>> = {
  en: {
    "quickFill.menu": "Insert 2FA code",
    "quickFill.copied": "Code copied — paste it into the field",
    "quickFill.manual": "Your code: {0}",
    "quickFill.openApp": "Open the extension to pick an account",
  },
  ar: {
    "quickFill.menu": "إدراج رمز 2FA",
    "quickFill.copied": "تم نسخ الرمز — الصقه في الحقل",
    "quickFill.manual": "رمزك: {0}",
    "quickFill.openApp": "افتح الإضافة لاختيار حساب",
  },
  de: {
    "quickFill.menu": "2FA-Code einfügen",
    "quickFill.copied": "Code kopiert – fügen Sie ihn in das Feld ein",
    "quickFill.manual": "Ihr Code: {0}",
    "quickFill.openApp": "Öffnen Sie die Erweiterung, um ein Konto zu wählen",
  },
  es: {
    "quickFill.menu": "Insertar código 2FA",
    "quickFill.copied": "Código copiado: pégalo en el campo",
    "quickFill.manual": "Tu código: {0}",
    "quickFill.openApp": "Abre la extensión para elegir una cuenta",
  },
  fr: {
    "quickFill.menu": "Insérer le code 2FA",
    "quickFill.copied": "Code copié — collez-le dans le champ",
    "quickFill.manual": "Votre code : {0}",
    "quickFill.openApp": "Ouvrez l’extension pour choisir un compte",
  },
  hi: {
    "quickFill.menu": "2FA कोड डालें",
    "quickFill.copied": "कोड कॉपी हो गया — इसे फ़ील्ड में पेस्ट करें",
    "quickFill.manual": "आपका कोड: {0}",
    "quickFill.openApp": "खाता चुनने के लिए एक्सटेंशन खोलें",
  },
  id: {
    "quickFill.menu": "Sisipkan kode 2FA",
    "quickFill.copied": "Kode disalin — tempel ke kolom",
    "quickFill.manual": "Kode Anda: {0}",
    "quickFill.openApp": "Buka ekstensi untuk memilih akun",
  },
  it: {
    "quickFill.menu": "Inserisci codice 2FA",
    "quickFill.copied": "Codice copiato: incollalo nel campo",
    "quickFill.manual": "Il tuo codice: {0}",
    "quickFill.openApp": "Apri l’estensione per scegliere un account",
  },
  ja: {
    "quickFill.menu": "2FAコードを入力",
    "quickFill.copied": "コードをコピーしました — 入力欄に貼り付けてください",
    "quickFill.manual": "コード: {0}",
    "quickFill.openApp": "拡張機能を開いてアカウントを選んでください",
  },
  ko: {
    "quickFill.menu": "2FA 코드 입력",
    "quickFill.copied": "코드를 복사했습니다 — 입력란에 붙여넣으세요",
    "quickFill.manual": "코드: {0}",
    "quickFill.openApp": "확장 프로그램을 열어 계정을 선택하세요",
  },
  nl: {
    "quickFill.menu": "2FA-code invoegen",
    "quickFill.copied": "Code gekopieerd — plak hem in het veld",
    "quickFill.manual": "Jouw code: {0}",
    "quickFill.openApp": "Open de extensie om een account te kiezen",
  },
  pl: {
    "quickFill.menu": "Wstaw kod 2FA",
    "quickFill.copied": "Kod skopiowany — wklej go do pola",
    "quickFill.manual": "Twój kod: {0}",
    "quickFill.openApp": "Otwórz rozszerzenie, aby wybrać konto",
  },
  pt: {
    "quickFill.menu": "Inserir código 2FA",
    "quickFill.copied": "Código copiado — cole no campo",
    "quickFill.manual": "Seu código: {0}",
    "quickFill.openApp": "Abra a extensão para escolher uma conta",
  },
  ru: {
    "quickFill.menu": "Вставить код 2FA",
    "quickFill.copied": "Код скопирован — вставьте его в поле",
    "quickFill.manual": "Ваш код: {0}",
    "quickFill.openApp": "Откройте расширение и выберите аккаунт",
  },
  sv: {
    "quickFill.menu": "Infoga 2FA-kod",
    "quickFill.copied": "Koden är kopierad – klistra in den i fältet",
    "quickFill.manual": "Din kod: {0}",
    "quickFill.openApp": "Öppna tillägget för att välja ett konto",
  },
  th: {
    "quickFill.menu": "ใส่รหัส 2FA",
    "quickFill.copied": "คัดลอกรหัสแล้ว — วางลงในช่อง",
    "quickFill.manual": "รหัสของคุณ: {0}",
    "quickFill.openApp": "เปิดส่วนขยายเพื่อเลือกบัญชี",
  },
  tr: {
    "quickFill.menu": "2FA kodunu ekle",
    "quickFill.copied": "Kod kopyalandı — alana yapıştırın",
    "quickFill.manual": "Kodunuz: {0}",
    "quickFill.openApp": "Hesap seçmek için uzantıyı açın",
  },
  uk: {
    "quickFill.menu": "Вставити код 2FA",
    "quickFill.copied": "Код скопійовано — вставте його в поле",
    "quickFill.manual": "Ваш код: {0}",
    "quickFill.openApp": "Відкрийте розширення, щоб вибрати обліковий запис",
  },
  vi: {
    "quickFill.menu": "Chèn mã 2FA",
    "quickFill.copied": "Đã sao chép mã — hãy dán vào ô",
    "quickFill.manual": "Mã của bạn: {0}",
    "quickFill.openApp": "Mở tiện ích để chọn tài khoản",
  },
  zh: {
    "quickFill.menu": "插入 2FA 验证码",
    "quickFill.copied": "验证码已复制 — 请粘贴到输入框",
    "quickFill.manual": "你的验证码：{0}",
    "quickFill.openApp": "打开扩展以选择账户",
  },
};

/** As the app's t(), for this handful of keys: English for anything missing, {0} filled in. */
export function workerT(language: Language) {
  const table = WORKER_STRINGS[language] ?? WORKER_STRINGS.en;
  return (key: WorkerKey, ...args: (string | number)[]): string => {
    let text = table[key] || WORKER_STRINGS.en[key] || key;
    args.forEach((arg, i) => {
      // Through a function, as in getTranslation: `$&` in a value is text.
      text = text.replace(`{${i}}`, () => String(arg));
    });
    return text;
  };
}
