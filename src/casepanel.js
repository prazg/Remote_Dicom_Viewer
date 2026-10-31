// Right-hand case panel: case details, and the report — read-only for the
// uploader, editable (claim → draft → sign) for the radiologist. Once signed,
// the report is locked; the signing radiologist can append signed addenda.

import { supabase, must } from './supabase.js';
import { h, fmtDateTime, shortRef, statusChip } from './dom.js';
import { session } from './pages.js';
import { toast } from './viewer-ui.js';

const $ = (id) => document.getElementById(id);

export async function renderCasePanel(study, { onChanged, onClosed }) {
  const panel = $('case-panel');
  const role = session.profile.role;
  const isMine = study.radiologist_id === session.profile.id;

  const details = h('section', { class: 'cp-section' },
    h('div', { class: 'cp-title' }, h('h2', {}, study.case_label), statusChip(study.status, study.addendum_count)),
    h('dl', { class: 'cp-meta' },
      h('dt', {}, 'Reference'), h('dd', { class: 'mono' }, shortRef(study.id)),
      h('dt', {}, 'Modality'), h('dd', {}, study.modality || '—'),
      h('dt', {}, 'Images'), h('dd', {}, `${study.file_count}${study.summary ? ` · ${study.summary}` : ''}`),
      h('dt', {}, 'Submitted'), h('dd', {}, fmtDateTime(study.submitted_at)),
      h('dt', {}, 'Privacy'), h('dd', {}, study.anonymised === false
        ? h('span', { class: 'chip identifiable' }, 'Identifiable · shared within organisation')
        : 'Anonymised')),
    h('h3', {}, 'Clinical details'),
    h('p', { class: 'cp-text' }, study.clinical_details || 'None given.'));

  const reportSection = h('section', { class: 'cp-section' }, h('h3', {}, 'Report'));
  panel.replaceChildren(details, reportSection);

  if (study.status === 'reported') {
    await showFinalReport(reportSection, study, { onChanged });
    return;
  }

  if (role === 'uploader') {
    reportSection.append(h('p', { class: 'muted' },
      study.status === 'in_review' ? 'A radiologist is reporting this case.' : 'Waiting for a radiologist.'),
    h('p', { class: 'muted small' }, 'You will be notified here and by email when the report is signed.'));
    return;
  }

  if (role === 'radiologist' && study.status === 'awaiting_report') {
    reportSection.append(
      h('p', { class: 'muted' }, 'Claim this case to start reporting. Other radiologists will no longer see it.'),
      h('button', {
        class: 'btn primary wide',
        onclick: async (e) => {
          e.target.disabled = true;
          try { must(await supabase.rpc('claim_study', { p_study: study.id })); toast('Case claimed.'); onChanged(); }
          catch (err) { toast(`Could not claim: ${err.message}`, 'error'); e.target.disabled = false; }
        },
      }, 'Claim for reporting'));
    return;
  }

  if (role === 'radiologist' && study.status === 'in_review' && isMine) {
    await showEditor(reportSection, study, { onChanged, onClosed });
  }
}

async function showFinalReport(section, study, { onChanged }) {
  let r, addenda;
  try {
    [r, addenda] = await Promise.all([
      supabase.from('reports').select('body, signed_by_name, signed_at, radiologist_id').eq('study_id', study.id).single().then(must),
      supabase.from('report_addenda').select('seq, body, signed_by_name, signed_at').eq('study_id', study.id).order('seq').then(must),
    ]);
  } catch (err) {
    section.append(h('p', { class: 'error-box' }, `Could not load the report: ${err.message}`));
    return;
  }

  section.append(
    h('div', { class: 'report-final' }, r.body),
    h('p', { class: 'muted small' }, `Signed by ${r.signed_by_name} · ${fmtDateTime(r.signed_at)}`));

  if (addenda.length) {
    section.append(h('h3', {}, addenda.length === 1 ? 'Addendum' : `Addenda (${addenda.length})`));
    for (const a of addenda) {
      section.append(h('div', { class: 'addendum' },
        h('div', { class: 'addendum-head' }, `Addendum ${a.seq}`),
        h('div', { class: 'addendum-body' }, a.body),
        h('p', { class: 'muted small' }, `Signed by ${a.signed_by_name} · ${fmtDateTime(a.signed_at)}`)));
    }
  }

  section.append(
    h('p', { class: 'muted small' }, 'The signed report is locked. Corrections are added as signed addenda and the original is kept unchanged.'),
    h('button', { class: 'btn small', onclick: () => downloadReport(study.id, r, addenda) }, 'Download as text'));

  const canAdd = session.profile.role === 'radiologist' && r.radiologist_id === session.profile.id;
  if (canAdd) section.append(addendumComposer(study, { onChanged }));
}

function addendumComposer(study, { onChanged }) {
  const holder = h('div', { class: 'addendum-composer' });
  const openBtn = h('button', { class: 'btn wide', onclick: () => open() }, 'Add addendum');
  holder.append(openBtn);

  function open() {
    const area = h('textarea', {
      class: 'report-editor addendum-editor', rows: 8, maxlength: 20000, 'aria-label': 'Addendum text',
      placeholder: 'Correction or additional findings. The original report stays unchanged.',
    });
    const guard = (e) => { if (area.value.trim()) e.preventDefault(); };
    window.addEventListener('beforeunload', guard);
    const close = () => { window.removeEventListener('beforeunload', guard); holder.replaceChildren(openBtn); };

    const signBtn = h('button', {
      class: 'btn primary',
      onclick: async () => {
        const body = area.value.trim();
        if (body.length < 10) { toast('Write the addendum before signing.', 'warn'); return; }
        const name = session.profile.full_name || session.profile.email;
        if (!confirm(`Sign this addendum as ${name}?\n\nIt will be added below the original report, cannot be edited or removed afterwards, and the uploader will be notified.`)) return;
        signBtn.disabled = true;
        try {
          must(await supabase.rpc('add_report_addendum', { p_study: study.id, p_body: body }));
          window.removeEventListener('beforeunload', guard);
          toast('Addendum signed. The uploader has been notified.');
          onChanged();
        } catch (err) {
          toast(`Could not sign the addendum: ${err.message}`, 'error', 8000);
          signBtn.disabled = false;
        }
      },
    }, 'Sign addendum');
    const cancelBtn = h('button', {
      class: 'btn ghost',
      onclick: () => { if (!area.value.trim() || confirm('Discard this addendum?')) close(); },
    }, 'Cancel');

    holder.replaceChildren(h('h3', {}, 'New addendum'), area, h('div', { class: 'cp-actions' }, cancelBtn, signBtn));
    area.focus();
  }
  return holder;
}

function downloadReport(studyId, r, addenda = []) {
  const parts = [
    `Case reference: ${shortRef(studyId)}`,
    `Signed by: ${r.signed_by_name}`,
    `Signed at: ${fmtDateTime(r.signed_at)}`,
    '', r.body, '',
  ];
  for (const a of addenda) {
    parts.push('----------------------------------------',
      `ADDENDUM ${a.seq}`, `Signed by: ${a.signed_by_name}`, `Signed at: ${fmtDateTime(a.signed_at)}`, '', a.body, '');
  }
  const url = URL.createObjectURL(new Blob([parts.join('\n')], { type: 'text/plain' }));
  const a = h('a', { href: url, download: `report-${shortRef(studyId)}.txt` });
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

async function showEditor(section, study, { onChanged, onClosed }) {
  let draft;
  try {
    draft = must(await supabase.from('reports').select('body, updated_at').eq('study_id', study.id).single());
  } catch (err) {
    section.append(h('p', { class: 'error-box' }, `Could not load the draft: ${err.message}`));
    return;
  }
  const status = h('span', { class: 'muted small', role: 'status' }, `Draft saved ${fmtDateTime(draft.updated_at)}`);
  const area = h('textarea', {
    class: 'report-editor', rows: 16, maxlength: 20000, 'aria-label': 'Report text',
    placeholder: 'Findings and conclusion…',
  });
  area.value = draft.body || '';

  let saveTimer, saving = Promise.resolve(), dirty = false;
  const save = () => {
    dirty = false;
    saving = (async () => {
      status.textContent = 'Saving…';
      try {
        const at = must(await supabase.rpc('save_report_draft', { p_study: study.id, p_body: area.value }));
        status.textContent = `Draft saved ${fmtDateTime(at)}`;
      } catch (err) {
        dirty = true;
        status.textContent = `Not saved: ${err.message}`;
      }
    })();
    return saving;
  };
  area.addEventListener('input', () => {
    dirty = true;
    status.textContent = 'Unsaved changes';
    clearTimeout(saveTimer);
    saveTimer = setTimeout(save, 1500);
  });

  const signBtn = h('button', {
    class: 'btn primary',
    onclick: async () => {
      const body = area.value.trim();
      if (body.length < 10) { toast('Write the report before signing.', 'warn'); return; }
      const name = session.profile.full_name || session.profile.email;
      if (!confirm(`Sign this report as ${name}?\n\nA signed report is final and cannot be edited. The uploader will be notified.`)) return;
      clearTimeout(saveTimer);
      await saving;
      signBtn.disabled = true;
      try {
        must(await supabase.rpc('sign_report', { p_study: study.id, p_body: area.value }));
        toast('Report signed and submitted. The uploader has been notified.');
        onChanged();
      } catch (err) {
        toast(`Could not sign: ${err.message}`, 'error', 8000);
        signBtn.disabled = false;
      }
    },
  }, 'Sign and submit');

  const releaseBtn = h('button', {
    class: 'btn ghost',
    onclick: async () => {
      if (!confirm('Return this case to the worklist? Your draft will be deleted.')) return;
      clearTimeout(saveTimer);
      try { must(await supabase.rpc('release_study', { p_study: study.id })); toast('Case returned to the worklist.'); onClosed(); }
      catch (err) { toast(err.message, 'error'); }
    },
  }, 'Release');

  section.append(area, h('div', { class: 'cp-actions' }, status), h('div', { class: 'cp-actions' }, releaseBtn, signBtn));

  // Save on leaving the page.
  window.addEventListener('beforeunload', (e) => { if (dirty) { save(); e.preventDefault(); } }, { once: true });
}
