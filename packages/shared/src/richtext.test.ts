import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { richTextRepeatsText } from './richtext.ts';

const section = (...elements: unknown[]) => ({ type: 'rich_text_section', elements });
const block = (...elements: unknown[]) => ({ type: 'rich_text', elements });

describe('richTextRepeatsText', () => {
  test('the same words with markup, mentions, links and emoji', () => {
    const rich = block(
      section(
        { type: 'text', text: 'Ship ' },
        { type: 'text', text: 'it', style: { bold: true } },
        { type: 'text', text: ' ' },
        { type: 'user', user_id: 'U1' },
        { type: 'text', text: ' see ' },
        { type: 'link', url: 'https://example.com/a?b=1&c=2', text: 'the notes' },
        { type: 'text', text: ' ' },
        { type: 'emoji', name: 'rocket', unicode: '1f680' },
      ),
    );
    assert.equal(richTextRepeatsText('Ship *it* <@U1> see <https://example.com/a?b=1&amp;c=2|the notes> :rocket:', rich), true);
  });

  test('lists, quotes and code blocks as the composer writes them', () => {
    const rich = block(
      section({ type: 'text', text: 'Plan:' }),
      { type: 'rich_text_list', style: 'ordered', indent: 0, border: 0, elements: [section({ type: 'text', text: 'first' }), section({ type: 'text', text: 'second' })] },
      { type: 'rich_text_list', style: 'bullet', indent: 1, border: 0, elements: [section({ type: 'text', text: 'detail' })] },
      { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted' }] },
      { type: 'rich_text_preformatted', border: 0, elements: [{ type: 'text', text: 'a < b' }] },
    );
    assert.equal(richTextRepeatsText('Plan:\n1. first\n2. second\n    ◦ detail\n&gt; quoted\n```\na &lt; b\n```', rich), true);
  });

  test('different words, other blocks and empty input are not repeats', () => {
    const rich = block(section({ type: 'text', text: 'The full report' }));
    assert.equal(richTextRepeatsText('New message', rich), false);
    assert.equal(richTextRepeatsText('', rich), false);
    assert.equal(richTextRepeatsText('The full report', { type: 'section', text: { type: 'mrkdwn', text: 'The full report' } }), false);
    assert.equal(richTextRepeatsText('x', block()), false);
  });
});
