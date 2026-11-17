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
