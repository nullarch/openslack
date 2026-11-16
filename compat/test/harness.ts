import { readFileSync, writeFileSync } from 'node:fs';
import { createServer } from 'node:net';
import { fileURLToPath } from 'node:url';
import type { TestApp } from '@app/server/test/helpers.ts';

const EXERCISED_FILE = fileURLToPath(new URL('../exercised.json', import.meta.url));

/** What one harness run saw: Web API methods called with a token, and payloads delivered to the app. */
export interface Exercised {
  /** Name and version of the SDK that was run. */
  sdk: string;
  methods: string[];
  events: string[];
}

/**
 * Record every API method an SDK calls with a token. Browser-session calls
 * (the "person" in these tests) are not counted: the table is about what apps use.
 */
export function recordTokenCalls(test: TestApp): Set<string> {
  const called = new Set<string>();
  for (const name of test.app.registry.names()) {
    const def = test.app.registry.get(name)!;
    const original = def.handler;
    def.handler = (call) => {
      if (call.actor && call.actor.kind !== 'session') called.add(name);
      return original(call);
    };
  }
  return called;
}

/** Save what a run exercised under its own key; `docs/COMPATIBILITY.md` is generated from this file. */
export function saveExercised(key: string, sdk: string, methods: Iterable<string>, events: Iterable<string>): void {
  let all: Record<string, Exercised> = {};
  try {
    all = JSON.parse(readFileSync(EXERCISED_FILE, 'utf8')) as Record<string, Exercised>;
  } catch {
    // First run.
  }
  all[key] = { sdk, methods: [...methods].sort(), events: [...events].sort() };
  const sorted = Object.fromEntries(Object.entries(all).sort(([a], [b]) => a.localeCompare(b)));
  writeFileSync(EXERCISED_FILE, `${JSON.stringify(sorted, null, 2)}\n`);
}

export function loadExercised(): Record<string, Exercised> {
  try {
    return JSON.parse(readFileSync(EXERCISED_FILE, 'utf8')) as Record<string, Exercised>;
  } catch {
    return {};
  }
}

/** A port nothing is listening on right now. */
export function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      const port = typeof address === 'object' && address ? address.port : 0;
      probe.close(() => resolve(port));
    });
  });
}
