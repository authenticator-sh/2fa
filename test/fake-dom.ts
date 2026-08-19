// A DOM small enough to reason about, for the one piece of this extension that
// runs inside somebody else's page.
//
// Not a general-purpose emulation: it implements exactly the surface
// quick-fill-page.ts touches, and it implements the parts that decide the
// outcome — maxlength truncation, a selection that insertText replaces,
// listeners that fire on the element and its ancestors — faithfully enough
// that the strategies fail here for the same reasons they fail on a real site.

type Listener = (event: any) => void;

class FakeElement {
  tagName = 'DIV';
  children: FakeElement[] = [];
  parentElement: FakeElement | null = null;
  attributes: Record<string, string> = {};
  listeners: Record<string, Listener[]> = {};
  isConnected = true;
  isContentEditable = false;
  textContent = '';
  style: Record<string, string> = { cssText: '' };
  /** Set by a test to make a field refuse the browser's own editing command. */
  refusesExecCommand = false;
  /** Set by a test to hide a field from the visibility check. */
  hidden = false;

  appendChild(child: FakeElement): FakeElement {
    child.parentElement = this;
    child.isConnected = true;
    this.children.push(child);
    return child;
  }

  remove(): void {
    if (this.parentElement) {
      this.parentElement.children = this.parentElement.children.filter(c => c !== this);
      this.parentElement = null;
    }
    this.isConnected = false;
  }

  getAttribute(name: string): string | null {
    return name in this.attributes ? this.attributes[name] : null;
  }

  setAttribute(name: string, value: string): void {
    this.attributes[name] = value;
  }

  getClientRects(): unknown[] {
    return this.hidden ? [] : [{}];
  }

  focus(): void {
    doc.activeElement = this;
  }

  addEventListener(type: string, listener: Listener): void {
    (this.listeners[type] = this.listeners[type] || []).push(listener);
  }

  dispatchEvent(event: any): boolean {
    event.target = event.target || this;
    let node: FakeElement | null = this;
    while (node) {
      for (const listener of node.listeners[event.type] || []) listener(event);
      node = event.bubbles ? node.parentElement : null;
    }
    return true;
  }

  attachShadow(): { appendChild(child: FakeElement): FakeElement } {
    const root = new FakeElement();
    this.appendChild(root);
    return root;
  }

  descendants(): FakeElement[] {
    return this.children.flatMap(child => [child, ...child.descendants()]);
  }

  querySelectorAll(selector: string): FakeElement[] {
    const wanted = selector.split(',').map(part => part.trim().toUpperCase());
    return this.descendants().filter(node => wanted.includes(node.tagName));
  }
}

class FakeInput extends FakeElement {
  tagName = 'INPUT';
  type = 'text';
  name = '';
  id = '';
  maxLength = -1;
  disabled = false;
  readOnly = false;
  inputMode = '';
  /** Mirrors a selection, so insertText replaces rather than appends. */
  selected = false;
  protected stored = '';
  /**
   * Declared, never emitted: the accessor below has to live on the prototype
   * and nowhere else. A class field would put an own property in front of it,
   * which is precisely the shape the code under test is written to get around.
   */
  declare value: string;

  select(): void {
    // Selecting focuses, as it does in a browser — which is what makes the
    // element the one a subsequent execCommand acts on.
    this.focus();
    this.selected = true;
  }
}

class FakeTextArea extends FakeInput {
  tagName = 'TEXTAREA';
}

// A real accessor on the prototype, because the code under test deliberately
// reaches for it: assigning through this setter is what a framework's value
// tracker does not see, and is the difference between a fill that sticks and
// one the next render throws away.
for (const cls of [FakeInput, FakeTextArea]) {
  Object.defineProperty(cls.prototype, 'value', {
    get(this: any) {
      return this.stored;
    },
    set(this: any, next: string) {
      this.stored = String(next);
    },
    configurable: true,
  });
}

class FakeDocument extends FakeElement {
  activeElement: FakeElement | null = null;
  documentElement = new FakeElement();
  body = new FakeElement();
  /** Set by a test to make the clipboard's last resort fail too. */
  copyFails = false;
  /** Set by a test to stand for a frame the user is not typing in. */
  focused = true;

  constructor() {
    super();
    this.appendChild(this.documentElement);
    this.documentElement.appendChild(this.body);
  }

  hasFocus(): boolean {
    return this.focused;
  }

  createElement(tag: string): FakeElement {
    if (tag === 'textarea') {
      const el = new FakeTextArea();
      return el;
    }
    return new FakeElement();
  }

  getSelection(): { selectAllChildren(): void } {
    return { selectAllChildren() {} };
  }

  execCommand(command: string, _show?: boolean, text?: string): boolean {
    if (command === 'copy') {
      if (this.copyFails) return false;
      const source = this.activeElement as FakeInput | null;
      clipboard.text = source ? source.value : '';
      return true;
    }

    if (command !== 'insertText') return false;

    const el = this.activeElement as FakeInput | null;
    if (!el || !(el instanceof FakeInput) || el.refusesExecCommand) return false;

    const base = el.selected ? '' : el.value;
    const combined = base + (text || '');
    // Browsers enforce maxlength on input they perform themselves, which is
    // why a six-digit code dropped into a one-character box is one digit.
    el.value = el.maxLength >= 0 ? combined.slice(0, el.maxLength) : combined;
    el.selected = false;
    el.dispatchEvent(new (globalThis as any).InputEvent('input', { bubbles: true, data: text }));
    return true;
  }
}

export const clipboard = { text: '', writeFails: true };

class FakeEvent {
  type: string;
  bubbles: boolean;
  cancelable: boolean;
  target: unknown = null;
  data?: string;
  clipboardData?: unknown;

  constructor(type: string, init: any = {}) {
    this.type = type;
    this.bubbles = !!init.bubbles;
    this.cancelable = !!init.cancelable;
    this.data = init.data;
    this.clipboardData = init.clipboardData;
  }
}

class FakeDataTransfer {
  private data: Record<string, string> = {};
  setData(type: string, value: string): void {
    this.data[type] = value;
  }
  getData(type: string): string {
    return this.data[type] || '';
  }
}

let doc: FakeDocument;

const GLOBALS = [
  'document',
  'HTMLElement',
  'HTMLInputElement',
  'HTMLTextAreaElement',
  'Event',
  'InputEvent',
  'ClipboardEvent',
  'DataTransfer',
  'getComputedStyle',
  'requestAnimationFrame',
  'navigator',
] as const;

// What was there before we took the names over. Node defines several of them
// itself — `Event` most consequentially, since undici dispatches one on every
// aborted fetch — so leaving our versions behind, or deleting the originals,
// breaks suites that run after this one rather than this one.
let saved: Array<[string, PropertyDescriptor | undefined]> = [];

/** Installs the globals the injected function expects, and returns the document. */
export function installDom(): FakeDocument {
  const g = globalThis as any;
  saved = GLOBALS.map(name => [name, Object.getOwnPropertyDescriptor(g, name)]);

  doc = new FakeDocument();
  g.document = doc;
  g.HTMLElement = FakeElement;
  g.HTMLInputElement = FakeInput;
  g.HTMLTextAreaElement = FakeTextArea;
  g.Event = FakeEvent;
  g.InputEvent = FakeEvent;
  g.ClipboardEvent = FakeEvent;
  g.DataTransfer = FakeDataTransfer;
  g.getComputedStyle = () => ({ visibility: 'visible', opacity: '1' });
  g.requestAnimationFrame = (fn: () => void) => setTimeout(fn, 0);
  g.navigator = {
    clipboard: {
      async writeText(value: string) {
        if (clipboard.writeFails) throw new Error('blocked without a user gesture');
        clipboard.text = value;
      },
    },
  };
  clipboard.text = '';
  clipboard.writeFails = true;
  return doc;
}

export function uninstallDom(): void {
  const g = globalThis as any;
  for (const [name, descriptor] of saved) {
    if (descriptor) Object.defineProperty(g, name, descriptor);
    else delete g[name];
  }
  saved = [];
}

export function input(props: Partial<FakeInput> & { parent: FakeElement }): FakeInput {
  const el = new FakeInput();
  Object.assign(el, props);
  props.parent.appendChild(el);
  return el;
}

export { FakeElement, FakeInput, FakeDocument };
