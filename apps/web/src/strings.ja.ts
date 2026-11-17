import type { Strings } from './strings.ts';
import { jaAtt } from './i18n/ja-att.ts';
import { jaCore } from './i18n/ja-core.ts';
import { jaRest } from './i18n/ja-rest.ts';

/**
 * Japanese. Follows the tone of Slack's own Japanese interface: です/ます for
 * sentences, short labels for buttons, and one word per idea (チャンネル,
 * スレッド, メンション, ワークスペース, ハドルミーティング, キャンバス, リスト,
 * ワークフロー). Typed as `Strings`, so it cannot fall behind the English source
 * without a type error. Written without a native speaker's review yet.
 */
export const ja: Strings = { ...jaCore, ...jaAtt, ...jaRest };
