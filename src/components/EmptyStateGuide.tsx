import { useState } from 'react';
import { ArrowLeft, Camera, ChevronDown, ChevronRight, FileDown, KeyRound, Smartphone } from 'lucide-react';
import { Logo } from '@/components/Logo';
import { createT, type Language, type TranslationKey } from '@/utils/i18n';

/**
 * First-run guidance.
 *
 * A chooser rather than a wizard: the very first question — where the user's
 * codes are right now — is a branch, not a step, and a linear flow would force
 * four out of five people through instructions meant for someone else. And not
 * a single block of text either, which is what the previous empty state was and
 * why the reviews say people don't know what to do.
 *
 * Pick a starting point, get only the steps for it.
 */

type PathId = 'ga' | 'new' | 'other' | 'key';

interface Path {
  id: PathId;
  icon: typeof Smartphone;
  label: TranslationKey;
  steps: TranslationKey;
  /**
   * What the fold is called. Named for the question it answers rather than
   * "other options", which told the reader nothing about what was inside and
   * left the fallback everyone actually needs — no camera on this computer —
   * behind a line nobody had a reason to open.
   */
  more: TranslationKey;
  /**
   * How many of the steps are the path everyone takes. The rest are the
   * "no camera?", "no export?" branches: real answers, but written for the
   * minority, and with all of them on screen the button that ends the path sat
   * below the fold in a 400px popup. They fold away behind one line instead.
   */
  primary: number;
  /** Which action ends this path. */
  action: 'camera' | 'add' | 'import';
}

const PATHS: Path[] = [
  { id: 'ga', icon: Smartphone, label: 'onboarding.ga.label', steps: 'onboarding.ga.steps', more: 'onboarding.ga.more', primary: 4, action: 'camera' },
  { id: 'new', icon: Camera, label: 'onboarding.new.label', steps: 'onboarding.new.steps', more: 'onboarding.new.more', primary: 3, action: 'add' },
  // 'import', not 'add': since 1.13.0 this branch leads with "paste the list
  // your old app exported", and its steps say a .txt of those links goes
  // through the button below. The button has to be the one that opens a file.
  { id: 'other', icon: KeyRound, label: 'onboarding.other.label', steps: 'onboarding.other.steps', more: 'onboarding.other.more', primary: 2, action: 'import' },
  { id: 'key', icon: FileDown, label: 'onboarding.key.label', steps: 'onboarding.key.steps', more: 'onboarding.key.more', primary: 3, action: 'import' },
];

interface EmptyStateGuideProps {
  language: Language;
  onAddAccount: () => void;
  onImport: () => void;
  onScanWithCamera: () => void;
}

export function EmptyStateGuide({
  language,
  onAddAccount,
  onImport,
  onScanWithCamera,
}: EmptyStateGuideProps) {
  const t = createT(language);
  const [openPath, setOpenPath] = useState<Path | null>(null);
  const [showMore, setShowMore] = useState(false);

  const open = (path: Path | null) => {
    setOpenPath(path);
    setShowMore(false);
  };

  if (!openPath) {
    return (
      <div className="flex flex-col items-center px-5 py-8">
        <Logo size={44} className="mb-3 opacity-40" />
        <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
          {t('onboarding.title')}
        </h2>
        <p className="mt-1 mb-5 text-xs text-gray-500 dark:text-gray-400">
          {t('onboarding.question')}
        </p>

        <div className="w-full space-y-2">
          {PATHS.map(path => (
            <button
              key={path.id}
              onClick={() => open(path)}
              className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-start transition-colors hover:border-[#4285F4] hover:bg-blue-50/50 dark:border-dark-600 dark:bg-dark-800 dark:hover:border-[#4285F4] dark:hover:bg-dark-700"
            >
              <path.icon size={18} className="flex-shrink-0 text-[#4285F4]" />
              <span className="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                {t(path.label)}
              </span>
              <ChevronRight size={16} className="flex-shrink-0 text-gray-400 rtl:rotate-180" />
            </button>
          ))}
        </div>
      </div>
    );
  }

  const runAction = () => {
    if (openPath.action === 'camera') onScanWithCamera();
    else if (openPath.action === 'import') onImport();
    else onAddAccount();
  };

  const actionLabel: TranslationKey =
    openPath.action === 'camera'
      ? 'addAccount.scanWithCamera'
      : openPath.action === 'import'
        ? 'accounts.importFromBackup'
        : 'accounts.addAccount';

  // Steps are one string with newlines, matching how the FAQ answers are
  // written — one translation unit per path keeps them coherent when localised.
  const steps = t(openPath.steps).split('\n').filter(Boolean);
  // Positional, and safe to be: every translation is the same string with the
  // same number of lines, and a short one just leaves the fold empty.
  const cut = Math.min(openPath.primary, steps.length);
  const main = steps.slice(0, cut);
  const extra = steps.slice(cut);

  const step = (text: string, index: number) => (
    <li key={index} className="flex gap-2.5">
      <span className="mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-semibold text-[#4285F4] dark:bg-blue-900/30">
        {index + 1}
      </span>
      <span className="text-xs leading-relaxed text-gray-700 dark:text-gray-300">{text}</span>
    </li>
  );

  return (
    <div className="px-5 pt-4">
      {/* Back and title share a row: at 320x400 every line of chrome above the
          steps is a line of steps pushed under the button. */}
      <div className="mb-3.5 flex items-center gap-2">
        <button
          onClick={() => open(null)}
          aria-label={t('common.back')}
          title={t('common.back')}
          className="-ms-1.5 flex-shrink-0 rounded-lg p-1.5 text-gray-500 transition-colors hover:bg-gray-100 hover:text-gray-900 dark:text-gray-400 dark:hover:bg-dark-700 dark:hover:text-gray-100"
        >
          <ArrowLeft size={16} className="rtl:rotate-180" />
        </button>
        <openPath.icon size={17} className="flex-shrink-0 text-[#4285F4]" />
        <h2 className="text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100">
          {t(openPath.label)}
        </h2>
      </div>

      <ol className="space-y-2.5">{main.map((text, index) => step(text, index))}</ol>

      {extra.length > 0 && (
        <>
          <button
            onClick={() => setShowMore(!showMore)}
            className="mt-3 flex items-center gap-1 text-xs font-medium text-[#4285F4] transition-colors hover:text-[#3367D6]"
          >
            <ChevronDown
              size={14}
              className={`transition-transform ${showMore ? 'rotate-180' : ''}`}
            />
            {t(openPath.more)}
          </button>
          {showMore && (
            <ol className="mt-3 space-y-2.5">
              {extra.map((text, index) => step(text, cut + index))}
            </ol>
          )}
        </>
      )}

      {/* Sticky, not merely last: the fallback steps can be long in any
          language, and the one button that finishes the path may not be
          skipped because it happens to sit past the bottom of a popup. It
          rides the bottom edge whenever the content is taller than the pane,
          and sits under the steps when it isn't. */}
      <div className="sticky bottom-0 -mx-5 mt-4 bg-gray-50 px-5 pb-5 pt-3 before:absolute before:inset-x-0 before:-top-5 before:h-5 before:bg-gradient-to-t before:from-gray-50 before:to-transparent dark:bg-dark-900 dark:before:from-dark-900">
        <button
          onClick={runAction}
          className="w-full rounded-lg bg-[#4285F4] py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#3367D6]"
        >
          {t(actionLabel)}
        </button>
      </div>
    </div>
  );
}
