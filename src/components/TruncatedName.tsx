import { useRef, useState } from 'react';

/**
 * The account name, with the whole of it a hover away.
 *
 * A tooltip of our own rather than the browser's `title`, for two reasons: the
 * native one waits about a second before appearing, which is useless when the
 * point is to glance down a list and tell two rows apart, and it cannot be
 * styled to match anything.
 *
 * The reason `title` was chosen first is real and had to be solved rather than
 * ignored: the popup root is `overflow-hidden`, so an absolutely positioned
 * tooltip is clipped on exactly the bottom rows where the list is longest.
 * `position: fixed` is measured against the viewport instead, and an ancestor's
 * `overflow` does not clip it — as long as no ancestor establishes a containing
 * block with `transform`, `filter` or `will-change`. None does; if one ever
 * appears above this component, the tooltip will start being cut off, and that
 * is the thing to look at.
 */
export function TruncatedName({ label, className }: { label: string; className: string }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [at, setAt] = useState<{ top?: number; bottom?: number } | null>(null);

  const show = () => {
    const el = ref.current;
    if (!el) return;
    // Nothing is hidden, so there is nothing to reveal. Measured on hover
    // rather than watched: one measurement when the pointer arrives costs
    // nothing, a ResizeObserver per row costs it forty-five times over.
    if (el.scrollWidth <= el.clientWidth) return;

    const rect = el.getBoundingClientRect();
    // Above the row by preference — that is where the pointer is not. Below
    // only when the row is near the top and there is no room.
    setAt(
      rect.top > 56
        ? { bottom: window.innerHeight - rect.top + 6 }
        : { top: rect.bottom + 6 }
    );
  };

  return (
    <>
      <span ref={ref} className={className} onMouseEnter={show} onMouseLeave={() => setAt(null)}>
        {label}
      </span>
      {at && (
        // Pinned to both edges rather than centred on the row: the popup is
        // 320px at its narrowest, so a tooltip that measured itself against the
        // text would spend the whole width anyway and could still overhang.
        <span
          role="tooltip"
          style={{ position: 'fixed', insetInline: 8, ...at }}
          // A card, like every other floating surface here, not a toast. A toast
          // is a notification and is meant to interrupt; this only finishes a
          // sentence the row had already started, and a dark slab in a light
          // popup reads as an alert about it.
          className="pointer-events-none z-[70] block rounded-lg border border-gray-200 bg-white px-2.5 py-1.5 text-xs leading-snug text-gray-900 shadow-lg [overflow-wrap:anywhere] dark:border-dark-600 dark:bg-dark-800 dark:text-gray-100"
        >
          {label}
        </span>
      )}
    </>
  );
}
