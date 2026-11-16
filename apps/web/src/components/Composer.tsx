import type { User } from '@app/shared';
import { AtSign, Bold, Code, Hash, Italic, Link2, Paperclip, Quote, SendHorizontal, Smile, SquareCode, SquareSlash, Strikethrough, X, FileText } from 'lucide-react';
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type ReactNode } from 'react';
import { errorText, loadCommands, runCommand, sendFiles, sendMessage, toast } from '../lib/actions';
import { asset, uploadFile } from '../lib/api';
import { encodeMessage, findTrigger, prefixLines, wrapSelection, type Edit, type Trigger } from '../lib/compose';
import { searchEmoji } from '../lib/emoji';
import { sendTyping } from '../lib/realtime';
import { displayName, get, set, threadKey, useStore } from '../lib/store';
import { fileSize } from '../lib/time';
import { S } from '../strings';
import { promptDialog } from './dialogs/confirm';
import { composeLookup, PickerPopover } from './Message';
import { Avatar, IconButton } from './ui';

interface Upload {
  key: string;
  file: File;
  progress: number;
  fileId?: string;
  failed?: boolean;
  preview?: string;
}

interface Suggestion {
  key: string;
  insert: string;
  icon: ReactNode;
  label: string;
  sub?: string;
}

interface ComposerProps {
  channel: string;
  threadTs?: string;
  placeholder: string;
  autoFocus?: boolean;
  /** Label for the "also send to channel" option in threads. */
  broadcastLabel?: string;
}

function draftKey(channel: string, threadTs?: string): string {
  return `draft:${channel}${threadTs ? `:${threadTs}` : ''}`;
}

function matchesUser(user: User, query: string): number {
  const names = [user.profile.display_name, user.real_name, user.name].map((name) => name.toLowerCase());
  if (names.some((name) => name.startsWith(query))) return 2;
  if (names.some((name) => name.split(/[\s._-]+/).some((word) => word.startsWith(query)))) return 1;
  return 0;
}

function suggest(trigger: Trigger, channel: string): { heading: string; items: Suggestion[] } {
  const state = get();
  const query = trigger.query;
  if (trigger.kind === 'user') {
    const people = Object.values(state.users)
      .filter((user) => !user.deleted)
      .map((user) => ({ user, score: matchesUser(user, query) }))
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score || displayName(a.user).localeCompare(displayName(b.user)))
      .slice(0, 8)
      .map(({ user }) => ({
        key: user.id,
        insert: `@${displayName(user)} `,
        icon: <Avatar user={user} size={22} presence />,
        label: displayName(user),
        sub: user.is_bot ? S.sidebar.app : user.real_name !== displayName(user) ? user.real_name : user.profile.title,
      }));
    const conv = state.channels[channel];
    const broadcasts =
      conv && !conv.is_im
        ? [
            { name: 'here', sub: S.composer.notifyOnline },
            { name: 'channel', sub: S.composer.notifyEveryone },
          ]
            .filter((entry) => query !== '' && entry.name.startsWith(query))
            .map((entry) => ({ key: entry.name, insert: `@${entry.name} `, icon: <AtSign size={18} />, label: `@${entry.name}`, sub: entry.sub }))
        : [];
    return { heading: S.composer.people, items: [...people, ...broadcasts] };
  }
  if (trigger.kind === 'channel') {
    const items = [...Object.values(state.channels), ...Object.values(state.others)]
      .filter((conv) => conv.is_channel && conv.name && conv.name.includes(query))
      .sort((a, b) => Number(b.name!.startsWith(query)) - Number(a.name!.startsWith(query)) || a.name!.localeCompare(b.name!))
      .slice(0, 8)
      .map((conv) => ({ key: conv.id, insert: `#${conv.name} `, icon: <Hash size={18} />, label: conv.name!, sub: conv.purpose?.value }));
    return { heading: S.composer.channelsHeading, items };
  }
  if (trigger.kind === 'emoji') {
    const items = searchEmoji(query, state.emoji).map((match) => ({
      key: match.name,
      insert: `:${match.name}: `,
      icon: match.url ? <img className="emoji emoji-custom" src={asset(match.url)} alt="" /> : <span className="emoji">{match.native}</span>,
      label: `:${match.name}:`,
    }));
    return { heading: S.composer.emojiHeading, items };
  }
  const items = state.commands
    .filter((command) => command.command.slice(1).startsWith(query))
    .slice(0, 8)
    .map((command) => ({
      key: command.command,
      insert: `${command.command} `,
      icon: <SquareSlash size={18} />,
      label: `${command.command}${command.usage_hint ? ` ${command.usage_hint}` : ''}`,
      sub: command.description || command.app_name,
    }));
  return { heading: S.composer.commandsHeading, items };
}

export function Composer({ channel, threadTs, placeholder, autoFocus = false, broadcastLabel }: ComposerProps) {
  const storageKey = draftKey(channel, threadTs);
  const [text, setTextState] = useState(() => localStorage.getItem(storageKey) ?? '');
  const [uploads, setUploads] = useState<Upload[]>([]);
  const [broadcast, setBroadcast] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [index, setIndex] = useState(0);
  const [picking, setPicking] = useState(false);
  const input = useRef<HTMLTextAreaElement>(null);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  const maxBytes = useStore((state) => state.maxUploadBytes);
  const typingKey = threadTs ? threadKey(channel, threadTs) : channel;
  const typingText = useStore((state) => {
    const active = state.typing[typingKey];
    if (!active) return '';
    const names = Object.keys(active)
      .filter((id) => id !== state.self?.id)
      .map((id) => displayName(state.users[id]));
    return names.length > 0 ? S.messages.typing(names) : '';
  });

  const suggestions = useMemo(() => (trigger ? suggest(trigger, channel) : null), [trigger, channel]);
  const open = suggestions !== null && suggestions.items.length > 0;

  const setText = (value: string): void => {
    setTextState(value);
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
  };

  useEffect(() => {
    if (autoFocus) input.current?.focus();
  }, [autoFocus, channel]);

  useLayoutEffect(() => {
    const node = input.current;
    if (!node) return;
    node.style.height = 'auto';
    node.style.height = `${Math.min(node.scrollHeight, Math.round(window.innerHeight * 0.45))}px`;
    if (pendingSelection.current) {
      node.focus();
      node.setSelectionRange(pendingSelection.current[0], pendingSelection.current[1]);
      pendingSelection.current = null;
    }
  }, [text]);

  useEffect(
    () => () => {
      for (const upload of uploadsRef.current) if (upload.preview) URL.revokeObjectURL(upload.preview);
    },
    [],
  );

  // ── Files ─────────────────────────────────────────────────────────────────

  const addFiles = (files: File[]): void => {
    for (const file of files) {
      if (maxBytes > 0 && file.size > maxBytes) {
        toast(S.composer.tooLarge(file.name, fileSize(maxBytes)), 'error');
        continue;
      }
      const key = crypto.randomUUID();
      const upload: Upload = { key, file, progress: 0 };
      if (file.type.startsWith('image/')) upload.preview = URL.createObjectURL(file);
      setUploads((current) => [...current, upload]);
      uploadFile(file, (fraction) => {
        setUploads((current) => current.map((item) => (item.key === key ? { ...item, progress: fraction } : item)));
      })
        .then((fileId) => {
          setUploads((current) => current.map((item) => (item.key === key ? { ...item, fileId, progress: 1 } : item)));
        })
        .catch((error: unknown) => {
          setUploads((current) => current.map((item) => (item.key === key ? { ...item, failed: true } : item)));
          toast(`${S.composer.uploadFailed(file.name)} ${errorText(error)}`, 'error');
        });
    }
    input.current?.focus();
  };

  const removeUpload = (key: string): void => {
    setUploads((current) => {
      const target = current.find((item) => item.key === key);
      if (target?.preview) URL.revokeObjectURL(target.preview);
      return current.filter((item) => item.key !== key);
    });
  };

  // Dropping files anywhere on the surrounding conversation attaches them here.
  useEffect(() => {
    const scope = root.current?.closest<HTMLElement>('[data-drop-scope]');
    if (!scope) return;
    let depth = 0;
    const hasFiles = (event: DragEvent): boolean => Array.from(event.dataTransfer?.types ?? []).includes('Files');
    const enter = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth += 1;
      scope.dataset.dragging = 'true';
    };
    const over = (event: DragEvent): void => {
      if (hasFiles(event)) event.preventDefault();
    };
    const leave = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      depth = Math.max(0, depth - 1);
      if (depth === 0) delete scope.dataset.dragging;
    };
    const drop = (event: DragEvent): void => {
      if (!hasFiles(event)) return;
      event.preventDefault();
      depth = 0;
      delete scope.dataset.dragging;
      addFiles(Array.from(event.dataTransfer?.files ?? []));
    };
    scope.addEventListener('dragenter', enter);
    scope.addEventListener('dragover', over);
    scope.addEventListener('dragleave', leave);
    scope.addEventListener('drop', drop);
    return () => {
      scope.removeEventListener('dragenter', enter);
      scope.removeEventListener('dragover', over);
      scope.removeEventListener('dragleave', leave);
      scope.removeEventListener('drop', drop);
      delete scope.dataset.dragging;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [maxBytes]);

  const onPaste = (event: ClipboardEvent<HTMLTextAreaElement>): void => {
    const files = Array.from(event.clipboardData.files);
    if (files.length === 0) return;
    event.preventDefault();
    addFiles(files);
  };

  // ── Text editing ──────────────────────────────────────────────────────────

  const refreshTrigger = (value: string, caret: number): void => {
    const next = findTrigger(value, caret);
    setTrigger(next);
    setIndex(0);
  };

  const applyEdit = (edit: Edit): void => {
    pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
    setText(edit.text);
    setTrigger(null);
  };

  const format = (kind: 'bold' | 'italic' | 'strike' | 'code' | 'block' | 'quote' | 'link'): void => {
    const node = input.current;
    if (!node) return;
    const { selectionStart: start, selectionEnd: end } = node;
    if (kind === 'bold') applyEdit(wrapSelection(text, start, end, '*'));
    else if (kind === 'italic') applyEdit(wrapSelection(text, start, end, '_'));
    else if (kind === 'strike') applyEdit(wrapSelection(text, start, end, '~'));
    else if (kind === 'code') applyEdit(wrapSelection(text, start, end, '`'));
    else if (kind === 'block') applyEdit(wrapSelection(text, start, end, '```\n', '\n```'));
    else if (kind === 'quote') applyEdit(prefixLines(text, start, end, '> '));
    else {
      void promptDialog({ title: S.composer.link, label: S.composer.linkPrompt, placeholder: 'https://', confirmLabel: S.done }).then((url) => {
        if (!url?.trim()) return;
        const address = /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
        const label = text.slice(start, end);
        const token = label ? `<${address}|${label}>` : address;
        const next = text.slice(0, start) + token + text.slice(end);
        applyEdit({ text: next, selectionStart: start + token.length, selectionEnd: start + token.length });
      });
    }
  };

  const insertAtCaret = (value: string): void => {
    const node = input.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + value + text.slice(end);
    pendingSelection.current = [start + value.length, start + value.length];
    setText(next);
    return;
  };

  const choose = (item: Suggestion): void => {
    if (!trigger) return;
    const caret = input.current?.selectionStart ?? text.length;
    const next = text.slice(0, trigger.start) + item.insert + text.slice(caret);
    const position = trigger.start + item.insert.length;
    applyEdit({ text: next, selectionStart: position, selectionEnd: position });
  };

  // ── Sending ───────────────────────────────────────────────────────────────

  const uploading = uploads.some((upload) => !upload.fileId && !upload.failed);
  const ready = uploads.filter((upload) => upload.fileId);
  const canSend = !uploading && (text.trim().length > 0 || ready.length > 0);

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const body = text.trim();
    const encoded = encodeMessage(body, composeLookup());
    const fileIds = ready.map((upload) => upload.fileId!);
    for (const upload of uploads) if (upload.preview) URL.revokeObjectURL(upload.preview);
    setText('');
    setUploads([]);
    setTrigger(null);
    if (fileIds.length > 0) {
      await sendFiles({ channel, text: encoded, threadTs }, fileIds);
      return;
    }
    const command = /^(\/[a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(body);
    if (command) {
      const name = command[1]!.toLowerCase();
      const known = (): boolean => get().commands.some((item) => item.command === name);
      // The list was loaded when this tab started; a command added since is one request away.
      if (!known()) await loadCommands();
      if (known()) {
        const ok = await runCommand(channel, name, command[2] ?? '', threadTs);
        if (!ok) setText(body);
        return;
      }
    }
    void sendMessage({ channel, text: encoded, threadTs, broadcast: broadcast && Boolean(threadTs) });
    setBroadcast(false);
  };

  const editLast = (): boolean => {
    const state = get();
    const list = threadTs ? (state.threads[threadKey(channel, threadTs)]?.replies ?? []) : (state.convs[channel]?.list ?? []);
    const mine = [...list].reverse().find((message) => message.user === state.self?.id && !message.bot_id && !message.subtype);
    if (!mine) return false;
    // The newest message is still on its way: do not reach past it to an older one.
    if (mine.pending || mine.failed) return true;
    set({ editing: { channel, ts: mine.ts } });
    return true;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (open && suggestions) {
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        event.preventDefault();
        const count = suggestions.items.length;
        setIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
        return;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        event.preventDefault();
        choose(suggestions.items[index] ?? suggestions.items[0]!);
        return;
      }
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setTrigger(null);
        return;
      }
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault();
      void submit();
      return;
    }
    if (event.key === 'ArrowUp' && text === '' && editLast()) {
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.shiftKey && !event.altKey) {
      const key = event.key.toLowerCase();
      if (key === 'b') {
        event.preventDefault();
        format('bold');
      } else if (key === 'i') {
        event.preventDefault();
        format('italic');
      }
    }
  };

  return (
    <div className="composer-wrap" ref={root}>
      {open && suggestions ? (
        <div className="suggest" role="listbox">
          <div className="suggest-head">{suggestions.heading}</div>
          {suggestions.items.map((item, itemIndex) => (
            <button
              key={item.key}
              type="button"
              role="option"
              aria-selected={itemIndex === index}
              className={`suggest-item ${itemIndex === index ? 'is-active' : ''}`}
              onMouseEnter={() => setIndex(itemIndex)}
              onMouseDown={(event) => {
                event.preventDefault();
                choose(item);
              }}
            >
              <span className="suggest-icon">{item.icon}</span>
              <span className="suggest-label">{item.label}</span>
              {item.sub ? <span className="suggest-sub">{item.sub}</span> : null}
            </button>
          ))}
        </div>
      ) : null}
      <div className="composer">
        <div className="composer-tools" role="toolbar">
          <IconButton label={S.composer.bold} onClick={() => format('bold')}>
            <Bold size={16} />
          </IconButton>
          <IconButton label={S.composer.italic} onClick={() => format('italic')}>
            <Italic size={16} />
          </IconButton>
          <IconButton label={S.composer.strike} onClick={() => format('strike')}>
            <Strikethrough size={16} />
          </IconButton>
          <span className="tool-sep" />
          <IconButton label={S.composer.link} onClick={() => format('link')}>
            <Link2 size={16} />
          </IconButton>
          <IconButton label={S.composer.quote} onClick={() => format('quote')}>
            <Quote size={16} />
          </IconButton>
          <span className="tool-sep" />
          <IconButton label={S.composer.code} onClick={() => format('code')}>
            <Code size={16} />
          </IconButton>
          <IconButton label={S.composer.codeBlock} onClick={() => format('block')}>
            <SquareCode size={16} />
          </IconButton>
        </div>
        <textarea
          ref={input}
          className="composer-input"
          rows={1}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          onChange={(event) => {
            setText(event.target.value);
            refreshTrigger(event.target.value, event.target.selectionStart);
            if (event.target.value) sendTyping(channel, threadTs);
          }}
          onKeyDown={onKeyDown}
          onPaste={onPaste}
          onClick={(event) => refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
          onBlur={() => window.setTimeout(() => setTrigger(null), 120)}
        />
        {uploads.length > 0 ? (
          <div className="composer-uploads">
            {uploads.map((upload) => (
              <div key={upload.key} className={`upload-chip ${upload.failed ? 'is-failed' : ''}`}>
                {upload.preview ? <img src={upload.preview} alt="" /> : <span className="upload-glyph"><FileText size={18} /></span>}
                <span className="upload-meta">
                  <span className="upload-name">{upload.file.name}</span>
                  <span className="upload-sub">{upload.fileId ? fileSize(upload.file.size) : upload.failed ? S.errors.upload_failed : S.composer.uploading}</span>
                </span>
                <IconButton label={S.composer.removeFile} onClick={() => removeUpload(upload.key)}>
                  <X size={14} />
                </IconButton>
                {!upload.fileId && !upload.failed ? <span className="upload-bar" style={{ width: `${Math.round(upload.progress * 100)}%` }} /> : null}
              </div>
            ))}
          </div>
        ) : null}
        <div className="composer-foot">
          <input
            ref={fileInput}
            type="file"
            multiple
            hidden
            onChange={(event) => {
              addFiles(Array.from(event.target.files ?? []));
              event.target.value = '';
            }}
          />
          <IconButton label={S.composer.attach} onClick={() => fileInput.current?.click()}>
            <Paperclip size={17} />
          </IconButton>
          <IconButton ref={emojiButton} label={S.composer.emoji} onClick={() => setPicking(true)}>
            <Smile size={17} />
          </IconButton>
          <IconButton
            label={S.composer.mention}
            onClick={() => {
              const node = input.current;
              const caret = node?.selectionStart ?? text.length;
              const lead = caret > 0 && !/\s/.test(text[caret - 1] ?? ' ') ? ' @' : '@';
              insertAtCaret(lead);
              window.setTimeout(() => refreshTrigger(input.current?.value ?? '', input.current?.selectionStart ?? 0), 0);
            }}
          >
            <AtSign size={17} />
          </IconButton>
          {threadTs && broadcastLabel ? (
            <label className="composer-broadcast">
              <input type="checkbox" checked={broadcast} onChange={(event) => setBroadcast(event.target.checked)} />
              <span>{broadcastLabel}</span>
            </label>
          ) : null}
          <span className="composer-spacer" />
          <button type="button" className="send-btn" disabled={!canSend} onClick={() => void submit()} aria-label={S.composer.send} title={S.composer.send}>
            <SendHorizontal size={17} />
          </button>
        </div>
      </div>
      <div className="composer-status">
        <span className="typing-text" aria-live="polite">
          {typingText}
        </span>
        <span className="composer-hint">{S.composer.hint}</span>
      </div>
      {picking ? (
        <PickerPopover
          anchor={emojiButton.current}
          side="top"
          onClose={() => setPicking(false)}
          onPick={(name) => insertAtCaret(`:${name}: `)}
        />
      ) : null}
    </div>
  );
}
