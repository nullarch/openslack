import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { decodeMessage, encodeMessage, findTrigger, prefixLines, wrapSelection } from '../src/lib/compose.ts';

const lookup = {
  users: [
    { id: 'U1', names: ['Daniel', 'Daniel Okafor', 'daniel'] },
    { id: 'U2', names: ['Dan', 'Dan Li', 'dan.li'] },
    { id: 'U3', names: ['준', 'Jun Park', 'jun'] },
  ],
  channels: [
    { id: 'C1', name: 'general' },
    { id: 'C2', name: '검색-테스트' },
  ],
};

describe('encodeMessage', () => {
  test('escapes the three reserved characters', () => {
    assert.equal(encodeMessage('a < b && c > d', lookup), 'a &lt; b &amp;&amp; c &gt; d');
    assert.equal(encodeMessage('> quoted', lookup), '&gt; quoted');
  });

  test('encodes mentions, preferring the longest name', () => {
    assert.equal(encodeMessage('hi @Daniel Okafor and @Dan!', lookup), 'hi <@U1> and <@U2>!');
    assert.equal(encodeMessage('@dan.li @준 ping', lookup), '<@U2> <@U3> ping');
    assert.equal(encodeMessage('@Danielle is someone else', lookup), '@Danielle is someone else');
    assert.equal(encodeMessage('mail me@daniel.dev', lookup), 'mail me@daniel.dev');
  });

  test('encodes broadcasts and channels', () => {
    assert.equal(encodeMessage('@here deploy in #general and #검색-테스트, not #nope', lookup), '<!here> deploy in <#C1> and <#C2>, not #nope');
    assert.equal(encodeMessage('@channel @everyone', lookup), '<!channel> <!everyone>');
  });

  test('raw mrkdwn tokens pass through', () => {
    assert.equal(encodeMessage('see <https://x.dev/a?b=1&c=2|the docs> <@U9ABCDEF> <!here>', lookup), 'see <https://x.dev/a?b=1&c=2|the docs> <@U9ABCDEF> <!here>');
    assert.equal(encodeMessage('<script>', lookup), '&lt;script&gt;');
  });
});

describe('decodeMessage', () => {
  const decode = {
    userName: (id: string) => ({ U1: 'Daniel Okafor' })[id],
    channelName: (id: string) => ({ C1: 'general' })[id],
  };

  test('round-trips a message for editing', () => {
    const stored = 'hi <@U1> in <#C1> <!here> &lt;3 &amp; <https://x.dev> <https://x.dev|docs>';
    const editable = decodeMessage(stored, decode);
    assert.equal(editable, 'hi @Daniel Okafor in #general @here <3 & https://x.dev <https://x.dev|docs>');
    assert.equal(encodeMessage(editable, lookup), 'hi <@U1> in <#C1> <!here> &lt;3 &amp; https://x.dev <https://x.dev|docs>');
  });

  test('unknown ids stay as tokens', () => {
    assert.equal(decodeMessage('<@U404> <#C404|old-name>', decode), '<@U404> #old-name');
  });
});

describe('findTrigger', () => {
  test('detects each trigger at the caret', () => {
    assert.deepEqual(findTrigger('hello @da', 9), { kind: 'user', query: 'da', start: 6 });
    assert.deepEqual(findTrigger('in #gen', 7), { kind: 'channel', query: 'gen', start: 3 });
    assert.deepEqual(findTrigger('nice :ta', 8), { kind: 'emoji', query: 'ta', start: 5 });
    assert.deepEqual(findTrigger('/dep', 4), { kind: 'command', query: 'dep', start: 0 });
    assert.equal(findTrigger('a/b', 3), null);
    assert.equal(findTrigger('mail@x', 6), null);
    assert.equal(findTrigger('10:30', 5), null);
    assert.equal(findTrigger('hello @da there', 15), null);
  });
});

describe('selection edits', () => {
  test('wrapSelection wraps or inserts a pair', () => {
    assert.deepEqual(wrapSelection('make bold', 5, 9, '*'), { text: 'make *bold*', selectionStart: 6, selectionEnd: 10 });
    assert.deepEqual(wrapSelection('ab', 1, 1, '`'), { text: 'a``b', selectionStart: 2, selectionEnd: 2 });
  });

  test('prefixLines toggles a prefix on whole lines', () => {
    const quoted = prefixLines('one\ntwo\nthree', 1, 6, '> ');
    assert.equal(quoted.text, '> one\n> two\nthree');
    assert.equal(prefixLines(quoted.text, 0, quoted.text.indexOf('three') - 1, '> ').text, 'one\ntwo\nthree');
  });
});
