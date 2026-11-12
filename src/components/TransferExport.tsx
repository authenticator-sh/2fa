import { useMemo, useState } from 'react';
import { QrOverlay, type QrFrame } from './QrOverlay';
import { ModalHeader } from './ModalHeader';
import type { Account } from '@/types';
import { accountLabel } from '@/utils/account-label';
import { createT, type Language } from '@/utils/i18n';
import { buildMigrationURLs, migrationSkipReason, type MigrationSkipReason } from '@/utils/migration-parser';
import { totpParams } from '@/utils/totp';

interface TransferExportProps {
  accounts: Account[];
  language: Language;
  onClose: () => void;
}

/**
 * Choosing which accounts go to Google Authenticator, then showing them as a
 * series of migration QR codes.
 *
 * Accounts the format cannot carry are listed, so nobody wonders where one went,
 * but cannot be ticked. The selection survives closing the QR overlay.
 */
export function TransferExport({ accounts, language, onClose }: TransferExportProps) {
  const t = createT(language);

  const rows = useMemo(
    () => accounts.map(account => ({ account, reason: migrationSkipReason(account) })),
    [accounts]
  );
  const selectable = useMemo(() => rows.filter(row => row.reason === null).map(row => row.account.id), [rows]);
  const [selected, setSelected] = useState<Set<string>>(() => new Set(selectable));
  const [frames, setFrames] = useState<QrFrame[] | null>(null);

  const allSelected = selectable.length > 0 && selected.size === selectable.length;

  const reasonText = (account: Account, reason: MigrationSkipReason): string => {
    switch (reason) {
      case 'steam':
        return t('transfer.skipSteam');
      case 'secret':
        return t('transfer.skipSecret');
      case 'period':
        return t('transfer.skipPeriod', totpParams(account).period);
      default:
        return t('transfer.skipParams');
    }
  };

  const toggle = (id: string) =>
    setSelected(prev => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const next = () => {
    const chosen = accounts.filter(account => selected.has(account.id));
    const { batches } = buildMigrationURLs(chosen);
    if (batches.length === 0) return;
    let first = 1;
    setFrames(
      batches.map(batch => {
        const last = first + batch.accounts.length - 1;
        const caption = t('transfer.batchCaption', first, last, chosen.length);
        first = last + 1;
        return { caption, text: batch.url };
      })
    );
  };

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-dark-800 anim-sheet"
      role="dialog"
      aria-modal="true"
      aria-label={t('transfer.title')}
    >
      <ModalHeader title={t('transfer.title')} back={t('common.back')} onBack={onClose} />

      <div className="flex items-center justify-between gap-2 px-4 py-2 text-xs text-gray-600 dark:text-gray-400">
        <span>{t('transfer.selected', selected.size, selectable.length)}</span>
        <button
          type="button"
          disabled={selectable.length === 0}
          onClick={() => setSelected(allSelected ? new Set() : new Set(selectable))}
          className="font-medium text-accent-600 hover:underline disabled:opacity-40 dark:text-blue-300"
        >
          {allSelected ? t('transfer.selectNone') : t('transfer.selectAll')}
        </button>
      </div>

      <ul className="flex-1 overflow-y-auto px-4">
        {rows.map(({ account, reason }) => {
          const label = accountLabel(account);
          return (
            <li key={account.id} className="border-b border-gray-200 last:border-b-0 dark:border-dark-600">
              <label className={`flex items-center gap-3 py-2.5 ${reason ? 'opacity-60' : 'cursor-pointer'}`}>
                <input
                  type="checkbox"
                  checked={selected.has(account.id)}
                  disabled={reason !== null}
                  onChange={() => toggle(account.id)}
                  aria-label={label}
                  className="h-4 w-4 shrink-0 accent-blue-600"
                />
                <span className="min-w-0 flex-1 truncate text-sm text-gray-900 dark:text-gray-100" title={label}>
                  {label}
                </span>
                {reason && (
                  <span className="max-w-[45%] text-right text-[11px] leading-tight text-gray-500 dark:text-gray-400">
                    {reasonText(account, reason)}
                  </span>
                )}
              </label>
            </li>
          );
        })}
      </ul>

      <div className="sticky bottom-0 border-t border-gray-200 bg-gray-50 p-4 dark:border-dark-600 dark:bg-dark-800">
        <button
          type="button"
          disabled={selected.size === 0}
          onClick={next}
          className="w-full rounded-lg bg-accent-500 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-600 disabled:opacity-40"
        >
          {t('transfer.next', selected.size)}
        </button>
      </div>

      {frames && (
        <QrOverlay
          frames={frames}
          language={language}
          onClose={() => setFrames(null)}
          lastHint={t('transfer.lastHint', frames.length)}
        />
      )}
    </div>
  );
}
