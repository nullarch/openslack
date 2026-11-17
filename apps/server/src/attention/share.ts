import { blocksToPlainText, type Attachment } from '@app/shared';
import { permalink, requirePostable } from '../api/methods/chat.ts';
import type { Registry } from '../api/registry.ts';
import { canSee, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { canAccessFile, getFile } from '../core/files.ts';
import { getMessage, MAX_TEXT_LENGTH, messageToApi, postMessage, type MsgRow } from '../core/messages.ts';
import { avatarUrl, getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';

/**
 * Forwarding: a message shared into other conversations, carried as a quoted
 * attachment in Slack's share shape (`is_share`, `is_msg_unfurl`, `from_url`),
 * and a file shared into another conversation.
 */

const MAX_TARGETS = 10;

function shareAttachment(ctx: Ctx, source: ConvRow, row: MsgRow): Attachment {
  const author = row.user_id ? getUser(ctx, row.user_id) : undefined;
  const api = messageToApi(ctx, row);
  const name = row.username || (author ? author.display_name || author.real_name || author.name : 'Unknown');
  const plain = [row.text, api.blocks ? blocksToPlainText(api.blocks) : ''].filter(Boolean).join(' ').trim();
  const attachment: Attachment = {
    fallback: `[${new Date(Number(row.ts) * 1000).toISOString().slice(0, 16).replace('T', ' ')}] ${name}: ${plain}`.slice(0, 500),
    text: row.text,
    author_id: row.user_id ?? undefined,
    author_name: name,
    author_icon: author ? avatarUrl(ctx, author, 48) : undefined,
    mrkdwn_in: ['text'],
    color: 'D0D0D0',
    from_url: permalink(ctx, source, row),
    is_msg_unfurl: true,
    is_share: true,
    channel_id: source.id,
    ts: row.ts,
    footer: source.kind === 'im' || source.kind === 'mpim' ? 'From a direct message' : `Posted in #${source.name}`,
  };
  if (source.kind === 'public' || source.kind === 'private') attachment.channel_name = source.name;
  if (api.blocks?.length) {
    attachment.message_blocks = [{ team: ctx.requireTeam().id, channel: source.id, ts: row.ts, message: { blocks: api.blocks } }];
  }
  if (api.files?.length) attachment.files = api.files;
  return attachment;
}

function targets(ctx: Ctx, actor: Actor, ids: string[]): ConvRow[] {
  if (ids.length === 0) fail('invalid_arguments', { needed: 'to' });
  if (ids.length > MAX_TARGETS) fail('too_many_targets');
  const out: ConvRow[] = [];
  for (const id of new Set(ids)) {
    const conv = resolveConv(ctx, actor, id);
    requirePostable(ctx, conv, actor);
    out.push(conv);
  }
  return out;
}

export function registerShare(registry: Registry): void {
  /** Share a message into up to ten conversations, with an optional comment. */
  registry.add('client.messages.share', { auth: 'session' }, ({ ctx, actor, args }) => {
    const source = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    if (!canSee(ctx, source, actor.userId)) fail('channel_not_found');
    const row = getMessage(ctx, source.id, args.reqTs('ts'));
    if (!row || row.subtype === 'tombstone') fail('message_not_found');
    const comment = (args.str('text') ?? '').trim();
    if (comment.length > MAX_TEXT_LENGTH) fail('msg_too_long');
    const attachment = shareAttachment(ctx, source, row);
    const posted = [];
    for (const conv of targets(ctx, actor, args.list('to'))) {
      const message = postMessage(ctx, { conv, userId: actor.userId, text: comment, attachments: [attachment] });
      posted.push({ channel: conv.id, ts: message.ts });
    }
    return { shared: posted };
  });

  /** Share an existing file into another conversation. */
  registry.add('client.files.share', { auth: 'session' }, ({ ctx, actor, args }) => {
    const file = getFile(ctx, args.req('file', 'file_not_found'));
    if (!file || file.state === 'pending' || !canAccessFile(ctx, file, actor.userId)) fail('file_not_found');
    const comment = (args.str('text') ?? '').trim();
    const posted = [];
    for (const conv of targets(ctx, actor, args.list('to'))) {
      const message = postMessage(ctx, { conv, userId: actor.userId, text: comment, fileIds: [file.id], eventExtra: { subtype: 'file_share' } });
      posted.push({ channel: conv.id, ts: message.ts });
    }
    return { shared: posted };
  });
}
