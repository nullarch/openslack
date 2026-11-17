import type { IncomingMessage, ServerResponse } from 'node:http';
import { Args, type Call } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { fail } from '../core/errors.ts';
import type { Actor } from '../ctx.ts';

/**
 * Channel templates: a new channel that starts with what that kind of channel
 * needs — a description, a canvas or list in its tabs, posting rules. Each
 * step is an ordinary API method run as the person creating the channel, so
 * the usual permissions, events and audit entries apply. Templates with a
 * step only admins may take (posting rules) are offered to admins only.
 */

type Step =
  | { method: 'conversations.setPurpose'; purpose: string }
  | { method: 'client.docs.create'; kind: 'canvas' | 'list'; title: string; template_id?: string }
  | { method: 'client.conversations.setPostingPolicy'; post: 'admins' }
  | { method: 'chat.postMessage'; text: string };

interface ChannelTemplate {
  id: string;
  name: string;
  description: string;
  /** Short names of what the channel starts with, for the picker. */
  includes: string[];
  /** Only admins may use it (it restricts posting). */
  adminOnly?: boolean;
  steps: Step[];
}

export const CHANNEL_TEMPLATES: ChannelTemplate[] = [
  {
    id: 'project',
    name: 'Project',
    description: 'Plan the work, track tasks and keep decisions in one place.',
    includes: ['Project brief canvas', 'Tasks list'],
    steps: [
      { method: 'conversations.setPurpose', purpose: 'Planning and progress for this project. The brief and the task list are in the tabs above.' },
      { method: 'client.docs.create', kind: 'canvas', title: 'Project brief', template_id: 'TPLbrief' },
      { method: 'client.docs.create', kind: 'list', title: 'Tasks' },
    ],
  },
  {
    id: 'help-requests',
    name: 'Help requests',
    description: 'One place to ask a team for help, with requests tracked to done.',
    includes: ['Requests list', 'How to ask canvas'],
    steps: [
      { method: 'conversations.setPurpose', purpose: 'Ask for help here. Each request is tracked in the Requests list until it is done.' },
      { method: 'client.docs.create', kind: 'list', title: 'Requests' },
      { method: 'client.docs.create', kind: 'canvas', title: 'How to ask for help' },
      { method: 'chat.postMessage', text: 'Welcome! Describe what you need, what you tried and how urgent it is. We track every request in the *Requests* list above.' },
    ],
  },
  {
    id: 'team',
    name: 'Team',
    description: 'Day-to-day coordination for a team, with notes from its meetings.',
    includes: ['Meeting notes canvas'],
    steps: [
      { method: 'conversations.setPurpose', purpose: 'Where the team coordinates. Meeting notes are in the tabs above.' },
      { method: 'client.docs.create', kind: 'canvas', title: 'Meeting notes', template_id: 'TPLmeeting' },
    ],
  },
  {
    id: 'bugs',
    name: 'Bug triage',
    description: 'Report bugs, agree on severity and follow them to a fix.',
    includes: ['Bug tracker list'],
    steps: [
      { method: 'conversations.setPurpose', purpose: 'Report bugs here. Each one goes into the Bug tracker list with its severity and owner.' },
      { method: 'client.docs.create', kind: 'list', title: 'Bug tracker', template_id: 'TPLbugs' },
    ],
  },
  {
    id: 'onboarding',
    name: 'Onboarding',
    description: 'Welcome a new teammate with a checklist everyone can follow.',
    includes: ['Onboarding checklist'],
    steps: [
      { method: 'conversations.setPurpose', purpose: 'Getting a new teammate started. Work through the checklist in the tabs above.' },
      { method: 'client.docs.create', kind: 'list', title: 'Onboarding checklist', template_id: 'TPLonboarding' },
    ],
  },
  {
    id: 'announcements',
    name: 'Announcements',
    description: 'News for everyone. Only admins post; everyone can reply in threads.',
    includes: ['Admins-only posting', 'Guidelines canvas'],
    adminOnly: true,
    steps: [
      { method: 'conversations.setPurpose', purpose: 'Announcements for everyone. Only admins post here; ask questions in threads.' },
      { method: 'client.conversations.setPostingPolicy', post: 'admins' },
      { method: 'client.docs.create', kind: 'canvas', title: 'Announcement guidelines' },
    ],
  },
];

export function installChannelTemplates(kernel: Kernel): void {
  const { ctx } = kernel;

  const invoke = async (name: string, actor: Actor, req: IncomingMessage, res: ServerResponse, raw: Record<string, unknown>): Promise<Record<string, unknown>> => {
    const def = kernel.registry.get(name);
    if (!def) fail('unknown_method', { method: name });
    return ((await def.handler({ ctx, actor, args: new Args(raw), req, res } as Call)) ?? {}) as Record<string, unknown>;
  };

  kernel.registry.add('client.channels.templates.list', { auth: 'session' }, ({ actor }) => ({
    templates: CHANNEL_TEMPLATES.filter((template) => !template.adminOnly || actor.role !== 'member').map(({ id, name, description, includes }) => ({ id, name, description, includes })),
  }));

  kernel.registry.add('client.channels.createFromTemplate', { auth: 'session' }, async ({ actor, args, req, res }) => {
    const template = CHANNEL_TEMPLATES.find((entry) => entry.id === args.req('template', 'template_not_found')) ?? fail('template_not_found');
    if (template.adminOnly && actor.role === 'member') fail('restricted_action');
    const created = await invoke('conversations.create', actor, req, res, { name: args.req('name', 'invalid_name_required'), is_private: args.bool('is_private') });
    const channel = (created.channel as { id: string }).id;
    const docs: unknown[] = [];
    for (const step of template.steps) {
      const { method, ...rest } = step;
      const result = await invoke(method, actor, req, res, { channel, ...rest });
      if (method === 'client.docs.create') docs.push(result.doc);
    }
    const info = await invoke('conversations.info', actor, req, res, { channel });
    return { channel: info.channel, docs };
  });
}
