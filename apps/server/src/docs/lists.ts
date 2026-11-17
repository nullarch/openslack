import type { Kernel } from '../app.ts';
import { sendJson } from '../api/http.ts';
import type { Registry } from '../api/registry.ts';
import { addActivity } from '../attention/activity.ts';
import { authenticate } from '../core/auth.ts';
import { getConv } from '../core/conversations.ts';
import { fail } from '../core/errors.ts';
import { newId, newSecret, nowSeconds } from '../core/ids.ts';
import { getUser } from '../core/users.ts';
import type { Actor, Ctx } from '../ctx.ts';
import { accessList, accessOf, canWrite, emitDocChanged, getDoc, grant, reindex, requireDoc, revoke, permalink, type DocRow, type Level } from './access.ts';
import { hostConversation } from './canvases.ts';

/**
 * Lists: structured trackers. A list has a schema of typed columns and items
 * whose fields are keyed by column id. The API follows Slack's `slackLists.*`
 * shapes: a field is `{ column_id, <type>: value }`, where the value key names
 * the column's type (`rich_text`, `number`, `select`, `user`, `date`,
 * `checkbox`, `link`, `rating`, `email`, `phone`, `channel`).
 */

const READ = ['lists:read', 'lists:write'];
const WRITE = ['lists:write'];
const MAX_COLUMNS = 40;
const MAX_ITEMS = 5000;

export type ColumnType = 'text' | 'number' | 'select' | 'user' | 'date' | 'checkbox' | 'link' | 'rating' | 'email' | 'phone' | 'channel';
const TYPES: ColumnType[] = ['text', 'number', 'select', 'user', 'date', 'checkbox', 'link', 'rating', 'email', 'phone', 'channel'];
/** The key a field's value goes under, per column type. */
const VALUE_KEY: Record<ColumnType, string> = {
  text: 'rich_text',
  number: 'number',
  select: 'select',
  user: 'user',
  date: 'date',
  checkbox: 'checkbox',
  link: 'link',
  rating: 'rating',
  email: 'email',
  phone: 'phone',
  channel: 'channel',
};

export interface Choice {
  value: string;
  label: string;
  color: string;
}

export interface Column {
  id: string;
  key: string;
  name: string;
  type: ColumnType;
  is_primary_column?: boolean;
  options?: {
    choices?: Choice[];
    format?: string;
    max?: number;
    precision?: number;
    notify_users?: boolean;
    [key: string]: unknown;
  };
}

export interface ListExtra {
  schema: Column[];
  description: string;
  todo_mode: boolean;
}

interface ItemRow {
  id: string;
  doc_id: string;
  parent_id: string | null;
  position: number;
  fields: string;
  archived: number;
  created: number;
  created_by: string;
  updated: number;
  updated_by: string;
}

type Values = Record<string, unknown>;

export function listExtra(doc: DocRow): ListExtra {
  try {
    const parsed = JSON.parse(doc.extra) as Partial<ListExtra>;
    return { schema: parsed.schema ?? [], description: parsed.description ?? '', todo_mode: Boolean(parsed.todo_mode) };
  } catch {
    return { schema: [], description: '', todo_mode: false };
  }
}

// ── Schema ──────────────────────────────────────────────────────────────────

const COLORS = ['blue', 'green', 'yellow', 'orange', 'red', 'purple', 'pink', 'gray'];

/** Check a schema sent by a caller; keep ids of columns that already exist. */
export function readSchema(input: unknown, previous: Column[] = [], todo = false): Column[] {
  const raw = Array.isArray(input) ? input : [];
  if (raw.length > MAX_COLUMNS) fail('invalid_schema', { detail: `at most ${MAX_COLUMNS} columns` });
  const byKey = new Map(previous.map((column) => [column.key, column]));
  const byId = new Map(previous.map((column) => [column.id, column]));
  const seen = new Set<string>();
  const columns = raw.map((entry, index): Column => {
    const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
    const name = String(item.name ?? '').trim().slice(0, 80);
    const type = String(item.type ?? 'text') as ColumnType;
    if (!name) fail('invalid_schema', { detail: `column ${index + 1} has no name` });
    if (!TYPES.includes(type)) fail('invalid_schema', { detail: `column ${name}: unknown type ${type}` });
    const key = String(item.key ?? name).toLowerCase().replace(/[^a-z0-9_]+/g, '_').replace(/^_+|_+$/g, '').slice(0, 40) || `col_${index}`;
    if (seen.has(key)) fail('invalid_schema', { detail: `duplicate column key ${key}` });
    seen.add(key);
    const before = (typeof item.id === 'string' ? byId.get(item.id) : undefined) ?? byKey.get(key);
    const options = (item.options && typeof item.options === 'object' ? { ...(item.options as Record<string, unknown>) } : {}) as NonNullable<Column['options']>;
    if (type === 'select') {
      const choices = Array.isArray(options.choices) ? options.choices : [];
      options.choices = choices.slice(0, 100).map((choice, n) => {
        const c = (choice && typeof choice === 'object' ? choice : { label: String(choice) }) as Partial<Choice>;
        const label = String(c.label ?? c.value ?? '').slice(0, 80) || `Option ${n + 1}`;
        return { value: String(c.value ?? label).slice(0, 80), label, color: String(c.color ?? COLORS[n % COLORS.length]) };
      });
    }
    if (type === 'rating') options.max = Math.max(1, Math.min(10, Number(options.max ?? 5)));
    if (type === 'user' && options.notify_users === undefined) options.notify_users = true;
    return { id: before?.id ?? newId('Col', 9), key, name, type, is_primary_column: false, options };
  });
  if (columns.length === 0) columns.push({ id: newId('Col', 9), key: 'name', name: 'Name', type: 'text', is_primary_column: true, options: {} });
  // The first text column is the primary one: it names the item.
  const primary = columns.find((column) => column.type === 'text') ?? columns[0]!;
  for (const column of columns) column.is_primary_column = column === primary;
  if (todo) {
    const add = (key: string, name: string, type: ColumnType, options: Column['options'] = {}): void => {
      if (!columns.some((column) => column.key === key)) columns.push({ id: byKey.get(key)?.id ?? newId('Col', 9), key, name, type, is_primary_column: false, options });
    };
    add('todo_completed', 'Completed', 'checkbox');
    add('todo_assignee', 'Assignee', 'user', { notify_users: true });
    add('todo_due_date', 'Due date', 'date');
  }
  return columns;
}

// ── Values ──────────────────────────────────────────────────────────────────

function richText(text: string): unknown[] {
  return [{ type: 'rich_text', elements: [{ type: 'rich_text_section', elements: [{ type: 'text', text }] }] }];
}

function plainOfRich(value: unknown): string {
  const parts: string[] = [];
  const visit = (node: unknown): void => {
    if (Array.isArray(node)) node.forEach(visit);
    else if (node && typeof node === 'object') {
      const record = node as Record<string, unknown>;
      if (typeof record.text === 'string' && record.type === 'text') parts.push(record.text);
      else if (record.type === 'user' && typeof record.user_id === 'string') parts.push(`<@${record.user_id}>`);
      else if (record.type === 'link' && typeof record.url === 'string') parts.push(String(record.text ?? record.url));
      for (const value of Object.values(record)) if (value && typeof value === 'object') visit(value);
    }
  };
  visit(value);
  return parts.join('');
}

const asArray = (value: unknown): unknown[] => (Array.isArray(value) ? value : value === undefined || value === null || value === '' ? [] : [value]);

/** A plain string may hold several values ("U1, U2" or "<@U1> <@U2>"), as workflow steps send them. */
const splitIds = (value: unknown): unknown[] =>
  typeof value === 'string' ? value.split(/[\s,]+/).map((part) => part.replace(/^<[@#]|[|>].*$/g, '')).filter(Boolean) : asArray(value);

/**
 * Normalise one value for a column, from Slack's field shape (`{ select: [...] }`)
 * or a plain value (`'Done'`, `3`, `['U123']`). Returns undefined to clear.
 */
export function readValue(ctx: Ctx, column: Column, input: unknown): unknown {
  switch (column.type) {
    case 'text': {
      if (typeof input === 'string') return input ? richText(input.slice(0, 10_000)) : undefined;
      if (Array.isArray(input)) return input.length ? input : undefined;
      return undefined;
    }
    case 'number':
    case 'rating': {
      const values = asArray(input).map(Number).filter((n) => Number.isFinite(n));
      if (column.type === 'rating') return values.length ? [Math.max(0, Math.min(column.options?.max ?? 5, Math.round(values[0]!)))] : undefined;
      return values.length ? [values[0]] : undefined;
    }
    case 'select': {
      const choices = column.options?.choices ?? [];
      const raw = typeof input === 'string' && column.options?.format === 'multi_select' ? input.split(',').map((part) => part.trim()).filter(Boolean) : asArray(input);
      const values = raw
        .map((value) => String(value))
        .map((value) => choices.find((choice) => choice.value === value || choice.label.toLowerCase() === value.toLowerCase())?.value)
        .filter((value): value is string => Boolean(value));
      if (raw.length && !values.length) fail('invalid_value', { detail: `${column.name}: unknown option` });
      return values.length ? (column.options?.format === 'multi_select' ? [...new Set(values)] : [values[0]]) : undefined;
    }
    case 'user': {
      const ids = splitIds(input).map(String);
      for (const id of ids) if (!getUser(ctx, id)) fail('invalid_value', { detail: `${column.name}: unknown user ${id}` });
      return ids.length ? [...new Set(ids)] : undefined;
    }
    case 'channel': {
      const ids = splitIds(input).map(String);
      for (const id of ids) if (!getConv(ctx, id)) fail('invalid_value', { detail: `${column.name}: unknown channel ${id}` });
      return ids.length ? ids : undefined;
    }
    case 'date': {
      const dates = asArray(input).map(String);
      for (const date of dates) if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) fail('invalid_value', { detail: `${column.name}: dates are YYYY-MM-DD` });
      return dates.length ? [dates[0]] : undefined;
    }
    case 'checkbox':
      return input === true || input === 'true' || input === 1 || (Array.isArray(input) && input[0] === true) ? true : input === undefined ? undefined : false;
    case 'link': {
      const links = asArray(input).map((entry) => {
        const link = (typeof entry === 'string' ? { original_url: entry } : entry) as Record<string, unknown>;
        const url = String(link.original_url ?? link.url ?? '');
        if (!/^https?:\/\//.test(url)) fail('invalid_value', { detail: `${column.name}: links must be http(s) URLs` });
        return { original_url: url, display_as_url: link.display_as_url !== false, display_name: String(link.display_name ?? '') };
      });
      return links.length ? links : undefined;
    }
    case 'email':
    case 'phone': {
      const values = asArray(input).map(String).filter(Boolean);
      return values.length ? values : undefined;
    }
  }
}

/** Read Slack-shaped fields (`[{ column_id, select: [...] }]`) or a plain object keyed by column key or id. */
export function readFields(ctx: Ctx, schema: Column[], input: unknown): Values {
  const out: Values = {};
  const find = (ref: string): Column =>
    schema.find((column) => column.id === ref || column.key === ref) ??
    schema.find((column) => column.name.toLowerCase() === ref.toLowerCase()) ??
    fail('invalid_value', { detail: `unknown column ${ref}` });
  if (Array.isArray(input)) {
    for (const entry of input) {
      const field = (entry ?? {}) as Record<string, unknown>;
      const column = find(String(field.column_id ?? field.key ?? ''));
      const key = VALUE_KEY[column.type];
      const raw = field[key] ?? (column.type === 'text' ? field.text : undefined) ?? field.value;
      out[column.id] = readValue(ctx, column, raw);
    }
  } else if (input && typeof input === 'object') {
    for (const [ref, raw] of Object.entries(input as Record<string, unknown>)) {
      const column = find(ref);
      out[column.id] = readValue(ctx, column, raw);
    }
  }
  return out;
}

function fieldsToApi(schema: Column[], values: Values): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const column of schema) {
    const value = values[column.id];
    if (value === undefined) continue;
    const field: Record<string, unknown> = { column_id: column.id, key: column.key, [VALUE_KEY[column.type]]: value };
    if (column.type === 'text') field.text = plainOfRich(value);
    out.push(field);
  }
  return out;
}

function itemToApi(doc: DocRow, schema: Column[], row: ItemRow): Record<string, unknown> {
  const item: Record<string, unknown> = {
    id: row.id,
    list_id: doc.id,
    date_created: row.created,
    created_by: row.created_by,
    updated_by: row.updated_by,
    updated_timestamp: String(row.updated),
    fields: fieldsToApi(schema, JSON.parse(row.fields) as Values),
    position: row.position,
  };
  if (row.parent_id) item.parent_item_id = row.parent_id;
  if (row.archived) item.archived = true;
  return item;
}

export function listToApi(ctx: Ctx, doc: DocRow, level: Level | null): Record<string, unknown> {
  const extra = listExtra(doc);
  const out: Record<string, unknown> = {
    id: doc.id,
    name: doc.title,
    title: doc.title,
    created: doc.created,
    updated: doc.updated,
    user: doc.owner,
    updated_by: doc.updated_by,
    conversation_id: doc.conversation_id,
    permalink: permalink(ctx, doc),
    access_level: level,
    editable: canWrite(level),
    description: extra.description,
    list_metadata: {
      schema: extra.schema,
      views: [
        { id: 'View0', name: 'All items', type: 'table', is_locked: false, position: '0' },
        ...(extra.schema.some((column) => column.type === 'select') ? [{ id: 'View1', name: 'Board', type: 'board', is_locked: false, position: '1' }] : []),
      ],
      todo_mode: extra.todo_mode,
    },
    item_count: ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM list_items WHERE doc_id = ? AND archived = 0', doc.id)?.n ?? 0,
  };
  if (canWrite(level)) out.access = accessList(ctx, doc.id);
  return out;
}

// ── Changes ─────────────────────────────────────────────────────────────────

function refreshPlain(ctx: Ctx, doc: DocRow): void {
  const extra = listExtra(doc);
  const texts = [extra.description];
  for (const row of ctx.db.all<{ fields: string }>('SELECT fields FROM list_items WHERE doc_id = ? AND archived = 0 ORDER BY position LIMIT 2000', doc.id)) {
    const values = JSON.parse(row.fields) as Values;
    for (const column of extra.schema) {
      const value = values[column.id];
      if (value === undefined) continue;
      if (column.type === 'text') texts.push(plainOfRich(value));
      else if (column.type === 'select') texts.push(...(value as string[]).map((v) => column.options?.choices?.find((choice) => choice.value === v)?.label ?? v));
    }
  }
  ctx.db.run('UPDATE docs SET plain = ? WHERE id = ?', texts.join('\n').slice(0, 200_000), doc.id);
  reindex(ctx, doc.id);
}

/** Tell people newly put in a people column that notifies, if they can open the list. */
function notifyAssigned(ctx: Ctx, doc: DocRow, schema: Column[], itemId: string, before: Values, after: Values, editor: string): void {
  for (const column of schema) {
    if (column.type !== 'user' || column.options?.notify_users === false) continue;
    const old = new Set((before[column.id] as string[] | undefined) ?? []);
    for (const userId of (after[column.id] as string[] | undefined) ?? []) {
      if (old.has(userId) || userId === editor) continue;
      if (!accessOf(ctx, doc, userId)) continue;
      addActivity(ctx, userId, { kind: 'list_assigned', channel: doc.id, ts: itemId, actor: editor, detail: column.id });
    }
  }
}

function touchList(ctx: Ctx, doc: DocRow, userId: string): void {
  ctx.db.run('UPDATE docs SET updated = ?, updated_by = ? WHERE id = ?', nowSeconds(), userId, doc.id);
}

/**
 * Add an item to a list as `actor` (who must be able to edit it). Fields may be
 * Slack-shaped (`[{ column_id, select: ['done'] }]`) or a plain object keyed by
 * column key or id (`{ name: 'Fix login', status: 'In progress', assignee: ['U123'] }`).
 * Used by `slackLists.items.create` and by workflow steps.
 */
export function createListItem(ctx: Ctx, actor: Actor, listId: string, fields: unknown, options: { parentId?: string | null } = {}): Record<string, unknown> {
  const { doc } = requireDoc(ctx, listId, 'list', actor.userId, 'write');
  const schema = listExtra(doc).schema;
  const count = ctx.db.get<{ n: number }>('SELECT count(*) AS n FROM list_items WHERE doc_id = ?', doc.id)?.n ?? 0;
  if (count >= MAX_ITEMS) fail('list_full');
  const values = readFields(ctx, schema, fields);
  for (const key of Object.keys(values)) if (values[key] === undefined) delete values[key];
  if (options.parentId && !ctx.db.get('SELECT 1 FROM list_items WHERE id = ? AND doc_id = ?', options.parentId, doc.id)) fail('item_not_found');
  const position = (ctx.db.get<{ p: number | null }>('SELECT max(position) AS p FROM list_items WHERE doc_id = ?', doc.id)?.p ?? 0) + 1;
  const id = newId('Rec', 9);
  const now = nowSeconds();
  ctx.db.run(
    'INSERT INTO list_items (id, doc_id, parent_id, position, fields, created, created_by, updated, updated_by) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    id,
    doc.id,
    options.parentId ?? null,
    position,
    JSON.stringify(values),
    now,
    actor.userId,
    now,
    actor.userId,
  );
  touchList(ctx, doc, actor.userId);
  refreshPlain(ctx, doc);
  notifyAssigned(ctx, doc, schema, id, {}, values, actor.userId);
  emitDocChanged(ctx, doc, 'items', { item_id: id });
  return itemToApi(doc, schema, ctx.db.get<ItemRow>('SELECT * FROM list_items WHERE id = ?', id)!);
}

export interface NewList {
  owner: string;
  title: string;
  description?: string;
  schema?: unknown;
  todo?: boolean;
  conversation?: string | null;
  items?: unknown[];
}

export function createList(ctx: Ctx, input: NewList): DocRow {
  const id = newId('F');
  const now = nowSeconds();
  const extra: ListExtra = { schema: readSchema(input.schema, [], input.todo), description: (input.description ?? '').slice(0, 4000), todo_mode: Boolean(input.todo) };
  ctx.db.tx(() => {
    ctx.db.run(
      'INSERT INTO docs (id, kind, title, owner, conversation_id, created, updated, updated_by, extra) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
      id,
      'list',
      input.title.trim().slice(0, 255) || 'Untitled list',
      input.owner,
      input.conversation ?? null,
      now,
      now,
      input.owner,
      JSON.stringify(extra),
    );
    if (input.conversation) grant(ctx, id, input.conversation, 'write');
  });
  const doc = getDoc(ctx, id, 'list')!;
  if (input.items?.length) {
    const actor = { userId: input.owner, kind: 'session', role: 'member', isBot: false, appId: null, botId: null, scopes: null } as Actor;
    for (const fields of input.items) createListItem(ctx, actor, id, fields);
  }
  refreshPlain(ctx, doc);
  emitDocChanged(ctx, doc, 'created');
  return getDoc(ctx, id, 'list')!;
}

function requireItem(ctx: Ctx, doc: DocRow, id: string | undefined): ItemRow {
  return (id ? ctx.db.get<ItemRow>('SELECT * FROM list_items WHERE id = ? AND doc_id = ?', id, doc.id) : undefined) ?? fail('item_not_found');
}

function csvOf(ctx: Ctx, doc: DocRow, includeArchived: boolean): string {
  const schema = listExtra(doc).schema;
  const quote = (value: string): string => (/[",\n]/.test(value) ? `"${value.replace(/"/g, '""')}"` : value);
  const cell = (column: Column, value: unknown): string => {
    if (value === undefined) return '';
    switch (column.type) {
      case 'text':
        return plainOfRich(value);
      case 'select':
        return (value as string[]).map((v) => column.options?.choices?.find((choice) => choice.value === v)?.label ?? v).join('; ');
      case 'user':
        return (value as string[]).map((id) => getUser(ctx, id)?.real_name || id).join('; ');
      case 'channel':
        return (value as string[]).map((id) => `#${getConv(ctx, id)?.name ?? id}`).join('; ');
      case 'link':
        return (value as { original_url: string }[]).map((link) => link.original_url).join('; ');
      case 'checkbox':
        return value ? 'true' : 'false';
      default:
        return (value as unknown[]).join('; ');
    }
  };
  const lines = [schema.map((column) => quote(column.name)).join(',')];
  const rows = ctx.db.all<ItemRow>(`SELECT * FROM list_items WHERE doc_id = ? ${includeArchived ? '' : 'AND archived = 0'} ORDER BY position`, doc.id);
  for (const row of rows) {
    const values = JSON.parse(row.fields) as Values;
    lines.push(schema.map((column) => quote(cell(column, values[column.id]))).join(','));
  }
  return `${lines.join('\r\n')}\r\n`;
}

// ── Due dates ───────────────────────────────────────────────────────────────

/**
 * Tell assignees about items due on `today` (YYYY-MM-DD) that are not marked
 * done. Each item and date is announced once. Run on a timer and from tests.
 */
export function runDueSweep(ctx: Ctx, today: string): number {
  let sent = 0;
  for (const doc of ctx.db.all<DocRow>("SELECT * FROM docs WHERE kind = 'list' AND deleted = 0")) {
    const schema = listExtra(doc).schema;
    const dates = schema.filter((column) => column.type === 'date');
    const people = schema.filter((column) => column.type === 'user' && column.options?.notify_users !== false);
    if (!dates.length || !people.length) continue;
    const done = schema.find((column) => column.type === 'checkbox' && (column.key === 'todo_completed' || /^(done|completed)$/i.test(column.name)));
    for (const row of ctx.db.all<ItemRow>('SELECT * FROM list_items WHERE doc_id = ? AND archived = 0', doc.id)) {
      const values = JSON.parse(row.fields) as Values;
      if (done && values[done.id] === true) continue;
      if (!dates.some((column) => (values[column.id] as string[] | undefined)?.[0] === today)) continue;
      if (!ctx.db.run('INSERT OR IGNORE INTO list_due_sent (item_id, due) VALUES (?, ?)', row.id, today).changes) continue;
      const assignees = new Set(people.flatMap((column) => (values[column.id] as string[] | undefined) ?? []));
      for (const userId of assignees) {
        if (!accessOf(ctx, doc, userId)) continue;
        addActivity(ctx, userId, { kind: 'list_due', channel: doc.id, ts: row.id, actor: '', detail: today });
        sent += 1;
      }
    }
  }
  return sent;
}

/** The primary column's text of an item, for activity and cards. */
export function itemTitle(ctx: Ctx, doc: DocRow, itemId: string): string {
  const row = ctx.db.get<ItemRow>('SELECT * FROM list_items WHERE id = ? AND doc_id = ?', itemId, doc.id);
  if (!row) return '';
  const primary = listExtra(doc).schema.find((column) => column.is_primary_column);
  return primary ? plainOfRich((JSON.parse(row.fields) as Values)[primary.id]) : '';
}

// ── Methods ─────────────────────────────────────────────────────────────────

export function registerLists(kernel: Kernel): void {
  const registry: Registry = kernel.registry;
  const jobs = new Map<string, { listId: string; userId: string; archived: boolean; expires: number }>();

  registry.add('slackLists.create', { scopes: WRITE }, ({ ctx, actor, args }) => {
    let schema = args.json<unknown[]>('schema');
    let items: unknown[] = [];
    const copyFrom = args.str('copy_from_list_id');
    if (copyFrom) {
      const { doc: source } = requireDoc(ctx, copyFrom, 'list', actor.userId);
      const sourceSchema = listExtra(source).schema;
      schema = sourceSchema.map(({ id: _id, ...column }) => column);
      if (args.bool('include_copied_list_records')) {
        items = ctx.db
          .all<ItemRow>('SELECT * FROM list_items WHERE doc_id = ? AND archived = 0 ORDER BY position', source.id)
          .map((row) => {
            const values = JSON.parse(row.fields) as Values;
            return Object.fromEntries(sourceSchema.filter((column) => values[column.id] !== undefined).map((column) => [column.key, values[column.id]]));
          });
      }
    }
    const description = args.json<unknown>('description_blocks');
    const doc = createList(ctx, {
      owner: actor.userId,
      title: args.req('name'),
      description: description ? plainOfRich(description) : '',
      schema,
      todo: args.bool('todo_mode'),
      conversation: hostConversation(ctx, actor, args.str('channel_id')),
      items,
    });
    const api = listToApi(ctx, doc, 'owner');
    return { list_id: doc.id, list_metadata: api.list_metadata };
  });

  registry.add('slackLists.update', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('id', 'list_not_found'), 'list', actor.userId, 'write');
    const extra = listExtra(doc);
    if (args.has('todo_mode')) {
      extra.todo_mode = args.bool('todo_mode');
      extra.schema = readSchema(extra.schema, extra.schema, extra.todo_mode);
    }
    const description = args.json<unknown>('description_blocks');
    if (description !== undefined) extra.description = plainOfRich(description);
    const title = args.has('name') ? args.req('name').trim().slice(0, 255) : doc.title;
    ctx.db.run('UPDATE docs SET title = ?, extra = ?, updated = ?, updated_by = ? WHERE id = ?', title || doc.title, JSON.stringify(extra), nowSeconds(), actor.userId, doc.id);
    refreshPlain(ctx, getDoc(ctx, doc.id, 'list')!);
    emitDocChanged(ctx, doc, 'meta');
  });

  registry.add('slackLists.items.create', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const listId = args.req('list_id', 'list_not_found');
    const duplicate = args.str('duplicated_item_id');
    let fields: unknown = args.json('initial_fields') ?? [];
    if (duplicate) {
      const { doc } = requireDoc(ctx, listId, 'list', actor.userId, 'write');
      const source = requireItem(ctx, doc, duplicate);
      const values = JSON.parse(source.fields) as Values;
      fields = Object.fromEntries(Object.entries(values));
    }
    return { item: createListItem(ctx, actor, listId, fields, { parentId: args.str('parent_item_id') ?? null }) };
  });

  registry.add('slackLists.items.update', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId, 'write');
    const schema = listExtra(doc).schema;
    const cells = args.json<Record<string, unknown>[]>('cells');
    if (!Array.isArray(cells) || cells.length === 0) fail('invalid_arguments', { needed: 'cells' });
    const byRow = new Map<string, Record<string, unknown>[]>();
    for (const cell of cells) {
      const row = String(cell.row_id ?? '');
      byRow.set(row, [...(byRow.get(row) ?? []), cell]);
    }
    // Validate everything before writing anything.
    const updates = [...byRow].map(([rowId, rowCells]) => {
      const item = requireItem(ctx, doc, rowId);
      return { item, changes: readFields(ctx, schema, rowCells) };
    });
    for (const { item, changes } of updates) {
      const before = JSON.parse(item.fields) as Values;
      const after: Values = { ...before };
      for (const [columnId, value] of Object.entries(changes)) {
        if (value === undefined) delete after[columnId];
        else after[columnId] = value;
      }
      ctx.db.run('UPDATE list_items SET fields = ?, updated = ?, updated_by = ? WHERE id = ?', JSON.stringify(after), nowSeconds(), actor.userId, item.id);
      notifyAssigned(ctx, doc, schema, item.id, before, after, actor.userId);
    }
    touchList(ctx, doc, actor.userId);
    refreshPlain(ctx, doc);
    for (const { item } of updates) emitDocChanged(ctx, doc, 'items', { item_id: item.id });
  });

  const deleteItems = (ctx: Ctx, actor: Actor, listId: string, ids: string[]): void => {
    const { doc } = requireDoc(ctx, listId, 'list', actor.userId, 'write');
    for (const id of ids) requireItem(ctx, doc, id);
    for (const id of ids) ctx.db.run('DELETE FROM list_items WHERE (id = ? OR parent_id = ?) AND doc_id = ?', id, id, doc.id);
    ctx.db.run(`DELETE FROM list_comments WHERE doc_id = ? AND item_id IN (${ids.map(() => '?').join(',')})`, doc.id, ...ids);
    touchList(ctx, doc, actor.userId);
    refreshPlain(ctx, doc);
    emitDocChanged(ctx, doc, 'items');
  };

  registry.add('slackLists.items.delete', { scopes: WRITE }, ({ ctx, actor, args }) => {
    deleteItems(ctx, actor, args.req('list_id', 'list_not_found'), [args.req('id', 'item_not_found')]);
  });

  registry.add('slackLists.items.deleteMultiple', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const ids = args.list('ids');
    if (!ids.length) fail('invalid_arguments', { needed: 'ids' });
    deleteItems(ctx, actor, args.req('list_id', 'list_not_found'), ids);
  });

  registry.add('slackLists.items.info', { scopes: READ }, ({ ctx, actor, args }) => {
    const { doc, level } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const schema = listExtra(doc).schema;
    const item = requireItem(ctx, doc, args.req('id', 'item_not_found'));
    const subtasks = ctx.db.all<ItemRow>('SELECT * FROM list_items WHERE parent_id = ? AND doc_id = ? ORDER BY position', item.id, doc.id);
    return { list: listToApi(ctx, doc, level), record: itemToApi(doc, schema, item), subtasks: subtasks.map((row) => itemToApi(doc, schema, row)) };
  });

  registry.add('slackLists.items.list', { scopes: READ }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const schema = listExtra(doc).schema;
    const limit = args.int('limit', 100, { min: 1, max: 1000 });
    const offset = args.str('cursor') ? Number(Buffer.from(args.req('cursor'), 'base64').toString('utf8').replace(/^offset:/, '')) : 0;
    if (!Number.isInteger(offset) || offset < 0) fail('invalid_cursor');
    const rows = ctx.db.all<ItemRow>('SELECT * FROM list_items WHERE doc_id = ? AND archived = ? ORDER BY position LIMIT ? OFFSET ?', doc.id, args.bool('archived') ? 1 : 0, limit + 1, offset);
    const more = rows.length > limit;
    return {
      items: rows.slice(0, limit).map((row) => itemToApi(doc, schema, row)),
      response_metadata: { next_cursor: more ? Buffer.from(`offset:${offset + limit}`).toString('base64') : '' },
    };
  });

  const setAccess = (ctx: Ctx, actor: Actor, listId: string, channelIds: string[], userIds: string[], level: 'read' | 'write' | null): Record<string, unknown> => {
    const { doc } = requireDoc(ctx, listId, 'list', actor.userId, 'owner');
    if (channelIds.length && userIds.length) fail('invalid_arguments', { detail: 'channel_ids and user_ids cannot be combined' });
    if (!channelIds.length && !userIds.length) fail('invalid_arguments', { needed: 'channel_ids or user_ids' });
    const failedChannels: string[] = [];
    const failedUsers: string[] = [];
    for (const channel of channelIds) {
      const conv = getConv(ctx, channel);
      if (!conv || conv.kind === 'im') failedChannels.push(channel);
      else if (level) grant(ctx, doc.id, conv.id, level);
      else revoke(ctx, doc.id, conv.id);
    }
    for (const userId of userIds) {
      if (!getUser(ctx, userId) || userId === doc.owner) failedUsers.push(userId);
      else if (level) grant(ctx, doc.id, userId, level);
      else revoke(ctx, doc.id, userId);
    }
    emitDocChanged(ctx, doc, 'access');
    const out: Record<string, unknown> = {};
    if (failedChannels.length) out.failed_to_update_channel_ids = failedChannels;
    if (failedUsers.length) out.failed_to_update_user_ids = failedUsers;
    return out;
  };

  registry.add('slackLists.access.set', { scopes: WRITE }, ({ ctx, actor, args }) => {
    const level = args.req('access_level');
    if (level !== 'read' && level !== 'write') fail('invalid_arguments', { needed: 'access_level' });
    return setAccess(ctx, actor, args.req('list_id', 'list_not_found'), args.list('channel_ids'), args.list('user_ids'), level);
  });

  registry.add('slackLists.access.delete', { scopes: WRITE }, ({ ctx, actor, args }) =>
    setAccess(ctx, actor, args.req('list_id', 'list_not_found'), args.list('channel_ids'), args.list('user_ids'), null),
  );

  registry.add('slackLists.download.start', { scopes: READ }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const jobId = newId('LeJ', 9);
    jobs.set(jobId, { listId: doc.id, userId: actor.userId, archived: args.bool('include_archived'), expires: Date.now() + 3600_000 });
    return { job_id: jobId };
  });

  registry.add('slackLists.download.get', { scopes: READ }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const job = jobs.get(args.req('job_id'));
    if (!job || job.listId !== doc.id || job.userId !== actor.userId || job.expires < Date.now()) fail('job_not_found');
    const secret = newSecret(18);
    downloads.set(secret, { ...job, expires: Date.now() + 600_000 });
    return { status: 'COMPLETED', download_url: `${ctx.config.publicUrl}/lists-export/${doc.id}.csv?key=${secret}` };
  });

  // CSV for people (session) and for download URLs handed out above.
  const downloads = new Map<string, { listId: string; userId: string; archived: boolean; expires: number }>();
  kernel.router.add('GET', /^\/lists-export\/([A-Z0-9]+)\.csv$/, ({ req, res, url, params }) => {
    const ctx = kernel.ctx;
    let userId: string | null = null;
    let archived = url.searchParams.get('archived') === '1';
    const key = url.searchParams.get('key');
    if (key) {
      const grantRow = downloads.get(key);
      if (grantRow && grantRow.listId === params[0] && grantRow.expires > Date.now()) {
        userId = grantRow.userId;
        archived = grantRow.archived;
      }
    } else {
      userId = authenticate(ctx, req, undefined).actor?.userId ?? null;
    }
    const doc = getDoc(ctx, params[0], 'list');
    if (!userId || !doc || !accessOf(ctx, doc, userId)) {
      sendJson(res, 404, { ok: false, error: 'list_not_found' });
      return;
    }
    const body = `﻿${csvOf(ctx, doc, archived)}`;
    res.writeHead(200, {
      'content-type': 'text/csv; charset=utf-8',
      'content-disposition': `attachment; filename*=UTF-8''${encodeURIComponent(`${doc.title || 'list'}.csv`)}`,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  });

  // ── First-party additions ─────────────────────────────────────────────────

  registry.add('client.lists.info', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc, level } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const schema = listExtra(doc).schema;
    const rows = ctx.db.all<ItemRow>('SELECT * FROM list_items WHERE doc_id = ? AND archived = 0 ORDER BY position', doc.id);
    const comments = new Map(
      ctx.db.all<{ item_id: string; n: number }>('SELECT item_id, count(*) AS n FROM list_comments WHERE doc_id = ? GROUP BY item_id', doc.id).map((row) => [row.item_id, row.n]),
    );
    return {
      list: listToApi(ctx, doc, level),
      items: rows.map((row) => ({ ...itemToApi(doc, schema, row), comment_count: comments.get(row.id) ?? 0 })),
    };
  });

  registry.add('client.lists.columns.set', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId, 'write');
    const extra = listExtra(doc);
    extra.schema = readSchema(args.json('schema'), extra.schema, extra.todo_mode);
    ctx.db.run('UPDATE docs SET extra = ?, updated = ?, updated_by = ? WHERE id = ?', JSON.stringify(extra), nowSeconds(), actor.userId, doc.id);
    emitDocChanged(ctx, doc, 'schema');
    return { schema: extra.schema };
  });

  registry.add('client.lists.items.move', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId, 'write');
    const item = requireItem(ctx, doc, args.req('id', 'item_not_found'));
    const after = args.str('after_id') ? requireItem(ctx, doc, args.req('after_id')) : null;
    const next = ctx.db.get<{ position: number }>(
      'SELECT position FROM list_items WHERE doc_id = ? AND position > ? AND id != ? ORDER BY position LIMIT 1',
      doc.id,
      after ? after.position : -Infinity,
      item.id,
    );
    const low = after ? after.position : (next ? next.position - 1 : 0);
    const position = next ? (low + next.position) / 2 : low + 1;
    ctx.db.run('UPDATE list_items SET position = ? WHERE id = ?', position, item.id);
    emitDocChanged(ctx, doc, 'items', { item_id: item.id });
  });

  registry.add('client.lists.items.archive', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId, 'write');
    const item = requireItem(ctx, doc, args.req('id', 'item_not_found'));
    ctx.db.run('UPDATE list_items SET archived = ? WHERE id = ?', args.bool('archived', true) ? 1 : 0, item.id);
    refreshPlain(ctx, doc);
    emitDocChanged(ctx, doc, 'items', { item_id: item.id });
  });

  registry.add('client.lists.comments.list', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const item = requireItem(ctx, doc, args.req('item_id', 'item_not_found'));
    return {
      comments: ctx.db.all('SELECT id, user_id AS user, text, created FROM list_comments WHERE doc_id = ? AND item_id = ? ORDER BY created, rowid', doc.id, item.id),
    };
  });

  registry.add('client.lists.comments.add', { auth: 'session' }, ({ ctx, actor, args }) => {
    const { doc } = requireDoc(ctx, args.req('list_id', 'list_not_found'), 'list', actor.userId);
    const item = requireItem(ctx, doc, args.req('item_id', 'item_not_found'));
    const text = args.req('text').trim().slice(0, 4000);
    if (!text) fail('no_text');
    const id = newId('Lc', 9);
    ctx.db.run('INSERT INTO list_comments (id, doc_id, item_id, user_id, text, created) VALUES (?, ?, ?, ?, ?, ?)', id, doc.id, item.id, actor.userId, text, nowSeconds());
    emitDocChanged(ctx, doc, 'comments', { item_id: item.id });
    return { comment: { id, user: actor.userId, text, created: nowSeconds() } };
  });

  // Due-date reminders: shortly after start, then every 30 minutes.
  const sweep = (): void => {
    try {
      runDueSweep(kernel.ctx, new Date().toISOString().slice(0, 10));
    } catch (error) {
      console.error('[lists] due sweep failed', error);
    }
  };
  const first = setTimeout(sweep, 5_000);
  const timer = setInterval(sweep, 30 * 60_000);
  first.unref();
  timer.unref();
  kernel.onClose.push(() => {
    clearTimeout(first);
    clearInterval(timer);
  });
}
