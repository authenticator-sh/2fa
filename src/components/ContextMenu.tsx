import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Check, type LucideIcon } from 'lucide-react';
import { useEscapeLayer } from '@/hooks/useLayer';

export interface MenuItem {
  label: string;
  icon?: LucideIcon;
  onSelect: () => void;
  danger?: boolean;
  /** A tick in front: the group an account is already in. */
  checked?: boolean;
}

/** A thin rule between items. */
export const SEPARATOR = 'separator' as const;

export type MenuEntry = MenuItem | typeof SEPARATOR;

interface ContextMenuProps {
  /** Where to open, in viewport coordinates — the pointer, or a button's corner. */
  x: number;
  y: number;
  items: MenuEntry[];
  /** Open upwards from `y` — from a button on the bottom bar. */
  above?: boolean;
  /**
   * Called with true when the menu should hand focus back to whatever opened
   * it — Escape — and false when the user has already moved on: a click
   * elsewhere, Tab, the window losing focus.
   */
  onClose: (returnFocus: boolean) => void;
}

/**
 * A menu at the pointer: the group chips' right-click, an account's, and the
 * selection bar's "Move to group".
 *
 * `fixed` rather than positioned inside its owner: the chip strip scrolls
 * sideways and clips anything absolutely positioned inside it, the popup root
 * is overflow-hidden, and a right-click menu is expected where the click was.
 * Moved back inside the window once measured, so a click near an edge of a
 * 360px popup does not open half of it off-screen.
 */
export function ContextMenu({ x, y, items, above = false, onClose }: ContextMenuProps) {
  const ref = useRef<HTMLDivElement>(null);
  const [position, setPosition] = useState({ left: x, top: y });
  const close = useRef(onClose);
  close.current = onClose;

  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu) return;
    const margin = 4;
    // offset*, not getBoundingClientRect: the opening animation scales the
    // menu, and a rect measured mid-scale would place it a few pixels off.
    const width = menu.offsetWidth;
    const height = menu.offsetHeight;
    setPosition({
      left: Math.max(margin, Math.min(x, window.innerWidth - width - margin)),
      top: Math.max(margin, Math.min(above ? y - height - margin : y, window.innerHeight - height - margin)),
    });
    menu.querySelector<HTMLElement>('[role^="menuitem"]')?.focus();
  }, [x, y, above, items.length]);

  useEscapeLayer(() => close.current(true));

  useEffect(() => {
    const outside = (event: Event) => {
      if (!ref.current?.contains(event.target as Node)) close.current(false);
    };
    const away = () => close.current(false);
    // Capture, so a right-click on another chip or row closes this menu before
    // that one opens its own, instead of after.
    document.addEventListener('mousedown', outside, true);
    document.addEventListener('contextmenu', outside, true);
    // The list under a menu opened from a row scrolls; the row moves, the menu
    // would not.
    document.addEventListener('scroll', away, true);
    window.addEventListener('blur', away);
    window.addEventListener('resize', away);
    return () => {
      document.removeEventListener('mousedown', outside, true);
      document.removeEventListener('contextmenu', outside, true);
      document.removeEventListener('scroll', away, true);
      window.removeEventListener('blur', away);
      window.removeEventListener('resize', away);
    };
  }, []);

  // Up and Down move between the items, Tab leaves — the keys a menu has.
  const onKeyDown = (event: React.KeyboardEvent) => {
    if (event.key === 'Tab') {
      onClose(false);
      return;
    }
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const entries = [...(ref.current?.querySelectorAll<HTMLElement>('[role^="menuitem"]') ?? [])];
    const at = entries.indexOf(document.activeElement as HTMLElement);
    const step = event.key === 'ArrowDown' ? 1 : -1;
    entries[(at + step + entries.length) % entries.length]?.focus();
  };

  const anyChecked = items.some(item => item !== SEPARATOR && item.checked !== undefined);

  return (
    <div
      ref={ref}
      role="menu"
      onKeyDown={onKeyDown}
      // Not passed up: a right-click inside the menu must not reach a row
      // under it and open that row's menu instead.
      onContextMenu={event => event.preventDefault()}
      style={{ left: position.left, top: position.top }}
      className={`fixed z-[60] min-w-[170px] max-w-[260px] max-h-[min(360px,80vh)] overflow-y-auto py-1 bg-white dark:bg-dark-800 rounded-lg shadow-lg border border-gray-200 dark:border-dark-600 ${above ? 'anim-menu-up' : 'anim-menu'}`}
    >
      {items.map((item, index) => {
        if (item === SEPARATOR) {
          return <div key={`sep-${index}`} role="separator" className="my-1 h-px bg-gray-200 dark:bg-dark-600" />;
        }
        const Icon = item.icon;
        return (
          <button
            key={`${index}-${item.label}`}
            role={item.checked !== undefined ? 'menuitemradio' : 'menuitem'}
            aria-checked={item.checked}
            onClick={item.onSelect}
            className={`w-full px-3 py-2 text-start text-sm flex items-center gap-2 transition-colors focus:outline-none ${
              item.danger
                ? 'text-red-600 dark:text-red-400 hover:bg-red-50 focus:bg-red-50 dark:hover:bg-red-900/20 dark:focus:bg-red-900/20'
                : 'text-gray-700 dark:text-gray-200 hover:bg-gray-100 focus:bg-gray-100 dark:hover:bg-dark-700 dark:focus:bg-dark-700'
            }`}
          >
            {anyChecked && (
              <span className="w-3.5 flex-shrink-0" aria-hidden>
                {item.checked && <Check size={14} />}
              </span>
            )}
            {Icon && <Icon aria-hidden size={14} className="flex-shrink-0" />}
            <span className="min-w-0 truncate">{item.label}</span>
          </button>
        );
      })}
    </div>
  );
}
