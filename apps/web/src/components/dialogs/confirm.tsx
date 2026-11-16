import { useState } from 'react';
import { create } from 'zustand';
import { S } from '../../strings';
import { Button, Field, Modal } from '../ui';

interface ConfirmRequest {
  kind: 'confirm';
  title: string;
  text: string;
  confirmLabel: string;
  resolve: (ok: boolean) => void;
}

interface PromptRequest {
  kind: 'prompt';
  title: string;
  label: string;
  initial: string;
  placeholder: string;
  confirmLabel: string;
  multiline: boolean;
  resolve: (value: string | null) => void;
}

const useRequest = create<{ request: ConfirmRequest | PromptRequest | null }>(() => ({ request: null }));

/** Ask before a destructive action. Resolves true when confirmed. */
export function confirmDialog(text: string, confirmLabel: string, title = confirmLabel): Promise<boolean> {
  return new Promise((resolve) => useRequest.setState({ request: { kind: 'confirm', title, text, confirmLabel, resolve } }));
}

export interface PromptOptions {
  title: string;
  label: string;
  initial?: string;
  placeholder?: string;
  confirmLabel?: string;
  multiline?: boolean;
}

/** Ask for one line (or paragraph) of text. Resolves null when cancelled. */
export function promptDialog(options: PromptOptions): Promise<string | null> {
  return new Promise((resolve) =>
    useRequest.setState({
      request: {
        kind: 'prompt',
        title: options.title,
        label: options.label,
        initial: options.initial ?? '',
        placeholder: options.placeholder ?? '',
        confirmLabel: options.confirmLabel ?? S.save,
        multiline: options.multiline ?? false,
        resolve,
      },
    }),
  );
}

function PromptBody({ request }: { request: PromptRequest }) {
  const [value, setValue] = useState(request.initial);
  const finish = (result: string | null): void => {
    useRequest.setState({ request: null });
    request.resolve(result);
  };
  return (
    <Modal
      title={request.title}
      width={440}
      onClose={() => finish(null)}
      footer={
        <>
          <Button onClick={() => finish(null)}>{S.cancel}</Button>
          <Button variant="primary" onClick={() => finish(value)}>
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <form
        onSubmit={(event) => {
          event.preventDefault();
          finish(value);
        }}
      >
        <Field label={request.label}>
          {request.multiline ? (
            <textarea value={value} rows={3} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} data-autofocus />
          ) : (
            <input value={value} placeholder={request.placeholder} onChange={(event) => setValue(event.target.value)} data-autofocus />
          )}
        </Field>
      </form>
    </Modal>
  );
}

/** Mount once at the app root. */
export function DialogHost() {
  const request = useRequest((state) => state.request);
  if (!request) return null;
  if (request.kind === 'prompt') return <PromptBody key={request.title + request.label} request={request} />;
  const finish = (ok: boolean): void => {
    useRequest.setState({ request: null });
    request.resolve(ok);
  };
  return (
    <Modal
      title={request.title}
      width={420}
      onClose={() => finish(false)}
      footer={
        <>
          <Button onClick={() => finish(false)}>{S.cancel}</Button>
          <Button variant="danger" onClick={() => finish(true)} data-autofocus>
            {request.confirmLabel}
          </Button>
        </>
      }
    >
      <p className="confirm-text">{request.text}</p>
    </Modal>
  );
}
