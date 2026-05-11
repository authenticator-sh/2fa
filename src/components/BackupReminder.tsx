import { Shield, X } from 'lucide-react';
import { snoozeReminder } from '@/utils/backup-reminder';
import { createT, type Language } from '@/utils/i18n';

interface BackupReminderProps {
  language: Language;
  onExport: () => void;
  onDismiss: () => void;
}

export function BackupReminder({ language, onExport, onDismiss }: BackupReminderProps) {
  const t = createT(language);

  const handleSnooze = async () => {
    await snoozeReminder();
    onDismiss();
  };

  return (
    <div className="bg-blue-50 dark:bg-blue-900/20 border-b border-blue-200 dark:border-blue-800 p-3 flex items-start gap-2">
      <Shield className="text-blue-600 dark:text-blue-400 flex-shrink-0 mt-0.5" size={16} />
      <div className="flex-1 min-w-0">
        <p className="text-xs font-medium text-blue-800 dark:text-blue-200">
          {t('backup.reminderTitle')}
        </p>
        <p className="text-xs text-blue-700 dark:text-blue-300 mt-0.5">
          {t('backup.reminderText')}
        </p>
        <div className="flex items-center gap-2 mt-2">
          <button
            onClick={onExport}
            className="text-xs font-medium bg-blue-600 hover:bg-blue-700 text-white px-3 py-1 rounded transition-colors"
          >
            {t('backup.export')}
          </button>
          <button
            onClick={handleSnooze}
            className="text-xs text-blue-600 dark:text-blue-400 hover:underline"
          >
            {t('backup.remindLater')}
          </button>
        </div>
      </div>
      <button
        onClick={handleSnooze}
        className="text-blue-400 dark:text-blue-500 hover:text-blue-600 dark:hover:text-blue-300 flex-shrink-0"
      >
        <X size={14} />
      </button>
    </div>
  );
}
