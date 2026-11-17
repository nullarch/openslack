/**
 * What crosses between servers refers to people, conversations and messages by
 * wire references that both sides understand, never by one side's local ids:
 *
 * - a person is `{ team, id }`: their home team and their id there;
 * - a message is `{ team, ts }`: the team where it was first posted and its ts there.
 *
 * In message text and Block Kit, a mention `<@U123>` is written as
 * `<@T9/U123>` on the wire (team, slash, id) and turned back into a local id
 * on arrival; a link to the shared conversation becomes `<#~>`; links to other
 * conversations, which the other side cannot open, become their name.
 */

export interface PersonRef {
  team: string;
  id: string;
}

export interface MessageRef {
  team: string;
  ts: string;
}

type Json = Record<string, unknown>;

export interface Rewrite {
  /** A local person id to its wire form `team/id`, or null to write the person's name instead. */
  person(id: string): string | null;
  /** A local conversation id to `~` (the shared conversation), or null. */
  conversation(id: string): string | null;
  /** Text shown in place of something that cannot cross (a private channel, a user group). */
  label(kind: 'person' | 'conversation' | 'group', id: string, given: string | undefined): string;
}

const MENTION = /<@([A-Z0-9]+(?:\/[A-Z0-9]+)?)(?:\|([^>]*))?>/g;
const CHANNEL = /<#([A-Z0-9~]+)(?:\|([^>]*))?>/g;
const GROUP = /<!subteam\^([A-Z0-9]+)(?:\|([^>]*))?>/g;

/** Rewrite the references in a piece of mrkdwn text. */
export function rewriteText(text: string, rewrite: Rewrite): string {
  return text
    .replace(MENTION, (_whole, id: string, name: string | undefined) => {
      const mapped = rewrite.person(id);
      return mapped ? `<@${mapped}>` : rewrite.label('person', id, name);
    })
    .replace(CHANNEL, (_whole, id: string, name: string | undefined) => {
      const mapped = rewrite.conversation(id);
      return mapped ? `<#${mapped}>` : rewrite.label('conversation', id, name);
    })
    .replace(GROUP, (_whole, id: string, name: string | undefined) => rewrite.label('group', id, name));
}

/**
 * Rewrite references anywhere in Block Kit or attachments: mrkdwn strings, and
 * the `user`, `channel` and `usergroup` elements of rich text.
 */
export function rewriteBlocks<T>(value: T, rewrite: Rewrite): T {
  const walk = (node: unknown): unknown => {
    if (typeof node === 'string') return rewriteText(node, rewrite);
    if (Array.isArray(node)) return node.map(walk);
    if (!node || typeof node !== 'object') return node;
    const element = node as Json;
    if (element.type === 'user' && typeof element.user_id === 'string') {
      const mapped = rewrite.person(element.user_id);
      return mapped ? { ...element, user_id: mapped } : { type: 'text', text: rewrite.label('person', element.user_id, undefined) };
    }
    if (element.type === 'channel' && typeof element.channel_id === 'string') {
      const mapped = rewrite.conversation(element.channel_id);
      return mapped ? { ...element, channel_id: mapped } : { type: 'text', text: rewrite.label('conversation', element.channel_id, undefined) };
    }
    if (element.type === 'usergroup' && typeof element.usergroup_id === 'string') {
      return { type: 'text', text: rewrite.label('group', element.usergroup_id, undefined) };
    }
    const out: Json = {};
    for (const [key, child] of Object.entries(element)) {
      // Identifiers are not text: leave them alone.
      out[key] = key === 'block_id' || key === 'action_id' || key === 'url' || key === 'image_url' ? child : walk(child);
    }
    return out;
  };
  return walk(value) as T;
}

/** Every person a piece of text or Block Kit refers to, in local form (`U…`). */
export function peopleIn(text: string, blocks: unknown): string[] {
  const found = new Set<string>();
  for (const match of text.matchAll(MENTION)) if (!match[1]!.includes('/')) found.add(match[1]!);
  const walk = (node: unknown): void => {
    if (typeof node === 'string') {
      for (const match of node.matchAll(MENTION)) if (!match[1]!.includes('/')) found.add(match[1]!);
    } else if (Array.isArray(node)) node.forEach(walk);
    else if (node && typeof node === 'object') {
      const element = node as Json;
      if (element.type === 'user' && typeof element.user_id === 'string') found.add(element.user_id);
      for (const child of Object.values(element)) walk(child);
    }
  };
  walk(blocks);
  return [...found];
}
