/** Who should receive an event. */
export type Audience =
  | { conversation: string }
  | { users: string[] }
  | { all: true };

export interface BusEvent {
  /** The event body in Slack's event vocabulary (`type`, plus type-specific fields). */
  event: { type: string; [key: string]: unknown };
  audience: Audience;
  /**
   * True for events that exist only for first-party clients (typing, read
   * cursors, thread summaries). They are never delivered to apps.
   */
  clientOnly?: boolean;
  /** Skip this user's own connections (used for typing indicators). */
  exceptUser?: string;
}

/** `remote` is true for an event emitted by another process (heard only with `everywhere`). */
type Listener = (event: BusEvent, remote: boolean) => void;

export interface SubscribeOptions {
  /**
   * Also hear events emitted by other server processes. For listeners that
   * serve connections held by this process (WebSockets, RTM) or state kept in
   * it. Listeners with side effects (deliveries to apps, notifications, AI)
   * leave it off, so they run once, in the process where the event happened.
   */
  everywhere?: boolean;
}

/**
 * Fan-out of events. Every write emits exactly one event here; the realtime
 * gateway and the app platform subscribe to it. When several processes share
 * the database, each event is also written to the shared log, and `everywhere`
 * listeners are fed from that log only, this process's events included: two
 * events from different processes then reach every socket in the same order
 * (a message, and the app's preview added to it a moment later through
 * another process, never the other way round).
 */
export class Bus {
  private readonly listeners = new Map<Listener, boolean>();
  private forward: ((event: BusEvent) => void) | null = null;

  subscribe(listener: Listener, options: SubscribeOptions = {}): () => void {
    this.listeners.set(listener, options.everywhere === true);
    return () => this.listeners.delete(listener);
  }

  /** Forward every event emitted here (set when processes share the database). */
  connect(forward: (event: BusEvent) => void): void {
    this.forward = forward;
  }

  emit(event: BusEvent): void {
    for (const [listener, everywhere] of [...this.listeners]) {
      if (!everywhere || !this.forward) this.call(listener, event, false);
    }
    if (this.forward) {
      try {
        this.forward(event);
      } catch (error) {
        console.error('[bus] forwarding failed', error);
      }
    }
  }

  /** An event from the shared log: emitted by another process (`remote`) or by this one. */
  receive(event: BusEvent, remote: boolean): void {
    for (const [listener, everywhere] of [...this.listeners]) {
      if (everywhere) this.call(listener, event, remote);
    }
  }

  private call(listener: Listener, event: BusEvent, remote: boolean): void {
    try {
      listener(event, remote);
    } catch (error) {
      console.error('[bus] listener failed', error);
    }
  }
}
