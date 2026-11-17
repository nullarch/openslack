import { FilePlus2, Trash2 } from 'lucide-react';
import { useEffect, useState } from 'react';
import { attempt } from '../../lib/actions';
import { call } from '../../lib/api';
import { createDoc, openDoc, useDocs, type DocKind, type DocSummary } from '../../lib/docs';
import { displayName, useStore } from '../../lib/store';
import { relative } from '../../lib/time';
import { S } from '../../strings';
import { Button, IconButton, Modal, Spinner } from '../ui';
import { EmptyNote, ViewFrame } from '../views/common';
import { KindIcon } from './index';
import '../../styles/docs.css';

interface Template {
  id: string;
  kind: DocKind;
  title: string;
  description: string;
  builtin: boolean;
  created_by: string | null;
  preview: string;
}

function useTemplates(kind?: DocKind): [Template[] | null, () => void] {
  const [templates, setTemplates] = useState<Template[] | null>(null);
  const load = (): void => {
    call('client.docs.templates.list', kind ? { kind } : {})
      .then((result) => setTemplates(result.templates as Template[]))
      .catch(() => setTemplates([]));
  };
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(load, [kind]);
  return [templates, load];
}

function TemplateGrid({ templates, kind, onPick, onDeleted }: { templates: Template[]; kind?: DocKind; onPick: (template: Template | { kind: DocKind; id: null }) => void; onDeleted: () => void }) {
  const users = useStore((state) => state.users);
  const self = useStore((state) => state.self);
  const blanks: DocKind[] = kind ? [kind] : ['canvas', 'list'];
  return (
    <div className="template-grid">
      {blanks.map((entry) => (
        <button key={`blank-${entry}`} type="button" className="template-card is-blank" data-template={`blank-${entry}`} onClick={() => onPick({ kind: entry, id: null })}>
          <span className={`doc-card-icon is-${entry}`}>
            <FilePlus2 size={18} />
          </span>
          <strong>{entry === 'canvas' ? S.docs.newCanvas : S.docs.newList}</strong>
          <span>{entry === 'canvas' ? S.docs.blankCanvas : S.docs.blankList}</span>
        </button>
      ))}
      {templates.map((template) => (
        <div key={template.id} className="template-card-wrap">
          <button type="button" className="template-card" data-template={template.id} onClick={() => onPick(template)}>
            <span className={`doc-card-icon is-${template.kind}`}>
              <KindIcon kind={template.kind} size={18} />
            </span>
            <strong>{template.title}</strong>
            <span>{template.description || template.preview.slice(0, 120)}</span>
            <span className="template-by">{template.builtin ? S.docs.builtIn : S.docs.savedBy(displayName(users[template.created_by ?? '']))}</span>
          </button>
          {!template.builtin && (template.created_by === self?.id || self?.is_admin || self?.is_owner) ? (
            <IconButton
              className="template-delete"
              label={S.docs.deleteTemplate}
              onClick={() => void attempt(() => call('client.docs.templates.delete', { template_id: template.id })).then(onDeleted)}
            >
              <Trash2 size={14} />
            </IconButton>
          ) : null}
        </div>
      ))}
    </div>
  );
}

/** Pick a template (or a blank page) for a new canvas or list in a conversation. */
export function TemplatePicker({ channel, kind, onClose }: { channel?: string; kind?: DocKind; onClose: () => void }) {
  const [templates, reload] = useTemplates(kind);
  return (
    <Modal title={S.docs.templates} onClose={onClose} width={760} className="template-dialog">
      {templates === null ? (
        <Spinner />
      ) : (
        <TemplateGrid
          templates={templates}
          kind={kind}
          onDeleted={reload}
          onPick={(template) => {
            onClose();
            void attempt(() => createDoc(template.kind, { channel, templateId: template.id ?? undefined }));
          }}
        />
      )}
    </Modal>
  );
}

/** Every canvas or list the viewer can open, newest first, and a way to start one. */
export default function DocsBrowser({ kind }: { kind: DocKind }) {
  const users = useStore((state) => state.users);
  const changes = useDocs((state) => Object.values(state.version).reduce((sum, value) => sum + value, 0));
  const [docs, setDocs] = useState<DocSummary[] | null>(null);
  const [picker, setPicker] = useState(false);
  useEffect(() => {
    let live = true;
    call('client.docs.list', { kind })
      .then((result) => live && setDocs(result.docs as DocSummary[]))
      .catch(() => live && setDocs([]));
    return () => {
      live = false;
    };
  }, [kind, changes]);
  return (
    <ViewFrame
      title={kind === 'canvas' ? S.docs.browseCanvases : S.docs.browseLists}
      className="docs-view"
      actions={
        <>
          <Button size="sm" onClick={() => setPicker(true)}>
            {S.docs.templates}
          </Button>
          <Button size="sm" variant="primary" onClick={() => void attempt(() => createDoc(kind))}>
            <FilePlus2 size={15} /> {kind === 'canvas' ? S.docs.newCanvas : S.docs.newList}
          </Button>
        </>
      }
    >
      {docs === null ? (
        <div className="list-loading">
          <Spinner />
        </div>
      ) : docs.length === 0 ? (
        <EmptyNote>{kind === 'canvas' ? S.docs.emptyCanvases : S.docs.emptyLists}</EmptyNote>
      ) : (
        <ul className="doc-list">
          {docs.map((doc) => (
            <li key={doc.id}>
              <a
                className="doc-row"
                href={doc.permalink}
                data-doc-row={doc.id}
                onClick={(event) => {
                  if (event.metaKey || event.ctrlKey) return;
                  event.preventDefault();
                  openDoc(doc.kind, doc.id);
                }}
              >
                <span className={`doc-card-icon is-${doc.kind}`}>
                  <KindIcon kind={doc.kind} size={18} />
                </span>
                <span className="doc-row-body">
                  <strong>{doc.title || S.docs.untitled}</strong>
                  <span>{doc.snippet || ' '}</span>
                </span>
                <span className="doc-row-meta">
                  {doc.access_level === 'read' ? <span className="tag">{S.docs.readOnly}</span> : null}
                  <span>{S.docs.updatedBy(displayName(users[doc.updated_by]), relative(String(doc.updated)))}</span>
                </span>
              </a>
            </li>
          ))}
        </ul>
      )}
      {picker ? <TemplatePicker kind={kind} onClose={() => setPicker(false)} /> : null}
    </ViewFrame>
  );
}
