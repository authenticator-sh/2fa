import { useState } from 'react';
import { Eye, EyeOff, Copy, Check, AlertTriangle } from 'lucide-react';
import { ModalHeader } from './ModalHeader';
import type { Account } from '@/types';
import { accountLabel } from '@/utils/account-label';
import { createT, type Language } from '@/utils/i18n';
import { buildShareLink, clampLabel, MAX_SHARE_SECONDS, SHARE_DURATIONS, type ShareLink } from '@/utils/share';
import { drawQR, type QRDrawing } from '@/utils/qr-encode';

interface ShareModalProps {
  account: Account;
  language: Language;
  onClose: () => void;
}

/**
 * Sharing an account's codes by link.
 *
 * Two screens in one dialog. The first asks how long the link should work and
 * whether it needs a password; the second shows the link as a QR code and as
 * text. Nothing is written anywhere in between: the link is computed in the
 * popup from the account's own generator — see utils/share.ts for what goes
 * into it and, more to the point, what does not.
 *
 * The QR code is shown first and largest on purpose. Reading it off the screen
 * is the one way to hand the link over that leaves no copy in a messenger's
 * cloud, and it is the natural gesture between two people in the same room —
 * which is who most of these links are for.
 */
export function ShareModal({ account, language, onClose }: ShareModalProps) {
  const t = createT(language);
  // The maximum is the default. A link is opened when the other person gets
  // round to it, not the moment it is sent, and a five-minute default that has
  // run out by then is a second link and a second message. An hour is still
  // bounded, and the sender can shorten it.
  // Seeded with the account's own label, so a sender who does not care sends
  // exactly what they sent before. Cleared on purpose, the link names no
  // account at all — useful when the recipient should not learn which
  // service the code is for.
  //
  // Clamped through the same function that seals it: the payload's limit is 64
  // bytes, so a maxLength of 64 characters would have let a Cyrillic or CJK
  // label be typed in full and arrive halved, with nothing on screen saying so.
  const [label, setLabel] = useState(() => clampLabel(accountLabel(account)));
  const [durationSec, setDurationSec] = useState<number>(MAX_SHARE_SECONDS);
  const [password, setPassword] = useState('');
  const [showPassword, setShowPassword] = useState(false);
  const [creating, setCreating] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [link, setLink] = useState<ShareLink | null>(null);
  const [qr, setQr] = useState<QRDrawing | null>(null);
  const [copied, setCopied] = useState(false);

  const durationLabel = (seconds: number) =>
    seconds >= MAX_SHARE_SECONDS ? t('share.hour') : t('share.minutes', Math.round(seconds / 60));

  const handleCreate = async (event: React.FormEvent) => {
    event.preventDefault();
    setCreating(true);
    setError(null);
    try {
      const built = await buildShareLink({ account, durationSec, label, password: password || undefined });
      // Drawn before the link is shown, so the second screen never paints with
      // a hole where the QR code is about to be — but a failure here is not a
      // failure to share. A five-second period packs 721 codes into 2 500
      // characters, past what any QR version can hold, and the encoder throws;
      // the link itself is fine and copying it still works, so the code is
      // dropped and the rest of the screen stands.
      let drawing: QRDrawing | null = null;
      try {
        drawing = await drawQR(built.url);
      } catch (err) {
        console.error('Could not draw a QR code for the share link', err);
      }
      setLink(built);
      setQr(drawing);
    } catch (err) {
      // The one failure with a cause of its own is a secret that produces no
      // code, and the card already refuses to offer sharing for those — so
      // this is the message for anything that gets past that.
      console.error('Could not build a share link', err);
      setError(t('share.failed'));
    } finally {
      setCreating(false);
    }
  };

  const handleCopy = async () => {
    if (!link) return;
    try {
      await navigator.clipboard.writeText(link.url);
    } catch (err) {
      console.error('Could not copy the link to the clipboard', err);
      return;
    }
    setCopied(true);
    setTimeout(() => setCopied(false), 2000);
  };

  const validUntil = link
    ? new Date(link.validUntilMs).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })
    : '';

  const inputClass =
    'w-full bg-white dark:bg-dark-900 text-gray-900 dark:text-gray-100 text-sm rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 focus:border-[#4285F4] focus:ring-2 focus:ring-[#4285F4]/20 outline-none transition-all placeholder-gray-400 dark:placeholder-gray-500';

  return (
    <div
      className="fixed inset-0 z-50 flex flex-col bg-gray-50 dark:bg-dark-800"
      role="dialog"
      aria-modal="true"
      aria-label={t('share.title')}
    >
      <ModalHeader title={t('share.title')} back={t('common.back')} onBack={onClose} />

      <div className="flex-1 overflow-y-auto">
        <div className="mx-auto w-full max-w-md p-4">
          {/* The label as sent, not the account's own: it is the only chance
              the sender gets to see what the other person will read, and a
              cleared field means the link names nothing — which is a choice
              this screen must not quietly contradict. */}
          {link && label.trim() && (
            <p className="mb-3 truncate text-sm font-medium text-gray-900 dark:text-gray-100" title={label.trim()}>
              {label.trim()}
            </p>
          )}

          {!link ? (
            <form onSubmit={handleCreate} className="space-y-4">
              <p className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                {t('share.intro', durationLabel(durationSec))}
              </p>

              <div>
                <label
                  htmlFor="share-label"
                  className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5"
                >
                  {t('share.label')}
                </label>
                <input
                  id="share-label"
                  type="text"
                  value={label}
                  onChange={(e) => setLabel(clampLabel(e.target.value))}
                  // A text field directly above a password field is the shape
                  // every password manager reads as a sign-in form, and the one
                  // below is a password that must never be saved anywhere.
                  autoComplete="off"
                  data-lpignore="true"
                  className={inputClass}
                />
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t('share.duration')}
                </label>
                {/* A row of chips, not a select: four choices fit on one line,
                    and the one that is picked should be visible without a
                    click. The last chip is the maximum, and there is no field
                    for typing a longer one. */}
                <div className="grid grid-cols-4 gap-1.5" role="radiogroup" aria-label={t('share.duration')}>
                  {SHARE_DURATIONS.map((seconds) => {
                    const active = seconds === durationSec;
                    return (
                      <button
                        key={seconds}
                        type="button"
                        role="radio"
                        aria-checked={active}
                        onClick={() => setDurationSec(seconds)}
                        className={`rounded-lg border px-2 py-1.5 text-xs font-medium transition-colors ${
                          active
                            ? 'border-[#4285F4] bg-blue-50 text-[#4285F4] dark:bg-blue-900/30 dark:text-blue-300'
                            : 'border-gray-300 text-gray-700 hover:bg-gray-50 dark:border-dark-600 dark:text-gray-300 dark:hover:bg-dark-700'
                        }`}
                      >
                        {durationLabel(seconds)}
                      </button>
                    );
                  })}
                </div>
              </div>

              <div>
                <label className="block text-sm font-medium text-gray-700 dark:text-gray-300 mb-1.5">
                  {t('share.password')}
                </label>
                <div className="relative">
                  <input
                    type={showPassword ? 'text' : 'password'}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                    autoComplete="off"
                    // A password typed here is never stored, so the browser's
                    // "save this password?" bar would be offering to keep the
                    // one thing that was meant to be sent another way.
                    data-lpignore="true"
                    className={`${inputClass} pe-10`}
                  />
                  <button
                    type="button"
                    onClick={() => setShowPassword(!showPassword)}
                    className="absolute end-2 top-1/2 -translate-y-1/2 text-gray-400 hover:text-gray-600 dark:text-gray-500 dark:hover:text-gray-300 transition-colors p-1"
                  >
                    {showPassword ? <EyeOff size={16} /> : <Eye size={16} />}
                  </button>
                </div>
                <p className="mt-1.5 text-xs leading-relaxed text-gray-500 dark:text-gray-400">
                  {t('share.passwordHint')}
                </p>
              </div>

              {error && (
                <p className="text-xs text-red-600 dark:text-red-400">{error}</p>
              )}

              <button
                type="submit"
                disabled={creating}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] disabled:opacity-60 text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
              >
                {creating ? t('share.creating') : t('share.create')}
              </button>
            </form>
          ) : (
            <div className="space-y-3">
              {qr && (
                // A white field of its own, in both themes: a QR code on a dark
                // background is inverted, and cameras read that far less
                // reliably. The quiet zone is the padding.
                <div className="mx-auto w-full max-w-[240px] rounded-lg bg-white p-3">
                  <svg
                    viewBox={`0 0 ${qr.size} ${qr.size}`}
                    shapeRendering="crispEdges"
                    className="block h-auto w-full text-black"
                    role="img"
                    aria-label={t('share.scan')}
                  >
                    <path d={qr.path} fill="currentColor" />
                  </svg>
                </div>
              )}

              <p className="text-center text-xs text-gray-500 dark:text-gray-400">{t('share.scan')}</p>

              {/* Read-only and single-line: the link is around 550 characters
                  and its middle is noise. What matters is that it visibly
                  starts with our address, which the truncation leaves in view. */}
              <input
                type="text"
                readOnly
                value={link.url}
                onFocus={(e) => e.currentTarget.select()}
                dir="ltr"
                className="w-full bg-gray-50 dark:bg-dark-900/50 text-gray-700 dark:text-gray-300 text-xs font-mono rounded-lg px-3 py-2 border border-gray-300 dark:border-dark-600 outline-none truncate"
              />

              <button
                type="button"
                onClick={handleCopy}
                className={`w-full flex items-center justify-center gap-2 font-medium text-sm py-2.5 rounded-lg transition-colors ${
                  copied
                    ? 'bg-green-600 text-white'
                    : 'bg-[#4285F4] hover:bg-[#3367D6] text-white'
                }`}
              >
                {copied ? <Check size={16} /> : <Copy size={16} />}
                {copied ? t('share.copied') : t('share.copy')}
              </button>

              <div className="text-xs leading-relaxed text-gray-600 dark:text-gray-400">
                <p className="font-medium text-gray-900 dark:text-gray-100">{t('share.validUntil', validUntil)}</p>
                {password && <p className="mt-0.5">{t('share.passwordReminder')}</p>}
              </div>

              <div className="flex items-start gap-2 rounded-lg border border-amber-200 bg-amber-50 p-3 text-xs leading-relaxed text-amber-900 dark:border-amber-900/40 dark:bg-amber-900/20 dark:text-amber-200">
                <AlertTriangle size={14} className="mt-0.5 flex-shrink-0" />
                <span>{t('share.caution')}</span>
              </div>

              <button
                type="button"
                onClick={onClose}
                className="w-full border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 font-medium text-sm py-2.5 rounded-lg transition-colors"
              >
                {t('share.done')}
              </button>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
