import { BRAND } from '@app/shared';
import nodemailer, { type Transporter } from 'nodemailer';
import type { Ctx } from '../ctx.ts';

/**
 * Outgoing mail. Optional: with no `SMTP_URL` the server shows invite links on
 * screen instead of sending them, and the mail-only sign-in paths are hidden.
 */

export interface Mail {
  to: string;
  subject: string;
  /** Plain-text body; the HTML version is built from it. */
  text: string;
  /** A call to action rendered as a button in the HTML version. */
  action?: { label: string; url: string };
}

const transports = new Map<string, Transporter>();

export function mailEnabled(ctx: Ctx): boolean {
  return Boolean(ctx.config.smtpUrl);
}

function transport(url: string): Transporter {
  let existing = transports.get(url);
  if (!existing) {
    existing = nodemailer.createTransport(url);
    transports.set(url, existing);
  }
  return existing;
}

const ESCAPE: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
const escape = (value: string): string => value.replace(/[&<>"']/g, (char) => ESCAPE[char]!);

function html(mail: Mail, teamName: string): string {
  const paragraphs = mail.text
    .split(/\n{2,}/)
    .map((part) => `<p style="margin:0 0 14px">${escape(part).replace(/\n/g, '<br>')}</p>`)
    .join('');
  const button = mail.action
    ? `<p style="margin:22px 0"><a href="${escape(mail.action.url)}" style="background:#1d1c1d;color:#fff;text-decoration:none;padding:11px 18px;border-radius:8px;font-weight:600;display:inline-block">${escape(mail.action.label)}</a></p>`
    : '';
  return `<!doctype html><html><body style="margin:0;padding:24px;background:#f6f5f2;font-family:system-ui,-apple-system,Segoe UI,sans-serif;color:#1d1c1d;font-size:15px;line-height:1.55"><div style="max-width:520px;margin:0 auto;background:#fff;border:1px solid #e3e1d9;border-radius:12px;padding:28px"><p style="margin:0 0 18px;font-weight:700">${escape(teamName)}</p>${paragraphs}${button}<p style="margin:24px 0 0;color:#6e6c65;font-size:13px">${escape(BRAND.name)}</p></div></body></html>`;
}

/** Send one message. Throws `mail_not_configured` when mail is off, `mail_failed` when the server refuses. */
export async function sendMail(ctx: Ctx, mail: Mail): Promise<void> {
  const url = ctx.config.smtpUrl;
  if (!url) throw new Error('mail_not_configured');
  const teamName = ctx.team()?.name ?? BRAND.name;
  const host = new URL(ctx.config.publicUrl || 'http://localhost').hostname;
  const from = ctx.config.mailFrom || `${teamName} <no-reply@${host.includes('.') ? host : 'localhost.localdomain'}>`;
  const text = mail.action ? `${mail.text}\n\n${mail.action.label}: ${mail.action.url}` : mail.text;
  try {
    await transport(url).sendMail({ from, to: mail.to, subject: mail.subject, text, html: html(mail, teamName) });
  } catch (error) {
    if (!ctx.config.quiet) console.error('[mail] send failed', error instanceof Error ? error.message : error);
    throw new Error('mail_failed');
  }
}

/** Send in the background; failures are logged, never surfaced to the caller. */
export function sendMailLater(ctx: Ctx, mail: Mail): void {
  void sendMail(ctx, mail).catch(() => undefined);
}
