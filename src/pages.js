// Role-based pages: uploader case list, radiologist worklist, admin users and
// audit log, notifications, and opening a case in the viewer.

import { supabase, must, callFunction } from './supabase.js';
import { h, fmtDateTime, shortRef, statusChip, table, caseLabel } from './dom.js';
import { loadFiles, resetViewerUI, setLocalLoading, showProgress, toast } from './viewer-ui.js';
import { renderCasePanel } from './casepanel.js';
import { startUpload } from './upload.js';

const $ = (id) => document.getElementById(id);
const PAGES = ['cases', 'worklist', 'admin', 'viewer'];

export const session = { profile: null, listPage: null, worklistTab: 'awaiting', openStudyId: null };

// ---------- Shell ----------

export async function enterApp(profile) {
  session.profile = profile;
  $('whoami').textContent = `${profile.full_name || profile.email} · ${profile.role}`;
  document.querySelectorAll('.navbtn').forEach((b) => {
    b.hidden = !b.dataset.roles.split(',').includes(profile.role);
    b.onclick = () => showPage(b.dataset.page);
  });
  document.querySelectorAll('[data-goto]').forEach((b) => { b.onclick = () => showPage(b.dataset.goto); });
  document.querySelectorAll('.tab[data-wl]').forEach((b) => {
    b.onclick = () => { session.worklistTab = b.dataset.wl; renderWorklist(); };
  });
  $('btn-back').onclick = () => showPage(session.listPage);
  $('btn-case').onclick = () => {
    const p = $('case-panel');
    p.hidden = !p.hidden;
    $('btn-case').setAttribute('aria-pressed', String(!p.hidden));
  };
  wireBell();
  if (profile.role !== 'admin') pollNotifications();

  const home = { uploader: 'cases', radiologist: 'worklist', admin: 'admin' }[profile.role];
  await showPage(home);
}

export async function showPage(name) {
  if (name !== 'viewer' && !$('page-viewer').hidden) {
    // Leaving the viewer: drop every image from memory.
    resetViewerUI();
    setLocalLoading(false);
    session.openStudyId = null;
  }
  if (name === 'upload') {
    session.listPage = 'cases';
    activateNav('upload');
    showSection('viewer');
    startUpload({ onDone: () => showPage('cases') });
    return;
  }
  if (name !== 'viewer') { session.listPage = name; activateNav(name); }
  showSection(name);
  if (name === 'cases') await renderCases();
  if (name === 'worklist') await renderWorklist();
  if (name === 'admin') await renderAdmin();
}

function showSection(name) {
  for (const p of PAGES) $(`page-${p}`).hidden = p !== name;
  if (name === 'viewer') window.dispatchEvent(new Event('resize'));
}

function activateNav(page) {
  document.querySelectorAll('.navbtn').forEach((b) => b.classList.toggle('active', b.dataset.page === page));
}

function errorBox(target, err) {
  target.replaceChildren(h('p', { class: 'error-box' }, `Could not load: ${err.message || err}`));
}

// ---------- Uploader: cases ----------

async function renderCases() {
  const target = $('cases-table');
  try {
    const rows = must(await supabase.from('studies')
      .select('id, case_label, modality, file_count, status, created_at, submitted_at, reported_at, addendum_count, anonymised')
      .order('created_at', { ascending: false }).limit(500));
    target.replaceChildren(table([
      { label: 'Ref', class: 'mono', render: (r) => shortRef(r.id) },
      { label: 'Case', render: caseLabel },
      { label: 'Modality', render: (r) => r.modality || '—' },
      { label: 'Files', class: 'num', render: (r) => r.file_count },
      { label: 'Submitted', render: (r) => fmtDateTime(r.submitted_at) },
      { label: 'Status', render: (r) => statusChip(r.status, r.addendum_count) },
      { label: 'Reported', render: (r) => fmtDateTime(r.reported_at) },
      {
        label: '', class: 'actions', render: (r) => (r.status === 'uploading'
          ? h('button', { class: 'btn small ghost', onclick: () => discardStudy(r) }, 'Discard')
          : h('button', { class: 'btn small', onclick: () => openCase(r.id) }, r.status === 'reported' ? 'View report' : 'Open')),
      },
    ], rows, 'No cases yet. Use “New upload” to send a scan for reporting.'));
  } catch (err) { errorBox(target, err); }
}

async function discardStudy(study) {
  if (!confirm(`Discard the incomplete upload “${study.case_label}”?`)) return;
  try {
    const files = must(await supabase.from('study_files').select('path').eq('study_id', study.id));
    if (files.length) must(await supabase.storage.from('dicom').remove(files.map((f) => f.path)));
    must(await supabase.rpc('discard_study', { p_study: study.id }));
    toast('Upload discarded.');
  } catch (err) { toast(err.message, 'error'); }
  renderCases();
}

// ---------- Radiologist: worklist ----------

async function renderWorklist() {
  document.querySelectorAll('.tab[data-wl]').forEach((b) => b.classList.toggle('active', b.dataset.wl === session.worklistTab));
  const target = $('worklist-table');
  const me = session.profile.id;
  try {
    let q = supabase.from('studies')
      .select('id, case_label, clinical_details, modality, summary, file_count, status, submitted_at, claimed_at, reported_at, addendum_count, anonymised');
    if (session.worklistTab === 'awaiting') q = q.eq('status', 'awaiting_report').order('submitted_at', { ascending: true });
    if (session.worklistTab === 'mine') q = q.eq('status', 'in_review').eq('radiologist_id', me).order('claimed_at', { ascending: true });
    if (session.worklistTab === 'done') q = q.eq('status', 'reported').eq('radiologist_id', me).order('reported_at', { ascending: false });
    const rows = must(await q.limit(500));
    const when = { awaiting: 'submitted_at', mine: 'claimed_at', done: 'reported_at' }[session.worklistTab];
    target.replaceChildren(table([
      { label: 'Ref', class: 'mono', render: (r) => shortRef(r.id) },
      { label: 'Case', render: caseLabel },
      { label: 'Clinical details', class: 'clip', render: (r) => r.clinical_details || '—' },
      { label: 'Modality', render: (r) => r.modality || '—' },
      { label: 'Images', class: 'num', render: (r) => r.file_count },
      { label: { submitted_at: 'Submitted', claimed_at: 'Claimed', reported_at: 'Reported' }[when], render: (r) => fmtDateTime(r[when]) },
      ...(session.worklistTab === 'done' ? [{ label: 'Addenda', class: 'num', render: (r) => r.addendum_count || '—' }] : []),
      { label: '', class: 'actions', render: (r) => h('button', { class: 'btn small', onclick: () => openCase(r.id) }, session.worklistTab === 'done' ? 'View' : 'Open') },
    ], rows, {
      awaiting: 'No studies are waiting for a report.',
      mine: 'You have no reports in progress.',
      done: 'You have not signed any reports yet.',
    }[session.worklistTab]));
  } catch (err) { errorBox(target, err); }
}

// ---------- Admin ----------

function inviteForm() {
  const email = h('input', { type: 'email', required: true, placeholder: 'name@nhs.net', autocomplete: 'off', 'aria-label': 'Email' });
  const name = h('input', { maxlength: 120, placeholder: 'Full name', autocomplete: 'off', 'aria-label': 'Full name' });
  const role = h('select', { 'aria-label': 'Role' },
    h('option', { value: 'uploader' }, 'Uploader'), h('option', { value: 'radiologist' }, 'Radiologist'), h('option', { value: 'admin' }, 'Admin'));
  const result = h('div', { class: 'invite-result' });
  const button = h('button', { class: 'btn primary', type: 'submit' }, 'Invite');
  const form = h('form', { class: 'invite-form', novalidate: true }, email, name, role, button);
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    result.replaceChildren();
    if (!email.value.trim()) { email.focus(); return; }
    button.disabled = true;
    try {
      const out = await callFunction('admin-users', { action: 'invite', email: email.value.trim(), full_name: name.value.trim(), role: role.value });
      if (out.emailed) {
        result.replaceChildren(h('p', { class: 'ok-box' }, `Invitation emailed to ${email.value.trim()}.`));
      } else {
        const linkBox = h('input', { class: 'link-box', readonly: true, value: out.link || '' });
        result.replaceChildren(h('div', { class: 'warn-box' },
          h('p', {}, `Email isn't set up, so send this one-time sign-up link to ${email.value.trim()} yourself, by secure email (e.g. NHSmail) only. Anyone with the link can claim the account. It works once and expires after 24 hours.`),
          h('div', { class: 'copy-row' }, linkBox,
            h('button', { class: 'btn small', type: 'button', onclick: async () => { await navigator.clipboard.writeText(linkBox.value); toast('Link copied.'); } }, 'Copy'))));
      }
      email.value = ''; name.value = '';
      renderAdminUsers();
      renderAudit();
    } catch (err) {
      result.replaceChildren(h('p', { class: 'error-box' }, err.message));
    }
    button.disabled = false;
  });
  return h('div', {}, form, result);
}

async function renderAdmin() {
  const holder = $('invite-holder');
  if (!holder.firstChild) holder.append(inviteForm());
  await Promise.all([renderAdminUsers(), renderAudit()]);
}

async function renderAdminUsers() {
  const users = $('users-table');
  try {
    const rows = must(await supabase.from('profiles').select('id, email, full_name, role, created_at').order('created_at'));
    users.replaceChildren(table([
      { label: 'Name', render: (r) => r.full_name || '—' },
      { label: 'Email', render: (r) => r.email },
      { label: 'Added', render: (r) => fmtDateTime(r.created_at) },
      {
        label: 'Role', render: (r) => {
          if (r.id === session.profile.id) return h('span', { class: 'muted' }, `${r.role} (you)`);
          const sel = h('select', { 'aria-label': `Role for ${r.email}` },
            h('option', { value: '' }, 'No access'),
            ['uploader', 'radiologist', 'admin'].map((role) => h('option', { value: role, selected: r.role === role }, role)));
          if (!r.role) sel.value = '';
          sel.onchange = async () => {
            const next = sel.value || null;
            const msg = next ? `Give ${r.email} the ${next} role?` : `Remove all access for ${r.email}? They will be locked out immediately.`;
            if (!confirm(msg)) { sel.value = r.role || ''; return; }
            try { must(await supabase.rpc('admin_set_role', { p_user: r.id, p_role: next })); toast(next ? 'Role updated.' : 'Access removed.'); }
            catch (err) { toast(err.message, 'error'); }
            renderAdmin();
          };
          return sel;
        },
      },
      {
        label: '', class: 'actions', render: (r) => (r.id === session.profile.id ? '' : h('button', {
          class: 'btn small ghost',
          title: 'Use when someone has lost their phone or authenticator app',
          onclick: async () => {
            if (!confirm(`Reset two-factor for ${r.email}? They will set up their authenticator app again at next sign-in.`)) return;
            try { const out = await callFunction('admin-users', { action: 'reset_mfa', user_id: r.id }); toast(out.removed ? 'Two-factor reset.' : 'They had no authenticator set up.'); }
            catch (err) { toast(err.message, 'error'); }
            renderAudit();
          },
        }, 'Reset 2FA')),
      },
    ], rows));
  } catch (err) { errorBox(users, err); }
}

async function renderAudit() {
  const audit = $('audit-table');
  try {
    const rows = must(await supabase.from('audit_log').select('at, actor_email, action, study_id, detail')
      .order('at', { ascending: false }).limit(200));
    audit.replaceChildren(table([
      { label: 'When', render: (r) => fmtDateTime(r.at) },
      { label: 'Who', render: (r) => r.actor_email || '—' },
      { label: 'Action', class: 'mono', render: (r) => r.action },
      { label: 'Case', class: 'mono', render: (r) => (r.study_id ? shortRef(r.study_id) : '—') },
      { label: 'Detail', class: 'mono clip', render: (r) => (r.detail && Object.keys(r.detail).length ? JSON.stringify(r.detail) : '') },
    ], rows, 'No events yet.'));
  } catch (err) { errorBox(audit, err); }
}

// ---------- Opening a case ----------

export async function openCase(studyId) {
  showSection('viewer');
  resetViewerUI();
  setLocalLoading(false);
  session.openStudyId = studyId;
  $('empty-title').textContent = 'Opening case…';
  $('empty-text').textContent = 'Downloading anonymised images.';
  $('case-panel').hidden = false;

  let study;
  try {
    study = must(await supabase.from('studies')
      .select('id, case_label, clinical_details, modality, summary, file_count, status, uploader_id, radiologist_id, created_at, submitted_at, claimed_at, reported_at, addendum_count, anonymised')
      .eq('id', studyId).single());
  } catch (err) {
    toast(`This case is not available: ${err.message}`, 'error', 8000);
    showPage(session.listPage);
    return;
  }
  renderCasePanel(study, { onChanged: () => openCase(studyId), onClosed: () => showPage(session.listPage) });

  try {
    must(await supabase.rpc('log_study_opened', { p_study: studyId }));
    const files = must(await supabase.from('study_files').select('path, size_bytes').eq('study_id', studyId).order('path'));
    const downloaded = await downloadAll(files, studyId);
    if (session.openStudyId !== studyId) return; // user navigated away
    showProgress(null);
    await loadFiles(downloaded, { label: 'Decoding' });
    $('empty-title').textContent = 'No images';
    $('empty-text').textContent = '';
  } catch (err) {
    showProgress(null);
    toast(`Could not load the images: ${err.message}`, 'error', 9000);
  }
}

async function downloadAll(files, studyId) {
  const out = new Array(files.length);
  let next = 0, done = 0;
  async function worker() {
    while (next < files.length) {
      const i = next++;
      if (session.openStudyId !== studyId) return;
      const blob = must(await supabase.storage.from('dicom').download(files[i].path));
      out[i] = new File([blob], files[i].path.split('/').pop(), { type: 'application/dicom' });
      showProgress(`Downloading ${++done} of ${files.length} files…`, done / files.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(6, files.length) }, worker));
  return out.filter(Boolean);
}

// ---------- Notifications ----------

let pollTimer;
async function pollNotifications() {
  clearTimeout(pollTimer);
  try {
    const rows = must(await supabase.from('notifications')
      .select('id, study_id, kind, message, created_at, read_at')
      .order('created_at', { ascending: false }).limit(20));
    renderBell(rows);
  } catch { /* transient; retry on next tick */ }
  pollTimer = setTimeout(pollNotifications, 60_000);
}

function renderBell(rows) {
  const unread = rows.filter((r) => !r.read_at);
  const count = $('bell-count');
  count.textContent = unread.length > 9 ? '9+' : String(unread.length);
  count.hidden = unread.length === 0;
  $('btn-bell').title = unread.length ? `${unread.length} unread notification(s)` : 'Notifications';
  const menu = $('bell-menu');
  menu.replaceChildren(
    h('div', { class: 'menu-head' }, h('strong', {}, 'Notifications'),
      unread.length ? h('button', { class: 'linklike', onclick: () => markRead(null) }, 'Mark all read') : null),
    ...(rows.length
      ? rows.map((r) => h('button', {
          class: `menu-item${r.read_at ? '' : ' unread'}`,
          onclick: () => { markRead([r.id]); toggleMenu(false); if (r.study_id) openCase(r.study_id); },
        },
        h('span', {}, `Case ${shortRef(r.study_id)}: ${r.message}`),
        h('small', { class: 'muted' }, fmtDateTime(r.created_at))))
      : [h('p', { class: 'muted small pad' }, 'No notifications.')]),
  );
  if (unread.length && session.lastUnread !== undefined && unread.length > session.lastUnread) {
    toast('A report is ready. Open the bell to view it.');
  }
  session.lastUnread = unread.length;
}

async function markRead(ids) {
  try { must(await supabase.rpc('mark_notifications_read', { p_ids: ids })); } catch { /* ignore */ }
  pollNotifications();
}

function toggleMenu(open) {
  $('bell-menu').hidden = !open;
  $('btn-bell').setAttribute('aria-expanded', String(open));
}

function wireBell() {
  $('btn-bell').onclick = (e) => { e.stopPropagation(); toggleMenu($('bell-menu').hidden); };
  document.addEventListener('click', (e) => { if (!e.target.closest('.bell')) toggleMenu(false); });
  document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && session.profile?.role !== 'admin') pollNotifications();
  });
  if (session.profile.role === 'admin') $('btn-bell').hidden = true;
}
