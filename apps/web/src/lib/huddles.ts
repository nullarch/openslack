import type { Huddle } from '@app/shared';
import { create } from 'zustand';
import { errorText, toast } from './actions';
import { call, type Json } from './api';
import { get as getApp } from './store';

/**
 * Huddles on the client: which conversations have one running (from
 * `client.huddles.info` and `huddle_changed` events) and the call this tab is
 * in. The media side lives in `huddleMedia.ts`, loaded only when joining, so
 * the LiveKit client stays out of the main bundle.
 */

export interface Tile {
  identity: string;
  name: string;
  isLocal: boolean;
  speaking: boolean;
  mic: boolean;
  camera: boolean;
  screen: boolean;
}

export interface FloatingReaction {
  id: number;
  emoji: string;
  identity: string;
  /** 0–1, where across the stage it rises. */
  x: number;
}

export interface DeviceList {
  audioinput: { deviceId: string; label: string }[];
  videoinput: { deviceId: string; label: string }[];
  audiooutput: { deviceId: string; label: string }[];
}

export interface HuddleState {
  enabled: boolean;
  /** Running huddles by conversation id. */
  active: Record<string, Huddle>;
  /** The huddle this tab is in. */
  current: { channel: string; status: 'connecting' | 'connected' | 'reconnecting' } | null;
  tiles: Tile[];
  mic: boolean;
  camera: boolean;
  screen: boolean;
  expanded: boolean;
  reactions: FloatingReaction[];
  devices: DeviceList;
  selected: { audioinput?: string; videoinput?: string; audiooutput?: string };
  /** Bumped when tracks change, so video elements re-attach. */
  trackVersion: number;
}

export const useHuddles = create<HuddleState>(() => ({
  enabled: false,
  active: {},
  current: null,
  tiles: [],
  mic: true,
  camera: false,
  screen: false,
  expanded: false,
  reactions: [],
  devices: { audioinput: [], videoinput: [], audiooutput: [] },
  selected: {},
  trackVersion: 0,
}));

const set = useHuddles.setState;
const get = useHuddles.getState;

/** The media controller, once loaded. */
type Media = typeof import('./huddleMedia');
let media: Media | null = null;
async function loadMedia(): Promise<Media> {
  media ??= await import('./huddleMedia');
  return media;
}
export function mediaIfLoaded(): Media | null {
  return media;
}

/** Load what is running now; called after every (re)connection. */
export async function refreshHuddles(): Promise<void> {
  try {
    const result = await call('client.huddles.info');
    const active: Record<string, Huddle> = {};
    for (const huddle of result.huddles as Huddle[]) active[huddle.channel] = huddle;
    set({ enabled: Boolean(result.enabled), active });
  } catch {
    // An older server without huddles: leave them off.
  }
}

/** Realtime events this module understands. Returns true when it handled one. */
export function handleHuddleEvent(event: Json): boolean {
  if (event.type !== 'huddle_changed') return false;
  const huddle = event.huddle as Huddle;
  set((state) => {
    const active = { ...state.active };
    if (huddle.has_ended) delete active[huddle.channel];
    else active[huddle.channel] = huddle;
    return { active };
  });
  return true;
}

export function huddleIn(channel: string): Huddle | undefined {
  return get().active[channel];
}

export async function joinHuddle(channel: string): Promise<void> {
  const current = get().current;
  if (current?.channel === channel) {
    set({ expanded: true });
    return;
  }
  if (current) await leaveHuddle();
  set({ current: { channel, status: 'connecting' }, mic: true, camera: false, screen: false, tiles: [], reactions: [] });
  try {
    const [joined, controller] = await Promise.all([call('client.huddles.join', { channel }), loadMedia()]);
    handleHuddleEvent({ type: 'huddle_changed', huddle: joined.huddle });
    await controller.connect(joined.url, joined.token, channel);
  } catch (error) {
    set({ current: null, tiles: [] });
    toast(errorText(error), 'error');
    await call('client.huddles.leave', { channel }).catch(() => undefined);
  }
}

export async function leaveHuddle(): Promise<void> {
  const current = get().current;
  if (!current) return;
  set({ current: null, tiles: [], expanded: false, reactions: [], screen: false, camera: false });
  await media?.disconnect();
  await call('client.huddles.leave', { channel: current.channel }).catch(() => undefined);
}

export async function toggleMic(): Promise<void> {
  const next = !get().mic;
  set({ mic: next });
  await media?.setMic(next);
}

export async function toggleCamera(): Promise<void> {
  const next = !get().camera;
  set({ camera: next });
  try {
    await media?.setCamera(next);
  } catch (error) {
    set({ camera: !next });
    toast(errorText(error), 'error');
  }
}

export async function toggleScreen(): Promise<void> {
  const next = !get().screen;
  set({ screen: next });
  try {
    await media?.setScreen(next);
  } catch {
    // The person closed the picker, or the browser refused.
    set({ screen: false });
  }
}

let reactionId = 0;
/** Show a reaction on everyone's stage, this tab's included. */
export function showReaction(emoji: string, identity: string): void {
  const id = ++reactionId;
  set((state) => ({ reactions: [...state.reactions, { id, emoji, identity, x: 0.15 + Math.random() * 0.7 }] }));
  window.setTimeout(() => set((state) => ({ reactions: state.reactions.filter((reaction) => reaction.id !== id) })), 2600);
}

export async function sendReaction(emoji: string): Promise<void> {
  const self = getApp().self?.id ?? '';
  showReaction(emoji, self);
  await media?.sendReaction(emoji);
}

export async function chooseDevice(kind: keyof DeviceList, deviceId: string): Promise<void> {
  set((state) => ({ selected: { ...state.selected, [kind]: deviceId } }));
  await media?.switchDevice(kind, deviceId);
}

export function setExpanded(expanded: boolean): void {
  set({ expanded });
}

/** Internal: the media controller reports here. */
export const report = {
  status(status: 'connected' | 'reconnecting'): void {
    set((state) => (state.current ? { current: { ...state.current, status } } : {}));
  },
  tiles(tiles: Tile[]): void {
    set((state) => ({ tiles, trackVersion: state.trackVersion + 1 }));
  },
  devices(devices: DeviceList): void {
    set({ devices });
  },
  /** The connection ended without the person leaving (kicked, room closed, network gone). */
  ended(): void {
    const current = get().current;
    set({ current: null, tiles: [], expanded: false, reactions: [] });
    if (current) void call('client.huddles.leave', { channel: current.channel }).catch(() => undefined);
  },
};

// Leaving the page leaves the huddle; the server also notices on its own.
window.addEventListener('pagehide', () => {
  const current = get().current;
  if (!current) return;
  void media?.disconnect();
  navigator.sendBeacon?.(
    '/api/client.huddles.leave',
    new Blob([JSON.stringify({ channel: current.channel })], { type: 'application/json' }),
  );
});
