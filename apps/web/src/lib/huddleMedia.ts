import {
  ConnectionState,
  type LocalTrackPublication,
  Participant,
  RemoteParticipant,
  Room,
  RoomEvent,
  Track,
  type RemoteTrack,
} from 'livekit-client';
import { displayName, get as getApp } from './store';
import { report, showReaction, useHuddles, type DeviceList, type Tile } from './huddles';

/**
 * Audio, video and screen sharing through LiveKit. Loaded on first join.
 * Remote audio plays through hidden <audio> elements; video is attached by
 * the stage's tiles through `attach()`.
 */

let room: Room | null = null;
const audioHost = document.createElement('div');
audioHost.hidden = true;
document.body.appendChild(audioHost);
const encoder = new TextEncoder();
const decoder = new TextDecoder();

function nameOf(participant: Participant): string {
  if (participant.name) return participant.name;
  return displayName(getApp().users[participant.identity]);
}

function tileOf(participant: Participant, isLocal: boolean): Tile {
  return {
    identity: participant.identity,
    name: nameOf(participant),
    isLocal,
    speaking: participant.isSpeaking,
    mic: participant.isMicrophoneEnabled,
    camera: participant.isCameraEnabled,
    screen: participant.isScreenShareEnabled,
  };
}

function publishTiles(): void {
  if (!room) return;
  const tiles = [tileOf(room.localParticipant, true), ...[...room.remoteParticipants.values()].map((participant) => tileOf(participant, false))];
  report.tiles(tiles);
}

async function refreshDevices(): Promise<void> {
  const list = async (kind: MediaDeviceKind): Promise<{ deviceId: string; label: string }[]> =>
    (await Room.getLocalDevices(kind, false)).map((device) => ({ deviceId: device.deviceId, label: device.label || kind }));
  const devices: DeviceList = {
    audioinput: await list('audioinput'),
    videoinput: await list('videoinput'),
    audiooutput: await list('audiooutput').catch(() => []),
  };
  report.devices(devices);
}

export async function connect(url: string, token: string, _channel: string): Promise<void> {
  const next = new Room({ adaptiveStream: true, dynacast: true });
  room = next;
  next
    .on(RoomEvent.ParticipantConnected, publishTiles)
    .on(RoomEvent.ParticipantDisconnected, publishTiles)
    .on(RoomEvent.TrackSubscribed, (track: RemoteTrack) => {
      if (track.kind === Track.Kind.Audio) audioHost.appendChild(track.attach());
      publishTiles();
    })
    .on(RoomEvent.TrackUnsubscribed, (track: RemoteTrack) => {
      for (const element of track.detach()) element.remove();
      publishTiles();
    })
    .on(RoomEvent.TrackMuted, publishTiles)
    .on(RoomEvent.TrackUnmuted, publishTiles)
    .on(RoomEvent.LocalTrackPublished, publishTiles)
    .on(RoomEvent.LocalTrackUnpublished, (publication: LocalTrackPublication) => {
      // The browser's own "Stop sharing" button ends a screen share without us.
      if (publication.source === Track.Source.ScreenShare) useHuddles.setState({ screen: false });
      publishTiles();
    })
    .on(RoomEvent.ActiveSpeakersChanged, publishTiles)
    .on(RoomEvent.MediaDevicesChanged, () => void refreshDevices())
    .on(RoomEvent.Reconnecting, () => report.status('reconnecting'))
    .on(RoomEvent.Reconnected, () => report.status('connected'))
    .on(RoomEvent.DataReceived, (payload: Uint8Array, participant?: RemoteParticipant, _kind?: unknown, topic?: string) => {
      if (topic !== 'reaction' || !participant) return;
      const emoji = decoder.decode(payload).slice(0, 16);
      if (emoji) showReaction(emoji, participant.identity);
    })
    .on(RoomEvent.Disconnected, () => {
      if (room !== next) return;
      room = null;
      audioHost.replaceChildren();
      report.ended();
    });

  await next.connect(url, token);
  report.status('connected');
  const selected = useHuddles.getState().selected;
  if (selected.audioinput) await next.switchActiveDevice('audioinput', selected.audioinput).catch(() => undefined);
  await next.localParticipant.setMicrophoneEnabled(useHuddles.getState().mic);
  await next.startAudio().catch(() => undefined);
  publishTiles();
  void refreshDevices();
}

export async function disconnect(): Promise<void> {
  const current = room;
  room = null;
  audioHost.replaceChildren();
  await current?.disconnect();
}

export async function setMic(on: boolean): Promise<void> {
  await room?.localParticipant.setMicrophoneEnabled(on);
  publishTiles();
}

export async function setCamera(on: boolean): Promise<void> {
  await room?.localParticipant.setCameraEnabled(on);
  publishTiles();
}

export async function setScreen(on: boolean): Promise<void> {
  await room?.localParticipant.setScreenShareEnabled(on, { audio: false });
  publishTiles();
}

export async function sendReaction(emoji: string): Promise<void> {
  await room?.localParticipant.publishData(encoder.encode(emoji), { reliable: true, topic: 'reaction' });
}

export async function switchDevice(kind: keyof DeviceList, deviceId: string): Promise<void> {
  await room?.switchActiveDevice(kind, deviceId);
}

/** Attach a participant's camera or screen to a video element; returns a detach function. */
export function attach(identity: string, source: 'camera' | 'screen', element: HTMLVideoElement): () => void {
  if (!room) return () => undefined;
  const participant: Participant | undefined =
    identity === room.localParticipant.identity ? room.localParticipant : room.remoteParticipants.get(identity);
  const publication = participant?.getTrackPublication(source === 'camera' ? Track.Source.Camera : Track.Source.ScreenShare);
  const track = publication?.track;
  if (!track || publication?.isMuted) return () => undefined;
  track.attach(element);
  return () => track.detach(element);
}

/** A plain summary of the call, for tests and diagnostics. */
function snapshot(): unknown {
  if (!room) return { connected: false };
  const sources = (participant: Participant): Record<string, boolean> => {
    const has = (source: Track.Source): boolean => {
      const publication = participant.getTrackPublication(source);
      return Boolean(publication?.track) && !publication?.isMuted;
    };
    return { audio: has(Track.Source.Microphone), camera: has(Track.Source.Camera), screen: has(Track.Source.ScreenShare) };
  };
  return {
    connected: room.state === ConnectionState.Connected,
    room: room.name,
    local: { identity: room.localParticipant.identity, ...sources(room.localParticipant) },
    remote: [...room.remoteParticipants.values()].map((participant) => ({ identity: participant.identity, ...sources(participant) })),
  };
}
(window as unknown as { __huddleState?: () => unknown }).__huddleState = snapshot;
