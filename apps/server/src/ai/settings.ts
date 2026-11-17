import type { Ctx } from '../ctx.ts';
import { fail } from '../core/errors.ts';
import { nowSeconds } from '../core/ids.ts';
import { createProvider, DEFAULT_CLAUDE_MODEL, type AiProvider, type ProviderKind, type ProviderSettings } from './provider.ts';

/** The AI features an admin can switch on and off one by one. */
export const FEATURES = ['summaries', 'recaps', 'search_answers', 'translate', 'writing'] as const;
export type Feature = (typeof FEATURES)[number];

interface SettingsRow {
  provider: ProviderKind;
  model: string;
  base_url: string | null;
  api_key: string | null;
  features: string;
  updated: number;
  updated_by: string;
}

export interface AiSettings extends ProviderSettings {
  features: Record<Feature, boolean>;
  updated: number;
  updatedBy: string;
}

function parseFeatures(text: string): Record<Feature, boolean> {
  let stored: Record<string, unknown> = {};
  try {
    stored = JSON.parse(text) as Record<string, unknown>;
  } catch {
    // Corrupt settings: treat every feature as on, the default.
  }
  return Object.fromEntries(FEATURES.map((feature) => [feature, stored[feature] !== false])) as Record<Feature, boolean>;
}

/** The connected model, or null: nothing leaves the server until an admin connects one. */
export function loadSettings(ctx: Ctx): AiSettings | null {
  const row = ctx.db.get<SettingsRow>('SELECT * FROM ai_settings WHERE id = 1');
  if (!row) return null;
  return {
    provider: row.provider,
    model: row.model,
    baseUrl: row.base_url,
    apiKey: row.api_key,
    features: parseFeatures(row.features),
    updated: row.updated,
    updatedBy: row.updated_by,
  };
}

/** The provider for `feature`, failing with a clear error when AI is off. */
export function requireProvider(ctx: Ctx, feature: Feature): { provider: AiProvider; settings: AiSettings } {
  const settings = loadSettings(ctx);
  if (!settings) fail('ai_not_configured');
  if (!settings.features[feature]) fail('ai_feature_disabled', { feature });
  return { provider: createProvider(settings), settings };
}

function keyHint(key: string | null): string | null {
  if (!key) return null;
  return key.length <= 8 ? '••••' : `${key.slice(0, 4)}…${key.slice(-4)}`;
}

/** Settings as admins see them. The key itself never leaves the server. */
export function settingsToApi(settings: AiSettings | null): Record<string, unknown> {
  if (!settings) {
    return {
      configured: false,
      provider: 'anthropic',
      model: DEFAULT_CLAUDE_MODEL,
      base_url: null,
      has_key: false,
      key_hint: null,
      features: Object.fromEntries(FEATURES.map((feature) => [feature, true])),
    };
  }
  return {
    configured: true,
    provider: settings.provider,
    model: settings.model,
    base_url: settings.baseUrl,
    has_key: Boolean(settings.apiKey),
    key_hint: keyHint(settings.apiKey),
    features: settings.features,
    updated: settings.updated,
    updated_by: settings.updatedBy,
  };
}

export interface SettingsInput {
  provider?: string;
  model?: string;
  baseUrl?: string | null;
  /** A new key; undefined keeps the stored one. */
  apiKey?: string;
  clearKey?: boolean;
  features?: Record<string, unknown>;
}

function validUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    fail('invalid_base_url');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') fail('invalid_base_url');
  return value.replace(/\/+$/, '');
}

export function saveSettings(ctx: Ctx, userId: string, input: SettingsInput): AiSettings {
  const current = loadSettings(ctx);
  const provider = (input.provider ?? current?.provider ?? 'anthropic') as ProviderKind;
  if (provider !== 'anthropic' && provider !== 'openai_compatible') fail('invalid_provider');
  const providerChanged = current !== null && current.provider !== provider;
  const model = (input.model ?? (providerChanged ? '' : current?.model) ?? '').trim() || (provider === 'anthropic' ? DEFAULT_CLAUDE_MODEL : '');
  if (!model) fail('model_required');
  if (model.length > 200) fail('invalid_model');
  const rawBase = input.baseUrl === undefined ? (providerChanged ? null : (current?.baseUrl ?? null)) : input.baseUrl;
  const baseUrl = rawBase ? validUrl(rawBase.trim()) : null;
  if (provider === 'openai_compatible' && !baseUrl) fail('base_url_required');
  let apiKey = providerChanged ? null : (current?.apiKey ?? null);
  if (input.clearKey) apiKey = null;
  if (input.apiKey !== undefined && input.apiKey.trim() !== '') apiKey = input.apiKey.trim();
  const features = { ...(current?.features ?? parseFeatures('{}')) };
  for (const feature of FEATURES) {
    if (input.features && typeof input.features[feature] === 'boolean') features[feature] = input.features[feature] as boolean;
  }
  ctx.db.run(
    `INSERT INTO ai_settings (id, provider, model, base_url, api_key, features, updated, updated_by)
     VALUES (1, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (id) DO UPDATE SET provider = excluded.provider, model = excluded.model, base_url = excluded.base_url,
       api_key = excluded.api_key, features = excluded.features, updated = excluded.updated, updated_by = excluded.updated_by`,
    provider,
    model,
    baseUrl,
    apiKey,
    JSON.stringify(features),
    nowSeconds(),
    userId,
  );
  return loadSettings(ctx)!;
}

export function clearSettings(ctx: Ctx): void {
  ctx.db.run('DELETE FROM ai_settings');
}
