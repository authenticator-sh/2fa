import { useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type { Account } from '@/types';
import { GroupInput } from './GroupInput';
import { createT, type Language } from '@/utils/i18n';

interface EditAccountModalProps {
  account: Account;
  onClose: () => void;
  onSave: (id: string, updates: Partial<Account>) => Promise<void>;
  language: Language;
  /** Existing group names, offered as suggestions — the field stays free text. */
  groups?: string[];
}

export function EditAccountModal({ account, onClose, onSave, language, groups = [] }: EditAccountModalProps) {
  const t = createT(language);
  const [name, setName] = useState(account.name);
  const [issuer, setIssuer] = useState(account.issuer);
  const [group, setGroup] = useState(account.group ?? '');
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    // The add form has always required a name; this one did not, so the field
    // could be emptied and saved. Beyond leaving a row with nothing to identify
    // it, a nameless account used to make the whole backup file it ended up in
    // unimportable — the import rejected the file on the first entry missing a
    // name, taking every good account with it.
    const trimmedName = name.trim();
    if (!trimmedName) {
      setError(t('edit.nameRequired'));
      return;
    }

    const updates: Partial<Account> = {};
    if (trimmedName !== account.name) updates.name = trimmedName;
    if (issuer !== account.issuer) updates.issuer = issuer;

    // Blank clears the group rather than storing an empty string, so an account
    // the user emptied out counts as ungrouped everywhere without a second case
    // to check. updateAccount drops the key on `undefined`.
    const nextGroup = group.trim();
    if (nextGroup !== (account.group?.trim() ?? '')) {
      updates.group = nextGroup || undefined;
    }

    if (Object.keys(updates).length === 0) {
      onClose();
      return;
    }

    setSaving(true);
    try {
      await onSave(account.id, updates);
      onClose();
    } finally {
      setSaving(false);
    }
  };

  const maskedSecret = account.secret.replace(/./g, '\u2022');

  return (
    <div className="fixed inset-0 bg-black/40 backdrop-blur-sm flex items-center justify-center z-50 p-4">
      <div className="bg-white dark:bg-dark-800 rounded-lg border border-gray-200 dark:border-dark-600 max-w-md w-full max-h-[90vh] overflow-y-auto shadow-xl">
        <div className="sticky top-0 bg-white dark:bg-dark-800 border-b border-gray-200 dark:border-dark-600 p-4 flex items-center justify-between">
          <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{t('edit.title')}</h2>
          <button
            onClick={onClose}
            className="text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-1"
          >
            <X size={20} />
          </button>
        </div>

        <div className="p-4">
          <form onSubmit={handleSubmit} className="space-y-4">
            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('addAccount.accountName')}
              </label>
              <input
                type="text"
                value={name}
                onChange={(e) => {
                  setName(e.target.value);
                  if (error) setError(null);
                }}
                aria-invalid={error ? true : undefined}
                className={`w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500 ${
                  error
                    ? 'border-red-400 dark:border-red-500 focus:border-red-500'
                    : 'border-gray-300 dark:border-dark-600 focus:border-[#4285F4]'
                }`}
              />
              {error && (
                <p className="mt-1.5 text-xs text-red-600 dark:text-red-400">{error}</p>
              )}
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('addAccount.issuer')}
              </label>
              <input
                type="text"
                value={issuer}
                onChange={(e) => setIssuer(e.target.value)}
                className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500"
              />
            </div>

            <div>
              <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                {t('addAccount.secretKey')}
              </label>
              <div className="relative">
                <input
                  type="text"
                  value={showSecret ? account.secret : maskedSecret}
                  readOnly
                  className="w-full bg-gray-50 dark:bg-dark-900/50 text-gray-900 dark:text-gray-100 text-sm font-mono rounded-lg px-3 py-2 pe-10 border border-gray-300 dark:border-dark-600 outline-none cursor-default"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute end-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-1"
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

            {/* Last, because it is the only optional field here — an empty box
                above the ones that must be filled reads as another required
                step. */}
            <GroupInput
              inputId="edit-account-group"
              value={group}
              onChange={setGroup}
              groups={groups}
              language={language}
            />

            <div className="flex items-center gap-3 pt-2">
              <button
                type="button"
                onClick={onClose}
                className="text-sm text-gray-600 dark:text-gray-400 hover:text-gray-900 dark:hover:text-gray-100 transition-colors"
              >
                {t('addAccount.cancel')}
              </button>
              <button
                type="submit"
                disabled={saving}
                className="flex-1 bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors disabled:opacity-50"
              >
                {t('edit.save')}
              </button>
            </div>
          </form>
        </div>
      </div>
    </div>
  );
}
