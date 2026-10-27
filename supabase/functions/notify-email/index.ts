// Emails the uploader when a report is signed or an addendum is added.
//
// Called by the database (pg_net trigger on public.notifications) with only
// {"notification_id": <id>}. Everything else is looked up here with the secret
// key, and each notification is emailed at most once: the row is claimed by
// setting emailed_at, so replaying or forging a call cannot send anything that
// was not already due. That is why no shared secret is needed.
//
// The email contains no clinical or patient information.
// Secrets: RESEND_API_KEY, NOTIFY_FROM, APP_URL. Optional: EMAIL_API_URL (tests).

import { env, rest, json } from '../_shared/supabase-admin.ts';

const CLAIM_WINDOW_MINUTES = 15;

Deno.serve(async (req) => {
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' });
  if (!env('RESEND_API_KEY') || !env('NOTIFY_FROM')) return json(200, { skipped: 'email not configured' });

  let id: number;
  try { id = Number((await req.json()).notification_id); } catch { return json(400, { error: 'invalid json' }); }
  if (!Number.isSafeInteger(id) || id <= 0) return json(400, { error: 'invalid id' });

  // Atomically claim the notification: only a recent, unsent report or addendum row matches.
  const since = new Date(Date.now() - CLAIM_WINDOW_MINUTES * 60_000).toISOString();
  const claim = await rest(
    `notifications?id=eq.${id}&kind=in.(report_ready,report_addended)&emailed_at=is.null&created_at=gte.${encodeURIComponent(since)}&select=id,user_id,study_id,kind`,
    { method: 'PATCH', headers: { Prefer: 'return=representation' }, body: JSON.stringify({ emailed_at: new Date().toISOString() }) },
  );
  const [rec] = claim.ok ? await claim.json() : [];
  if (!rec) return json(200, { skipped: true });

  const release = () => rest(`notifications?id=eq.${id}`, { method: 'PATCH', body: JSON.stringify({ emailed_at: null }) });

  const pr = await rest(`profiles?id=eq.${rec.user_id}&select=email,full_name`);
  const [profile] = pr.ok ? await pr.json() : [];
  if (!profile?.email) { await release(); return json(404, { error: 'recipient not found' }); }

  const ref = String(rec.study_id ?? '').slice(0, 8).toUpperCase();
  const appUrl = env('APP_URL');
  const name = String(profile.full_name || '').replace(/[<>&"]/g, '');
  const greeting = name ? `Dear ${name},` : 'Hello,';
  const isAddendum = rec.kind === 'report_addended';
  const event = isAddendum
    ? 'An addendum has been added to the signed radiology report'
    : 'A radiology report has been signed';
  const subject = isAddendum ? `Report addendum – case ${ref}` : `Report ready – case ${ref}`;
  const text = [
    greeting, '',
    `${event} for case reference ${ref}.`,
    `Sign in to view it: ${appUrl}`, '',
    'This message contains no patient information. Do not reply.',
  ].join('\n');
  const html = `<p>${greeting}</p>
<p>${event} for case reference <strong>${ref}</strong>.</p>
<p><a href="${encodeURI(appUrl)}">Sign in to view it</a>.</p>
<p style="color:#666;font-size:12px">This message contains no patient information. Do not reply.</p>`;

  const res = await fetch(env('EMAIL_API_URL') || 'https://api.resend.com/emails', {
    method: 'POST',
    headers: { Authorization: `Bearer ${env('RESEND_API_KEY')}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ from: env('NOTIFY_FROM'), to: [profile.email], subject, text, html }),
  });
  if (!res.ok) {
    console.error('email provider error', res.status, await res.text());
    await release();
    return json(502, { error: 'email provider error' });
  }
  return json(200, { sent: true });
});
