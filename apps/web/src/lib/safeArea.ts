/**
 * The screen's safe-area insets in pixels: what the notch, the status bar and
 * the home indicator cover on phones (tokens.css `--safe-*`). For code that
 * places things on the screen itself, such as menus.
 */
export interface Insets {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

let probe: HTMLElement | null = null;

export function safeInsets(): Insets {
  if (!probe || !probe.isConnected) {
    probe = document.createElement('div');
    probe.setAttribute('aria-hidden', 'true');
    probe.style.cssText =
      'position:fixed;top:0;left:0;width:0;height:0;visibility:hidden;pointer-events:none;padding:var(--safe-top) var(--safe-right) var(--safe-bottom) var(--safe-left)';
    document.body.appendChild(probe);
  }
  const style = getComputedStyle(probe);
  const px = (value: string): number => Number.parseFloat(value) || 0;
  return { top: px(style.paddingTop), right: px(style.paddingRight), bottom: px(style.paddingBottom), left: px(style.paddingLeft) };
}
