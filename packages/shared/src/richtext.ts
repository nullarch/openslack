/**
 * Helpers for Slack's `rich_text` blocks that the server needs. Clients (Slack's
 * own and this one) send a person's message twice: as `mrkdwn` in `text` and as
 * a `rich_text` block built from the same document. Those are one message, not two.
 */

import { parseMrkdwn, type MrkdwnNode } from './mrkdwn.ts';

type Json = Record<string, unknown>;

/** Letters and digits only, lowercased: what two renderings of the same words have in common. */
function letters(value: string): string {
  return value.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');
}

function mrkdwnSkeleton(nodes: MrkdwnNode[]): string {
  let out = '';
  for (const node of nodes) {
    switch (node.type) {
      case 'text':
      case 'code':
      case 'pre':
        out += node.text;
        break;
      case 'bold':
      case 'italic':
      case 'strike':
      case 'quote':
      case 'link':
        out += mrkdwnSkeleton(node.children);
        break;
      case 'user':
      case 'channel':
      case 'usergroup':
        out += node.id;
        break;
      case 'broadcast':
        out += node.range;
        break;
      case 'date':
        out += node.fallback;
        break;
      case 'emoji':
        out += node.name.split('::')[0] ?? '';
        break;
      case 'br':
        break;
    }
  }
  return out;
}

function inlineSkeleton(elements: unknown): string {
  if (!Array.isArray(elements)) return '';
  let out = '';
  for (const item of elements as Json[]) {
    if (!item || typeof item !== 'object') continue;
    switch (item.type) {
      case 'text':
        out += String(item.text ?? '');
        break;
      case 'link':
        out += String(item.text || item.url || '');
        break;
      case 'user':
        out += String(item.user_id ?? '');
        break;
      case 'channel':
        out += String(item.channel_id ?? '');
        break;
      case 'usergroup':
        out += String(item.usergroup_id ?? '');
        break;
      case 'broadcast':
        out += String(item.range ?? '');
        break;
      case 'date':
        out += String(item.fallback ?? '');
        break;
      case 'emoji':
        out += String(item.name ?? '');
        break;
      default:
        break;
    }
  }
  return out;
}

function blockSkeleton(block: Json): string {
  let out = '';
  for (const element of Array.isArray(block.elements) ? (block.elements as Json[]) : []) {
    if (!element || typeof element !== 'object') continue;
    if (element.type === 'rich_text_list') {
      const items = Array.isArray(element.elements) ? (element.elements as Json[]) : [];
      const offset = Number(element.offset ?? 0) || 0;
      items.forEach((item, index) => {
        // A numbered list's text carries its numbers ("1. first"), so they count here too.
        if (element.style === 'ordered') out += String(offset + index + 1);
        out += inlineSkeleton(item?.elements);
      });
    } else {
      out += inlineSkeleton(element.elements);
    }
  }
  return out;
}

/**
 * Whether a `rich_text` block says the same words as the `mrkdwn` text: markup,
 * spacing, list bullets and quote marks aside. Such a block adds nothing to the
 * searchable text of its message.
 */
export function richTextRepeatsText(text: string, block: unknown): boolean {
  if (!text || !block || typeof block !== 'object' || (block as Json).type !== 'rich_text') return false;
  const fromBlock = letters(blockSkeleton(block as Json));
  return fromBlock !== '' && fromBlock === letters(mrkdwnSkeleton(parseMrkdwn(text)));
}
