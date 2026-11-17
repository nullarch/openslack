/** Thin client for `/api/<method>`: every call is a same-origin JSON POST carrying the session cookie. */

export class ApiError extends Error {
  readonly code: string;
  readonly data: Record<string, unknown>;

  constructor(code: string, data: Record<string, unknown> = {}) {
    super(code);
    this.code = code;
    this.data = data;
  }
}

// Responses vary per method; callers pick the fields they need.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export type Json = any;

let authLost: (() => void) | null = null;

/** Register what to do when the server says the session is no longer valid. */
export function onAuthLost(handler: () => void): void {
  authLost = handler;
}

export async function call(method: string, args: Record<string, unknown> = {}): Promise<Json> {
  let response: Response;
  try {
    response = await fetch(`/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      credentials: 'same-origin',
      body: JSON.stringify(args),
    });
  } catch {
    throw new ApiError('network_error');
  }
  if (response.status === 429) {
    const wait = Math.min(10, Number(response.headers.get('retry-after') ?? 1));
    await new Promise((resolve) => setTimeout(resolve, wait * 1000));
    return call(method, args);
  }
  let body: Json;
  try {
    body = await response.json();
  } catch {
    throw new ApiError('bad_response');
  }
  if (!body?.ok) {
    const code = String(body?.error ?? 'unknown_error');
    if (code === 'invalid_auth' || code === 'not_authed') authLost?.();
    throw new ApiError(code, body ?? {});
  }
  return body;
}

/** True when the server does not implement a method yet (the app platform may be absent). */
export function isUnsupported(error: unknown): boolean {
  return error instanceof ApiError && error.code === 'unknown_method';
}

const SAME_ORIGIN_PATHS = /^\/(files-pri|files-tmb|avatars|emoji|team-icon|upload|previews)\//;

/**
 * URLs in API objects are absolute and built from the server's configured
 * public address. Keep only path and query for paths this server owns, so they
 * load from wherever the page itself was loaded.
 */
export function asset(url: string | undefined | null): string {
  if (!url) return '';
  try {
    const parsed = new URL(url, window.location.origin);
    if (SAME_ORIGIN_PATHS.test(parsed.pathname)) return parsed.pathname + parsed.search;
  } catch {
    // Not a URL: hand it back unchanged.
  }
  return url;
}

const THUMB_SIDE = 720;

/**
 * A smaller copy of an image for message previews, made here because the
 * browser already decodes every format it can show. Null when the image is
 * small enough already, animated (GIF), or not decodable.
 */
async function makeThumbnail(file: File): Promise<Blob | null> {
  if (!/^image\/(png|jpeg|webp|avif|bmp|heic|heif)$/.test(file.type)) return null;
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file);
  } catch {
    return null;
  }
  try {
    const scale = Math.min(1, THUMB_SIDE / Math.max(bitmap.width, bitmap.height));
    if (scale === 1 && file.size < 300_000) return null;
    const canvas = document.createElement('canvas');
    canvas.width = Math.max(1, Math.round(bitmap.width * scale));
    canvas.height = Math.max(1, Math.round(bitmap.height * scale));
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0, canvas.width, canvas.height);
    // PNGs may be transparent; everything else becomes a JPEG.
    const type = file.type === 'image/png' ? 'image/png' : 'image/jpeg';
    return await new Promise((resolve) => canvas.toBlob((blob) => resolve(blob), type, 0.82));
  } finally {
    bitmap.close();
  }
}

/** Upload one file in two steps and return its id, ready for `files.completeUploadExternal`. */
export async function uploadFile(file: File, onProgress?: (fraction: number) => void, options: { snippetType?: string } = {}): Promise<string> {
  const reserved = await call('files.getUploadURLExternal', { filename: file.name || 'file', length: file.size || 1, snippet_type: options.snippetType });
  // The thumbnail goes first: the upload URL stops working once the file itself has arrived.
  const thumbnail = await makeThumbnail(file);
  if (thumbnail) {
    const target = new URL(asset(reserved.upload_url), window.location.origin);
    target.pathname += '/thumb';
    await fetch(target.pathname + target.search, { method: 'POST', body: thumbnail }).catch(() => undefined);
  }
  await new Promise<void>((resolve, reject) => {
    const request = new XMLHttpRequest();
    request.open('POST', asset(reserved.upload_url));
    request.upload.onprogress = (event) => {
      if (event.lengthComputable) onProgress?.(event.loaded / event.total);
    };
    request.onload = () => {
      if (request.status >= 200 && request.status < 300) resolve();
      else reject(new ApiError(parseUploadError(request.responseText)));
    };
    request.onerror = () => reject(new ApiError('network_error'));
    request.send(file);
  });
  return reserved.file_id as string;
}

function parseUploadError(text: string): string {
  try {
    return String((JSON.parse(text) as { error?: string }).error ?? 'upload_failed');
  } catch {
    return 'upload_failed';
  }
}
