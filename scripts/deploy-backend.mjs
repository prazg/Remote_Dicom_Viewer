#!/usr/bin/env node
// Sets up (or updates) the Supabase backend. Run by the GitHub Actions workflow
// on every push; safe to re-run. Uses the Supabase Management API only, so no
// database password is needed.
//
// Required env:  SUPABASE_ACCESS_TOKEN, SUPABASE_PROJECT_REF, SITE_URL
// Optional env:  ADMIN_EMAIL     first administrator (invited if no admin exists yet)
//                RESEND_API_KEY  enables invitation and report-ready emails
//                EMAIL_FROM      e.g. "DICOM Reporting <reports@your-domain.org>" (domain verified in Resend)
// Testing only:  SUPABASE_API_URL, SUPABASE_PROJECT_URL, FUNCTIONS_URL_FOR_DB
//
// Writes `supabase_url` and `publishable_key` to $GITHUB_OUTPUT for the site build.

import { readFileSync, readdirSync, appendFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const API = (process.env.SUPABASE_API_URL || 'https://api.supabase.com').replace(/\/$/, '');
const TOKEN = process.env.SUPABASE_ACCESS_TOKEN || '';
const REF = (process.env.SUPABASE_PROJECT_REF || '').trim();
const SITE_URL = (process.env.SITE_URL || '').trim().replace(/\/?$/, '/');
const PROJECT_URL = (process.env.SUPABASE_PROJECT_URL || `https://${REF}.supabase.co`).replace(/\/$/, '');
const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || '').trim().toLowerCase();
const RESEND_API_KEY = (process.env.RESEND_API_KEY || '').trim();
const EMAIL_FROM = (process.env.EMAIL_FROM || '').trim();
const IN_ACTIONS = process.env.GITHUB_ACTIONS === 'true';

const log = (m) => console.log(m);
const warn = (m) => console.log(IN_ACTIONS ? `::warning::${m}` : `WARNING: ${m}`);
const fail = (m) => { console.log(IN_ACTIONS ? `::error::${m}` : `ERROR: ${m}`); process.exit(1); };
const mask = (v) => { if (IN_ACTIONS && v) console.log(`::add-mask::${v}`); };

if (!TOKEN) fail('SUPABASE_ACCESS_TOKEN is not set.');
if (!/^[a-z]{20}$/.test(REF)) fail('SUPABASE_PROJECT_REF must be the 20-letter project reference (Project Settings → General).');
if (!/^https?:\/\/[^\s'"<>]+$/.test(SITE_URL)) fail('SITE_URL must be the site address, e.g. https://you.github.io/repo/');
if (ADMIN_EMAIL && !/^[^\s@'"<>]+@[^\s@'"<>]+\.[^\s@'"<>]+$/.test(ADMIN_EMAIL)) fail('ADMIN_EMAIL is not a valid email address.');
const emailEnabled = Boolean(RESEND_API_KEY && EMAIL_FROM);
if ((RESEND_API_KEY || EMAIL_FROM) && !emailEnabled) fail('Set both RESEND_API_KEY and EMAIL_FROM to enable email, or neither.');
const fromAddress = (EMAIL_FROM.match(/<([^>]+)>/)?.[1] || EMAIL_FROM).trim();
mask(TOKEN); mask(RESEND_API_KEY);

async function api(method, path, body, extraHeaders = {}) {
  const res = await fetch(`${API}${path}`, {
    method,
    headers: { Authorization: `Bearer ${TOKEN}`, 'Content-Type': 'application/json', ...extraHeaders },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let data; try { data = text ? JSON.parse(text) : null; } catch { data = text; }
  if (!res.ok) {
    const msg = typeof data === 'object' && data ? (data.message || data.error || JSON.stringify(data)) : text;
    const err = new Error(`${method} ${path} → ${res.status}: ${String(msg).slice(0, 400)}`);
    err.status = res.status;
    throw err;
  }
  return data;
}

// Values are validated above and quoted here, so no query parameters are needed.
const lit = (v) => `'${String(v).replace(/'/g, "''")}'`;
const sql = (query) => api('POST', `/v1/projects/${REF}/database/query`, { query });

async function main() {
  // 1. Project -------------------------------------------------------------
  const project = await api('GET', `/v1/projects/${REF}`);
  log(`Project: ${project.name} (${project.region})`);
  if (project.region && project.region !== 'eu-west-2') {
    warn(`Project region is ${project.region}, not London (eu-west-2). Data is stored outside the UK.`);
  }

  // 2. Database migrations ---------------------------------------------------
  const applied = await api('GET', `/v1/projects/${REF}/database/migrations`);
  const isApplied = (version, stem, label) => (applied || []).some((m) =>
    m.name === stem || m.name === label || `${m.version}_${m.name}` === stem || m.version === version);
  const dir = join(ROOT, 'supabase', 'migrations');
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.sql')).sort()) {
    const stem = file.replace(/\.sql$/, '');
    const [version, ...rest] = stem.split('_');
    if (isApplied(version, stem, rest.join('_'))) { log(`Migration ${stem}: already applied`); continue; }
    log(`Migration ${stem}: applying…`);
    await api('POST', `/v1/projects/${REF}/database/migrations`,
      { query: readFileSync(join(dir, file), 'utf8'), name: stem }, { 'Idempotency-Key': stem });
    log(`Migration ${stem}: done`);
  }

  // 3. Authentication settings -------------------------------------------------
  const authConfig = {
    site_url: SITE_URL,
    uri_allow_list: [SITE_URL, `${SITE_URL}**`].join(','),
    disable_signup: true,                       // invitation only
    external_email_enabled: true,               // email + password sign-in
    external_phone_enabled: false,
    external_anonymous_users_enabled: false,
    mfa_totp_enroll_enabled: true,              // authenticator apps
    mfa_totp_verify_enabled: true,
    mfa_phone_enroll_enabled: false,
    password_min_length: 12,
    password_required_characters: 'abcdefghijklmnopqrstuvwxyz:ABCDEFGHIJKLMNOPQRSTUVWXYZ:0123456789',
    security_update_password_require_reauthentication: true,
    mailer_secure_email_change_enabled: true,
    mailer_otp_exp: 86400,                      // invitation and reset links expire after 24 hours
  };
  if (emailEnabled) {
    Object.assign(authConfig, {
      smtp_host: 'smtp.resend.com', smtp_port: '465', smtp_user: 'resend', smtp_pass: RESEND_API_KEY,
      smtp_admin_email: fromAddress, smtp_sender_name: 'DICOM Reporting', rate_limit_email_sent: 30,
    });
  }
  await api('PATCH', `/v1/projects/${REF}/config/auth`, authConfig);
  log(`Auth: sign-up disabled, two-factor enabled, 12+ character passwords, site ${SITE_URL}${emailEnabled ? ', email via Resend' : ''}`);

  // Pro-plan hardening: applied when available, otherwise noted.
  try {
    await api('PATCH', `/v1/projects/${REF}/config/auth`, { sessions_timebox: 12, sessions_inactivity_timeout: 0.5, password_hibp_enabled: true });
    log('Auth: 12-hour session limit, 30-minute server-side inactivity timeout, leaked-password check');
  } catch (e) {
    warn(`Session limits and leaked-password checks were not applied (they need a Supabase Pro plan): ${e.message}`);
  }

  // 4. API keys for the site -------------------------------------------------
  const keys = await api('GET', `/v1/projects/${REF}/api-keys?reveal=true`);
  const pick = (type, legacyName) => (keys.find((k) => k.type === type && k.api_key) || keys.find((k) => k.name === legacyName && k.api_key))?.api_key;
  const publishable = pick('publishable', 'anon');
  const secret = pick('secret', 'service_role');
  if (!publishable || !secret) fail('Could not read the project API keys.');
  mask(secret);

  // 5. Function secrets --------------------------------------------------------
  const fnSecrets = [
    { name: 'APP_URL', value: SITE_URL },
    { name: 'EMAIL_ENABLED', value: emailEnabled ? 'true' : 'false' },
  ];
  if (emailEnabled) fnSecrets.push({ name: 'RESEND_API_KEY', value: RESEND_API_KEY }, { name: 'NOTIFY_FROM', value: EMAIL_FROM });
  await api('POST', `/v1/projects/${REF}/secrets`, fnSecrets);
  log(`Function secrets: ${fnSecrets.map((s) => s.name).join(', ')}`);

  // 6. Database settings: where to queue report-ready emails ------------------
  const functionsUrl = process.env.FUNCTIONS_URL_FOR_DB || `${PROJECT_URL}/functions/v1`;
  await sql(`insert into public.app_config (key, value) values ('app_url', ${lit(SITE_URL)})
             on conflict (key) do update set value = excluded.value`);
  if (emailEnabled) {
    await sql(`insert into public.app_config (key, value) values ('functions_url', ${lit(functionsUrl)})
               on conflict (key) do update set value = excluded.value`);
  } else {
    await sql(`delete from public.app_config where key = 'functions_url'`);
  }
  log(`Report-ready emails: ${emailEnabled ? 'on' : 'off (in-app notifications only)'}`);

  // 7. First administrator ------------------------------------------------------
  const [{ admins }] = await sql(`select count(*)::int as admins from public.profiles where role = 'admin'`);
  if (admins > 0) {
    log(`Administrators: ${admins} (bootstrap skipped)`);
  } else if (!ADMIN_EMAIL) {
    warn('No administrator yet. Set the ADMIN_EMAIL secret and re-run this workflow.');
  } else {
    mask(ADMIN_EMAIL);
    const existing = await sql(`select id from public.profiles where lower(email) = ${lit(ADMIN_EMAIL)}`);
    if (!existing.length) {
      const res = await fetch(`${PROJECT_URL}/auth/v1/invite?redirect_to=${encodeURIComponent(SITE_URL)}`, {
        method: 'POST',
        headers: { apikey: secret, ...(secret.startsWith('eyJ') ? { Authorization: `Bearer ${secret}` } : {}), 'Content-Type': 'application/json' },
        body: JSON.stringify({ email: ADMIN_EMAIL, data: { full_name: 'Administrator' } }),
      });
      if (!res.ok) {
        const t = (await res.text()).slice(0, 300);
        warn(`Could not email the admin invitation (${res.status}: ${t}). Without RESEND_API_KEY, Supabase only emails members of your Supabase organisation. Invite ADMIN_EMAIL from the Supabase dashboard (Authentication → Users → Invite user), then re-run this workflow.`);
      }
    }
    const promoted = await sql(`update public.profiles set role = 'admin' where lower(email) = ${lit(ADMIN_EMAIL)} and role is null returning id`);
    if (promoted.length) {
      await sql(`insert into public.audit_log (action, detail) values ('user.role_set', jsonb_build_object('user', ${lit(promoted[0].id)}, 'role', 'admin', 'by', 'deploy workflow'))`);
      log('Administrator: invited and given the admin role. Check the ADMIN_EMAIL inbox for the invitation.');
    }
  }

  // 8. Outputs for the site build --------------------------------------------
  if (process.env.GITHUB_OUTPUT) {
    appendFileSync(process.env.GITHUB_OUTPUT, `supabase_url=${PROJECT_URL}\npublishable_key=${publishable}\n`);
  }
  log('Backend ready.');
}

main().catch((e) => fail(e.message));
