import type { IncomingMessage, ServerResponse } from 'node:http';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { BRAND } from '@app/shared';
import { z } from 'zod';
import { authorize, readBody, sendJson } from '../api/http.ts';
import { Args } from '../api/registry.ts';
import type { Kernel } from '../app.ts';
import { authenticate } from '../core/auth.ts';
import { ApiError } from '../core/errors.ts';
import { getUser } from '../core/users.ts';
import type { Actor } from '../ctx.ts';

/**
 * A Model Context Protocol endpoint at `/mcp`, so any MCP client (an agent, an
 * IDE, a chat app) can search, read and post with the permissions of the token
 * it presents. Every tool is a thin wrapper over an API method: the same
 * visibility and scope rules apply.
 *
 * The endpoint is stateless: each POST is handled on its own and answered with
 * JSON, so it works behind any proxy and needs no session storage.
 */

type Loose = Record<string, unknown>;

interface ToolContext {
  kernel: Kernel;
  actor: Actor;
  req: IncomingMessage;
  res: ServerResponse;
}

/** Run an API method as the MCP caller. */
async function call(tool: ToolContext, method: string, args: Loose): Promise<Loose> {
  const def = tool.kernel.registry.get(method);
  if (!def) throw new ApiError('unknown_method');
  authorize(def, tool.actor);
  for (const guard of tool.kernel.registry.guards) guard(method, tool.actor);
  const result = await def.handler({ ctx: tool.kernel.ctx, actor: tool.actor, args: new Args(args), req: tool.req, res: tool.res });
  return (result ?? {}) as Loose;
}

function ok(value: unknown): { content: { type: 'text'; text: string }[] } {
  return { content: [{ type: 'text', text: JSON.stringify(value, null, 1) }] };
}

function failed(error: unknown): { content: { type: 'text'; text: string }[]; isError: true } {
  const text = error instanceof ApiError ? JSON.stringify({ error: error.code, ...error.extra }) : 'internal_error';
  if (!(error instanceof ApiError)) console.error('[mcp] tool failed', error);
  return { content: [{ type: 'text', text }], isError: true };
}

/** Shrink a message to what a model needs, with the author's name resolved. */
function compactMessage(tool: ToolContext, message: Loose): Loose {
  const author = typeof message.user === 'string' ? getUser(tool.kernel.ctx, message.user) : undefined;
  const out: Loose = {
    ts: message.ts,
    user: message.user ?? null,
    user_name: author ? author.display_name || author.real_name || author.name : (message.username ?? null),
    text: message.text,
  };
  if (message.subtype) out.subtype = message.subtype;
  if (message.thread_ts) out.thread_ts = message.thread_ts;
  if (message.reply_count) out.reply_count = message.reply_count;
  if (Array.isArray(message.reactions)) {
    out.reactions = (message.reactions as Loose[]).map((reaction) => `${String(reaction.name)}×${String(reaction.count)}`);
  }
  if (Array.isArray(message.files)) {
    out.files = (message.files as Loose[]).map((file) => ({ id: file.id, name: file.name, url: file.url_private }));
  }
  // Text is only a fallback when a message is built from blocks; give the model the real content.
  if (Array.isArray(message.blocks)) {
    const markdown = (message.blocks as Loose[]).filter((block) => block.type === 'markdown').map((block) => String(block.text));
    if (markdown.length) out.text = markdown.join('\n\n');
  }
  return out;
}

function buildServer(tool: ToolContext): McpServer {
  const server = new McpServer({ name: BRAND.slug, version: tool.kernel.ctx.config.version });
  const readOnly = { readOnlyHint: true, openWorldHint: false };

  server.registerTool(
    'list_channels',
    {
      title: 'List channels',
      description: 'List the channels you can see: every public channel, plus the private channels you belong to.',
      inputSchema: { include_archived: z.boolean().optional().describe('Include archived channels. Default false.') },
      annotations: readOnly,
    },
    async ({ include_archived }) => {
      try {
        const result = await call(tool, 'conversations.list', {
          types: 'public_channel,private_channel',
          exclude_archived: !include_archived,
          limit: 1000,
        });
        return ok(
          (result.channels as Loose[]).map((channel) => ({
            id: channel.id,
            name: channel.name,
            is_private: channel.is_private,
            is_member: channel.is_member,
            num_members: channel.num_members,
            topic: (channel.topic as Loose | undefined)?.value || undefined,
            purpose: (channel.purpose as Loose | undefined)?.value || undefined,
          })),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'read_channel',
    {
      title: 'Read channel history',
      description:
        'Read messages from a channel or direct message, newest first. Thread replies are not included; use read_thread for a message that has reply_count.',
      inputSchema: {
        channel: z.string().describe('Channel id (C…), "#name", or a user id (U…) for the direct message with that person.'),
        limit: z.number().int().min(1).max(200).optional().describe('How many messages. Default 30.'),
        before_ts: z.string().optional().describe('Only messages older than this ts (for paging back).'),
        after_ts: z.string().optional().describe('Only messages newer than this ts.'),
      },
      annotations: readOnly,
    },
    async ({ channel, limit, before_ts, after_ts }) => {
      try {
        const args: Loose = { channel, limit: limit ?? 30 };
        if (before_ts) args.latest = before_ts;
        if (after_ts) args.oldest = after_ts;
        const result = await call(tool, 'conversations.history', args);
        return ok({
          messages: (result.messages as Loose[]).map((message) => compactMessage(tool, message)),
          has_more: result.has_more,
        });
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'read_thread',
    {
      title: 'Read a thread',
      description: 'Read a thread: the parent message followed by its replies, oldest first.',
      inputSchema: {
        channel: z.string().describe('Channel id or "#name".'),
        thread_ts: z.string().describe('The ts of the parent message.'),
      },
      annotations: readOnly,
    },
    async ({ channel, thread_ts }) => {
      try {
        const result = await call(tool, 'conversations.replies', { channel, ts: thread_ts, limit: 1000 });
        return ok({ messages: (result.messages as Loose[]).map((message) => compactMessage(tool, message)) });
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'search_messages',
    {
      title: 'Search messages',
      description:
        'Search every message you can read. Modifiers: in:#channel, from:@name, before:YYYY-MM-DD, after:YYYY-MM-DD, on:YYYY-MM-DD, has:link, has:file, has:reaction, is:thread. Quote a phrase to match it exactly.',
      inputSchema: {
        query: z.string().min(1).describe('Search text with optional modifiers.'),
        limit: z.number().int().min(1).max(100).optional().describe('How many results. Default 20.'),
      },
      annotations: readOnly,
    },
    async ({ query, limit }) => {
      try {
        const result = await call(tool, 'search.messages', { query, count: limit ?? 20 });
        const messages = result.messages as { total: number; matches: Loose[] };
        return ok({
          total: messages.total,
          matches: messages.matches.map((match) => ({
            channel: { id: (match.channel as Loose).id, name: (match.channel as Loose).name },
            ...compactMessage(tool, match),
            permalink: match.permalink,
          })),
        });
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'list_users',
    {
      title: 'List people',
      description: 'List the people and bots in this workspace.',
      inputSchema: {},
      annotations: readOnly,
    },
    async () => {
      try {
        const result = await call(tool, 'users.list', { limit: 1000 });
        return ok(
          (result.members as Loose[]).map((user) => {
            const profile = user.profile as Loose;
            return {
              id: user.id,
              name: user.name,
              real_name: user.real_name,
              title: profile.title || undefined,
              is_bot: user.is_bot || undefined,
              deactivated: user.deleted || undefined,
            };
          }),
        );
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'post_message',
    {
      title: 'Post a message',
      description:
        'Post a message as yourself. Write standard Markdown. Mention a person with <@USERID>. Set thread_ts to reply inside a thread.',
      inputSchema: {
        channel: z.string().describe('Channel id (C…), "#name", or a user id (U…) to send a direct message.'),
        text: z.string().min(1).describe('The message, in Markdown.'),
        thread_ts: z.string().optional().describe('Reply in the thread of this message.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, openWorldHint: false },
    },
    async ({ channel, text, thread_ts }) => {
      try {
        const args: Loose = { channel, markdown_text: text };
        if (thread_ts) args.thread_ts = thread_ts;
        const result = await call(tool, 'chat.postMessage', args);
        const link = await call(tool, 'chat.getPermalink', { channel: result.channel, message_ts: result.ts });
        return ok({ channel: result.channel, ts: result.ts, permalink: link.permalink });
      } catch (error) {
        return failed(error);
      }
    },
  );

  server.registerTool(
    'add_reaction',
    {
      title: 'React to a message',
      description: 'Add an emoji reaction to a message, for example "eyes" or "white_check_mark".',
      inputSchema: {
        channel: z.string().describe('Channel id or "#name".'),
        ts: z.string().describe('The ts of the message.'),
        name: z.string().describe('Emoji name without colons.'),
      },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ channel, ts, name }) => {
      try {
        await call(tool, 'reactions.add', { channel, timestamp: ts, name });
        return ok({ ok: true });
      } catch (error) {
        return error instanceof ApiError && error.code === 'already_reacted' ? ok({ ok: true }) : failed(error);
      }
    },
  );

  return server;
}

export function installMcp(kernel: Kernel): void {
  kernel.router.add(null, /^\/mcp$/, async ({ req, res }) => {
    // API tokens only: a browser cookie must never authorise this endpoint.
    const presentsToken = /^Bearer\s+\S/i.test(String(req.headers.authorization ?? ''));
    const { actor } = presentsToken ? authenticate(kernel.ctx, req, undefined) : { actor: null };
    if (!actor || actor.kind === 'session' || actor.kind === 'app') {
      sendJson(res, 401, { jsonrpc: '2.0', error: { code: -32001, message: 'A bot or user API token is required.' }, id: null }, {
        'www-authenticate': 'Bearer',
      });
      return;
    }
    if (req.method !== 'POST') {
      sendJson(res, 405, { jsonrpc: '2.0', error: { code: -32000, message: 'Use POST.' }, id: null }, { allow: 'POST' });
      return;
    }
    let body: unknown;
    try {
      body = JSON.parse((await readBody(req)).toString('utf8'));
    } catch {
      sendJson(res, 400, { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error' }, id: null });
      return;
    }
    const server = buildServer({ kernel, actor, req, res });
    const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    res.on('close', () => {
      void transport.close();
      void server.close();
    });
    await server.connect(transport);
    await transport.handleRequest(req, res, body);
  });
}
