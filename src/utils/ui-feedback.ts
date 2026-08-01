// In-app replacements for alert/confirm/prompt.
//
// A module-level store rather than React context: the call sites are spread
// across the popup, the modals and the scanner page, and threading callbacks
// through five components to show a message is worse than a subscription that
// any module can reach. `<FeedbackHost/>` renders whatever is pending.

export type ToastKind = 'success' | 'error' | 'info';

export interface Toast {
  id: number;
  kind: ToastKind;
  message: string;
}

export interface ConfirmRequest {
  id: number;
  kind: 'confirm';
  title: string;
  body?: string;
  confirmLabel: string;
  cancelLabel: string;
  danger?: boolean;
  resolve: (confirmed: boolean) => void;
}

export interface PromptRequest {
  id: number;
  kind: 'prompt';
  title: string;
  body?: string;
  placeholder?: string;
  password?: boolean;
  confirmLabel: string;
  cancelLabel: string;
  resolve: (value: string | null) => void;
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

const TOAST_MS = 3500;

export function toast(kind: ToastKind, message: string): void {
  const id = nextId++;
  state = { ...state, toasts: [...state.toasts, { id, kind, message }] };
  emit();
  setTimeout(() => dismissToast(id), TOAST_MS);
}

export function dismissToast(id: number): void {
  state = { ...state, toasts: state.toasts.filter(t => t.id !== id) };
  emit();
}

function openDialog(request: DialogRequest): void {
  state = { ...state, dialog: request };
  emit();
}

function closeDialog(): void {
  state = { ...state, dialog: null };
  emit();
}

export function confirmDialog(
  options: Omit<ConfirmRequest, 'id' | 'kind' | 'resolve'>
): Promise<boolean> {
  return new Promise(resolve => {
    openDialog({
      ...options,
      id: nextId++,
      kind: 'confirm',
      resolve: confirmed => {
        closeDialog();
        resolve(confirmed);
      },
    });
  });
}

export function promptDialog(
  options: Omit<PromptRequest, 'id' | 'kind' | 'resolve'>
): Promise<string | null> {
  return new Promise(resolve => {
    openDialog({
      ...options,
      id: nextId++,
      kind: 'prompt',
      resolve: value => {
        closeDialog();
        resolve(value);
      },
    });
  });
}
