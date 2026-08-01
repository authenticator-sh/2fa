import { useState } from 'react';
import { Copy, Check, Trash2, GripVertical, Pencil } from 'lucide-react';
import type { Account } from '@/types';
import { useTOTP } from '@/hooks/useTOTP';
import { createT, type Language } from '@/utils/i18n';
import { recordAccountUsage } from '@/utils/suggestions';
import { ProgressRing } from './ProgressRing';

export type ViewMode = 'normal' | 'compact' | 'hidden';

interface AccountCardProps {
  account: Account;
  onDelete: (id: string) => void;
  onEdit: (account: Account) => void;
  language: Language;
  viewMode?: ViewMode;
  draggable?: boolean;
  onDragStart?: (e: React.DragEvent, id: string) => void;
  onDragOver?: (e: React.DragEvent) => void;
  onDrop?: (e: React.DragEvent, id: string) => void;
  isDragOver?: boolean;
  currentDomain?: string | null;
  isSuggested?: boolean;
}

export function AccountCard({
  account,
  onDelete,
  onEdit,
  language,
  viewMode = 'normal',
  draggable,
  onDragStart,
  onDragOver,
  onDrop,
  isDragOver,
  currentDomain,
  isSuggested,
}: AccountCardProps) {
  const t = createT(language);
  const totp = useTOTP(account);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    await navigator.clipboard.writeText(totp.code);
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (currentDomain) {
      recordAccountUsage(currentDomain, account.id).catch(() => {});
    }
  };

  const suggestedBadge = isSuggested ? (
    <span className="flex-shrink-0 text-[10px] font-medium leading-none text-[#4285F4] bg-blue-50/70 dark:bg-blue-900/25 border border-blue-200/70 dark:border-blue-800/60 px-1.5 py-[3px] rounded-full">
      {t('accounts.suggested')}
    </span>
  ) : null;

  const formattedCode = totp.code.match(/.{1,3}/g)?.join(' ') || totp.code;
  const isExpiringSoon = totp.remaining <= 5;

  const dragProps = {
    draggable,
    onDragStart: (e: React.DragEvent) => onDragStart?.(e, account.id),
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); onDragOver?.(e); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); onDrop?.(e, account.id); },
  };

  const baseClass = `relative group bg-white dark:bg-dark-800 hover:bg-gray-50 dark:hover:bg-dark-700 transition-all duration-200 after:content-[''] after:absolute after:bottom-0 after:left-4 after:right-4 after:h-px after:bg-gray-200 dark:after:bg-dark-600 last:after:hidden ${
    isDragOver ? 'border-t-2 border-[#4285F4]' : ''
  }`;

  // Hidden mode — just name, click whole row to copy
  if (viewMode === 'hidden') {
    return (
      <div {...dragProps} className={`${baseClass} px-4 py-2.5`}>
        <div className="flex items-center gap-2">
          {draggable && (
            <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 dark:text-gray-500 flex-shrink-0">
              <GripVertical size={14} />
            </div>
          )}

          <button
            onClick={handleCopy}
            className="flex-1 min-w-0 flex items-center gap-2 text-left group/copy"
          >
            <span className="text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {account.issuer}{account.issuer && account.name ? ': ' : ''}{account.name}
            </span>
            {suggestedBadge}
            <span className={`flex-shrink-0 transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
              {copied ? (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={14} className="text-gray-400 dark:text-gray-500" />
              )}
            </span>
            {copied && (
              <span className="flex-shrink-0 text-xs font-medium text-green-600 dark:text-green-400">
                {t('accounts.copied')}
              </span>
            )}
          </button>

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            <button
              onClick={() => onEdit(account)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="p-1 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-400 hover:text-red-500"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={13} />
            </button>
          </div>

          <div className="flex-shrink-0">
            <ProgressRing remaining={totp.remaining} period={totp.period} />
          </div>
        </div>
      </div>
    );
  }

  // Compact mode
  if (viewMode === 'compact') {
    return (
      <div {...dragProps} className={`${baseClass} py-2 px-4`}>
        <div className="flex items-center gap-2">
          {draggable && (
            <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 dark:text-gray-500 flex-shrink-0">
              <GripVertical size={14} />
            </div>
          )}

          <div className="flex-1 min-w-0">
            <div className="flex items-center gap-1.5">
              <h3 className="text-gray-500 dark:text-gray-400 text-xs truncate leading-tight">
                {account.issuer}{account.issuer && account.name ? ': ' : ''}{account.name}
              </h3>
              {suggestedBadge}
            </div>
            <button
              onClick={handleCopy}
              className="flex items-center gap-1.5 group/copy"
            >
              <span className={`font-mono text-lg tracking-wide transition-colors leading-tight ${
                isExpiringSoon
                  ? 'text-orange-600 dark:text-orange-400 animate-pulse'
                  : 'text-[#4285F4]'
              }`}>
                {formattedCode}
              </span>
              <span className={`transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
                {copied ? (
                  <Check size={14} className="text-green-600 dark:text-green-400" />
                ) : (
                  <Copy size={14} className="text-gray-400 dark:text-gray-500" />
                )}
              </span>
            </button>
          </div>

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0">
            <button
              onClick={() => onEdit(account)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="p-1 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-400 hover:text-red-500"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={13} />
            </button>
          </div>

          <div className="flex-shrink-0">
            <ProgressRing remaining={totp.remaining} period={totp.period} />
          </div>
        </div>
      </div>
    );
  }

  // Normal mode
  return (
    <div {...dragProps} className={`${baseClass} p-3 px-4`}>
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          <h3 className="text-gray-900 dark:text-gray-100 font-medium text-sm truncate">
            {account.issuer}: {account.name}
          </h3>
          {suggestedBadge}
          {draggable && (
            <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 dark:text-gray-500 flex-shrink-0">
              <GripVertical size={14} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          <button
            onClick={() => onEdit(account)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('edit.title')}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(account.id)}
            className="opacity-0 group-hover:opacity-100 transition-opacity p-1 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-400 hover:text-red-500"
            title={t('accounts.deleteAccount')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={handleCopy}
          className="flex-1 flex items-center gap-2 hover:bg-gray-50 dark:hover:bg-dark-700 rounded-lg p-1.5 -m-1.5 transition-colors group/copy relative"
        >
          <div className={`font-mono text-2xl tracking-wide transition-colors ${
            isExpiringSoon
              ? 'text-orange-600 dark:text-orange-400 animate-pulse'
              : 'text-[#4285F4]'
          }`}>
            {formattedCode}
          </div>
          <div className="ml-auto flex items-center gap-2">
            {copied && (
              <span className="text-xs font-medium text-green-600 dark:text-green-400 animate-in fade-in slide-in-from-right-2 duration-200">
                {t('accounts.copied')}
              </span>
            )}
            <div className={`transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
              {copied ? (
                <Check size={16} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={16} className="text-gray-400 dark:text-gray-500" />
              )}
            </div>
          </div>
        </button>

        <div className="ml-2">
          <ProgressRing remaining={totp.remaining} period={totp.period} />
        </div>
      </div>
    </div>
  );
}
