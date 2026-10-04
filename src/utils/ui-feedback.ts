// In-app replacements for alert/confirm/prompt.
//
// A module-level store rather than React context: the call sites are spread
// across the popup, the modals and the scanner page, and threading callbacks
// through five components to show a message is worse than a subscription that
// any module can reach. `<FeedbackHost/>` renders whatever is pending.

export type ToastKind = 'success' | 'error' | 'info';

/** A button inside a toast — "Undo" after a delete. */
export interface ToastAction {
  label: string;
  run: () => void;
}

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
  action?: ToastAction;
  /** How long it stays up, not counting time spent paused. */
  durationMs: number;
}

export interface ConfirmRequest {
  id: number;
  kind: 'confirm';
  title: string;
  body?: string;
  /**
   * A caution to show in a box of its own, above the buttons.
   *
   * Separate from `body` because it is a different kind of sentence and wants a
   * different weight. The delete confirmation used to carry its warning inside
   * `body` as one pre-formatted string, emoji and bullet characters typed into
   * the translation — which meant every locale shipped its own layout, and the
   * result rendered as a paragraph pretending to be a list.
   */
  warning?: string;
  /** A closing line in smaller, quieter type — "this cannot be undone". */
  note?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  /** Answer and close. */
  resolve: (confirmed: boolean) => void;
  /** Answer without touching the slot — for a dialog another one has replaced. */
  settle: (confirmed: boolean) => void;
  /** What had focus before the dialog opened; it gets focus back when it closes. */
  opener?: Element | null;
}

export interface PromptRequest {
  id: number;
  kind: 'prompt';
  title: string;
  body?: string;
  placeholder?: string;
  password?: boolean;
  /**
   * Render a textarea instead of an input.
   *
   * Not cosmetic: a single-line input collapses a multi-line paste, and the
   * list of otpauth:// URIs it is used for is parsed line by line.
   */
  multiline?: boolean;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (value: string | null) => void;
  settle: (value: string | null) => void;
  opener?: Element | null;
}

export type DialogRequest = ConfirmRequest | PromptRequest;

interface State {
  toasts: Toast[];
  dialog: DialogRequest | null;
}

let state: State = { toasts: [], dialog: null };
const listeners = new Set<(state: State) => void>();
let nextId = 1;

function emit(): void {
  listeners.forEach(listener => listener(state));
}

export function subscribe(listener: (state: State) => void): () => void {
  listeners.add(listener);
  listener(state);
  return () => void listeners.delete(listener);
}

export function getState(): State {
  return state;
}

/**
 * How long a toast stays up.
 *
 * One figure for everything was 3.5 seconds, which is enough for "Copied" and
 * not for the sentences this app also puts in a toast: "Saved 12 accounts. 2
 * Steam Guard accounts were left out — this format cannot describe them…" is
 * 150 characters, gone before most people reach the part that says what to
 * do. Time grows with the text, at a slow reading pace of about 50 ms a
 * character. An error starts from longer, because it is the one that asks for
 * something; a toast with a button starts from longer still, because the
 * button is worth nothing if it vanishes while the pointer travels to it.
 */
export function toastDuration(kind: ToastKind, message: string, hasAction = false): number {
  const floor = hasAction ? 10_000 : kind === 'error' ? 6_000 : 4_000;
  return Math.min(20_000, Math.max(floor, 2_000 + message.length * 50));
}

interface ToastTimer {
  handle: ReturnType<typeof setTimeout> | null;
  /** Time left to run; counted down only while not paused. */
  remaining: number;
  startedAt: number;
}

const timers = new Map<number, ToastTimer>();
let paused = false;

function startTimer(id: number, timer: ToastTimer): void {
  timer.startedAt = Date.now();
  timer.handle = setTimeout(() => dismissToast(id), timer.remaining);
}

export function toast(
  kind: ToastKind,
  message: string,
  options: { action?: ToastAction; durationMs?: number } = {}
): number {
  const id = nextId++;
  const durationMs = options.durationMs ?? toastDuration(kind, message, Boolean(options.action));
  state = {
    ...state,
    toasts: [...state.toasts, { id, kind, message, durationMs, ...(options.action ? { action: options.action } : {}) }],
  };
  emit();
  const timer: ToastTimer = { handle: null, remaining: durationMs, startedAt: 0 };
  timers.set(id, timer);
  if (!paused) startTimer(id, timer);
  return id;
}

export function dismissToast(id: number): void {
  const timer = timers.get(id);
  if (timer?.handle) clearTimeout(timer.handle);
  timers.delete(id);
  if (!state.toasts.some(t => t.id === id)) return;
  state = { ...state, toasts: state.toasts.filter(t => t.id !== id) };
  // A toast clicked away while hovered never gets its mouseleave, so the pause
  // it started would outlive it and freeze every toast after it on screen.
  if (state.toasts.length === 0) paused = false;
  emit();
}

/**
 * Stop the clocks while the pointer or the keyboard is on a toast.
 *
 * A toast that disappears under the cursor — or while a screen reader user is
 * tabbing to its Undo — takes the action with it. All of them pause together:
 * they stack in one column, and the one being read is rarely the only one
 * being read.
 */
export function pauseToasts(): void {
  if (paused) return;
  paused = true;
  const now = Date.now();
  for (const timer of timers.values()) {
    if (!timer.handle) continue;
    clearTimeout(timer.handle);
    timer.handle = null;
    timer.remaining = Math.max(0, timer.remaining - (now - timer.startedAt));
  }
}

export function resumeToasts(): void {
  if (!paused) return;
  paused = false;
  for (const [id, timer] of timers) {
    // Never less than a second and a half back: resuming onto a toast with
    // nothing left would snatch it away the moment the pointer moves off it.
    timer.remaining = Math.max(timer.remaining, 1_500);
    startTimer(id, timer);
  }
}

/**
 * Show a dialog, answering any one it replaces.
 *
 * There is one dialog slot. A second request used to overwrite the first, and
 * the first promise was never settled — its caller sat on an `await` for the
 * life of the page, holding whatever busy flag or lock it had taken. It is now
 * answered as a cancel, which is what it is: the user never got to choose.
 */
function openDialog(request: DialogRequest): void {
  const previous = state.dialog;
  // A dialog that replaces another returns focus where the first one would
  // have: the replaced one's own buttons are gone by then.
  request.opener = previous
    ? previous.opener
    : typeof document !== 'undefined'
      ? document.activeElement
      : null;
  state = { ...state, dialog: request };
  emit();
  if (previous) settleAsCancel(previous);
}

function settleAsCancel(request: DialogRequest): void {
  if (request.kind === 'prompt') request.settle(null);
  else request.settle(false);
}

function closeDialog(id: number): void {
  // Only the dialog that is answering may close the slot: an answer from one
  // that has already been replaced must not take its successor down with it.
  if (state.dialog?.id !== id) return;
  state = { ...state, dialog: null };
  emit();
}

export function confirmDialog(
  options: Omit<ConfirmRequest, 'id' | 'kind' | 'resolve' | 'settle' | 'opener'>
): Promise<boolean> {
  return new Promise(resolve => {
    const id = nextId++;
    let settled = false;
    const settle = (confirmed: boolean) => {
      if (settled) return;
      settled = true;
      resolve(confirmed);
    };
    openDialog({
      ...options,
      id,
      kind: 'confirm',
      settle,
      resolve: confirmed => {
        closeDialog(id);
        settle(confirmed);
      },
    });
  });
}

export function promptDialog(
  options: Omit<PromptRequest, 'id' | 'kind' | 'resolve' | 'settle' | 'opener'>
): Promise<string | null> {
  return new Promise(resolve => {
    const id = nextId++;
    let settled = false;
    const settle = (value: string | null) => {
      if (settled) return;
      settled = true;
      resolve(value);
    };
    openDialog({
      ...options,
      id,
      kind: 'prompt',
      settle,
      resolve: value => {
        closeDialog(id);
        settle(value);
      },
    });
  });
}
