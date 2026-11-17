import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { contrast, isHexColor, SIDEBAR_PRESETS, sidebarBackground, sidebarInk, sidebarVars } from '../src/lib/sidebar-colors.ts';

const TEXT = ['--chrome-text', '--chrome-dim', '--chrome-strong'];

/** The background with 12% of the ink over it: the strongest wash under sidebar text (fields, hover, the bottom strip). */
function washed(vars: Record<string, string>): string {
  const channels = (hex: string): number[] => [1, 3, 5].map((index) => Number.parseInt(hex.slice(index, index + 2), 16));
  const [base, ink] = [channels(vars['--chrome']!), channels(vars['--chrome-strong']!)];
  return `#${base.map((value, index) => Math.round(value + (ink[index]! - value) * 0.12).toString(16).padStart(2, '0')).join('')}`;
}

/** Every text color reads on the sidebar's background and on its washes. */
function readable(vars: Record<string, string>, label: string): void {
  for (const key of TEXT) {
    assert.ok(contrast(vars[key]!, vars['--chrome']!) >= 4.5, `${label} ${key} ${vars[key]} on ${vars['--chrome']}`);
    assert.ok(contrast(vars[key]!, washed(vars)) >= 4.5, `${label} ${key} ${vars[key]} on the wash ${washed(vars)}`);
  }
}

describe('sidebar colors', () => {
  test('every preset keeps all sidebar text at 4.5:1 or better', () => {
    for (const [name, background] of Object.entries(SIDEBAR_PRESETS)) {
      if (!background) continue;
      const vars = sidebarVars(background);
      readable(vars, name);
      assert.equal(vars['--chrome'], background, `${name} keeps its color`);
    }
  });

  test('any custom color does too, dark or light, saturated or grey', () => {
    // A grid through the whole color cube, including the mid greys where neither ink is comfortable.
    const steps = [0, 0x33, 0x66, 0x80, 0x99, 0xcc, 0xff];
    for (const r of steps) {
      for (const g of steps) {
        for (const b of steps) {
          const background = `#${[r, g, b].map((value) => value.toString(16).padStart(2, '0')).join('')}`;
          const vars = sidebarVars(background);
          readable(vars, background);
          // A mid tone may move, but only a little.
          assert.ok(contrast(vars['--chrome']!, background) < 1.6, `${background} stays close to what was chosen (${vars['--chrome']})`);
        }
      }
    }
  });

  test('ink follows the background: white on dark, near-black on light', () => {
    assert.equal(sidebarInk('#1f3d2c'), '#ffffff');
    assert.equal(sidebarInk('#f2e8c9'), '#14191b');
    // Secondary text is softer than the strongest ink, but still a distinct step from it.
    const vars = sidebarVars('#1f3d2c');
    assert.notEqual(vars['--chrome-text'], vars['--chrome-strong']);
  });

  test('preferences resolve to a background, or to the built-in look', () => {
    assert.equal(sidebarBackground({}), null);
    assert.equal(sidebarBackground({ sidebar_theme: 'harbor' }), null);
    assert.equal(sidebarBackground({ sidebar_theme: 'forest' }), '#1f3d2c');
    assert.equal(sidebarBackground({ sidebar_theme: 'custom', sidebar_color: '#abc' }), '#abc');
    assert.equal(sidebarBackground({ sidebar_theme: 'custom', sidebar_color: 'red' }), null, 'only hex colors');
    assert.equal(sidebarBackground({ sidebar_theme: 'unknown' }), null);
    assert.equal(isHexColor('#12345g'), false);
  });
});
