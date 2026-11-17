import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { mrkdwnToPlain, parseMrkdwn, type MrkdwnNode } from './mrkdwn.ts';

const text = (value: string): MrkdwnNode => ({ type: 'text', text: value });

describe('parseMrkdwn', () => {
  test('plain text and line breaks', () => {
    assert.deepEqual(parseMrkdwn('hello'), [text('hello')]);
    assert.deepEqual(parseMrkdwn('one\ntwo'), [text('one'), { type: 'br' }, text('two')]);
    assert.deepEqual(parseMrkdwn(''), []);
  });

  test('bold, italic and strikethrough', () => {
    assert.deepEqual(parseMrkdwn('*bold* _it_ ~gone~'), [
      { type: 'bold', children: [text('bold')] },
      text(' '),
      { type: 'italic', children: [text('it')] },
      text(' '),
      { type: 'strike', children: [text('gone')] },
    ]);
    assert.deepEqual(parseMrkdwn('*2.4 ships Thursday.* Freeze is Wednesday'), [
      { type: 'bold', children: [text('2.4 ships Thursday.')] },
      text(' Freeze is Wednesday'),
    ]);
    // A marker after a backslash is literal: the shrug from /shrug is not italic.
    assert.deepEqual(parseMrkdwn('fine ¯\\_(ツ)_/¯'), [text('fine ¯\\_(ツ)_/¯')]);
    // Nested emphasis.
    assert.deepEqual(parseMrkdwn('*bold _both_*'), [
      { type: 'bold', children: [text('bold '), { type: 'italic', children: [text('both')] }] },
    ]);
  });

  test('emphasis needs word boundaries', () => {
    assert.deepEqual(parseMrkdwn('snake_case_name'), [text('snake_case_name')]);
    assert.deepEqual(parseMrkdwn('2 * 3 * 4'), [text('2 * 3 * 4')]);
    assert.deepEqual(parseMrkdwn('a*b*c'), [text('a*b*c')]);
    assert.deepEqual(parseMrkdwn('* not bold *'), [text('* not bold *')]);
    assert.deepEqual(parseMrkdwn('**'), [text('**')]);
  });

  test('inline code is literal', () => {
    assert.deepEqual(parseMrkdwn('flip `sessions_v2` now'), [
      text('flip '),
      { type: 'code', text: 'sessions_v2' },
      text(' now'),
    ]);
    assert.deepEqual(parseMrkdwn('`*not bold* &lt;b&gt;`'), [{ type: 'code', text: '*not bold* <b>' }]);
  });

  test('code fences', () => {
    assert.deepEqual(parseMrkdwn('before\n```\nconst a = 1;\n*raw*\n```\nafter'), [
      text('before'),
      { type: 'pre', text: 'const a = 1;\n*raw*' },
      text('after'),
    ]);
    assert.deepEqual(parseMrkdwn('```one line```'), [{ type: 'pre', text: 'one line' }]);
  });

  test('quotes', () => {
    assert.deepEqual(parseMrkdwn('&gt; quoted *text*\n&gt; second\nreply'), [
      { type: 'quote', children: [text('quoted '), { type: 'bold', children: [text('text')] }, { type: 'br' }, text('second')] },
      text('reply'),
    ]);
    assert.deepEqual(parseMrkdwn('> raw angle'), [{ type: 'quote', children: [text('raw angle')] }]);
    assert.deepEqual(parseMrkdwn('intro\n&gt;&gt;&gt; all\nof this'), [
      text('intro'),
      { type: 'quote', children: [text('all'), { type: 'br' }, text('of this')] },
    ]);
  });

  test('links with and without labels', () => {
    assert.deepEqual(parseMrkdwn('<https://example.com/a?b=1&amp;c=2|the *docs*>'), [
      {
        type: 'link',
        url: 'https://example.com/a?b=1&c=2',
        children: [text('the '), { type: 'bold', children: [text('docs')] }],
      },
    ]);
    assert.deepEqual(parseMrkdwn('<https://example.com>'), [
      { type: 'link', url: 'https://example.com', children: [text('https://example.com')] },
    ]);
    assert.deepEqual(parseMrkdwn('<mailto:a@b.co|mail me>'), [
      { type: 'link', url: 'mailto:a@b.co', children: [text('mail me')] },
    ]);
  });

  test('bare URLs are linked without trailing punctuation', () => {
    assert.deepEqual(parseMrkdwn('see https://example.com/release.'), [
      text('see '),
      { type: 'link', url: 'https://example.com/release', children: [text('https://example.com/release')] },
      text('.'),
    ]);
    assert.deepEqual(parseMrkdwn('(https://en.wikipedia.org/wiki/Rust_(language))'), [
      text('('),
      {
        type: 'link',
        url: 'https://en.wikipedia.org/wiki/Rust_(language)',
        children: [text('https://en.wikipedia.org/wiki/Rust_(language)')],
      },
      text(')'),
    ]);
    assert.deepEqual(parseMrkdwn('nothttps://x.y'), [text('nothttps://x.y')]);
  });

  test('mentions, channel links and broadcasts', () => {
    assert.deepEqual(parseMrkdwn('<@U123ABC> ping <@W9|sam> in <#C42|general> <#C43> <!here> <!channel> <!everyone>'), [
      { type: 'user', id: 'U123ABC' },
      text(' ping '),
      { type: 'user', id: 'W9', label: 'sam' },
      text(' in '),
      { type: 'channel', id: 'C42', label: 'general' },
      text(' '),
      { type: 'channel', id: 'C43' },
      text(' '),
      { type: 'broadcast', range: 'here' },
      text(' '),
      { type: 'broadcast', range: 'channel' },
      text(' '),
      { type: 'broadcast', range: 'everyone' },
    ]);
    assert.deepEqual(parseMrkdwn('<!subteam^S01|@oncall>'), [{ type: 'usergroup', id: 'S01', label: '@oncall' }]);
    assert.deepEqual(parseMrkdwn('<!date^1700000000^{date_short}|Nov 14>'), [
      { type: 'date', timestamp: 1700000000, format: '{date_short}', fallback: 'Nov 14' },
    ]);
  });

  test('emoji shortcodes', () => {
    assert.deepEqual(parseMrkdwn('ship it :rocket::tada:'), [
      text('ship it '),
      { type: 'emoji', name: 'rocket' },
      { type: 'emoji', name: 'tada' },
    ]);
    assert.deepEqual(parseMrkdwn(':+1::skin-tone-3:'), [{ type: 'emoji', name: '+1::skin-tone-3' }]);
    // A time is not an emoji.
    assert.deepEqual(parseMrkdwn('at 10:30:45 sharp'), [text('at 10:30:45 sharp')]);
  });

  test('escapes are decoded and unknown angle tokens stay text', () => {
    assert.deepEqual(parseMrkdwn('a &lt;b&gt; &amp; c'), [text('a <b> & c')]);
    assert.deepEqual(parseMrkdwn('<not a token>'), [text('<not a token>')]);
    assert.deepEqual(parseMrkdwn('1 < 2 > 0'), [text('1 < 2 > 0')]);
  });
});

describe('mrkdwnToPlain', () => {
  test('flattens with lookups', () => {
    const nodes = parseMrkdwn('*Hi* <@U1>, see <#C1> and <https://x.dev|the docs> :tada:\nbye');
    assert.equal(
      mrkdwnToPlain(nodes, {
        user: (id) => (id === 'U1' ? 'Maya' : undefined),
        channel: (id) => (id === 'C1' ? 'general' : undefined),
        emoji: (name) => (name === 'tada' ? '🎉' : undefined),
      }),
      'Hi @Maya, see #general and the docs 🎉\nbye',
    );
    assert.equal(mrkdwnToPlain(parseMrkdwn('<@U9> <!here> :nope:')), '@U9 @here :nope:');
  });
});
