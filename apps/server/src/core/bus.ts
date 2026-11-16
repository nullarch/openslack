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

type Listener = (event: BusEvent) => void;

/**
 * In-process fan-out. Every write emits exactly one event here; the realtime
 * gateway and the app platform subscribe to it.
 */
export class Bus {
  private readonly listeners = new Set<Listener>();

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  emit(event: BusEvent): void {
    for (const listener of this.listeners) {
      try {
        listener(event);
      } catch (error) {
        console.error('[bus] listener failed', error);
      }
    }
  }
}
