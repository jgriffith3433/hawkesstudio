// Email from Studio (invites and password resets) through Amazon SES's query API (us-east-1), signed like aws.ts.
// The sending domain hawkesgen.com is set up by deploy/deploy.mjs --email (SES identity + DKIM records in Route 53).
// While the SES account is in the sandbox it only delivers to verified addresses; the Users tab always shows the link
// too, so an invite never depends on email.

import { awsCredentials, sign } from './aws.ts';

const REGION = process.env.STUDIO_MAIL_REGION || 'us-east-1';
const FROM = process.env.STUDIO_MAIL_FROM || 'Hawkes Studio <noreply@hawkesgen.com>';

export type Mail = { to: string; subject: string; text: string; html?: string };

/** Sends one email. Resolves with SES's message id; rejects with SES's reason (e.g. the sandbox, or no permission). */
export async function sendMail(m: Mail): Promise<string> {
  if (process.env.STUDIO_MAIL === 'off') throw new Error('email is off (STUDIO_MAIL=off)');
  const p = new URLSearchParams({
    Action: 'SendEmail', Version: '2010-12-01', Source: FROM,
    'Destination.ToAddresses.member.1': m.to,
    'Message.Subject.Data': m.subject, 'Message.Subject.Charset': 'UTF-8',
    'Message.Body.Text.Data': m.text, 'Message.Body.Text.Charset': 'UTF-8',
    ...(m.html ? { 'Message.Body.Html.Data': m.html, 'Message.Body.Html.Charset': 'UTF-8' } : {}),
  });
  const body = p.toString();
  const host = `email.${REGION}.amazonaws.com`;
  const creds = await awsCredentials();
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded; charset=utf-8', host, ...(creds.token ? { 'x-amz-security-token': creds.token } : {}) };
  const r = await fetch(`https://${host}/`, { method: 'POST', headers: sign(headers, body, creds, REGION, 'ses'), body, signal: AbortSignal.timeout(20_000) });
  const text = await r.text();
  if (!r.ok) throw new Error(/<Message>([^<]+)<\/Message>/.exec(text)?.[1] ?? `SES ${r.status}`);
  return /<MessageId>([^<]+)<\/MessageId>/.exec(text)?.[1] ?? 'sent';
}

const esc = (s: string) => s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]!);

/** The invite or reset email. */
export function linkMail(kind: 'invite' | 'reset', to: string, link: string, by: string | null): Mail {
  const invite = kind === 'invite';
  const subject = invite ? 'You\'re invited to Hawkes Studio' : 'Reset your Hawkes Studio password';
  const lead = invite ? `${by ? `${by} invited you` : 'You\'ve been invited'} to Hawkes Studio.` : 'Someone asked to reset your Hawkes Studio password.';
  const action = invite ? 'Set your password to join' : 'Choose a new password';
  const expiry = invite ? 'The link works once and expires in 7 days.' : 'The link works once and expires in 24 hours. If you didn\'t ask for this, ignore this email.';
  return {
    to, subject,
    text: `${lead}\n\n${action}: ${link}\n\n${expiry}\n`,
    html: `<p>${esc(lead)}</p><p><a href="${esc(link)}">${esc(action)}</a></p><p style="color:#666">${esc(expiry)}</p>`,
  };
}
