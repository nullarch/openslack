import { recognitionCtor, type Recognition } from './captions';

/**
 * Recording a clip: the microphone, the camera or the screen, through
 * MediaRecorder, with captions made at the same time from the microphone by
 * the browser's speech recognition (where there is one). Nothing leaves the
 * browser until the person sends the clip.
 */

export type ClipKind = 'audio' | 'video' | 'screen';

export const MAX_CLIP_MS = 5 * 60_000;

interface Cue {
  start: number;
  end: number;
  text: string;
}

export interface Clip {
  file: File;
  url: string;
  transcript: { vtt: string; locale: string } | null;
  words: string;
}

function pickType(kind: ClipKind): { mime: string; ext: string } {
  const candidates =
    kind === 'audio'
      ? [
          { mime: 'audio/webm;codecs=opus', ext: 'weba' },
          { mime: 'audio/webm', ext: 'weba' },
          { mime: 'audio/mp4', ext: 'm4a' },
        ]
      : [
          { mime: 'video/webm;codecs=vp9,opus', ext: 'webm' },
          { mime: 'video/webm', ext: 'webm' },
          { mime: 'video/mp4', ext: 'mp4' },
        ];
  return candidates.find((candidate) => MediaRecorder.isTypeSupported(candidate.mime)) ?? candidates[candidates.length - 1]!;
}

function stamp(ms: number): string {
  const total = Math.max(0, Math.round(ms));
  const h = Math.floor(total / 3_600_000);
  const m = Math.floor((total % 3_600_000) / 60_000);
  const s = Math.floor((total % 60_000) / 1000);
  const rest = total % 1000;
  const pad = (n: number, width = 2): string => String(n).padStart(width, '0');
  return `${h ? `${pad(h)}:` : ''}${pad(m)}:${pad(s)}.${pad(rest, 3)}`;
}

export function toVtt(cues: Cue[]): string {
  return `WEBVTT\n\n${cues.map((cue) => `${stamp(cue.start)} --> ${stamp(Math.max(cue.end, cue.start + 500))}\n${cue.text.replace(/-->/g, '→')}`).join('\n\n')}\n`;
}

/** A file name people can read: "Video clip 2026-11-17 18.03.webm". */
function clipName(label: string, ext: string): string {
  const now = new Date();
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${label} ${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}.${pad(now.getMinutes())}.${ext}`;
}

export class ClipRecording {
  readonly kind: ClipKind;
  readonly stream: MediaStream;
  private readonly extra: MediaStream[];
  private readonly recorder: MediaRecorder;
  private readonly type: { mime: string; ext: string };
  private readonly chunks: Blob[] = [];
  private readonly cues: Cue[] = [];
  private recognition: Recognition | null = null;
  private phraseStart = new Map<number, number>();
  private listening = false;
  started = 0;

  private constructor(kind: ClipKind, stream: MediaStream, extra: MediaStream[]) {
    this.kind = kind;
    this.stream = stream;
    this.extra = extra;
    this.type = pickType(kind);
    this.recorder = new MediaRecorder(stream, MediaRecorder.isTypeSupported(this.type.mime) ? { mimeType: this.type.mime } : undefined);
    this.recorder.ondataavailable = (event) => {
      if (event.data.size) this.chunks.push(event.data);
    };
  }

  /** Ask for the devices; throws when the person or the browser says no. */
  static async open(kind: ClipKind): Promise<ClipRecording> {
    if (kind === 'audio') return new ClipRecording(kind, await navigator.mediaDevices.getUserMedia({ audio: true }), []);
    if (kind === 'video') {
      return new ClipRecording(kind, await navigator.mediaDevices.getUserMedia({ audio: true, video: { width: { ideal: 1280 }, height: { ideal: 720 } } }), []);
    }
    const display = await navigator.mediaDevices.getDisplayMedia({ video: true, audio: true });
    let mic: MediaStream | null = null;
    try {
      mic = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch {
      // The screen alone, with its own sound if it has any.
    }
    const tracks = [...display.getVideoTracks(), ...(mic ? mic.getAudioTracks() : display.getAudioTracks())];
    return new ClipRecording(kind, new MediaStream(tracks), [display, ...(mic ? [mic] : [])]);
  }

  get hasCaptions(): boolean {
    return recognitionCtor() !== null && this.stream.getAudioTracks().length > 0;
  }

  start(onEnded: () => void): void {
    this.started = performance.now();
    this.recorder.start(1000);
    // Stopping the screen share from the browser's own bar ends the clip.
    for (const track of this.stream.getVideoTracks()) track.addEventListener('ended', onEnded);
    this.listen();
  }

  elapsed(): number {
    return this.started ? performance.now() - this.started : 0;
  }

  private listen(): void {
    const Ctor = recognitionCtor();
    if (!Ctor || this.stream.getAudioTracks().length === 0) return;
    const recognition = new Ctor();
    recognition.continuous = true;
    recognition.interimResults = true;
    recognition.lang = navigator.language || 'en-US';
    this.phraseStart = new Map();
    recognition.onresult = (event) => {
      const now = this.elapsed();
      for (let index = event.resultIndex; index < event.results.length; index += 1) {
        const result = event.results[index]!;
        if (!this.phraseStart.has(index)) this.phraseStart.set(index, Math.max(0, now - 1500));
        if (!result.isFinal) continue;
        const text = result[0].transcript.trim();
        if (text) this.cues.push({ start: this.phraseStart.get(index)!, end: now, text });
      }
    };
    recognition.onend = () => {
      if (this.listening && this.recognition === recognition) {
        this.phraseStart = new Map();
        try {
          recognition.start();
        } catch {
          this.recognition = null;
        }
      }
    };
    recognition.onerror = () => undefined;
    this.recognition = recognition;
    this.listening = true;
    try {
      recognition.start();
    } catch {
      this.recognition = null;
    }
  }

  private release(): void {
    this.listening = false;
    this.recognition?.stop();
    this.recognition = null;
    for (const stream of [this.stream, ...this.extra]) for (const track of stream.getTracks()) track.stop();
  }

  /** Stop and hand back the clip. */
  async finish(labels: Record<ClipKind, string>): Promise<Clip> {
    const stopped = new Promise<void>((resolve) => {
      this.recorder.onstop = () => resolve();
    });
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    // Let the recognizer deliver its last words.
    await new Promise((resolve) => setTimeout(resolve, 300));
    this.release();
    await stopped;
    const blob = new Blob(this.chunks, { type: this.type.mime.split(';')[0] });
    const file = new File([blob], clipName(labels[this.kind], this.type.ext), { type: blob.type });
    const cues = this.cues.slice().sort((a, b) => a.start - b.start);
    return {
      file,
      url: URL.createObjectURL(blob),
      transcript: cues.length ? { vtt: toVtt(cues), locale: navigator.language || 'en-US' } : null,
      words: cues.map((cue) => cue.text).join(' '),
    };
  }

  cancel(): void {
    if (this.recorder.state !== 'inactive') this.recorder.stop();
    this.release();
  }
}
