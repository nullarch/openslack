import assert from 'node:assert/strict';
import { describe, test } from 'node:test';
import { richTextRepeatsText } from '@app/shared';
import { encodeMessage } from '../src/lib/compose.ts';
import {
  composeMarkup,
  composeRich,
  docToMarkup,
  docToRichText,
  markupToDoc,
  mrkdwnToDoc,
  richTextToDoc,
  richTextToMrkdwn,
  type DocNode,
  type RichLookup,
  type RichTextBlock,
} from '../src/lib/richtext.ts';

const EMOJI: Record<string, string | null> = { rocket: '🚀', tada: '🎉', '+1::skin-tone-3': '👍🏽', partyparrot: null };

const lookup: RichLookup = {
  compose: {
    users: [
      { id: 'U1', names: ['Maya', 'Maya Chen', 'maya'] },
      { id: 'U2', names: ['Daniel', 'daniel'] },
    ],
    channels: [{ id: 'C1', name: 'general' }],
    groups: [{ id: 'S1', handle: 'design' }],
  },
  userName: (id) => ({ U1: 'Maya', U2: 'Daniel' })[id],
  channelName: (id) => ({ C1: 'general' })[id],
  groupHandle: (id) => ({ S1: 'design' })[id],
  isEmoji: (name) => name in EMOJI,
  emojiChar: (name) => EMOJI[name] ?? null,
};

const text = (value: string, ...marks: string[]): DocNode => (marks.length ? { type: 'text', text: value, marks: marks.map((type) => ({ type })) } : { type: 'text', text: value });
const p = (...content: DocNode[]): DocNode => (content.length ? { type: 'paragraph', content } : { type: 'paragraph' });
const doc = (...content: DocNode[]): DocNode => ({ type: 'doc', content });
const mention = (kind: string, id: string, label: string): DocNode => ({ type: 'mention', attrs: { kind, id, label } });
const emoji = (name: string): DocNode => ({ type: 'emoji', attrs: { name } });
const item = (...content: DocNode[]): DocNode => ({ type: 'listItem', content });
const link = (value: string, href: string, ...marks: string[]): DocNode => ({ type: 'text', text: value, marks: [...marks.map((type) => ({ type })), { type: 'link', attrs: { href } }] });

describe('docToRichText and richTextToMrkdwn', () => {
  test('styles, mentions, emoji and links, as Slack’s client sends them', () => {
    const sent = composeRich(
      doc(
        p(
          text('Ship '),
          text('it', 'bold'),
          text(' '),
          mention('user', 'U1', 'Maya'),
          text(' in '),
          mention('channel', 'C1', 'general'),
          text(' '),
          emoji('rocket'),
          text(' '),
          link('the notes', 'https://example.com/a?b=1&c=2'),
          text(' '),
          text('a < b', 'code'),
        ),
      ),
      lookup,
    );
    assert.deepEqual(sent.blocks, [
      {
        type: 'rich_text',
        elements: [
          {
            type: 'rich_text_section',
            elements: [
              { type: 'text', text: 'Ship ' },
              { type: 'text', text: 'it', style: { bold: true } },
              { type: 'text', text: ' ' },
              { type: 'user', user_id: 'U1' },
              { type: 'text', text: ' in ' },
              { type: 'channel', channel_id: 'C1' },
              { type: 'text', text: ' ' },
              { type: 'emoji', name: 'rocket', unicode: '1f680' },
              { type: 'text', text: ' ' },
              { type: 'link', url: 'https://example.com/a?b=1&c=2', text: 'the notes' },
              { type: 'text', text: ' ' },
              { type: 'text', text: 'a < b', style: { code: true } },
            ],
          },
        ],
      },
    ]);
    assert.equal(sent.text, 'Ship *it* <@U1> in <#C1> :rocket: <https://example.com/a?b=1&amp;c=2|the notes> `a &lt; b`');
    assert.ok(richTextRepeatsText(sent.text, sent.blocks[0]), 'the server sees one message, not two');
  });

  test('markers wrap words, not the spaces around them, and nest', () => {
    const sent = composeRich(doc(p(text('say '), text('hello ', 'bold'), text('big', 'bold', 'italic'), text(' world', 'bold'), text(' now'))), lookup);
    assert.equal(sent.text, 'say *hello _big_ world* now');
    assert.equal(composeRich(doc(p(text('two\nlines', 'bold'))), lookup).text, '*two*\n*lines*');
    // A mention in code would show its raw token, so only the other styles reach the text.
    assert.equal(composeRich(doc(p({ ...mention('user', 'U1', 'Maya'), marks: [{ type: 'bold' }, { type: 'code' }] })), lookup).text, '*<@U1>*');
  });

  test('lines, lists (nested and numbered), quotes and code blocks', () => {
    const block = docToRichText(
      doc(
        p(text('Plan:')),
        p(),
        p(text('first line')),
        { type: 'orderedList', attrs: { start: 1 }, content: [item(p(text('draft'))), item(p(text('review')), { type: 'bulletList', content: [item(p(text('legal')))] }), item(p(text('ship')))] },
        { type: 'blockquote', content: [p(text('quoted')), p(text('twice'))] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'npm run @maya' }] },
        p(text('done  ')),
        p(),
      ),
      lookup,
    )!;
    assert.deepEqual(block.elements, [
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'Plan:\n\nfirst line' }] },
      { type: 'rich_text_list', style: 'ordered', indent: 0, border: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'draft' }] }, { type: 'rich_text_section', elements: [{ type: 'text', text: 'review' }] }] },
      { type: 'rich_text_list', style: 'bullet', indent: 1, border: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'legal' }] }] },
      { type: 'rich_text_list', style: 'ordered', indent: 0, offset: 2, border: 0, elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text: 'ship' }] }] },
      { type: 'rich_text_quote', elements: [{ type: 'text', text: 'quoted\ntwice' }] },
      { type: 'rich_text_preformatted', border: 0, elements: [{ type: 'text', text: 'npm run @maya' }] },
      { type: 'rich_text_section', elements: [{ type: 'text', text: 'done' }] },
    ]);
    const mrkdwn = richTextToMrkdwn(block);
    assert.equal(mrkdwn, 'Plan:\n\nfirst line\n1. draft\n2. review\n    ◦ legal\n3. ship\n&gt; quoted\n&gt; twice\n```\nnpm run @maya\n```\ndone');
    assert.ok(richTextRepeatsText(mrkdwn, block));
  });

  test('names typed out in full become mentions; code does not', () => {
    const block = docToRichText(doc(p(text('ask @Maya Chen and @design, cc @here in #general: '), text('@maya', 'code'))), lookup)!;
    assert.deepEqual(block.elements[0], {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'ask ' },
        { type: 'user', user_id: 'U1' },
        { type: 'text', text: ' and ' },
        { type: 'usergroup', usergroup_id: 'S1' },
        { type: 'text', text: ', cc ' },
        { type: 'broadcast', range: 'here' },
        { type: 'text', text: ' in ' },
        { type: 'channel', channel_id: 'C1' },
        { type: 'text', text: ': ' },
        { type: 'text', text: '@maya', style: { code: true } },
      ],
    });
    assert.equal(richTextToMrkdwn(block, lookup), 'ask <@U1> and <!subteam^S1|@design>, cc <!here> in <#C1>: `@maya`');
  });

  test('known :shortcodes: typed out in full are emoji; others and times stay text', () => {
    const block = docToRichText(doc(p(text('ship :rocket::tada: at 10:30:00 :nope: :partyparrot:'))), lookup)!;
    assert.deepEqual(block.elements[0], {
      type: 'rich_text_section',
      elements: [
        { type: 'text', text: 'ship ' },
        { type: 'emoji', name: 'rocket', unicode: '1f680' },
        { type: 'emoji', name: 'tada', unicode: '1f389' },
        { type: 'text', text: ' at 10:30:00 :nope: ' },
        { type: 'emoji', name: 'partyparrot' },
      ],
    });
  });

  test('an empty document sends nothing', () => {
    assert.deepEqual(composeRich(doc(p(), p(text('   ')), p()), lookup), { text: '', blocks: [] });
  });
});

describe('back into the editor', () => {
  test('stored mrkdwn becomes the same document', () => {
    assert.deepEqual(
      mrkdwnToDoc('Ship *it* <@U1> :rocket: :nope: <https://x.test|notes>\n&gt; quoted\n```\ncode\n```\n\nafter', lookup),
      doc(
        p(text('Ship '), text('it', 'bold'), text(' '), mention('user', 'U1', 'Maya'), text(' '), emoji('rocket'), text(' :nope: '), link('notes', 'https://x.test')),
        { type: 'blockquote', content: [p(text('quoted'))] },
        { type: 'codeBlock', content: [{ type: 'text', text: 'code' }] },
        p(),
        p(text('after')),
      ),
    );
  });

  test('a typed draft round-trips through the editor, lists included', () => {
    const typed = 'Hi @Maya, see #general\n• one\n    ◦ nested\n2. two\n*bold* and `code @Maya`';
    const back = docToMarkup(markupToDoc(typed, lookup), lookup);
    assert.equal(back, 'Hi @Maya, see #general\n• one\n    ◦ nested\n2. two\n*bold* and `code @Maya`');
    const lists = markupToDoc('- a\n- b\n1. c', lookup).content!;
    assert.deepEqual(
      lists.map((node) => node.type),
      ['bulletList', 'orderedList'],
    );
  });

  test('rich_text blocks become the document they were written from', () => {
    const original = doc(
      p(text('Hello '), mention('user', 'U2', 'Daniel'), text(' '), emoji('+1::skin-tone-3')),
      { type: 'bulletList', content: [item(p(text('a')), { type: 'orderedList', content: [item(p(text('b')))] }), item(p(text('c')))] },
      { type: 'codeBlock', content: [{ type: 'text', text: 'x' }] },
    );
    const block = docToRichText(original, lookup) as RichTextBlock;
    assert.deepEqual(richTextToDoc([block], lookup), original);
  });

  test('the markup composer sends its text as before, with a block that matches it', () => {
    const sent = composeMarkup('*Heads up* @Maya: 1. first\n> careful', lookup);
    assert.equal(sent.text, encodeMessage('*Heads up* @Maya: 1. first\n> careful', lookup.compose!));
    assert.equal(sent.blocks[0]!.elements[0]!.type, 'rich_text_section');
    assert.equal(sent.blocks[0]!.elements[1]!.type, 'rich_text_quote');
    assert.ok(richTextRepeatsText(sent.text, sent.blocks[0]));
  });
});

describe('encodeMessage', () => {
  test('names in code stay as typed', () => {
    assert.equal(encodeMessage('@Maya `@Maya` ```\n@Maya <b>\n```', lookup.compose!), '<@U1> `@Maya` ```\n@Maya &lt;b&gt;\n```');
  });
});
