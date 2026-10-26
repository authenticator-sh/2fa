import { useEffect, useId, useRef, useState } from 'react';
import { useEscapeLayer } from '@/hooks/useLayer';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import {
  dismissToast,
  pauseToasts,
  resumeToasts,
  subscribe,
  type DialogRequest,
  type Toast,
} from '@/utils/ui-feedback';

// A neutral dark pill with a coloured icon, rather than a full-width slab of
// saturated colour: in a 400px popup a solid green bar reads as an error state
// from a different app. Colour carries the meaning, the surface stays quiet.
const TONE = {
  success: { icon: CheckCircle2, iconClass: 'text-green-400' },
  error: { icon: AlertTriangle, iconClass: 'text-red-400' },
  info: { icon: Info, iconClass: 'text-blue-300' },
} as const;

function ToastRow({ toast }: { toast: Toast }) {
  const tone = TONE[toast.kind];
  return (
    // Hovering or focusing a toast stops every toast's clock: one that leaves
    // while the pointer is on its Undo, or while a keyboard user is tabbing
    // to it, takes the undo with it.
    <div
      onMouseEnter={pauseToasts}
      onMouseLeave={resumeToasts}
      onFocus={pauseToasts}
      onBlur={resumeToasts}
      className="pointer-events-auto mx-auto flex max-w-[92%] items-center rounded-full bg-gray-900/95 shadow-lg ring-1 ring-white/10 backdrop-blur-sm dark:bg-dark-600/95 motion-safe:animate-[toastIn_180ms_ease-out]"
    >
      <button
        type="button"
        onClick={() => dismissToast(toast.id)}
        title=""
        className={`flex min-w-0 items-center gap-2 rounded-full py-2 ps-3 text-start transition hover:bg-gray-900 dark:hover:bg-dark-600 ${toast.action ? 'pe-2' : 'pe-3.5'}`}
      >
        <tone.icon size={15} aria-hidden className={`flex-shrink-0 ${tone.iconClass}`} />
        <span className="text-xs font-medium leading-snug text-white">{toast.message}</span>
        {toast.count && toast.count > 1 && (
          <span className="flex-shrink-0 rounded-full bg-white/15 px-1.5 text-[10px] font-semibold leading-4 text-white">
            ×{toast.count}
          </span>
        )}
      </button>
      {toast.action && (
        <button
          type="button"
          onClick={() => {
            dismissToast(toast.id);
            toast.action!.run();
          }}
          // blue-300 on the near-black pill: 9.9:1, and the brand blue itself
          // would be 3.9:1 there.
          className="me-1.5 flex-shrink-0 rounded-full px-2.5 py-1 text-xs font-semibold text-blue-300 transition-colors hover:bg-white/10 hover:text-blue-200 focus-visible:outline focus-visible:outline-2 focus-visible:outline-blue-300"
        >
          {toast.action.label}
        </button>
      )}
    </div>
  );
}

/** Everything in the dialog Tab can reach, in order. */
const FOCUSABLE =
  'button:not([disabled]), input:not([disabled]), textarea:not([disabled]), select:not([disabled]), a[href], [tabindex]:not([tabindex="-1"])';

function Dialog({ request }: { request: DialogRequest }) {
  const [value, setValue] = useState(request.kind === 'prompt' ? request.defaultValue ?? '' : '');
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement>(null);
  const cancelRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const ids = useId();
  const titleId = `${ids}-title`;
  const bodyId = `${ids}-body`;
  const warningId = `${ids}-warning`;
  const noteId = `${ids}-note`;

  const cancel = () => (request.kind === 'prompt' ? request.resolve(null) : request.resolve(false));
  const accept = () => (request.kind === 'prompt' ? request.resolve(value) : request.resolve(true));

  // A prompt starts in its field. A confirmation starts on Cancel: most of them
  // guard something that cannot be taken back — deleting an account, turning
  // protection off — and an Enter pressed out of habit must land on "no".
  useEffect(() => {
    (request.kind === 'prompt' ? inputRef.current : cancelRef.current)?.focus();
    // Selected, so typing replaces a prefilled name and an arrow key keeps it.
    if (request.kind === 'prompt' && request.defaultValue) inputRef.current?.select();
  }, [request.kind]);

  // The topmost layer, so Escape answers this and leaves the screen under it
  // alone — the export window, Add account, Edit.
  useEscapeLayer(cancel);

  // Tab and Shift+Tab go round the dialog rather than out of it: the page under
  // it is `inert` in the popup, but not every page that shows one is, and focus
  // that leaves an aria-modal dialog leaves the user nowhere they can see.
  const trapTab = (event: React.KeyboardEvent) => {
    if (event.key !== 'Tab' || !panelRef.current) return;
    const focusable = [...panelRef.current.querySelectorAll<HTMLElement>(FOCUSABLE)];
    if (focusable.length === 0) return;
    const first = focusable[0];
    const last = focusable[focusable.length - 1];
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault();
      first.focus();
    }
  };

  const describedBy = [
    request.body ? bodyId : null,
    request.kind === 'confirm' && request.warning ? warningId : null,
    request.kind === 'confirm' && request.note ? noteId : null,
  ]
    .filter(Boolean)
    .join(' ');

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4 anim-backdrop">
      {/* alertdialog for a confirmation: it interrupts to ask about something
          consequential, and a screen reader reads its whole text on opening
          rather than just the focused button. */}
      <div
        ref={panelRef}
        role={request.kind === 'confirm' ? 'alertdialog' : 'dialog'}
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={describedBy || undefined}
        onKeyDown={trapTab}
        className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-dark-600 dark:bg-dark-800 anim-pop"
      >
        <h2 id={titleId} className="text-base font-semibold text-gray-900 dark:text-gray-100">{request.title}</h2>
        {request.body && (
          <p id={bodyId} className="mt-1.5 whitespace-pre-line text-xs text-gray-600 dark:text-gray-400">{request.body}</p>
        )}

        {request.kind === 'confirm' && request.warning && (
          <div className="mt-3 flex gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 dark:border-amber-900/60 dark:bg-amber-900/20">
            <AlertTriangle
              size={14}
              aria-hidden
              className="mt-px flex-shrink-0 text-amber-600 dark:text-amber-500"
            />
            <p id={warningId} className="text-xs leading-relaxed text-amber-900 dark:text-amber-200">
              {request.warning}
            </p>
          </div>
        )}

        {request.kind === 'confirm' && request.note && (
          <p id={noteId} className="mt-2.5 text-[11px] text-gray-500 dark:text-gray-400">{request.note}</p>
        )}

        {request.kind === 'prompt' &&
          (request.multiline ? (
            // No Enter-to-accept here: Enter is how the user separates one link
            // from the next, and in a list of a hundred it is pressed by
            // accident long before the paste is finished.
            <textarea
              ref={inputRef as React.RefObject<HTMLTextAreaElement>}
              value={value}
              rows={5}
              // What goes in here is otpauth:// URIs, which are LTR whatever the
              // interface language is. Left to inherit dir=rtl in Arabic, the
              // "//", the ":" and the "?a=b&c=d" run reorder on screen and the
              // caret starts on the wrong side of a link the user is checking.
              dir="ltr"
              spellCheck={false}
              autoComplete="off"
              autoCapitalize="off"
              autoCorrect="off"
              placeholder={request.placeholder}
              onChange={event => setValue(event.target.value)}
              className="mt-3 w-full resize-none rounded-lg border border-gray-300 bg-white px-3 py-2 font-mono text-[11px] leading-relaxed text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:border-dark-500 dark:bg-dark-700 dark:text-gray-100"
            />
          ) : (
            <input
              ref={inputRef as React.RefObject<HTMLInputElement>}
              type={request.password ? 'password' : 'text'}
              value={value}
              placeholder={request.placeholder}
              onChange={event => setValue(event.target.value)}
              onKeyDown={event => event.key === 'Enter' && accept()}
              className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-accent-500 dark:border-dark-500 dark:bg-dark-700 dark:text-gray-100"
            />
          ))}

        <div className="mt-4 flex gap-2">
          <button
            ref={cancelRef}
            onClick={cancel}
            className="flex-1 rounded-lg border border-gray-300 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-dark-500 dark:text-gray-300 dark:hover:bg-dark-700"
          >
            {request.cancelLabel}
          </button>
          <button
            onClick={accept}
            disabled={request.kind === 'prompt' && !value}
            className={`flex-1 rounded-lg py-2.5 text-sm font-medium text-white transition-colors disabled:opacity-50 ${
              request.kind === 'confirm' && request.danger
                ? 'bg-red-600 hover:bg-red-700'
                : 'bg-accent-600 hover:bg-accent-700'
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/**
 * Put focus back where it was before a dialog opened.
 *
 * Only once the slot is empty: a dialog replaced by another hands its opener
 * on (see openDialog) rather than returning focus underneath the new one.
 */
function restoreFocus(opener: Element | null | undefined): void {
  if (!(opener instanceof HTMLElement) || opener === document.body) return;
  const restore = () => {
    if (opener.isConnected && !opener.closest('[inert]')) opener.focus();
  };
  // The popup lifts `inert` from the page in the same update that closes the
  // dialog; if this runs first, it waits for that.
  if (opener.closest('[inert]')) setTimeout(restore, 0);
  else restore();
}

/** Mount once per page. Renders toasts and whichever dialog is pending. */
export function FeedbackHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);
  const shownDialog = useRef<DialogRequest | null>(null);

  useEffect(
    () =>
      subscribe(state => {
        setToasts(state.toasts);
        setDialog(state.dialog);
      }),
    []
  );

  useEffect(() => {
    const previous = shownDialog.current;
    shownDialog.current = dialog;
    if (previous && !dialog) restoreFocus(previous.opener);
  }, [dialog]);

  // Errors interrupt; everything else waits for a pause in speech.
  const urgent = toasts.filter(toast => toast.kind === 'error');
  const polite = toasts.filter(toast => toast.kind !== 'error');

  return (
    <>
      {/* Both regions are always in the page, empty or not. A live region
          created together with its first message is one a screen reader has
          not started watching yet, and the first toast after opening the
          popup — often the only one — went unannounced. */}
      {/* Not display:contents, which drops an element from the accessibility
          tree in older Chrome — and a region that is not in the tree is not
          watched either. */}
      {/* Above the "+" button (bottom-4, 3.5rem tall) rather than over it: a
          toast with an action ends at the same corner, and a click meant for
          "+" pressed the toast's button instead — for the held add, "Don't
          add", which throws away the account kept through Checkout. */}
      <div className="pointer-events-none fixed inset-x-0 bottom-[5.25rem] z-[70] flex flex-col px-3">
        <div role="alert" aria-live="assertive" className="flex w-full flex-col items-center gap-1.5">
          {urgent.map(toast => (
            <ToastRow key={toast.id} toast={toast} />
          ))}
        </div>
        <div
          role="status"
          aria-live="polite"
          className={`flex w-full flex-col items-center gap-1.5 ${urgent.length > 0 && polite.length > 0 ? 'mt-1.5' : ''}`}
        >
          {polite.map(toast => (
            <ToastRow key={toast.id} toast={toast} />
          ))}
        </div>
      </div>
      {/* Keyed by request id so a new prompt starts from its own defaultValue. */}
      {dialog && <Dialog key={dialog.id} request={dialog} />}
    </>
  );
}
