/**
 * Just enough MIME (RFC 2045–2047, 2231) to turn an incoming email into a
 * message: headers with encoded words, multipart bodies, base64 and
 * quoted-printable, character sets, the plain-text body (or the HTML one with
 * its tags removed) and attachments.
 */

export interface ParsedMail {
  from: { name: string; address: string };
  to: string[];
  subject: string;
  text: string;
  attachments: { filename: string; contentType: string; content: Buffer }[];
}

interface Part {
  headers: Map<string, string>;
  body: Buffer;
}

function splitHeaders(raw: Buffer): Part {
  const text = raw.toString('latin1');
  const match = /\r?\n\r?\n/.exec(text);
  const headerText = match ? text.slice(0, match.index) : text;
  const bodyStart = match ? match.index + match[0].length : raw.length;
  const headers = new Map<string, string>();
  for (const line of headerText.replace(/\r?\n[ \t]+/g, ' ').split(/\r?\n/)) {
    const colon = line.indexOf(':');
    if (colon <= 0) continue;
    const name = line.slice(0, colon).trim().toLowerCase();
    if (!headers.has(name)) headers.set(name, line.slice(colon + 1).trim());
  }
  return { headers, body: raw.subarray(bodyStart) };
}

function decodeCharset(bytes: Buffer, charset: string): string {
  try {
    return new TextDecoder(charset.toLowerCase().replace(/^(x-|cs)/, '') || 'utf-8').decode(bytes);
  } catch {
    return bytes.toString('utf8');
  }
}

/** `=?charset?B|Q?…?=` words in a header value (RFC 2047); header bytes themselves are read as UTF-8. */
export function decodeHeader(value: string): string {
  // Raw header bytes arrive as latin1; a value already decoded (RFC 2231 parameters) is left as it is.
  const utf8 = /[^\u0000-\u00ff]/.test(value) ? value : Buffer.from(value, 'latin1').toString('utf8');
  return utf8
    .replace(/\?=\s+=\?/g, '?==?')
    .replace(/=\?([^?]+)\?([bBqQ])\?([^?]*)\?=/g, (_all, charset: string, encoding: string, data: string) => {
      const bytes = encoding.toUpperCase() === 'B' ? Buffer.from(data, 'base64') : Buffer.from(data.replace(/_/g, ' ').replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
      return decodeCharset(bytes, charset);
    });
}

function parameters(value: string): { value: string; params: Map<string, string> } {
  const [head = '', ...rest] = value.split(';');
  const params = new Map<string, string>();
  const continued = new Map<string, string[]>();
  for (const piece of rest) {
    const equals = piece.indexOf('=');
    if (equals < 0) continue;
    let key = piece.slice(0, equals).trim().toLowerCase();
    let raw = piece.slice(equals + 1).trim().replace(/^"(.*)"$/, '$1');
    // RFC 2231: name*=charset''percent-encoded, and name*0*= continuations.
    const extended = key.endsWith('*');
    if (extended) key = key.slice(0, -1);
    const section = /^(.*)\*(\d+)$/.exec(key);
    if (extended) {
      const quote = raw.indexOf("''");
      const charset = quote >= 0 ? raw.slice(0, quote) : 'utf-8';
      if (quote >= 0) raw = raw.slice(quote + 2);
      try {
        raw = decodeCharset(Buffer.from(raw.replace(/%([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1'), charset || 'utf-8');
      } catch {
        // keep as is
      }
    }
    if (section) {
      const list = continued.get(section[1]!) ?? [];
      list[Number(section[2])] = raw;
      continued.set(section[1]!, list);
    } else params.set(key, raw);
  }
  for (const [key, list] of continued) if (!params.has(key)) params.set(key, list.join(''));
  return { value: head.trim().toLowerCase(), params };
}

function transferDecode(body: Buffer, encoding: string): Buffer {
  const kind = encoding.trim().toLowerCase();
  if (kind === 'base64') return Buffer.from(body.toString('latin1').replace(/[^A-Za-z0-9+/=]/g, ''), 'base64');
  if (kind === 'quoted-printable') {
    const text = body.toString('latin1').replace(/=\r?\n/g, '');
    return Buffer.from(text.replace(/=([0-9A-Fa-f]{2})/g, (_m, hex: string) => String.fromCharCode(Number.parseInt(hex, 16))), 'latin1');
  }
  return body;
}

function walk(part: Part, out: { plain: string[]; html: string[]; attachments: ParsedMail['attachments'] }, depth = 0): void {
  if (depth > 10) return;
  const type = parameters(part.headers.get('content-type') ?? 'text/plain');
  const disposition = parameters(part.headers.get('content-disposition') ?? '');
  if (type.value.startsWith('multipart/')) {
    const boundary = type.params.get('boundary');
    if (!boundary) return;
    const text = part.body.toString('latin1');
    const marker = `--${boundary}`;
    const pieces = text.split(marker).slice(1);
    for (const piece of pieces) {
      if (piece.startsWith('--')) break;
      const content = piece.replace(/^\r?\n/, '').replace(/\r?\n$/, '');
      walk(splitHeaders(Buffer.from(content, 'latin1')), out, depth + 1);
    }
    return;
  }
  if (type.value === 'message/rfc822') {
    walk(splitHeaders(transferDecode(part.body, part.headers.get('content-transfer-encoding') ?? '')), out, depth + 1);
    return;
  }
  const body = transferDecode(part.body, part.headers.get('content-transfer-encoding') ?? '7bit');
  const filename = disposition.params.get('filename') ?? type.params.get('name');
  const isAttachment = disposition.value === 'attachment' || (filename !== undefined && !type.value.startsWith('text/'));
  if (isAttachment) {
    out.attachments.push({ filename: decodeHeader(filename ?? 'attachment'), contentType: type.value || 'application/octet-stream', content: body });
    return;
  }
  const charset = type.params.get('charset') ?? 'utf-8';
  if (type.value === 'text/plain' || type.value === '') out.plain.push(decodeCharset(body, charset));
  else if (type.value === 'text/html') out.html.push(decodeCharset(body, charset));
}

function htmlToText(html: string): string {
  return html
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, '')
    .replace(/<br\s*\/?>/gi, '\n')
    .replace(/<\/(p|div|li|tr|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_m, code: string) => String.fromCodePoint(Number(code)))
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

function addresses(value: string | undefined): string[] {
  if (!value) return [];
  return [...decodeHeader(value).matchAll(/[\w.+'-]+@[\w-]+(?:\.[\w-]+)+/g)].map((match) => match[0]!.toLowerCase());
}

export function parseMail(raw: Buffer): ParsedMail {
  const root = splitHeaders(raw);
  const out = { plain: [] as string[], html: [] as string[], attachments: [] as ParsedMail['attachments'] };
  walk(root, out);
  const fromHeader = decodeHeader(root.headers.get('from') ?? '');
  const address = addresses(fromHeader)[0] ?? '';
  const name = fromHeader.replace(/<[^>]*>/, '').replace(/"/g, '').trim() || address;
  const recipients = ['to', 'cc', 'delivered-to', 'x-original-to', 'envelope-to'].flatMap((key) => addresses(root.headers.get(key)));
  return {
    from: { name: name === address ? address : name, address },
    to: [...new Set(recipients)],
    subject: decodeHeader(root.headers.get('subject') ?? '').trim(),
    text: (out.plain.join('\n\n') || htmlToText(out.html.join('\n'))).replace(/\r\n/g, '\n').trim(),
    attachments: out.attachments,
  };
}
