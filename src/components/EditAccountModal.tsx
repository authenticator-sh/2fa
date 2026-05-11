import { useState } from 'react';
import { X, Eye, EyeOff } from 'lucide-react';
import type { Account } from '@/types';
import { createT, type Language } from '@/utils/i18n';

interface EditAccountModalProps {
  account: Account;
  onClose: () => void;
  onSave: (id: string, updates: Partial<Account>) => Promise<void>;
  language: Language;
}

export function EditAccountModal({ account, onClose, onSave, language }: EditAccountModalProps) {
  const t = createT(language);
  const [name, setName] = useState(account.name);
  const [issuer, setIssuer] = useState(account.issuer);
  const [showSecret, setShowSecret] = useState(false);
  const [saving, setSaving] = useState(false);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();

    const updates: Partial<Account> = {};
    if (name !== account.name) updates.name = name;
    if (issuer !== account.issuer) updates.issuer = issuer;

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
                onChange={(e) => setName(e.target.value)}
                className="w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500"
              />
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
                  className="w-full bg-gray-50 dark:bg-dark-900/50 text-gray-900 dark:text-gray-100 text-sm font-mono rounded-lg px-3 py-2 pr-10 border border-gray-300 dark:border-dark-600 outline-none cursor-default"
                />
                <button
                  type="button"
                  onClick={() => setShowSecret(!showSecret)}
                  className="absolute right-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-1"
                >
                  {showSecret ? <EyeOff size={16} /> : <Eye size={16} />}
                </button>
              </div>
            </div>

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
