import { createServer, type Server, type Socket } from 'node:net';
import type { AddressInfo } from 'node:net';

/** One message as the sink received it, with the body decoded enough to read codes and links. */
export interface SunkMail {
  from: string;
  to: string[];
  raw: string;
  subject: string;
  /** The message with quoted-printable soft breaks and escapes undone. */
  text: string;
}

/**
 * A tiny SMTP server that accepts everything and keeps it in memory, so tests
 * can read what the server sent without any real mail system.
 */
export class MailSink {
  readonly mails: SunkMail[] = [];
  private server: Server | null = null;
  private waiters: { match: (mail: SunkMail) => boolean; resolve: (mail: SunkMail) => void }[] = [];
  port = 0;

  async start(): Promise<string> {
    this.server = createServer((socket) => this.session(socket));
    await new Promise<void>((resolve) => this.server!.listen(0, '127.0.0.1', resolve));
    this.port = (this.server.address() as AddressInfo).port;
    return `smtp://127.0.0.1:${this.port}`;
  }

  async stop(): Promise<void> {
    await new Promise<void>((resolve) => this.server?.close(() => resolve()) ?? resolve());
  }

  /** The first message (already received or future) that matches. */
  next(match: (mail: SunkMail) => boolean = () => true, timeoutMs = 3000): Promise<SunkMail> {
    const seen = this.mails.find(match);
    if (seen) return Promise.resolve(seen);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('no mail arrived')), timeoutMs);
      this.waiters.push({
        match,
        resolve: (mail) => {
          clearTimeout(timer);
          resolve(mail);
        },
      });
    });
  }

  private deliver(mail: SunkMail): void {
    this.mails.push(mail);
    this.waiters = this.waiters.filter((waiter) => {
      if (!waiter.match(mail)) return true;
      waiter.resolve(mail);
      return false;
    });
  }

  private session(socket: Socket): void {
    let buffer = '';
    let inData = false;
    let data = '';
    let from = '';
    let to: string[] = [];
    const reply = (line: string): void => {
      socket.write(`${line}\r\n`);
    };
    reply('220 sink ESMTP ready');
    socket.on('data', (chunk) => {
      buffer += chunk.toString('utf8');
      for (;;) {
        if (inData) {
          const end = buffer.indexOf('\r\n.\r\n');
          if (end === -1) return;
          data += buffer.slice(0, end);
          buffer = buffer.slice(end + 5);
          inData = false;
          const raw = data.replace(/^\.\./gm, '.');
          const text = raw.replace(/=\r\n/g, '').replace(/=([0-9A-F]{2})/g, (_all, hex: string) => String.fromCharCode(parseInt(hex, 16)));
          const subject = /^Subject: (.*)$/im.exec(raw)?.[1] ?? '';
          this.deliver({ from, to, raw, subject: decodeHeader(subject), text: Buffer.from(text, 'latin1').toString('utf8') });
          data = '';
          reply('250 queued');
          continue;
        }
        const newline = buffer.indexOf('\r\n');
        if (newline === -1) return;
        const line = buffer.slice(0, newline);
        buffer = buffer.slice(newline + 2);
        const verb = line.slice(0, 4).toUpperCase();
        if (verb === 'EHLO') reply('250-sink\r\n250-8BITMIME\r\n250 SMTPUTF8');
        else if (verb === 'HELO') reply('250 sink');
        else if (verb === 'MAIL') {
          from = /<([^>]*)>/.exec(line)?.[1] ?? '';
          to = [];
          reply('250 ok');
        } else if (verb === 'RCPT') {
          to.push(/<([^>]*)>/.exec(line)?.[1] ?? '');
          reply('250 ok');
        } else if (verb === 'DATA') {
          inData = true;
          reply('354 end with .');
        } else if (verb === 'QUIT') {
          reply('221 bye');
          socket.end();
        } else reply('250 ok');
      }
    });
    socket.on('error', () => undefined);
  }
}

/** Undo RFC 2047 encoded words (`=?UTF-8?Q?…?=` / `=?UTF-8?B?…?=`) in a header. */
function decodeHeader(value: string): string {
  return value.replace(/=\?utf-8\?([QB])\?([^?]*)\?=/gi, (_all, kind: string, body: string) => {
    if (kind.toUpperCase() === 'B') return Buffer.from(body, 'base64').toString('utf8');
    const bytes = body.replace(/_/g, ' ').replace(/=([0-9A-F]{2})/gi, (_m, hex: string) => String.fromCharCode(parseInt(hex, 16)));
    return Buffer.from(bytes, 'latin1').toString('utf8');
  });
}
