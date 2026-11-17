/** Has the person asked for less motion? Scrolling and similar effects done in code check this. */
export function reducedMotion(): boolean {
  return typeof window !== 'undefined' && window.matchMedia?.('(prefers-reduced-motion: reduce)').matches === true;
}

/**
 * Whether the person is using the keyboard or a pointer right now, kept on the
 * root element (`data-input`) so styles can show what keyboard users need
 * (a message's toolbar while focus is in it) without waiting for a render.
 */
export function trackInputMode(): void {
  const root = document.documentElement;
  const set = (mode: 'keyboard' | 'pointer'): void => {
    if (root.dataset.input !== mode) root.dataset.input = mode;
  };
  window.addEventListener('keydown', (event) => {
    if (event.key !== 'Shift' && event.key !== 'Control' && event.key !== 'Alt' && event.key !== 'Meta') set('keyboard');
  }, true);
  window.addEventListener('pointerdown', () => set('pointer'), true);
}

/**
 * The app scrolls inside its panes; the page itself never should. iOS scrolls
 * the whole page to keep a focused field above the keyboard and does not
 * always scroll it back (after signing in, the form it scrolled for is gone),
 * which left the app under the status bar. Put the page back when the
 * workspace appears, and when editing ends with nothing left to type in.
 */
export function keepPageInPlace(onPhase: (listener: () => void) => void): void {
  const reset = (): void => {
    if (window.scrollX !== 0 || window.scrollY !== 0) window.scrollTo(0, 0);
  };
  const editing = (): boolean => {
    const active = document.activeElement as HTMLElement | null;
    return !!active && (active.isContentEditable || active.tagName === 'INPUT' || active.tagName === 'TEXTAREA' || active.tagName === 'SELECT');
  };
  document.addEventListener('focusout', () => {
    window.setTimeout(() => {
      if (!editing()) reset();
    }, 150);
  });
  onPhase(() => {
    // The form that had the keyboard is gone: let the keyboard go too, then put the page back.
    const active = document.activeElement as HTMLElement | null;
    if (active && active !== document.body && !document.body.contains(active)) active.blur();
    if (active && (active.tagName === 'INPUT' || active.tagName === 'TEXTAREA')) active.blur();
    window.setTimeout(reset, 0);
    window.setTimeout(reset, 400);
  });
}
