/**
 * Pure helpers for a code channel's view tabs: reading a unified diff into
 * files and lines, and wrapping an agent's HTML so the frame that shows it
 * loads only what the agent declared.
 */

export interface DiffLine {
  kind: 'add' | 'del' | 'context' | 'hunk' | 'note';
  text: string;
  /** Line number in the old file (context and removed lines). */
  old?: number;
  /** Line number in the new file (context and added lines). */
  new?: number;
}

export interface DiffFile {
  name: string;
  /** Set when the file was renamed. */
  from?: string;
  binary: boolean;
  added: number;
  removed: number;
  lines: DiffLine[];
}

const HUNK = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;

function stripPrefix(path: string): string {
  const clean = path.replace(/\t.*$/, '').trim();
  return clean.replace(/^[ab]\//, '');
}

/** Files of a unified diff (`git diff` output, or plain `---`/`+++` patches). Commit headers are skipped. */
export function parseUnifiedDiff(text: string): DiffFile[] {
  const files: DiffFile[] = [];
  let file: DiffFile | null = null;
  let oldLine = 0;
  let newLine = 0;
  /** Lines of the current hunk still to come, from its header; none left ends it. */
  let oldLeft = 0;
  let newLeft = 0;
  let inHunk = false;
  const start = (name: string): DiffFile => {
    const next: DiffFile = { name, binary: false, added: 0, removed: 0, lines: [] };
    files.push(next);
    inHunk = false;
    return next;
  };
  // The text's last newline ends the last line; it does not start an empty one.
  for (const line of text.replace(/\r\n?/g, '\n').replace(/\n$/, '').split('\n')) {
    const git = /^diff --git a\/(.+?) b\/(.+)$/.exec(line);
    if (git) {
      file = start(git[2]!);
      if (git[1] !== git[2]) file.from = git[1]!;
      continue;
    }
    if (!inHunk && line.startsWith('--- ')) {
      const name = stripPrefix(line.slice(4));
      if (!file || file.lines.length) file = start(name === '/dev/null' ? '' : name);
      continue;
    }
    if (!inHunk && line.startsWith('+++ ')) {
      const name = stripPrefix(line.slice(4));
      if (file && name !== '/dev/null') file.name = name;
      continue;
    }
    if (!file) continue;
    if (!inHunk && /^rename from /.test(line)) {
      file.from = line.slice('rename from '.length);
      continue;
    }
    if (!inHunk && /^rename to /.test(line)) {
      file.name = line.slice('rename to '.length);
      continue;
    }
    if (/^Binary files /.test(line) || line === 'GIT binary patch') {
      file.binary = true;
      continue;
    }
    const hunk = HUNK.exec(line);
    if (hunk) {
      inHunk = true;
      oldLine = Number(hunk[1]);
      oldLeft = hunk[2] === undefined ? 1 : Number(hunk[2]);
      newLine = Number(hunk[3]);
      newLeft = hunk[4] === undefined ? 1 : Number(hunk[4]);
      file.lines.push({ kind: 'hunk', text: line });
      continue;
    }
    // "\ No newline at end of file" follows the line it is about, even the hunk's last.
    if (line.startsWith('\\') && file.lines.length) {
      file.lines.push({ kind: 'note', text: line });
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && newLeft > 0) {
      file.lines.push({ kind: 'add', text: line, new: newLine });
      newLine += 1;
      newLeft -= 1;
      file.added += 1;
    } else if (line.startsWith('-') && oldLeft > 0) {
      file.lines.push({ kind: 'del', text: line, old: oldLine });
      oldLine += 1;
      oldLeft -= 1;
      file.removed += 1;
    } else if ((line.startsWith(' ') || line === '') && oldLeft > 0 && newLeft > 0) {
      // Some tools drop the space of an empty context line.
      file.lines.push({ kind: 'context', text: line || ' ', old: oldLine, new: newLine });
      oldLine += 1;
      newLine += 1;
      oldLeft -= 1;
      newLeft -= 1;
    } else {
      inHunk = false;
    }
    if (oldLeft <= 0 && newLeft <= 0) inHunk = false;
  }
  return files.filter((entry) => entry.name || entry.from);
}

/**
 * The policy an agent's HTML runs under: nothing from anywhere, except inline
 * scripts and styles of the document itself and resources from the origins
 * the agent declared (`csp.resource_domains`). It cannot connect anywhere,
 * frame anything or submit forms.
 */
export function viewPolicy(resourceDomains: string[]): string {
  const origins = resourceDomains.filter((origin) => /^https:\/\/[a-z0-9.*:[\]-]+$/i.test(origin)).join(' ');
  const plus = origins ? ` ${origins}` : '';
  return [
    "default-src 'none'",
    `script-src 'unsafe-inline'${plus}`,
    `style-src 'unsafe-inline'${plus}`,
    `img-src data: blob:${plus}`,
    `font-src data:${plus}`,
    `media-src data: blob:${plus}`,
    "connect-src 'none'",
    "frame-src 'none'",
    "form-action 'none'",
    "base-uri 'none'",
  ].join('; ');
}

const attribute = (value: string): string => value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;');

/**
 * The frame's document: the policy comes first, before anything the agent
 * wrote, so no script of the agent's runs before it applies. The agent's own
 * doctype and head that follow are folded in by the parser.
 */
export function viewDocument(content: string, resourceDomains: string[]): string {
  return `<!doctype html><meta http-equiv="Content-Security-Policy" content="${attribute(viewPolicy(resourceDomains))}"><meta name="referrer" content="no-referrer">${content}`;
}
