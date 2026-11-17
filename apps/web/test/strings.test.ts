import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { DOC_EN, DOC_TRANSLATIONS } from '../src/components/docs/text.ts';
import { EN, TRANSLATIONS as LOADERS, type Strings } from '../src/strings.ts';

/**
 * Every translation against the English source, at run time. The types already
 * refuse a missing top-level key; these also cover what they cannot see: the
 * keys of `Record<string, string>` maps (error codes, audit actions, field
 * types), array lengths, what functions return, and text left in English.
 */

type Tree = Record<string, unknown>;
type Translation = keyof typeof LOADERS;
const TRANSLATIONS = Object.keys(LOADERS) as Translation[];
const BUNDLES = Object.fromEntries(await Promise.all(TRANSLATIONS.map(async (locale) => [locale, await LOADERS[locale]()] as const))) as Record<Translation, Strings>;

const HANGUL = /[\uAC00-\uD7A3]/;
const KANA_OR_KANJI = /[\u3040-\u30FF\u4E00-\u9FFF]/;
// Hiragana and katakana, except ツ: the shrug ¯\_(ツ)_/¯ is the same in every language.
const KANA = /[\u3040-\u30C3\u30C5-\u30FF]/;

/** Arguments to try a function with: numbers, words and lists cover every signature in the bundles. */
const SAMPLES: unknown[] = [0, 1, 2, 5, 365, 'Ab', ['Ab', 'Cd'], ['Ab', 'Cd', 'Ef']];

interface Leaf {
  path: string;
  en: string;
  text: string;
}

/** Walk the English tree and the translation together; return every pair of texts (strings and function results). */
function pairs(en: unknown, other: unknown, path: string, out: Leaf[] = []): Leaf[] {
  if (typeof en === 'string') {
    assert.equal(typeof other, 'string', `${path}: expected a string`);
    out.push({ path, en, text: other as string });
  } else if (typeof en === 'function') {
    assert.equal(typeof other, 'function', `${path}: expected a function`);
    const fn = other as (...args: unknown[]) => unknown;
    assert.equal(fn.length, en.length, `${path}: takes ${en.length} arguments in English`);
    for (const sample of SAMPLES) {
      const args: unknown[] = Array.from({ length: Math.max(en.length, 1) }, () => sample);
      let source: unknown;
      try {
        source = en(...args);
      } catch {
        continue;
      }
      // A sample of the wrong type for this function (a word where it wants a number) says nothing.
      if (typeof source !== 'string' || /undefined|NaN|\[object/.test(source)) continue;
      const text = fn(...args);
      assert.equal(typeof text, 'string', `${path}(${JSON.stringify(args)}) returns a string`);
      assert.doesNotMatch(text as string, /undefined|NaN|\[object/, `${path}(${JSON.stringify(args)}) = ${text}`);
      out.push({ path: `${path}(${JSON.stringify(args)})`, en: source, text: text as string });
    }
  } else if (Array.isArray(en)) {
    assert.ok(Array.isArray(other), `${path}: expected a list`);
    assert.equal((other as unknown[]).length, en.length, `${path}: ${en.length} items in English`);
    en.forEach((item, index) => pairs(item, (other as unknown[])[index], `${path}[${index}]`, out));
  } else if (en && typeof en === 'object') {
    assert.ok(other && typeof other === 'object', `${path}: expected an object`);
    const keys = Object.keys(en).sort();
    assert.deepEqual(Object.keys(other as Tree).sort(), keys, `${path}: the same keys as English`);
    for (const key of keys) pairs((en as Tree)[key], (other as Tree)[key], `${path}.${key}`, out);
  } else {
    assert.equal(other, en, path);
  }
  return out;
}

const cache = new Map<Translation, Leaf[]>();

/** A translation's texts next to the English ones; walking it asserts the shape (inside the test that asks first). */
function texts(locale: Translation): Leaf[] {
  if (!cache.has(locale)) {
    const docs = { ...BUNDLES[locale].docs, ...DOC_TRANSLATIONS[locale] };
    cache.set(locale, [...pairs(EN, BUNDLES[locale], 'S'), ...pairs(DOC_EN, docs, 'T')]);
  }
  return cache.get(locale)!;
}

describe('translations', () => {
  test('there is a Korean and a Japanese bundle', () => {
    assert.deepEqual([...TRANSLATIONS].sort(), ['ja', 'ko']);
  });

  for (const locale of TRANSLATIONS) {
    test(`${locale}: the same shape as English, and every function returns text`, () => {
      assert.ok(texts(locale).length > 1500, `${texts(locale).length} texts`);
    });
  }

  test('a text left as in English is left so in every language (a name or code, not a forgotten string)', () => {
    const kept = (locale: Translation) => new Set(texts(locale).filter((leaf) => leaf.text === leaf.en && /[A-Za-z]{3,}/.test(leaf.en)).map((leaf) => leaf.path));
    const sets = TRANSLATIONS.map((locale) => [locale, kept(locale)] as const);
    for (const [locale, set] of sets) {
      for (const [other, otherSet] of sets) {
        if (other === locale) continue;
        const lone = [...set].filter((path) => !otherSet.has(path));
        assert.deepEqual(lone, [], `${locale} keeps the English text where ${other} translates it`);
      }
    }
  });

  test('Japanese has no Korean in it, and Korean no Japanese', () => {
    assert.deepEqual(texts('ja').filter((leaf) => HANGUL.test(leaf.text)).map((leaf) => leaf.path), []);
    assert.deepEqual(texts('ko').filter((leaf) => KANA.test(leaf.text)).map((leaf) => leaf.path), []);
  });

  test('Japanese sentences use Japanese punctuation and quotes', () => {
    const japanese = texts('ja').filter((leaf) => KANA_OR_KANJI.test(leaf.text));
    // “…” around a name or a search term is 「…」 in Japanese; a sentence ends with 。 not a period.
    assert.deepEqual(japanese.filter((leaf) => /[“”]/.test(leaf.text)).map((leaf) => `${leaf.path}: ${leaf.text}`), []);
    assert.deepEqual(japanese.filter((leaf) => /[\u3040-\u30FF\u4E00-\u9FFF]\.(\s|$)/.test(leaf.text)).map((leaf) => `${leaf.path}: ${leaf.text}`), []);
  });
});
