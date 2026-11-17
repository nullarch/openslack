import type { FileObject } from '@app/shared';
import { Download, ExternalLink, FileText, File as FileIcon, FileCode, FileArchive, FileSpreadsheet } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { openModal } from '../lib/actions';
import { asset } from '../lib/api';
import { fileSize } from '../lib/time';
import { S } from '../strings';

const TEXT_TYPES = new Set([
  'text', 'markdown', 'csv', 'json', 'yaml', 'xml', 'html', 'css', 'javascript', 'typescript', 'python', 'go', 'rust', 'shell', 'sql', 'diff',
]);
const PREVIEW_BYTES = 20_000;

const HighlightedCode = lazy(() => import('./Highlight'));

function isText(file: FileObject): boolean {
  return TEXT_TYPES.has(file.filetype) || file.mimetype.startsWith('text/');
}

function Glyph({ file }: { file: FileObject }) {
  if (file.filetype === 'pdf' || file.filetype === 'text' || file.filetype === 'markdown') return <FileText size={20} />;
  if (/^(zip|gzip)$/.test(file.filetype)) return <FileArchive size={20} />;
  if (/^(csv|xls|xlsx)$/.test(file.filetype)) return <FileSpreadsheet size={20} />;
  if (isText(file)) return <FileCode size={20} />;
  return <FileIcon size={20} />;
}

function ImageFile({ file }: { file: FileObject }) {
  const width = file.thumb_360_w ?? 360;
  const height = file.thumb_360_h ?? 240;
  return (
    <button
      type="button"
      className="file-image"
      style={{ width: Math.max(48, width), aspectRatio: `${width} / ${height}` }}
      onClick={() => openModal({ kind: 'image', file })}
      title={file.title || file.name}
    >
      <img src={asset(file.thumb_720 ?? file.thumb_360 ?? file.url_private)} alt={file.alt_txt ?? file.title ?? file.name} loading="lazy" />
    </button>
  );
}

function TextPreview({ file }: { file: FileObject }) {
  const [open, setOpen] = useState(false);
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);

  const toggle = (): void => {
    const next = !open;
    setOpen(next);
    if (!next || text !== null) return;
    fetch(asset(file.url_private), { headers: { range: `bytes=0-${PREVIEW_BYTES - 1}` }, credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('failed'))))
      .then((body) => setText(body))
      .catch(() => setFailed(true));
  };

  return (
    <div className="file-card is-text">
      <FileCardHead file={file} extra={<button type="button" className="link-btn" onClick={toggle}>{open ? S.files.showLess : S.files.showMore}</button>} />
      {open ? (
        failed ? (
          <div className="file-preview-note">{S.files.previewFailed}</div>
        ) : (
          <pre className="code-block file-preview">
            <code>{text ?? S.loading}</code>
          </pre>
        )
      ) : null}
    </div>
  );
}

/** A PDF opens in the browser's own viewer, on request: loading every PDF in a channel up front would be wasteful. */
function PdfFile({ file }: { file: FileObject }) {
  const [open, setOpen] = useState(false);
  return (
    <div className={`file-card is-pdf ${open ? 'is-open' : ''}`}>
      <FileCardHead
        file={file}
        extra={
          <button type="button" className="link-btn" onClick={() => setOpen((value) => !value)}>
            {open ? S.files.hidePreview : S.files.preview}
          </button>
        }
      />
      {open ? <iframe className="file-pdf" src={asset(file.url_private)} title={file.title || file.name} /> : null}
    </div>
  );
}

function FileCardHead({ file, extra }: { file: FileObject; extra?: React.ReactNode }) {
  return (
    <div className="file-card-head">
      <span className="file-glyph">
        <Glyph file={file} />
      </span>
      <span className="file-meta">
        <span className="file-name">{file.title || file.name}</span>
        <span className="file-sub">
          {file.pretty_type} · {fileSize(file.size)}
        </span>
      </span>
      {extra}
      <a className="icon-btn" href={asset(file.url_private)} target="_blank" rel="noopener noreferrer" title={S.files.open} aria-label={S.files.open}>
        <ExternalLink size={16} />
      </a>
      <a className="icon-btn" href={asset(file.url_private_download)} title={S.files.download} aria-label={S.files.download}>
        <Download size={16} />
      </a>
    </div>
  );
}

/** A snippet: a text file shown open, with syntax highlighting once the highlighter has loaded. */
function SnippetFile({ file }: { file: FileObject }) {
  const [text, setText] = useState<string | null>(null);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    let live = true;
    fetch(asset(file.url_private), { headers: { range: `bytes=0-${PREVIEW_BYTES - 1}` }, credentials: 'same-origin' })
      .then((response) => (response.ok ? response.text() : Promise.reject(new Error('failed'))))
      .then((body) => live && setText(body))
      .catch(() => live && setFailed(true));
    return () => {
      live = false;
    };
  }, [file.url_private]);
  const lines = text ? text.replace(/\n$/, '').split('\n').length : 0;
  return (
    <div className="file-card is-text is-snippet">
      <FileCardHead file={file} extra={text ? <span className="file-sub snippet-lines">{S.att.snippet.lines(lines)}</span> : undefined} />
      {failed ? (
        <div className="file-preview-note">{S.files.previewFailed}</div>
      ) : (
        <Suspense fallback={<pre className="code-block file-preview"><code>{text ?? S.loading}</code></pre>}>
          {text !== null ? <HighlightedCode code={text} language={file.filetype} /> : <pre className="code-block file-preview"><code>{S.loading}</code></pre>}
        </Suspense>
      )}
    </div>
  );
}

export function Files({ files, collapsed = false }: { files: FileObject[]; collapsed?: boolean }) {
  if (collapsed) {
    return (
      <div className="files">
        {files.map((file) => (
          <div key={file.id} className="file-card">
            <FileCardHead file={file} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="files">
      {files.map((file) => {
        if (file.mode === 'snippet') return <SnippetFile key={file.id} file={file} />;
        if (/^image\/(png|jpeg|gif|webp)$/.test(file.mimetype)) return <ImageFile key={file.id} file={file} />;
        if (file.mimetype.startsWith('video/')) {
          return (
            <div key={file.id} className="file-media">
              <video controls preload="metadata" src={asset(file.url_private)} />
              <FileCardHead file={file} />
            </div>
          );
        }
        if (file.mimetype.startsWith('audio/')) {
          return (
            <div key={file.id} className="file-media is-audio">
              <FileCardHead file={file} />
              <audio controls preload="metadata" src={asset(file.url_private)} />
            </div>
          );
        }
        if (file.mimetype === 'application/pdf') return <PdfFile key={file.id} file={file} />;
        if (isText(file)) return <TextPreview key={file.id} file={file} />;
        return (
          <div key={file.id} className="file-card">
            <FileCardHead file={file} />
          </div>
        );
      })}
    </div>
  );
}

/** Full-size image viewer. */
export function ImageViewer({ file }: { file: FileObject }) {
  return (
    <div className="image-viewer">
      <img src={asset(file.url_private)} alt={file.alt_txt ?? file.title ?? file.name} />
      <div className="image-viewer-bar">
        <span>{file.title || file.name}</span>
        <a href={asset(file.url_private)} target="_blank" rel="noopener noreferrer">
          {S.files.openOriginal}
        </a>
        <a href={asset(file.url_private_download)}>{S.files.download}</a>
      </div>
    </div>
  );
}
