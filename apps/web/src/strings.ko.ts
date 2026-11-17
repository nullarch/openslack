import type { Strings } from './strings';
import { koAtt } from './i18n/ko-att';
import { koCore } from './i18n/ko-core';
import { koRest } from './i18n/ko-rest';

/**
 * Korean. Written for people, not word for word: 해요체 for sentences, short
 * nouns for buttons, and one word per idea (채널, 스레드, 멘션, 워크스페이스,
 * 허들, 캔버스, 리스트, 워크플로). Typed as `Strings`, so it cannot fall behind
 * the English source without a type error.
 */
export const ko: Strings = { ...koCore, ...koAtt, ...koRest };
