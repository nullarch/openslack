// A stand-in for an OpenAI-compatible model server: always answers with one fixed sentence.
import { createServer } from 'node:http';
const REPLY = 'Hello from OpenClaw, running against this server with an unmodified Slack plugin.';
createServer((req, res) => {
  let body = '';
  req.on('data', (c) => (body += c));
  req.on('end', () => {
    if (req.url.endsWith('/models')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ object: 'list', data: [{ id: 'mock', object: 'model', owned_by: 'local' }] }));
      return;
    }
    if (req.url.endsWith('/chat/completions')) {
      const json = body ? JSON.parse(body) : {};
      console.log('chat request, messages:', json.messages?.length, 'stream:', !!json.stream);
      const id = 'chatcmpl-mock';
      if (json.stream) {
        res.writeHead(200, { 'content-type': 'text/event-stream' });
        const send = (o) => res.write(`data: ${JSON.stringify(o)}\n\n`);
        send({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { role: 'assistant', content: '' } }] });
        for (const word of REPLY.split(/(?<= )/)) send({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: { content: word } }] });
        send({ id, object: 'chat.completion.chunk', model: 'mock', choices: [{ index: 0, delta: {}, finish_reason: 'stop' }] });
        send({ id, object: 'chat.completion.chunk', model: 'mock', choices: [], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } });
        res.end('data: [DONE]\n\n');
        return;
      }
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ id, object: 'chat.completion', model: 'mock', choices: [{ index: 0, message: { role: 'assistant', content: REPLY }, finish_reason: 'stop' }], usage: { prompt_tokens: 10, completion_tokens: 12, total_tokens: 22 } }));
      return;
    }
    res.writeHead(404); res.end();
  });
}).listen(Number(process.env.PORT ?? 28000), '127.0.0.1', () => console.log('mock model server listening'));
