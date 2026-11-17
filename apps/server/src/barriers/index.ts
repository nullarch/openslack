import type { Kernel } from '../app.ts';
import { memberIds, resolveConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, nowSeconds } from '../core/ids.ts';
import { messageGuards } from '../core/messages.ts';
import type { Ctx } from '../ctx.ts';

/**
 * Information barriers (Slack's `admin.barriers.*`): members of one user
 * group may not open direct messages, group messages or calls with members of
 * the groups it is barriered from. Membership is read when it matters, so
 * changing a group changes who is kept apart. Existing direct conversations
 * between them can no longer be written in or called from.
 */

type Subject = 'im' | 'mpim' | 'call';
const SUBJECTS: Subject[] = ['im', 'mpim', 'call'];

interface BarrierRow {
  id: string;
  primary_usergroup_id: string;
  barriered_from: string;
  restricted_subjects: string;
  created_by: string;
  date_update: number;
}

function groupMembers(ctx: Ctx, groupId: string): Set<string> {
  return new Set(ctx.db.all<{ user_id: string }>('SELECT user_id FROM usergroup_members WHERE usergroup_id = ?', groupId).map((row) => row.user_id));
}

/** Whether any two of these people are kept apart for this kind of conversation. */
export function barrierBetween(ctx: Ctx, people: string[], subject: Subject): boolean {
  if (people.length < 2) return false;
  for (const barrier of ctx.db.all<BarrierRow>('SELECT * FROM barriers')) {
    if (!(JSON.parse(barrier.restricted_subjects) as string[]).includes(subject)) continue;
    const primary = groupMembers(ctx, barrier.primary_usergroup_id);
    const others = new Set<string>();
    for (const id of JSON.parse(barrier.barriered_from) as string[]) for (const user of groupMembers(ctx, id)) others.add(user);
    const inPrimary = people.filter((person) => primary.has(person));
    const inOthers = people.filter((person) => others.has(person));
    if (inPrimary.some((a) => inOthers.some((b) => a !== b))) return true;
  }
  return false;
}

export function installBarriers(kernel: Kernel): void {
  const { ctx, registry } = kernel;

  const groupName = (id: string): string => ctx.db.get<{ name: string }>('SELECT name FROM usergroups WHERE id = ?', id)?.name ?? '';
  const toApi = (row: BarrierRow): Record<string, unknown> => ({
    id: row.id,
    enterprise_id: ctx.requireTeam().id,
    primary_usergroup: { id: row.primary_usergroup_id, name: groupName(row.primary_usergroup_id) },
    barriered_from_usergroups: (JSON.parse(row.barriered_from) as string[]).map((id) => ({ id, name: groupName(id) })),
    restricted_subjects: JSON.parse(row.restricted_subjects) as string[],
    date_update: row.date_update,
  });

  const readGroups = (value: string[]): string[] => {
    for (const id of value) if (!ctx.db.get('SELECT 1 FROM usergroups WHERE id = ? AND date_delete = 0', id)) fail('invalid_usergroup', { id });
    return [...new Set(value)];
  };
  const readSubjects = (value: string[]): Subject[] => {
    const subjects = value.length ? value : SUBJECTS;
    if (subjects.some((subject) => !SUBJECTS.includes(subject as Subject))) fail('invalid_restricted_subjects');
    return [...new Set(subjects)] as Subject[];
  };

  registry.add('admin.barriers.list', { auth: 'admin', scopes: ['admin.barriers:read'] }, () => ({
    barriers: ctx.db.all<BarrierRow>('SELECT * FROM barriers ORDER BY date_update DESC').map(toApi),
    response_metadata: { next_cursor: '' },
  }));

  registry.add('admin.barriers.create', { auth: 'admin', scopes: ['admin.barriers:write'] }, ({ actor, args }) => {
    const primary = readGroups([args.req('primary_usergroup_id', 'invalid_usergroup')])[0]!;
    const others = readGroups(args.list('barriered_from_usergroup_ids'));
    if (others.length === 0 || others.includes(primary)) fail('invalid_arguments', { arg: 'barriered_from_usergroup_ids' });
    const subjects = readSubjects(args.list('restricted_subjects'));
    if (ctx.db.get('SELECT 1 FROM barriers WHERE primary_usergroup_id = ?', primary)) fail('barrier_already_exists');
    const id = newId('BR');
    ctx.db.run('INSERT INTO barriers (id, primary_usergroup_id, barriered_from, restricted_subjects, created_by, date_update) VALUES (?, ?, ?, ?, ?, ?)', id, primary, JSON.stringify(others), JSON.stringify(subjects), actor.userId, nowSeconds());
    return { barrier: toApi(ctx.db.get<BarrierRow>('SELECT * FROM barriers WHERE id = ?', id)!) };
  });

  registry.add('admin.barriers.update', { auth: 'admin', scopes: ['admin.barriers:write'] }, ({ args }) => {
    const row = ctx.db.get<BarrierRow>('SELECT * FROM barriers WHERE id = ?', args.req('barrier_id', 'barrier_not_found'));
    if (!row) fail('barrier_not_found');
    const primary = args.has('primary_usergroup_id') ? readGroups([args.req('primary_usergroup_id')])[0]! : row.primary_usergroup_id;
    const others = args.has('barriered_from_usergroup_ids') ? readGroups(args.list('barriered_from_usergroup_ids')) : (JSON.parse(row.barriered_from) as string[]);
    const subjects = args.has('restricted_subjects') ? readSubjects(args.list('restricted_subjects')) : (JSON.parse(row.restricted_subjects) as Subject[]);
    ctx.db.run('UPDATE barriers SET primary_usergroup_id = ?, barriered_from = ?, restricted_subjects = ?, date_update = ? WHERE id = ?', primary, JSON.stringify(others), JSON.stringify(subjects), nowSeconds(), row.id);
    return { barrier: toApi(ctx.db.get<BarrierRow>('SELECT * FROM barriers WHERE id = ?', row.id)!) };
  });

  registry.add('admin.barriers.delete', { auth: 'admin', scopes: ['admin.barriers:write'] }, ({ args }) => {
    if (ctx.db.run('DELETE FROM barriers WHERE id = ?', args.req('barrier_id', 'barrier_not_found')).changes === 0) fail('barrier_not_found');
  });

  // Opening a direct or group conversation across a barrier.
  const open = registry.get('conversations.open')!;
  const openHandler = open.handler;
  open.handler = (call) => {
    const users = call.args.list('users');
    if (users.length) {
      const people = [...new Set([call.actor.userId, ...users])];
      if (barrierBetween(ctx, people, people.length > 2 ? 'mpim' : 'im')) fail('restricted_action', { detail: 'information_barrier' });
    }
    return openHandler(call);
  };

  // Writing in one that already exists.
  // Hook lists are shared by every server in the process: always use the context passed in.
  messageGuards.push((ctx2, input) => {
    if (input.conv.kind !== 'im' && input.conv.kind !== 'mpim') return;
    const people = memberIds(ctx2, input.conv.id);
    if (barrierBetween(ctx2, people, input.conv.kind)) fail('restricted_action', { detail: 'information_barrier' });
  });

  // Calling in one.
  const join = registry.get('client.huddles.join');
  if (join) {
    const joinHandler = join.handler;
    join.handler = (call) => {
      const conv = resolveConv(ctx, call.actor, call.args.str('channel'));
      if ((conv.kind === 'im' || conv.kind === 'mpim') && barrierBetween(ctx, memberIds(ctx, conv.id), 'call')) fail('restricted_action', { detail: 'information_barrier' });
      return joinHandler(call);
    };
  }
}
