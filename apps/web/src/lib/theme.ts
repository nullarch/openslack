export type ThemeChoice = 'system' | 'light' | 'dark';

let choice: ThemeChoice = 'system';
const media = window.matchMedia('(prefers-color-scheme: dark)');

export function themeChoice(value: unknown): ThemeChoice {
  return value === 'light' || value === 'dark' ? value : 'system';
}

/** Apply the viewer's theme preference; `system` follows the operating system and keeps following it. */
export function applyTheme(value: unknown): void {
  choice = themeChoice(value);
  const resolved = choice === 'system' ? (media.matches ? 'dark' : 'light') : choice;
  document.documentElement.dataset.theme = resolved;
  try {
    // Remembered so the next page load paints the right theme before boot.
    if (choice === 'system') localStorage.removeItem('theme');
    else localStorage.setItem('theme', choice);
  } catch {
    // Storage may be unavailable; the theme still applies for this session.
  }
}

export function resolvedTheme(): 'light' | 'dark' {
  return document.documentElement.dataset.theme === 'dark' ? 'dark' : 'light';
}

media.addEventListener('change', () => {
  if (choice === 'system') applyTheme('system');
});
