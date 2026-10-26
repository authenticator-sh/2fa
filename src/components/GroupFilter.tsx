import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { ChevronLeft, ChevronRight, Pencil, Plus, Trash2 } from 'lucide-react';
import { createT, type Language } from '@/utils/i18n';
import { movedBefore, type GroupCount } from '@/utils/list-view';
import { ContextMenu } from './ContextMenu';

export type { GroupCount };

/** What a dragged chip carries, so a drag from anywhere else is not taken for one. */
const CHIP_DRAG = 'application/x-authenticator-group';

interface GroupFilterProps {
  groups: GroupCount[];
  /** How many accounts have no group; the "no group" chip is hidden at 0. */
  ungroupedCount: number;
  totalCount: number;
  /** null — everything; '' — the ungrouped chip; otherwise a group name. */
  active: string | null;
  onChange: (group: string | null) => void;
  /** Right-click on a group's chip. "All" and "No group" are not groups and have no menu. */
  onRename: (group: string) => void;
  onDelete: (group: string) => void;
  /** The "+" at the end of the strip. */
  onCreate: () => void;
  /** The group names in their new order, after a chip was dragged. */
  onReorder: (names: string[]) => void;
  /**
   * An account row is being dragged: the group chips and "No group" take it,
   * and dropping it there moves the account. Null while nothing is.
   */
  onDropAccount: ((group: string) => void) | null;
  language: Language;
}

/**
 * The filter strip above the account list.
 *
 * Every chip carries its count, including "All". Without it a filtered list is
 * indistinguishable from a shrunken one, and on a 2FA app "some of my accounts
 * are missing" is read as data loss long before it is read as a filter.
 */
export function GroupFilter({
  groups,
  ungroupedCount,
  totalCount,
  active,
  onChange,
  onRename,
  onDelete,
  onCreate,
  onReorder,
  onDropAccount,
  language,
}: GroupFilterProps) {
  const t = createT(language);
  const [menu, setMenu] = useState<{ group: string; x: number; y: number; chip: HTMLElement } | null>(null);
  // The chip being dragged, and the chip it is over — a group name, or '' for
  // "No group" when an account is being dropped there.
  const [draggedChip, setDraggedChip] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const scrollerRef = useRef<HTMLDivElement>(null);
  // Whether there are chips out of view towards each end. In logical terms, so
  // an Arabic strip — which starts on the right — gets the same answers.
  const [more, setMore] = useState({ start: false, end: false });

  const measure = useCallback(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const max = scroller.scrollWidth - scroller.clientWidth;
    // Negative in RTL, where the strip scrolls from 0 towards the left.
    const at = Math.abs(scroller.scrollLeft);
    const next = { start: at > 1, end: at < max - 1 };
    setMore(prev => (prev.start === next.start && prev.end === next.end ? prev : next));
  }, []);

  useLayoutEffect(measure, [measure, groups, ungroupedCount, totalCount, language]);

  useEffect(() => {
    const scroller = scrollerRef.current;
    if (!scroller) return;

    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure);
    observer?.observe(scroller);

    // A mouse wheel only scrolls up and down, and a strip that only scrolls
    // sideways ignored it: with more groups than fit, the rest could be reached
    // by a trackpad swipe and by nothing else, and looked as if they were not
    // there. Over the strip the wheel scrolls it. A sideways swipe is left to
    // the browser, which already does it.
    const onWheel = (event: WheelEvent) => {
      if (scroller.scrollWidth <= scroller.clientWidth) return;
      if (Math.abs(event.deltaY) <= Math.abs(event.deltaX)) return;
      event.preventDefault();
      scroller.scrollLeft += isRtl(scroller) ? -event.deltaY : event.deltaY;
    };
    // Not React's onWheel: React listens passively, and preventDefault there is
    // ignored.
    scroller.addEventListener('wheel', onWheel, { passive: false });

    return () => {
      observer?.disconnect();
      scroller.removeEventListener('wheel', onWheel);
    };
  }, [measure]);

  // The chosen group in view — after a click on a chip half off the edge, a
  // rename, or a popup that opens on a filter remembered from last time.
  useEffect(() => {
    scrollerRef.current
      ?.querySelector<HTMLElement>('[aria-pressed="true"]')
      ?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [active]);

  const scrollTowards = (side: 'start' | 'end') => {
    const scroller = scrollerRef.current;
    if (!scroller) return;
    const sign = (side === 'end' ? 1 : -1) * (isRtl(scroller) ? -1 : 1);
    scroller.scrollBy({ left: sign * scroller.clientWidth * 0.7, behavior: 'smooth' });
  };

  const chips: { key: string; label: string; count: number; value: string | null }[] = [
    { key: '__all', label: t('groups.all'), count: totalCount, value: null },
    ...groups.map(g => ({ key: `g:${g.name}`, label: g.name, count: g.count, value: g.name })),
  ];

  if (ungroupedCount > 0) {
    chips.push({ key: '__ungrouped', label: t('groups.ungrouped'), count: ungroupedCount, value: '' });
  }

  const names = groups.map(group => group.name);

  /** Drag-and-drop for one chip: reordering among the groups, or taking an account. */
  const dropProps = (value: string | null) => {
    if (value === null) return {};
    const takesChip = value !== '' && draggedChip !== null && draggedChip !== value;
    const takesAccount = onDropAccount !== null;
    if (!takesChip && !takesAccount) return {};
    return {
      onDragOver: (event: React.DragEvent) => {
        event.preventDefault();
        event.dataTransfer.dropEffect = 'move';
        setDropTarget(value);
      },
      onDragLeave: () => setDropTarget(current => (current === value ? null : current)),
      onDrop: (event: React.DragEvent) => {
        event.preventDefault();
        setDropTarget(null);
        if (takesChip && event.dataTransfer.types.includes(CHIP_DRAG)) {
          const from = names.indexOf(draggedChip);
          const to = names.indexOf(value);
          // Dragged forwards it lands after the chip it was dropped on, and
          // backwards before it — where the pointer let go, either way.
          onReorder(movedBefore(names, draggedChip, from < to ? names[to + 1] ?? null : value));
        } else if (takesAccount) {
          onDropAccount(value);
        }
        setDraggedChip(null);
      },
    };
  };

  return (
    // flex-shrink-0: the strip is a flex child of the fixed-height popup, so
    // without it a long account list squeezes the chips until their text is
    // clipped by their own pill.
    <div
      data-ui="toolbar"
      className="relative flex-shrink-0 bg-white dark:bg-dark-900 border-b border-gray-200 dark:border-dark-700"
    >
      <div
        ref={scrollerRef}
        onScroll={() => {
          measure();
          // A menu pinned to where the chip was would point at another chip
          // once the strip has scrolled under it.
          setMenu(null);
        }}
        // Chips running out under the edge fade rather than being cut through
        // the middle: a cut chip looked like the last one. A mask rather than
        // a gradient drawn over them, because the strip's background differs
        // between the two styles and the two themes.
        style={fadeMask(more, scrollerRef.current)}
        className="flex gap-1.5 overflow-x-auto scrollbar-hide px-4 py-2"
      >
        {chips.map(chip => {
          const isActive = chip.value === active;
          const group = chip.value;
          const isTarget = dropTarget !== null && dropTarget === group;
          return (
            <button
              key={chip.key}
              onClick={() => onChange(chip.value)}
              onContextMenu={
                group
                  ? event => {
                      event.preventDefault();
                      setMenu({ group, x: event.clientX, y: event.clientY, chip: event.currentTarget });
                    }
                  : undefined
              }
              onKeyDown={
                group
                  ? event => {
                      if (event.key !== 'ContextMenu' && !(event.shiftKey && event.key === 'F10')) return;
                      event.preventDefault();
                      const rect = event.currentTarget.getBoundingClientRect();
                      setMenu({ group, x: rect.left, y: rect.bottom + 4, chip: event.currentTarget });
                    }
                  : undefined
              }
              // Only the groups move; "All" and "No group" keep their ends.
              draggable={Boolean(group)}
              onDragStart={
                group
                  ? event => {
                      event.dataTransfer.setData(CHIP_DRAG, group);
                      event.dataTransfer.effectAllowed = 'move';
                      setDraggedChip(group);
                    }
                  : undefined
              }
              onDragEnd={() => {
                setDraggedChip(null);
                setDropTarget(null);
              }}
              {...dropProps(group)}
              aria-pressed={isActive}
              aria-haspopup={group ? 'menu' : undefined}
              className={`flex-shrink-0 max-w-[140px] flex items-center gap-1 text-xs font-medium px-2.5 py-1 rounded-full transition-colors ${
                isActive
                  ? 'bg-accent-600 text-white'
                  : 'bg-gray-100 dark:bg-dark-700 text-gray-600 dark:text-gray-300 hover:bg-gray-200 dark:hover:bg-dark-600'
              } ${isTarget ? 'ring-2 ring-accent-500 ring-offset-1 dark:ring-offset-dark-900' : ''} ${
                group && draggedChip === group ? 'opacity-50' : ''
              }`}
            >
              <span className="truncate">{chip.label}</span>
              <span className={isActive ? 'opacity-70' : 'opacity-50'}>{chip.count}</span>
            </button>
          );
        })}
        <button
          onClick={onCreate}
          aria-label={t('groups.new')}
          title={t('groups.new')}
          className="flex-shrink-0 flex items-center justify-center w-7 rounded-full border border-dashed border-gray-300 dark:border-dark-500 text-gray-500 dark:text-gray-400 hover:border-accent-500 hover:text-accent-600 dark:hover:text-accent-400 transition-colors"
        >
          <Plus size={14} aria-hidden />
        </button>
      </div>

      {/* For a mouse: the wheel works too, but nothing says so. Out of the tab
          order — a keyboard reaches every chip by Tab, and focus scrolls the
          strip by itself. */}
      {more.start && <ScrollButton side="start" onClick={() => scrollTowards('start')} />}
      {more.end && <ScrollButton side="end" onClick={() => scrollTowards('end')} />}

      {menu && (
        <ContextMenu
          x={menu.x}
          y={menu.y}
          items={[
            {
              label: t('groups.rename'),
              icon: Pencil,
              onSelect: () => {
                setMenu(null);
                onRename(menu.group);
              },
            },
            {
              label: t('groups.delete'),
              icon: Trash2,
              danger: true,
              onSelect: () => {
                setMenu(null);
                onDelete(menu.group);
              },
            },
          ]}
          onClose={returnFocus => {
            setMenu(null);
            if (returnFocus) menu.chip.focus();
          }}
        />
      )}
    </div>
  );
}

function isRtl(element: HTMLElement): boolean {
  return getComputedStyle(element).direction === 'rtl';
}

const FADE = '28px';

function fadeMask(more: { start: boolean; end: boolean }, scroller: HTMLElement | null): React.CSSProperties | undefined {
  if (!more.start && !more.end) return undefined;
  const rtl = scroller ? isRtl(scroller) : false;
  const left = rtl ? more.end : more.start;
  const right = rtl ? more.start : more.end;
  const image = `linear-gradient(to right, ${left ? `transparent, black ${FADE}` : 'black'}, ${
    right ? `black calc(100% - ${FADE}), transparent` : 'black'
  })`;
  return { maskImage: image, WebkitMaskImage: image };
}

function ScrollButton({ side, onClick }: { side: 'start' | 'end'; onClick: () => void }) {
  const Icon = side === 'start' ? ChevronLeft : ChevronRight;
  return (
    <button
      tabIndex={-1}
      aria-hidden
      onClick={onClick}
      className={`absolute top-1/2 -translate-y-1/2 ${
        side === 'start' ? 'start-1' : 'end-1'
      } flex h-6 w-6 items-center justify-center rounded-full bg-white text-gray-600 shadow-md ring-1 ring-gray-200 transition-colors hover:bg-gray-50 dark:bg-dark-700 dark:text-gray-200 dark:ring-dark-600 dark:hover:bg-dark-600`}
    >
      <Icon size={14} className="rtl:rotate-180" />
    </button>
  );
}
