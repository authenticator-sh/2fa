import { useEffect, useRef, useState } from 'react';
import { ChevronDown, type LucideIcon } from 'lucide-react';

/** One answer to "Where is your QR code?", as a row. */
export const QR_ANSWER_ROW =
  'w-full flex items-center gap-2 py-2 px-3 rounded-lg border border-gray-300 dark:border-dark-500 bg-white dark:bg-dark-700 hover:bg-gray-50 dark:hover:bg-dark-600 text-gray-700 dark:text-gray-200 font-medium text-sm text-start transition-colors';

interface QrAnswerFoldProps {
  icon: LucideIcon;
  label: string;
  how: string;
  /** Reported the first time it opens: which answers people give is the point. */
  onOpen: () => void;
}

/**
 * An answer nothing here can act on: the code is on a page this window cannot
 * go to, or does not exist yet. What to do unfolds under it.
 */
export function QrAnswerFold({ icon: Icon, label, how, onOpen }: QrAnswerFoldProps) {
  const [open, setOpen] = useState(false);
  const howRef = useRef<HTMLParagraphElement>(null);

  useEffect(() => {
    if (open) howRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
  }, [open]);

  return (
    <div>
      <button
        type="button"
        aria-expanded={open}
        onClick={() => {
          if (!open) onOpen();
          setOpen(!open);
        }}
        className={QR_ANSWER_ROW}
      >
        <Icon size={16} className="shrink-0" />
        <span className="min-w-0 flex-1">{label}</span>
        <ChevronDown size={14} className={`shrink-0 transition-transform ${open ? 'rotate-180' : ''}`} />
      </button>
      {open && (
        <p ref={howRef} className="mt-1.5 px-1 text-start text-xs leading-relaxed text-gray-600 dark:text-gray-300">
          {how}
        </p>
      )}
    </div>
  );
}
