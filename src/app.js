// Entry point: sign-in (password + mandatory two-factor), role routing,
// idle sign-out. All authorisation is enforced by the database; the browser
// checks here only decide which screen to show.

import { supabase, isConfigured, IDLE_MINUTES, urlAuth, must } from './supabase.js';
import { initViewerUI } from './viewer-ui.js';
import { enterApp } from './pages.js';

const $ = (id) => document.getElementById(id);
const STEPS = ['form-login', 'form-forgot', 'form-mfa-enrol', 'form-mfa', 'form-password', 'step-no-role', 'step-config'];

let needsPassword = urlAuth.type === 'invite' || urlAuth.type === 'recovery';
let enrolFactorId = null;
let entered = false;
let busy = false;

function showStep(id) {
  $('boot').hidden = true;
  $('app').hidden = true;
  $('auth').hidden = false;
  for (const s of STEPS) $(s).hidden = s !== id;
  $(id).querySelector('input')?.focus();
}

function authMessage(kind, text) {
  const other = kind === 'error' ? 'info' : 'error';
  $(`auth-${other}`).hidden = true;
  const el = $(`auth-${kind}`);
  el.textContent = text || '';
  el.hidden = !text;
}
const authError = (t) => authMessage('error', t);
const authInfo = (t) => authMessage('info', t);

async function guarded(form, fn) {
  if (busy) return;
  busy = true;
  const button = form.querySelector('button[type="submit"]');
  if (button) button.disabled = true;
  authError('');
  try { await fn(); }
  catch (err) { authError(err.message || String(err)); }
  finally { busy = false; if (button) button.disabled = false; }
}

// ---------- Routing between steps ----------

async function route() {
  const { data: { session } } = await supabase.auth.getSession();
  if (!session) { entered = false; showStep('form-login'); return; }

  const aal = must(await supabase.auth.mfa.getAuthenticatorAssuranceLevel());
  if (aal.currentLevel !== 'aal2') {
    if (aal.nextLevel === 'aal2') showStep('form-mfa');
    else await startEnrol();
    return;
  }
  if (needsPassword) { showStep('form-password'); return; }

  const profile = must(await supabase.from('profiles')
    .select('id, email, full_name, role').eq('id', session.user.id).single());
  if (!profile.role) { showStep('step-no-role'); return; }

  if (!entered) {
    entered = true;
    authError(''); authInfo('');
    $('auth').hidden = true;
    $('boot').hidden = true;
    $('app').hidden = false;
    startIdleTimer();
    await enterApp(profile);
  }
}

async function startEnrol() {
  // Remove any half-finished enrolment so a fresh QR code can be issued.
  const factors = must(await supabase.auth.mfa.listFactors());
  for (const f of factors.all.filter((x) => x.status !== 'verified')) {
    await supabase.auth.mfa.unenroll({ factorId: f.id });
  }
  const data = must(await supabase.auth.mfa.enroll({
    factorType: 'totp', friendlyName: 'Authenticator app', issuer: 'DICOM Reporting',
  }));
  enrolFactorId = data.id;
  $('mfa-qr').src = data.totp.qr_code;
  $('mfa-secret').textContent = data.totp.secret;
  showStep('form-mfa-enrol');
}

// ---------- Forms ----------

function wireForms() {
  $('form-login').addEventListener('submit', (e) => {
    e.preventDefault();
    guarded(e.target, async () => {
      authInfo('');
      const { error } = await supabase.auth.signInWithPassword({
        email: $('login-email').value.trim(),
        password: $('login-password').value,
      });
      $('login-password').value = '';
      // Same message whatever the cause, so accounts cannot be enumerated.
      if (error) throw new Error('Email or password not recognised, or too many attempts. Try again shortly.');
      await route();
    });
  });

  $('btn-show-forgot').onclick = () => { authError(''); showStep('form-forgot'); };
  document.querySelectorAll('[data-back-to-login]').forEach((b) => { b.onclick = () => { authError(''); showStep('form-login'); }; });

  $('form-forgot').addEventListener('submit', (e) => {
    e.preventDefault();
    guarded(e.target, async () => {
      const redirectTo = window.location.href.split('#')[0];
      await supabase.auth.resetPasswordForEmail($('forgot-email').value.trim(), { redirectTo });
      authInfo('If that address has an account, a reset link is on its way. It expires after a short time.');
      showStep('form-login');
    });
  });

  $('form-mfa-enrol').addEventListener('submit', (e) => {
    e.preventDefault();
    guarded(e.target, async () => {
      must(await supabase.auth.mfa.challengeAndVerify({ factorId: enrolFactorId, code: $('mfa-enrol-code').value.trim() }));
      $('mfa-enrol-code').value = '';
      $('mfa-secret').textContent = '';
      $('mfa-qr').removeAttribute('src');
      await route();
    });
  });

  $('form-mfa').addEventListener('submit', (e) => {
    e.preventDefault();
    guarded(e.target, async () => {
      const factors = must(await supabase.auth.mfa.listFactors());
      const totp = factors.totp[0];
      if (!totp) throw new Error('No authenticator is registered for this account. Contact your administrator.');
      const { error } = await supabase.auth.mfa.challengeAndVerify({ factorId: totp.id, code: $('mfa-code').value.trim() });
      $('mfa-code').value = '';
      if (error) throw new Error('That code was not accepted. Codes change every 30 seconds — try the current one.');
      await route();
    });
  });

  $('form-password').addEventListener('submit', (e) => {
    e.preventDefault();
    guarded(e.target, async () => {
      const p1 = $('new-password').value;
      const p2 = $('new-password-2').value;
      if (p1 !== p2) throw new Error('The passwords do not match.');
      if (p1.length < 12 || !/[a-z]/.test(p1) || !/[A-Z]/.test(p1) || !/[0-9]/.test(p1)) {
        throw new Error('Use at least 12 characters with upper- and lower-case letters and a number.');
      }
      must(await supabase.auth.updateUser({ password: p1 }));
      $('new-password').value = ''; $('new-password-2').value = '';
      needsPassword = false;
      authInfo('Password saved.');
      await route();
    });
  });

  document.addEventListener('click', (e) => {
    if (e.target.closest('[data-signout]')) signOut();
  });
}

// ---------- Sign-out and idle timeout ----------

export async function signOut(reason) {
  try { await supabase.auth.signOut(); } catch { /* still clear local state */ }
  sessionStorage.clear();
  if (reason) sessionStorage.setItem('signout-reason', reason);
  // Reloading discards every image and report held in memory.
  window.location.replace(window.location.pathname);
}

function startIdleTimer() {
  let timer;
  const reset = () => {
    clearTimeout(timer);
    timer = setTimeout(() => signOut(`Signed out after ${IDLE_MINUTES} minutes of inactivity.`), IDLE_MINUTES * 60_000);
  };
  ['pointerdown', 'keydown', 'wheel', 'touchstart'].forEach((ev) => window.addEventListener(ev, reset, { passive: true }));
  reset();
}

// ---------- Boot ----------

async function boot() {
  if (!isConfigured) { showStep('step-config'); return; }
  wireForms();
  await initViewerUI();

  const reason = sessionStorage.getItem('signout-reason');
  if (reason) { sessionStorage.removeItem('signout-reason'); authInfo(reason); }
  if (urlAuth.error) authError(`That link is invalid or has expired (${urlAuth.error}). Ask for a new one.`);

  supabase.auth.onAuthStateChange((event) => {
    if (event === 'PASSWORD_RECOVERY') needsPassword = true;
    if (event === 'SIGNED_OUT' && entered) window.location.replace(window.location.pathname);
  });

  // Let the client finish reading an invite/recovery link, then tidy the URL.
  await supabase.auth.getSession();
  if (window.location.href.includes('#')) history.replaceState(null, '', window.location.pathname + window.location.search);

  try { await route(); }
  catch (err) { showStep('form-login'); authError(err.message); }
}

boot();
