import { create } from 'zustand';
import { S } from '../strings';
import { toast } from './actions';
import { call, type Json } from './api';
import { useHuddles } from './huddles';

/**
 * Live captions in a huddle. Speech becomes text in this browser (the Web
 * Speech API), for this person's own microphone only, while captions are on
 * and the microphone is not muted. The text goes to the server, which passes
 * it to everyone in the huddle; every caption shown here, this person's
 * included, comes back as a `huddle_caption` event.
 */

export interface CaptionLine {
  key: string;
  user: string;
  text: string;
  final: boolean;
  at: number;
}

interface CaptionState {
  on: boolean;
  lines: CaptionLine[];
  /** Whether the workspace keeps captions as a transcript (shown before anyone speaks). */
  transcripts: boolean;
}

export const useCaptions = create<CaptionState>(() => ({ on: false, lines: [], transcripts: true }));
const set = useCaptions.setState;
const get = useCaptions.getState;

const SHOWN_MS = 9000;
const INTERIM_MS = 700;

export interface RecognitionResult {
  isFinal: boolean;
  0: { transcript: string };
}
export interface Recognition {
  continuous: boolean;
  interimResults: boolean;
  lang: string;
  onresult: ((event: { resultIndex: number; results: ArrayLike<RecognitionResult> }) => void) | null;
  onend: (() => void) | null;
  onerror: ((event: { error: string }) => void) | null;
  start(): void;
  stop(): void;
}
export type RecognitionCtor = new () => Recognition;

export function recognitionCtor(): RecognitionCtor | null {
  const scope = window as unknown as { SpeechRecognition?: RecognitionCtor; webkitSpeechRecognition?: RecognitionCtor };
  return scope.SpeechRecognition ?? scope.webkitSpeechRecognition ?? null;
}

export function speechSupported(): boolean {
  return recognitionCtor() !== null;
}

let recognizer: Recognition | null = null;
let channel: string | null = null;
let lastInterim = 0;
let pruneTimer: number | null = null;

function send(text: string, final: boolean): void {
  if (!channel) return;
  void call('client.huddles.caption', { channel, text, final }).catch(() => undefined);
}

function shouldListen(): boolean {
  const huddles = useHuddles.getState();
  return get().on && huddles.current !== null && huddles.mic;
}

function startListening(): void {
  const Ctor = recognitionCtor();
  if (!Ctor || recognizer) return;
  const current = useHuddles.getState().current;
  if (!current) return;
  channel = current.channel;
  const next = new Ctor();
  next.continuous = true;
  next.interimResults = true;
  next.lang = navigator.language || 'en-US';
  next.onresult = (event) => {
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]!;
      const text = result[0].transcript.trim();
      if (!text) continue;
      if (result.isFinal) {
        lastInterim = 0;
        send(text, true);
      } else if (Date.now() - lastInterim >= INTERIM_MS) {
        lastInterim = Date.now();
        send(text, false);
      }
    }
  };
  next.onerror = (event) => {
    if (event.error === 'not-allowed' || event.error === 'service-not-allowed') {
      toast(S.huddles.captionsBlocked, 'error');
      stopListening();
    }
  };
  // Recognition stops on its own after a pause; keep it going while it should.
  next.onend = () => {
    if (recognizer !== next) return;
    if (shouldListen()) {
      try {
        next.start();
        return;
      } catch {
        // started again elsewhere
      }
    }
    recognizer = null;
  };
  recognizer = next;
  try {
    next.start();
  } catch {
    recognizer = null;
  }
}

function stopListening(): void {
  const stopping = recognizer;
  recognizer = null;
  stopping?.stop();
}

function sync(): void {
  if (shouldListen()) startListening();
  else stopListening();
}

// Muting, unmuting and leaving decide whether this browser listens.
let watching = false;
function watchHuddle(): void {
  if (watching) return;
  watching = true;
  useHuddles.subscribe((state, previous) => {
    if (state.mic === previous.mic && state.current?.channel === previous.current?.channel) return;
    if (state.current?.channel !== previous.current?.channel) set({ lines: [] });
    if (!state.current) set({ on: false });
    sync();
  });
}

export async function toggleCaptions(): Promise<void> {
  watchHuddle();
  const on = !get().on;
  set({ on, lines: on ? get().lines : [] });
  if (on) {
    pruneTimer ??= window.setInterval(() => {
      const cutoff = Date.now() - SHOWN_MS;
      const lines = get().lines.filter((line) => line.at >= cutoff);
      if (lines.length !== get().lines.length) set({ lines });
    }, 1000);
    void call('client.huddles.info')
      .then((info) => {
        const transcripts = info.transcripts !== false;
        set({ transcripts });
        toast(transcripts ? S.huddles.captionsOnKept : S.huddles.captionsOnLive);
      })
      .catch(() => undefined);
  } else if (pruneTimer !== null) {
    window.clearInterval(pruneTimer);
    pruneTimer = null;
  }
  sync();
}

/** Realtime events for captions. Returns true when it handled one. */
export function handleCaptionEvent(event: Json): boolean {
  if (event.type !== 'huddle_caption') return false;
  if (!get().on || useHuddles.getState().current?.channel !== event.channel) return true;
  set((state) => {
    // A person's words in progress are replaced by their next words.
    const lines = state.lines.filter((line) => line.final || line.user !== event.user);
    lines.push({ key: `${event.user}:${event.event_ts}`, user: String(event.user), text: String(event.text), final: Boolean(event.final), at: Date.now() });
    return { lines: lines.slice(-6) };
  });
  return true;
}
