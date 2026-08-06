import { Component, type ErrorInfo, type ReactNode } from 'react';

interface ErrorBoundaryProps {
  children: ReactNode;
}

interface ErrorBoundaryState {
  message: string | null;
}

/**
 * Last resort between a render error and a blank popup.
 *
 * Without one, a single throw anywhere in the tree unmounts everything and
 * leaves a white rectangle. On a 2FA app that is not a glitch someone shrugs at
 * — it is indistinguishable from every account being gone, and if the throw
 * comes from stored data (a field of an unexpected type in an imported file, say)
 * it repeats on every open, with no way to reach the export button and get the
 * secrets back out.
 *
 * So the fallback's job is not to apologise. It is to say the data is still
 * there and hand over the two actions that recover from a bad record: reload,
 * and export everything to a file.
 */
export class ErrorBoundary extends Component<ErrorBoundaryProps, ErrorBoundaryState> {
  state: ErrorBoundaryState = { message: null };

  static getDerivedStateFromError(error: unknown): ErrorBoundaryState {
    return { message: error instanceof Error ? error.message : String(error) };
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error('Popup crashed:', error, info.componentStack);
  }

  /**
   * Reads the records straight out of storage and offers them as a download.
   *
   * Deliberately not the normal export path: that one decodes every account
   * first, and whatever is wrong with the data is likely to throw there too.
   * The file is the raw stored form — encrypted if a vault is on — which the
   * import side already knows how to read back.
   */
  private handleExport = async () => {
    try {
      const stored = await chrome.storage.local.get('authenticator_accounts');
      const blob = new Blob([JSON.stringify(stored.authenticator_accounts ?? [], null, 2)], {
        type: 'application/json',
      });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `authenticator-recovery-${new Date().toISOString().slice(0, 10)}.json`;
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      console.error('Recovery export failed:', error);
    }
  };

  render() {
    if (this.state.message === null) return this.props.children;

    // Deliberately untranslated: the translation layer is part of what may have
    // just thrown, and English that renders beats a key that does not.
    return (
      <div className="flex h-full flex-col items-center justify-center gap-3 bg-white p-6 text-center dark:bg-dark-900">
        <h1 className="text-base font-semibold text-gray-900 dark:text-gray-100">
          Something went wrong
        </h1>
        <p className="text-xs leading-relaxed text-gray-500 dark:text-gray-400">
          Your accounts are still saved on this device. Reload to try again, or save a copy
          of them to a file first.
        </p>
        <div className="flex w-full max-w-[220px] flex-col gap-2">
          <button
            onClick={() => window.location.reload()}
            className="rounded-lg bg-[#4285F4] py-2 text-sm font-medium text-white transition-colors hover:bg-[#3367D6]"
          >
            Reload
          </button>
          <button
            onClick={this.handleExport}
            className="rounded-lg border border-gray-300 py-2 text-sm font-medium text-gray-700 transition-colors hover:bg-gray-50 dark:border-dark-500 dark:text-gray-300 dark:hover:bg-dark-700"
          >
            Save a copy of my accounts
          </button>
        </div>
        <p className="max-w-[260px] break-words text-[10px] text-gray-400 dark:text-gray-500">
          {this.state.message}
        </p>
      </div>
    );
  }
}
