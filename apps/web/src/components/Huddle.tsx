import type { Huddle } from '@app/shared';
import {
  Headphones,
  Maximize2,
  MessageSquareText,
  Mic,
  MicOff,
  Minimize2,
  MonitorUp,
  PhoneOff,
  Settings2,
  SmilePlus,
  Video,
  VideoOff,
} from 'lucide-react';
import { useEffect, useRef, useState } from 'react';
import { openThread } from '../lib/actions';
import {
  chooseDevice,
  joinHuddle,
  leaveHuddle,
  mediaIfLoaded,
  sendReaction,
  setExpanded,
  toggleCamera,
  toggleMic,
  toggleScreen,
  useHuddles,
  type DeviceList,
  type Tile,
} from '../lib/huddles';
import { conversation, conversationName, displayName, useStore, type LocalMessage } from '../lib/store';
import { S } from '../strings';
import '../styles/huddles.css';
import { Mrkdwn } from './text';
import { CaptionsButton, CaptionsOverlay } from './HuddleCaptions';
import { DrawButton, DrawingLayer, EffectPicker } from './HuddleDrawing';
import { Avatar, Button, IconButton, Popover } from './ui';

const REACTIONS = ['👍', '🎉', '😂', '❤️', '👏', '🙌'];

function AvatarStack({ ids, size = 22, max = 4 }: { ids: string[]; size?: number; max?: number }) {
  const users = useStore((state) => state.users);
  const shown = ids.slice(0, max);
  return (
    <span className="huddle-avatars">
      {shown.map((id) => (
        <Avatar key={id} user={users[id]} size={size} />
      ))}
      {ids.length > max ? <span className="huddle-more">+{ids.length - max}</span> : null}
    </span>
  );
}

function elapsed(since: number): string {
  const seconds = Math.max(0, Math.floor(Date.now() / 1000 - since));
  const minutes = Math.floor(seconds / 60);
  const rest = String(seconds % 60).padStart(2, '0');
  return minutes >= 60 ? `${Math.floor(minutes / 60)}:${String(minutes % 60).padStart(2, '0')}:${rest}` : `${minutes}:${rest}`;
}

function useTicker(active: boolean): void {
  const [, setTick] = useState(0);
  useEffect(() => {
    if (!active) return;
    const timer = window.setInterval(() => setTick((value) => value + 1), 1000);
    return () => window.clearInterval(timer);
  }, [active]);
}

// ── In the conversation header ──────────────────────────────────────────────

export function HuddleHeaderButton({ channel, isMember }: { channel: string; isMember: boolean }) {
  const enabled = useHuddles((state) => state.enabled);
  const huddle = useHuddles((state) => state.active[channel]);
  const mine = useHuddles((state) => state.current?.channel === channel);
  const archived = useStore((state) => conversation(state, channel)?.is_archived ?? false);
  if (!enabled || archived) return null;
  if (huddle) {
    return (
      <div className={`huddle-pill ${mine ? 'is-mine' : ''}`} data-huddle-pill>
        <Headphones size={15} />
        <AvatarStack ids={huddle.participants} size={20} max={3} />
        {mine ? (
          <Button size="sm" variant="danger" onClick={() => void leaveHuddle()}>
            {S.huddles.leave}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={!isMember} title={isMember ? undefined : S.huddles.joinChannelFirst} onClick={() => void joinHuddle(channel)}>
            {S.huddles.join}
          </Button>
        )}
      </div>
    );
  }
  return (
    <IconButton label={isMember ? S.huddles.start : S.huddles.joinChannelFirst} disabled={!isMember} onClick={() => void joinHuddle(channel)} data-huddle-start>
      <Headphones size={18} />
    </IconButton>
  );
}

// ── In the sidebar ──────────────────────────────────────────────────────────

export function SidebarHuddleBadge({ channel }: { channel: string }) {
  const count = useHuddles((state) => state.active[channel]?.participants.length ?? 0);
  if (count === 0) return null;
  return (
    <span className="side-huddle" title={S.huddles.inProgress(count)} aria-label={S.huddles.inProgress(count)}>
      <Headphones size={13} />
      {count}
    </span>
  );
}

// ── The huddle_thread message ───────────────────────────────────────────────

export function HuddleCard({ channel, message }: { channel: string; message: LocalMessage }) {
  const live = useHuddles((state) => {
    const huddle = state.active[channel];
    return huddle && huddle.ts === message.ts ? huddle : undefined;
  });
  const mine = useHuddles((state) => state.current?.channel === channel);
  const isMember = useStore((state) => state.channels[channel] !== undefined);
  useTicker(Boolean(live));
  const room = message.room;

  if (live) {
    return (
      <div className="huddle-card is-live" data-huddle-card="live">
        <span className="huddle-card-icon">
          <Headphones size={18} />
        </span>
        <div className="huddle-card-main">
          <div className="huddle-card-title">
            {S.huddles.live} <span className="huddle-card-time">{elapsed(live.date_start)}</span>
          </div>
          <div className="huddle-card-meta">
            <AvatarStack ids={live.participants} />
            <span>{S.huddles.people(live.participants.length)}</span>
          </div>
        </div>
        {mine ? (
          <Button size="sm" onClick={() => setExpanded(true)}>
            {S.huddles.open}
          </Button>
        ) : (
          <Button size="sm" variant="primary" disabled={!isMember} onClick={() => void joinHuddle(channel)}>
            {S.huddles.join}
          </Button>
        )}
      </div>
    );
  }
  return (
    <div className="huddle-card is-ended" data-huddle-card="ended">
      <span className="huddle-card-icon">
        <Headphones size={18} />
      </span>
      <div className="huddle-card-main">
        <div className="huddle-card-title">{room?.has_ended ? S.huddles.ended : S.huddles.live}</div>
        {room?.has_ended ? (
          <div className="huddle-card-meta">
            {room.participant_history.length ? <AvatarStack ids={room.participant_history} /> : null}
            <span>{S.huddles.summary(lasted(room.date_end - room.date_start), names(room.participant_history))}</span>
          </div>
        ) : (
          <div className="huddle-card-meta">
            <Mrkdwn text={message.text} inline />
          </div>
        )}
      </div>
    </div>
  );
}

function lasted(seconds: number): string {
  const minutes = Math.round(seconds / 60);
  if (minutes < 1) return S.huddles.underAMinute;
  if (minutes < 60) return S.huddles.minutes(minutes);
  return S.huddles.hoursMinutes(Math.floor(minutes / 60), minutes % 60);
}

function names(ids: string[]): string {
  const users = useStore.getState().users;
  const list = ids.map((id) => displayName(users[id]));
  if (list.length <= 1) return list.join('');
  return `${list.slice(0, -1).join(', ')} ${S.huddles.and} ${list.at(-1)}`;
}

// ── The call itself ─────────────────────────────────────────────────────────

function VideoTile({ tile, source }: { tile: Tile; source: 'camera' | 'screen' }) {
  const ref = useRef<HTMLVideoElement>(null);
  const version = useHuddles((state) => state.trackVersion);
  useEffect(() => {
    const element = ref.current;
    const media = mediaIfLoaded();
    if (!element || !media) return;
    return media.attach(tile.identity, source, element);
  }, [tile.identity, source, version]);
  return <video ref={ref} className={`huddle-video ${source === 'camera' && tile.isLocal ? 'is-mirrored' : ''}`} autoPlay playsInline muted={tile.isLocal} />;
}

function StageTile({ tile, source = 'camera' }: { tile: Tile; source?: 'camera' | 'screen' }) {
  const user = useStore((state) => state.users[tile.identity]);
  const showVideo = source === 'screen' || tile.camera;
  return (
    <div
      className={`huddle-tile ${tile.speaking && source === 'camera' ? 'is-speaking' : ''} ${source === 'screen' ? 'is-screen' : ''}`}
      data-tile={tile.identity}
      data-source={source}
    >
      {showVideo ? <VideoTile tile={tile} source={source} /> : <Avatar user={user} size={72} />}
      {source === 'screen' ? <DrawingLayer sharer={tile.identity} /> : null}
      {source === 'screen' ? <DrawButton sharer={tile.identity} /> : null}
      <span className="huddle-tile-name">
        {source === 'screen' ? S.huddles.sharing(tile.name) : tile.isLocal ? `${tile.name} ${S.huddles.you}` : tile.name}
        {source === 'camera' && !tile.mic ? <MicOff size={13} /> : null}
      </span>
    </div>
  );
}

function DevicePicker({ anchor, onClose }: { anchor: HTMLElement | null; onClose: () => void }) {
  const devices = useHuddles((state) => state.devices);
  const selected = useHuddles((state) => state.selected);
  const row = (kind: keyof DeviceList, label: string) =>
    devices[kind].length ? (
      <label className="huddle-device">
        <span>{label}</span>
        <select value={selected[kind] ?? ''} onChange={(event) => void chooseDevice(kind, event.target.value)}>
          {!selected[kind] ? <option value="">{S.huddles.systemDefault}</option> : null}
          {devices[kind].map((device) => (
            <option key={device.deviceId} value={device.deviceId}>
              {device.label}
            </option>
          ))}
        </select>
      </label>
    ) : null;
  return (
    <Popover anchor={anchor} onClose={onClose} side="top" className="huddle-devices">
      {row('audioinput', S.huddles.microphone)}
      {row('videoinput', S.huddles.camera)}
      {row('audiooutput', S.huddles.speaker)}
      <EffectPicker />
    </Popover>
  );
}

function Controls({ compact }: { compact: boolean }) {
  const mic = useHuddles((state) => state.mic);
  const camera = useHuddles((state) => state.camera);
  const screen = useHuddles((state) => state.screen);
  const expanded = useHuddles((state) => state.expanded);
  const current = useHuddles((state) => state.current);
  const huddle = useHuddles((state) => (state.current ? state.active[state.current.channel] : undefined));
  const [reactAnchor, setReactAnchor] = useState<HTMLElement | null>(null);
  const [deviceAnchor, setDeviceAnchor] = useState<HTMLElement | null>(null);
  const canShare = typeof navigator.mediaDevices?.getDisplayMedia === 'function';
  const size = compact ? 16 : 19;
  return (
    <div className={`huddle-controls ${compact ? 'is-compact' : ''}`}>
      <IconButton label={mic ? S.huddles.mute : S.huddles.unmute} active={!mic} onClick={() => void toggleMic()} data-control="mic">
        {mic ? <Mic size={size} /> : <MicOff size={size} />}
      </IconButton>
      <IconButton label={camera ? S.huddles.cameraOff : S.huddles.cameraOn} active={camera} onClick={() => void toggleCamera()} data-control="camera">
        {camera ? <Video size={size} /> : <VideoOff size={size} />}
      </IconButton>
      {canShare ? (
        <IconButton label={screen ? S.huddles.shareOff : S.huddles.shareOn} active={screen} onClick={() => void toggleScreen()} data-control="screen">
          <MonitorUp size={size} />
        </IconButton>
      ) : null}
      <IconButton label={S.huddles.react} onClick={(event) => setReactAnchor(event.currentTarget)} data-control="react">
        <SmilePlus size={size} />
      </IconButton>
      <CaptionsButton size={size} />
      {reactAnchor ? (
        <Popover anchor={reactAnchor} onClose={() => setReactAnchor(null)} side="top" className="huddle-reaction-picker">
          {REACTIONS.map((emoji) => (
            <button
              key={emoji}
              type="button"
              className="huddle-reaction-choice"
              onClick={() => {
                void sendReaction(emoji);
                setReactAnchor(null);
              }}
            >
              {emoji}
            </button>
          ))}
        </Popover>
      ) : null}
      {huddle && current ? (
        <IconButton label={S.huddles.thread} onClick={() => openThread(current.channel, huddle.ts)} data-control="thread">
          <MessageSquareText size={size} />
        </IconButton>
      ) : null}
      {!compact ? (
        <IconButton label={S.huddles.devices} onClick={(event) => setDeviceAnchor(event.currentTarget)} data-control="devices">
          <Settings2 size={size} />
        </IconButton>
      ) : null}
      {deviceAnchor ? <DevicePicker anchor={deviceAnchor} onClose={() => setDeviceAnchor(null)} /> : null}
      <IconButton label={expanded ? S.huddles.minimize : S.huddles.expand} onClick={() => setExpanded(!expanded)} data-control="expand">
        {expanded ? <Minimize2 size={size} /> : <Maximize2 size={size} />}
      </IconButton>
      <button type="button" className="huddle-leave" onClick={() => void leaveHuddle()} aria-label={S.huddles.leave} title={S.huddles.leave} data-control="leave">
        <PhoneOff size={size} />
        {compact ? null : <span>{S.huddles.leave}</span>}
      </button>
    </div>
  );
}

function Reactions() {
  const reactions = useHuddles((state) => state.reactions);
  return (
    <div className="huddle-reactions" aria-hidden="true">
      {reactions.map((reaction) => (
        <span key={reaction.id} className="huddle-reaction" style={{ left: `${reaction.x * 100}%` }}>
          {reaction.emoji}
        </span>
      ))}
    </div>
  );
}

function Stage({ channel, huddle }: { channel: string; huddle: Huddle | undefined }) {
  const tiles = useHuddles((state) => state.tiles);
  const name = useStore((state) => conversationName(state, conversation(state, channel)));
  useTicker(true);
  const sharers = tiles.filter((tile) => tile.screen);
  return (
    <div className="huddle-stage" role="dialog" aria-label={S.huddles.stageLabel(name)} data-huddle-stage>
      <header className="huddle-stage-head">
        <Headphones size={18} />
        <strong>{name}</strong>
        {huddle ? <span className="huddle-stage-time">{elapsed(huddle.date_start)}</span> : null}
      </header>
      <div className={`huddle-stage-body ${sharers.length ? 'has-screen' : ''}`}>
        {sharers.length ? (
          <div className="huddle-spotlight">
            {sharers.map((tile) => (
              <StageTile key={`${tile.identity}:screen`} tile={tile} source="screen" />
            ))}
          </div>
        ) : null}
        <div className={`huddle-grid count-${Math.min(tiles.length, 9)}`}>
          {tiles.map((tile) => (
            <StageTile key={tile.identity} tile={tile} />
          ))}
        </div>
        <Reactions />
        <CaptionsOverlay />
      </div>
      <Controls compact={false} />
    </div>
  );
}

/** The call while browsing: a small bar over the sidebar, or the full stage. */
export function HuddleDock() {
  const current = useHuddles((state) => state.current);
  const expanded = useHuddles((state) => state.expanded);
  const tiles = useHuddles((state) => state.tiles);
  const huddle = useHuddles((state) => (state.current ? state.active[state.current.channel] : undefined));
  const name = useStore((state) => (current ? conversationName(state, conversation(state, current.channel)) : ''));
  if (!current) return null;
  if (expanded) return <Stage channel={current.channel} huddle={huddle} />;
  const status = current.status === 'connecting' ? S.huddles.connecting : current.status === 'reconnecting' ? S.huddles.reconnecting : null;
  return (
    <div className="huddle-dock" data-huddle-dock data-status={current.status}>
      <div className="huddle-dock-head">
        <span className="huddle-live-dot" />
        <button type="button" className="huddle-dock-name" onClick={() => setExpanded(true)}>
          {name}
        </button>
        {status ? <span className="huddle-dock-status">{status}</span> : null}
      </div>
      <div className="huddle-dock-people">
        {tiles.map((tile) => (
          <span key={tile.identity} className={`huddle-dock-person ${tile.speaking ? 'is-speaking' : ''}`} title={tile.name}>
            <DockAvatar id={tile.identity} />
            {!tile.mic ? <MicOff size={10} className="huddle-dock-muted" /> : null}
          </span>
        ))}
      </div>
      <CaptionsOverlay compact />
      <Controls compact />
      <Reactions />
    </div>
  );
}

function DockAvatar({ id }: { id: string }) {
  const user = useStore((state) => state.users[id]);
  return <Avatar user={user} size={26} />;
}
