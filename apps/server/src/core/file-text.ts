import { inflateRawSync, inflateSync } from 'node:zlib';
import type { Ctx } from '../ctx.ts';
import type { FileRow } from './files.ts';

/**
 * Text inside uploaded files, so search finds a file by what it says and not
 * only by its name: plain text and code, Word, Excel and PowerPoint files
 * (XML inside a zip) and PDFs (text drawn by content streams, mapped through
 * the fonts' ToUnicode tables where they have them). No external tools; what
 * cannot be read is simply not indexed.
 */

const MAX_BYTES = 20 * 1024 * 1024;
const MAX_CHARS = 200_000;

const TEXT_TYPES = /^(text\/|application\/(json|xml|javascript|x-yaml|yaml|sql|x-sh|toml|csv))/;
const TEXT_EXTENSIONS = new Set([
  'txt', 'md', 'markdown', 'csv', 'tsv', 'json', 'yaml', 'yml', 'xml', 'html', 'htm', 'log', 'ini', 'toml', 'sql', 'sh',
  'js', 'mjs', 'ts', 'tsx', 'jsx', 'py', 'rb', 'go', 'rs', 'java', 'kt', 'swift', 'c', 'h', 'cpp', 'cs', 'php', 'css', 'scss', 'vue',
]);

export type Extractor = (bytes: Buffer) => string;

export function extractorFor(name: string, mimetype: string): Extractor | null {
  const extension = name.toLowerCase().split('.').pop() ?? '';
  if (extension === 'docx') return (bytes) => officeText(bytes, (entry) => entry === 'word/document.xml' || /^word\/(header|footer|footnotes)\d*\.xml$/.test(entry));
  if (extension === 'pptx') return (bytes) => officeText(bytes, (entry) => /^ppt\/(slides\/slide|notesSlides\/notesSlide)\d+\.xml$/.test(entry));
  if (extension === 'xlsx') return (bytes) => officeText(bytes, (entry) => entry === 'xl/sharedStrings.xml' || /^xl\/worksheets\/sheet\d+\.xml$/.test(entry));
  if (extension === 'pdf' || mimetype === 'application/pdf') return pdfText;
  if (TEXT_TYPES.test(mimetype) || TEXT_EXTENSIONS.has(extension)) return plainText;
  return null;
}

function plainText(bytes: Buffer): string {
  if (bytes.subarray(0, 8000).includes(0)) return ''; // binary after all
  return bytes.toString('utf8');
}

// ── Office files: entries of a zip, read from memory ────────────────────────

function zipEntries(bytes: Buffer): Map<string, () => Buffer> {
  const entries = new Map<string, () => Buffer>();
  // End of central directory: the last "PK\x05\x06".
  let end = -1;
  for (let i = bytes.length - 22; i >= Math.max(0, bytes.length - 65_557); i -= 1) {
    if (bytes.readUInt32LE(i) === 0x06054b50) {
      end = i;
      break;
    }
  }
  if (end < 0) return entries;
  const count = bytes.readUInt16LE(end + 10);
  let offset = bytes.readUInt32LE(end + 16);
  for (let index = 0; index < count && offset + 46 <= bytes.length; index += 1) {
    if (bytes.readUInt32LE(offset) !== 0x02014b50) break;
    const method = bytes.readUInt16LE(offset + 10);
    const compressed = bytes.readUInt32LE(offset + 20);
    const nameLength = bytes.readUInt16LE(offset + 28);
    const extraLength = bytes.readUInt16LE(offset + 30);
    const commentLength = bytes.readUInt16LE(offset + 32);
    const local = bytes.readUInt32LE(offset + 42);
    const name = bytes.toString('utf8', offset + 46, offset + 46 + nameLength);
    entries.set(name, () => {
      const start = local + 30 + bytes.readUInt16LE(local + 26) + bytes.readUInt16LE(local + 28);
      const data = bytes.subarray(start, start + compressed);
      return method === 8 ? inflateRawSync(data) : Buffer.from(data);
    });
    offset += 46 + nameLength + extraLength + commentLength;
  }
  return entries;
}

const ENTITIES: Record<string, string> = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };

function xmlText(xml: string): string {
  return xml
    .replace(/<\/(w:p|a:p|si|row|c)>/g, '\n')
    .replace(/<w:tab\/>|<\/a:t>/g, ' ')
    .replace(/<[^>]+>/g, '')
    .replace(/&(#x[0-9a-f]+|#\d+|\w+);/gi, (all, code: string) => {
      if (code.startsWith('#x') || code.startsWith('#X')) return String.fromCodePoint(Number.parseInt(code.slice(2), 16));
      if (code.startsWith('#')) return String.fromCodePoint(Number(code.slice(1)));
      return ENTITIES[code] ?? all;
    });
}

function officeText(bytes: Buffer, wanted: (entry: string) => boolean): string {
  const entries = zipEntries(bytes);
  const names = [...entries.keys()].filter(wanted).sort((a, b) => a.localeCompare(b, 'en', { numeric: true }));
  return names.map((name) => xmlText(entries.get(name)!().toString('utf8'))).join('\n');
}

// ── PDF ─────────────────────────────────────────────────────────────────────

function streams(pdf: Buffer): { dictionary: string; data: Buffer }[] {
  const out: { dictionary: string; data: Buffer }[] = [];
  const text = pdf.toString('latin1');
  const pattern = /(?<!end)stream\r?\n/g;
  for (let match = pattern.exec(text); match; match = pattern.exec(text)) {
    const start = match.index + match[0].length;
    const end = text.indexOf('endstream', start);
    if (end < 0) break;
    const dictionaryStart = text.lastIndexOf('<<', match.index);
    const dictionary = dictionaryStart >= 0 ? text.slice(dictionaryStart, match.index) : '';
    let data = pdf.subarray(start, end);
    if (/\/FlateDecode/.test(dictionary)) {
      try {
        data = inflateSync(data);
      } catch {
        try {
          data = inflateSync(data.subarray(0, data.length - 1));
        } catch {
          data = Buffer.alloc(0);
        }
      }
    } else if (/\/Filter/.test(dictionary)) {
      data = Buffer.alloc(0); // other filters (images, LZW) carry no text we can read
    }
    out.push({ dictionary, data });
    pattern.lastIndex = end + 'endstream'.length;
  }
  return out;
}

/** Glyph codes → text, from every ToUnicode CMap in the file. */
function toUnicode(cmaps: string[]): { map: Map<string, string>; width: number } {
  const map = new Map<string, string>();
  let width = 2;
  const hexText = (hex: string): string => {
    let out = '';
    for (let i = 0; i + 4 <= hex.length; i += 4) out += String.fromCharCode(Number.parseInt(hex.slice(i, i + 4), 16));
    return out;
  };
  for (const cmap of cmaps) {
    for (const block of cmap.matchAll(/beginbfchar([\s\S]*?)endbfchar/g)) {
      for (const pair of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>/g)) {
        width = pair[1]!.length / 2;
        map.set(pair[1]!.toLowerCase(), hexText(pair[2]!));
      }
    }
    for (const block of cmap.matchAll(/beginbfrange([\s\S]*?)endbfrange/g)) {
      for (const range of block[1]!.matchAll(/<([0-9a-fA-F]+)>\s*<([0-9a-fA-F]+)>\s*(<([0-9a-fA-F]+)>|\[([^\]]*)\])/g)) {
        const from = Number.parseInt(range[1]!, 16);
        const to = Number.parseInt(range[2]!, 16);
        width = range[1]!.length / 2;
        if (to - from > 65_535) continue;
        const pad = (code: number): string => code.toString(16).padStart(range[1]!.length, '0');
        if (range[4]) {
          const base = Number.parseInt(range[4], 16);
          for (let code = from; code <= to; code += 1) map.set(pad(code), String.fromCharCode(base + (code - from)));
        } else if (range[5]) {
          const targets = [...range[5].matchAll(/<([0-9a-fA-F]+)>/g)].map((item) => hexText(item[1]!));
          targets.forEach((target, index) => map.set(pad(from + index), target));
        }
      }
    }
  }
  return { map, width };
}

function pdfLiteral(raw: string): string {
  return raw.replace(/\\([nrtbf()\\]|[0-7]{1,3}|\r?\n)/g, (_all, escape: string) => {
    if (/^[0-7]+$/.test(escape)) return String.fromCharCode(Number.parseInt(escape, 8));
    return ({ n: '\n', r: '', t: '\t', b: '', f: '', '(': '(', ')': ')', '\\': '\\' } as Record<string, string>)[escape] ?? '';
  });
}

function pdfText(pdf: Buffer): string {
  if (pdf.toString('latin1', 0, 5) !== '%PDF-') return '';
  const all = streams(pdf);
  const decoded = all.map((stream) => stream.data.toString('latin1'));
  const { map, width } = toUnicode(decoded.filter((text) => text.includes('begincmap')));
  const hex = (value: string): string => {
    const clean = value.replace(/\s+/g, '').toLowerCase();
    if (map.size) {
      let out = '';
      for (let i = 0; i + width * 2 <= clean.length; i += width * 2) out += map.get(clean.slice(i, i + width * 2)) ?? '';
      return out;
    }
    return Buffer.from(clean, 'hex').toString('latin1');
  };
  const literal = (value: string): string => {
    const text = pdfLiteral(value);
    if (!map.size || width !== 1) return text;
    return [...text].map((char) => map.get(char.charCodeAt(0).toString(16).padStart(2, '0')) ?? char).join('');
  };
  const lines: string[] = [];
  for (const [index, content] of decoded.entries()) {
    // Page content only: fonts, images, metadata and object streams have their own dictionaries.
    if (/\/(Length[123]|Subtype|Type\s*\/(XObject|Metadata|ObjStm|XRef|EmbeddedFile))\b/.test(all[index]!.dictionary)) continue;
    if (!/\bBT\b/.test(content) || !/\bET\b/.test(content) || content.includes('begincmap')) continue;
    let line = '';
    let lastY: string | null = null;
    let pendingSpace = false;
    const breakLine = (): void => {
      if (line.trim()) lines.push(line);
      line = '';
      pendingSpace = false;
    };
    const add = (text: string): void => {
      if (!text) return;
      if (pendingSpace && !/^[\s.,;:!?)\]}%]/.test(text)) line += ' ';
      pendingSpace = false;
      line += text;
    };
    // Strings shown with Tj, ', " and the arrays of TJ (a large negative kern is a word gap). A move to
    // another baseline starts a new line; moves along it do not, since glyph runs are often placed one by one.
    const operators = /\[((?:\((?:\\.|[^\\)])*\)|<[0-9a-fA-F\s]*>|-?\d+(?:\.\d+)?|\s)*)\]\s*TJ|\(((?:\\.|[^\\)])*)\)\s*(?:Tj|'|")|<([0-9a-fA-F\s]+)>\s*Tj|(-?[\d.]+)\s+(-?[\d.]+)\s+T[dD]\b|(-?[\d.]+)\s+Tm\b|(T\*)|\b(BT)\b/g;
    for (const match of content.matchAll(operators)) {
      if (match[1] !== undefined) {
        for (const part of match[1].matchAll(/\(((?:\\.|[^\\)])*)\)|<([0-9a-fA-F\s]*)>|(-?\d+(?:\.\d+)?)/g)) {
          if (part[1] !== undefined) add(literal(part[1]));
          else if (part[2] !== undefined) add(hex(part[2]));
          else if (Number(part[3]) < -200) line += ' ';
        }
      } else if (match[2] !== undefined) add(literal(match[2]));
      else if (match[3] !== undefined) add(hex(match[3]));
      else if (match[5] !== undefined) {
        if (Number(match[5]) !== 0) breakLine();
      } else if (match[6] !== undefined) {
        // Text objects (BT…ET) often hold one word each; the same baseline means the same line.
        if (lastY !== null && Math.abs(Number(match[6]) - Number(lastY)) > 0.5) breakLine();
        lastY = match[6];
      } else if (match[8] !== undefined) {
        // A new text object on the same line is usually a new word or cell: a space, unless what follows is punctuation.
        pendingSpace = line !== '' && !/\s$/.test(line);
      } else breakLine();
    }
    breakLine();
  }
  // Text that is mostly control characters came from something that was not text.
  return lines.filter((line) => (line.match(/[\u0000-\u001f\u007f-\u009f\ufffd]/g)?.length ?? 0) < line.length / 4).join('\n');
}

// ── Indexing ────────────────────────────────────────────────────────────────

export async function indexFileText(ctx: Ctx, row: FileRow): Promise<void> {
  const extractor = extractorFor(row.name, row.mimetype);
  let text = '';
  if (extractor && row.size <= MAX_BYTES) {
    try {
      const chunks: Buffer[] = [];
      for await (const chunk of ctx.storage.read(row.storage_key)) chunks.push(chunk as Buffer);
      // NFKC folds ligatures (ﬁ → fi) and full-width forms, so they match what people type.
      text = extractor(Buffer.concat(chunks))
        .normalize('NFKC')
        .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f]/g, ' ')
        .replace(/[ \t]+/g, ' ')
        .replace(/\n{3,}/g, '\n\n')
        .trim()
        .slice(0, MAX_CHARS);
    } catch (error) {
      if (!ctx.config.quiet) console.warn(`[file-text] ${row.id}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  if (!ctx.db.get('SELECT 1 FROM files WHERE id = ?', row.id)) return;
  ctx.db.run('DELETE FROM file_text WHERE file_id = ?', row.id);
  // An empty row marks the file as looked at, so the backfill does not try it again.
  ctx.db.run('INSERT INTO file_text (file_id, body) VALUES (?, ?)', row.id, text);
}

/** Files uploaded before text indexing existed, a few at a time. */
export async function backfillFileText(ctx: Ctx, limit = 25): Promise<number> {
  const rows = ctx.db.all<FileRow>(
    "SELECT * FROM files WHERE state != 'pending' AND id NOT IN (SELECT file_id FROM file_text) ORDER BY created DESC LIMIT ?",
    limit,
  );
  for (const row of rows) await indexFileText(ctx, row);
  return rows.length;
}

/** Keep the index filled: files from before this existed, and any whose indexing was interrupted. */
export function installFileText(kernel: { ctx: Ctx; onClose: (() => void | Promise<void>)[] }): void {
  const { ctx } = kernel;
  let busy = false;
  const timer = setInterval(() => {
    if (busy || !ctx.team() || !ctx.instances.isLeader()) return;
    busy = true;
    void backfillFileText(ctx)
      .catch(() => 0)
      .finally(() => {
        busy = false;
      });
  }, 60_000);
  timer.unref();
  kernel.onClose.push(() => clearInterval(timer));
}
