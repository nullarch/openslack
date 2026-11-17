import { create } from 'zustand';
import { go } from './actions';
import { call, type Json } from './api';

/**
 * Canvases and lists, as the always-loaded part of the client knows them:
 * which ones are tabs of each conversation, the link cards messages show, and
 * a change counter per document that open views watch to refetch. The editor
 * and the list views live in lazily loaded chunks.
 */

export type DocKind = 'canvas' | 'list';

export interface DocSummary {
  id: string;
  kind: DocKind;
  title: string;
  owner: string;
  conversation_id: string | null;
  updated: number;
  updated_by: string;
  access_level: 'read' | 'write' | 'owner';
  snippet: string;
  permalink: string;
  item_count?: number;
  columns?: string[];
}

interface DocsState {
  /** Canvases and lists shown as tabs, per conversation. */
  byChannel: Record<string, DocSummary[]>;
  /** The tab open in each conversation: a document id, or absent for messages. */
  tab: Record<string, string>;
  /** Bumped whenever the server says a document changed. */
  version: Record<string, number>;
  /** What a link to a document shows; `null` when the viewer cannot open it. */
  cards: Record<string, DocSummary | null>;
  /** The last change kind per document (`content`, `items`, `comments`, …). */
  lastChange: Record<string, string>;
}

export const useDocs = create<DocsState>(() => ({ byChannel: {}, tab: {}, version: {}, cards: {}, lastChange: {} }));

const pendingChannels = new Set<string>();

export async function loadChannelDocs(channel: string): Promise<void> {
  if (pendingChannels.has(channel)) return;
  pendingChannels.add(channel);
  try {
    const result = await call('client.docs.list', { channel });
    useDocs.setState((state) => ({ byChannel: { ...state.byChannel, [channel]: result.docs as DocSummary[] } }));
  } catch {
    useDocs.setState((state) => ({ byChannel: { ...state.byChannel, [channel]: state.byChannel[channel] ?? [] } }));
  } finally {
    pendingChannels.delete(channel);
  }
}

export function setDocTab(channel: string, id: string | null): void {
  useDocs.setState((state) => {
    const tab = { ...state.tab };
    if (id) tab[channel] = id;
    else delete tab[channel];
    return { tab };
  });
}

const pendingCards = new Set<string>();

export function loadCard(id: string): void {
  if (pendingCards.has(id) || id in useDocs.getState().cards) return;
  pendingCards.add(id);
  call('client.docs.card', { id })
    .then((result) => useDocs.setState((state) => ({ cards: { ...state.cards, [id]: result.card as DocSummary } })))
    .catch(() => useDocs.setState((state) => ({ cards: { ...state.cards, [id]: null } })))
    .finally(() => pendingCards.delete(id));
}

export function openDoc(kind: DocKind, id: string): void {
  go({ name: 'doc', kind, id });
}

/** Make a canvas or list, optionally as a tab of `channel` and from a template, and open it. */
export async function createDoc(kind: DocKind, options: { channel?: string; templateId?: string; title?: string } = {}): Promise<DocSummary> {
  const result = await call('client.docs.create', { kind, channel: options.channel, template_id: options.templateId, title: options.title });
  const doc = result.doc as DocSummary;
  if (options.channel) {
    await loadChannelDocs(options.channel);
    setDocTab(options.channel, doc.id);
  } else openDoc(kind, doc.id);
  return doc;
}

/** Links in message text that point at a canvas or list on this server. */
export function docLinks(text: string): { kind: DocKind; id: string }[] {
  const found = new Map<string, DocKind>();
  const origin = window.location.origin.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const pattern = new RegExp(`(?:${origin}|https?://[^\\s/|>]+)/(docs|lists)/(?:T[A-Z0-9]+/)?(F[A-Z0-9]+)`, 'g');
  for (const match of text.matchAll(pattern)) found.set(match[2]!, match[1] === 'docs' ? 'canvas' : 'list');
  return [...found].slice(0, 3).map(([id, kind]) => ({ id, kind }));
}

/** Realtime: `doc_changed` refreshes tabs, cards and open views. Returns true when handled. */
export function handleDocEvent(event: Json): boolean {
  if (event.type !== 'doc_changed') return false;
  const id = String(event.id);
  const change = String(event.change ?? '');
  useDocs.setState((state) => {
    const cards = { ...state.cards };
    delete cards[id];
    return { version: { ...state.version, [id]: (state.version[id] ?? 0) + 1 }, lastChange: { ...state.lastChange, [id]: change }, cards };
  });
  if (['created', 'deleted', 'renamed', 'access'].includes(change)) {
    const state = useDocs.getState();
    const channels = new Set<string>();
    if (typeof event.conversation_id === 'string') channels.add(event.conversation_id);
    for (const [channel, docs] of Object.entries(state.byChannel)) if (docs.some((doc) => doc.id === id)) channels.add(channel);
    for (const channel of channels) if (channel in state.byChannel) void loadChannelDocs(channel);
    if (change === 'deleted') {
      for (const [channel, tab] of Object.entries(state.tab)) if (tab === id) setDocTab(channel, null);
    }
  }
  return true;
}

/** A color per person for cursors and avatars in a canvas, stable across sessions. */
export function personColor(userId: string): string {
  const palette = ['#d9480f', '#2b8a3e', '#1971c2', '#9c36b5', '#c2255c', '#0b7285', '#e67700', '#5f3dc4'];
  let hash = 0;
  for (const char of userId) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return palette[hash % palette.length]!;
}
