import type { Kernel } from '../app.ts';
import { requirePostable } from '../api/methods/chat.ts';
import type { Args } from '../api/registry.ts';
import { canSee, getConv, resolveConv, type ConvRow } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Featured workflows (`workflows.featured.*`): link workflows pinned to a
 * channel so people find and start them there. Slack names a link trigger
 * `Ft…`; here that is `Ft` + the workflow's id. Shown in the channel's
 * bookmarks bar.
 */

const MAX_FEATURED = 15;
const TRIGGER = /^Ft(Wf[A-Z0-9]+)$/;

interface Row {
  conversation_id: string;
  workflow_id: string;
  position: number;
}

function triggerIds(args: Args): string[] {
  const raw = args.raw.trigger_ids;
  const list = Array.isArray(raw) ? raw.map(String) : args.list('trigger_ids');
  return [...new Set(list.map((id) => id.trim()).filter(Boolean))];
}

/** The published link workflows behind these trigger ids, or the error Slack gives. */
function workflowIds(ctx: Ctx, ids: string[]): string[] {
  if (ids.length > MAX_FEATURED) fail('error_modifying_workflows', { detail: `at most ${MAX_FEATURED}` });
  return ids.map((id) => {
    const match = TRIGGER.exec(id);
    const workflow = match
      ? ctx.db.get<{ id: string; trigger: string }>("SELECT id, trigger FROM workflows WHERE id = ? AND status = 'published'", match[1])
      : undefined;
    if (!workflow || (JSON.parse(workflow.trigger) as { type?: string }).type !== 'link') fail('error_modifying_workflows', { detail: `not a published link trigger: ${id}` });
    return workflow.id;
  });
}

export function featuredIn(ctx: Ctx, conversationId: string): { id: string; title: string; link: string | null }[] {
  return ctx.db
    .all<{ workflow_id: string; name: string; link_token: string | null }>(
      "SELECT f.workflow_id, w.name, w.link_token FROM featured_workflows f JOIN workflows w ON w.id = f.workflow_id WHERE f.conversation_id = ? AND w.status = 'published' ORDER BY f.position",
      conversationId,
    )
    .map((row) => ({ id: `Ft${row.workflow_id}`, title: row.name, link: row.link_token }));
}

export function installFeaturedWorkflows(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  const target = (actor: Parameters<typeof resolveConv>[1], args: Args): ConvRow => {
    const conv = resolveConv(ctx, actor, args.req('channel_id', 'channel_not_found'));
    requirePostable(ctx, conv, actor);
    return conv;
  };
  const changed = (conv: ConvRow): void => {
    ctx.bus.emit({
      event: { type: 'featured_workflows_changed', channel: conv.id, featured: featuredIn(ctx, conv.id), event_ts: ctx.clock.eventTs() },
      audience: conv.kind === 'public' ? { all: true } : { conversation: conv.id },
      clientOnly: true,
    });
  };
  const write = (conv: ConvRow, ids: string[], userId: string): void => {
    ctx.db.tx(() => {
      ctx.db.run('DELETE FROM featured_workflows WHERE conversation_id = ?', conv.id);
      ids.forEach((id, position) => ctx.db.run('INSERT INTO featured_workflows (conversation_id, workflow_id, position, added_by) VALUES (?, ?, ?, ?)', conv.id, id, position, userId));
    });
    changed(conv);
  };
  const current = (conv: ConvRow): string[] =>
    ctx.db.all<Row>('SELECT * FROM featured_workflows WHERE conversation_id = ? ORDER BY position', conv.id).map((row) => row.workflow_id);

  registry.add('workflows.featured.add', { scopes: ['bookmarks:write'] }, ({ actor, args }) => {
    const conv = target(actor, args);
    const adding = workflowIds(ctx, triggerIds(args));
    if (adding.length === 0) fail('invalid_arguments', { needed: 'trigger_ids' });
    const next = [...new Set([...current(conv), ...adding])];
    if (next.length > MAX_FEATURED) fail('error_modifying_workflows', { detail: `at most ${MAX_FEATURED} per channel` });
    write(conv, next, actor.userId);
  });

  registry.add('workflows.featured.remove', { scopes: ['bookmarks:write'] }, ({ actor, args }) => {
    const conv = target(actor, args);
    const removing = new Set(triggerIds(args).map((id) => TRIGGER.exec(id)?.[1] ?? id));
    if (removing.size === 0) fail('invalid_arguments', { needed: 'trigger_ids' });
    write(conv, current(conv).filter((id) => !removing.has(id)), actor.userId);
  });

  registry.add('workflows.featured.set', { scopes: ['bookmarks:write'] }, ({ actor, args }) => {
    const conv = target(actor, args);
    // An empty list clears the channel's featured workflows.
    write(conv, workflowIds(ctx, triggerIds(args)), actor.userId);
  });

  registry.add('workflows.featured.list', { scopes: ['bookmarks:read'] }, ({ actor, args }) => {
    const raw = args.raw.channel_ids;
    const ids = Array.isArray(raw) ? raw.map(String) : args.list('channel_ids');
    if (ids.length === 0 || ids.length > 100) fail('error_invalid_channels');
    return {
      featured_workflows: ids.map((id) => {
        const conv = getConv(ctx, id);
        if (!conv || !canSee(ctx, conv, actor.userId)) fail('channel_not_found');
        return { channel_id: conv.id, triggers: featuredIn(ctx, conv.id).map(({ id: triggerId, title }) => ({ id: triggerId, title })) };
      }),
    };
  });

  // What the web client shows in the bookmarks bar, with the link to start each one.
  registry.add('client.workflows.featured', { auth: 'session' }, ({ actor, args }) => {
    const conv = resolveConv(ctx, actor, args.req('channel', 'channel_not_found'));
    return { featured: featuredIn(ctx, conv.id) };
  });

  registry.add('team.billing.info', { scopes: ['team.billing:read'] }, () => {
    if (!ctx.team()) fail('invalid_team');
    // No plan limits on this server: the closest of Slack's plans.
    return { plan: 'plus' };
  });
}
