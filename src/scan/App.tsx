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
import { generateRandomColor, parseQRCode, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { cleanSecret } from '@/utils/totp';
import type { Account } from '@/types';
import { describeImport, type ImportOutcome } from '@/utils/import-message';

type Status =
  | { kind: 'starting' }
  | { kind: 'scanning' }
  // `group` is the filter the popup had on when it opened the scanner, if any —
  // named in the result so the accounts are not simply missing later.
  | { kind: 'added'; outcome: ImportOutcome; group?: string; batch?: { index: number; total: number } }
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
  /** Stops whichever frame loop is running — rVFC and rAF cancel differently. */
  const stopLoopRef = useRef<(() => void) | null>(null);
  /** A second start() while the first is still awaiting getUserMedia leaked its stream. */
  const startingRef = useRef(false);
  // Guards the async add path: a QR stays in frame for many frames, and without
  // this the same account gets submitted a dozen times before the first write
  // lands.
  const handledRef = useRef(false);

  const t = createT(language);

  /** This export has codes the user has not scanned yet. */
  const moreCodes =
    status.kind === 'added' && !!status.batch && status.batch.index < status.batch.total;

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
    stopLoopRef.current?.();
    stopLoopRef.current = null;
    streamRef.current?.getTracks().forEach(track => track.stop());
    streamRef.current = null;
  }, []);

  const handleDecoded = useCallback(
    async (text: string) => {
      let parsed;
      try {
        parsed = parseQRCode(text);
      } catch (error) {
        // A QR we read and refuse — currently only counter-based tokens. Unlike
        // an unrecognised code, rescanning this one will never help, so the
        // session ends with an explanation instead of looping on the camera.
        stopCamera();
        setStatus({
          kind: 'error',
          message:
            error instanceof UnsupportedOTPTypeError
              ? t('addAccount.errorHotp')
              : t('addAccount.errorInvalidQR'),
        });
        return;
      }

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
        setStatus({ kind: 'added', outcome: result, group: filteredGroup, batch: parsed.batch });
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
    // Two starts overlapping — a double click on "Scan another" — used to leave
    // the first getUserMedia stream running with nothing tracking it, so the
    // camera light stayed on until the tab closed.
    if (startingRef.current) return;
    startingRef.current = true;
    stopCamera();

    setStatus({ kind: 'starting' });
    handledRef.current = false;

    try {
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

      // Most of the "hold it there, keep holding it" is the webcam hunting for
      // focus on a phone screen 30cm away, not the decoder. Asking for
      // continuous autofocus costs nothing where it is unsupported.
      try {
        const [track] = stream.getVideoTracks();
        const capabilities = (track.getCapabilities?.() ?? {}) as { focusMode?: string[] };
        if (capabilities.focusMode?.includes('continuous')) {
          await track.applyConstraints({
            advanced: [{ focusMode: 'continuous' } as MediaTrackConstraintSet],
          });
        }
      } catch {
        // Focus control is optional; scanning still works without it.
      }

      const video = videoRef.current;
      if (!video) return;

      video.srcObject = stream;
      await video.play().catch(() => {});
      setStatus({ kind: 'scanning' });

      const canvas = canvasRef.current!;
      const ctx = canvas.getContext('2d', { willReadFrequently: true });

      // The camera runs at 1280x720, and reading that back is ~3.7 MB per frame
      // before jsQR has looked at a single pixel. A QR needs nothing like it:
      // decoding a downscaled centre square costs about a sixteenth as much, and
      // the frames saved go into a preview that no longer stutters — which is
      // itself most of why aiming took so long.
      const DECODE_SIZE = 480;
      const CROP = 0.8;
      let frameCount = 0;

      const scanFrame = () => {
        if (handledRef.current || !ctx || video.readyState !== video.HAVE_ENOUGH_DATA) return;

        const vw = video.videoWidth;
        const vh = video.videoHeight;
        if (!vw || !vh) return;

        // The viewfinder points people at the middle; the edges are background
        // that costs pixels and never holds the code.
        const side = Math.min(vw, vh) * CROP;
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        const size = Math.min(DECODE_SIZE, Math.round(side));

        // Assigning width resets the whole canvas, so only do it on a change.
        if (canvas.width !== size || canvas.height !== size) {
          canvas.width = size;
          canvas.height = size;
        }

        ctx.drawImage(video, sx, sy, side, side, 0, 0, size, size);
        const { data } = ctx.getImageData(0, 0, size, size);

        // `attemptBoth` runs the detector a second time over the whole frame
        // whenever the first pass finds nothing — which is every frame while the
        // user is still aiming, the entire stretch that actually matters.
        // Inverted codes barely exist for otpauth, so they get an occasional
        // frame instead of half the budget.
        const found = decode(data, size, size, {
          inversionAttempts: frameCount++ % 8 === 7 ? 'attemptBoth' : 'dontInvert',
        });

        if (found?.data) {
          handledRef.current = true;
          handleDecoded(found.data);
        }
      };

      // requestVideoFrameCallback fires once per frame the camera actually
      // delivers (~30/s); rAF fires 60 times a second and would decode half of
      // them twice over.
      const withVideoFrames = video as HTMLVideoElement & {
        requestVideoFrameCallback?: (cb: () => void) => number;
        cancelVideoFrameCallback?: (handle: number) => void;
      };

      if (typeof withVideoFrames.requestVideoFrameCallback === 'function') {
        let handle = 0;
        const onFrame = () => {
          scanFrame();
          if (!handledRef.current) handle = withVideoFrames.requestVideoFrameCallback!(onFrame);
        };
        handle = withVideoFrames.requestVideoFrameCallback(onFrame);
        stopLoopRef.current = () => withVideoFrames.cancelVideoFrameCallback?.(handle);
      } else {
        let handle = 0;
        const tick = () => {
          handle = requestAnimationFrame(tick);
          scanFrame();
        };
        handle = requestAnimationFrame(tick);
        stopLoopRef.current = () => cancelAnimationFrame(handle);
      }
    } finally {
      startingRef.current = false;
    }
  }, [handleDecoded, stopCamera]);

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
              {status.outcome.added > 0 && !moreCodes && (
                <p className="text-sm text-gray-500 dark:text-gray-400 mb-4">{t('scan.addedBody')}</p>
              )}

              {/* Google Authenticator caps a code at ten accounts and puts the
                  rest behind a "Next" button that is easy to miss. Someone who
                  scans one code and reads "10 imported" as "finished" leaves the
                  other twenty on the phone and only finds out when they need
                  one. The payload says which code this was, so say it. */}
              {moreCodes && (
                <div className="mb-4 rounded-lg border border-amber-200 bg-amber-50 p-3 text-start dark:border-amber-800 dark:bg-amber-900/20">
                  <div className="text-sm font-medium text-amber-900 dark:text-amber-200">
                    {t('scan.batchMore', status.batch!.index, status.batch!.total, status.batch!.total - status.batch!.index)}
                  </div>
                  <p className="mt-1 text-xs leading-relaxed text-amber-800 dark:text-amber-300">
                    {t('scan.batchBody')}
                  </p>
                </div>
              )}

              {status.batch && !moreCodes && (
                <p className="mb-4 text-sm text-green-700 dark:text-green-400">
                  {t('scan.batchLast', status.batch.total)}
                </p>
              )}

              {/* With codes still to come, "Scan another" is the action that
                  finishes the job, so it stops being the quiet one. */}
              <div className="flex gap-2">
                <button
                  onClick={start}
                  className={`flex-1 text-sm font-medium py-2.5 rounded-lg transition-colors ${
                    moreCodes
                      ? 'bg-[#4285F4] hover:bg-[#3367D6] text-white'
                      : 'border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700'
                  }`}
                >
                  {moreCodes ? t('scan.scanNext') : t('scan.scanAnother')}
                </button>
                <button
                  onClick={() => window.close()}
                  className={`flex-1 font-medium text-sm py-2.5 rounded-lg transition-colors ${
                    moreCodes
                      ? 'border border-gray-300 dark:border-dark-500 text-gray-700 dark:text-gray-300 hover:bg-gray-50 dark:hover:bg-dark-700'
                      : 'bg-[#4285F4] hover:bg-[#3367D6] text-white'
                  }`}
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
