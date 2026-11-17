import type { Attachment, Block, Message } from '@app/shared';
import { Check, X } from 'lucide-react';
import { Component, lazy, Suspense, useMemo, type ReactNode } from 'react';
import { clickBlockAction } from '../lib/actions';
import { asset, call } from '../lib/api';
import { removePreview } from '../lib/attention';
import { useAccounts } from '../lib/accounts';
import { useStore } from '../lib/store';
import { StateBag, SurfaceContext, useSurface, type Surface } from '../lib/surface';
import { S } from '../strings';
import { InputBlock, InteractiveElement } from './blockElements';
import { CallCard } from './CallCard';
import { Files } from './files';
import { Broadcast, ChannelLink, DateToken, Emoji, Link, Mrkdwn, PlainText, UserMention } from './text';

const MarkdownText = lazy(() => import('./Markdown'));

// Block Kit arrives as loosely typed JSON; each renderer checks what it reads.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Any = any;

// ── Text objects ────────────────────────────────────────────────────────────

function TextObject({ value, inline = true }: { value: Any; inline?: boolean }) {
  if (!value) return null;
  if (typeof value === 'string') return <Mrkdwn text={value} inline={inline} />;
  if (value.type === 'mrkdwn') return <Mrkdwn text={String(value.text ?? '')} inline={inline} />;
  return <PlainText text={String(value.text ?? '')} emoji={value.emoji !== false} />;
}

function plain(value: Any): string {
  return typeof value === 'string' ? value : String(value?.text ?? '');
}

// ── rich_text ───────────────────────────────────────────────────────────────

function styled(node: ReactNode, style: Any): ReactNode {
  let out = node;
  if (style?.code) out = <code className="code-inline">{out}</code>;
  if (style?.bold) out = <strong>{out}</strong>;
  if (style?.italic) out = <em>{out}</em>;
  if (style?.strike) out = <s>{out}</s>;
  return out;
}

function unicodeEmoji(codes: string): string | null {
  try {
    return String.fromCodePoint(...codes.split('-').map((code) => parseInt(code, 16)));
  } catch {
    return null;
  }
}

function GroupMention({ id }: { id: string }) {
  const handle = useAccounts((state) => state.usergroups[id]?.handle);
  return <span className="mention">@{handle ?? id}</span>;
}

function RichInline({ element }: { element: Any }) {
  switch (element?.type) {
    case 'text': {
      const lines = String(element.text ?? '').split('\n');
      return (
        <>
          {styled(
            lines.map((line, index) => (
              <span key={index}>
                {index > 0 ? <br /> : null}
                {line}
              </span>
            )),
            element.style,
          )}
        </>
      );
    }
    case 'link':
      return <>{styled(<Link url={String(element.url)}>{element.text || element.url}</Link>, element.style)}</>;
    case 'user':
      return <>{styled(<UserMention id={String(element.user_id)} />, element.style)}</>;
    case 'channel':
      return <>{styled(<ChannelLink id={String(element.channel_id)} />, element.style)}</>;
    case 'usergroup':
      return <>{styled(<GroupMention id={String(element.usergroup_id)} />, element.style)}</>;
    case 'broadcast':
      return <>{styled(<Broadcast range={String(element.range)} />, element.style)}</>;
    case 'emoji': {
      const native = element.unicode ? unicodeEmoji(String(element.unicode)) : null;
      const name = element.skin_tone > 1 ? `${element.name}::skin-tone-${element.skin_tone}` : String(element.name);
      if (native) {
        return (
          <>
            {styled(
              <span className="emoji" role="img" aria-label={String(element.name).replace(/_/g, ' ')} title={`:${name}:`}>
                {native}
              </span>,
              element.style,
            )}
          </>
        );
      }
      return <>{styled(<Emoji name={name} />, element.style)}</>;
    }
    case 'date':
      return <DateToken timestamp={Number(element.timestamp)} fallback={String(element.fallback ?? '')} />;
    case 'color':
      return (
        <span className="color-chip">
          <span style={{ background: String(element.value) }} />
          {String(element.value)}
        </span>
      );
    default:
      return null;
  }
}

function RichInlines({ elements }: { elements: Any }) {
  if (!Array.isArray(elements)) return null;
  return (
    <>
      {elements.map((element, index) => (
        <RichInline key={index} element={element} />
      ))}
    </>
  );
}

function RichElement({ element }: { element: Any }) {
  switch (element?.type) {
    case 'rich_text_section':
      return (
        <div className="rich-section">
          <RichInlines elements={element.elements} />
        </div>
      );
    case 'rich_text_list': {
      const List = element.style === 'ordered' ? 'ol' : 'ul';
      const indent = Number(element.indent ?? 0);
      return (
        <List className={`rich-list is-level-${indent % 3}`} style={{ marginLeft: indent * 22 }} start={Number(element.offset ?? 0) + 1}>
          {(element.elements ?? []).map((item: Any, itemIndex: number) => (
            <li key={itemIndex}>
              <RichInlines elements={item.elements} />
            </li>
          ))}
        </List>
      );
    }
    case 'rich_text_preformatted':
      return (
        <pre className="code-block">
          <code>
            <RichInlines elements={element.elements} />
          </code>
        </pre>
      );
    case 'rich_text_quote':
      return (
        <blockquote className="quote">
          <RichInlines elements={element.elements} />
        </blockquote>
      );
    default:
      return null;
  }
}

function RichText({ block }: { block: Any }) {
  const elements: Any[] = Array.isArray(block.elements) ? block.elements : [];
  return (
    <div className="rich-text">
      {elements.map((element, index) => (
        <RichElement key={index} element={element} />
      ))}
    </div>
  );
}

/** Up to three emoji and nothing else, as in mrkdwn: shown large. */
function emojiOnly(elements: Any[]): boolean {
  if (elements.length !== 1 || elements[0]?.type !== 'rich_text_section') return false;
  let count = 0;
  for (const item of elements[0].elements ?? []) {
    if (item?.type === 'emoji') count += 1;
    else if (item?.type === 'text' && String(item.text ?? '').trim() === '') continue;
    else return false;
  }
  return count > 0 && count <= 3;
}

/**
 * A person's message written in the composer: its `rich_text` blocks drawn as
 * one body, so it reads like mrkdwn text (the edited mark follows the last line).
 */
export function RichTextBody({ blocks }: { blocks: Block[] }) {
  const elements = blocks.flatMap((block) => (Array.isArray(block.elements) ? (block.elements as Any[]) : []));
  return (
    <div className={`rich-text rich-body ${emojiOnly(elements) ? 'is-jumbo' : ''}`}>
      {elements.map((element, index) => (
        <RichElement key={index} element={element} />
      ))}
    </div>
  );
}

// ── Interactive elements ────────────────────────────────────────────────────

function Element({ element, blockId, block }: { element: Any; blockId: string; block: Any }) {
  if (element?.type === 'image') {
    return <img className="block-accessory-image" src={asset(String(element.image_url ?? ''))} alt={String(element.alt_text ?? '')} loading="lazy" />;
  }
  return <>{InteractiveElement({ element, blockId, block })}</>;
}

// ── Blocks ──────────────────────────────────────────────────────────────────

function TableBlock({ block }: { block: Any }) {
  const rows: Any[][] = Array.isArray(block.rows) ? block.rows : [];
  if (rows.length === 0) return null;
  const cell = (value: Any): ReactNode =>
    value?.type === 'rich_text' ? <RichText block={value} /> : <PlainText text={String(value?.text ?? '')} />;
  const align = (index: number): 'left' | 'center' | 'right' => block.column_settings?.[index]?.align ?? 'left';
  const [head, ...body] = rows;
  return (
    <div className="md-table">
      <table>
        <thead>
          <tr>
            {(head ?? []).map((value, index) => (
              <th key={index} style={{ textAlign: align(index) }}>
                {cell(value)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {body.map((row, rowIndex) => (
            <tr key={rowIndex}>
              {row.map((value, index) => (
                <td key={index} style={{ textAlign: align(index) }}>
                  {cell(value)}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Agent progress: plans and task cards ───────────────────────────────────

function TaskDetail({ value }: { value: Any }) {
  if (!value) return null;
  if (typeof value === 'string') return <Mrkdwn text={value} />;
  if (value.type === 'rich_text') return <RichText block={value} />;
  if (typeof value.text === 'string') return <TextObject value={value} inline={false} />;
  return null;
}

function TaskItem({ task }: { task: Any }) {
  const status = String(task?.status ?? 'pending');
  const state = status === 'complete' || status === 'completed' ? 'done' : status === 'in_progress' ? 'active' : status === 'error' ? 'error' : 'todo';
  const sources: Any[] = Array.isArray(task?.sources) ? task.sources : [];
  return (
    <li className={`task is-${state}`}>
      <span className="task-mark" aria-hidden="true">
        {state === 'done' ? <Check size={13} /> : state === 'error' ? <X size={13} /> : state === 'active' ? <span className="spinner" /> : null}
      </span>
      <div className="task-main">
        <div className="task-title">
          <PlainText text={plain(task?.title)} />
        </div>
        <TaskDetail value={task?.details} />
        <TaskDetail value={task?.output} />
        {sources.length > 0 ? (
          <div className="task-sources">
            {sources.map((source, index) =>
              source?.url ? (
                <Link key={index} url={String(source.url)}>
                  {String(source.text ?? source.url)}
                </Link>
              ) : null,
            )}
          </div>
        ) : null}
      </div>
    </li>
  );
}

function PlanBlock({ title, tasks }: { title?: Any; tasks: Any[] }) {
  return (
    <div className="plan">
      {title ? (
        <div className="plan-title">
          <PlainText text={plain(title)} />
        </div>
      ) : null}
      <ul>
        {tasks.map((task, index) => (
          <TaskItem key={String(task?.task_id ?? index)} task={task} />
        ))}
      </ul>
    </div>
  );
}

/** Render one block, or null when its type is not supported. */
function renderBlock(block: Block, index: number): ReactNode {
  const value = block as Any;
  const blockId = String(value.block_id ?? `b${index}`);
  switch (block.type) {
    case 'rich_text':
      return <RichText block={value} />;
    case 'section':
      return (
        <div className="block-section">
          <div className="block-section-main">
            {value.text ? (
              <div className="block-text">
                <TextObject value={value.text} inline={false} />
              </div>
            ) : null}
            {Array.isArray(value.fields) && value.fields.length > 0 ? (
              <div className="block-fields">
                {value.fields.map((field: Any, fieldIndex: number) => (
                  <div key={fieldIndex} className="block-field">
                    <TextObject value={field} inline={false} />
                  </div>
                ))}
              </div>
            ) : null}
          </div>
          {value.accessory ? (
            <div className="block-accessory">
              <Element element={value.accessory} blockId={blockId} block={value} />
            </div>
          ) : null}
        </div>
      );
    case 'divider':
      return <hr className="block-divider" />;
    case 'call':
      return value.call_id ? <CallCard callId={String(value.call_id)} /> : null;
    case 'header':
      return (
        <h3 className="block-header">
          <PlainText text={plain(value.text)} />
        </h3>
      );
    case 'context':
      return (
        <div className="block-context">
          {(Array.isArray(value.elements) ? value.elements : []).map((element: Any, elementIndex: number) =>
            element?.type === 'image' ? (
              <img key={elementIndex} src={asset(String(element.image_url ?? ''))} alt={String(element.alt_text ?? '')} loading="lazy" />
            ) : (
              <span key={elementIndex}>
                <TextObject value={element} />
              </span>
            ),
          )}
        </div>
      );
    case 'image': {
      const url = asset(String(value.image_url ?? value.slack_file?.url ?? ''));
      if (!url) return null;
      return (
        <figure className="block-image">
          {value.title ? (
            <figcaption>
              <PlainText text={plain(value.title)} />
            </figcaption>
          ) : null}
          <a href={url} target="_blank" rel="noopener noreferrer">
            <img src={url} alt={String(value.alt_text ?? '')} loading="lazy" />
          </a>
        </figure>
      );
    }
    case 'actions':
      return (
        <div className="block-actions">
          {(Array.isArray(value.elements) ? value.elements : []).map((element: Any, elementIndex: number) => (
            <Element key={elementIndex} element={element} blockId={blockId} block={value} />
          ))}
        </div>
      );
    case 'input':
      return <InputBlock block={value} blockId={blockId} />;
    case 'markdown':
      return (
        <Suspense fallback={<div className="md md-plain">{String(value.text ?? '')}</div>}>
          <MarkdownText text={String(value.text ?? '')} />
        </Suspense>
      );
    case 'table':
      return <TableBlock block={value} />;
    case 'plan':
      return <PlanBlock title={value.title} tasks={Array.isArray(value.tasks) ? value.tasks : []} />;
    case 'task_card':
      return <PlanBlock tasks={[value]} />;
    case 'video':
      return (
        <div className="block-video">
          <Link url={String(value.title_url ?? value.video_url ?? '#')}>
            {value.thumbnail_url ? <img src={String(value.thumbnail_url)} alt={String(value.alt_text ?? '')} loading="lazy" /> : null}
            <span>
              <PlainText text={plain(value.title)} />
            </span>
          </Link>
          {value.description ? (
            <p>
              <PlainText text={plain(value.description)} />
            </p>
          ) : null}
        </div>
      );
    default:
      return null;
  }
}

class Boundary extends Component<{ fallback: ReactNode; children: ReactNode }, { failed: boolean }> {
  override state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  override render(): ReactNode {
    return this.state.failed ? this.props.fallback : this.props.children;
  }
}

interface BlocksProps {
  blocks: Block[];
  /** Shown when no block could be rendered. */
  fallbackText: string;
  /** Where the blocks are drawn. Without one, they belong to `message` in `channel`. */
  surface?: Surface;
  channel?: string;
  message?: Message;
}

/** The surface of blocks on a message: actions and menus go to the app that posted it. */
function useMessageSurface(channel: string | undefined, message: Message | undefined): Surface | null {
  const ts = message?.ts;
  return useMemo(() => {
    if (!channel || !message) return null;
    const state = new StateBag();
    return {
      kind: 'message',
      state,
      errors: {},
      act: (action) => clickBlockAction(channel, message, action, state.toState()),
      suggest: (actionId, blockId, value) =>
        call('client.interactions.suggest', { channel, message_ts: message.ts, action_id: actionId, block_id: blockId, value }).catch(() => ({ options: [] })),
    } satisfies Surface;
    // A message's surface lives as long as the message keeps its timestamp.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [channel, ts]);
}

export function Blocks({ blocks, fallbackText, surface, channel, message }: BlocksProps) {
  const inherited = useSurface();
  const own = useMessageSurface(surface || inherited ? undefined : channel, message);
  const active = surface ?? inherited ?? own;
  const fallback = fallbackText ? <Mrkdwn text={fallbackText} /> : <div className="block-unsupported">{S.blocks.unsupported}</div>;
  const rendered = blocks.map((block, index) => ({ block, node: safeRender(block, index) })).filter((item) => item.node !== null);
  if (rendered.length === 0) return fallback;
  return (
    <Boundary fallback={fallback}>
      <SurfaceContext.Provider value={active}>
        <div className="blocks">
          {rendered.map((item, index) => (
            <div key={item.block.block_id ?? index} className="block" data-block={item.block.type}>
              {item.node}
            </div>
          ))}
        </div>
      </SurfaceContext.Provider>
    </Boundary>
  );
}

function safeRender(block: Block, index: number): ReactNode {
  try {
    if (!block || typeof block !== 'object') return null;
    return renderBlock(block, index);
  } catch {
    return null;
  }
}

// ── Legacy attachments ──────────────────────────────────────────────────────

const NAMED_COLORS: Record<string, string> = { good: '#2eb67d', warning: '#ecb22e', danger: '#e01e5a' };

/** A permalink this server made, rebased onto the address the page was loaded from. */
function ownLink(url: string): string {
  try {
    const parsed = new URL(url);
    return `${window.location.origin}${parsed.pathname}${parsed.search}`;
  } catch {
    return url;
  }
}

function barColor(value: unknown): string | undefined {
  if (typeof value !== 'string' || !value) return undefined;
  if (NAMED_COLORS[value]) return NAMED_COLORS[value];
  const hex = value.replace(/^#/, '');
  return /^[0-9a-f]{3,8}$/i.test(hex) ? `#${hex}` : undefined;
}

export function Attachments({ attachments, channel, message }: { attachments: Attachment[]; channel: string; message: Message }) {
  const canRemovePreview = useStore((state) => state.self?.id === message.user || Boolean(state.self?.is_admin));
  return (
    <div className="attachments">
      {attachments.map((raw, index) => {
        const attachment = raw as Any;
        const fields: Any[] = Array.isArray(attachment.fields) ? attachment.fields : [];
        const hasBody =
          attachment.author_name || attachment.title || attachment.text || fields.length > 0 || attachment.image_url || attachment.footer || attachment.blocks;
        // A link preview the server made (not a forwarded message, not an app's own attachment).
        const preview = typeof attachment.original_url === 'string' && !attachment.is_share && !attachment.is_app_unfurl;
        const shared = attachment.is_share === true;
        return (
          <div key={index} className={`attachment-wrap ${preview ? 'is-preview' : ''} ${shared ? 'is-share' : ''}`}>
            {attachment.pretext ? <Mrkdwn text={String(attachment.pretext)} /> : null}
            {hasBody ? (
              <div className="attachment" style={{ ['--bar' as string]: barColor(attachment.color) ?? 'var(--line-strong)' }}>
                {preview && canRemovePreview ? (
                  <button
                    type="button"
                    className="attachment-remove"
                    aria-label={S.att.preview.remove}
                    title={S.att.preview.remove}
                    onClick={() => void removePreview(channel, message.ts, String(attachment.original_url))}
                  >
                    <X size={14} />
                  </button>
                ) : null}
                <div className="attachment-main">
                  {preview && attachment.service_name ? <div className="attachment-service">{String(attachment.service_name)}</div> : null}
                  {attachment.author_name ? (
                    <div className="attachment-author">
                      {attachment.author_icon ? <img src={asset(String(attachment.author_icon))} alt="" loading="lazy" /> : null}
                      {attachment.author_link ? <Link url={String(attachment.author_link)}>{String(attachment.author_name)}</Link> : String(attachment.author_name)}
                    </div>
                  ) : null}
                  {attachment.title ? (
                    <div className="attachment-title">
                      {attachment.title_link ? (
                        <Link url={String(attachment.title_link)}>
                          <Mrkdwn text={String(attachment.title)} inline />
                        </Link>
                      ) : (
                        <Mrkdwn text={String(attachment.title)} inline />
                      )}
                    </div>
                  ) : null}
                  {shared && Array.isArray(attachment.message_blocks) && attachment.message_blocks[0]?.message?.blocks ? (
                    <Blocks blocks={attachment.message_blocks[0].message.blocks as Block[]} fallbackText={String(attachment.text ?? '')} channel={channel} message={message} />
                  ) : attachment.text ? (
                    <Mrkdwn text={String(attachment.text)} />
                  ) : null}
                  {shared && Array.isArray(attachment.files) && attachment.files.length > 0 ? <Files files={attachment.files} /> : null}
                  {Array.isArray(attachment.blocks) ? (
                    <Blocks blocks={attachment.blocks as Block[]} fallbackText={String(attachment.fallback ?? '')} channel={channel} message={message} />
                  ) : null}
                  {fields.length > 0 ? (
                    <div className="attachment-fields">
                      {fields.map((field, fieldIndex) => (
                        <div key={fieldIndex} className={field.short ? 'is-short' : ''}>
                          {field.title ? <div className="attachment-field-title">{String(field.title)}</div> : null}
                          <Mrkdwn text={String(field.value ?? '')} />
                        </div>
                      ))}
                    </div>
                  ) : null}
                  {attachment.image_url ? (
                    <a href={String(attachment.title_link ?? attachment.image_url)} target="_blank" rel="noopener noreferrer">
                      <img
                        className="attachment-image"
                        src={asset(String(attachment.image_url))}
                        alt=""
                        loading="lazy"
                        width={typeof attachment.image_width === 'number' ? attachment.image_width : undefined}
                        height={typeof attachment.image_height === 'number' ? attachment.image_height : undefined}
                      />
                    </a>
                  ) : null}
                  {attachment.footer ? (
                    <div className="attachment-footer">
                      {attachment.footer_icon ? <img src={asset(String(attachment.footer_icon))} alt="" loading="lazy" /> : null}
                      {shared && attachment.from_url ? (
                        <span className="attachment-origin">
                          <Link url={ownLink(String(attachment.from_url))}>
                            <Mrkdwn text={String(attachment.footer)} inline />
                          </Link>
                        </span>
                      ) : (
                        <Mrkdwn text={String(attachment.footer)} inline />
                      )}
                      {attachment.ts ? <DateToken timestamp={Number(attachment.ts)} fallback="" /> : null}
                    </div>
                  ) : null}
                </div>
                {attachment.thumb_url ? <img className="attachment-thumb" src={asset(String(attachment.thumb_url))} alt="" loading="lazy" /> : null}
              </div>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}
