import type { Ctx } from '../ctx.ts';

/**
 * Templates for new canvases and lists. Built-in ones ship with the server;
 * anyone can save a canvas or list as a template for the whole workspace
 * ("Save as template"), stored in `doc_templates`.
 */

export interface CanvasBody {
  markdown: string;
}

export interface ListBody {
  schema: unknown[];
  items?: Record<string, unknown>[];
  description?: string;
  todo?: boolean;
}

export interface Template {
  id: string;
  kind: 'canvas' | 'list';
  title: string;
  description: string;
  builtin: boolean;
  created_by: string | null;
  body: CanvasBody | ListBody;
}

const STATUS = (choices: string[]): { choices: { value: string; label: string; color: string }[] } => ({
  choices: choices.map((label, index) => ({ value: label.toLowerCase().replace(/\s+/g, '_'), label, color: ['gray', 'blue', 'yellow', 'green', 'red', 'purple'][index % 6]! })),
});

export const BUILTIN_TEMPLATES: Template[] = [
  {
    id: 'TPLmeeting',
    kind: 'canvas',
    title: 'Meeting notes',
    description: 'Agenda, notes, decisions and action items for one meeting.',
    builtin: true,
    created_by: null,
    body: {
      markdown: [
        '# Meeting notes',
        '**Date:** ',
        '**Attendees:** ',
        '## Agenda',
        '- ',
        '## Notes',
        '',
        '## Decisions',
        '- ',
        '## Action items',
        '- [ ] ',
      ].join('\n'),
    },
  },
  {
    id: 'TPLbrief',
    kind: 'canvas',
    title: 'Project brief',
    description: 'Why, what and when: goals, scope, people and milestones.',
    builtin: true,
    created_by: null,
    body: {
      markdown: [
        '# Project brief',
        '## Summary',
        'One or two sentences on what this project is.',
        '## Goals',
        '- ',
        '## Out of scope',
        '- ',
        '## People',
        '| Role | Person |',
        '| --- | --- |',
        '| Owner | |',
        '| Reviewer | |',
        '## Milestones',
        '- [ ] Kickoff',
        '- [ ] First version',
        '- [ ] Launch',
        '## Links',
        '- ',
      ].join('\n'),
    },
  },
  {
    id: 'TPLbugs',
    kind: 'list',
    title: 'Bug tracker',
    description: 'Report, assign and follow bugs to done.',
    builtin: true,
    created_by: null,
    body: {
      schema: [
        { key: 'title', name: 'Bug', type: 'text' },
        { key: 'status', name: 'Status', type: 'select', options: STATUS(['New', 'Triaged', 'In progress', 'Fixed', "Won't fix"]) },
        { key: 'severity', name: 'Severity', type: 'select', options: STATUS(['Low', 'Medium', 'High', 'Critical']) },
        { key: 'assignee', name: 'Assignee', type: 'user' },
        { key: 'due', name: 'Due', type: 'date' },
        { key: 'link', name: 'Link', type: 'link' },
      ],
    },
  },
  {
    id: 'TPLonboarding',
    kind: 'list',
    title: 'Onboarding checklist',
    description: 'Everything a new teammate needs in their first weeks.',
    builtin: true,
    created_by: null,
    body: {
      schema: [
        { key: 'task', name: 'Task', type: 'text' },
        { key: 'done', name: 'Done', type: 'checkbox' },
        { key: 'owner', name: 'Owner', type: 'user' },
        { key: 'week', name: 'Week', type: 'select', options: STATUS(['Week 1', 'Week 2', 'Week 3', 'Week 4']) },
        { key: 'due', name: 'Due', type: 'date' },
      ],
      items: [
        { task: 'Set up your laptop and accounts', week: 'Week 1' },
        { task: 'Read the team handbook', week: 'Week 1' },
        { task: 'Meet your onboarding buddy', week: 'Week 1' },
        { task: 'Ship a first small change', week: 'Week 2' },
        { task: 'Join the on-call rotation as a shadow', week: 'Week 3' },
        { task: 'Thirty-day check-in', week: 'Week 4' },
      ],
    },
  },
];

interface TemplateRow {
  id: string;
  kind: 'canvas' | 'list';
  title: string;
  description: string;
  body: string;
  created_by: string;
  created: number;
}

export function listTemplates(ctx: Ctx, kind?: 'canvas' | 'list'): Template[] {
  const saved = ctx.db
    .all<TemplateRow>(`SELECT * FROM doc_templates ${kind ? 'WHERE kind = ?' : ''} ORDER BY created DESC LIMIT 200`, ...(kind ? [kind] : []))
    .map((row): Template => ({ id: row.id, kind: row.kind, title: row.title, description: row.description, builtin: false, created_by: row.created_by, body: JSON.parse(row.body) as CanvasBody | ListBody }));
  return [...BUILTIN_TEMPLATES.filter((template) => !kind || template.kind === kind), ...saved];
}

export function getTemplate(ctx: Ctx, id: string): Template | undefined {
  return listTemplates(ctx).find((template) => template.id === id);
}
