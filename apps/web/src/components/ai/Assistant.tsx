import { Sparkles, X } from 'lucide-react';
import { useEffect, useState } from 'react';
import { attempt, openDirect, toast } from '../../lib/actions';
import { useAiFeature } from '../../lib/ai';
import { call } from '../../lib/api';
import { S } from '../../strings';
import { confirmDialog } from '../dialogs/confirm';
import { Button, IconButton, Spinner } from '../ui';

/** Sidebar entry: opens the direct message with the built-in assistant. */
export function AssistantNavItem() {
  const enabled = useAiFeature('assistant');
  if (!enabled) return null;
  return (
    <a
      href="/assistant"
      className="side-item side-nav"
      data-view="assistant"
      onClick={(event) => {
        event.preventDefault();
        void attempt(() => call('client.assistant.open')).then((result) => {
          if (result) void openDirect([result.bot_id as string]);
        });
      }}
    >
      <span className="side-icon">
        <Sparkles size={16} />
      </span>
      <span className="side-name">{S.assistant.nav}</span>
    </a>
  );
}

interface Memory {
  id: string;
  text: string;
  created: number;
}

/** Preferences: what the assistant remembers about you, and nobody else can see. */
export function AssistantMemoryPref() {
  const enabled = useAiFeature('assistant');
  const [memories, setMemories] = useState<Memory[] | null>(null);
  const [text, setText] = useState('');
  useEffect(() => {
    if (!enabled) return;
    call('client.assistant.memories.list')
      .then((result) => setMemories(result.memories as Memory[]))
      .catch(() => setMemories([]));
  }, [enabled]);
  if (!enabled) return null;
  const add = async (): Promise<void> => {
    const result = await attempt(() => call('client.assistant.memories.add', { text }));
    if (!result) return;
    setMemories([...(memories ?? []), result.memory as Memory]);
    setText('');
  };
  const forget = async (id: string): Promise<void> => {
    if (await attempt(() => call('client.assistant.memories.delete', { id }))) setMemories((memories ?? []).filter((memory) => memory.id !== id));
  };
  const clear = async (): Promise<void> => {
    if (!(await confirmDialog(S.assistant.confirmClear, S.assistant.clear))) return;
    if (await attempt(() => call('client.assistant.memories.clear'))) {
      setMemories([]);
      toast(S.assistant.cleared);
    }
  };
  return (
    <fieldset className="pref-group assistant-memory">
      <legend>{S.assistant.memoryTitle}</legend>
      <p className="muted">{S.assistant.memoryHint}</p>
      {memories === null ? (
        <Spinner />
      ) : memories.length ? (
        <ul className="memory-list">
          {memories.map((memory) => (
            <li key={memory.id}>
              <span>{memory.text}</span>
              <IconButton label={S.assistant.forget(memory.text)} onClick={() => void forget(memory.id)}>
                <X size={15} />
              </IconButton>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">{S.assistant.empty}</p>
      )}
      <form
        className="memory-add"
        onSubmit={(event) => {
          event.preventDefault();
          if (text.trim()) void add();
        }}
      >
        <input type="text" value={text} maxLength={300} aria-label={S.assistant.addLabel} placeholder={S.assistant.addPlaceholder} onChange={(event) => setText(event.target.value)} />
        <Button type="submit" disabled={!text.trim()}>
          {S.assistant.add}
        </Button>
      </form>
      {memories?.length ? (
        <button type="button" className="link-btn pref-link" onClick={() => void clear()}>
          {S.assistant.clear}
        </button>
      ) : null}
    </fieldset>
  );
}
