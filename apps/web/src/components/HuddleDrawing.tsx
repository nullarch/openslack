import { Pencil } from 'lucide-react';
import { useEffect, useRef, useState, type PointerEvent as ReactPointerEvent } from 'react';
import { endStroke, extendStroke, setDrawingOn, startStroke, useDrawing } from '../lib/huddleDrawing';
import { chooseEffect, useHuddles } from '../lib/huddles';
import { EFFECTS, effectsSupported, type Effect } from '../lib/huddleEffects';
import { useStore } from '../lib/store';
import { S } from '../strings';
import { IconButton } from './ui';

/** Where the shared picture actually sits inside its tile (the video is letterboxed). */
function contentBox(video: HTMLVideoElement | null): { left: number; top: number; width: number; height: number } | null {
  if (!video || !video.videoWidth || !video.videoHeight) return null;
  const box = video.getBoundingClientRect();
  const parent = video.parentElement?.getBoundingClientRect();
  if (!parent || !box.width || !box.height) return null;
  const scale = Math.min(box.width / video.videoWidth, box.height / video.videoHeight);
  const width = video.videoWidth * scale;
  const height = video.videoHeight * scale;
  return { left: box.left - parent.left + (box.width - width) / 2, top: box.top - parent.top + (box.height - height) / 2, width, height };
}

/** Marks drawn on someone's shared screen, over that screen, for everyone. */
export function DrawingLayer({ sharer }: { sharer: string }) {
  const strokes = useDrawing((state) => state.strokes[sharer]);
  const drawing = useDrawing((state) => state.drawingOn === sharer);
  const self = useStore((state) => state.self?.id ?? '');
  const ref = useRef<SVGSVGElement>(null);
  const [box, setBox] = useState<ReturnType<typeof contentBox>>(null);
  const active = useRef(false);

  useEffect(() => {
    const video = ref.current?.parentElement?.querySelector('video') ?? null;
    const measure = (): void => setBox(contentBox(video));
    measure();
    video?.addEventListener('loadedmetadata', measure);
    video?.addEventListener('resize', measure);
    const observer = new ResizeObserver(measure);
    if (ref.current?.parentElement) observer.observe(ref.current.parentElement);
    return () => {
      video?.removeEventListener('loadedmetadata', measure);
      video?.removeEventListener('resize', measure);
      observer.disconnect();
    };
  }, []);

  const point = (event: ReactPointerEvent<SVGSVGElement>): [number, number] => {
    const rect = event.currentTarget.getBoundingClientRect();
    const clamp = (value: number): number => Math.min(1, Math.max(0, Math.round(value * 10_000) / 10_000));
    return [clamp((event.clientX - rect.left) / rect.width), clamp((event.clientY - rect.top) / rect.height)];
  };

  const style = box ? { left: box.left, top: box.top, width: box.width, height: box.height } : { inset: 0 };
  return (
    <svg
      ref={ref}
      className={`huddle-drawing ${drawing ? 'is-drawing' : ''}`}
      style={style}
      viewBox="0 0 1 1"
      preserveAspectRatio="none"
      aria-hidden="true"
      data-drawing={sharer}
      onPointerDown={(event) => {
        if (!drawing) return;
        event.currentTarget.setPointerCapture(event.pointerId);
        active.current = true;
        startStroke(sharer, self, point(event));
      }}
      onPointerMove={(event) => {
        if (drawing && active.current) extendStroke(point(event));
      }}
      onPointerUp={() => {
        if (!active.current) return;
        active.current = false;
        endStroke();
      }}
    >
      {(strokes ?? []).map((stroke) => (
        <polyline
          key={stroke.id}
          className={stroke.done ? 'is-done' : ''}
          points={stroke.points.map(([x, y]) => `${x},${y}`).join(' ')}
          fill="none"
          stroke={stroke.color}
          strokeWidth={4}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      ))}
    </svg>
  );
}

/** Turn drawing on a shared screen on and off. */
export function DrawButton({ sharer }: { sharer: string }) {
  const drawing = useDrawing((state) => state.drawingOn === sharer);
  useEffect(() => {
    if (!drawing) return;
    const key = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setDrawingOn(null);
    };
    window.addEventListener('keydown', key);
    return () => window.removeEventListener('keydown', key);
  }, [drawing]);
  return (
    <IconButton className="huddle-draw-btn" label={drawing ? S.huddles.stopDrawing : S.huddles.draw} active={drawing} aria-pressed={drawing} onClick={() => setDrawingOn(drawing ? null : sharer)} data-control="draw">
      <Pencil size={16} />
    </IconButton>
  );
}

/** The camera background choice, in the call's settings. */
export function EffectPicker() {
  const effect = useHuddles((state) => state.effect);
  const [supported, setSupported] = useState<boolean | null>(null);
  useEffect(() => {
    void effectsSupported().then(setSupported);
  }, []);
  if (supported === false) return <p className="huddle-device-note">{S.huddles.effectsUnsupported}</p>;
  return (
    <label className="huddle-device">
      <span>{S.huddles.background}</span>
      <select value={effect} disabled={supported === null} onChange={(event) => void chooseEffect(event.target.value as Effect)} data-control="effect">
        {EFFECTS.map((value) => (
          <option key={value} value={value}>
            {S.huddles.effects[value]}
          </option>
        ))}
      </select>
    </label>
  );
}
