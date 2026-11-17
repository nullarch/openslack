import { useEffect, useRef, type RefObject } from 'react';

/**
 * Roving tabindex (WAI-ARIA Authoring Practices): a group of items is one stop
 * in the tab order, and the arrow keys move between its items.
 */
export interface RovingOptions {
  /** The items taking part, as a selector inside the container. */
  items: string;
  /** The item that holds the tab stop while focus is elsewhere (the selected tab, the open channel). */
  current?: string;
  /** Without a current item, the stop starts on the first item or the last (the newest message). */
  start?: 'first' | 'last';
  /** Up/Down, Left/Right, or both. */
  orientation?: 'vertical' | 'horizontal' | 'both';
  /** Moving past the end comes back at the start. */
  wrap?: boolean;
  /** Clicking the item focus moves to (tabs that show their panel as they are reached). */
  activate?: boolean;
  /**
   * Controls that belong to an item's row (its "more" button): out of the tab
   * order, reached with Right from the item and left again with Left. `row`
   * names the element holding an item and its controls.
   */
  extras?: string;
  row?: string;
  /**
   * Items with controls of their own (a message's reactions, links, author):
   * only the item holding the stop keeps them in the tab order, so Tab goes
   * through one item's controls rather than every item's.
   */
  inner?: boolean;
}

const CONTROLS = 'a[href], button, input, select, textarea, [contenteditable="true"], audio[controls], video[controls]';

const visible = (element: HTMLElement): boolean => element.getClientRects().length > 0;

export function useRoving(ref: RefObject<HTMLElement>, options: RovingOptions): void {
  const { items, current, start = 'first', orientation = 'vertical', wrap = false, activate = false, extras, row, inner = false } = options;
  useEffect(() => {
    const root = ref.current;
    if (!root) return;
    let last: HTMLElement | null = null;
    const list = (): HTMLElement[] => [...root.querySelectorAll<HTMLElement>(items)].filter(visible);

    const apply = (): void => {
      const all = list();
      if (all.length === 0) return;
      const focused = document.activeElement instanceof HTMLElement ? document.activeElement.closest<HTMLElement>(items) : null;
      const inside = focused && all.includes(focused) ? focused : null;
      const chosen = current ? all.find((item) => item.matches(current)) : undefined;
      const remembered = last && all.includes(last) ? last : null;
      const stop = inside ?? chosen ?? remembered ?? (start === 'last' ? all[all.length - 1] : all[0]);
      for (const item of all) {
        const want = item === stop ? '0' : '-1';
        if (item.getAttribute('tabindex') !== want) item.setAttribute('tabindex', want);
      }
      if (extras) for (const extra of root.querySelectorAll<HTMLElement>(extras)) if (extra.getAttribute('tabindex') !== '-1') extra.setAttribute('tabindex', '-1');
      if (inner) {
        for (const item of all) {
          for (const control of item.querySelectorAll<HTMLElement>(CONTROLS)) {
            // Only controls without a tabindex of their own are taken out, and marked so they can be put back.
            if (item !== stop && !control.hasAttribute('tabindex')) {
              control.setAttribute('tabindex', '-1');
              control.dataset.rovingInner = '';
            } else if (item === stop && control.dataset.rovingInner !== undefined) {
              control.removeAttribute('tabindex');
              delete control.dataset.rovingInner;
            }
          }
        }
      }
    };

    /** Right and Left between an item and the controls on its row. */
    const sideways = (event: KeyboardEvent, target: HTMLElement): boolean => {
      if (!extras || !row || (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft')) return false;
      const line = target.closest<HTMLElement>(row);
      if (!line) return false;
      const item = line.matches(items) ? line : line.querySelector<HTMLElement>(items);
      const controls = [...line.querySelectorAll<HTMLElement>(extras)];
      const stops = [item, ...controls].filter((element): element is HTMLElement => element !== null);
      const index = stops.indexOf(target);
      if (index < 0) return false;
      const next = stops[index + (event.key === 'ArrowRight' ? 1 : -1)];
      if (!next) return false;
      event.preventDefault();
      // A control hidden until hover or focus is shown by its own :focus-visible rule.
      next.focus();
      return true;
    };

    const onFocusIn = (event: FocusEvent): void => {
      const item = (event.target as HTMLElement).closest<HTMLElement>(items);
      if (!item || !root.contains(item)) return;
      last = item;
      apply();
    };

    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.defaultPrevented || event.altKey || event.ctrlKey || event.metaKey || event.shiftKey) return;
      const target = event.target as HTMLElement;
      if (sideways(event, target)) return;
      if (extras && row && target.matches(extras) && (event.key === 'ArrowUp' || event.key === 'ArrowDown')) {
        // From a row's control, Up and Down carry on from the row's item.
        const line = target.closest<HTMLElement>(row);
        const item = line?.matches(items) ? line : line?.querySelector<HTMLElement>(items);
        const all = list();
        const index = item ? all.indexOf(item) : -1;
        const next = all[index + (event.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          event.preventDefault();
          next.focus();
          next.scrollIntoView({ block: 'nearest' });
        }
        return;
      }
      // Only when an item itself has focus: arrow keys inside a field or a control within an item keep their meaning.
      if (!target.matches(items)) return;
      const all = list();
      const index = all.indexOf(target);
      if (index < 0) return;
      const back = orientation === 'horizontal' ? ['ArrowLeft'] : orientation === 'vertical' ? ['ArrowUp'] : ['ArrowUp', 'ArrowLeft'];
      const forward = orientation === 'horizontal' ? ['ArrowRight'] : orientation === 'vertical' ? ['ArrowDown'] : ['ArrowDown', 'ArrowRight'];
      let next: number;
      if (back.includes(event.key)) next = index - 1;
      else if (forward.includes(event.key)) next = index + 1;
      else if (event.key === 'Home') next = 0;
      else if (event.key === 'End') next = all.length - 1;
      else return;
      if (wrap) next = (next + all.length) % all.length;
      else next = Math.max(0, Math.min(all.length - 1, next));
      event.preventDefault();
      const item = all[next]!;
      item.focus();
      item.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      if (activate && item !== target) item.click();
    };

    // Once focus has left, the stop goes back to the current item.
    const onFocusOut = (): void => void window.setTimeout(apply, 0);

    apply();
    const observer = new MutationObserver(apply);
    observer.observe(root, { childList: true, subtree: true, attributes: true, attributeFilter: ['aria-selected', 'aria-current', 'hidden'] });
    root.addEventListener('focusin', onFocusIn);
    root.addEventListener('focusout', onFocusOut);
    root.addEventListener('keydown', onKeyDown);
    return () => {
      observer.disconnect();
      root.removeEventListener('focusin', onFocusIn);
      root.removeEventListener('focusout', onFocusOut);
      root.removeEventListener('keydown', onKeyDown);
    };
  }, [ref, items, current, start, orientation, wrap, activate, extras, row, inner]);
}

/** Move focus into a container: to the item holding its tab stop, or the container itself. */
export function focusInto(container: HTMLElement | null): void {
  if (!container) return;
  const stop = container.querySelector<HTMLElement>('[tabindex="0"]');
  if (stop) stop.focus();
  else {
    if (!container.hasAttribute('tabindex')) container.setAttribute('tabindex', '-1');
    container.focus();
  }
}

/** A tablist: one Tab stop on the selected tab; Left, Right, Home and End move and select. */
export function useTabList<T extends HTMLElement = HTMLDivElement>(): RefObject<T> {
  const ref = useRef<T>(null);
  useRoving(ref, { items: '[role="tab"]:not([disabled])', current: '[role="tab"][aria-selected="true"]', orientation: 'horizontal', wrap: true, activate: true });
  return ref;
}
