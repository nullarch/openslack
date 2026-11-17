import { ApiError } from '../core/errors.ts';
import { newHex } from '../core/ids.ts';

interface Trigger {
  appId: string;
  userId: string;
  expires: number;
  used: boolean;
}

const MAX_TRIGGERS = 10_000;

/**
 * `trigger_id`: handed to an app with every interaction, slash command and
 * shortcut. The app exchanges it once, within a few seconds, to open a modal
 * for the person who acted (`views.open`, `views.push`).
 */
export class Triggers {
  private readonly ttlMs: number;
  private readonly triggers = new Map<string, Trigger>();

  constructor(ttlMs: number) {
    this.ttlMs = ttlMs;
  }

  /** A new trigger for `userId`, usable by `appId` only. Slack's three-part form. */
  issue(appId: string, userId: string): string {
    this.sweep();
    const digits = (): string => String(Math.floor(1e11 + Math.random() * 9e11));
    const id = `${digits()}.${digits()}.${newHex(16)}`;
    this.triggers.set(id, { appId, userId, expires: Date.now() + this.ttlMs, used: false });
    return id;
  }

  /**
   * Exchange a trigger and return the person it was issued for. Errors follow
   * `views.open`: `invalid_trigger_id`, `expired_trigger_id`, `exchanged_trigger_id`.
   */
  consume(id: string | undefined, appId: string): string {
    if (!id || !/^\d+\.\d+\.[0-9a-f]+$/.test(id)) throw new ApiError('invalid_trigger_id');
    const trigger = this.triggers.get(id);
    // A trigger issued for another app is no trigger at all for this one.
    if (!trigger || trigger.appId !== appId) throw new ApiError('invalid_trigger_id');
    if (trigger.used) throw new ApiError('exchanged_trigger_id');
    if (trigger.expires <= Date.now()) throw new ApiError('expired_trigger_id');
    trigger.used = true;
    return trigger.userId;
  }

  private sweep(): void {
    if (this.triggers.size < MAX_TRIGGERS) return;
    // Kept a little past expiry so a late exchange still gets the precise error.
    const cutoff = Date.now() - 60_000;
    for (const [id, trigger] of this.triggers) {
      if (trigger.expires < cutoff || this.triggers.size >= MAX_TRIGGERS) this.triggers.delete(id);
    }
  }
}
