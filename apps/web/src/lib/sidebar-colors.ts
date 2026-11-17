/**
 * Sidebar colors, as plain functions (no DOM), so they can be tested on their own.
 *
 * Presets are one background color each, shown in both light and dark themes;
 * `harbor` is the built-in look and sets nothing. Text colors are never stored:
 * they are derived from the background so every one of them meets 4.5:1
 * contrast, for presets and custom colors alike.
 */

export const SIDEBAR_PRESETS: Record<string, string | null> = {
  harbor: null,
  forest: '#1f3d2c',
  plum: '#3d2140',
  ink: '#1b1c21',
  clay: '#5b3326',
  mist: '#e3ebef',
};

/** The CSS variables a sidebar color sets (the rest of the page keeps its own). */
export const SIDEBAR_VARIABLES = ['--chrome', '--chrome-text', '--chrome-dim', '--chrome-strong', '--chrome-hover', '--chrome-line', '--chrome-field'];

function rgb(hex: string): [number, number, number] {
  const value = hex.replace('#', '');
  const full = value.length === 3 ? value.replace(/./g, (char) => char + char) : value;
  return [0, 2, 4].map((index) => Number.parseInt(full.slice(index, index + 2), 16)) as [number, number, number];
}

function toHex([r, g, b]: [number, number, number]): string {
  return `#${[r, g, b].map((channel) => Math.round(channel).toString(16).padStart(2, '0')).join('')}`;
}

function luminance(color: string): number {
  const [r, g, b] = rgb(color).map((channel) => {
    const value = channel / 255;
    return value <= 0.03928 ? value / 12.92 : ((value + 0.055) / 1.055) ** 2.4;
  }) as [number, number, number];
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
}

/** WCAG contrast ratio between two hex colors. */
export function contrast(a: string, b: string): number {
  const [light, dark] = [luminance(a), luminance(b)].sort((x, y) => y - x) as [number, number];
  return (light + 0.05) / (dark + 0.05);
}

function mix(from: string, to: string, amount: number): string {
  const a = rgb(from);
  const b = rgb(to);
  return toHex([0, 1, 2].map((index) => a[index]! + (b[index]! - a[index]!) * amount) as [number, number, number]);
}

export function isHexColor(value: unknown): value is string {
  return typeof value === 'string' && /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.test(value);
}

/**
 * The ink that reads best on a background: white, or the app's near-black. On
 * a few mid tones (#0080cc, say) neither reaches 4.5:1; then pure black or
 * white, one of which always reaches at least 4.58:1.
 */
export function sidebarInk(background: string): string {
  const white = contrast('#ffffff', background);
  const near = contrast('#14191b', background);
  const best = white >= near ? '#ffffff' : '#14191b';
  if (Math.max(white, near) >= 4.5) return best;
  return white >= contrast('#000000', background) ? '#ffffff' : '#000000';
}

/** The chrome variables for a sidebar background, every text color at 4.5:1 or better. */
export function sidebarVars(background: string): Record<string, string> {
  const ink = sidebarInk(background);
  // Start part of the way toward the background, then move back toward the ink until the contrast holds.
  const readable = (start: number): string => {
    for (let amount = start; amount > 0; amount -= 0.02) {
      const color = mix(ink, background, amount);
      if (contrast(color, background) >= 4.5) return color;
    }
    return ink;
  };
  const [r, g, b] = rgb(ink);
  const wash = (alpha: number): string => `rgba(${r}, ${g}, ${b}, ${alpha})`;
  return {
    '--chrome': background,
    '--chrome-text': readable(0.26),
    '--chrome-dim': readable(0.42),
    '--chrome-strong': ink,
    '--chrome-hover': wash(0.08),
    '--chrome-line': wash(0.11),
    '--chrome-field': wash(0.12),
  };
}

/** The background a sidebar preference asks for, or null for the built-in look. */
export function sidebarBackground(prefs: { sidebar_theme?: unknown; sidebar_color?: unknown }): string | null {
  const theme = typeof prefs.sidebar_theme === 'string' ? prefs.sidebar_theme : 'harbor';
  if (theme === 'custom') return isHexColor(prefs.sidebar_color) ? prefs.sidebar_color : null;
  return SIDEBAR_PRESETS[theme] ?? null;
}
