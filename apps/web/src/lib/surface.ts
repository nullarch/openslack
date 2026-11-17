import { createContext, useContext } from 'react';

/**
 * Where Block Kit is drawn — a message, a modal or a Home tab — and what using
 * an element there does. Elements read the surface from context, keep what the
 * person chose in its state bag (sent as `state.values`), and ask it to deliver
 * actions and load options for external menus.
 */

export interface OptionObject {
  text: { type: string; text: string; emoji?: boolean };
  value: string;
  description?: { type: string; text: string };
  url?: string;
}

export interface OptionGroup {
  label: { type: string; text: string };
  options: OptionObject[];
}

export interface Suggestions {
  options?: OptionObject[];
  option_groups?: OptionGroup[];
}

/** One element's value, in the shape of Slack's `state.values[block][action]`. */
export type StateValue = { type: string } & Record<string, unknown>;

/** What people have entered on a surface, keyed by block id then action id. */
export class StateBag {
  private readonly values: Record<string, Record<string, StateValue>>;

  constructor(initial: Record<string, Record<string, StateValue>> = {}) {
    this.values = structuredClone(initial);
  }

  get(blockId: string, actionId: string): StateValue | undefined {
    return this.values[blockId]?.[actionId];
  }

  set(blockId: string, actionId: string, value: StateValue): void {
    (this.values[blockId] ??= {})[actionId] = value;
  }

  toState(): { values: Record<string, Record<string, StateValue>> } {
    return { values: structuredClone(this.values) };
  }
}

export interface Surface {
  kind: 'message' | 'modal' | 'home';
  /** Deliver a `block_actions` entry to the app (with this surface's state). */
  act: (action: Record<string, unknown>) => Promise<void>;
  /** Options for an external menu. */
  suggest: (actionId: string, blockId: string, value: string) => Promise<Suggestions>;
  state: StateBag;
  /** Messages from the app's `response_action: errors`, by block id. */
  errors: Record<string, string>;
  /** Called when a value in a block changes, so an error shown for it can go. */
  changed?: (blockId: string) => void;
}

export const SurfaceContext = createContext<Surface | null>(null);

export function useSurface(): Surface | null {
  return useContext(SurfaceContext);
}

/** Plain text of a text object (or a string). */
export function textOf(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value && typeof value === 'object') return String((value as { text?: unknown }).text ?? '');
  return '';
}
