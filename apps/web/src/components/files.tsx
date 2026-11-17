import type { FileObject } from '@app/shared';
import { Download, ExternalLink, FileText, File as FileIcon, FileCode, FileArchive, FileSpreadsheet, Globe, Link2 } from 'lucide-react';
import { lazy, Suspense, useEffect, useState } from 'react';
import { openModal, toast } from '../lib/actions';
import { useAccounts } from '../lib/accounts';
import { asset, call } from '../lib/api';
import { useStore } from '../lib/store';
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
      <PublicLink file={file} />
      <a className="icon-btn" href={asset(file.url_private)} target="_blank" rel="noopener noreferrer" title={S.files.open} aria-label={S.files.open}>
        <ExternalLink size={16} />
      </a>
      <a className="icon-btn" href={asset(file.url_private_download)} title={S.files.download} aria-label={S.files.download}>
        <Download size={16} />
      </a>
    </div>
  );
}

/**
 * The uploader can hand out a link that works without signing in, and turn it
 * off again. The link is copied as soon as it exists.
 */
function PublicLink({ file }: { file: FileObject }) {
  const selfId = useStore((state) => state.self?.id);
  const [link, setLink] = useState<string | null>(file.permalink_public ?? null);
  const [busy, setBusy] = useState(false);
  const allowed = useAccounts((state) => state.permissions.public_file_links);
  // When the workspace turns links off, an existing one can still be turned off here.
  if (file.user !== selfId || (!allowed && !link)) return null;
  const copy = async (url: string): Promise<void> => {
    await navigator.clipboard?.writeText(url).catch(() => undefined);
    toast(S.files.copied);
  };
  const run = async (method: string): Promise<void> => {
    setBusy(true);
    try {
      const result = await call(method, { file: file.id });
      const next = (result.file?.permalink_public as string | undefined) ?? null;
      setLink(next);
      if (next) await copy(next);
      else toast(S.files.revoked);
    } catch (error) {
      toast(error instanceof Error ? error.message : String(error), 'error');
    } finally {
      setBusy(false);
    }
  };
  if (!link) {
    return (
      <button type="button" className="icon-btn" disabled={busy} title={S.files.makePublic} aria-label={S.files.makePublic} onClick={() => void run('files.sharedPublicURL')}>
        <Link2 size={16} />
      </button>
    );
  }
  return (
    <span className="public-link">
      <button type="button" className="icon-btn is-active" title={S.files.publicLink} aria-label={S.files.publicLink} onClick={() => void copy(link)}>
        <Globe size={16} />
      </button>
      <button type="button" className="link-btn" disabled={busy} onClick={() => void run('files.revokePublicURL')}>
        {S.files.revoke}
      </button>
    </span>
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
