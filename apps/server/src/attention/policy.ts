import type { Registry } from '../api/registry.ts';
import { fail } from '../core/errors.ts';
import type { MsgRow } from '../core/messages.ts';
import { isAdmin } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';

/**
 * Workspace rules for changing messages after they are sent, with Slack's
 * preference names: `msg_edit_window_mins` (-1 = any time) and
 * `allow_message_deletion` (`everyone` or `admins`). Admins are not limited;
 * apps may always edit their own messages.
 */

export interface MessagePolicy {
  msg_edit_window_mins: number;
  allow_message_deletion: 'everyone' | 'admins';
}

const DEFAULT_POLICY: MessagePolicy = { msg_edit_window_mins: -1, allow_message_deletion: 'everyone' };

function teamPrefs(ctx: Ctx): Record<string, unknown> {
  try {
    return JSON.parse(ctx.requireTeam().prefs) as Record<string, unknown>;
  } catch {
    return {};
  }
}

export function messagePolicy(ctx: Ctx): MessagePolicy {
  const prefs = teamPrefs(ctx);
  const window = Number(prefs.msg_edit_window_mins);
  return {
    msg_edit_window_mins: Number.isInteger(window) && window >= -1 ? window : DEFAULT_POLICY.msg_edit_window_mins,
    allow_message_deletion: prefs.allow_message_deletion === 'admins' ? 'admins' : 'everyone',
  };
}

export function checkEdit(ctx: Ctx, actor: Actor, row: MsgRow): void {
  if (isAdmin(actor) || actor.isBot || row.bot_id) return;
  const window = messagePolicy(ctx).msg_edit_window_mins;
  if (window < 0) return;
  if (Date.now() / 1000 - Number(row.ts) > window * 60) fail('edit_window_closed');
}

export function checkDelete(ctx: Ctx, actor: Actor, row: MsgRow): void {
  if (isAdmin(actor) || actor.isBot || row.bot_id) return;
  if (messagePolicy(ctx).allow_message_deletion === 'admins') fail('cant_delete_message');
}

export function registerPolicy(registry: Registry): void {
  registry.add('client.admin.setMessagePolicy', { auth: 'admin' }, ({ ctx, args }) => {
    const prefs = teamPrefs(ctx);
    if (args.has('msg_edit_window_mins')) {
      const window = args.int('msg_edit_window_mins', -1);
      if (window < -1 || window > 60 * 24 * 365) fail('invalid_arguments', { needed: 'msg_edit_window_mins' });
      prefs.msg_edit_window_mins = window;
    }
    if (args.has('allow_message_deletion')) {
      const value = args.req('allow_message_deletion');
      if (value !== 'everyone' && value !== 'admins') fail('invalid_arguments', { needed: 'allow_message_deletion' });
      prefs.allow_message_deletion = value;
    }
    ctx.db.run('UPDATE team SET prefs = ? WHERE id = ?', JSON.stringify(prefs), ctx.requireTeam().id);
    ctx.invalidateTeam();
    const policy = messagePolicy(ctx);
    ctx.bus.emit({ event: { type: 'message_policy_changed', policy }, audience: { all: true }, clientOnly: true });
    return { policy };
  });
}
