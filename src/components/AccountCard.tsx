import { useState } from 'react';
import { Copy, Check, Trash2, GripVertical, Pencil } from 'lucide-react';
import type { Account } from '@/types';
import { useTOTP } from '@/hooks/useTOTP';
import { createT, type Language } from '@/utils/i18n';
import { recordAccountUsage } from '@/utils/suggestions';
import { takePickPrompt } from '@/utils/quick-fill';
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
  /** Off while the list is already filtered to one group — the chip says it. */
  showGroup?: boolean;
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
  showGroup,
}: AccountCardProps) {
  const t = createT(language);
  const totp = useTOTP(account);
  const [copied, setCopied] = useState(false);

  const handleCopy = async () => {
    if (!totp) return;
    try {
      await navigator.clipboard.writeText(totp.code);
    } catch (error) {
      // Rejected when the document is not focused, or by policy. Swallowing it
      // silently left the user unable to tell a failed copy from a misclick.
      console.error('Could not copy the code to the clipboard', error);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
    if (currentDomain) {
      // What this copy is worth depends on why the popup is open. Opened by
      // quick fill because it could not tell which account this site wants,
      // the answer names the site. Opened from the toolbar, the code may
      // equally be going into a desktop VPN client or an SSH prompt, and the
      // site behind the popup is a coincidence.
      takePickPrompt(currentDomain)
        .then(answeredPrompt => recordAccountUsage(currentDomain, account.id, answeredPrompt ? 'site' : 'copy'))
        .catch(() => {});
    }
  };

  const suggestedBadge = isSuggested ? (
    <span className="flex-shrink-0 text-[10px] font-medium leading-none text-[#4285F4] bg-blue-50/70 dark:bg-blue-900/25 border border-blue-200/70 dark:border-blue-800/60 px-1.5 py-[3px] rounded-full">
      {t('accounts.suggested')}
    </span>
  ) : null;

  // Typed, not assumed: `group` can come from an imported file, and until the
  // import path started coercing it a number here threw on `.trim()` and took
  // the whole popup down with it.
  const groupName = typeof account.group === 'string' ? account.group.trim() : '';

  /**
   * @param compact Halves the cap and lets the badge shrink.
   *
   * The compact row is one line where the name is the only thing that can give
   * way, so a wide badge eats it: at the default width a 110px badge left about
   * four characters of the account name, and at the 320px "Small" popup the row
   * overflowed outright. Truncating the group — which the chip strip above
   * already names — costs less than truncating the account.
   */
  const badgeClass = (compact: boolean) =>
    `${compact ? 'min-w-0 max-w-[70px]' : 'flex-shrink-0 max-w-[110px]'} truncate text-[10px] font-medium leading-none text-gray-600 dark:text-gray-300 bg-gray-100 dark:bg-dark-700 border border-gray-200 dark:border-dark-600 px-1.5 py-[3px] rounded-full`;

  const groupBadgeFor = (compact: boolean) =>
    showGroup && groupName ? <span className={badgeClass(compact)}>{groupName}</span> : null;

  const groupBadge = groupBadgeFor(false);

  const formattedCode = totp ? totp.code.match(/.{1,3}/g)?.join(' ') || totp.code : '';
  const isExpiringSoon = totp ? totp.remaining <= 5 : false;

  const dragProps = {
    draggable,
    onDragStart: (e: React.DragEvent) => onDragStart?.(e, account.id),
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); onDragOver?.(e); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); onDrop?.(e, account.id); },
  };

  const baseClass = `relative group bg-white dark:bg-dark-800 hover:bg-gray-50 dark:hover:bg-dark-700 transition-all duration-200 after:content-[''] after:absolute after:bottom-0 after:inset-x-4 after:h-px after:bg-gray-200 dark:after:bg-dark-600 last:after:hidden ${
    isDragOver ? 'border-t-2 border-[#4285F4]' : ''
  }`;

  /**
   * A record whose secret cannot produce a code.
   *
   * Placed ahead of the three view modes so every one of them is covered by a
   * single branch. It deliberately keeps Edit and Delete reachable: this row is
   * the only handle the user has on a record that would otherwise be unfixable
   * from inside the app, and the secret is very often one paste away from being
   * correct.
   */
  if (!totp) {
    return (
      <div {...dragProps} className={`${baseClass} px-4 py-3`}>
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <div className="truncate text-sm font-medium text-gray-900 dark:text-gray-100">
              {account.issuer}
              {account.issuer && account.name ? ': ' : ''}
              {account.name}
            </div>
            <div className="mt-0.5 text-xs text-red-600 dark:text-red-400">
              {t('accounts.invalidSecret')}
            </div>
          </div>

          <div className="flex flex-shrink-0 items-center gap-0.5">
            <button
              onClick={() => onEdit(account)}
              className="rounded p-1 text-gray-400 hover:bg-gray-100 hover:text-gray-600 dark:hover:bg-dark-600 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="rounded p-1 text-gray-400 hover:bg-red-50 hover:text-red-500 dark:hover:bg-red-900/30"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={13} />
            </button>
          </div>
        </div>
      </div>
    );
  }

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
            className="flex-1 min-w-0 flex items-center gap-2 text-start group/copy"
          >
            <span className="min-w-0 text-sm font-medium text-gray-900 dark:text-gray-100 truncate">
              {account.issuer}{account.issuer && account.name ? ': ' : ''}{account.name}
            </span>
            {suggestedBadge}
            {groupBadgeFor(true)}
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

          {/* Same 26px ring as the compact row: at the default 40 the mode that
              hides the codes ended up the tallest of the three. */}
          <div className="flex-shrink-0">
            <ProgressRing remaining={totp.remaining} period={totp.period} size={26} />
          </div>
        </div>
      </div>
    );
  }

  // Compact mode — one row per account.
  //
  // Stacking the name over the code left compact barely shorter than a normal
  // card while opening a wide gap between the code and the ring. On one line the
  // name takes the slack, the code sits against the ring, and twice as many
  // accounts fit on screen — which is the only reason to pick this mode.
  if (viewMode === 'compact') {
    return (
      // overflow-hidden so a row that runs out of width clips instead of laying
      // the code and the copy icon over the hover actions and the ring.
      <div {...dragProps} className={`${baseClass} py-1.5 px-4 overflow-hidden`}>
        <div className="flex items-center gap-2">
          {draggable && (
            <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-gray-400 dark:text-gray-500 flex-shrink-0">
              <GripVertical size={14} />
            </div>
          )}

          <button
            onClick={handleCopy}
            className="flex-1 min-w-0 flex items-center gap-2 text-start group/copy"
          >
            {/* min-w-0: a flex item will not shrink below its content without
                it, so a long name would push the code off the row instead of
                truncating. */}
            <span className="min-w-0 text-sm text-gray-700 dark:text-gray-300 truncate">
              {account.issuer}{account.issuer && account.name ? ': ' : ''}{account.name}
            </span>
            {suggestedBadge}
            {groupBadgeFor(true)}
            <span className={`ms-auto flex-shrink-0 font-mono text-base tracking-wide transition-colors ${
              isExpiringSoon
                ? 'text-orange-600 dark:text-orange-400 animate-pulse'
                : 'text-[#4285F4]'
            }`}>
              {formattedCode}
            </span>
            <span className={`flex-shrink-0 transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
              {copied ? (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={14} className="text-gray-400 dark:text-gray-500" />
              )}
            </span>
          </button>

          {/* Always in the flow, only faded: revealing them on hover by taking
              them out of the layout would shove the code sideways under the
              cursor, and the code is what the row exists to show. */}
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
            <ProgressRing remaining={totp.remaining} period={totp.period} size={26} />
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
          {groupBadge}
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
          {/* Sits directly after the digits rather than pushed to the far right:
              the icon belongs to the code it copies, and across the width of the
              card it read as an unrelated control. The label goes after the icon
              so appearing does not shove the icon sideways. */}
          <div className="flex items-center gap-2">
            <div className={`transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
              {copied ? (
                <Check size={16} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={16} className="text-gray-400 dark:text-gray-500" />
              )}
            </div>
            {copied && (
              <span className="text-xs font-medium text-green-600 dark:text-green-400 animate-in fade-in slide-in-from-left-1 duration-200">
                {t('accounts.copied')}
              </span>
            )}
          </div>
        </button>

        <div className="ms-2">
          <ProgressRing remaining={totp.remaining} period={totp.period} />
        </div>
      </div>
    </div>
  );
}
