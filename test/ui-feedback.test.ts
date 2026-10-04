// Toasts, dialogs, Escape and the order of the list.
//
// Each of these was a report or an audit finding: a delete that could not be
// taken back, a 150-character toast gone in three and a half seconds, a
// confirmation whose promise was never answered once another dialog replaced
// it, one Escape closing two layers at once, forty rows with no way to sort
// them. The React around them is thin; the rules are here.

import { check, scenario } from './harness';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function run(): Promise<void> {
  const feedback = await import('@/utils/ui-feedback');
  const layers = await import('@/utils/escape-layers');
  const list = await import('@/utils/list-view');
  const { settingsFromChanges } = await import('@/utils/settings-watch');

  scenario('A toast stays up long enough to be read');
  {
    const { toastDuration } = feedback;
    const short = toastDuration('success', 'Copied');
    const long = toastDuration(
      'info',
      'Saved 12 accounts. 2 Steam Guard accounts were left out — this format cannot describe them. Use the JSON or text export for those.'
    );
    check('a short confirmation is brief', short >= 3_500 && short <= 5_000, String(short));
    check('a long one grows with its text', long > 7_000, String(long));
    check('an error outlasts a success of the same length', toastDuration('error', 'Failed') > toastDuration('success', 'Failed'));
    check('a toast with a button outlasts both — the pointer has to get there', toastDuration('success', 'Deleted', true) >= 10_000);
    check('and nothing stays forever', toastDuration('error', 'x'.repeat(5_000)) <= 20_000);
  }

  scenario('A toast carries its action, and pausing stops its clock');
  {
    let ran = 0;
    const id = feedback.toast('success', 'Account deleted', {
      action: { label: 'Undo', run: () => ran++ },
      durationMs: 60,
    });
    const shown = feedback.getState().toasts.find(t => t.id === id);
    check('the action is on the toast', shown?.action?.label === 'Undo');
    shown?.action?.run();
    check('and runs what it was given', ran === 1);

    feedback.pauseToasts();
    await sleep(120);
    check('paused, it outlives its duration', feedback.getState().toasts.some(t => t.id === id));
    feedback.resumeToasts();
    check('resumed, it is still there for a moment', feedback.getState().toasts.some(t => t.id === id));
    feedback.dismissToast(id);
    check('dismissed, it is gone', !feedback.getState().toasts.some(t => t.id === id));

    // Paused by a hover, then clicked away: no mouseleave ever comes.
    const hovered = feedback.toast('info', 'hovered', { durationMs: 20 });
    feedback.pauseToasts();
    feedback.dismissToast(hovered);
    const quick = feedback.toast('info', 'x', { durationMs: 20 });
    await sleep(80);
    check('a toast after one dismissed mid-hover still goes by itself', !feedback.getState().toasts.some(t => t.id === quick));
  }

  scenario('A dialog replaced by another is answered, not left hanging');
  {
    const first = feedback.confirmDialog({ title: 'Delete?', confirmLabel: 'Delete', cancelLabel: 'Cancel' });
    const second = feedback.promptDialog({ title: 'Password', confirmLabel: 'OK', cancelLabel: 'Cancel' });
    const firstAnswer = await Promise.race([first, sleep(50).then(() => 'still waiting')]);
    check('the first resolves as a cancel', firstAnswer === false, String(firstAnswer));
    const open = feedback.getState().dialog;
    check('the second is the one on screen', open?.kind === 'prompt' && open.title === 'Password');

    // An answer from the replaced one — a stale click — must not close the new one.
    const third = feedback.confirmDialog({ title: 'Third', confirmLabel: 'Yes', cancelLabel: 'No' });
    const secondAnswer = await second;
    check('replacing a prompt answers it with null', secondAnswer === null);
    const replaced = open!;
    if (replaced.kind === 'prompt') replaced.resolve('late');
    check('a late answer from a replaced dialog leaves the current one open', feedback.getState().dialog?.title === 'Third');
    const current = feedback.getState().dialog!;
    if (current.kind === 'confirm') current.resolve(true);
    check('the current one still answers normally', (await third) === true);
    check('and the slot is empty afterwards', feedback.getState().dialog === null);
  }

  scenario('Escape closes the topmost layer only');
  {
    const closed: string[] = [];
    const popExport = layers.pushEscapeLayer(() => closed.push('export'));
    const popConfirm = layers.pushEscapeLayer(() => closed.push('confirm'));
    check('a layer takes it', layers.dispatchEscape() === true);
    check('the confirmation over the export window closes, the window does not', closed.join() === 'confirm');
    popConfirm();
    layers.dispatchEscape();
    check('the next Escape reaches the window', closed.join() === 'confirm,export');
    popExport();
    check('with nothing open, Escape is left to the browser', layers.dispatchEscape() === false);

    // Layers close in any order: a view under a dialog can go first.
    const popA = layers.pushEscapeLayer(() => closed.push('a'));
    const popB = layers.pushEscapeLayer(() => closed.push('b'));
    popA();
    layers.dispatchEscape();
    check('removing a lower layer leaves the top one in charge', closed[closed.length - 1] === 'b');
    popB();
    check('and nothing is left behind', layers.escapeLayerCount() === 0);
  }

  scenario('Search finds an account by its group');
  {
    const account = { name: 'me@corp.com', issuer: 'Okta', group: 'Work' };
    check('by group', list.matchesSearch(account, 'work'));
    check('still by name and service', list.matchesSearch(account, 'corp') && list.matchesSearch(account, 'OKTA'));
    check('a group that is not a string does not throw', !list.matchesSearch({ name: 'a', issuer: 'b', group: 7 as any }, 'zzz'));
  }

  scenario('The list can be sorted, and sorting never rewrites the manual order');
  {
    const accounts = [
      { id: '1', name: 'zed@x', issuer: 'github' },
      { id: '2', name: 'amy@x', issuer: 'Äpfel' },
      { id: '3', name: 'bob@x', issuer: 'GitHub' },
      { id: '4', name: 'Server 10', issuer: '' },
      { id: '5', name: 'Server 2', issuer: '' },
    ];
    const ids = (rows: { id: string }[]) => rows.map(row => row.id).join(',');
    check('manual is the order it was given', ids(list.sortAccounts(accounts, 'manual', 'en')) === '1,2,3,4,5');
    check(
      'by service: collated, case-blind, and an empty service sorts by the name',
      ids(list.sortAccounts(accounts, 'service', 'de')) === '2,3,1,5,4',
      ids(list.sortAccounts(accounts, 'service', 'de'))
    );
    check('by name, numbers in their numeric order', ids(list.sortAccounts(accounts, 'name', 'en')) === '2,3,5,4,1', ids(list.sortAccounts(accounts, 'name', 'en')));
    check('the input is left as it was', ids(accounts) === '1,2,3,4,5');
    check('an unknown stored value is manual', list.readSortOrder('by-colour') === 'manual' && list.readSortOrder(undefined) === 'manual');
    check('a known one is kept', list.readSortOrder('name') === 'name');
    const patch = settingsFromChanges({ sortOrder: { newValue: 'service' } }, 'local');
    check('a change in another window is followed', patch.sortOrder === 'service');
  }

  scenario('An undone delete goes back where it was');
  {
    check(
      'after the nearest account that stood before it',
      list.restoredOrder(['a', 'b', 'd', 'x'], 'x', ['a', 'b', 'x', 'd'])?.join() === 'a,b,x,d'
    );
    check(
      'past a neighbour deleted meanwhile, to the next one up',
      list.restoredOrder(['a', 'd', 'x'], 'x', ['a', 'b', 'x', 'd'])?.join() === 'a,x,d'
    );
    check('first stays first', list.restoredOrder(['b', 'c', 'a'], 'a', ['a', 'b', 'c'])?.join() === 'a,b,c');
    check('already in place: nothing to write', list.restoredOrder(['a', 'b', 'c'], 'c', ['a', 'b', 'c']) === null);
    check('not in the list at all: nothing to write', list.restoredOrder(['a', 'b'], 'x', ['x', 'a', 'b']) === null);
  }

  scenario('What the page puts in front of a screen reader');
  {
    const React = await import('react');
    const { renderToStaticMarkup } = await import('react-dom/server');
    const { FeedbackHost } = await import('@/components/FeedbackHost');
    const { SegmentedControl } = await import('@/components/SegmentedControl');

    const host = renderToStaticMarkup(React.createElement(FeedbackHost));
    check('the polite live region is there before any toast', /role="status"[^>]*aria-live="polite"/.test(host), host);
    check('and so is the urgent one', /role="alert"[^>]*aria-live="assertive"/.test(host));

    const segmented = renderToStaticMarkup(
      React.createElement(SegmentedControl<'a' | 'b'>, {
        label: 'Order',
        value: 'b',
        options: [
          ['a', 'Manual'],
          ['b', 'Name'],
        ],
        onChange: () => {},
      })
    );
    check('a segmented switch is a named group', /role="group" aria-label="Order"/.test(segmented));
    check('and says which segment is on', /aria-pressed="false"[^>]*>Manual/.test(segmented) && /aria-pressed="true"[^>]*>Name/.test(segmented), segmented);
  }
}
