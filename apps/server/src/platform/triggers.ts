import { ApiError } from '../core/errors.ts';
import { newHex } from '../core/ids.ts';
import type { Transient } from '../core/transient.ts';

interface Trigger {
  appId: string;
  userId: string;
  /** The conversation the interaction happened in, when there was one (legacy dialogs report it). */
  channel: string | null;
  expires: number;
  used: boolean;
}

const KIND = 'trigger';
/** Kept a little past expiry so a late exchange still gets the precise error. */
const KEEP_AFTER_MS = 60_000;

/**
 * `trigger_id`: handed to an app with every interaction, slash command and
 * shortcut. The app exchanges it once, within a few seconds, to open a modal
 * for the person who acted (`views.open`, `views.push`). Kept in the shared
 * short-lived store: the app's `views.open` may reach another process.
 */
export class Triggers {
  private readonly transient: Transient;
  private readonly ttlMs: number;

  constructor(transient: Transient, ttlMs: number) {
    this.transient = transient;
    this.ttlMs = ttlMs;
  }

  /** A new trigger for `userId`, usable by `appId` only. Slack's three-part form. */
  issue(appId: string, userId: string, channel: string | null = null): string {
    const digits = (): string => String(Math.floor(1e11 + Math.random() * 9e11));
    const id = `${digits()}.${digits()}.${newHex(16)}`;
    const trigger: Trigger = { appId, userId, channel, expires: Date.now() + this.ttlMs, used: false };
    this.transient.put(KIND, id, trigger, this.ttlMs + KEEP_AFTER_MS);
    return id;
  }

  /**
   * Exchange a trigger and return the person it was issued for. Errors follow
   * `views.open`: `invalid_trigger_id`, `expired_trigger_id`, `exchanged_trigger_id`.
   */
  consume(id: string | undefined, appId: string): string {
    return this.exchange(id, appId).userId;
  }

  /** Like `consume`, with the conversation the trigger came from. */
  exchange(id: string | undefined, appId: string): { userId: string; channel: string | null } {
    if (!id || !/^\d+\.\d+\.[0-9a-f]+$/.test(id)) throw new ApiError('invalid_trigger_id');
    // A trigger issued for another app is no trigger at all for this one.
    let error = 'invalid_trigger_id';
    const used = this.transient.update<Trigger>(KIND, id, (trigger) => {
      if (trigger.appId !== appId) return undefined;
      if (trigger.used) {
        error = 'exchanged_trigger_id';
        return undefined;
      }
      if (trigger.expires <= Date.now()) {
        error = 'expired_trigger_id';
        return undefined;
      }
      return { ...trigger, used: true };
    });
    if (!used) throw new ApiError(error);
    return { userId: used.userId, channel: used.channel };
  }
}
