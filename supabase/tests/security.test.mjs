// Security tests for the reporting workflow, run against a local Supabase stack.
//   SUPABASE_URL=http://127.0.0.1:54321 SUPABASE_PUBLISHABLE_KEY=... SUPABASE_SECRET_KEY=... \
//   DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres node supabase/tests/security.test.mjs
// Each check is an attack that must fail or an action that must succeed.

import { createClient } from '@supabase/supabase-js';
import { createHmac, randomBytes } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const URL = process.env.SUPABASE_URL;
const PUB = process.env.SUPABASE_PUBLISHABLE_KEY;
const SECRET = process.env.SUPABASE_SECRET_KEY;
const DB = process.env.DB_URL;
const PASSWORD = 'Correct-Horse-Battery-9';

let pass = 0, fail = 0;
function check(name, ok, extra = '') {
  if (ok) { pass++; console.log(`  ✓ ${name}`); }
  else { fail++; console.log(`  ✗ ${name} ${extra}`); }
}
const sql = (q) => execFileSync('psql', [DB, '-tAc', q], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();

// RFC 6238 TOTP, so tests can complete real two-factor sign-in.
function base32Decode(s) {
  const alpha = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';
  let bits = '';
  for (const c of s.replace(/=+$/, '').toUpperCase()) bits += alpha.indexOf(c).toString(2).padStart(5, '0');
  const out = [];
  for (let i = 0; i + 8 <= bits.length; i += 8) out.push(parseInt(bits.slice(i, i + 8), 2));
  return Buffer.from(out);
}
function totp(secret, t = Date.now()) {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(Math.floor(t / 30000)));
  const h = createHmac('sha1', base32Decode(secret)).update(counter).digest();
  const o = h[h.length - 1] & 0xf;
  const code = ((h.readUInt32BE(o) & 0x7fffffff) % 1e6).toString().padStart(6, '0');
  return code;
}

const admin = createClient(URL, SECRET, { auth: { persistSession: false } });
const client = () => createClient(URL, PUB, { auth: { persistSession: false, autoRefreshToken: false } });

async function makeUser(email, role, { mfa = true } = {}) {
  const { data, error } = await admin.auth.admin.createUser({ email, password: PASSWORD, email_confirm: true, user_metadata: { full_name: email.split('@')[0] } });
  if (error) throw error;
  if (role) sql(`update public.profiles set role='${role}' where id='${data.user.id}'`);
  const c = client();
  const { error: e2 } = await c.auth.signInWithPassword({ email, password: PASSWORD });
  if (e2) throw e2;
  if (mfa) {
    const { data: f, error: e3 } = await c.auth.mfa.enroll({ factorType: 'totp', friendlyName: 'test' });
    if (e3) throw e3;
    const { error: e4 } = await c.auth.mfa.challengeAndVerify({ factorId: f.id, code: totp(f.totp.secret) });
    if (e4) throw e4;
  }
  return { c, id: data.user.id, email };
}

const DCM = new Blob([new Uint8Array(256).fill(7)], { type: 'application/dicom' });

async function main() {
  const tag = randomBytes(3).toString('hex');
  console.log('Creating users…');
  const up1 = await makeUser(`uploader1-${tag}@test.local`, 'uploader');
  const up2 = await makeUser(`uploader2-${tag}@test.local`, 'uploader');
  const rad1 = await makeUser(`rad1-${tag}@test.local`, 'radiologist');
  const rad2 = await makeUser(`rad2-${tag}@test.local`, 'radiologist');
  const adm = await makeUser(`admin-${tag}@test.local`, 'admin');
  const nobody = await makeUser(`norole-${tag}@test.local`, null);
  const noMfa = await makeUser(`nomfa-${tag}@test.local`, 'uploader', { mfa: false });
  const anon = client();

  console.log('\nSign-up and two-factor');
  {
    const { error } = await client().auth.signUp({ email: `self-${tag}@test.local`, password: PASSWORD });
    check('public self sign-up is disabled', !!error, error?.message);
    const r = await noMfa.c.rpc('create_study', { p_case_label: 'x', p_clinical_details: '', p_modality: '', p_summary: '' });
    check('password-only (aal1) session cannot create a study', !!r.error);
    const s = await noMfa.c.from('studies').select('id');
    check('aal1 session reads no studies', (s.data ?? []).length === 0);
    const p = await noMfa.c.from('profiles').select('email').eq('id', noMfa.id);
    check('aal1 session can read its own profile only', p.data?.length === 1);
    const r2 = await anon.rpc('create_study', { p_case_label: 'x', p_clinical_details: '', p_modality: '', p_summary: '' });
    check('anonymous caller cannot call functions', !!r2.error);
    const s2 = await anon.from('studies').select('id');
    check('anonymous caller reads nothing', !!s2.error || (s2.data ?? []).length === 0);
  }

  console.log('\nUpload');
  const { data: study1, error: cErr } = await up1.c.rpc('create_study', { p_case_label: 'Case A', p_clinical_details: 'Headache', p_modality: 'CT', p_summary: '1 series' });
  check('uploader creates a study', !cErr && !!study1, cErr?.message);
  const { data: study2 } = await up2.c.rpc('create_study', { p_case_label: 'Case B', p_clinical_details: '', p_modality: 'MR', p_summary: '' });
  {
    const r = await rad1.c.rpc('create_study', { p_case_label: 'x', p_clinical_details: '', p_modality: '', p_summary: '' });
    check('radiologist cannot create studies', !!r.error);
    const u = await up1.c.storage.from('dicom').upload(`${study1}/0001.dcm`, DCM, { contentType: 'application/dicom' });
    check('uploader uploads to own study', !u.error, u.error?.message);
    const f = await up1.c.from('study_files').insert({ study_id: study1, path: `${study1}/0001.dcm`, size_bytes: 256 });
    check('uploader registers the file', !f.error, f.error?.message);
    const x1 = await up1.c.storage.from('dicom').upload(`${study2}/evil.dcm`, DCM, { contentType: 'application/dicom' });
    check("uploader cannot upload into another uploader's study", !!x1.error);
    const x2 = await up1.c.storage.from('dicom').upload(`evil.dcm`, DCM, { contentType: 'application/dicom' });
    check('uploader cannot upload outside a study folder', !!x2.error);
    const x3 = await up1.c.storage.from('dicom').upload(`${study1}/a/b.dcm`, DCM, { contentType: 'application/dicom' });
    check('uploader cannot create nested paths', !!x3.error);
    const x4 = await up1.c.storage.from('dicom').upload(`${study1}/0002.html`, new Blob(['<script>'], { type: 'text/html' }), { contentType: 'text/html' });
    check('non-DICOM content type is rejected', !!x4.error);
    const x5 = await up1.c.from('study_files').insert({ study_id: study2, path: `${study2}/x.dcm`, size_bytes: 1 });
    check("uploader cannot register files in another's study", !!x5.error);
    const x6 = await up1.c.from('study_files').insert({ study_id: study1, path: `${study2}/x.dcm`, size_bytes: 1 });
    check('file path must sit inside its study', !!x6.error);
    const x7 = await up1.c.from('studies').update({ status: 'reported' }).eq('id', study1);
    const st = sql(`select status from public.studies where id='${study1}'`);
    check('uploader cannot change study status directly', st === 'uploading', `${x7.error?.message} status=${st}`);
    const before = await rad1.c.from('studies').select('id').eq('id', study1);
    check('radiologist cannot see a study before it is submitted', (before.data ?? []).length === 0);
    const sub = await up1.c.rpc('submit_study', { p_study: study1 });
    check('uploader submits the study', !sub.error, sub.error?.message);
    const late = await up1.c.storage.from('dicom').upload(`${study1}/0003.dcm`, DCM, { contentType: 'application/dicom' });
    check('no uploads after submission', !!late.error);
    const del = await up1.c.storage.from('dicom').remove([`${study1}/0001.dcm`]);
    const still = sql(`select count(*) from storage.objects where name='${study1}/0001.dcm'`);
    check('submitted files cannot be deleted', still === '1', JSON.stringify(del));
    const subEmpty = await up2.c.rpc('submit_study', { p_study: study2 });
    check('an empty study cannot be submitted', !!subEmpty.error);
  }

  console.log('\nVisibility');
  {
    const a = await up2.c.from('studies').select('id').eq('id', study1);
    check("uploader cannot see another uploader's study", (a.data ?? []).length === 0);
    const d = await up2.c.storage.from('dicom').download(`${study1}/0001.dcm`);
    check("uploader cannot download another uploader's images", !!d.error);
    const n = await nobody.c.from('studies').select('id');
    check('account without a role sees nothing', (n.data ?? []).length === 0);
    const nd = await nobody.c.storage.from('dicom').download(`${study1}/0001.dcm`);
    check('account without a role cannot download images', !!nd.error);
    const r = await rad1.c.from('studies').select('id, case_label, clinical_details').eq('id', study1);
    check('radiologist sees the submitted study on the worklist', r.data?.length === 1);
    const rd = await rad1.c.storage.from('dicom').download(`${study1}/0001.dcm`);
    check('radiologist can download submitted images', !rd.error && rd.data?.size === 256);
    const ad = await adm.c.storage.from('dicom').download(`${study1}/0001.dcm`);
    check('admin cannot download images', !!ad.error);
    const as = await adm.c.from('studies').select('id').eq('id', study1);
    check('admin can see study metadata', as.data?.length === 1);
    const anonD = await anon.storage.from('dicom').download(`${study1}/0001.dcm`);
    check('anonymous caller cannot download images', !!anonD.error);
    const pub = await fetch(`${URL}/storage/v1/object/public/dicom/${study1}/0001.dcm`);
    check('bucket is not public', pub.status >= 400, `status ${pub.status}`);
  }

  console.log('\nReporting');
  {
    const c1 = await rad1.c.rpc('claim_study', { p_study: study1 });
    check('radiologist 1 claims the study', !c1.error, c1.error?.message);
    const c2 = await rad2.c.rpc('claim_study', { p_study: study1 });
    check('radiologist 2 cannot claim the same study', !!c2.error);
    const v2 = await rad2.c.from('studies').select('id').eq('id', study1);
    check('claimed study disappears from radiologist 2', (v2.data ?? []).length === 0);
    const d2 = await rad2.c.storage.from('dicom').download(`${study1}/0001.dcm`);
    check('radiologist 2 can no longer download the images', !!d2.error);
    const s2 = await rad2.c.rpc('save_report_draft', { p_study: study1, p_body: 'hijack' });
    check("radiologist 2 cannot write radiologist 1's report", !!s2.error);
    const s1 = await rad1.c.rpc('save_report_draft', { p_study: study1, p_body: 'Draft findings so far' });
    check('radiologist 1 saves a draft', !s1.error, s1.error?.message);
    const ud = await up1.c.from('reports').select('body').eq('study_id', study1);
    check('uploader cannot read a draft', (ud.data ?? []).length === 0);
    const direct = await rad1.c.from('reports').update({ status: 'final' }).eq('study_id', study1);
    const rs = sql(`select status from public.reports where study_id='${study1}'`);
    check('report cannot be finalised by direct table write', rs === 'draft', direct.error?.message);
    const short = await rad1.c.rpc('sign_report', { p_study: study1, p_body: 'ok' });
    check('an empty or trivial report cannot be signed', !!short.error);
    const sign = await rad1.c.rpc('sign_report', { p_study: study1, p_body: 'No acute intracranial abnormality.' });
    check('radiologist 1 signs the report', !sign.error, sign.error?.message);
    const again = await rad1.c.rpc('save_report_draft', { p_study: study1, p_body: 'changed' });
    check('signed report cannot be edited', !!again.error);
    let trig = false;
    try { sql(`update public.reports set body='tampered' where study_id='${study1}'`); } catch { trig = true; }
    check('signed report is protected even from the database owner (trigger)', trig);
    const ur = await up1.c.from('reports').select('body, signed_by_name, signed_at').eq('study_id', study1).single();
    check('uploader reads the signed report', ur.data?.body === 'No acute intracranial abnormality.' && !!ur.data?.signed_at, ur.error?.message);
    const u2r = await up2.c.from('reports').select('body').eq('study_id', study1);
    check("other uploader cannot read the report", (u2r.data ?? []).length === 0);
    const n = await up1.c.from('notifications').select('id, kind, read_at').eq('study_id', study1);
    check('uploader receives an in-app notification', n.data?.length === 1 && n.data[0].kind === 'report_ready');
    const n2 = await up2.c.from('notifications').select('id');
    check('other uploader receives no notification', (n2.data ?? []).length === 0);
    const mr = await up1.c.rpc('mark_notifications_read', { p_ids: [n.data[0].id] });
    const n3 = await up1.c.from('notifications').select('read_at').eq('id', n.data[0].id).single();
    check('uploader marks the notification read', !mr.error && !!n3.data?.read_at);
  }

  console.log('\nRoles and audit');
  {
    const self = await up1.c.from('profiles').update({ role: 'admin' }).eq('id', up1.id);
    const r = sql(`select role from public.profiles where id='${up1.id}'`);
    check('user cannot promote themselves', r === 'uploader', self.error?.message);
    const a = await up1.c.rpc('admin_set_role', { p_user: up1.id, p_role: 'admin' });
    check('non-admin cannot assign roles', !!a.error);
    const ok = await adm.c.rpc('admin_set_role', { p_user: nobody.id, p_role: 'radiologist' });
    check('admin assigns a role', !ok.error, ok.error?.message);
    const others = await up1.c.from('profiles').select('id');
    check('users cannot list other users', others.data?.length === 1);
    const la = await up1.c.from('audit_log').select('id');
    check('non-admin cannot read the audit log', (la.data ?? []).length === 0);
    const aa = await adm.c.from('audit_log').select('action').eq('study_id', study1);
    const actions = (aa.data ?? []).map((x) => x.action);
    check('audit log records the workflow', ['study.created', 'study.submitted', 'study.claimed', 'report.signed'].every((x) => actions.includes(x)), actions.join(','));
    let blocked = false;
    try { sql(`delete from public.audit_log where study_id='${study1}'`); } catch { blocked = true; }
    check('audit log cannot be deleted, even by the database owner', blocked);
  }

  console.log('\nAddenda');
  {
    const original = sql(`select body from public.reports where study_id='${study1}'`);
    const text = 'Addendum: on review the lesion measures 32 mm, not 30 mm.';
    const r2 = await rad2.c.rpc('add_report_addendum', { p_study: study1, p_body: 'I did not report this case.' });
    check('another radiologist cannot add an addendum', !!r2.error);
    const u = await up1.c.rpc('add_report_addendum', { p_study: study1, p_body: 'Uploader trying to amend.' });
    check('uploader cannot add an addendum', !!u.error);
    const a1 = await adm.c.rpc('add_report_addendum', { p_study: study1, p_body: 'Admin trying to amend.' });
    check('admin cannot add an addendum', !!a1.error);
    const aal1 = await noMfa.c.rpc('add_report_addendum', { p_study: study1, p_body: 'Password-only session.' });
    check('password-only session cannot add an addendum', !!aal1.error);
    const short = await rad1.c.rpc('add_report_addendum', { p_study: study1, p_body: '  ok  ' });
    check('an empty or trivial addendum is refused', !!short.error);
    const direct = await rad1.c.from('report_addenda').insert({ study_id: study1, seq: 1, radiologist_id: rad1.id, body: 'Direct insert bypassing the function', signed_by_name: 'x' });
    check('addenda cannot be inserted directly', !!direct.error);
    const ok = await rad1.c.rpc('add_report_addendum', { p_study: study1, p_body: text });
    check('signing radiologist adds an addendum', !ok.error && !!ok.data, ok.error?.message);
    const ok2 = await rad1.c.rpc('add_report_addendum', { p_study: study1, p_body: 'Second addendum: no further change.' });
    check('a second addendum is numbered 2', !ok2.error && sql(`select string_agg(seq::text, ',' order by seq) from public.report_addenda where study_id='${study1}'`) === '1,2');
    check('the original report is unchanged', sql(`select body from public.reports where study_id='${study1}'`) === original);
    check('study records the addendum count', sql(`select addendum_count from public.studies where id='${study1}'`) === '2');
    let blocked = 0;
    for (const q of [`update public.report_addenda set body='tampered' where study_id='${study1}'`, `delete from public.report_addenda where study_id='${study1}'`]) {
      try { sql(q); } catch { blocked++; }
    }
    check('addenda cannot be edited or deleted, even by the database owner', blocked === 2 && sql(`select count(*) from public.report_addenda where study_id='${study1}' and body='${text.replace(/'/g, "''")}'`) === '1');
    const rd = await rad1.c.from('report_addenda').update({ body: 'x' }).eq('study_id', study1).select();
    check('radiologist cannot edit an addendum via the API', !!rd.error || (rd.data ?? []).length === 0);
    const ur = await up1.c.from('report_addenda').select('seq, body, signed_by_name').eq('study_id', study1).order('seq');
    check('uploader reads the addenda in order', ur.data?.length === 2 && ur.data[0].body === text && !!ur.data[0].signed_by_name, ur.error?.message);
    const u2 = await up2.c.from('report_addenda').select('id').eq('study_id', study1);
    check('other uploader cannot read the addenda', (u2.data ?? []).length === 0);
    const r2r = await rad2.c.from('report_addenda').select('id').eq('study_id', study1);
    check('other radiologist cannot read the addenda', (r2r.data ?? []).length === 0);
    const ar = await adm.c.from('report_addenda').select('id').eq('study_id', study1);
    check('admin cannot read the addenda', (ar.data ?? []).length === 0);
    const n = await up1.c.from('notifications').select('kind').eq('study_id', study1).eq('kind', 'report_addended');
    check('uploader is notified of each addendum', n.data?.length === 2);
    const n2 = await up2.c.from('notifications').select('id').eq('kind', 'report_addended');
    check('other uploader is not notified', (n2.data ?? []).length === 0);
    const audits = (await adm.c.from('audit_log').select('action').eq('study_id', study1)).data.map((x) => x.action);
    check('addenda are audited', audits.filter((a) => a === 'report.addendum_signed').length === 2);
    // An addendum needs a signed report: try on a claimed, unsigned case.
    const { data: study3 } = await up1.c.rpc('create_study', { p_case_label: 'Case C', p_clinical_details: '', p_modality: 'CT', p_summary: '' });
    await up1.c.storage.from('dicom').upload(`${study3}/0001.dcm`, DCM, { contentType: 'application/dicom' });
    await up1.c.from('study_files').insert({ study_id: study3, path: `${study3}/0001.dcm`, size_bytes: 256 });
    await up1.c.rpc('submit_study', { p_study: study3 });
    await rad1.c.rpc('claim_study', { p_study: study3 });
    const draft = await rad1.c.rpc('add_report_addendum', { p_study: study3, p_body: 'Addendum on an unsigned draft.' });
    check('no addendum before the report is signed', !!draft.error);
    if (process.env.EXPECT_EMAIL) {
      let sent = '';
      for (let i = 0; i < 20 && sent !== '2'; i++) {
        await new Promise((r) => setTimeout(r, 500));
        sent = sql(`select count(*) from public.notifications where study_id='${study1}' and kind='report_addended' and emailed_at is not null`);
      }
      check('an email is sent for each addendum', sent === '2', sent);
    }
  }

  console.log('\nEmail notification');
  {
    const FN = `${URL}/functions/v1`;
    let emailed = '';
    for (let i = 0; i < 20 && emailed !== 't'; i++) {
      await new Promise((r) => setTimeout(r, 500));
      emailed = sql(`select emailed_at is not null from public.notifications where study_id='${study1}' and kind='report_ready'`);
    }
    if (process.env.EXPECT_EMAIL) check('signing queued and sent exactly one email', emailed === 't');
    const nid = sql(`select id from public.notifications where study_id='${study1}' and kind='report_ready'`);
    const replay = await fetch(`${FN}/notify-email`, { method: 'POST', body: JSON.stringify({ notification_id: Number(nid) }) });
    const rj = await replay.json();
    check('replaying the email call sends nothing', replay.status === 200 && (rj.skipped === true || typeof rj.skipped === 'string'), JSON.stringify(rj));
    const forged = await fetch(`${FN}/notify-email`, { method: 'POST', body: JSON.stringify({ notification_id: 999999 }) });
    const fj = await forged.json();
    check('a forged notification id sends nothing', !fj.sent, JSON.stringify(fj));
  }

  console.log('\nUser management function');
  {
    const FN = `${URL}/functions/v1/admin-users`;
    const call = async (c, body) => {
      const token = c ? (await c.auth.getSession()).data.session?.access_token : null;
      const r = await fetch(FN, { method: 'POST', headers: { 'Content-Type': 'application/json', ...(token ? { Authorization: `Bearer ${token}` } : {}) }, body: JSON.stringify(body) });
      return { status: r.status, body: await r.json().catch(() => ({})) };
    };
    const inv = { action: 'invite', email: `invitee-${tag}@test.local`, role: 'radiologist', full_name: 'Invitee' };
    check('no token: refused', (await call(null, inv)).status === 403);
    check('uploader: refused', (await call(up1.c, inv)).status === 403);
    check('radiologist: refused', (await call(rad1.c, inv)).status === 403);
    const aal1Admin = await makeUser(`admin-nomfa-${tag}@test.local`, 'admin', { mfa: false });
    check('admin without two-factor: refused', (await call(aal1Admin.c, inv)).status === 403);
    const forgedTok = (await adm.c.auth.getSession()).data.session.access_token.split('.');
    const payload = JSON.parse(Buffer.from(forgedTok[1], 'base64url'));
    const tampered = [forgedTok[0], Buffer.from(JSON.stringify({ ...payload, sub: up1.id })).toString('base64url'), forgedTok[2]].join('.');
    const tr = await fetch(FN, { method: 'POST', headers: { Authorization: `Bearer ${tampered}` }, body: JSON.stringify(inv) });
    check('tampered token: refused', tr.status === 403);
    const ok = await call(adm.c, inv);
    check('admin invites a user', ok.status === 200 && ok.body.ok, JSON.stringify(ok.body));
    const role = sql(`select role from public.profiles where email='${inv.email}'`);
    check('invited user gets the chosen role', role === 'radiologist', role);
    check('duplicate invitation refused', (await call(adm.c, inv)).status === 409);
    check('invalid role refused', (await call(adm.c, { ...inv, email: `x-${tag}@test.local`, role: 'superuser' })).status === 400);
    const before = (await admin.auth.admin.mfa.listFactors({ userId: rad2.id })).data.factors.length;
    const rm = await call(adm.c, { action: 'reset_mfa', user_id: rad2.id });
    const after = (await admin.auth.admin.mfa.listFactors({ userId: rad2.id })).data.factors.length;
    check('admin resets a user\'s two-factor', rm.status === 200 && before === 1 && after === 0, JSON.stringify(rm.body));
    check('non-admin cannot reset two-factor', (await call(up1.c, { action: 'reset_mfa', user_id: up2.id })).status === 403);
    const rv = await adm.c.rpc('admin_set_role', { p_user: up2.id, p_role: null });
    const gone = await up2.c.from('studies').select('id');
    check('revoking a role removes access immediately', !rv.error && (gone.data ?? []).length === 0, rv.error?.message);
    const acts = (await adm.c.from('audit_log').select('action')).data.map((x) => x.action);
    check('invites, two-factor resets and revocations are audited', ['user.invited', 'user.mfa_reset', 'user.access_revoked'].every((a) => acts.includes(a)));
  }

  console.log(`\n${pass} passed, ${fail} failed`);
  process.exit(fail ? 1 : 0);
}

main().catch((e) => { console.error(e); process.exit(1); });
