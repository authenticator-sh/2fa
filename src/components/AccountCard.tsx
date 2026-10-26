import { memo, useEffect, useRef, useState } from 'react';
import { Copy, Check, Trash2, GripVertical, Pencil, Pin, Share2 } from 'lucide-react';
import type { Account } from '@/types';
import { colorForKey } from '@/utils/qr-parser';
import { accountLabel } from '@/utils/account-label';
import { useCheckingTime, useTOTP } from '@/hooks/useTOTP';
import { isSteamAccount, tryGenerateTOTP, whenTimeOffsetSettled } from '@/utils/totp';
import { toast } from '@/utils/ui-feedback';
import { createT, type Language } from '@/utils/i18n';
import { recordAccountUsage } from '@/utils/suggestions';
import { takePickPrompt } from '@/utils/quick-fill';
import { finishPickedFill } from '@/utils/finish-quick-fill';
import { announceFilled } from '@/hooks/useFinishQuickFill';
import { ProgressRing } from './ProgressRing';
import { TruncatedName } from './TruncatedName';
import { reportCodeUsed } from '@/billing/onboarding';

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
  /** Takes the row's id so the parent can pass one stable handler to every row. */
  onDragOver?: (e: React.DragEvent, id: string) => void;
  onDrop?: (e: React.DragEvent, id: string) => void;
  /** The pointer left this row, so its drop marker must go. */
  onDragLeave?: (id: string) => void;
  /** The drag this row started is over — dropped anywhere, or cancelled with Esc. */
  onDragEnd?: () => void;
  isDragOver?: boolean;
  currentDomain?: string | null;
  isSuggested?: boolean;
  /** Off while the list is already filtered to one group — the chip says it. */
  showGroup?: boolean;
  /**
   * Right-click on the row. `copy` is the row's own copy, so the menu's "Copy
   * code" is the same click on the code — quick fill, usage, "Copied" and all.
   */
  onMenu?: (account: Account, x: number, y: number, copy: () => void) => void;
  /** The list is choosing accounts: a click ticks the row instead of copying. */
  selecting?: boolean;
  selected?: boolean;
  onToggleSelect?: (id: string) => void;
}

/**
 * How long "Copied" stays up after a copy. Restarted by a second copy rather
 * than left to the first one's timer, which took the confirmation of the second
 * click down early.
 */
const COPIED_MS = 2000;

/**
 * Memoised so a popup-wide re-render — a search keystroke, a banner appearing —
 * does not redraw every row whose props did not change. Each row keeps its own
 * code up to date from the shared tick; nothing above it needs to.
 *
 * Which only works while every callback the popup passes keeps its identity —
 * see useStableCallback and the drag handlers in App.tsx. One inline arrow is
 * enough to redraw all forty rows on every keystroke.
 */
export const AccountCard = memo(function AccountCard({
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
  onDragLeave,
  onDragEnd,
  isDragOver,
  currentDomain,
  isSuggested,
  showGroup,
  onMenu,
  selecting = false,
  selected = false,
  onToggleSelect,
}: AccountCardProps) {
  const t = createT(language);
  const totp = useTOTP(account);
  const checkingTime = useCheckingTime();
  const [copied, setCopied] = useState(false);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  // A row removed while "Copied" is up — deleted, filtered out — must not have
  // a timer left behind to set state on it.
  useEffect(() => () => {
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
  }, []);

  const handleCopy = async () => {
    if (!totp) return;
    // The code is worked out at the moment of the click, not taken from what
    // the row last drew: that is up to a tick old, and a click just after a
    // slot ends — or just after a clock correction lands — copied the code
    // that had stopped working. And if the clock is being measured again,
    // the copy waits the second it takes rather than guess.
    await whenTimeOffsetSettled();
    const current = tryGenerateTOTP(account);
    if (!current) return;

    // Opened by quick fill to ask which account this site wants? Then the
    // answer goes where the question came from, as well as onto the clipboard
    // — a miss there costs nothing, the code is pasted as it always was.
    // Started before the copy so a clipboard refusal does not also cost the
    // fill.
    finishPickedFill(account, t)
      .then(outcome => {
        if (outcome === 'filled') announceFilled(t);
      })
      .catch(() => {});
    try {
      await navigator.clipboard.writeText(current.code);
    } catch (error) {
      // Rejected when the document is not focused, or by policy. Swallowing it
      // silently left the user unable to tell a failed copy from a misclick —
      // and then paste whatever the clipboard held before.
      console.error('Could not copy the code to the clipboard', error);
      toast('error', t('accounts.copyFailed'));
      return;
    }
    void reportCodeUsed('copy');
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => {
      copiedTimer.current = null;
      setCopied(false);
    }, COPIED_MS);
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
    <span className="flex-shrink-0 text-[10px] font-medium leading-none text-accent-600 dark:text-accent-400 bg-blue-50/70 dark:bg-blue-900/25 border border-blue-200/70 dark:border-blue-800/60 px-1.5 py-[3px] rounded-full">
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

  // The same instant tooltip as the name: the native `title` it had took a
  // second to appear and never did in the desktop app's web view, so a badge
  // cut to "G…" could not be read at all.
  const groupBadgeFor = (compact: boolean) =>
    showGroup && groupName ? <TruncatedName label={groupName} className={badgeClass(compact)} /> : null;

  const groupBadge = groupBadgeFor(false);

  const pinMark = account.pinned ? (
    <span className="flex-shrink-0 text-gray-400 dark:text-gray-500" title={t('menu.pinned')}>
      <Pin size={12} aria-hidden className="rotate-45" />
      <span className="sr-only">{t('menu.pinned')}</span>
    </span>
  ) : null;

  // While choosing, the whole row is one button that ticks it — nothing under
  // it copies, opens or deletes. The mark takes the timer's place: which code
  // is current does not matter while picking.
  const selectOverlay = selecting ? (
    <button
      type="button"
      data-row-action
      role="checkbox"
      aria-checked={selected}
      aria-label={fullName}
      onClick={() => onToggleSelect?.(account.id)}
      className={`absolute inset-0 z-10 rounded-none text-start transition-colors focus:outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-accent-500 ${
        selected ? 'bg-accent-500/10 dark:bg-accent-400/10' : 'hover:bg-gray-500/5'
      }`}
    />
  ) : null;

  const selectMark = (size: number) => (
    <span
      aria-hidden
      style={{ width: size, height: size }}
      className="grid place-items-center"
    >
      <span
        className={`grid h-[22px] w-[22px] place-items-center rounded-full border-2 transition-colors ${
          selected ? 'border-accent-600 bg-accent-600 text-white' : 'border-gray-300 dark:border-dark-500'
        }`}
      >
        {selected && <Check size={14} strokeWidth={3} className="anim-check" />}
      </span>
    </span>
  );

  const ring = (size?: number) =>
    selecting ? selectMark(size ?? 40) : totp ? <ProgressRing remaining={totp.remaining} period={totp.period} size={size} /> : null;

  const rowProps = {
    'data-account-id': account.id,
    onContextMenu: (event: React.MouseEvent) => {
      if (!onMenu || selecting) return;
      event.preventDefault();
      onMenu(account, event.clientX, event.clientY, () => void handleCopy());
    },
    // The menu key and Shift+F10 open it under the focused control. Not left
    // to the browser's own contextmenu event, which a keyboard does not always
    // raise — and where it does, the handler above takes the same state again.
    onKeyDown: (event: React.KeyboardEvent) => {
      if (!onMenu || selecting) return;
      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
      event.preventDefault();
      const rect = (event.target as HTMLElement).getBoundingClientRect();
      onMenu(account, rect.left + 8, rect.bottom, () => void handleCopy());
    },
  };

  const steam = isSteamAccount(account);
  // Steam's five characters are shown the way Steam shows them, unbroken:
  // split 3 + 2 they read as two things to type.
  const formattedCode = totp ? (steam ? totp.code : totp.code.match(/.{1,3}/g)?.join(' ') || totp.code) : '';
  // While a lapsed correction is measured again, the row says so in place of
  // the code — see isTimeOffsetPending. Only the digits give way: the ring,
  // the name and every action stay where they are, so nothing jumps when the
  // code comes back a second later.
  const checkingLabel = (
    <span className="font-sans text-xs tracking-normal text-gray-500 dark:text-gray-400" role="status">
      {t('accounts.checkingTime')}
    </span>
  );
  // A share link carries codes as numbers, and a Steam code is not one.
  const canShare = !steam;
  const isExpiringSoon = totp && !checkingTime ? totp.remaining <= 5 : false;

  const dragProps = {
    draggable,
    onDragStart: (e: React.DragEvent) => onDragStart?.(e, account.id),
    onDragOver: (e: React.DragEvent) => { e.preventDefault(); onDragOver?.(e, account.id); },
    onDrop: (e: React.DragEvent) => { e.preventDefault(); onDrop?.(e, account.id); },
    // Without these two the blue line stayed on the last row the pointer
    // crossed whenever the drag ended anywhere but on a row — outside the
    // list, or cancelled with Esc — and sat there until the next drag.
    //
    // dragleave also fires when the pointer moves onto one of the row's own
    // children, which would flicker the marker off and on; that case is not a
    // leave.
    onDragLeave: (e: React.DragEvent) => {
      const next = e.relatedTarget as Node | null;
      if (next && e.currentTarget.contains(next)) return;
      onDragLeave?.(account.id);
    },
    onDragEnd: () => onDragEnd?.(),
  };

  // Without `group` while choosing, so hovering a row does not bring up its
  // share, edit and delete buttons from under the tick overlay — visible but
  // dead, they looked like the way to act on the selection.
  const baseClass = `relative ${selecting ? '' : 'group'} bg-white dark:bg-dark-800 hover:bg-gray-50 dark:hover:bg-dark-700 transition-all duration-200 after:content-[''] after:absolute after:bottom-0 after:h-px after:bg-gray-200 dark:after:bg-dark-600 last:after:hidden ${
    isDragOver ? 'border-t-2 border-accent-500' : ''
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
        {...rowProps}
        data-testid="account-card"
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
              className="rounded p-1 text-gray-500 hover:bg-gray-100 hover:text-gray-700 dark:text-gray-400 dark:hover:bg-dark-600 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="rounded p-1 text-gray-500 hover:bg-red-50 hover:text-red-600 dark:text-gray-400 dark:hover:bg-red-900/30 dark:hover:text-red-400"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={13} />
            </button>
          </div>
          {selecting && selectMark(26)}
        </div>
        {selectOverlay}
      </div>
    );
  }

  // Hidden mode — just name, click whole row to copy
  if (viewMode === 'hidden') {
    return (
      <div {...dragProps} {...rowProps} data-testid="account-card" className={`${baseClass} px-4 py-2.5 after:inset-x-4 overflow-hidden`}>
        <div className="flex items-center gap-2">
          {draggable && (
            <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 dark:text-gray-400 flex-shrink-0">
              <GripVertical size={14} />
            </div>
          )}

          <button
            onClick={handleCopy}
            data-row-action
            className="flex-1 min-w-0 flex items-center gap-2 text-start group/copy"
          >
            {showAvatar && <Avatar account={account} size={18} />}
            <TruncatedName
              label={fullName}
              className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
            />
            {pinMark}
            {suggestedBadge}
            {groupBadgeFor(true)}
            <span className={`flex-shrink-0 transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
              {copied ? (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={14} className="text-gray-500 dark:text-gray-400" />
              )}
            </span>
            {copied && (
              <span className="flex-shrink-0 text-xs font-medium text-green-600 dark:text-green-400">
                {t('accounts.copied')}
              </span>
            )}
          </button>

          <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
            {canShare && (
              <button
                onClick={() => onShare(account)}
                className="p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                title={t('share.title')}
              >
                <Share2 size={13} />
              </button>
            )}
            <button
              onClick={() => onEdit(account)}
              className="p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={13} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="p-1 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={13} />
            </button>
          </div>

          {/* Same 26px ring as the compact row: at the default 40 the mode that
              hides the codes ended up the tallest of the three. */}
          <div className="flex-shrink-0">
            {ring(26)}
          </div>
        </div>
        {selectOverlay}
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
      <div {...rowProps} data-testid="account-card" className={`${baseClass} py-1.5 px-3 after:inset-x-3 overflow-hidden`}>
        <div className="flex items-center gap-1.5">
          <button
            onClick={handleCopy}
            data-row-action
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
            {pinMark}
            {suggestedBadge}
            {groupBadgeFor(true)}
            <span
              dir="ltr"
              data-testid="account-code"
              className={`ms-auto flex-shrink-0 font-mono text-base tracking-wide transition-colors ${
                isExpiringSoon
                  ? 'text-orange-600 dark:text-orange-400 motion-safe:animate-pulse'
                  : 'text-accent-600 dark:text-accent-400'
              }`}
            >
              {checkingTime ? checkingLabel : formattedCode}
            </span>
            <span className={`flex-shrink-0 transition-opacity ${copied ? 'opacity-100' : 'opacity-0 group-hover/copy:opacity-100'}`}>
              {copied ? (
                <Check size={14} className="text-green-600 dark:text-green-400" />
              ) : (
                <Copy size={14} className="text-gray-500 dark:text-gray-400" />
              )}
            </span>
          </button>

          {/* Always in the flow, only faded: revealing them on hover by taking
              them out of the layout would shove the code sideways under the
              cursor, and the code is what the row exists to show. */}
          <div className="flex items-center opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity flex-shrink-0">
            {canShare && (
              <button
                onClick={() => onShare(account)}
                className="p-0.5 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
                title={t('share.title')}
              >
                <Share2 size={12} />
              </button>
            )}
            <button
              onClick={() => onEdit(account)}
              className="p-0.5 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              title={t('edit.title')}
            >
              <Pencil size={12} />
            </button>
            <button
              onClick={() => onDelete(account.id)}
              className="p-0.5 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
              title={t('accounts.deleteAccount')}
            >
              <Trash2 size={12} />
            </button>
          </div>

          <div className="flex-shrink-0">
            {ring(26)}
          </div>
        </div>
        {selectOverlay}
      </div>
    );
  }

  // Normal mode
  return (
    // data-testid on the row and the code: what the Playwright suite (e2e/)
    // reads. The row has no role of its own to find it by, and the digits are
    // one text node among the name and the badges.
    <div {...dragProps} {...rowProps} data-testid="account-card" className={`${baseClass} p-3 px-4 after:inset-x-4`}>
      <div className="flex items-start justify-between mb-1.5">
        <div className="flex items-center gap-1.5 flex-1 min-w-0">
          {showAvatar && <Avatar account={account} size={20} />}
          <TruncatedName
            label={fullName}
            className="min-w-0 truncate text-sm font-medium text-gray-900 dark:text-gray-100"
          />
          {pinMark}
            {suggestedBadge}
          {groupBadge}
          {draggable && (
            <div className="cursor-grab active:cursor-grabbing opacity-0 group-hover:opacity-100 transition-opacity text-gray-500 dark:text-gray-400 flex-shrink-0">
              <GripVertical size={14} />
            </div>
          )}
        </div>
        <div className="flex items-center gap-0.5">
          {canShare && (
            <button
              onClick={() => onShare(account)}
              className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
              title={t('share.title')}
            >
              <Share2 size={13} />
            </button>
          )}
          <button
            onClick={() => onEdit(account)}
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 hover:bg-gray-100 dark:hover:bg-dark-600 rounded text-gray-500 hover:text-gray-700 dark:text-gray-400 dark:hover:text-gray-300"
            title={t('edit.title')}
          >
            <Pencil size={13} />
          </button>
          <button
            onClick={() => onDelete(account.id)}
            className="opacity-0 group-hover:opacity-100 focus-within:opacity-100 group-focus-within:opacity-100 transition-opacity p-1 hover:bg-red-50 dark:hover:bg-red-900/30 rounded text-gray-500 hover:text-red-600 dark:text-gray-400 dark:hover:text-red-400"
            title={t('accounts.deleteAccount')}
          >
            <Trash2 size={14} />
          </button>
        </div>
      </div>

      <div className="flex items-center justify-between">
        <button
          onClick={handleCopy}
            data-row-action
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
            data-testid="account-code"
            className={`font-mono text-2xl tracking-wide transition-colors ${
              isExpiringSoon
                ? 'text-orange-600 dark:text-orange-400 motion-safe:animate-pulse'
                : 'text-accent-600 dark:text-accent-400'
            }`}
          >
            {checkingTime ? checkingLabel : formattedCode}
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
                <Copy size={16} className="text-gray-500 dark:text-gray-400" />
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
          {ring()}
        </div>
      </div>
      {selectOverlay}
    </div>
  );
});
