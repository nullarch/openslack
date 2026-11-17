import type { Json } from './elements.ts';

/**
 * Legacy dialogs (`dialog.open`): the form apps opened before modals. A dialog
 * is shown as a modal built from its elements; what the person submits, or
 * cancelling it, reaches the app as Slack sent it then (`dialog_submission`
 * with a flat `submission` map, `dialog_cancellation`, `dialog_suggestion`
 * for external menus), and the app's `{"errors": [{"name", "error"}]}` answer
 * marks the fields again.
 */

export interface DialogElement {
  name: string;
  type: 'text' | 'textarea' | 'select';
  dataSource: string;
  blockId: string;
}

/** What the server keeps about an open dialog, next to its modal. */
export interface DialogMeta {
  callback_id: string;
  state: string;
  notify_on_cancel: boolean;
  channel: string | null;
  elements: DialogElement[];
}

const plain = (text: string): Json => ({ type: 'plain_text', text, emoji: true });

/** Validate a dialog and build the modal that shows it. Returns Slack-style messages when it is not valid. */
export function dialogToView(raw: unknown, channel: string | null): { view: Json; meta: DialogMeta } | { messages: string[] } {
  const messages: string[] = [];
  const problem = (text: string, pointer: string): void => {
    messages.push(`[ERROR] ${text} [json-pointer:/dialog${pointer}]`);
  };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { messages: ['[ERROR] dialog must be an object [json-pointer:/dialog]'] };
  const dialog = raw as Json;
  const title = typeof dialog.title === 'string' ? dialog.title : '';
  if (!title) problem('missing required field: title', '/title');
  else if (title.length > 24) problem('must be less than 25 characters', '/title');
  const callbackId = typeof dialog.callback_id === 'string' ? dialog.callback_id : '';
  if (!callbackId) problem('missing required field: callback_id', '/callback_id');
  else if (callbackId.length > 255) problem('must be less than 256 characters', '/callback_id');
  const submitLabel = typeof dialog.submit_label === 'string' && dialog.submit_label ? dialog.submit_label : 'Submit';
  if (submitLabel.length > 48 || /\s/.test(submitLabel.trim())) problem('must be a single word of no more than 48 characters', '/submit_label');
  const state = typeof dialog.state === 'string' ? dialog.state : '';
  if (state.length > 3000) problem('must be less than 3001 characters', '/state');
  const elements = Array.isArray(dialog.elements) ? (dialog.elements as Json[]) : [];
  if (elements.length === 0 || elements.length > 10) problem('must provide between 1 and 10 elements', '/elements');

  const names = new Set<string>();
  const blocks: Json[] = [];
  const kept: DialogElement[] = [];
  elements.slice(0, 10).forEach((element, index) => {
    const at = `/elements/${index}`;
    if (!element || typeof element !== 'object') {
      problem('must be an object', at);
      return;
    }
    const type = element.type;
    const label = typeof element.label === 'string' ? element.label : '';
    const name = typeof element.name === 'string' ? element.name : '';
    if (type !== 'text' && type !== 'textarea' && type !== 'select') problem('must be one of text, textarea, select', `${at}/type`);
    if (!label) problem('missing required field: label', `${at}/label`);
    else if (label.length > 48) problem('must be less than 49 characters', `${at}/label`);
    if (!name) problem('missing required field: name', `${at}/name`);
    else if (name.length > 300) problem('must be less than 301 characters', `${at}/name`);
    else if (names.has(name)) problem('element names must be unique', `${at}/name`);
    names.add(name);
    const hint = typeof element.hint === 'string' ? element.hint.slice(0, 150) : '';
    const placeholder = typeof element.placeholder === 'string' && element.placeholder ? plain(element.placeholder.slice(0, 150)) : undefined;
    const blockId = `dialog_${index}`;
    let input: Json | null = null;
    let dataSource = '';
    if (type === 'text' || type === 'textarea') {
      const max = type === 'text' ? 150 : 3000;
      const value = typeof element.value === 'string' ? element.value : '';
      if (value.length > max) problem(`must be less than ${max + 1} characters`, `${at}/value`);
      const maxLength = Number.isInteger(element.max_length) ? Math.min(Math.max(Number(element.max_length), 1), max) : max;
      const minLength = Number.isInteger(element.min_length) ? Math.min(Math.max(Number(element.min_length), 0), maxLength) : 0;
      input = {
        type: 'plain_text_input',
        action_id: name,
        multiline: type === 'textarea',
        max_length: maxLength,
        ...(minLength ? { min_length: minLength } : {}),
        ...(value ? { initial_value: value } : {}),
        ...(placeholder ? { placeholder } : {}),
      };
    } else if (type === 'select') {
      dataSource = typeof element.data_source === 'string' ? element.data_source : 'static';
      const option = (entry: Json): Json => ({ text: plain(String(entry.label ?? '').slice(0, 75)), value: String(entry.value ?? '').slice(0, 75) });
      if (dataSource === 'static') {
        const options = Array.isArray(element.options) ? (element.options as Json[]) : [];
        const groups = Array.isArray(element.option_groups) ? (element.option_groups as Json[]) : [];
        if (!options.length && !groups.length) problem('must provide options or option_groups', `${at}/options`);
        if (options.length > 100 || groups.length > 100) problem('must provide fewer than 100 options', `${at}/options`);
        const all = [...options, ...groups.flatMap((group) => (Array.isArray(group.options) ? (group.options as Json[]) : []))];
        const initial = all.find((entry) => String(entry.value) === String(element.value ?? ''));
        input = {
          type: 'static_select',
          action_id: name,
          ...(groups.length
            ? { option_groups: groups.slice(0, 100).map((group) => ({ label: plain(String(group.label ?? '').slice(0, 75)), options: (Array.isArray(group.options) ? (group.options as Json[]) : []).slice(0, 100).map(option) })) }
            : { options: options.slice(0, 100).map(option) }),
          ...(initial ? { initial_option: option(initial) } : {}),
          ...(placeholder ? { placeholder } : {}),
        };
      } else if (dataSource === 'users') {
        input = { type: 'users_select', action_id: name, ...(typeof element.value === 'string' && element.value ? { initial_user: element.value } : {}), ...(placeholder ? { placeholder } : {}) };
      } else if (dataSource === 'channels') {
        input = { type: 'channels_select', action_id: name, ...(typeof element.value === 'string' && element.value ? { initial_channel: element.value } : {}), ...(placeholder ? { placeholder } : {}) };
      } else if (dataSource === 'conversations') {
        input = { type: 'conversations_select', action_id: name, ...(typeof element.value === 'string' && element.value ? { initial_conversation: element.value } : {}), ...(placeholder ? { placeholder } : {}) };
      } else if (dataSource === 'external') {
        const selected = Array.isArray(element.selected_options) ? (element.selected_options as Json[])[0] : undefined;
        input = {
          type: 'external_select',
          action_id: name,
          min_query_length: Number.isInteger(element.min_query_length) ? Number(element.min_query_length) : 1,
          ...(selected ? { initial_option: option(selected) } : {}),
          ...(placeholder ? { placeholder } : {}),
        };
      } else {
        problem('must be one of static, users, channels, conversations, external', `${at}/data_source`);
      }
    }
    if (!input || !name) return;
    blocks.push({
      type: 'input',
      block_id: blockId,
      optional: element.optional === true,
      label: plain(label.slice(0, 48)),
      ...(hint ? { hint: plain(hint) } : {}),
      element: input,
    });
    kept.push({ name, type: type as DialogElement['type'], dataSource, blockId });
  });
  if (messages.length) return { messages };
  return {
    view: {
      type: 'modal',
      callback_id: callbackId,
      title: plain(title),
      submit: plain(submitLabel),
      close: plain('Cancel'),
      blocks,
    },
    meta: { callback_id: callbackId, state, notify_on_cancel: dialog.notify_on_cancel === true, channel, elements: kept },
  };
}

/** The flat `submission` map Slack sent for a dialog: element name → value, null when left empty. */
export function dialogSubmission(meta: DialogMeta, state: Json): Record<string, string | null> {
  const values = (state.values ?? {}) as Record<string, Record<string, Json>>;
  const out: Record<string, string | null> = {};
  for (const element of meta.elements) {
    const entry = values[element.blockId]?.[element.name];
    let value: unknown = null;
    if (entry) {
      value =
        entry.value ??
        (entry.selected_option as Json | undefined)?.value ??
        entry.selected_user ??
        entry.selected_channel ??
        entry.selected_conversation ??
        null;
    }
    out[element.name] = typeof value === 'string' && value !== '' ? value : null;
  }
  return out;
}

/** The app's validation answer, `{"errors": [{"name", "error"}]}`, as errors by block id. */
export function dialogErrors(meta: DialogMeta, answer: unknown): Record<string, string> | null {
  const errors = answer && typeof answer === 'object' ? (answer as Json).errors : undefined;
  if (!Array.isArray(errors) || errors.length === 0) return null;
  const out: Record<string, string> = {};
  for (const item of errors as Json[]) {
    const element = meta.elements.find((entry) => entry.name === item?.name);
    if (element && typeof item.error === 'string') out[element.blockId] = item.error.slice(0, 500);
  }
  return Object.keys(out).length ? out : null;
}

/** Options from a `dialog_suggestion` answer ({options: [{label, value}]} or option_groups) in Block Kit form. */
export function dialogOptions(answer: unknown): Json {
  const body = answer && typeof answer === 'object' ? (answer as Json) : {};
  const option = (entry: Json): Json => ({ text: plain(String(entry.label ?? '').slice(0, 75)), value: String(entry.value ?? '').slice(0, 75) });
  if (Array.isArray(body.option_groups)) {
    return { option_groups: (body.option_groups as Json[]).slice(0, 100).map((group) => ({ label: plain(String(group.label ?? '')), options: (Array.isArray(group.options) ? (group.options as Json[]) : []).slice(0, 100).map(option) })) };
  }
  return { options: (Array.isArray(body.options) ? (body.options as Json[]) : []).slice(0, 100).map(option) };
}
