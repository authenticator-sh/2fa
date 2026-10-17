// Pictures for the two ways the browser's camera question goes wrong.
//
// A line of text saying "allow the camera in your site settings" leaves the
// person to find those settings, and a third of the people who open the scanner
// never got a picture. These draw the one place to look: the camera icon at the
// end of the address bar for a refusal, and the question's own box at the top
// left for a question that was closed or is still waiting.
//
// The browser's chrome is drawn without words — bars for text — so nothing here
// needs a translation but the step texts and the one button label, and it reads
// the same under any browser's skin. Motion is `motion-safe:` throughout: with
// reduced motion asked for, the arrow and the ring simply sit there.

import { ArrowUp, CameraOff, Check, Lock, Video } from 'lucide-react';

/** The address bar with the blocked camera at its end, pointed at. */
function AddressBarMock() {
  return (
    <div dir="ltr" aria-hidden="true" className="mx-auto w-full max-w-xs">
      <div className="flex items-center gap-2 rounded-full border border-gray-300 bg-gray-100 px-3 py-1.5 dark:border-dark-500 dark:bg-dark-700">
        <Lock size={12} className="shrink-0 text-gray-400" />
        <div className="h-2 flex-1 rounded-full bg-gray-300 dark:bg-dark-500" />
        <span className="relative flex h-6 w-6 shrink-0 items-center justify-center rounded-full bg-red-100 dark:bg-red-900/40">
          <span className="absolute inset-0 rounded-full bg-red-400/50 motion-safe:animate-ping" />
          <CameraOff size={13} className="relative text-red-600 dark:text-red-400" />
        </span>
      </div>
      <div className="flex justify-end pr-[18px]">
        <ArrowUp size={22} className="mt-1 text-accent-600 motion-safe:animate-bounce dark:text-accent-400" />
      </div>
    </div>
  );
}

/** The browser's question, in the top-left corner where it opens, with its Allow button picked out. */
export function PromptMock({ allow }: { allow: string }) {
  return (
    <div dir="ltr" aria-hidden="true" className="mx-auto w-full max-w-xs text-start">
      <div className="flex items-center gap-2 rounded-full border border-gray-300 bg-gray-100 px-3 py-1.5 dark:border-dark-500 dark:bg-dark-700">
        <Lock size={12} className="shrink-0 text-gray-400" />
        <div className="h-2 flex-1 rounded-full bg-gray-300 dark:bg-dark-500" />
      </div>
      <div className="mt-1 w-44 rounded-lg border border-gray-300 bg-white p-2.5 shadow-md dark:border-dark-500 dark:bg-dark-800">
        <div className="flex items-center gap-1.5">
          <Video size={13} className="shrink-0 text-gray-500 dark:text-gray-400" />
          <div className="h-1.5 w-20 rounded-full bg-gray-300 dark:bg-dark-500" />
        </div>
        <div className="mt-2 flex gap-1.5">
          <span className="relative flex-1">
            <span className="absolute -inset-0.5 rounded-md ring-2 ring-accent-500 motion-safe:animate-pulse" />
            <span className="relative block rounded-md bg-accent-600 py-1 text-center text-[11px] font-medium text-white">
              {allow}
            </span>
          </span>
          <span className="flex-1 rounded-md bg-gray-200 py-1 dark:bg-dark-600" />
        </div>
      </div>
    </div>
  );
}

/** The three steps for a camera the browser has blocked, under the picture of where to click. */
export function BlockedGuide({ steps, allow }: { steps: [string, string, string]; allow: string }) {
  return (
    <div className="mb-4">
      <AddressBarMock />
      <ol className="mt-3 space-y-2 text-start">
        {steps.map((text, index) => (
          <li key={index} className="flex items-start gap-2.5 text-sm text-gray-700 dark:text-gray-300">
            <span className="mt-0.5 flex h-5 w-5 shrink-0 items-center justify-center rounded-full bg-accent-50 text-xs font-semibold text-accent-700 dark:bg-accent-700/30 dark:text-accent-300">
              {index + 1}
            </span>
            <span className="flex-1">
              {text}
              {index === 1 && (
                <span dir="ltr" className="ms-2 inline-flex items-center gap-1 rounded bg-green-100 px-1.5 py-0.5 align-middle text-xs font-medium text-green-700 dark:bg-green-900/30 dark:text-green-400">
                  <Check size={11} />
                  {allow}
                </span>
              )}
            </span>
          </li>
        ))}
      </ol>
    </div>
  );
}
