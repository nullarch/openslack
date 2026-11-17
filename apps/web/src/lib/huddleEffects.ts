import type { LocalVideoTrack } from 'livekit-client';

/**
 * Camera backgrounds in a huddle: blur, or a picture behind the person. The
 * person is separated from the background in this browser (MediaPipe's
 * selfie segmenter through LiveKit's track processors); the files come from
 * this server, never from a third party, and load only when an effect is
 * first chosen.
 */

export type Effect = 'none' | 'blur' | 'blur-strong' | 'dusk' | 'meadow';
export const EFFECTS: Effect[] = ['none', 'blur', 'blur-strong', 'dusk', 'meadow'];

const STORAGE_KEY = 'huddle-effect';

export function savedEffect(): Effect {
  try {
    const value = localStorage.getItem(STORAGE_KEY);
    return EFFECTS.includes(value as Effect) ? (value as Effect) : 'none';
  } catch {
    return 'none';
  }
}

export function saveEffect(effect: Effect): void {
  try {
    localStorage.setItem(STORAGE_KEY, effect);
  } catch {
    // private window: the choice lasts for this call only
  }
}

/** A soft gradient picture, drawn here so no image has to be shipped. */
function backdrop(effect: 'dusk' | 'meadow'): string {
  const canvas = document.createElement('canvas');
  canvas.width = 1280;
  canvas.height = 720;
  const context = canvas.getContext('2d')!;
  const gradient = context.createLinearGradient(0, 0, 1280, 720);
  const stops = effect === 'dusk' ? ['#2b2d5c', '#7a4a8c', '#e8936b'] : ['#16443f', '#3f8f6e', '#c9e3a6'];
  stops.forEach((color, index) => gradient.addColorStop(index / (stops.length - 1), color));
  context.fillStyle = gradient;
  context.fillRect(0, 0, 1280, 720);
  return canvas.toDataURL('image/jpeg', 0.9);
}

const assetPaths = (): { tasksVisionFileSet: string; modelAssetPath: string } => ({
  tasksVisionFileSet: new URL('/effects', window.location.origin).toString(),
  modelAssetPath: new URL('/effects/selfie_segmenter.tflite', window.location.origin).toString(),
});

let library: Promise<typeof import('@livekit/track-processors')> | null = null;
const load = (): Promise<typeof import('@livekit/track-processors')> => (library ??= import('@livekit/track-processors'));

export async function effectsSupported(): Promise<boolean> {
  try {
    return (await load()).supportsBackgroundProcessors();
  } catch {
    return false;
  }
}

/** Put `effect` on the camera track (or take any effect off). */
export async function applyEffect(track: LocalVideoTrack | undefined, effect: Effect): Promise<void> {
  if (!track) return;
  if (effect === 'none') {
    if (track.getProcessor()) await track.stopProcessor();
    return;
  }
  const { BackgroundProcessor } = await load();
  const processor =
    effect === 'blur' || effect === 'blur-strong'
      ? BackgroundProcessor({ mode: 'background-blur', blurRadius: effect === 'blur' ? 10 : 24, assetPaths: assetPaths() })
      : BackgroundProcessor({ mode: 'virtual-background', imagePath: backdrop(effect), assetPaths: assetPaths() });
  if (track.getProcessor()) await track.stopProcessor();
  await track.setProcessor(processor);
}
