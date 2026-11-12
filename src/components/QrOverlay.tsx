import { useEffect, useState } from 'react';
import { AlertTriangle } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { drawQR, type QRDrawing } from '@/utils/qr-encode';
import { useEscapeLayer, useReturnFocus } from '@/hooks/useLayer';

export interface QrFrame {
  caption: string;
  /** What the QR code carries. It holds a secret: never log it. */
  text: string;
  note?: string;
}

interface QrOverlayProps {
  frames: QrFrame[];
  language: Language;
  onClose: () => void;
  /** Shown under the code on the last frame of a series. */
  lastHint?: string;
}

const AMBER_BOX =
  'flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200';

const SECONDARY_BUTTON =
  'border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 disabled:opacity-40 disabled:hover:bg-transparent font-medium text-sm py-2 rounded-lg transition-colors';

/**
 * One or more QR codes on a card over whatever opened it, for another app to
 * scan: a single account's otpauth:// code, or a series of migration codes.
 *
 * It sits above the full-screen z-50 views. Escape goes to the topmost layer
 * only, so it closes this card and leaves the screen underneath alone.
 */
export function QrOverlay({ frames, language, onClose, lastHint }: QrOverlayProps) {
  const t = createT(language);
  const [index, setIndex] = useState(0);
  const [qr, setQr] = useState<QRDrawing | null>(null);
  const [failed, setFailed] = useState(false);

  useEscapeLayer(onClose);
  useReturnFocus();

  const frame = frames[index];
  const text = frame?.text;

  useEffect(() => {
    if (text === undefined) return;
    let cancelled = false;
    setQr(null);
    setFailed(false);
    drawQR(text).then(
      (drawing) => {
        if (!cancelled) setQr(drawing);
      },
      () => {
        // Nothing is logged: the error may quote what was being encoded.
        if (!cancelled) setFailed(true);
      }
    );
    return () => {
      cancelled = true;
    };
  }, [text]);

  if (!frame) return null;

  const many = frames.length > 1;
  const last = index === frames.length - 1;

  return (
    <div
      className="fixed inset-0 z-[60] flex items-center justify-center bg-black/40 p-4"
      onClick={onClose}
      data-testid="qr-overlay"
    >
      <div
        className="w-full max-w-sm max-h-full overflow-y-auto space-y-3 rounded-xl bg-white p-4 shadow-xl dark:bg-dark-800"
        role="dialog"
        aria-modal="true"
        aria-label={frame.caption}
        onClick={(e) => e.stopPropagation()}
      >
        <p className="truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={frame.caption}>
          {frame.caption}
        </p>

        {failed ? (
          <p className="text-center text-xs text-red-600 dark:text-red-400">{t('qr.failed')}</p>
        ) : (
          // A white field of its own, in both themes: a QR code on a dark
          // background is inverted, and cameras read that far less reliably.
          // The quiet zone is the padding.
          <div className="mx-auto w-full max-w-[240px] rounded-lg bg-white p-3">
            {qr ? (
              <svg
                viewBox={`0 0 ${qr.size} ${qr.size}`}
                shapeRendering="crispEdges"
                className="block h-auto w-full text-black"
                role="img"
                aria-label={t('qr.scanHint')}
              >
                <path d={qr.path} fill="currentColor" />
              </svg>
            ) : (
              <div className="aspect-square w-full" />
            )}
          </div>
        )}

        {qr && !failed && <p className="text-center text-xs text-gray-500 dark:text-gray-400">{t('qr.scanHint')}</p>}

        {many && last && lastHint && (
          <p className="text-center text-xs leading-relaxed text-gray-600 dark:text-gray-400">{lastHint}</p>
        )}

        {frame.note && (
          <div className={AMBER_BOX}>
            <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
            <span>{frame.note}</span>
          </div>
        )}

        <div className={AMBER_BOX}>
          <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
          <span>{t('qr.permanentWarning')}</span>
        </div>

        {many && (
          <div className="flex items-center gap-2">
            <button
              type="button"
              onClick={() => setIndex(index - 1)}
              disabled={index === 0}
              className={`flex-1 ${SECONDARY_BUTTON}`}
            >
              {t('common.back')}
            </button>
            <span className="text-xs text-gray-500 dark:text-gray-400 whitespace-nowrap">
              {t('qr.position', index + 1, frames.length)}
            </span>
            <button
              type="button"
              onClick={() => setIndex(index + 1)}
              disabled={last}
              className={`flex-1 ${SECONDARY_BUTTON}`}
            >
              {t('qr.next')}
            </button>
          </div>
        )}

        {/* Focus starts here, inside the card, so a key pressed while it is
            open never reaches the screen underneath. */}
        <button
          type="button"
          onClick={onClose}
          autoFocus
          className="w-full bg-accent-600 hover:bg-accent-700 text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
        >
          {t('share.done')}
        </button>
      </div>
    </div>
  );
}
