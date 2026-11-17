import { Clapperboard, Mic, MonitorUp, Video } from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { ClipRecording, MAX_CLIP_MS, type Clip, type ClipKind } from '../lib/clips';
import { S } from '../strings';
import { Button, IconButton, MenuItem, Modal, Popover, Spinner } from './ui';

function clock(ms: number): string {
  const seconds = Math.floor(ms / 1000);
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, '0')}`;
}

type Phase = 'asking' | 'recording' | 'review' | 'error';

function ClipRecorder({ kind, onClose, onUse }: { kind: ClipKind; onClose: () => void; onUse: (clip: Clip) => void }) {
  const [phase, setPhase] = useState<Phase>('asking');
  const [error, setError] = useState('');
  const [clip, setClip] = useState<Clip | null>(null);
  const [elapsed, setElapsed] = useState(0);
  const [captions, setCaptions] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const recording = useRef<ClipRecording | null>(null);
  const preview = useRef<HTMLVideoElement>(null);

  const stop = async (): Promise<void> => {
    const current = recording.current;
    if (!current) return;
    recording.current = null;
    const done = await current.finish(S.clips.fileLabels);
    setClip(done);
    setPhase('review');
  };
  const stopRef = useRef(stop);
  stopRef.current = stop;

  useEffect(() => {
    let cancelled = false;
    setPhase('asking');
    ClipRecording.open(kind)
      .then((opened) => {
        if (cancelled) {
          opened.cancel();
          return;
        }
        recording.current = opened;
        setCaptions(opened.hasCaptions);
        opened.start(() => void stopRef.current());
        setPhase('recording');
      })
      .catch((reason: unknown) => {
        if (cancelled) return;
        setError(reason instanceof DOMException && reason.name === 'NotAllowedError' ? S.clips.denied : S.clips.failed);
        setPhase('error');
      });
    return () => {
      cancelled = true;
      recording.current?.cancel();
      recording.current = null;
    };
  }, [kind, attempt]);

  useEffect(() => {
    if (phase === 'recording' && preview.current && recording.current) preview.current.srcObject = recording.current.stream;
    if (phase !== 'recording') return;
    const timer = window.setInterval(() => {
      const ms = recording.current?.elapsed() ?? 0;
      setElapsed(ms);
      if (ms >= MAX_CLIP_MS) void stopRef.current();
    }, 250);
    return () => window.clearInterval(timer);
  }, [phase]);

  // The recorded clip's address lives until the dialog closes.
  useEffect(() => () => {
    if (clip) URL.revokeObjectURL(clip.url);
  }, [clip]);

  const again = (): void => {
    setClip(null);
    setElapsed(0);
    setAttempt((n) => n + 1);
  };

  let body;
  let footer;
  if (phase === 'asking') {
    body = <Spinner label={kind === 'screen' ? S.clips.askingScreen : kind === 'video' ? S.clips.askingCamera : S.clips.askingMic} />;
    footer = <Button onClick={onClose}>{S.cancel}</Button>;
  } else if (phase === 'recording') {
    body = (
      <>
        {kind === 'audio' ? (
          <div className="clip-audio">
            <Mic size={32} />
          </div>
        ) : (
          <video ref={preview} className={`clip-video ${kind === 'video' ? 'is-mirrored' : ''}`} autoPlay muted playsInline />
        )}
        <p className="clip-status" role="timer" aria-live="off">
          <span className="clip-dot" aria-hidden="true" /> {S.clips.recording} {clock(elapsed)} / {clock(MAX_CLIP_MS)}
        </p>
        <p className="field-hint">{captions ? S.clips.captioning : S.clips.noCaptions}</p>
      </>
    );
    footer = (
      <>
        <Button onClick={onClose}>{S.cancel}</Button>
        <Button variant="primary" onClick={() => void stop()} data-clip-stop>
          {S.clips.stop}
        </Button>
      </>
    );
  } else if (phase === 'review' && clip) {
    body = (
      <>
        {kind === 'audio' ? <audio className="clip-audio-player" controls src={clip.url} /> : <video className="clip-video" controls playsInline src={clip.url} />}
        {clip.words ? (
          <p className="clip-words">
            <strong>{S.clips.transcript}</strong> {clip.words}
          </p>
        ) : null}
      </>
    );
    footer = (
      <>
        <Button onClick={again}>{S.clips.again}</Button>
        <Button variant="primary" onClick={() => onUse(clip)} data-clip-use>
          {S.clips.use}
        </Button>
      </>
    );
  } else {
    body = <p className="notice">{error}</p>;
    footer = (
      <>
        <Button onClick={onClose}>{S.close}</Button>
        <Button variant="primary" onClick={again}>
          {S.clips.retry}
        </Button>
      </>
    );
  }
  return (
    <Modal title={S.clips.title[kind]} onClose={onClose} width={560} className="clip-recorder" footer={footer}>
      {body}
    </Modal>
  );
}

/** The composer's "Record a clip" button and its dialog. */
export function ClipButton({ onClip }: { onClip: (file: File, transcript: Clip['transcript']) => void }) {
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const [kind, setKind] = useState<ClipKind | null>(null);
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) return null;
  const canShare = typeof navigator.mediaDevices.getDisplayMedia === 'function';
  const choose = (next: ClipKind) => () => {
    setAnchor(null);
    setKind(next);
  };
  return (
    <>
      <IconButton label={S.clips.record} onClick={(event) => setAnchor(event.currentTarget)} data-clip-button>
        <Clapperboard size={17} />
      </IconButton>
      {anchor ? (
        <Popover anchor={anchor} onClose={() => setAnchor(null)} side="top" className="menu">
          <MenuItem icon={<Mic size={16} />} label={S.clips.title.audio} onSelect={choose('audio')} />
          <MenuItem icon={<Video size={16} />} label={S.clips.title.video} onSelect={choose('video')} />
          {canShare ? <MenuItem icon={<MonitorUp size={16} />} label={S.clips.title.screen} onSelect={choose('screen')} /> : null}
        </Popover>
      ) : null}
      {kind ? (
        <ClipRecorder
          kind={kind}
          onClose={() => setKind(null)}
          onUse={(clip) => {
            onClip(clip.file, clip.transcript);
            setKind(null);
          }}
        />
      ) : null}
    </>
  );
}
