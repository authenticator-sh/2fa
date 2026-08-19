import { check, scenario } from './harness';
import { clipboard, installDom, input, uninstallDom, FakeElement, FakeInput } from './fake-dom';
import { quickFillInPage, type QuickFillPageArgs } from '@/background/quick-fill-page';

const CODE = '123456';

const ARGS: QuickFillPageArgs = {
  code: CODE,
  requireFocus: false,
  copiedText: 'Code copied',
  manualText: `Your code: ${CODE}`,
  noticeText: 'Open the extension',
};

/**
 * Run the function the way Chrome does.
 *
 * `executeScript` ships a function by its source text, so anything it closes
 * over is simply absent in the page. Rebuilding it from `toString()` in an
 * otherwise empty scope is what proves it closes over nothing — a reference to
 * a module constant or a bundled helper fails here exactly as it would on a
 * real site.
 *
 * The one thing handed in is `__name`, which esbuild wraps around every arrow
 * function when it transpiles for this test runner, purely to keep names in
 * stack traces. `vite build` does not emit it — the shipped service worker has
 * no such helper in it — so shimming it here removes a property of the test
 * runner rather than papering over one of the code.
 */
const runDetached = (args: QuickFillPageArgs): Promise<string> => {
  const rebuilt = new Function('__name', `return (${quickFillInPage.toString()})`)(
    <T,>(fn: T) => fn
  );
  return rebuilt(args);
};

/** A group of one-character boxes, as split code fields are built. */
function boxes(parent: FakeElement, count: number): FakeInput[] {
  return Array.from({ length: count }, () =>
    input({ parent, maxLength: 1, inputMode: 'numeric' })
  );
}

export async function run(): Promise<void> {
  const doc = installDom();

  scenario('Inserting into an ordinary field');

  const single = input({ parent: doc.body, name: 'otp', maxLength: 6 });
  single.focus();
  check('the focused field is filled', (await runDetached(ARGS)) === 'filled');
  check('and holds the code', single.value === CODE);
  single.remove();

  scenario('Inserting into one box per digit');

  // A component that only implements onPaste — the common shape, and the one
  // that per-box writing races with.
  const pasteOnly = doc.body.appendChild(new FakeElement());
  const pasteBoxes = boxes(pasteOnly, 6);
  for (const box of pasteBoxes) box.refusesExecCommand = true;
  pasteOnly.addEventListener('paste', (event: any) => {
    const text = event.clipboardData.getData('text/plain');
    pasteBoxes.forEach((box, i) => { box.value = text[i] || ''; });
  });
  pasteBoxes[0].focus();
  check('a paste-handling group takes the whole code', (await runDetached(ARGS)) === 'filled');
  check('one digit per box, in order', pasteBoxes.map(b => b.value).join('') === CODE);
  pasteOnly.remove();

  const typedOnly = doc.body.appendChild(new FakeElement());
  const typedBoxes = boxes(typedOnly, 6);
  typedBoxes[0].focus();
  check('a group that ignores paste is written box by box', (await runDetached(ARGS)) === 'filled');
  check('and each box holds its own digit', typedBoxes.map(b => b.value).join('') === CODE);
  typedOnly.remove();

  // Six boxes cannot hold an eight-digit code. Filling them would truncate it
  // into something that looks right and can never be valid.
  const shortGroup = doc.body.appendChild(new FakeElement());
  const shortBoxes = boxes(shortGroup, 6);
  shortBoxes[0].focus();
  const eight = await runDetached({ ...ARGS, code: '12345678' });
  check('a group too short for the code is refused', eight === 'copied');
  check('nothing was truncated into it', shortBoxes.every(box => box.value === ''));
  shortGroup.remove();

  scenario('Fields that will not take a code');

  const stubborn = input({ parent: doc.body, name: 'otp', refusesExecCommand: true });
  // Assignment through the prototype setter is undone, the way a controlled
  // component discards a write it did not make itself.
  Object.defineProperty(stubborn, 'value', { get: () => '', set: () => {}, configurable: true });
  stubborn.focus();
  check('the code goes to the clipboard instead', (await runDetached(ARGS)) === 'copied');
  check('and the clipboard has it', clipboard.text === CODE);
  stubborn.remove();

  clipboard.text = '';
  doc.copyFails = true;
  const alsoStubborn = input({ parent: doc.body, name: 'otp', refusesExecCommand: true });
  Object.defineProperty(alsoStubborn, 'value', { get: () => '', set: () => {}, configurable: true });
  alsoStubborn.focus();
  check('with no clipboard either, the code is shown', (await runDetached(ARGS)) === 'shown');
  check('and nothing was silently swallowed', clipboard.text === '');
  alsoStubborn.remove();
  doc.copyFails = false;

  scenario('Nothing to fill');

  doc.activeElement = null;
  check('an unmatched page still gets the code', (await runDetached(ARGS)) === 'copied');
  check('on the clipboard', clipboard.text === CODE);

  clipboard.text = '';
  const notice = await runDetached({ ...ARGS, code: null });
  check('with no code at all, only the notice is shown', notice === 'shown');
  check('and nothing is written anywhere', clipboard.text === '');

  scenario('Fields that are torn down as they are filled');

  // The last digit submits the form and the inputs go with it. There is
  // nothing left to read the code back from, and copying it to the clipboard
  // on top of a sign-in that already worked is the wrong answer.
  const submitting = input({ parent: doc.body, name: 'otp', maxLength: 6 });
  submitting.addEventListener('input', () => submitting.remove());
  submitting.focus();
  clipboard.text = '';
  check('a form that submits itself counts as filled', (await runDetached(ARGS)) === 'filled');
  check('and the clipboard is left alone', clipboard.text === '');

  // The same disappearance, with the opposite meaning: the component threw the
  // write away and rebuilt its input empty.
  const rebuilding = input({ parent: doc.body, name: 'otp', maxLength: 6 });
  rebuilding.addEventListener('input', () => {
    rebuilding.remove();
    input({ parent: doc.body, name: 'otp', maxLength: 6 });
  });
  rebuilding.focus();
  check('a field that rebuilds itself empty does not', (await runDetached(ARGS)) === 'copied');
  check('so the code is on the clipboard', clipboard.text === CODE);
  for (const leftover of doc.body.querySelectorAll('input')) leftover.remove();

  scenario('The keyboard shortcut, in a frame that is not being typed in');

  const elsewhere = input({ parent: doc.body, name: 'otp', maxLength: 6 });
  doc.focused = false;
  check('the frame stands aside', (await runDetached({ ...ARGS, requireFocus: true })) === 'skipped');
  check('and touches nothing', elsewhere.value === '');
  doc.focused = true;
  elsewhere.remove();

  scenario('Which field is chosen');

  const search = input({ parent: doc.body, name: 'q', id: 'search' });
  const codeField = input({ parent: doc.body, name: 'verification_code' });
  doc.activeElement = null;
  check('a code field is preferred over a search box', (await runDetached(ARGS)) === 'filled');
  check('the code field has it', codeField.value === CODE);
  check('the search box was left alone', search.value === '');
  search.remove();
  codeField.remove();

  // The menu item appears on any text field, including pages with no code
  // field at all. Guessing one there would put a one-time code into a comment
  // box or a public search.
  const onlySearch = input({ parent: doc.body, name: 'q', id: 'search' });
  doc.activeElement = null;
  clipboard.text = '';
  check('an unrelated field is never guessed at', (await runDetached(ARGS)) === 'copied');
  check('it stays empty', onlySearch.value === '');
  onlySearch.remove();

  uninstallDom();
}
