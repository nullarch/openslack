import { useState } from 'react';
import { attempt, toast } from '../../lib/actions';
import { call } from '../../lib/api';
import { S } from '../../strings';
import { Button, Field } from '../ui';

interface WithFunctions {
  id: string;
  functions?: unknown[];
}

/** The workflow steps an app provides (Slack's function definitions), on its admin screen. */
export function AppStepsSetting({ app, onChanged }: { app: WithFunctions; onChanged: () => void }) {
  const [text, setText] = useState(() => JSON.stringify(app.functions ?? [], null, 2));
  const [invalid, setInvalid] = useState(false);
  const save = async (): Promise<void> => {
    let functions: unknown;
    try {
      functions = JSON.parse(text || '[]');
    } catch {
      setInvalid(true);
      return;
    }
    setInvalid(false);
    const result = await attempt(() => call('client.apps.update', { app: app.id, functions }));
    if (!result) return;
    setText(JSON.stringify(result.app?.functions ?? [], null, 2));
    toast(S.saved);
    onChanged();
  };
  return (
    <div className="app-steps-setting">
      <h3 className="dialog-sub">{S.wf.stepTypesTitle}</h3>
      <p className="muted">{S.wf.stepTypesHint}</p>
      <Field label="functions" error={invalid ? S.errors.invalid_functions : undefined}>
        <textarea className="mono-input" rows={6} spellCheck={false} value={text} onChange={(event) => setText(event.target.value)} />
      </Field>
      <Button onClick={() => void save()}>{S.save}</Button>
    </div>
  );
}
