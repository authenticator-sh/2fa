import { useEffect, useRef } from 'react';
import { ArrowLeft } from 'lucide-react';

/**
 * The bar every full-screen flow opens with.
 *
 * Deliberately the same shape as the app's own header — same padding, same
 * type, arrow where the logo sits — because in a 400px popup Add account is
 * not a window floating over the app, it *is* the screen, and it should read
 * like Settings does: you are somewhere else, and this is the way back.
 *
 * It also carries the two behaviours every one of these screens has to have
 * and two of the three had forgotten: Escape leaves, and focus starts inside
 * rather than on the button underneath that opened it. Keeping them here is
 * what stops the next screen forgetting them again.
 */
interface ModalHeaderProps {
  title: string;
  /** Accessible name for the arrow — the same word Settings uses. */
  back: string;
  onBack: () => void;
}

export function ModalHeader({ title, back, onBack }: ModalHeaderProps) {
  const backRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    // In the popup, Escape would otherwise close the whole window and take a
    // half-typed form with it; in the floating window and the side panel there
    // was no keyboard way out of these screens at all.
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onBack();
    };
    document.addEventListener('keydown', onKey);
    return () => document.removeEventListener('keydown', onKey);
  }, [onBack]);

  useEffect(() => {
    // Focus lands on the way out, not on a field: these screens open over a
    // list, and starting on an input would make the first keystroke of someone
    // who opened the wrong screen edit something.
    backRef.current?.focus();
  }, []);

  return (
    <div className="flex flex-shrink-0 items-center gap-2 border-b border-gray-200 bg-white p-4 dark:border-dark-700 dark:bg-dark-900">
      <button
        ref={backRef}
        onClick={onBack}
        aria-label={back}
        title={back}
        className="-ms-1 -me-1 flex-shrink-0 rounded-lg p-1 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-dark-700 dark:hover:text-gray-100"
      >
        <ArrowLeft size={20} className="rtl:rotate-180" />
      </button>
      <h1 className="truncate text-lg font-semibold text-gray-900 dark:text-gray-100">{title}</h1>
    </div>
  );
}
