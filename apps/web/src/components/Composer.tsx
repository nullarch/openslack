import { ClipButton } from './ClipRecorder';
import type { User } from '@app/shared';
import { AtSign, Bold, CalendarClock, ChevronDown, Clock, Code, FileCode2, Hash, Italic, Link2, List, ListOrdered, Moon, Paperclip, Quote, SendHorizontal, Smile, SquareCode, SquareSlash, Strikethrough, Users, X, FileText } from 'lucide-react';
import { ShortcutsButton } from './AppViews';
import { useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type ClipboardEvent, type KeyboardEvent, type MouseEvent, type ReactNode } from 'react';
import { useShallow } from 'zustand/react/shallow';
import { errorText, loadCommands, openModal, runCommand, sendFiles, sendMessage, toast } from '../lib/actions';
import { canPostIn, draftEvents, draftKey as serverDraftKey, notifyAnyway, saveDraft, scheduleMessage, serverDraft, userInDnd } from '../lib/attention';
import { BUILT_INS, findBuiltIn } from '../lib/builtins';
import { commandsIn } from '../lib/codeChannels';
import { asset, call, uploadFile } from '../lib/api';
import { accounts } from '../lib/accounts';
import { encodeMessage, findTrigger, prefixLines, wrapSelection, type Edit, type Trigger } from '../lib/compose';
import { searchEmoji } from '../lib/emoji';
import { composeLookup, markupComposer, richLookup, useRichInput, type FormatKind, type RichHandle } from '../lib/richInput';
import { composeMarkup, composeRich, docToMarkup, EMPTY_DOC, markupToDoc, type DocNode, type Outgoing } from '../lib/richtext';
import { sendTyping } from '../lib/realtime';
import { displayName, get, set, threadKey, useStore } from '../lib/store';
import { fileSize } from '../lib/time';
import { S } from '../strings';
import { AiWriteButton } from './ai/AiControls';
import { promptDialog } from './dialogs/confirm';
import { PickerPopover } from './Message';
import { Avatar, IconButton, MenuItem, Popover } from './ui';

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
  /** What the markup composer types. */
  insert: string;
  /** What the rich composer puts in instead: a chip, an emoji, or text. */
  node: DocNode;
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

/** 9:00 in the morning, `days` from today, in seconds. */
function atNine(days: number): number {
  const date = new Date();
  date.setDate(date.getDate() + days);
  date.setHours(9, 0, 0, 0);
  return Math.floor(date.getTime() / 1000);
}

function matchesUser(user: User, query: string): number {
  const names = [user.profile.display_name, user.real_name, user.name].map((name) => name.toLowerCase());
  if (names.some((name) => name.startsWith(query))) return 2;
  if (names.some((name) => name.split(/[\s._-]+/).some((word) => word.startsWith(query)))) return 1;
  return 0;
}

const mention = (kind: string, id: string, label: string): DocNode => ({ type: 'mention', attrs: { kind, id, label } });

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
        node: mention('user', user.id, displayName(user)),
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
            .map((entry) => ({ key: entry.name, insert: `@${entry.name} `, node: mention('broadcast', entry.name, entry.name), icon: <AtSign size={18} />, label: `@${entry.name}`, sub: entry.sub }))
        : [];
    const groups = Object.values(accounts().usergroups)
      .filter((group) => group.handle.startsWith(query) || group.name.toLowerCase().includes(query))
      .slice(0, 5)
      .map((group) => ({ key: group.id, insert: `@${group.handle} `, node: mention('usergroup', group.id, group.handle), icon: <Users size={18} />, label: `@${group.handle}`, sub: group.name }));
    return { heading: S.composer.people, items: [...people, ...groups, ...broadcasts] };
  }
  if (trigger.kind === 'channel') {
    const items = [...Object.values(state.channels), ...Object.values(state.others)]
      .filter((conv) => conv.is_channel && conv.name && conv.name.includes(query))
      .sort((a, b) => Number(b.name!.startsWith(query)) - Number(a.name!.startsWith(query)) || a.name!.localeCompare(b.name!))
      .slice(0, 8)
      .map((conv) => ({ key: conv.id, insert: `#${conv.name} `, node: mention('channel', conv.id, conv.name!), icon: <Hash size={18} />, label: conv.name!, sub: conv.purpose?.value }));
    return { heading: S.composer.channelsHeading, items };
  }
  if (trigger.kind === 'emoji') {
    const items = searchEmoji(query, state.emoji).map((match) => ({
      key: match.name,
      insert: `:${match.name}: `,
      node: { type: 'emoji', attrs: { name: match.name } },
      icon: match.url ? <img className="emoji emoji-custom" src={asset(match.url)} alt="" /> : <span className="emoji">{match.native}</span>,
      label: `:${match.name}:`,
    }));
    return { heading: S.composer.emojiHeading, items };
  }
  // A built-in command wins over an app command of the same name; apps' own commands are listed first.
  const builtIns = BUILT_INS.filter((command) => command.command.slice(1).startsWith(query)).map((command) => ({
    key: command.command,
    insert: `${command.command} `,
    node: { type: 'text', text: command.command },
    icon: <SquareSlash size={18} />,
    label: `${command.command}${command.usage ? ` ${command.usage}` : ''}`,
    sub: command.description,
  }));
  const items = commandsIn(state.commands, channel)
    .filter((command) => command.command.slice(1).startsWith(query) && !findBuiltIn(command.command))
    .map((command) => ({
      key: command.command,
      insert: `${command.command} `,
      node: { type: 'text', text: command.command },
      icon: <SquareSlash size={18} />,
      label: `${command.command}${command.usage_hint ? ` ${command.usage_hint}` : ''}`,
      sub: command.description || command.app_name,
    }));
  return { heading: S.composer.commandsHeading, items: [...items, ...builtIns].slice(0, 10) };
}

/** Where an autocomplete trigger is in the rich editor: the text before the caret in its line. */
function richTrigger(handle: RichHandle | null): (Trigger & { from: number; to: number }) | null {
  const context = handle?.context();
  if (!context) return null;
  const found = findTrigger(context.text, context.text.length);
  // A slash command is the whole message, so only its first line can start one.
  if (!found || (found.kind === 'command' && !context.first)) return null;
  return { ...found, from: context.start + found.start, to: context.start + context.text.length };
}

const NO_FORMAT: Record<FormatKind, boolean> = { bold: false, italic: false, strike: false, code: false, block: false, quote: false, bullet: false, ordered: false, link: false };

export function Composer({ channel, threadTs, placeholder, autoFocus = false, broadcastLabel }: ComposerProps) {
  const storageKey = draftKey(channel, threadTs);
  // `text` is always the typed (markup) form: what drafts keep and what commands read.
  const [text, setTextState] = useState(() => localStorage.getItem(storageKey) ?? serverDraft(channel, threadTs) ?? '');
  const textRef = useRef(text);
  textRef.current = text;
  const [uploads, setUploads] = useState<Upload[]>([]);
  const clipTranscripts = useRef(new Map<File, { vtt: string; locale: string }>());
  const [broadcast, setBroadcast] = useState(false);
  const [trigger, setTrigger] = useState<Trigger | null>(null);
  const [index, setIndex] = useState(0);
  const [picking, setPicking] = useState(false);
  const [scheduling, setScheduling] = useState(false);
  const [formats, setFormats] = useState(NO_FORMAT);
  const scheduleButton = useRef<HTMLButtonElement>(null);
  const input = useRef<HTMLTextAreaElement>(null);
  const editor = useRef<RichHandle>(null);
  const root = useRef<HTMLDivElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const emojiButton = useRef<HTMLButtonElement>(null);
  const pendingSelection = useRef<[number, number] | null>(null);
  const dismissed = useRef(false);
  const uploadsRef = useRef(uploads);
  uploadsRef.current = uploads;

  // The rich editor unless this person chose markup, or its chunk could not load.
  const wantsMarkup = useStore((state) => markupComposer(state.prefs));
  const { Input: RichInput, failed } = useRichInput(!wantsMarkup);
  const rich = !wantsMarkup && !failed;
  const selfId = useStore((state) => state.self?.id ?? '');
  // What the rich editor starts with: the draft, when it first appears (and again after a switch of composer).
  const initialDoc = useMemo<DocNode>(() => (rich ? markupToDoc(textRef.current, richLookup()) : EMPTY_DOC), [rich]);

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
  const suggestId = useId();
  const open = suggestions !== null && suggestions.items.length > 0;

  /** Keep what is typed: in this tab, in this browser, and as the draft other devices see. */
  const saveText = (value: string): void => {
    setTextState(value);
    textRef.current = value;
    if (value) localStorage.setItem(storageKey, value);
    else localStorage.removeItem(storageKey);
    // Slash commands are not drafts worth carrying to other devices.
    if (!value.startsWith('/')) saveDraft(channel, threadTs, value);
  };

  /** Replace what is in the composer (cleared after sending, restored, rewritten, arrived from elsewhere). */
  const replaceText = (value: string): void => {
    saveText(value);
    if (rich) editor.current?.setContent(value ? markupToDoc(value, richLookup()) : EMPTY_DOC);
  };

  const focusInput = (): void => {
    if (rich) editor.current?.focus();
    else input.current?.focus();
  };

  // A draft written on another device appears here unless something is already being typed.
  useEffect(() => {
    const onDraft = (event: Event): void => {
      const detail = (event as CustomEvent<{ key: string; text: string }>).detail;
      if (detail.key !== serverDraftKey(channel, threadTs)) return;
      const node = rich ? editor.current?.element() : input.current;
      if (node && document.activeElement === node && textRef.current.trim() !== '') return;
      setTextState(detail.text);
      textRef.current = detail.text;
      if (rich) editor.current?.setContent(detail.text ? markupToDoc(detail.text, richLookup()) : EMPTY_DOC);
      if (detail.text) localStorage.setItem(storageKey, detail.text);
      else localStorage.removeItem(storageKey);
    };
    draftEvents.addEventListener('draft', onDraft);
    return () => draftEvents.removeEventListener('draft', onDraft);
  }, [channel, threadTs, storageKey, rich]);

  const conv = useStore((state) => state.channels[channel]);
  const permissions = useStore(useShallow((state) => {
    void state.att.tick;
    return canPostIn(state.channels[channel] ?? state.others[channel]);
  }));
  const pausedName = useStore((state) => {
    void state.att.tick;
    const item = state.channels[channel];
    if (!item?.is_im || item.user === state.self?.id || !userInDnd(item.user)) return null;
    return displayName(state.users[item.user ?? '']);
  });

  useEffect(() => {
    if (autoFocus && !rich) input.current?.focus();
  }, [autoFocus, channel, rich]);

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

  // The rich editor is the textbox that owns the suggestion list.
  useEffect(() => {
    const node = rich ? editor.current?.element() : null;
    if (!node) return;
    if (open) node.setAttribute('aria-controls', suggestId);
    else node.removeAttribute('aria-controls');
    if (open && suggestions?.items[index]) node.setAttribute('aria-activedescendant', `${suggestId}-${index}`);
    else node.removeAttribute('aria-activedescendant');
  });

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
        .then(async (fileId) => {
          // A clip's captions go with it, before it is sent.
          const transcript = clipTranscripts.current.get(file);
          if (transcript) {
            clipTranscripts.current.delete(file);
            await call('client.files.setTranscript', { file: fileId, vtt: transcript.vtt, locale: transcript.locale }).catch((error: unknown) => toast(errorText(error), 'error'));
          }
          setUploads((current) => current.map((item) => (item.key === key ? { ...item, fileId, progress: 1 } : item)));
        })
        .catch((error: unknown) => {
          setUploads((current) => current.map((item) => (item.key === key ? { ...item, failed: true } : item)));
          toast(`${S.composer.uploadFailed(file.name)} ${errorText(error)}`, 'error');
        });
    }
    focusInput();
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

  const refreshRich = (): void => {
    setTrigger(dismissed.current ? null : richTrigger(editor.current));
    setIndex(0);
    setFormats(editor.current?.active() ?? NO_FORMAT);
  };

  const onRichChange = (): void => {
    const handle = editor.current;
    if (!handle) return;
    // Escape closes the list until something more is typed, as in the markup composer.
    dismissed.current = false;
    saveText(docToMarkup(handle.json(), richLookup(false)));
    refreshRich();
    if (!handle.isEmpty()) sendTyping(channel, threadTs);
  };

  const applyEdit = (edit: Edit): void => {
    pendingSelection.current = [edit.selectionStart, edit.selectionEnd];
    saveText(edit.text);
    setTrigger(null);
  };

  const askLink = (): void => {
    const handle = editor.current;
    const linked = handle?.active().link ?? false;
    void promptDialog({ title: S.composer.link, label: S.composer.linkPrompt, placeholder: 'https://', confirmLabel: S.done }).then((url) => {
      if (url === null || url === undefined) return;
      if (!url.trim() && !linked) return;
      const address = !url.trim() ? '' : /^[a-z][a-z0-9+.-]*:/i.test(url.trim()) ? url.trim() : `https://${url.trim()}`;
      handle?.setLink(address);
    });
  };

  const format = (kind: FormatKind): void => {
    if (rich) {
      if (kind === 'link') askLink();
      else editor.current?.format(kind);
      return;
    }
    const node = input.current;
    if (!node) return;
    const { selectionStart: start, selectionEnd: end } = node;
    if (kind === 'bold') applyEdit(wrapSelection(text, start, end, '*'));
    else if (kind === 'italic') applyEdit(wrapSelection(text, start, end, '_'));
    else if (kind === 'strike') applyEdit(wrapSelection(text, start, end, '~'));
    else if (kind === 'code') applyEdit(wrapSelection(text, start, end, '`'));
    else if (kind === 'block') applyEdit(wrapSelection(text, start, end, '```\n', '\n```'));
    else if (kind === 'quote') applyEdit(prefixLines(text, start, end, '> '));
    else if (kind === 'link') {
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
    if (rich) {
      editor.current?.insertText(value);
      return;
    }
    const node = input.current;
    const start = node?.selectionStart ?? text.length;
    const end = node?.selectionEnd ?? text.length;
    const next = text.slice(0, start) + value + text.slice(end);
    pendingSelection.current = [start + value.length, start + value.length];
    saveText(next);
  };

  const choose = (item: Suggestion): void => {
    if (rich) {
      const at = richTrigger(editor.current);
      if (!at) return;
      editor.current?.insertNodes([item.node], { from: at.from, to: at.to });
      setTrigger(null);
      return;
    }
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

  /** The message as sent: mrkdwn and its `rich_text` block, from either composer. */
  const outgoing = (body: string): Outgoing => {
    const lookup = richLookup();
    const handle = editor.current;
    return rich && handle ? composeRich(handle.json(), lookup) : composeMarkup(body, lookup);
  };

  const submit = async (): Promise<void> => {
    if (!canSend) return;
    const body = text.trim();
    const out = outgoing(body);
    const fileIds = ready.map((upload) => upload.fileId!);
    for (const upload of uploads) if (upload.preview) URL.revokeObjectURL(upload.preview);
    replaceText('');
    setUploads([]);
    setTrigger(null);
    if (fileIds.length > 0) {
      await sendFiles({ channel, text: out.text, threadTs }, fileIds);
      return;
    }
    const command = /^(\/[a-z0-9_-]+)(?:\s+([\s\S]*))?$/i.exec(body);
    const builtIn = command ? findBuiltIn(command[1]!) : undefined;
    if (builtIn) {
      const encoded = encodeMessage(body, composeLookup());
      const args = /^\/[a-z0-9_-]+\s*([\s\S]*)$/i.exec(encoded)?.[1] ?? '';
      const ok = await builtIn.run({ channel, threadTs, args });
      if (!ok) replaceText(body);
      return;
    }
    if (command) {
      const name = command[1]!.toLowerCase();
      const known = (): boolean => commandsIn(get().commands, channel).some((item) => item.command === name);
      // The list was loaded when this tab started; a command added since is one request away.
      if (!known()) await loadCommands();
      if (known()) {
        const ok = await runCommand(channel, name, command[2] ?? '', threadTs);
        if (!ok) replaceText(body);
        return;
      }
    }
    void sendMessage({ channel, text: out.text, blocks: out.blocks, threadTs, broadcast: broadcast && Boolean(threadTs) });
    setBroadcast(false);
  };

  /** Send later instead of now. Text only: files are sent when they are attached. */
  const schedule = async (postAt: number | 'custom'): Promise<void> => {
    setScheduling(false);
    const body = text.trim();
    if (!body || uploads.length > 0) return;
    const out = outgoing(body);
    if (postAt === 'custom') {
      openModal({ kind: 'schedule', channel, threadTs, text: out.text, blocks: out.blocks, draft: body, broadcast: broadcast && Boolean(threadTs) });
      replaceText('');
      return;
    }
    replaceText('');
    const ok = await scheduleMessage(channel, out.text, postAt, threadTs, broadcast && Boolean(threadTs), out.blocks);
    if (!ok) replaceText(body);
  };

  const notifyLatest = (): void => {
    const state = get();
    const mine = [...(state.convs[channel]?.list ?? [])].reverse().find((message) => message.user === state.self?.id && !message.pending && !message.failed);
    if (mine) void notifyAnyway(channel, mine.ts);
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

  /** Keys both composers share; true when handled. */
  const sharedKey = (event: { key: string; shiftKey: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean; stopPropagation: () => void }, list: { items: Suggestion[] } | null): boolean => {
    if (list && list.items.length > 0) {
      const count = list.items.length;
      if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
        setIndex((current) => (current + (event.key === 'ArrowDown' ? 1 : count - 1)) % count);
        return true;
      }
      if (event.key === 'Enter' || event.key === 'Tab') {
        choose(list.items[Math.min(index, count - 1)] ?? list.items[0]!);
        return true;
      }
      if (event.key === 'Escape') {
        event.stopPropagation();
        dismissed.current = true;
        setTrigger(null);
        return true;
      }
    }
    // Enter sends, as before; Shift+Enter is a new line.
    if (event.key === 'Enter' && !event.shiftKey) {
      void submit();
      return true;
    }
    if ((event.metaKey || event.ctrlKey) && event.shiftKey && !event.altKey && event.key.toLowerCase() === 'u') {
      format('link');
      return true;
    }
    return false;
  };

  const onKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>): void => {
    if (event.nativeEvent.isComposing) return;
    if (sharedKey(event, open ? suggestions : null)) {
      event.preventDefault();
      return;
    }
    if (event.key === 'ArrowUp' && text === '' && editLast()) {
      event.preventDefault();
      return;
    }
    if ((event.metaKey || event.ctrlKey) && !event.altKey) {
      const key = event.key.toLowerCase();
      const kind: FormatKind | null = !event.shiftKey ? (key === 'b' ? 'bold' : key === 'i' ? 'italic' : null) : key === 'x' ? 'strike' : key === 'c' ? 'code' : null;
      if (kind) {
        event.preventDefault();
        format(kind);
      }
    }
  };

  const onRichKey = (event: globalThis.KeyboardEvent): boolean => {
    if (event.isComposing || event.keyCode === 229) return false;
    // Read the trigger from the editor now: the list on screen may be a keystroke behind.
    const at = dismissed.current ? null : richTrigger(editor.current);
    if (sharedKey(event, at ? suggest(at, channel) : null)) return true;
    if (event.key === 'Enter') {
      editor.current?.newline();
      return true;
    }
    if (event.key === 'ArrowUp' && editor.current?.isEmpty() && editLast()) return true;
    return false;
  };

  if (threadTs ? !permissions.thread : !permissions.top) {
    return <div className="notice-bar">{S.att.posting.readOnly}</div>;
  }

  // Toolbar buttons leave the caret and selection where they are.
  const keepFocus = (event: MouseEvent): void => event.preventDefault();
  const tool = (kind: FormatKind, label: string, icon: ReactNode): ReactNode => (
    <IconButton label={label} onMouseDown={keepFocus} onClick={() => format(kind)} {...(rich ? { active: formats[kind], 'aria-pressed': formats[kind] } : {})}>
      {icon}
    </IconButton>
  );

  return (
    <div className="composer-wrap" ref={root}>
      {pausedName && !threadTs ? (
        <div className="dnd-hint" role="status">
          <Moon size={14} /> <span>{S.att.dnd.theyPaused(pausedName)}</span>
          {conv?.latest_ts ? (
            <button type="button" className="link-btn" onClick={notifyLatest}>
              {S.att.dnd.notifyAnyway}
            </button>
          ) : null}
        </div>
      ) : null}
      {open && suggestions ? (
        <div className="suggest" role="listbox" id={suggestId} aria-labelledby={`${suggestId}-head`}>
          <div className="suggest-head" id={`${suggestId}-head`}>
            {suggestions.heading}
          </div>
          {suggestions.items.map((item, itemIndex) => (
            <button
              key={item.key}
              id={`${suggestId}-${itemIndex}`}
              type="button"
              tabIndex={-1}
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
        <div className="composer-tools" role="toolbar" aria-label={S.composer.formatting}>
          {tool('bold', S.composer.bold, <Bold size={16} />)}
          {tool('italic', S.composer.italic, <Italic size={16} />)}
          {tool('strike', S.composer.strike, <Strikethrough size={16} />)}
          <span className="tool-sep" />
          {tool('link', S.composer.link, <Link2 size={16} />)}
          {rich ? tool('ordered', S.composer.orderedList, <ListOrdered size={16} />) : null}
          {rich ? tool('bullet', S.composer.bulletList, <List size={16} />) : null}
          {tool('quote', S.composer.quote, <Quote size={16} />)}
          <span className="tool-sep" />
          {tool('code', S.composer.code, <Code size={16} />)}
          {tool('block', S.composer.codeBlock, <SquareCode size={16} />)}
          <AiWriteButton
            text={text}
            onReplace={(value) => {
              replaceText(value);
              focusInput();
            }}
          />
        </div>
        {!rich ? (
          <textarea
            ref={input}
            className="composer-input"
            rows={1}
            value={text}
            placeholder={placeholder}
            aria-label={placeholder}
            aria-autocomplete="list"
            aria-controls={open ? suggestId : undefined}
            aria-activedescendant={open && suggestions?.items[index] ? `${suggestId}-${index}` : undefined}
            onChange={(event) => {
              saveText(event.target.value);
              refreshTrigger(event.target.value, event.target.selectionStart);
              if (event.target.value) sendTyping(channel, threadTs);
            }}
            onKeyDown={onKeyDown}
            onPaste={onPaste}
            onClick={(event) => refreshTrigger(event.currentTarget.value, event.currentTarget.selectionStart)}
            onBlur={() => window.setTimeout(() => setTrigger(null), 120)}
          />
        ) : RichInput ? (
          <RichInput
            ref={editor}
            className="composer-input"
            label={placeholder}
            placeholder={placeholder}
            initial={initialDoc}
            autoFocus={autoFocus}
            autocomplete
            selfId={selfId}
            onChange={onRichChange}
            onSelect={refreshRich}
            onKeyDown={onRichKey}
            onFiles={addFiles}
            onBlur={() => window.setTimeout(() => setTrigger(null), 120)}
          />
        ) : (
          // The editor's chunk is still on its way (it starts loading with the app).
          <div className="composer-input-waiting" aria-hidden="true">
            {text || placeholder}
          </div>
        )}
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
          <ClipButton
            onClip={(file, transcript) => {
              if (transcript) clipTranscripts.current.set(file, transcript);
              addFiles([file]);
            }}
          />
          <IconButton ref={emojiButton} label={S.composer.emoji} onClick={() => setPicking(true)}>
            <Smile size={17} />
          </IconButton>
          <IconButton
            label={S.composer.mention}
            onMouseDown={keepFocus}
            onClick={() => {
              if (rich) {
                const before = editor.current?.context()?.text ?? '';
                editor.current?.insertText(before && !/\s$/.test(before) ? ' @' : '@');
                return;
              }
              const node = input.current;
              const caret = node?.selectionStart ?? text.length;
              const lead = caret > 0 && !/\s/.test(text[caret - 1] ?? ' ') ? ' @' : '@';
              insertAtCaret(lead);
              window.setTimeout(() => refreshTrigger(input.current?.value ?? '', input.current?.selectionStart ?? 0), 0);
            }}
          >
            <AtSign size={17} />
          </IconButton>
          <ShortcutsButton />
          {threadTs && broadcastLabel && permissions.top ? (
            <label className="composer-broadcast">
              <input type="checkbox" checked={broadcast} onChange={(event) => setBroadcast(event.target.checked)} />
              <span>{broadcastLabel}</span>
            </label>
          ) : null}
          <IconButton label={S.att.snippet.action} onClick={() => openModal({ kind: 'snippet', channel, threadTs })}>
            <FileCode2 size={17} />
          </IconButton>
          <span className="composer-spacer" />
          <span className={`send-group ${canSend ? 'is-ready' : ''}`}>
            <button type="button" className="send-btn" disabled={!canSend} onClick={() => void submit()} aria-label={S.composer.send} title={S.composer.send}>
              <SendHorizontal size={17} />
            </button>
            <button
              ref={scheduleButton}
              type="button"
              className="send-more"
              disabled={!canSend || uploads.length > 0 || text.trim().startsWith('/')}
              onClick={() => setScheduling(true)}
              aria-label={S.att.schedule.menu}
              title={S.att.schedule.menu}
            >
              <ChevronDown size={15} />
            </button>
          </span>
        </div>
      </div>
      {scheduling ? (
        <Popover anchor={scheduleButton.current} onClose={() => setScheduling(false)} side="top" align="end" className="menu">
          <div className="menu-heading">{S.att.schedule.menu}</div>
          <MenuItem icon={<Clock size={16} />} label={S.att.schedule.tomorrow9} onSelect={() => void schedule(atNine(1))} />
          <MenuItem icon={<Clock size={16} />} label={S.att.schedule.monday9} onSelect={() => void schedule(atNine(((8 - new Date().getDay()) % 7) || 7))} />
          <MenuItem icon={<CalendarClock size={16} />} label={S.att.schedule.custom} onSelect={() => void schedule('custom')} />
        </Popover>
      ) : null}
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
          onPick={(name) => {
            if (rich) editor.current?.insertNodes([{ type: 'emoji', attrs: { name } }]);
            else insertAtCaret(`:${name}: `);
          }}
        />
      ) : null}
    </div>
  );
}
