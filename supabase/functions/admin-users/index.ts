// Admin-only user management, called from the app's "Users & audit" page.
//
//   POST {action: "invite", email, full_name?, role}  → invites a new user
//   POST {action: "reset_mfa", user_id}               → removes their authenticator
//
// The caller must send their session token. It is checked with the Auth server,
// must be a two-factor (aal2) session, and must belong to an admin. Invitations
// are emailed when email is configured (EMAIL_ENABLED=true). Otherwise a one-time
// sign-up link is returned for the admin to send through a secure channel.
//
// Secrets: APP_URL. Optional: EMAIL_ENABLED.

import { env, authAdmin, rest, json, isUuid, audit } from '../_shared/supabase-admin.ts';

const ROLES = new Set(['uploader', 'radiologist', 'admin']);

function cors(req: Request): Record<string, string> {
  let allowed = '';
  try { allowed = new URL(env('APP_URL')).origin; } catch { /* unset */ }
  const origin = req.headers.get('Origin') ?? '';
  return {
    'Access-Control-Allow-Origin': origin && origin === allowed ? origin : allowed || 'null',
    'Access-Control-Allow-Headers': 'authorization, apikey, content-type, x-client-info',
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Max-Age': '600',
    Vary: 'Origin',
  };
}

function jwtPayload(token: string): Record<string, unknown> | null {
  try {
    const part = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(atob(part + '='.repeat((4 - (part.length % 4)) % 4)));
  } catch { return null; }
}

/** Verifies the caller's session with the Auth server and checks admin + aal2. */
async function requireAdmin(req: Request) {
  const token = (req.headers.get('Authorization') ?? '').replace(/^Bearer\s+/i, '');
  if (!token) return null;
  const res = await authAdmin('user', { headers: { Authorization: `Bearer ${token}` } });
  if (!res.ok) return null;
  const user = await res.json();
  const claims = jwtPayload(token);
  if (!claims || claims.sub !== user.id || claims.aal !== 'aal2') return null;
  const pr = await rest(`profiles?id=eq.${user.id}&select=id,email,role`);
  const [profile] = pr.ok ? await pr.json() : [];
  return profile?.role === 'admin' ? profile : null;
}

Deno.serve(async (req) => {
  const ch = cors(req);
  if (req.method === 'OPTIONS') return new Response(null, { status: 204, headers: ch });
  if (req.method !== 'POST') return json(405, { error: 'method not allowed' }, ch);

  const admin = await requireAdmin(req);
  if (!admin) return json(403, { error: 'Admin with two-factor sign-in required.' }, ch);

  let body: Record<string, unknown>;
  try { body = await req.json(); } catch { return json(400, { error: 'invalid json' }, ch); }

  if (body.action === 'invite') {
    const email = String(body.email ?? '').trim().toLowerCase();
    const role = String(body.role ?? '');
    const fullName = String(body.full_name ?? '').trim().slice(0, 120);
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) return json(400, { error: 'Enter a valid email address.' }, ch);
    if (!ROLES.has(role)) return json(400, { error: 'Choose a role.' }, ch);

    const existing = await rest(`profiles?email=eq.${encodeURIComponent(email)}&select=id`);
    if (existing.ok && (await existing.json()).length) return json(409, { error: 'That email already has an account.' }, ch);

    const redirect = encodeURIComponent(env('APP_URL'));
    const sendEmail = env('EMAIL_ENABLED') === 'true';
    let userId: string, link: string | null = null;
    if (sendEmail) {
      const r = await authAdmin(`invite?redirect_to=${redirect}`, { method: 'POST', body: JSON.stringify({ email, data: { full_name: fullName } }) });
      const d = await r.json();
      if (!r.ok) return json(502, { error: `Invitation email failed: ${d.msg || d.message || r.status}` }, ch);
      userId = d.id;
    } else {
      const r = await authAdmin(`admin/generate_link?redirect_to=${redirect}`, {
        method: 'POST', body: JSON.stringify({ type: 'invite', email, data: { full_name: fullName } }),
      });
      const d = await r.json();
      if (!r.ok) return json(502, { error: `Could not create the invitation: ${d.msg || d.message || r.status}` }, ch);
      userId = d.id ?? d.user?.id;
      link = d.action_link ?? d.properties?.action_link ?? null;
    }
    if (!isUuid(userId)) return json(502, { error: 'Unexpected response from the Auth server.' }, ch);

    // The profile row is created by a trigger; give it its role.
    await rest(`profiles?id=eq.${userId}`, { method: 'PATCH', body: JSON.stringify({ role, full_name: fullName }) });
    await audit(admin, 'user.invited', { user: userId, email, role, emailed: sendEmail });
    return json(200, { ok: true, emailed: sendEmail, link }, ch);
  }

  if (body.action === 'reset_mfa') {
    const userId = body.user_id;
    if (!isUuid(userId)) return json(400, { error: 'invalid user' }, ch);
    if (userId === admin.id) return json(400, { error: 'Ask another admin to reset your own two-factor.' }, ch);
    const lf = await authAdmin(`admin/users/${userId}/factors`);
    if (!lf.ok) return json(502, { error: 'Could not list factors.' }, ch);
    const factors = await lf.json();
    for (const f of factors) {
      const del = await authAdmin(`admin/users/${userId}/factors/${f.id}`, { method: 'DELETE' });
      if (!del.ok) return json(502, { error: 'Could not remove a factor.' }, ch);
    }
    await audit(admin, 'user.mfa_reset', { user: userId, removed: factors.length });
    return json(200, { ok: true, removed: factors.length }, ch);
  }

  return json(400, { error: 'unknown action' }, ch);
});
