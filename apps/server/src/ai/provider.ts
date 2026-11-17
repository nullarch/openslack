import Anthropic from '@anthropic-ai/sdk';

/**
 * The model behind the AI features, behind one small interface: the Claude API
 * through the official SDK, or any OpenAI-compatible chat endpoint (local
 * models, gateways). Nothing here runs until an admin connects a model.
 */

export type ProviderKind = 'anthropic' | 'openai_compatible';

export interface ProviderSettings {
  provider: ProviderKind;
  model: string;
  /** Optional for the Claude API (a proxy or gateway); required for OpenAI-compatible endpoints. */
  baseUrl: string | null;
  apiKey: string | null;
}

export interface AiRequest {
  system: string;
  prompt: string;
  maxTokens: number;
  /** How hard the model should think; only the Claude API path uses it. */
  effort?: 'low' | 'medium' | 'high';
}

export interface AiOutcome {
  /** Why generation stopped: finished, hit the length limit, or the model declined. */
  stop: 'end' | 'length' | 'refusal';
}

/** A failure talking to the model, with a short reason safe to show an admin. */
export class AiProviderError extends Error {
  readonly reason: string;

  constructor(reason: string, detail = '') {
    super(detail ? `${reason}: ${detail}` : reason);
    this.reason = reason;
  }
}

export interface AiProvider {
  /** Generate a reply, calling `onText` with each piece of text as it arrives. */
  run(request: AiRequest, onText: (delta: string) => void): Promise<AiOutcome>;
}

export const DEFAULT_CLAUDE_MODEL = 'claude-opus-5-5';

/** Models that accept the API's server-side fallback (`fallbacks: "default"`). */
const FALLBACK_MODELS = new Set(['claude-fable-5-2', 'claude-fable-5-1', 'claude-opus-5-5', 'claude-opus-5', 'claude-sonnet-5-5']);

class ClaudeProvider implements AiProvider {
  private readonly client: Anthropic;
  private readonly model: string;

  constructor(settings: ProviderSettings) {
    this.client = new Anthropic({
      // An empty key still lets the SDK fall back to ANTHROPIC_API_KEY or an `ant auth login` profile.
      ...(settings.apiKey ? { apiKey: settings.apiKey } : {}),
      ...(settings.baseUrl ? { baseURL: settings.baseUrl } : {}),
      maxRetries: 2,
      timeout: 5 * 60_000,
    });
    this.model = settings.model || DEFAULT_CLAUDE_MODEL;
  }

  async run(request: AiRequest, onText: (delta: string) => void): Promise<AiOutcome> {
    // Server-side fallback: when a request is declined, the API retries it on
    // another model inside the same call instead of answering with a refusal.
    const fallback = FALLBACK_MODELS.has(this.model)
      ? { betas: ['server-side-fallback-2026-07-01'], fallbacks: 'default' as const }
      : {};
    try {
      const stream = this.client.beta.messages.stream({
        model: this.model,
        max_tokens: request.maxTokens,
        ...(request.effort ? { output_config: { effort: request.effort } } : {}),
        ...fallback,
        system: request.system,
        messages: [{ role: 'user', content: request.prompt }],
      });
      for await (const event of stream) {
        if (event.type === 'content_block_delta' && event.delta.type === 'text_delta') onText(event.delta.text);
      }
      const message = await stream.finalMessage();
      if (message.stop_reason === 'refusal') return { stop: 'refusal' };
      if (message.stop_reason === 'max_tokens') return { stop: 'length' };
      return { stop: 'end' };
    } catch (error) {
      if (error instanceof Anthropic.AuthenticationError || error instanceof Anthropic.PermissionDeniedError) {
        throw new AiProviderError('authentication_failed');
      }
      if (error instanceof Anthropic.NotFoundError) throw new AiProviderError('model_not_found', this.model);
      if (error instanceof Anthropic.RateLimitError) throw new AiProviderError('rate_limited');
      if (error instanceof Anthropic.BadRequestError) throw new AiProviderError('bad_request', error.message.slice(0, 200));
      if (error instanceof Anthropic.APIConnectionError) throw new AiProviderError('unreachable');
      if (error instanceof Anthropic.APIError) throw new AiProviderError('provider_error', `HTTP ${error.status ?? '?'}`);
      throw error;
    }
  }
}

/** Any server speaking the OpenAI chat-completions protocol: vLLM, Ollama, LM Studio, LiteLLM, … */
class OpenAiCompatibleProvider implements AiProvider {
  private readonly settings: ProviderSettings;

  constructor(settings: ProviderSettings) {
    if (!settings.baseUrl) throw new AiProviderError('base_url_required');
    this.settings = settings;
  }

  async run(request: AiRequest, onText: (delta: string) => void): Promise<AiOutcome> {
    const url = `${this.settings.baseUrl!.replace(/\/+$/, '')}/chat/completions`;
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.settings.apiKey ? { authorization: `Bearer ${this.settings.apiKey}` } : {}),
        },
        body: JSON.stringify({
          model: this.settings.model,
          stream: true,
          max_tokens: request.maxTokens,
          messages: [
            { role: 'system', content: request.system },
            { role: 'user', content: request.prompt },
          ],
        }),
        signal: AbortSignal.timeout(5 * 60_000),
      });
    } catch {
      throw new AiProviderError('unreachable');
    }
    if (response.status === 401 || response.status === 403) throw new AiProviderError('authentication_failed');
    if (response.status === 404) throw new AiProviderError('model_not_found', this.settings.model);
    if (response.status === 429) throw new AiProviderError('rate_limited');
    if (!response.ok || !response.body) throw new AiProviderError('provider_error', `HTTP ${response.status}`);

    let stop: AiOutcome['stop'] = 'end';
    let buffer = '';
    const decoder = new TextDecoder();
    for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
      buffer += decoder.decode(chunk, { stream: true });
      let newline: number;
      while ((newline = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, newline).trim();
        buffer = buffer.slice(newline + 1);
        if (!line.startsWith('data:')) continue;
        const data = line.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const parsed = JSON.parse(data) as { choices?: { delta?: { content?: string }; finish_reason?: string | null }[] };
          const choice = parsed.choices?.[0];
          if (choice?.delta?.content) onText(choice.delta.content);
          if (choice?.finish_reason === 'length') stop = 'length';
          if (choice?.finish_reason === 'content_filter') stop = 'refusal';
        } catch {
          // A keep-alive or a line this client does not understand.
        }
      }
    }
    return { stop };
  }
}

export function createProvider(settings: ProviderSettings): AiProvider {
  return settings.provider === 'openai_compatible' ? new OpenAiCompatibleProvider(settings) : new ClaudeProvider(settings);
}
