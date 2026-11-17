import type { Block } from '@app/shared';
import { fail } from '../core/errors.ts';
import { newId } from '../core/ids.ts';

/**
 * Block Kit interactive elements, as far as the server needs them: finding an
 * element by `action_id`, and turning what a person chose into the value
 * shapes Slack sends (`block_actions` entries and `view.state.values`). What
 * an element is always comes from the stored message or view; only the choice
 * comes from the client, and it is checked against the element.
 */

export type Json = Record<string, unknown>;

/** A value in `state.values[block_id][action_id]`, as Slack's `ViewStateValue`. */
export type StateValue = Json & { type: string };
export type StateValues = Record<string, Record<string, StateValue>>;

export interface Located {
  element: Json;
  blockId: string;
  block: Json;
}

/** Every interactive element in a list of blocks, with the block that holds it. */
export function elementsOf(blocks: Block[]): Located[] {
  const found: Located[] = [];
  for (const block of blocks as Json[]) {
    const blockId = String(block.block_id ?? '');
    const candidates: unknown[] = [];
    if (Array.isArray(block.elements) && block.type === 'actions') candidates.push(...(block.elements as unknown[]));
    if (block.accessory) candidates.push(block.accessory);
    if (block.element) candidates.push(block.element);
    for (const candidate of candidates) {
      if (candidate && typeof candidate === 'object' && typeof (candidate as Json).action_id === 'string') {
        found.push({ element: candidate as Json, blockId, block });
      }
    }
  }
  return found;
}

/** Find an element by `action_id`, optionally within one block. */
export function locate(blocks: Block[], actionId: string, blockId: string | undefined): Located | undefined {
  return elementsOf(blocks).find((entry) => entry.element.action_id === actionId && (blockId === undefined || entry.blockId === blockId));
}

const SHORT_ID = 'abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';

function randomId(): string {
  let out = '';
  for (let i = 0; i < 5; i += 1) out += SHORT_ID[Math.floor(Math.random() * SHORT_ID.length)];
  return out;
}

/**
 * Give every block a `block_id` and every interactive element an `action_id`,
 * as Slack does for views: values in `state` are keyed by both. Ids the app
 * chose are kept.
 */
export function assignIds(blocks: Block[]): Block[] {
  return blocks.map((raw) => {
    const block: Json = { ...(raw as Json) };
    if (typeof block.block_id !== 'string' || !block.block_id) block.block_id = randomId();
    const named = (element: unknown): unknown => {
      if (!element || typeof element !== 'object') return element;
      const value = element as Json;
      const interactive = typeof value.type === 'string' && !['image', 'mrkdwn', 'plain_text'].includes(value.type);
      return interactive && typeof value.action_id !== 'string' ? { ...value, action_id: newId('', 6).toLowerCase() } : value;
    };
    if (block.element) block.element = named(block.element);
    if (block.accessory) block.accessory = named(block.accessory);
    if (Array.isArray(block.elements) && block.type === 'actions') block.elements = (block.elements as unknown[]).map(named);
    return block as Block;
  });
}

/** Positional ids for message blocks stored without one (`b0`, `b1`, …). Nothing is rewritten in storage. */
export function withBlockIds(blocks: Block[]): Block[] {
  return blocks.map((block, index) => (typeof block.block_id === 'string' && block.block_id ? block : { ...block, block_id: `b${index}` }));
}

function optionsOf(element: Json): Json[] {
  const options: Json[] = [];
  if (Array.isArray(element.options)) options.push(...(element.options as Json[]));
  if (Array.isArray(element.option_groups)) {
    for (const group of element.option_groups as Json[]) {
      if (Array.isArray(group.options)) options.push(...(group.options as Json[]));
    }
  }
  return options;
}

function isExternal(type: string): boolean {
  return type === 'external_select' || type === 'multi_external_select';
}

/** An option the person picked, taken from the element as the app defined it. */
function pickOption(element: Json, chosen: unknown): Json | null {
  if (chosen === null || chosen === undefined) return null;
  const value = typeof chosen === 'object' ? (chosen as Json).value : chosen;
  const known = optionsOf(element).find((option) => option.value === value);
  if (known) return known;
  // Menus with external data sources have no static list to check against.
  if (isExternal(String(element.type)) && typeof chosen === 'object') {
    const option = chosen as Json;
    return { text: option.text, value: option.value };
  }
  return fail('invalid_action_value');
}

function stringOrNull(value: unknown, pattern?: RegExp): string | null {
  if (typeof value !== 'string' || value === '') return null;
  if (pattern && !pattern.test(value)) fail('invalid_action_value');
  return value;
}

function ids(value: unknown): string[] {
  return Array.isArray(value) ? value.map(String).filter((entry) => /^[A-Z0-9]{2,}$/.test(entry)).slice(0, 100) : [];
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^\d{2}:\d{2}$/;

/**
 * The value fields for one element: what goes into an `actions[]` entry
 * (besides its ids) and into `state.values`. Text inputs keep what was typed,
 * up to the element's `max_length`.
 */
export function elementValue(element: Json, input: Json): Json {
  const type = String(element.type);
  switch (type) {
    case 'static_select':
    case 'external_select':
    case 'overflow':
    case 'radio_buttons':
      return { selected_option: pickOption(element, input.selected_option) };
    case 'multi_static_select':
    case 'multi_external_select':
    case 'checkboxes':
      return {
        selected_options: (Array.isArray(input.selected_options) ? input.selected_options : [])
          .map((chosen) => pickOption(element, chosen))
          .filter((option) => option !== null),
      };
    case 'datepicker':
      return { selected_date: stringOrNull(input.selected_date, DATE) };
    case 'timepicker':
      return { selected_time: stringOrNull(input.selected_time, TIME) };
    case 'datetimepicker': {
      const value = typeof input.selected_date_time === 'number' ? Math.trunc(input.selected_date_time) : null;
      return { selected_date_time: value };
    }
    case 'users_select':
      return { selected_user: stringOrNull(input.selected_user, /^[A-Z0-9]+$/) };
    case 'conversations_select':
      return { selected_conversation: stringOrNull(input.selected_conversation, /^[A-Z0-9]+$/) };
    case 'channels_select':
      return { selected_channel: stringOrNull(input.selected_channel, /^[A-Z0-9]+$/) };
    case 'multi_users_select':
      return { selected_users: ids(input.selected_users) };
    case 'multi_conversations_select':
      return { selected_conversations: ids(input.selected_conversations) };
    case 'multi_channels_select':
      return { selected_channels: ids(input.selected_channels) };
    case 'number_input': {
      const value = typeof input.value === 'string' ? input.value.trim() : null;
      if (value !== null && value !== '' && !/^-?\d+(\.\d+)?$/.test(value)) fail('invalid_action_value');
      return { value: value === '' ? null : value };
    }
    default: {
      // plain_text_input, email_text_input, url_text_input and anything text-like.
      const max = typeof element.max_length === 'number' ? element.max_length : 3000;
      return { value: typeof input.value === 'string' ? input.value.slice(0, max) : null };
    }
  }
}

/**
 * Rebuild `state.values` for a view from what the client sent: only elements
 * that exist in the view, each with its type and a checked value.
 */
export function sanitizeState(blocks: Block[], values: unknown): StateValues {
  const out: StateValues = {};
  const sent = values && typeof values === 'object' ? (values as Record<string, Record<string, unknown>>) : {};
  for (const { element, blockId, block } of elementsOf(blocks)) {
    // Buttons and overflow menus act; they hold no state.
    if (element.type === 'button' || element.type === 'overflow' || element.type === 'workflow_button') continue;
    if (block.type !== 'input' && block.type !== 'actions' && block.type !== 'section') continue;
    const input = sent[blockId]?.[String(element.action_id)];
    if (!input || typeof input !== 'object') continue;
    const value = { type: String(element.type), ...elementValue(element, input as Json) } as StateValue;
    (out[blockId] ??= {})[String(element.action_id)] = value;
  }
  return out;
}
