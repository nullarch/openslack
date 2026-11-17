import { create } from 'zustand';

/**
 * Drawing on a shared screen: anyone in the huddle marks up what is being
 * shared, everyone (the person sharing included) sees the marks on that
 * screen, and they fade after a few seconds. Points are fractions of the
 * shared picture, so they land in the same place whatever the window size.
 * Marks travel over the call's data channel and are never stored.
 */

export interface Stroke {
  id: string;
  author: string;
  color: string;
  points: [number, number][];
  done: boolean;
  at: number;
}

interface DrawingState {
  /** Strokes by the identity of the person whose screen they are on. */
  strokes: Record<string, Stroke[]>;
  /** The screen this person is drawing on, if any. */
  drawingOn: string | null;
}

export const useDrawing = create<DrawingState>(() => ({ strokes: {}, drawingOn: null }));
const set = useDrawing.setState;
const get = useDrawing.getState;

const FADE_MS = 4000;
const SEND_MS = 40;
const COLORS = ['#e5484d', '#2a78d6', '#1baf7a', '#eb6834', '#8e4ec6', '#d6409f'];

export function colorFor(identity: string): string {
  let hash = 0;
  for (const char of identity) hash = (hash * 31 + char.charCodeAt(0)) >>> 0;
  return COLORS[hash % COLORS.length]!;
}

type Send = (message: unknown) => void;
let send: Send = () => undefined;
/** Wired by the media module once connected. */
export function setDrawingTransport(next: Send): void {
  send = next;
}

function upsert(sharer: string, stroke: Stroke): void {
  set((state) => {
    const list = (state.strokes[sharer] ?? []).filter((item) => item.id !== stroke.id);
    return { strokes: { ...state.strokes, [sharer]: [...list, stroke].slice(-50) } };
  });
  if (stroke.done) {
    window.setTimeout(() => {
      set((state) => ({ strokes: { ...state.strokes, [sharer]: (state.strokes[sharer] ?? []).filter((item) => item.id !== stroke.id) } }));
    }, FADE_MS);
  }
}

export function setDrawingOn(sharer: string | null): void {
  set({ drawingOn: sharer });
}

let current: { sharer: string; stroke: Stroke; pending: [number, number][]; timer: number | null } | null = null;

function flush(): void {
  if (!current) return;
  current.timer = null;
  const { sharer, stroke, pending } = current;
  if (!pending.length && !stroke.done) return;
  send({ sharer, id: stroke.id, color: stroke.color, points: pending, done: stroke.done });
  current.pending = [];
}

export function startStroke(sharer: string, self: string, point: [number, number]): void {
  const stroke: Stroke = { id: `${self}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`, author: self, color: colorFor(self), points: [point], done: false, at: Date.now() };
  current = { sharer, stroke, pending: [point], timer: null };
  upsert(sharer, stroke);
  flush();
}

export function extendStroke(point: [number, number]): void {
  if (!current) return;
  current.stroke = { ...current.stroke, points: [...current.stroke.points, point].slice(-2000) };
  current.pending.push(point);
  upsert(current.sharer, current.stroke);
  current.timer ??= window.setTimeout(flush, SEND_MS);
}

export function endStroke(): void {
  if (!current) return;
  if (current.timer) window.clearTimeout(current.timer);
  current.stroke = { ...current.stroke, done: true };
  upsert(current.sharer, current.stroke);
  flush();
  current = null;
}

/** A piece of someone else's stroke arrived. */
export function receiveStroke(author: string, message: unknown): void {
  if (!message || typeof message !== 'object') return;
  const data = message as { sharer?: unknown; id?: unknown; color?: unknown; points?: unknown; done?: unknown };
  if (typeof data.sharer !== 'string' || typeof data.id !== 'string' || !Array.isArray(data.points)) return;
  const points = (data.points as unknown[])
    .filter((point): point is [number, number] => Array.isArray(point) && point.length === 2 && point.every((value) => typeof value === 'number' && value >= 0 && value <= 1))
    .slice(0, 500);
  const existing = (get().strokes[data.sharer] ?? []).find((item) => item.id === data.id);
  const color = typeof data.color === 'string' && /^#[0-9a-f]{6}$/i.test(data.color) ? data.color : colorFor(author);
  upsert(data.sharer, {
    id: data.id.slice(0, 80),
    author,
    color,
    points: [...(existing?.points ?? []), ...points].slice(-2000),
    done: data.done === true,
    at: existing?.at ?? Date.now(),
  });
}

/** Everything goes when the call ends. */
export function clearDrawings(): void {
  current = null;
  set({ strokes: {}, drawingOn: null });
}
