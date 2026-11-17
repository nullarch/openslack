/**
 * Huddles: audio/video calls that live inside a conversation. Slack has no
 * public API for them; the `room` object on a `huddle_thread` message follows
 * the shape Slack's own messages carry, as far as it is known.
 */
export interface HuddleRoom {
  id: string;
  /** The conversation the huddle belongs to. */
  channels: string[];
  created_by: string;
  /** Seconds. */
  date_start: number;
  /** Seconds; 0 while the huddle is running. */
  date_end: number;
  has_ended: boolean;
  /** Who is in the huddle now. */
  participants: string[];
  /** Everyone who joined at any point, in order of first joining. */
  participant_history: string[];
}

/** A running huddle as clients track it (event `huddle_changed`, method `client.huddles.info`). */
export interface Huddle extends HuddleRoom {
  channel: string;
  /** The `huddle_thread` message that holds the huddle's thread. */
  ts: string;
}
