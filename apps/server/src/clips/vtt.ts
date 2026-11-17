const MAX_TRANSCRIPT_CHARS = 100_000;

/** The words of a WebVTT file: no header, cue ids, timings or tags. */
export function vttText(vtt: string): string {
  const lines: string[] = [];
  for (const block of vtt.replace(/\r\n?/g, '\n').split(/\n{2,}/)) {
    const rows = block.split('\n');
    const timing = rows.findIndex((row) => row.includes('-->'));
    if (timing < 0) continue;
    const text = rows
      .slice(timing + 1)
      .join(' ')
      .replace(/<[^>]*>/g, '')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&amp;/g, '&')
      .trim();
    if (text) lines.push(text);
  }
  return lines.join('\n').slice(0, MAX_TRANSCRIPT_CHARS);
}

