import { useEffect, useState } from 'react';
import { call } from '../../lib/api';
import { S } from '../../strings';

export interface ChannelTemplateInfo {
  id: string;
  name: string;
  description: string;
  includes: string[];
}

/** Pick what a new channel starts with (client.channels.templates.list); null is a blank channel. */
export function ChannelTemplatePicker({ value, onChange }: { value: string | null; onChange: (id: string | null) => void }) {
  const [templates, setTemplates] = useState<ChannelTemplateInfo[]>([]);
  useEffect(() => {
    call('client.channels.templates.list')
      .then((result) => setTemplates(result.templates as ChannelTemplateInfo[]))
      .catch(() => setTemplates([]));
  }, []);
  if (templates.length === 0) return null;
  return (
    <fieldset className="template-picker">
      <legend className="field-label">{S.channelTemplates.title}</legend>
      <div className="template-options" role="radiogroup" aria-label={S.channelTemplates.title}>
        <button type="button" role="radio" aria-checked={value === null} className={`template-option ${value === null ? 'is-active' : ''}`} onClick={() => onChange(null)}>
          <strong>{S.channelTemplates.blank}</strong>
          <span className="muted">{S.channelTemplates.blankHint}</span>
        </button>
        {templates.map((template) => (
          <button key={template.id} type="button" role="radio" aria-checked={value === template.id} className={`template-option ${value === template.id ? 'is-active' : ''}`} onClick={() => onChange(template.id)}>
            <strong>{S.channelTemplates.names[template.id] ?? template.name}</strong>
            <span className="muted">{S.channelTemplates.descriptions[template.id] ?? template.description}</span>
          </button>
        ))}
      </div>
    </fieldset>
  );
}
