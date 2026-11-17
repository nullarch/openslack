import type { Message } from '@app/shared';
import { Bot, CalendarClock, Languages, Settings2, Sparkles, Undo2, WandSparkles } from 'lucide-react';
import { lazy, Suspense, useRef, useState } from 'react';
import { go, toast } from '../../lib/actions';
import {
  aiErrorText,
  askQuestion,
  hideTranslation,
  openAiModal,
  rewriteDraft,
  summarize,
  translateMessage,
  useAi,
  useAiFeature,
  useTranslation,
  type AiResult,
  type WriteMode,
} from '../../lib/ai';
import { conversation, conversationName, useStore } from '../../lib/store';
import { S } from '../../strings';
import { Button, IconButton, MenuDivider, MenuItem, Popover, Spinner } from '../ui';
import '../../styles/ai.css';

const MarkdownText = lazy(() => import('../Markdown'));

/** Turn `[n]` citations into links to the cited messages. */
export function withCitationLinks(text: string, result: Pick<AiResult, 'citations'>): string {
  const links = new Map(result.citations.map((citation) => [citation.n, citation.link]));
  return text.replace(/\[(\d{1,4})\](?!\()/g, (all, n: string) => (links.has(Number(n)) ? `[[${n}]](${links.get(Number(n))})` : all));
}

/** Markdown answer text with its citations, as it streams in. */
export function AiText({ result }: { result: AiResult }) {
  return (
    <div className="ai-text md">
      <Suspense fallback={<p>{result.text}</p>}>
        <MarkdownText text={withCitationLinks(result.text, result)} />
      </Suspense>
      {!result.done ? <span className="ai-caret" aria-hidden="true" /> : null}
    </div>
  );
}

// ── Conversation header ─────────────────────────────────────────────────────

export function AiChannelButton({ channel }: { channel: string }) {
  const summaries = useAiFeature('summaries');
  const recaps = useAiFeature('recaps');
  const name = useStore((state) => conversationName(state, conversation(state, channel)));
  const isChannel = useStore((state) => Boolean(conversation(state, channel)?.is_channel));
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  if (!summaries && !recaps) return null;
  const label = isChannel ? `#${name}` : name;
  const pick = (action: () => void) => () => {
    setOpen(false);
    action();
  };
  return (
    <>
      <IconButton ref={anchor} className="ai-btn" label={S.ai.sparkle} onClick={() => setOpen(true)}>
        <Sparkles size={17} />
      </IconButton>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} align="end" className="menu">
          {summaries ? (
            <>
              <MenuItem icon={<Sparkles size={16} />} label={S.ai.summarizeUnread} onSelect={pick(() => void summarize({ channel, range: 'unread' }, S.ai.titleUnread(label)))} />
              <MenuItem icon={<Sparkles size={16} />} label={S.ai.summarizeToday} onSelect={pick(() => void summarize({ channel, range: 'today' }, S.ai.titleToday(label)))} />
            </>
          ) : null}
          {recaps && isChannel ? (
            <>
              {summaries ? <MenuDivider /> : null}
              <MenuItem icon={<CalendarClock size={16} />} label={S.ai.dailyRecap} onSelect={pick(() => openAiModal('recap'))} />
            </>
          ) : null}
        </Popover>
      ) : null}
    </>
  );
}

// ── Thread panel ────────────────────────────────────────────────────────────

export function AiThreadSummary({ channel, ts }: { channel: string; ts: string }) {
  const summaries = useAiFeature('summaries');
  if (!summaries) return null;
  return (
    <button type="button" className="ai-chip" onClick={() => void summarize({ channel, thread_ts: ts }, S.ai.titleThread)}>
      <Sparkles size={14} />
      {S.ai.summarizeThread}
    </button>
  );
}

// ── Message menu and in-place translation ───────────────────────────────────

export function AiMessageItems({ channel, message, inThread, onDone }: { channel: string; message: Message; inThread: boolean; onDone: () => void }) {
  const translate = useAiFeature('translate');
  const summaries = useAiFeature('summaries');
  const canTranslate = translate && Boolean(message.text) && message.subtype !== 'tombstone';
  const canSummarize = summaries && !inThread && (message.reply_count ?? 0) > 0;
  if (!canTranslate && !canSummarize) return null;
  return (
    <>
      <MenuDivider />
      {canTranslate ? (
        <MenuItem
          icon={<Languages size={16} />}
          label={S.ai.translate}
          onSelect={() => {
            onDone();
            void translateMessage(channel, message.ts);
          }}
        />
      ) : null}
      {canSummarize ? (
        <MenuItem
          icon={<Sparkles size={16} />}
          label={S.ai.summarizeThread}
          onSelect={() => {
            onDone();
            void summarize({ channel, thread_ts: message.thread_ts ?? message.ts }, S.ai.titleThread);
          }}
        />
      ) : null}
    </>
  );
}

export function AiTranslation({ channel, ts }: { channel: string; ts: string }) {
  const translation = useTranslation(channel, ts);
  if (!translation?.shown) return null;
  return (
    <div className="ai-translation" aria-live="polite">
      <div className="ai-translation-head">
        <Languages size={13} />
        <span>{translation.loading ? S.ai.translating : S.ai.translated}</span>
        {!translation.loading ? (
          <button type="button" className="link-btn" onClick={() => hideTranslation(channel, ts)}>
            {S.ai.hideTranslation}
          </button>
        ) : null}
      </div>
      {translation.error ? <p className="ai-error">{aiErrorText(translation.error)}</p> : null}
      {translation.text ? <p className="ai-translation-text">{translation.text}</p> : null}
    </div>
  );
}

// ── Composer ────────────────────────────────────────────────────────────────

const WRITE_MODES: WriteMode[] = ['improve', 'shorten', 'friendly', 'formal', 'fix'];

export function AiWriteButton({ text, onReplace }: { text: string; onReplace: (value: string) => void }) {
  const writing = useAiFeature('writing');
  const anchor = useRef<HTMLButtonElement>(null);
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  const [undo, setUndo] = useState<{ before: string; after: string } | null>(null);
  if (!writing) return null;
  const canUndo = undo !== null && undo.after === text;

  const run = async (mode: WriteMode): Promise<void> => {
    setOpen(false);
    if (!text.trim()) {
      toast(S.ai.write.empty);
      return;
    }
    setBusy(true);
    try {
      const rewritten = await rewriteDraft(text, mode);
      setUndo({ before: text, after: rewritten });
      onReplace(rewritten);
    } catch (error) {
      toast(error instanceof Error ? error.message : S.ai.errors.generic, 'error');
    } finally {
      setBusy(false);
    }
  };

  return (
    <>
      <span className="tool-sep" />
      <IconButton ref={anchor} className="ai-btn" label={busy ? S.ai.write.working : S.ai.write.button} onClick={() => setOpen(true)} disabled={busy}>
        {busy ? <span className="spinner" aria-hidden="true" /> : <WandSparkles size={16} />}
      </IconButton>
      {open ? (
        <Popover anchor={anchor.current} onClose={() => setOpen(false)} side="top" className="menu">
          {canUndo ? (
            <>
              <MenuItem
                icon={<Undo2 size={16} />}
                label={S.ai.write.undo}
                onSelect={() => {
                  setOpen(false);
                  onReplace(undo!.before);
                  setUndo(null);
                }}
              />
              <MenuDivider />
            </>
          ) : null}
          {WRITE_MODES.map((mode) => (
            <MenuItem key={mode} icon={<WandSparkles size={16} />} label={S.ai.write[mode]} onSelect={() => void run(mode)} />
          ))}
        </Popover>
      ) : null}
    </>
  );
}

// ── Search ──────────────────────────────────────────────────────────────────

export function AiSearchAnswer({ query }: { query: string }) {
  const enabled = useAiFeature('search_answers');
  const result = useAi((state) => state.answers[query]);
  if (!enabled || !query) return null;
  if (!result) {
    return (
      <div className="ai-answer is-idle">
        <Button size="sm" onClick={() => void askQuestion(query)}>
          <Sparkles size={14} /> {S.ai.answerButton}
        </Button>
        <span className="field-hint">{S.ai.answerHint}</span>
      </div>
    );
  }
  return (
    <section className="ai-answer" aria-live="polite">
      <header>
        <Sparkles size={15} />
        <strong>{S.ai.answerTitle}</strong>
        <span className="ai-private">{S.ai.onlyYou}</span>
      </header>
      {result.error ? <p className="ai-error">{aiErrorText(result.error)}</p> : null}
      {!result.text && !result.done ? <Spinner label={S.ai.answering} /> : null}
      {result.text ? <AiText result={result} /> : null}
      {result.done && result.citations.length > 0 ? <CitationList result={result} /> : null}
    </section>
  );
}

export function CitationList({ result }: { result: AiResult }) {
  return (
    <ol className="ai-citations" aria-label={S.ai.sources}>
      {result.citations.map((citation) => (
        <li key={citation.n} value={citation.n}>
          <a
            href={citation.link}
            onClick={(event) => {
              event.preventDefault();
              go({ name: 'conversation', id: citation.channel, ts: citation.ts });
            }}
          >
            <strong>{citation.author}</strong> {citation.excerpt}
          </a>
        </li>
      ))}
    </ol>
  );
}

// ── Workspace menu ──────────────────────────────────────────────────────────

/** Entries for the workspace menu: agents for everyone, recaps when on, settings for admins. */
export function AiMenuItems({ pick }: { pick: (action: () => void) => () => void }) {
  const isAdmin = useStore((state) => Boolean(state.self?.is_admin));
  const recaps = useAiFeature('recaps');
  return (
    <>
      <MenuItem icon={<Bot size={16} />} label={S.ai.menuAgents} onSelect={pick(() => go({ name: 'agents' }))} />
      {recaps ? <MenuItem icon={<CalendarClock size={16} />} label={S.ai.menuRecap} onSelect={pick(() => openAiModal('recap'))} /> : null}
      {isAdmin ? <MenuItem icon={<Settings2 size={16} />} label={S.ai.menuSettings} onSelect={pick(() => openAiModal('settings'))} /> : null}
    </>
  );
}
