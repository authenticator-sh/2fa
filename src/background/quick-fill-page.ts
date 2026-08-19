// The only code this extension ever runs inside a web page.
//
// It is not a content script: nothing is injected until the user picks the
// extension's item out of the right-click menu (or presses its shortcut), and
// what that gesture grants is `activeTab` — one tab, one invocation, revoked
// on navigation. There is no host permission behind it and no listener left
// behind afterwards.
//
// Everything below therefore has to live inside a single self-contained
// function: `chrome.scripting.executeScript({ func })` ships this function by
// its source text, so a reference to anything outside it — a module constant,
// an imported helper — would arrive in the page as an undefined variable.
// Helpers are nested for that reason, not for style.

export type QuickFillOutcome =
  /** The code went into a field on the page. */
  | 'filled'
  /** No field took it; it is on the clipboard instead. */
  | 'copied'
  /** Not even the clipboard was available; the code was shown to be typed. */
  | 'shown'
  /** This frame is not the one the user is typing in — another will answer. */
  | 'skipped';

export interface QuickFillPageArgs {
  /** null means there is nothing to fill and `noticeText` is the whole job. */
  code: string | null;
  /**
   * Set for the keyboard shortcut, which has no frame to aim at and so is
   * injected into all of them: only the frame holding the caret should act.
   * The context menu knows its frame and passes false.
   */
  requireFocus: boolean;
  // Toast copy, already translated — the page has no access to our locales.
  /** Shown when the code went to the clipboard instead of into the field. */
  copiedText: string;
  /** Shown when even the clipboard refused; carries the code to be typed. */
  manualText: string;
  /** Shown when there is no code and the popup has to be opened by hand. */
  noticeText: string;
}

export async function quickFillInPage(args: QuickFillPageArgs): Promise<QuickFillOutcome> {
  const CODE = args.code || '';

  if (args.requireFocus && !document.hasFocus()) return 'skipped';

  const wait = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

  const visible = (el: Element): boolean => {
    if (!(el instanceof HTMLElement)) return false;
    if (el.getClientRects().length === 0) return false;
    const style = getComputedStyle(el);
    return style.visibility !== 'hidden' && style.opacity !== '0';
  };

  const FILLABLE_TYPES = /^(text|tel|number|password|search|email|url)$/;

  const isFillable = (el: Element | null): el is HTMLElement => {
    if (!el || !visible(el)) return false;
    if (el instanceof HTMLInputElement) {
      return !el.disabled && !el.readOnly && FILLABLE_TYPES.test(el.type || 'text');
    }
    if (el instanceof HTMLTextAreaElement) return !el.disabled && !el.readOnly;
    return el instanceof HTMLElement && el.isContentEditable;
  };

  // Right-clicking a field focuses it, so the caret is normally the answer.
  // Shadow roots have their own activeElement and report only their host to
  // the document, so the chain has to be walked to the bottom.
  const focusedElement = (): Element | null => {
    let el: Element | null = document.activeElement;
    while (el && el.shadowRoot && el.shadowRoot.activeElement) el = el.shadowRoot.activeElement;
    return el;
  };

  const OTP_HINT = /(^|[^a-z])(otp|totp|mfa|2fa|twofactor|two_factor|onetime|one_time|authcode|securitycode|verification|verify|passcode|token)([^a-z]|$)/i;

  /**
   * Fields worth filling when the caret is somewhere useless — the page stole
   * focus back, or the shortcut was pressed without clicking the box first.
   *
   * Scored rather than taken in document order: a login page's search box is a
   * fillable text input too, and putting a one-time code into it is worse than
   * doing nothing. Only positive scores are accepted, so "no obvious code
   * field" ends in the clipboard fallback instead of a guess.
   */
  const guessTarget = (): HTMLElement | null => {
    const inputs = Array.from(document.querySelectorAll('input, textarea'));
    let best: HTMLElement | null = null;
    let bestScore = 0;

    for (const el of inputs) {
      if (!isFillable(el)) continue;
      const field = el as HTMLInputElement;
      const haystack = [
        field.getAttribute('autocomplete'),
        field.name,
        field.id,
        field.getAttribute('placeholder'),
        field.getAttribute('aria-label'),
        field.getAttribute('data-testid'),
      ]
        .filter(Boolean)
        .join(' ');

      let score = 0;
      // The standards-blessed marker, and the one the browser's own OTP
      // autofill keys off — worth more than any amount of naming.
      if ((field.getAttribute('autocomplete') || '').includes('one-time-code')) score += 10;
      if (OTP_HINT.test(haystack)) score += 5;
      if (/(^|[^a-z])code([^a-z]|$)/i.test(haystack)) score += 3;
      if (field.maxLength === 1) score += 2;
      if (field.maxLength === CODE.length) score += 2;
      if (field.inputMode === 'numeric' || field.type === 'tel') score += 1;

      if (score > bestScore) {
        best = field;
        bestScore = score;
      }
    }

    return bestScore > 0 ? best : null;
  };

  /**
   * The one-box-per-digit layout, returned in document order.
   *
   * Walking up from the field rather than down from a container: the boxes are
   * siblings in some implementations and each wrapped in its own div in
   * others, and the first ancestor holding more than one of them is the group
   * either way.
   */
  const groupFor = (el: HTMLElement): HTMLInputElement[] | null => {
    if (!(el instanceof HTMLInputElement) || el.maxLength !== 1) return null;

    let container: HTMLElement | null = el.parentElement;
    for (let depth = 0; depth < 5 && container; depth += 1) {
      const boxes = Array.from(container.querySelectorAll('input')).filter(
        (box) => box.maxLength === 1 && !box.disabled && !box.readOnly && visible(box)
      );
      // A group shorter than the code would fill silently and truncate, which
      // looks like success and submits a wrong code. Refuse and let the
      // clipboard fallback take it.
      if (boxes.length >= CODE.length && boxes.indexOf(el) !== -1) return boxes;
      if (boxes.length >= 2 && boxes.length < CODE.length) return null;
      container = container.parentElement;
    }
    return null;
  };

  const readValue = (el: HTMLElement): string =>
    el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement ? el.value : el.textContent || '';

  const normalize = (value: string): string => value.replace(/[^0-9a-zA-Z]/g, '');

  const focus = (el: HTMLElement): void => {
    try {
      el.focus({ preventScroll: true });
    } catch {
      el.focus();
    }
  };

  const selectAll = (el: HTMLElement): void => {
    try {
      if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) el.select();
      else document.getSelection()?.selectAllChildren(el);
    } catch {
      // Some input types refuse selection; insertText then appends, which the
      // verification below catches.
    }
  };

  /**
   * Native insertion.
   *
   * `execCommand('insertText')` goes through the browser's own editing
   * pipeline, so the field sees a real `beforeinput`/`input` pair. That is the
   * difference that matters for a React-controlled input: assigning `.value`
   * updates React's internal value tracker as a side effect, the change looks
   * like one React already knows about, no `onChange` runs, and the next
   * render puts the old value straight back.
   */
  const insertText = (el: HTMLElement, value: string): void => {
    focus(el);
    selectAll(el);
    try {
      document.execCommand('insertText', false, value);
    } catch {
      // Deprecated and refused in a few embedded contexts; the setter below is
      // the fallback and verification decides which of them worked.
    }
  };

  /** Assignment that bypasses React's tracker, plus the events it listens for. */
  const setValue = (el: HTMLElement, value: string): void => {
    focus(el);
    if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
      const setter = Object.getOwnPropertyDescriptor(proto, 'value')?.set;
      if (setter) setter.call(el, value);
      else el.value = value;
    } else {
      el.textContent = value;
    }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, data: value, inputType: 'insertText' }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
  };

  /**
   * A paste carrying the whole code at once.
   *
   * This is the strategy for split fields: every widely used OTP component
   * implements `onPaste` and distributes the digits itself, including moving
   * the caret. One event beats six writes racing that same auto-advance.
   *
   * The event is untrusted, so the browser will not insert anything on its
   * own — this only works where the site handles paste, which is exactly the
   * case it is here for.
   */
  const paste = (el: HTMLElement, value: string): void => {
    focus(el);
    selectAll(el);
    try {
      const data = new DataTransfer();
      data.setData('text/plain', value);
      el.dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
    } catch {
      // No ClipboardEvent constructor here — the other strategies still apply.
    }
  };

  /**
   * Did it actually land?
   *
   * Read back twice with a gap, because a controlled component may only
   * reflect the value once its state update has run.
   *
   * Fields that have left the document are the awkward case, and they mean one
   * of two opposite things: the form submitted itself on the last digit and
   * took its inputs with it — a success that can no longer be read — or the
   * component rebuilt its inputs and discarded the write. Telling them apart
   * is worth the extra look, because guessing either way is expensive: a false
   * success skips the clipboard fallback and leaves the user with nothing,
   * a false failure overwrites the clipboard and puts a toast on a page that
   * is already signing in.
   */
  const landed = async (fields: HTMLElement[]): Promise<boolean> => {
    for (const delay of [20, 120]) {
      await wait(delay);

      const live = fields.filter((field) => field.isConnected);
      if (live.length === fields.length) {
        if (normalize(live.map(readValue).join('')).includes(CODE)) return true;
        continue;
      }

      // Something replaced them. If a code field is still on the page it was a
      // rebuild, and only its contents can say whether the write survived.
      const replacement = guessTarget();
      if (!replacement) return true;
      const group = groupFor(replacement) || [replacement];
      if (normalize(group.map(readValue).join('')).includes(CODE)) return true;
    }
    return false;
  };

  const fill = async (target: HTMLElement): Promise<boolean> => {
    const group = groupFor(target);

    // A field that cannot hold the whole code, and is not part of a group that
    // can. Writing to it anyway would still "work": `maxlength` constrains
    // what a person can type, not what an assignment can set, so the code goes
    // in, reads back correctly, and leaves a one-character box holding six
    // digits with the component's own state disagreeing. Refusing sends it to
    // the clipboard, which is the honest outcome.
    if (!group && target instanceof HTMLInputElement && target.maxLength >= 1 && target.maxLength < CODE.length) {
      return false;
    }

    if (group) {
      paste(group[0], CODE);
      if (await landed(group)) return true;

      // The component ignores paste. Write the digits one box at a time, each
      // through the native pipeline, in document order.
      for (let i = 0; i < CODE.length; i += 1) insertText(group[i], CODE[i]);
      if (await landed(group)) return true;

      for (let i = 0; i < CODE.length; i += 1) setValue(group[i], CODE[i]);
      return landed(group);
    }

    insertText(target, CODE);
    if (await landed([target])) return true;

    setValue(target, CODE);
    if (await landed([target])) return true;

    paste(target, CODE);
    return landed([target]);
  };

  const copy = async (value: string): Promise<boolean> => {
    try {
      await navigator.clipboard.writeText(value);
      return true;
    } catch {
      // Blocked without transient activation, which the menu itself may have
      // consumed. The old path still works from a content script.
    }

    const restore = document.activeElement as HTMLElement | null;
    const scratch = document.createElement('textarea');
    scratch.value = value;
    scratch.setAttribute('aria-hidden', 'true');
    scratch.style.cssText = 'position:fixed;top:0;left:0;width:1px;height:1px;padding:0;border:0;opacity:0';
    document.body.appendChild(scratch);
    try {
      scratch.select();
      return document.execCommand('copy');
    } catch {
      return false;
    } finally {
      scratch.remove();
      if (restore && typeof restore.focus === 'function') restore.focus();
    }
  };

  /**
   * Confirmation, in a closed shadow root.
   *
   * Only ever shown when the fill did not work, so it has to say what happened
   * without the user going looking. The shadow root is for the page's CSS, not
   * for secrecy — everything in it is either our own copy or a code that was
   * on its way into this page's form anyway.
   */
  const toast = (text: string): void => {
    const host = document.createElement('div');
    host.style.cssText = 'all:initial;position:fixed;top:16px;right:16px;z-index:2147483647';
    const root = host.attachShadow({ mode: 'closed' });

    const card = document.createElement('div');
    card.textContent = text;
    card.style.cssText = [
      'font:500 13px/1.4 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif',
      'max-width:280px',
      'padding:10px 14px',
      'border-radius:10px',
      'background:#1f2937',
      'color:#f9fafb',
      'box-shadow:0 6px 24px rgba(0,0,0,.28)',
      'opacity:0',
      'transform:translateY(-6px)',
      'transition:opacity .15s ease,transform .15s ease',
    ].join(';');

    root.appendChild(card);
    document.documentElement.appendChild(host);
    requestAnimationFrame(() => {
      card.style.opacity = '1';
      card.style.transform = 'translateY(0)';
    });
    setTimeout(() => {
      card.style.opacity = '0';
      setTimeout(() => host.remove(), 200);
    }, 3600);
  };

  // Nothing to insert: the caller could not decide which account to use, or
  // could not open its own window to ask. Say so and stop — an empty string
  // run through the fill path would select the field's contents and replace
  // them with nothing.
  if (args.code === null) {
    toast(args.noticeText);
    return 'shown';
  }

  const focused = focusedElement();
  const target = isFillable(focused) ? (focused as HTMLElement) : guessTarget();

  if (target && (await fill(target))) return 'filled';

  if (await copy(CODE)) {
    toast(args.copiedText);
    return 'copied';
  }

  toast(args.manualText);
  return 'shown';
}
