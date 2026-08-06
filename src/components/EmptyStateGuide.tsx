import { useState } from 'react';
import { ArrowLeft, Camera, ChevronRight, FileDown, KeyRound, Smartphone } from 'lucide-react';
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
  /** Which action ends this path. */
  action: 'camera' | 'add' | 'import';
}

const PATHS: Path[] = [
  { id: 'ga', icon: Smartphone, label: 'onboarding.ga.label', steps: 'onboarding.ga.steps', action: 'camera' },
  { id: 'new', icon: Camera, label: 'onboarding.new.label', steps: 'onboarding.new.steps', action: 'add' },
  { id: 'other', icon: KeyRound, label: 'onboarding.other.label', steps: 'onboarding.other.steps', action: 'add' },
  { id: 'key', icon: FileDown, label: 'onboarding.key.label', steps: 'onboarding.key.steps', action: 'import' },
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
              onClick={() => setOpenPath(path)}
              className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white px-3.5 py-3 text-start transition-colors hover:border-[#4285F4] hover:bg-blue-50/50 dark:border-dark-600 dark:bg-dark-800 dark:hover:border-[#4285F4] dark:hover:bg-dark-700"
            >
              <path.icon size={18} className="flex-shrink-0 text-[#4285F4]" />
              <span className="flex-1 text-sm font-medium text-gray-900 dark:text-gray-100">
                {t(path.label)}
              </span>
              <ChevronRight size={16} className="flex-shrink-0 text-gray-400" />
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

  return (
    <div className="px-5 py-6">
      <button
        onClick={() => setOpenPath(null)}
        className="mb-4 flex items-center gap-1.5 text-xs font-medium text-gray-500 transition-colors hover:text-gray-900 dark:text-gray-400 dark:hover:text-gray-100"
      >
        <ArrowLeft size={14} />
        {t('onboarding.back')}
      </button>

      <div className="mb-4 flex items-start gap-2.5">
        <openPath.icon size={19} className="mt-0.5 flex-shrink-0 text-[#4285F4]" />
        <h2 className="text-sm font-semibold leading-snug text-gray-900 dark:text-gray-100">
          {t(openPath.label)}
        </h2>
      </div>

      <ol className="mb-5 space-y-2.5">
        {steps.map((step, index) => (
          <li key={index} className="flex gap-2.5">
            <span className="mt-px flex h-5 w-5 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-[11px] font-semibold text-[#4285F4] dark:bg-blue-900/30">
              {index + 1}
            </span>
            <span className="text-xs leading-relaxed text-gray-700 dark:text-gray-300">{step}</span>
          </li>
        ))}
      </ol>

      <button
        onClick={runAction}
        className="w-full rounded-lg bg-[#4285F4] py-2.5 text-sm font-medium text-white transition-colors hover:bg-[#3367D6]"
      >
        {t(actionLabel)}
      </button>
    </div>
  );
}
