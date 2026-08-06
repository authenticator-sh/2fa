// Camera QR scanner.
//
// This lives in its own extension page opened as a tab, not in the popup: the
// popup is destroyed the moment it loses focus, and Chrome's camera permission
// prompt takes focus — so the user could never reach the "Allow" button. In a
// tab the prompt behaves normally and Chrome remembers the grant for the
// extension's origin.
//
// Camera access needs no manifest permission for an extension page; it goes
// through the standard web prompt. The manifest still declares only "storage"
// and "activeTab".

import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, Camera, CameraOff, Check, Loader2, Lock } from 'lucide-react';
import type jsQRType from 'jsqr';
import { Logo } from '@/components/Logo';
import { FeedbackHost } from '@/components/FeedbackHost';
import { SupportFooter } from '@/components/SupportFooter';
import { applyDocumentLanguage, createT, loadLanguage, type Language } from '@/utils/i18n';
import { addMultipleAccounts } from '@/utils/storage';
import { readActiveGroup } from '@/utils/active-group';
import { VaultLockedError } from '@/utils/vault';
import { generateRandomColor, parseQRCode } from '@/utils/qr-parser';
import { cleanSecret } from '@/utils/totp';
import type { Account } from '@/types';
import { describeImport, type ImportOutcome } from '@/utils/import-message';

type Status =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  // `group` is the filter the popup had on when it opened the scanner, if any —
  // named in the result so the accounts are not simply missing later.
  | { kind: 'added'; outcome: ImportOutcome; group?: string }
  | { kind: 'locked' }
  | { kind: 'denied' }
  | { kind: 'noCamera' }
  | { kind: 'error'; message: string };

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [darkMode, setDarkMode] = useState(false);
  const [status, setStatus] = useState<Status>({ kind: 'starting' });

  const videoRef = useRef<HTMLVideoElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const streamRef = useRef<MediaStream | null>(null);
  const frameRef = useRef<number>();
  // Guards the async add path: a QR stays in frame for many frames, and without
  // this the same account gets submitted a dozen times before the first write
  // lands.
  const handledRef = useRef(false);

  const t = createT(language);

  useEffect(() => {
    chrome.storage.local.get(['language', 'darkMode'], result => {
      if (result.darkMode) setDarkMode(true);
      if (result.language) loadLanguage(result.language).then(() => setLanguage(result.language));
    });
  }, []);

  // The scanner is its own page, so it needs the same treatment as the popup.
  useEffect(() => {
    applyDocumentLanguage(language);
  }, [language]);

  const stopCamera = useCallback(() => {
    if (frameRef.current) cancelAnimationFrame(frameRef.current);
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  const handleDecoded = useCallback(
    async (text: string) => {
      const parsed = parseQRCode(text);
      if (!parsed || parsed.accounts.length === 0) {
        // Not an otpauth QR — keep scanning rather than failing the session.
        handledRef.current = false;
        return;
      }

      stopCamera();

      // The scanner runs in its own tab, but the popup that launched it may have
      // had a group filter on — and it restores that filter when it reopens. An
      // account added without the group would land outside the filter and simply
      // not be there, which on a 2FA app reads as a scan that silently failed.
      // The in-popup QR paths already inherit the filter; this one is the same
      // promise kept from a different window.
      const filteredGroup = (await readActiveGroup())?.trim() || undefined;

      const accounts: Account[] = parsed.accounts.map((data, index) => ({
        id: Date.now().toString() + index + Math.random().toString(36).substring(7),
        name: data.name,
        issuer: data.issuer,
        secret: cleanSecret(data.secret),
        algorithm: data.algorithm,
        digits: data.digits,
        period: data.period,
        createdAt: Date.now() + index,
        color: generateRandomColor(),
        ...(filteredGroup ? { group: filteredGroup } : {}),
      }));

      try {
        const result = await addMultipleAccounts(accounts);
        setStatus({ kind: 'added', outcome: result, group: filteredGroup });
      } catch (error) {
        if (error instanceof VaultLockedError) {
          setStatus({ kind: 'locked' });
          return;
        }
        console.error('Failed to add scanned accounts:', error);
        setStatus({ kind: 'error', message: String(error) });
      }
    },
    [stopCamera]
  );

  const start = useCallback(async () => {
    setStatus({ kind: 'starting' });
    handledRef.current = false;

    let decode: typeof jsQRType;
    try {
      // Same lazy import as the image path — jsQR only loads once a scan starts.
      decode = (await import('jsqr')).default;
    } catch (error) {
      setStatus({ kind: 'error', message: String(error) });
      return;
    }

    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({
        video: { facingMode: 'environment', width: { ideal: 1280 }, height: { ideal: 720 } },
        audio: false,
      });
    } catch (error) {
      const name = error instanceof DOMException ? error.name : '';
      if (name === 'NotAllowedError' || name === 'SecurityError') {
        setStatus({ kind: 'denied' });
      } else if (name === 'NotFoundError' || name === 'DevicesNotFoundError') {
        setStatus({ kind: 'noCamera' });
      } else {
        setStatus({ kind: 'error', message: error instanceof Error ? error.message : String(error) });
      }
      return;
    }

    streamRef.current = stream;
    const video = videoRef.current;
    if (!video) return;

    video.srcObject = stream;
    await video.play().catch(() => {});
    setStatus({ kind: 'scanning' });

    const canvas = canvasRef.current!;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });

    const tick = () => {
      frameRef.current = requestAnimationFrame(tick);
      if (handledRef.current || !ctx || video.readyState !== video.HAVE_ENOUGH_DATA) return;

      canvas.width = video.videoWidth;
      canvas.height = video.videoHeight;
      ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

      const { data } = ctx.getImageData(0, 0, canvas.width, canvas.height);
      const found = decode(data, canvas.width, canvas.height, { inversionAttempts: 'attemptBoth' });
      if (found?.data) {
        handledRef.current = true;
        handleDecoded(found.data);
      }
    };

    frameRef.current = requestAnimationFrame(tick);
  }, [handleDecoded]);

  useEffect(() => {
    start();
    return stopCamera;
    // Intentionally once: restarts go through the retry button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const message = () => {
    switch (status.kind) {
      case 'denied':
        return { icon: CameraOff, tone: 'red', title: t('scan.deniedTitle'), body: t('scan.deniedBody') };
      case 'noCamera':
        return { icon: CameraOff, tone: 'red', title: t('scan.noCameraTitle'), body: t('scan.noCameraBody') };
      case 'locked':
        return { icon: Lock, tone: 'yellow', title: t('scan.lockedTitle'), body: t('scan.lockedBody') };
      case 'error':
        return { icon: AlertTriangle, tone: 'red', title: t('scan.errorTitle'), body: status.message };
      default:
        return null;
    }
  };

  const problem = message();

  return (
    <div className={darkMode ? 'dark' : ''}>
      <div className="min-h-screen bg-gray-50 dark:bg-dark-900 flex flex-col items-center px-6 py-10">
        <div className="w-full max-w-md">
          <div className="flex items-center gap-2 mb-6">
            <Logo size={28} />
            <h1 className="text-xl font-semibold text-gray-900 dark:text-gray-100">{t('scan.title')}</h1>
          </div>

          {status.kind === 'added' ? (
            <div className="bg-white dark:bg-dark-800 border border-gray-200 dark:border-dark-600 rounded-xl p-6 text-center">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${
                  status.outcome.added > 0
                    ? 'bg-green-100 dark:bg-green-900/30'
                    : 'bg-gray-100 dark:bg-dark-700'
                }`}
              >
                <Check
                  className={status.outcome.added > 0 ? 'text-green-600 dark:text-green-400' : 'text-gray-400'}
                  size={24}
                />
              </div>
              <h2 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">
                {describeImport(status.outcome, language, status.group)}
              </h2>
              {status.outcome.added > 0 && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('scan.addedBody')}</p>
              )}
              <div className="flex gap-2">
                <button
                  onClick={start}
                  className="flex-1 text-sm font-medium py-2.5 rounded-lg border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700 transition-colors"
                >
                  {t('scan.scanAnother')}
                </button>
                <button
                  onClick={() => window.close()}
                  className="flex-1 bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
                >
                  {t('scan.done')}
                </button>
              </div>
            </div>
          ) : problem ? (
            <div className="bg-white dark:bg-dark-800 border border-gray-200 dark:border-dark-600 rounded-xl p-6 text-center">
              <div
                className={`w-12 h-12 rounded-full flex items-center justify-center mx-auto mb-3 ${
                  problem.tone === 'red'
                    ? 'bg-red-100 dark:bg-red-900/30'
                    : 'bg-yellow-100 dark:bg-yellow-900/30'
                }`}
              >
                <problem.icon
                  className={problem.tone === 'red' ? 'text-red-600 dark:text-red-400' : 'text-yellow-600 dark:text-yellow-400'}
                  size={24}
                />
              </div>
              <h2 className="text-base font-medium text-gray-900 dark:text-gray-100 mb-1">{problem.title}</h2>
              <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{problem.body}</p>
              <button
                onClick={start}
                className="w-full bg-[#4285F4] hover:bg-[#3367D6] text-white font-medium text-sm py-2.5 rounded-lg transition-colors"
              >
                {t('scan.retry')}
              </button>
            </div>
          ) : (
            <>
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black">
                <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
                {/* Viewfinder guide */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  <div className="h-48 w-48 rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
                </div>
                {status.kind === 'starting' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <Loader2 className="animate-spin text-white" size={28} />
                  </div>
                )}
              </div>

              <p className="mt-4 flex items-center justify-center gap-2 text-sm text-gray-600 dark:text-gray-400">
                <Camera size={16} />
                {status.kind === 'starting' ? t('scan.starting') : t('scan.hint')}
              </p>
            </>
          )}

          <canvas ref={canvasRef} className="hidden" />

          <div className="mt-10 rounded-xl border border-gray-200 dark:border-dark-600 overflow-hidden">
            <SupportFooter language={language} />
          </div>
        </div>
        <FeedbackHost />
      </div>
    </div>
  );
}
