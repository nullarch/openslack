import type { Ctx } from '../ctx.ts';

/** A channel name not taken yet: `name-imported`, then `name-imported-2`, … */
export function freeChannelName(ctx: Ctx, base: string): string {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '-imported' : `-imported-${n}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    if (!ctx.db.get('SELECT 1 FROM conversations WHERE name = ?', candidate)) return candidate;
  }
}

/**
 * Where a channel goes when its name is taken by one of the other kind: the
 * first `name-imported…` that is free, or already of the right kind (a
 * previous run of an import that matches channels by name).
 */
export function separateChannel<T extends { kind: string }>(ctx: Ctx, base: string, kind: 'public' | 'private'): { name: string; conv: T | undefined } {
  for (let n = 1; ; n += 1) {
    const suffix = n === 1 ? '-imported' : `-imported-${n}`;
    const candidate = `${base.slice(0, 80 - suffix.length)}${suffix}`;
    const found = ctx.db.get<T>('SELECT * FROM conversations WHERE name = ?', candidate);
    if (!found) return { name: candidate, conv: undefined };
    if (found.kind === kind) return { name: candidate, conv: found };
  }
}
