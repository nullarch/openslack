import hljs from 'highlight.js/lib/core';
import bash from 'highlight.js/lib/languages/bash';
import cpp from 'highlight.js/lib/languages/cpp';
import csharp from 'highlight.js/lib/languages/csharp';
import css from 'highlight.js/lib/languages/css';
import diff from 'highlight.js/lib/languages/diff';
import go from 'highlight.js/lib/languages/go';
import java from 'highlight.js/lib/languages/java';
import javascript from 'highlight.js/lib/languages/javascript';
import json from 'highlight.js/lib/languages/json';
import kotlin from 'highlight.js/lib/languages/kotlin';
import markdown from 'highlight.js/lib/languages/markdown';
import php from 'highlight.js/lib/languages/php';
import python from 'highlight.js/lib/languages/python';
import ruby from 'highlight.js/lib/languages/ruby';
import rust from 'highlight.js/lib/languages/rust';
import sql from 'highlight.js/lib/languages/sql';
import swift from 'highlight.js/lib/languages/swift';
import typescript from 'highlight.js/lib/languages/typescript';
import xml from 'highlight.js/lib/languages/xml';
import yaml from 'highlight.js/lib/languages/yaml';
import { useMemo } from 'react';

const LANGUAGES = { bash, cpp, csharp, css, diff, go, java, javascript, json, kotlin, markdown, php, python, ruby, rust, sql, swift, typescript, xml, yaml };
for (const [name, language] of Object.entries(LANGUAGES)) hljs.registerLanguage(name, language);

/** Names a snippet may carry, mapped to a registered language. */
const ALIASES: Record<string, string> = { shell: 'bash', sh: 'bash', js: 'javascript', ts: 'typescript', py: 'python', html: 'xml', yml: 'yaml', md: 'markdown', 'c++': 'cpp', 'c#': 'csharp', rb: 'ruby' };

export const SNIPPET_LANGUAGES = ['text', ...Object.keys(LANGUAGES)];

/** Code with syntax highlighting. highlight.js escapes the input; its output is safe to insert. */
export default function HighlightedCode({ code, language }: { code: string; language?: string }) {
  const html = useMemo(() => {
    const name = ALIASES[language ?? ''] ?? language ?? '';
    if (name && hljs.getLanguage(name)) return hljs.highlight(code, { language: name, ignoreIllegals: true }).value;
    return null;
  }, [code, language]);
  return (
    <pre className="code-block file-preview hljs" data-lang={language}>
      {html === null ? <code>{code}</code> : <code dangerouslySetInnerHTML={{ __html: html }} />}
    </pre>
  );
}
