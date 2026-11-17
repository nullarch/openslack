import { create } from 'zustand';
import { S } from '../strings';
import { ApiError, call, type Json } from './api';

/**
 * Client state for the AI features. Kept apart from the main store: the
 * features are optional, and everything here is private to this viewer.
 */

export type AiFeature = 'summaries' | 'recaps' | 'search_answers' | 'translate' | 'writing';

export interface Citation {
  n: number;
  channel: string;
  ts: string;
  link: string;
  author: string;
  excerpt: string;
}

/** A streamed answer: a summary or a search answer. */
export interface AiResult {
  requestId: string | null;
  kind: 'summary' | 'answer';
  title: string;
  text: string;
  citations: Citation[];
  done: boolean;
  error: string | null;
  messages?: number;
  leftOut?: number;
}

export interface Translation {
  text: string;
  loading: boolean;
  error: string | null;
  shown: boolean;
}

interface AiState {
  /** Null until loaded. Features the workspace has turned on. */
  status: { configured: boolean; features: Record<AiFeature, boolean> } | null;
  /** The summary shown in the floating sheet. */
  sheet: AiResult | null;
  /** Search answers, by query. */
  answers: Record<string, AiResult>;
  /** In-place translations, by `channel:ts`. */
  translations: Record<string, Translation>;
  modal: 'settings' | 'recap' | null;
}

export const useAi = create<AiState>(() => ({ status: null, sheet: null, answers: {}, translations: {}, modal: null }));
const setAi = useAi.setState;
const getAi = useAi.getState;

export function aiErrorText(code: string | null | undefined): string {
  if (!code) return S.ai.errors.generic;
  return (S.ai.errors as Record<string, string>)[code] ?? S.ai.errors.generic;
}

function codeOf(error: unknown): string {
  if (!(error instanceof ApiError)) return 'internal_error';
  return error.code === 'ai_provider_error' ? String(error.data.detail ?? error.code) : error.code;
}

let loading: Promise<void> | null = null;

/** Which features are on, for deciding what to offer. */
export function loadAiStatus(force = false): Promise<void> {
  if (loading && !force) return loading;
  loading = call('client.ai.status')
    .then((result: Json) => setAi({ status: { configured: result.configured, features: result.features } }))
    .catch(() => setAi({ status: { configured: false, features: {} as Record<AiFeature, boolean> } }));
  return loading;
}

export function useAiFeature(feature: AiFeature): boolean {
  return useAi((state) => Boolean(state.status?.configured && state.status.features[feature]));
}

// ── Streamed requests ───────────────────────────────────────────────────────

/** Where each running request's events go. */
const targets = new Map<string, { place: 'sheet' } | { place: 'answer'; query: string }>();
/** Events that arrive before the HTTP answer naming their request. */
const early = new Map<string, Json[]>();

function update(requestId: string, change: (result: AiResult) => AiResult): void {
  const target = targets.get(requestId);
  if (!target) return;
  if (target.place === 'sheet') {
    const sheet = getAi().sheet;
    if (sheet?.requestId === requestId) setAi({ sheet: change(sheet) });
  } else {
    const current = getAi().answers[target.query];
    if (current?.requestId === requestId) setAi({ answers: { ...getAi().answers, [target.query]: change(current) } });
  }
}

function apply(event: Json): void {
  const requestId = String(event.request_id);
  if (event.type === 'ai_stream') {
    update(requestId, (result) => ({ ...result, text: result.text + String(event.delta ?? '') }));
    return;
  }
  update(requestId, (result) => ({
    ...result,
    text: typeof event.text === 'string' ? event.text : result.text,
    citations: Array.isArray(event.citations) ? event.citations : [],
    done: true,
    error: event.error ? String(event.error) : null,
    messages: typeof event.messages === 'number' ? event.messages : undefined,
    leftOut: typeof event.left_out === 'number' ? event.left_out : undefined,
  }));
  targets.delete(requestId);
}

/** Realtime events for this module; returns true when it handled one. */
export function handleAiEvent(event: Json): boolean {
  if (event.type === 'ai_settings_changed') {
    void loadAiStatus(true);
    return true;
  }
  if (event.type !== 'ai_stream' && event.type !== 'ai_done') return false;
  const requestId = String(event.request_id);
  if (targets.has(requestId)) apply(event);
  else early.set(requestId, [...(early.get(requestId) ?? []), event]);
  return true;
}

function attach(requestId: string, target: { place: 'sheet' } | { place: 'answer'; query: string }): void {
  targets.set(requestId, target);
  for (const event of early.get(requestId) ?? []) apply(event);
  early.delete(requestId);
}

export async function summarize(args: { channel: string; thread_ts?: string; range?: 'unread' | 'today' }, title: string): Promise<void> {
  setAi({ sheet: { requestId: null, kind: 'summary', title, text: '', citations: [], done: false, error: null } });
  try {
    const { request_id } = await call('client.ai.summarize', args);
    const sheet = getAi().sheet;
    if (!sheet || sheet.requestId !== null || sheet.title !== title) return;
    setAi({ sheet: { ...sheet, requestId: request_id } });
    attach(request_id, { place: 'sheet' });
  } catch (error) {
    const sheet = getAi().sheet;
    if (sheet && sheet.requestId === null) setAi({ sheet: { ...sheet, done: true, error: codeOf(error) } });
  }
}

export function closeSheet(): void {
  const sheet = getAi().sheet;
  if (sheet?.requestId) targets.delete(sheet.requestId);
  setAi({ sheet: null });
}

export async function askQuestion(query: string): Promise<void> {
  const pending: AiResult = { requestId: null, kind: 'answer', title: query, text: '', citations: [], done: false, error: null };
  setAi({ answers: { ...getAi().answers, [query]: pending } });
  try {
    const { request_id } = await call('client.ai.answer', { query });
    const current = getAi().answers[query];
    if (!current || current.requestId !== null) return;
    setAi({ answers: { ...getAi().answers, [query]: { ...current, requestId: request_id } } });
    attach(request_id, { place: 'answer', query });
  } catch (error) {
    const current = getAi().answers[query];
    if (current) setAi({ answers: { ...getAi().answers, [query]: { ...current, done: true, error: codeOf(error) } } });
  }
}

// ── Direct requests ─────────────────────────────────────────────────────────

const translationKey = (channel: string, ts: string): string => `${channel}:${ts}`;

export async function translateMessage(channel: string, ts: string): Promise<void> {
  const key = translationKey(channel, ts);
  const existing = getAi().translations[key];
  if (existing && !existing.error) {
    setAi({ translations: { ...getAi().translations, [key]: { ...existing, shown: true } } });
    return;
  }
  setAi({ translations: { ...getAi().translations, [key]: { text: '', loading: true, error: null, shown: true } } });
  try {
    const result = await call('client.ai.translate', { channel, ts, language: navigator.language || 'en' });
    setAi({ translations: { ...getAi().translations, [key]: { text: result.text, loading: false, error: null, shown: true } } });
  } catch (error) {
    setAi({ translations: { ...getAi().translations, [key]: { text: '', loading: false, error: codeOf(error), shown: true } } });
  }
}

export function hideTranslation(channel: string, ts: string): void {
  const key = translationKey(channel, ts);
  const existing = getAi().translations[key];
  if (existing) setAi({ translations: { ...getAi().translations, [key]: { ...existing, shown: false } } });
}

export function useTranslation(channel: string, ts: string): Translation | undefined {
  return useAi((state) => state.translations[translationKey(channel, ts)]);
}

export type WriteMode = 'improve' | 'shorten' | 'friendly' | 'formal' | 'fix';

/** Rewrite a draft. Resolves with the new text; never sends anything. */
export async function rewriteDraft(text: string, mode: WriteMode): Promise<string> {
  try {
    const result = await call('client.ai.write', { text, mode });
    return String(result.text);
  } catch (error) {
    throw new Error(aiErrorText(codeOf(error)));
  }
}

export function openAiModal(modal: 'settings' | 'recap'): void {
  setAi({ modal });
}

export function closeAiModal(): void {
  setAi({ modal: null });
}
