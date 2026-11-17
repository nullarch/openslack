import type { Kernel } from '../app.ts';
import { installAgents } from './agents.ts';
import { installFeatures } from './features.ts';
import { installRecaps } from './recaps.ts';

/**
 * AI features: summaries, daily recaps, search answers, translation, writing
 * help, and the Agents view. Every model-backed method fails with
 * `ai_not_configured` and makes no outbound request until an admin connects a
 * model; every answer is built only from what the asking person can read.
 */
export function installAi(kernel: Kernel): void {
  installFeatures(kernel);
  installRecaps(kernel);
  installAgents(kernel);
}
