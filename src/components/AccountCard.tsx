import { useState } from 'react';
import { Copy, Check, Trash2, GripVertical, Pencil, Share2 } from 'lucide-react';
import type { Account } from '@/types';
import { colorForKey } from '@/utils/qr-parser';
import { accountLabel } from '@/utils/account-label';
import { useTOTP } from '@/hooks/useTOTP';
import { createT, type Language } from '@/utils/i18n';
import { recordAccountUsage } from '@/utils/suggestions';
import { takePickPrompt } from '@/utils/quick-fill';
import { ProgressRing } from './ProgressRing';
import { TruncatedName } from './TruncatedName';

export type ViewMode = 'normal' | 'compact' | 'hidden';

/**
 * A coloured initial.
 *
 * The colour is not new: `generateRandomColor` has stamped one onto every
 * account on every import path since the beginning, storage has carried it, and
 * nothing has ever drawn it. This is that field finally reaching the screen.
 *
 * Deliberately not a favicon. Fetching those means one network request per
 * service, which tells whoever answers it exactly which sites this user holds
 * 2FA for — and the popup's rule is that it makes no network requests at all.
 * An initial says nothing to anyone, needs no permission, costs no bytes, and
 * works for every account rather than only for the recognised ones.
 */
/**
 * Black or white, whichever the background can actually carry.
 *
 * White on everything was the first attempt and it left the pale half of the
 * palette unreadable — amber came in at 2.15:1, which at this size is less a
 * letter than a rumour.
 *
 * The threshold is 0.28 rather than the 0.179 where black's contrast merely
 * overtakes white's, because at 0.179 every colour we ship flips and four of
 * them gain almost nothing for it: indigo goes from 4.47:1 to 4.70:1 and stops
 * looking like itself. 0.28 sits in the gap the palette actually has, between
 * pink at L=0.248 and orange at L=0.325 — the four pale colours get black and
 * 7.5–9.8:1, the four dark ones keep white and the look they had. Arbitrary
 * colours from an imported backup are still measured, not assumed.
 */
function readableInk(background: string): string {
  const hex = background.replace('#', '');
  if (hex.length !== 6) return '#ffffff';
  const channel = (offset: number) => {
    const value = parseInt(hex.slice(offset, offset + 2), 16) / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  };
  const luminance = 0.2126 * channel(0) + 0.7152 * channel(2) + 0.0722 * channel(4);
  return luminance > 0.28 ? '#000000' : '#ffffff';
}

function Avatar({ account, size }: { account: Account; size: number }) {
  const issuer = typeof account.issuer === 'string' ? account.issuer : '';
  const name = typeof account.name === 'string' ? account.name : '';
  const source = (issuer || name || '?').trim();
  // Spread rather than [0]: an emoji or any astral character is a surrogate
  // pair, and indexing one splits it into half a character the font cannot draw.
  const initial = ([...source][0] || '?').toUpperCase();
  const background = account.color || colorForKey(`${issuer}:${name}:${account.id}`);
  return (
    <span
      aria-hidden
      style={{ backgroundColor: background, color: readableInk(background), width: size, height: size }}
      className="flex-shrink-0 grid place-items-center rounded-full font-semibold leading-none"
    >
      <span style={{ fontSize: Math.round(size * 0.5) }}>{initial}</span>
    </span>
  );
}

interface AccountCardProps {
  account: Account;
  onDelete: (id: string) => void;
  onEdit: (account: Account) => void;
  /** Opens the share dialog. Absent on the broken-record row: no code, no link. */
  onShare: (account: Account) => void;
  language: Language;
  viewMode?: ViewMode;
  /** Off by default — see the toggle in Settings and the note beside it. */
  showAvatar?: boolean;
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
  onShare,
  language,
  viewMode = 'normal',
  showAvatar = false,
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
   * The label, and the title every branch hands the browser.
   *
   * Each of the four branches below truncates it, and at the 320px popup it
   * truncates hard enough that two accounts on one service stop being
   * distinguishable — the name is the only thing on the row that can give way.
   * A native title rather than a tooltip of our own: the popup root is
   * overflow-hidden, so an absolutely positioned one would be clipped on
   * exactly the bottom rows where the list is longest.
   */
  const fullName = accountLabel(account);

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
    showGroup && groupName ? <span className={badgeClass(compact)} title={groupName}>{groupName}</span> : null;

  const groupBadge = groupBadgeFor(false);

  const formattedCode = totp ? totp.code.match(/.{1,3}/g)?.join(' ') || totp.code : '';
  const isExpiringSoon = totp ? totp.remaining <= 5 : false;

  const dragProps = {
    draggable,
    onDragStart: (e: React.DragEvent) => onDragStart?.(e, account.id),
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); onDragOver?.(e); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); onDrop?.(e, account.id); },
  };

  const baseClass = `relative group bg-white dark:bg-dark-800 hover:bg-gray-50 dark:hover:bg-dark-700 transition-all duration-200 after:content-[''] after:absolute after:bottom-0 after:h-px after:bg-gray-200 dark:after:bg-dark-600 last:after:hidden ${
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
      <div
        {...dragProps}
        className={`${baseClass} py-3 ${viewMode === 'compact' ? 'px-3 after:inset-x-3' : 'px-4 after:inset-x-4'}`}
      >
        <div className="flex items-center gap-2">
          <div className="min-w-0 flex-1">
            <TruncatedName
              label={fullName}
              className="block truncate text-sm font-medium text-gray-900 dark:text-gray-100"
            />
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
      <div {...dragProps} className={`${baseClass} px-4 py-2.5 after:inset-x-4 overflow-hidden`}>
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
            {showAvatar && <Avatar account={account} size={18} />}
            <TruncatedName
              label={fullName}
              className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
            />
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

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
            <button
              onClick={() => onShare(account)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title={t('share.title')}
            >
              <Share2 size={13} />
            </button>
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
      // px-3 and gap-1.5 rather than px-4 and gap-2, and no drag handle: at the
      // 320px popup the fixed furniture of this row left the name about 78px —
      // ten characters — so two accounts on one service read identically. The
      // padding, the gaps and the handle give back 44px between them without
      // moving anything the row exists to show; the avatar spends 24 of it, so
      // the name's measured gain is 26px — 80px to 106px at this width.
      //
      // The drag goes with the handle. A row that still reorders with no
      // affordance, and jumps 2px mid-drag when isDragOver lands, is worse than
      // a row that does not reorder; that stays a normal-view job.
      <div className={`${baseClass} py-1.5 px-3 after:inset-x-3 overflow-hidden`}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            className="flex-1 min-w-0 flex items-center gap-1.5 text-start group/copy"
          >
            {showAvatar && <Avatar account={account} size={18} />}
            {/* min-w-0: a flex item will not shrink below its content without
                it, so a long name would push the code off the row instead of
                truncating. */}
            <TruncatedName
              label={fullName}
              className="min-w-0 truncate text-sm text-gray-700 dark:text-gray-300"
            />
            {suggestedBadge}
            {groupBadgeFor(true)}
            <span
              dir="ltr"
              className={`ms-auto flex-shrink-0 font-mono text-base tracking-wide transition-colors ${
                isExpiringSoon
                  ? 'text-orange-600 dark:text-orange-400 animate-pulse'
                  : 'text-[#4285F4]'
              }`}
            >
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
          <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
            <button
              onClick={() => onShare(account)}
              className="p-0.5 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title={t('share.title')}
            >
              <Share2 size={12} />
            </button>
            <button
              onClick={() => onEdit(account)}
              className="p-0.5 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="p-0.5 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-400 hover:text-red-500"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={12} />
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
    <div {...dragProps} className={`${baseClass} p-3 px-4 after:inset-x-4`}>
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {showAvatar && <Avatar account={account} size={20} />}
          <TruncatedName
            label={fullName}
            className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
          />
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
            onClick={() => onShare(account)}
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('share.title')}
          >
            <Share2 size={13} />
          </button>
          <button
            onClick={() => onEdit(account)}
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-400 hover:text-gray-600 dark:hover:text-gray-300"
            title={t('edit.title')}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(account.id)}
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-400 hover:text-red-500"
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
          {/* dir="ltr" is load-bearing, not tidiness. The code is drawn in
              groups of three separated by a space, and under RTL the bidi
              algorithm resolves that neutral space to the paragraph direction:
              "123 456" lays out with 456 to the LEFT of 123, so an Arabic user
              reading the screen left to right types 456123 and is refused. Copy
              was never affected — it writes the raw digits — so this only ever
              bit the read-and-type path, which is the one people use when the
              code is going into a phone, a VPN client or an SSH prompt. */}
          <div
            dir="ltr"
            className={`font-mono text-2xl tracking-wide transition-colors ${
              isExpiringSoon
                ? 'text-orange-600 dark:text-orange-400 animate-pulse'
                : 'text-[#4285F4]'
            }`}
          >
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
