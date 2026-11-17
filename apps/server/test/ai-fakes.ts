import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

/**
 * Stand-ins for the model providers, so the AI features are tested without
 * credentials or cost: a Claude Messages API (streaming SSE) and an
 * OpenAI-compatible chat endpoint. Both record every request.
 */

export interface RecordedRequest {
  url: string;
  headers: IncomingHttpHeaders;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  body: any;
}

export interface FakeProvider {
  url: string;
  requests: RecordedRequest[];
  /** Override the reply for the next requests. */
  reply: ((system: string, prompt: string) => string) | null;
  /** Answer the next request with this HTTP status instead. */
  failNextWith: number | null;
  close(): Promise<void>;
}

/** The text a stand-in answers with, chosen by what the request is for. */
export function defaultReply(system: string, prompt: string): string {
  if (system.includes('You translate')) return 'Le gel du code est toujours prévu pour jeudi.';
  if (system.includes('help someone edit')) return 'Could you review the release notes by Friday?';
  if (system.includes('connection works')) return 'ready';
  if (system.includes('daily recap')) return '### #general\n- The release ships Thursday [1].';
  if (system.includes('answer a question')) return 'The freeze is on Thursday [1].';
  const cited = [...prompt.matchAll(/^\[(\d+)\]/gm)].map((match) => `[${match[1]}]`).slice(0, 2).join('');
  return `**Decisions**\n- Ship on Thursday ${cited}\n- Nothing else.`;
}

function listen(server: Server): Promise<string> {
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(`http://127.0.0.1:${(server.address() as AddressInfo).port}`)));
}

function words(text: string): string[] {
  return text.match(/\S+\s*|\s+/g) ?? [text];
}

export async function fakeClaude(): Promise<FakeProvider> {
  const fake: FakeProvider = { url: '', requests: [], reply: null, failNextWith: null, close: async () => undefined };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      fake.requests.push({ url: req.url ?? '', headers: req.headers, body });
      if (fake.failNextWith) {
        const status = fake.failNextWith;
        fake.failNextWith = null;
        res.writeHead(status, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ type: 'error', error: { type: status === 401 ? 'authentication_error' : 'api_error', message: 'stand-in failure' } }));
        return;
      }
      const system = typeof body.system === 'string' ? body.system : '';
      const prompt = String(body.messages?.[0]?.content ?? '');
      const text = (fake.reply ?? defaultReply)(system, prompt);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      const send = (type: string, data: object): void => {
        res.write(`event: ${type}\ndata: ${JSON.stringify({ type, ...data })}\n\n`);
      };
      send('message_start', {
        message: { id: 'msg_fake', type: 'message', role: 'assistant', model: body.model, content: [], stop_reason: null, stop_sequence: null, usage: { input_tokens: 10, output_tokens: 0 } },
      });
      send('content_block_start', { index: 0, content_block: { type: 'text', text: '' } });
      for (const piece of words(text)) send('content_block_delta', { index: 0, delta: { type: 'text_delta', text: piece } });
      send('content_block_stop', { index: 0 });
      send('message_delta', { delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: { output_tokens: 5 } });
      send('message_stop', {});
      res.end();
    });
  });
  fake.url = await listen(server);
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}

export async function fakeOpenAi(): Promise<FakeProvider> {
  const fake: FakeProvider = { url: '', requests: [], reply: null, failNextWith: null, close: async () => undefined };
  const server = createServer((req, res) => {
    let raw = '';
    req.on('data', (chunk) => (raw += chunk));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}');
      fake.requests.push({ url: req.url ?? '', headers: req.headers, body });
      if (fake.failNextWith) {
        const status = fake.failNextWith;
        fake.failNextWith = null;
        res.writeHead(status).end();
        return;
      }
      const system = String(body.messages?.find((m: { role: string }) => m.role === 'system')?.content ?? '');
      const prompt = String(body.messages?.find((m: { role: string }) => m.role === 'user')?.content ?? '');
      const text = (fake.reply ?? defaultReply)(system, prompt);
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const piece of words(text)) res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: { content: piece } }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] })}\n\n`);
      res.end('data: [DONE]\n\n');
    });
  });
  fake.url = await listen(server);
  fake.close = () => new Promise((resolve) => server.close(() => resolve()));
  return fake;
}
