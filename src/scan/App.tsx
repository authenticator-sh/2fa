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
import { AlertTriangle, CameraOff, Check, Loader2, Lock, Upload } from 'lucide-react';
import type jsQRType from 'jsqr';
import { Logo } from '@/components/Logo';
import { FeedbackHost } from '@/components/FeedbackHost';
import { SupportFooter } from '@/components/SupportFooter';
import { applyDocumentLanguage, createT, detectLanguage, loadLanguage, type Language } from '@/utils/i18n';
import { addMultipleAccounts } from '@/utils/storage';
import { readActiveGroup } from '@/utils/active-group';
import { VaultLockedError } from '@/utils/vault';
import { generateRandomColor, parseQRCode, UnsupportedOTPTypeError } from '@/utils/qr-parser';
import { decodeQrFromImage } from '@/utils/qr-decode';
import { toast } from '@/utils/ui-feedback';
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
  /** Every video input, listed once a grant makes the labels readable. */
  const [cameras, setCameras] = useState<{ id: string; label: string }[]>([]);
  /** The device the live stream is actually using, so the picker shows it. */
  const [cameraId, setCameraId] = useState('');
  const [decodingImage, setDecodingImage] = useState(false);

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
  /** Which `start()` run owns the camera; see the comment in start(). */
  const startGenerationRef = useRef(0);
  /** The camera the user explicitly picked; null means the browser's choice. */
  const chosenCameraRef = useRef<string | null>(null);
  /** A second image while the first is still decoding would race the add. */
  const decodingImageRef = useRef(false);

  const t = createT(language);

  /** This export has codes the user has not scanned yet. */
  const moreCodes =
    status.kind === 'added' && !!status.batch && status.batch.index < status.batch.total;

  useEffect(() => {
    chrome.storage.local.get(['language', 'darkMode'], result => {
      if (result.darkMode) setDarkMode(true);
      // Same rule as the popup: a stored choice wins, otherwise the browser's
      // own language decides. This page opens in its own tab, where landing in
      // English is even more jarring than in a 360px popup.
      const language: Language = result.language || detectLanguage();
      if (language !== 'en') loadLanguage(language).then(() => setLanguage(language));
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

    // This run's ticket. Everything below happens after at least one await —
    // getUserMedia alone spans the whole time the permission prompt is up — and
    // an image pasted or dropped in that window finishes the scan without ever
    // touching the camera. The stream then arrived with nothing left to attach
    // it to: the code returned at `if (!video) return` still holding a live
    // MediaStream, so the camera light stayed on over the "Account added" card
    // until the tab was closed. Worse when the video was still mounted — the
    // success card was replaced by a preview that could decode nothing.
    const generation = ++startGenerationRef.current;
    /** True once this run has been overtaken by a decode or a newer start. */
    const superseded = () => handledRef.current || generation !== startGenerationRef.current;

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
        // A laptop has no `environment` camera, so the browser falls back to
        // its default device — which can be a virtual camera (OBS, phone-link)
        // showing a black or frozen frame. Once the user picks a real one in
        // the dropdown, ask for it by id. `ideal`, not `exact`: a remembered
        // camera that got unplugged should fall back, not dead-end the page.
        const chosen = chosenCameraRef.current;
        stream = await navigator.mediaDevices.getUserMedia({
          video: {
            ...(chosen ? { deviceId: { ideal: chosen } } : { facingMode: 'environment' }),
            width: { ideal: 1280 },
            height: { ideal: 720 },
          },
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

      // Nothing has been recorded anywhere until this line, so a run that lost
      // the race has to close its own stream rather than hand it over.
      if (superseded()) {
        stream.getTracks().forEach(track => track.stop());
        return;
      }

      streamRef.current = stream;

      // Labels are only readable after a grant, which is also the moment a
      // wrong default camera becomes visible as a wrong preview — list the
      // alternatives so there is a way out that is not "buy a better webcam".
      navigator.mediaDevices
        .enumerateDevices()
        .then(devices => {
          const inputs = devices.filter(device => device.kind === 'videoinput');
          setCameras(
            inputs.map((device, index) => ({
              id: device.deviceId,
              label: device.label || `Camera ${index + 1}`,
            }))
          );
        })
        .catch(() => {});
      const activeId = stream.getVideoTracks()[0]?.getSettings?.().deviceId;
      if (activeId) setCameraId(activeId);

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
      // Checked again: applying the focus constraint above is another await.
      if (!video || superseded()) {
        stopCamera();
        return;
      }

      video.srcObject = stream;
      await video.play().catch(() => {});
      // And once more before the status is written — otherwise a scan that has
      // already succeeded has its confirmation replaced by a live preview.
      if (superseded()) {
        stopCamera();
        return;
      }
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
        const frame = frameCount++;
        const side = Math.min(vw, vh) * CROP;
        const sx = (vw - side) / 2;
        const sy = (vh - side) / 2;
        // Downscaling to 480 is right for speed but wrong for dense codes: a
        // full Google Authenticator export runs ~100 modules across, which at
        // 480px is ~3px per module — the edge of what jsQR resolves, and any
        // blur pushes it over. About once a second, one frame is decoded at
        // the crop's native size instead.
        const size =
          frame % 30 === 29 ? Math.round(side) : Math.min(DECODE_SIZE, Math.round(side));

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
          inversionAttempts: frame % 8 === 7 ? 'attemptBoth' : 'dontInvert',
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

  /** The camera's fallback: a picture of the code — chosen, dropped, or pasted. */
  const handleImageFile = useCallback(
    async (file: Blob) => {
      if (decodingImageRef.current) return;
      decodingImageRef.current = true;
      setDecodingImage(true);
      try {
        const text = await decodeQrFromImage(file);
        if (!text) {
          toast('error', t('addAccount.errorNoQr'));
          return;
        }
        // Freeze the camera loop while the add is in flight, exactly like a
        // camera hit — otherwise a QR still in frame lands twice.
        handledRef.current = true;
        await handleDecoded(text);
        if (!handledRef.current) {
          // handleDecoded read it, found no otpauth in it, and reset the guard
          // expecting a live camera loop — which its early return in the
          // camera path keeps running, but this path froze. Restart it.
          toast('error', t('addAccount.errorInvalidQR'));
          start();
        }
      } catch (error) {
        console.error('Could not read the uploaded image:', error);
        toast('error', t('addAccount.errorNoQr'));
      } finally {
        decodingImageRef.current = false;
        setDecodingImage(false);
      }
    },
    // `t` is deliberately not a dependency, same as in handleDecoded — it is
    // rebuilt every render and would drag the document listeners with it.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [handleDecoded, start]
  );

  useEffect(() => {
    start();
    return stopCamera;
    // Intentionally once: restarts go through the retry button.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // The whole page accepts a picture of the code — dropped, or pasted with
  // Ctrl+V. A screenshot lands on the clipboard already; forcing a
  // save-to-file detour before "Choose image" would be the longest possible
  // path to the same pixels.
  useEffect(() => {
    const onDragOver = (event: DragEvent) => event.preventDefault();
    const onDrop = (event: DragEvent) => {
      event.preventDefault();
      const file = event.dataTransfer?.files?.[0];
      if (file && file.type.startsWith('image/')) handleImageFile(file);
    };
    const onPaste = (event: ClipboardEvent) => {
      const item = Array.from(event.clipboardData?.items ?? []).find(entry =>
        entry.type.startsWith('image/')
      );
      const file = item?.getAsFile();
      if (file) {
        event.preventDefault();
        handleImageFile(file);
      }
    };
    document.addEventListener('dragover', onDragOver);
    document.addEventListener('drop', onDrop);
    document.addEventListener('paste', onPaste);
    return () => {
      document.removeEventListener('dragover', onDragOver);
      document.removeEventListener('drop', onDrop);
      document.removeEventListener('paste', onPaste);
    };
  }, [handleImageFile]);

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

  const uploadButton = (
    <label className="flex w-full cursor-pointer items-center justify-center gap-2 rounded-lg border border-gray-300 bg-white py-2.5 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-dark-500 dark:bg-dark-700 dark:text-gray-200 dark:hover:bg-dark-600">
      <input
        type="file"
        accept="image/*"
        className="hidden"
        disabled={decodingImage}
        onChange={event => {
          const file = event.target.files?.[0];
          if (file) handleImageFile(file);
          // Reset so re-picking the same file fires onChange again.
          event.target.value = '';
        }}
      />
      {decodingImage ? <Loader2 className="animate-spin" size={16} /> : <Upload size={16} />}
      {t('addAccount.chooseImage')}
    </label>
  );

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
              {/* The way out that does not depend on the thing that just
                  failed. Every state on this card — denied, no camera, error —
                  is one a picture of the code walks straight past. */}
              <div className="mt-2">{uploadButton}</div>
              <p className="mt-2 text-xs text-gray-400 dark:text-gray-500">{t('scan.uploadHint')}</p>
            </div>
          ) : (
            <>
              <div className="relative aspect-[4/3] w-full overflow-hidden rounded-xl bg-black">
                <video ref={videoRef} playsInline muted className="h-full w-full object-cover" />
                {/* Viewfinder guide */}
                <div className="pointer-events-none absolute inset-0 flex items-center justify-center">
                  {/* Sized to what the decoder actually reads (CROP, an 80%
                      centre crop): the old fixed 192px square taught people to
                      hold the code smaller — and so blurrier — than it had to
                      be. 66% was still teaching it: under object-cover in a 4:3
                      box the crop lands at 80% of the container height at every
                      resolution the camera offers, so the guide covered 68% of
                      the read area by area and the dimming outside it actively
                      discouraged filling the rest. A dense code — a full Google
                      Authenticator export runs about a hundred modules across —
                      held to fill a 66% guide sits right where the cheap
                      downscaled pass stops resolving, which is the one case
                      that most needs the camera. */}
                  <div className="aspect-square h-[80%] rounded-lg border-2 border-white/80 shadow-[0_0_0_9999px_rgba(0,0,0,0.35)]" />
                </div>
                {status.kind === 'starting' && (
                  <div className="absolute inset-0 flex items-center justify-center bg-black/60">
                    <Loader2 className="animate-spin text-white" size={28} />
                  </div>
                )}
              </div>

              {cameras.length > 1 && (
                <select
                  value={cameraId}
                  onChange={event => {
                    chosenCameraRef.current = event.target.value;
                    setCameraId(event.target.value);
                    start();
                  }}
                  aria-label={t('scan.selectCamera')}
                  className="mt-3 w-full rounded-lg border border-gray-300 bg-white px-3 py-2 text-sm text-gray-700 outline-none focus:border-[#4285F4] dark:border-dark-500 dark:bg-dark-700 dark:text-gray-200"
                >
                  {cameras.map(camera => (
                    <option key={camera.id} value={camera.id}>
                      {camera.label}
                    </option>
                  ))}
                </select>
              )}

              {/* Plain text on purpose: with an icon in front it read as a
                  third button — same layout as the two real ones below it —
                  and it did nothing when clicked. */}
              <p className="mt-4 text-center text-sm text-gray-600 dark:text-gray-400">
                {status.kind === 'starting' ? t('scan.starting') : t('scan.hint')}
              </p>

              <div className="mt-3">{uploadButton}</div>
              <p className="mt-2 text-center text-xs text-gray-400 dark:text-gray-500">
                {t('scan.uploadHint')}
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
