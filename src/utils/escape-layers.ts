// Which open layer Escape belongs to.
//
// Every dialog, full-screen view and menu used to add its own keydown listener
// to `document`, and every one of them heard every Escape. A confirmation over
// the export window closed both at once; a confirmation raised from inside
// Add account closed the confirmation and the screen behind it, throwing away
// what had been typed. Escape now goes to the layer opened last, and only to it.

type Handler = () => void;

interface Layer {
  id: number;
  handler: Handler;
}

const layers: Layer[] = [];
let nextId = 1;
let listening = false;

/**
 * Hand an Escape to the topmost layer. Returns whether one took it.
 *
 * Exported for the tests; the page reaches it through the one document
 * listener below.
 */
export function dispatchEscape(): boolean {
  const top = layers[layers.length - 1];
  if (!top) return false;
  top.handler();
  return true;
}

function onKeyDown(event: KeyboardEvent): void {
  if (event.key !== 'Escape' || event.defaultPrevented) return;
  // The popup closes itself on an Escape nobody handled. Taken by a layer, it
  // must not also take the window with it.
  if (dispatchEscape()) {
    event.preventDefault();
    event.stopPropagation();
  }
}

/**
 * Register a layer on top of the ones already open. Call the returned
 * function when it closes; layers may close in any order.
 */
export function pushEscapeLayer(handler: Handler): () => void {
  const layer: Layer = { id: nextId++, handler };
  layers.push(layer);
  if (!listening && typeof document !== 'undefined') {
    document.addEventListener('keydown', onKeyDown);
    listening = true;
  }
  return () => {
    const at = layers.findIndex(entry => entry.id === layer.id);
    if (at !== -1) layers.splice(at, 1);
  };
}

/** How many layers are open — for the tests. */
export function escapeLayerCount(): number {
  return layers.length;
}
