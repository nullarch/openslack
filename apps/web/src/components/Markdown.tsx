import { Children, isValidElement, useMemo, type ReactElement, type ReactNode } from 'react';
import ReactMarkdown from 'react-markdown';
import remarkGfm from 'remark-gfm';
import { nativeEmoji } from '../lib/emoji';
import { Link } from './text';

/** Replace `:shortcode:` with emoji outside of code. */
function withEmoji(text: string): string {
  if (!text.includes(':')) return text;
  return text
    .split(/(```[\s\S]*?```|`[^`\n]*`)/g)
    .map((part, index) =>
      index % 2 === 1 ? part : part.replace(/:([a-z0-9_+'-]+):/gi, (match, name: string) => nativeEmoji(name.toLowerCase()) ?? match),
    )
    .join('');
}

function looksLikeDiff(code: string): boolean {
  const lines = code.split('\n');
  const marked = lines.filter((line) => /^[+-](?![+-])/.test(line)).length;
  return marked > 0 && lines.some((line) => line.startsWith('-')) && lines.some((line) => line.startsWith('+'));
}

export function CodeBlock({ code, lang }: { code: string; lang?: string }) {
  const diff = lang === 'diff' || lang === 'patch' || (!lang && looksLikeDiff(code));
  if (!diff) {
    return (
      <pre className="code-block" data-lang={lang}>
        <code>{code}</code>
      </pre>
    );
  }
  return (
    <pre className="code-block is-diff" data-lang="diff">
      <code>
        {code.split('\n').map((line, index) => {
          const kind = line.startsWith('+') ? 'add' : line.startsWith('-') ? 'del' : line.startsWith('@@') ? 'hunk' : '';
          return (
            <span key={index} className={`diff-line ${kind}`}>
              {line || ' '}
              {'\n'}
            </span>
          );
        })}
      </code>
    </pre>
  );
}

function Pre({ children }: { children?: ReactNode }) {
  const child = Children.toArray(children).find((item) => isValidElement(item)) as
    | ReactElement<{ className?: string; children?: ReactNode }>
    | undefined;
  if (!child) return <pre className="code-block">{children}</pre>;
  const lang = /language-(\S+)/.exec(child.props.className ?? '')?.[1];
  const code = Children.toArray(child.props.children).join('').replace(/\n$/, '');
  return <CodeBlock code={code} lang={lang} />;
}

/**
 * Standard Markdown, as agents write it. Raw HTML is never rendered, and
 * images become links so nothing is fetched from another site unasked.
 */
export default function MarkdownText({ text }: { text: string }) {
  const source = useMemo(() => withEmoji(text), [text]);
  return (
    <div className="md">
      <ReactMarkdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ href, children }) => <Link url={href ?? '#'}>{children}</Link>,
          img: ({ src, alt }) => <Link url={typeof src === 'string' ? src : '#'}>{alt || (typeof src === 'string' ? src : '')}</Link>,
          pre: Pre,
          code: ({ children }) => <code className="code-inline">{children}</code>,
          table: ({ children }) => (
            <div className="md-table">
              <table>{children}</table>
            </div>
          ),
        }}
      >
        {source}
      </ReactMarkdown>
    </div>
  );
}
