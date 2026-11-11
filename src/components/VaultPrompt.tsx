import { Lock, X } from 'lucide-react';
import { snoozeVaultPrompt } from '@/utils/vault-prompt';
import { createT, type Language } from '@/utils/i18n';

interface VaultPromptProps {
  language: Language;
  onEnable: () => void;
  onDismiss: () => void;
  /** The host's words for what is on offer (utils/host-vault.ts): Face ID on a phone. */
  text?: { title: string; text: string; cta: string };
}

/**
 * Shown in the account list once the user has a couple of accounts — see
 * vault-prompt.ts for why that moment and not install time. Deliberately a
 * strip, not a modal: nothing here should block getting to a code.
 */
export function VaultPrompt({ language, onEnable, onDismiss, text }: VaultPromptProps) {
  const t = createT(language);
  const words = text ?? { title: t('vault.prompt.title'), text: t('vault.prompt.text'), cta: t('vault.prompt.enable') };

  const handleSnooze = async () => {
    await snoozeVaultPrompt();
    onDismiss();
  };

  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 p-3 flex items-start gap-2">
      <Lock className="text-accent-600 dark:text-accent-300 flex-shrink-0 mt-0.5" size={16} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-blue-800 dark:text-blue-200">{words.title}</p>
        <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">{words.text}</p>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={onEnable}
            className="text-xs font-medium bg-accent-600 hover:bg-accent-700 text-white px-3 py-1 rounded transition-colors"
          >
            {words.cta}
          </button>
          <button
            onClick={handleSnooze}
            className="text-xs text-accent-600 dark:text-accent-300 hover:underline"
          >
            {t('vault.prompt.later')}
          </button>
        </div>
      </div>
      <button
        onClick={handleSnooze}
        aria-label={t('common.close')}
        title={t('common.close')}
        className="text-accent-600 dark:text-accent-300 hover:text-accent-700 dark:hover:text-blue-300 flex-shrink-0"
      >
        <X size={14} aria-hidden />
      </button>
    </div>
  );
}
