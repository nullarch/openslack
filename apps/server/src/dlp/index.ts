import { runInNewContext } from 'node:vm';
import type { Kernel } from '../app.ts';
import { recordAuditEvent } from '../audit/index.ts';
import { fail } from '../core/errors.ts';
import { contentChecks } from '../core/messages.ts';
import { uploadChecks } from '../core/files.ts';
import { extractorFor } from '../core/file-text.ts';
import { getUser } from '../core/users.ts';
import type { Ctx } from '../ctx.ts';
import { regexProblem } from '../workflows/responses.ts';

/**
 * Keeping sensitive information out of messages: when a workspace turns a
 * detector on, a message (or an edit) that contains what it detects is
 * refused with `sensitive_information`, and the attempt is written to the audit
 * log (which detector, who; never the text). Built-in detectors check
 * structure, not only shape (card numbers pass the Luhn check, resident
 * registration numbers carry a real date); admins can add their own patterns.
 */

interface Detector {
  id: string;
  name: string;
  find: (text: string) => boolean;
}

function luhn(digits: string): boolean {
  let sum = 0;
  for (let i = 0; i < digits.length; i += 1) {
    let digit = Number(digits[digits.length - 1 - i]);
    if (i % 2 === 1) {
      digit *= 2;
      if (digit > 9) digit -= 9;
    }
    sum += digit;
  }
  return sum % 10 === 0;
}

function validDate(yy: string, mm: string, dd: string): boolean {
  const month = Number(mm);
  const day = Number(dd);
  return month >= 1 && month <= 12 && day >= 1 && day <= 31 && yy.length === 2;
}

export const DETECTORS: Detector[] = [
  {
    id: 'credit_card',
    name: 'Payment card numbers',
    find: (text) => [...text.matchAll(/(?<![\d-])(?:\d[ -]?){12,18}\d(?![\d-])/g)].some((match) => {
      const digits = match[0].replace(/[ -]/g, '');
      return digits.length >= 13 && digits.length <= 19 && /^[2-6]/.test(digits) && luhn(digits);
    }),
  },
  {
    id: 'kr_rrn',
    name: 'Korean resident registration numbers (주민등록번호)',
    find: (text) => [...text.matchAll(/(?<!\d)(\d{2})(\d{2})(\d{2})-?([1-8])\d{6}(?!\d)/g)].some((match) => validDate(match[1]!, match[2]!, match[3]!)),
  },
  {
    id: 'us_ssn',
    name: 'US Social Security numbers',
    find: (text) => [...text.matchAll(/(?<!\d)(\d{3})-(\d{2})-(\d{4})(?!\d)/g)].some((match) => match[1] !== '000' && match[1] !== '666' && !match[1]!.startsWith('9') && match[2] !== '00' && match[3] !== '0000'),
  },
  {
    id: 'secrets',
    name: 'API keys, tokens and private keys',
    find: (text) =>
      /\bAKIA[0-9A-Z]{16}\b/.test(text) ||
      /\bgh[pousr]_[A-Za-z0-9]{36,}\b/.test(text) ||
      /\bxox[abeprs]-[A-Za-z0-9-]{20,}/.test(text) ||
      /\bxapp-1-[A-Za-z0-9-]{20,}/.test(text) ||
      /\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{32,}\b/.test(text) ||
      /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/.test(text),
  },
];

interface CustomRule {
  name: string;
  pattern: string;
}

interface Policy {
  detectors: string[];
  custom: CustomRule[];
}

export function dlpPolicy(ctx: Ctx): Policy {
  try {
    const raw = (JSON.parse(ctx.team()?.prefs ?? '{}') as { dlp?: Partial<Policy> }).dlp ?? {};
    return {
      detectors: Array.isArray(raw.detectors) ? raw.detectors.filter((id) => DETECTORS.some((detector) => detector.id === id)) : [],
      custom: Array.isArray(raw.custom) ? raw.custom.filter((rule) => rule && typeof rule.pattern === 'string' && !regexProblem(rule.pattern)) : [],
    };
  } catch {
    return { detectors: [], custom: [] };
  }
}

/** Which rules a text breaks (names only). */
export function findSensitive(policy: Policy, text: string): string[] {
  const body = text.slice(0, 40_000);
  const hits = DETECTORS.filter((detector) => policy.detectors.includes(detector.id) && detector.find(body)).map((detector) => detector.name);
  for (const rule of policy.custom) {
    try {
      if (runInNewContext('pattern.test(text)', { pattern: new RegExp(rule.pattern, 'iu'), text: body }, { timeout: 50 }) === true) hits.push(rule.name);
    } catch {
      // Too slow or broken: not a match.
    }
  }
  return hits;
}

function blockText(blocks: unknown): string {
  // Text inside Block Kit counts too: collect every string value.
  const out: string[] = [];
  const walk = (value: unknown, depth: number): void => {
    if (depth > 12 || out.length > 2000) return;
    if (typeof value === 'string') out.push(value);
    else if (Array.isArray(value)) value.forEach((entry) => walk(entry, depth + 1));
    else if (value && typeof value === 'object') Object.values(value).forEach((entry) => walk(entry, depth + 1));
  };
  walk(blocks, 0);
  return out.join('\n');
}

export function installDlp(kernel: Kernel): void {
  const { ctx } = kernel;

  contentChecks.push((ctx2, userId, text, blocks) => {
    const policy = dlpPolicy(ctx2);
    if (policy.detectors.length === 0 && policy.custom.length === 0) return;
    const hits = findSensitive(policy, blocks ? `${text}\n${blockText(blocks)}` : text);
    if (hits.length === 0) return;
    const user = getUser(ctx2, userId);
    ctx2.db.run(
      'INSERT INTO audit_log (created, action, actor_type, actor_id, details) VALUES (unixepoch(), ?, ?, ?, ?)',
      'message_blocked_sensitive',
      user?.is_bot === 1 ? 'app' : 'user',
      user?.is_bot === 1 ? (user.app_id ?? userId) : userId,
      JSON.stringify({ rules: hits }),
    );
    fail('sensitive_information', { rules: hits });
  });

  // Text inside uploads (documents, PDFs, code) is held to the same rules.
  uploadChecks.push(async (ctx2, row, size) => {
    const policy = dlpPolicy(ctx2);
    if (policy.detectors.length === 0 && policy.custom.length === 0) return;
    const extractor = extractorFor(row.name, row.mimetype);
    if (!extractor || size > 20 * 1024 * 1024) return;
    const chunks: Buffer[] = [];
    for await (const chunk of ctx2.storage.read(row.storage_key)) chunks.push(chunk as Buffer);
    let text = '';
    try {
      text = extractor(Buffer.concat(chunks));
    } catch {
      return;
    }
    const hits = findSensitive(policy, `${row.name}\n${text}`);
    if (hits.length === 0) return;
    ctx2.db.run(
      'INSERT INTO audit_log (created, action, actor_type, actor_id, entity_type, details) VALUES (unixepoch(), ?, ?, ?, ?, ?)',
      'file_blocked_sensitive',
      'user',
      row.user_id,
      'file',
      JSON.stringify({ rules: hits, name: row.name }),
    );
    fail('sensitive_information', { rules: hits });
  });

  kernel.registry.add('client.admin.dlp.get', { auth: 'admin' }, () => {
    const policy = dlpPolicy(ctx);
    return { detectors: DETECTORS.map((detector) => ({ id: detector.id, name: detector.name, enabled: policy.detectors.includes(detector.id) })), custom: policy.custom };
  });

  kernel.registry.add('client.admin.dlp.set', { auth: 'admin' }, ({ actor, args, req }) => {
    const detectors = args.has('detectors') ? (args.json<unknown[]>('detectors') ?? []) : dlpPolicy(ctx).detectors;
    if (!Array.isArray(detectors) || detectors.some((id) => !DETECTORS.some((detector) => detector.id === id))) fail('invalid_arguments', { arg: 'detectors' });
    const custom = args.has('custom') ? (args.json<unknown[]>('custom') ?? []) : dlpPolicy(ctx).custom;
    if (!Array.isArray(custom) || custom.length > 50) fail('invalid_arguments', { arg: 'custom' });
    const rules = custom.map((entry) => {
      const item = (entry && typeof entry === 'object' ? entry : {}) as Record<string, unknown>;
      const name = String(item.name ?? '').trim().slice(0, 80);
      const pattern = String(item.pattern ?? '');
      const problem = regexProblem(pattern);
      if (!name || problem) fail('invalid_pattern', { name, detail: problem ?? 'A name is required.' });
      return { name, pattern };
    });
    const policy: Policy = { detectors: [...new Set(detectors as string[])], custom: rules };
    ctx.db.run("UPDATE team SET prefs = json_set(prefs, '$.dlp', json(?)) WHERE id = ?", JSON.stringify(policy), ctx.requireTeam().id);
    ctx.invalidateTeam();
    recordAuditEvent(ctx, { action: 'sensitive_information_policy_changed', actorId: actor.userId, req, details: { detectors: policy.detectors, custom: policy.custom.map((rule) => rule.name) } });
    return { detectors: policy.detectors, custom: policy.custom };
  });

  /** Try the policy (or a draft of it) on a text, for the settings screen. */
  kernel.registry.add('client.admin.dlp.test', { auth: 'admin' }, ({ args }) => {
    const draft = args.has('policy') ? (args.json<Policy>('policy') ?? dlpPolicy(ctx)) : dlpPolicy(ctx);
    const policy: Policy = { detectors: Array.isArray(draft.detectors) ? draft.detectors : [], custom: Array.isArray(draft.custom) ? draft.custom.filter((rule) => !regexProblem(String(rule.pattern))) : [] };
    return { matches: findSensitive(policy, args.req('text')) };
  });
}
