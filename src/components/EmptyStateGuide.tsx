import { useEffect, useRef, useState } from 'react';
import { ArrowLeftRight, Camera, ChevronDown, ChevronRight, HelpCircle, FileDown, ImagePlus, KeyRound, Link2, Monitor, QrCode, Smartphone } from 'lucide-react';
import { createT, type Language, type TranslationKey } from '@/utils/i18n';
import { reportAddStep, reportOnboardPick } from '@/billing/onboarding';

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

type PathId = 'ga' | 'new' | 'other' | 'manual' | 'key' | 'asked';

/**
 * The tile behind a row's icon. One colour per row, so the five read as five
 * different answers rather than as a list to be read top to bottom; spelled out
 * in full because Tailwind only ships the classes it finds written down.
 */
const TONES = {
  blue: 'bg-blue-100 text-accent-600 dark:bg-blue-900/30 dark:text-accent-400',
  green: 'bg-green-100 text-green-700 dark:bg-green-900/30 dark:text-green-400',
  teal: 'bg-teal-100 text-teal-700 dark:bg-teal-900/30 dark:text-teal-400',
  violet: 'bg-violet-100 text-violet-700 dark:bg-violet-900/30 dark:text-violet-400',
  amber: 'bg-amber-100 text-amber-700 dark:bg-amber-900/30 dark:text-amber-400',
};

/** A row of the chooser. */
interface GuideRow {
  id: PathId;
  icon: typeof Smartphone;
  tone: keyof typeof TONES;
  /** Where the codes are — the answer to the question above the rows. */
  label: TranslationKey;
  /**
   * What picking the row will have the reader do, in one line under it. The
   * label says whose case this is; on its own it left people guessing what
   * came next, and guessing between two rows that both end in a QR code.
   * Absent on the branch opened from the link under the rows, which has no row.
   */
  sub?: TranslationKey;
  /**
   * Which action ends this path. 'screen' scans the tab behind the popup at
   * once: it used to open the add dialog, where the same scan was one tab and
   * one more button away, and half of those who got there went elsewhere.
   */
  action: 'camera' | 'screen' | 'manual' | 'import';
}

/** A row that opens steps. One without goes straight to its action. */
export interface GuidePath extends GuideRow {
  steps: TranslationKey;
  /**
   * What the fold is called. Named for the question it answers rather than
   * "other options", which told the reader nothing about what was inside and
   * left the fallback everyone actually needs — no camera on this computer —
   * behind a line nobody had a reason to open. Absent on a branch short enough
   * to show whole.
   */
  more?: TranslationKey;
  /**
   * How many of the steps are the path everyone takes. The rest are the
   * "no camera?", "no export?" branches: real answers, but written for the
   * minority, and with all of them on screen the button that ends the path sat
   * below the fold in a 400px popup. They fold away behind one line instead.
   */
  primary: number;
  /**
   * The branch also ends in the paste box. A list of otpauth:// links comes as
   * a file or as text on the clipboard, and the same person cannot tell in
   * advance which button their list needs — so the branch offers both rather
   * than sending the second half to Settings → Paste links, a screen away from
   * a guide that exists so nobody has to go looking.
   */
  paste?: boolean;
  /**
   * The branch offers the key form beside its scan. A site that shows no QR
   * code shows a key instead, and the steps saying so are folded away.
   */
  keyInstead?: boolean;
}

/**
 * In the order people pick them. On 1.15.0 (10–17 Oct 2026, ~7,000 first
 * picks) "turning 2FA on right now" was the first choice of 40 % even from
 * second place, the phone 33 %, a key 19 %, a file 4 %, another app 3 %. The
 * phone row led before, and it is where people stranded most: a third of
 * those who opened it went on to pick another row, many with no QR on a phone
 * at all — just a site asking for a code they had never set up.
 */
const PATHS: Array<GuideRow | GuidePath> = [
  // A QR code, not a camera: the code this branch is about is on the screen
  // the popup was opened over, and nothing in the branch needs a camera.
  { id: 'new', icon: QrCode, tone: 'green', label: 'onboarding.new.label', sub: 'onboarding.new.sub', steps: 'onboarding.new.steps', more: 'onboarding.new.more', primary: 3, action: 'screen', keyInstead: true },
  { id: 'ga', icon: Smartphone, tone: 'blue', label: 'onboarding.ga.label', sub: 'onboarding.ga.sub', steps: 'onboarding.ga.steps', more: 'onboarding.ga.more', primary: 4, action: 'camera' },
  // No steps: the form is the whole instruction, and it carries its own "where
  // to find your secret key". This used to be the third step of the backup
  // branch, and uninstall answers said manual entry could not be found.
  { id: 'manual', icon: KeyRound, tone: 'violet', label: 'onboarding.manual.label', sub: 'onboarding.manual.sub', action: 'manual' },
  { id: 'key', icon: FileDown, tone: 'amber', label: 'onboarding.key.label', sub: 'onboarding.key.sub', steps: 'onboarding.key.steps', more: 'onboarding.key.more', primary: 4, action: 'import', paste: true },
  // 'import', not 'add': since 1.13.0 this branch leads with "paste the list
  // your old app exported", and its steps say a .txt of those links goes
  // through the button below. The button has to be the one that opens a file.
  { id: 'other', icon: ArrowLeftRight, tone: 'teal', label: 'onboarding.other.label', sub: 'onboarding.other.sub', steps: 'onboarding.other.steps', more: 'onboarding.other.more', primary: 2, action: 'import' },
];

/**
 * "A site asks for a code, but I don't have one" — the link under the rows.
 * Not a sixth row: it answers no "where are your codes", it is the person
 * whose codes are nowhere, sent here by a login screen (support mail, 2026-10:
 * "I get asked for an authenticator code… there is no QR code to point to").
 * Without it they tried the phone row and the turning-on row in turn.
 */
const ASKED: GuidePath = { id: 'asked', icon: HelpCircle, tone: 'blue', label: 'onboarding.asked.label', steps: 'onboarding.asked.steps', primary: 3, action: 'screen' };

function hasSteps(row: GuideRow | GuidePath): row is GuidePath {
  return 'steps' in row;
}

interface EmptyStateGuideProps {
  language: Language;
  /**
   * The branch whose steps are on screen. Held by the app rather than here
   * because the app's header names it and carries the way back, the same as it
   * does for Settings: a second, smaller back row inside the pane was one more
   * line of chrome above the steps, and one more place to look for the exit.
   */
  openPath: GuidePath | null;
  onOpenPath: (path: GuidePath) => void;
  /** Leaves the open branch, as the arrow in the app's header does. */
  onBack: () => void;
  /** The add dialog, scanning the tab behind the popup as it opens. */
  onScanScreen: () => void;
  /**
   * False in a popup the welcome page opened: Chrome lets the extension capture
   * a tab only after a click on its icon, and the tab behind is the welcome
   * page anyway — so the page scan is not offered there.
   */
  canScanPage?: boolean;
  /** The add form, already on the tab where a key is typed. */
  onEnterKey: () => void;
  onImport: () => void;
  onPasteLinks: () => void;
  onScanWithCamera: () => void;
  /** The scanner page with no camera asked for: a picture of the code is the way in. */
  onScanWithImage: () => void;
}

export function EmptyStateGuide({
  language,
  openPath,
  onOpenPath,
  onBack,
  onScanScreen,
  canScanPage = true,
  onEnterKey,
  onImport,
  onPasteLinks,
  onScanWithCamera,
  onScanWithImage,
}: EmptyStateGuideProps) {
  const t = createT(language);
  const rows = useRef<Partial<Record<PathId, HTMLButtonElement | null>>>({});
  const cameFrom = useRef<PathId | null>(null);

  // Back lands on the row that was opened, not on <body>: the row is gone
  // while its steps are up, so there is nothing for the browser to return to.
  useEffect(() => {
    if (openPath) {
      cameFrom.current = openPath.id;
      return;
    }
    if (cameFrom.current) rows.current[cameFrom.current]?.focus();
    cameFrom.current = null;
  }, [openPath]);

  const run = (action: GuideRow['action']) => {
    if (action === 'camera') onScanWithCamera();
    else if (action === 'import') onImport();
    else if (action === 'manual') onEnterKey();
    else onScanScreen();
  };

  if (!openPath) {
    return (
      // No logo above the title any more. It cost 56px, and with a line under
      // every row that was the difference between five rows on screen and four
      // in the 400px popup. Without it all five fit there unscrolled in each
      // of the twenty languages (measured). The header carries the logo anyway.
      // With the page scan over the question and the link under the rows they
      // still do, the link included, at rows of py-1.5 and the tighter gaps
      // here (measured 2026-10-17; in six languages the link meets the footer
      // with nothing to spare). The 320px popup scrolls, as it partly did.
      <div className="flex flex-col items-center px-5 pt-3 pb-2">
        <h2 className="text-base font-medium text-gray-900 dark:text-gray-100">
          {t('onboarding.title')}
        </h2>

        {/* Above the question, because it needs no answer to it: the popup is
            open over a page, and the commonest first visit is somebody turning
            2FA on with the QR code on that very page. A button, not a scan of
            its own on opening — the tab is captured only when the person asks
            (how-it-works, activeTab). */}
        {canScanPage && (
          <button
            onClick={() => {
              void reportOnboardPick('page');
              onScanScreen();
            }}
            className="mt-2.5 flex w-full items-center justify-center gap-2 rounded-xl bg-accent-600 px-3 py-2 text-sm font-medium text-white transition-colors hover:bg-accent-700"
          >
            <Monitor size={16} className="shrink-0" />
            {t('onboarding.page.scan')}
          </button>
        )}

        <p className="mt-3 mb-2 text-xs text-gray-500 dark:text-gray-400">
          {t('onboarding.question')}
        </p>

        <div className="w-full space-y-1.5">
          {PATHS.map(path => (
            <button
              key={path.id}
              ref={node => {
                rows.current[path.id] = node;
              }}
              onClick={() => {
                void reportOnboardPick(path.id);
                if (hasSteps(path)) onOpenPath(path);
                else run(path.action);
              }}
              // All five alike until one is hovered. The first used to be
              // tinted from the start, which singled out Google Authenticator
              // before the reader had answered the question above the rows.
              className="flex w-full items-center gap-3 rounded-xl border border-gray-200 bg-white px-3 py-1.5 text-start transition-colors hover:border-accent-500 hover:bg-blue-50/50 dark:border-dark-600 dark:bg-dark-800 dark:hover:border-accent-500 dark:hover:bg-dark-700"
            >
              <span className={`flex h-9 w-9 flex-shrink-0 items-center justify-center rounded-lg ${TONES[path.tone]}`}>
                <path.icon size={18} />
              </span>
              <span className="min-w-0 flex-1">
                <span className="block text-sm font-medium text-gray-900 dark:text-gray-100">
                  {t(path.label)}
                </span>
                {/* Not at the 320px popup: there the line wraps under a
                    label that already has, and the rows end up four and five
                    lines tall each. */}
                {path.sub && (
                  <span className="mt-0.5 block text-xs text-gray-500 dark:text-gray-400 max-[359px]:hidden">
                    {t(path.sub)}
                  </span>
                )}
              </span>
              <ChevronRight size={16} className="flex-shrink-0 text-gray-500 dark:text-gray-400 rtl:rotate-180" />
            </button>
          ))}
        </div>

        <button
          ref={node => {
            rows.current.asked = node;
          }}
          onClick={() => {
            void reportOnboardPick('asked');
            onOpenPath(ASKED);
          }}
          className="mt-2.5 flex items-center gap-1.5 text-start text-xs font-medium text-accent-600 transition-colors hover:text-accent-700 dark:text-accent-400 dark:hover:text-accent-300"
        >
          <HelpCircle size={14} className="shrink-0" />
          {t('onboarding.asked.label')}
        </button>
      </div>
    );
  }

  // Keyed, so the fold is closed again on every branch that is opened.
  return (
    <GuideSteps
      key={openPath.id}
      path={openPath}
      language={language}
      onAction={() => {
        void reportAddStep('guide', `${openPath.id}_go`);
        run(openPath.action);
      }}
      onPasteLinks={() => {
        void reportAddStep('guide', `${openPath.id}_paste`);
        onPasteLinks();
      }}
      onEnterKey={() => {
        void reportAddStep('guide', `${openPath.id}_key`);
        onEnterKey();
      }}
      // Offered up front, before the camera is tried: the browser says nothing
      // reliable about whether there is one until it has been asked (the list
      // of devices is one blank entry with and without a camera), so the way
      // for a computer without one is a button, not a guess.
      onImage={
        openPath.action === 'camera'
          ? () => {
              void reportAddStep('guide', `${openPath.id}_image`);
              onScanWithImage();
            }
          : undefined
      }
      onBack={onBack}
    />
  );
}

interface GuideStepsProps {
  path: GuidePath;
  language: Language;
  onAction: () => void;
  onPasteLinks: () => void;
  onEnterKey: () => void;
  onImage?: () => void;
  onBack: () => void;
}

function GuideSteps({ path, language, onAction, onPasteLinks, onEnterKey, onImage, onBack }: GuideStepsProps) {
  const t = createT(language);
  const [showMore, setShowMore] = useState(false);

  const actionLabel: TranslationKey =
    path.action === 'camera'
      ? 'addAccount.scanWithCamera'
      : path.action === 'import'
        ? 'accounts.importFromBackup'
        : 'addAccount.scanFromScreen';

  // Steps are one string with newlines, matching how the FAQ answers are
  // written — one translation unit per path keeps them coherent when localised.
  const steps = t(path.steps).split('\n').filter(Boolean);
  // Positional, and safe to be: every translation is the same string with the
  // same number of lines, and a short one just leaves the fold empty.
  const cut = Math.min(path.primary, steps.length);
  const main = steps.slice(0, cut);
  const extra = steps.slice(cut);

  // 14px, the size Settings is read at. These are instructions followed with a
  // phone in the other hand, and at 12px they were the smallest text in the app
  // doing the most work.
  const step = (text: string, index: number) => (
    <li key={index} className="flex gap-3">
      <span className="flex h-6 w-6 flex-shrink-0 items-center justify-center rounded-full bg-blue-100 text-xs font-semibold text-accent-600 dark:text-accent-400 dark:bg-blue-900/30">
        {index + 1}
      </span>
      <span className="pt-0.5 text-sm leading-snug text-gray-700 dark:text-gray-300">{text}</span>
    </li>
  );

  return (
    // A column that fills the pane, so the bar at the end can be pushed to the
    // bottom edge when the steps are shorter than the popup.
    <div className="flex flex-1 flex-col px-5 pt-4">
      <ol className="space-y-3">{main.map((text, index) => step(text, index))}</ol>

      {/* Under the steps that name it, and in line with their text rather than
          in the bar below: that bar is Back and one button, and a third there
          does not fit a 320px popup in the longer languages. */}
      {path.paste && (
        <button
          onClick={onPasteLinks}
          className="ms-9 mt-3 inline-flex items-center self-start gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm font-medium text-accent-600 transition-colors hover:bg-gray-100 dark:border-dark-500 dark:bg-dark-800 dark:text-accent-400 dark:hover:bg-dark-700"
        >
          <Link2 size={16} />
          {t('import.paste')}
        </button>
      )}

      {path.keyInstead && (
        <button
          onClick={onEnterKey}
          className="ms-9 mt-3 inline-flex items-center self-start gap-1.5 rounded-lg border border-gray-300 bg-white px-3 py-2 text-start text-sm font-medium text-accent-600 transition-colors hover:bg-gray-100 dark:border-dark-500 dark:bg-dark-800 dark:text-accent-400 dark:hover:bg-dark-700"
        >
          <KeyRound size={16} className="shrink-0" />
          {t('onboarding.new.noQr')}
        </button>
      )}

      {extra.length > 0 && path.more && (
        <>
          <button
            onClick={() => {
              if (!showMore) void reportAddStep('guide', `${path.id}_more`);
              setShowMore(!showMore);
            }}
            aria-expanded={showMore}
            className="mt-3.5 flex items-center gap-1 text-sm font-medium text-accent-600 dark:text-accent-400 transition-colors hover:text-accent-700 dark:hover:text-accent-300"
          >
            <ChevronDown
              size={16}
              className={`transition-transform ${showMore ? 'rotate-180' : ''}`}
            />
            {t(path.more)}
          </button>
          {showMore && (
            <ol className="mt-3 space-y-3">
              {extra.map((text, index) => step(text, cut + index))}
            </ol>
          )}
        </>
      )}

      {/* Sticky, not merely last: the fallback steps can be long in any
          language, and the one button that finishes the path may not be
          skipped because it happens to sit past the bottom of a popup. It
          rides the bottom edge whenever the content is taller than the pane,
          and the spacer above holds it there when it isn't: under three short
          steps the buttons floated mid-popup over an empty half.

          Back sits beside it. The arrow in the header does the same thing,
          but "this is not my case" is decided here, at the end of the steps,
          and the header is the far end of the screen from there. */}
      <div className="min-h-4 flex-1" />
      <div className="sticky bottom-0 -mx-5 flex flex-col gap-2 bg-gray-50 px-5 pb-5 pt-3 before:absolute before:inset-x-0 before:-top-5 before:h-5 before:bg-gradient-to-t before:from-gray-50 before:to-transparent dark:bg-dark-900 dark:before:from-dark-900">
        {/* A picture of the code, full width over Back and the camera. It used
            to be a smaller button among the steps, and "no camera" and "camera
            blocked" were the two commonest ways this branch ended (1.15.0,
            ~750 of ~2,600 who opened it). */}
        {onImage && (
          <button
            onClick={onImage}
            className="flex w-full items-center justify-center gap-2 rounded-lg border border-accent-600 bg-white px-3 py-2.5 text-sm font-medium text-accent-600 transition-colors hover:bg-blue-50 dark:border-accent-400 dark:bg-dark-800 dark:text-accent-400 dark:hover:bg-dark-700"
          >
            <ImagePlus size={16} className="shrink-0" />
            {t('onboarding.ga.noCamera')}
          </button>
        )}
        <div className="flex gap-2">
          <button
            onClick={onBack}
            className="flex-shrink-0 rounded-lg border border-gray-300 bg-white px-4 py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-100 dark:border-dark-500 dark:bg-dark-800 dark:text-gray-200 dark:hover:bg-dark-700"
          >
            {t('common.back')}
          </button>
          <button
            onClick={onAction}
            className="flex min-w-0 flex-1 items-center justify-center gap-2 rounded-lg bg-accent-600 px-3 py-2.5 text-sm font-medium text-white transition-colors hover:bg-accent-700"
          >
            {onImage && <Camera size={16} className="shrink-0" />}
            {t(actionLabel)}
          </button>
        </div>
      </div>
    </div>
  );
}
