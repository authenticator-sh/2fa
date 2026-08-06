import { useEffect, useRef, useState } from 'react';
import { AlertTriangle, CheckCircle2, Info } from 'lucide-react';
import { dismissToast, subscribe, type DialogRequest, type Toast } from '@/utils/ui-feedback';

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
    <button
      type="button"
      onClick={() => dismissToast(toast.id)}
      role="status"
      title=""
      className="pointer-events-auto mx-auto flex max-w-[92%] items-center gap-2 rounded-full bg-gray-900/95 py-2 ps-3 pe-3.5 text-start shadow-lg ring-1 ring-white/10 backdrop-blur-sm transition hover:bg-gray-900 dark:bg-dark-600/95 dark:hover:bg-dark-600 motion-safe:animate-[toastIn_180ms_ease-out]"
    >
      <tone.icon size={15} className={`flex-shrink-0 ${tone.iconClass}`} />
      <span className="text-xs font-medium leading-snug text-white">{toast.message}</span>
    </button>
  );
}

function Dialog({ request }: { request: DialogRequest }) {
  const [value, setValue] = useState('');
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        request.kind === 'prompt' ? request.resolve(null) : request.resolve(false);
      }
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [request]);

  const cancel = () => (request.kind === 'prompt' ? request.resolve(null) : request.resolve(false));
  const accept = () => (request.kind === 'prompt' ? request.resolve(value) : request.resolve(true));

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 backdrop-blur-sm p-4">
      <div className="w-full max-w-sm rounded-lg border border-gray-200 bg-white p-5 shadow-xl dark:border-dark-600 dark:bg-dark-800">
        <h2 className="text-base font-semibold text-gray-900 dark:text-gray-100">{request.title}</h2>
        {request.body && (
          <p className="mt-1.5 whitespace-pre-line text-xs text-gray-600 dark:text-gray-400">{request.body}</p>
        )}

        {request.kind === 'prompt' && (
          <input
            ref={inputRef}
            type={request.password ? 'password' : 'text'}
            value={value}
            placeholder={request.placeholder}
            onChange={event => setValue(event.target.value)}
            onKeyDown={event => event.key === 'Enter' && accept()}
            className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-900 focus:outline-none focus:ring-2 focus:ring-[#4285F4] dark:border-dark-500 dark:bg-dark-700 dark:text-gray-100"
          />
        )}

        <div className="mt-4 flex gap-2">
          <button
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
                : 'bg-[#4285F4] hover:bg-[#3367D6]'
            }`}
          >
            {request.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  );
}

/** Mount once per page. Renders toasts and whichever dialog is pending. */
export function FeedbackHost() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const [dialog, setDialog] = useState<DialogRequest | null>(null);

  useEffect(
    () =>
      subscribe(state => {
        setToasts(state.toasts);
        setDialog(state.dialog);
      }),
    []
  );

  return (
    <>
      {toasts.length > 0 && (
        <div className="pointer-events-none fixed inset-x-0 bottom-4 z-[70] flex flex-col items-center gap-1.5 px-3">
          {toasts.map(toast => (
            <ToastRow key={toast.id} toast={toast} />
          ))}
        </div>
      )}
      {/* Keyed by request id so a new prompt starts with an empty input. */}
      {dialog && <Dialog key={dialog.id} request={dialog} />}
    </>
  );
}
