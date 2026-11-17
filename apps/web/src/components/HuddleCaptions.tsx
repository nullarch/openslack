import { Captions, CaptionsOff } from 'lucide-react';
import { speechSupported, toggleCaptions, useCaptions } from '../lib/captions';
import { displayName, useStore } from '../lib/store';
import { S } from '../strings';
import { IconButton } from './ui';

export function CaptionsButton({ size }: { size: number }) {
  const on = useCaptions((state) => state.on);
  return (
    <IconButton label={on ? S.huddles.captionsOff : S.huddles.captionsOn} active={on} onClick={() => void toggleCaptions()} data-control="captions">
      {on ? <Captions size={size} /> : <CaptionsOff size={size} />}
    </IconButton>
  );
}

function Line({ user, text, final }: { user: string; text: string; final: boolean }) {
  const name = useStore((state) => displayName(state.users[user]));
  return (
    <p className={`huddle-caption ${final ? '' : 'is-interim'}`}>
      <strong>{name}</strong> {text}
    </p>
  );
}

/** The latest captions, over the stage or under the dock. */
export function CaptionsOverlay({ compact = false }: { compact?: boolean }) {
  const on = useCaptions((state) => state.on);
  const lines = useCaptions((state) => state.lines);
  const transcripts = useCaptions((state) => state.transcripts);
  if (!on) return null;
  const shown = lines.slice(compact ? -1 : -3);
  return (
    <div className={`huddle-captions ${compact ? 'is-compact' : ''}`} data-huddle-captions>
      <div role="log" aria-live="polite" aria-label={S.huddles.captionsLabel}>
        {shown.map((line) => (
          <Line key={line.key} user={line.user} text={line.text} final={line.final} />
        ))}
      </div>
      {!compact && !shown.length ? (
        <p className="huddle-caption-note">
          {speechSupported() ? S.huddles.captionsListening : S.huddles.captionsUnsupported}
          {transcripts ? ` ${S.huddles.captionsKept}` : ''}
        </p>
      ) : null}
    </div>
  );
}
