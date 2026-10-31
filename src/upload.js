// Uploader flow: choose files → preview locally → anonymise in the browser
// (default) or, after confirming internal sharing, keep identifiable →
// upload to the private bucket → submit for reporting.

import { supabase, must } from './supabase.js';
import { h } from './dom.js';
import { allSeries } from './ingest.js';
import { createAnonymiser, burnedInRisk } from './anonymise.js';
import { resetViewerUI, setLocalLoading, showProgress, toast } from './viewer-ui.js';

const $ = (id) => document.getElementById(id);
const MAX_FILE_BYTES = 50 * 1024 * 1024; // matches the bucket limit
const CONCURRENCY = 4;

let onDoneCb = () => {};
let uploading = false;

export function startUpload({ onDone }) {
  onDoneCb = onDone;
  resetViewerUI();
  $('empty-title').textContent = 'Drop a DICOM folder here';
  $('empty-text').textContent = 'or use Open folder. Files are previewed locally and anonymised in your browser before upload.';
  $('case-panel').hidden = false;
  setLocalLoading(true, () => renderForm());
  renderForm();
}

/** Everything the form needs to know about the files currently loaded. */
function inspectLoaded() {
  const series = allSeries();
  const instances = series.flatMap((s) => s.instances);
  const declared = instances.filter((i) => burnedInRisk(i.dataSet) === 'declared');
  const risky = instances.filter((i) => burnedInRisk(i.dataSet) === 'modality');
  const tooBig = instances.filter((i) => i.file.size > MAX_FILE_BYTES);
  const uploadable = instances.filter((i) => !declared.includes(i) && !tooBig.includes(i));
  const modalities = [...new Set(series.map((s) => s.modality))].join(', ');
  const patients = new Set(instances.map((i) => `${i.patientID}|${i.patientName}`.toUpperCase()));
  // Identifiers from the files, to stop them being typed into the case label or details.
  const identifiers = new Set();
  for (const i of instances) {
    i.patientName.split(/\s+/).filter((p) => p.length >= 3).forEach((p) => identifiers.add(p.toUpperCase()));
    if (i.patientID?.length >= 4) identifiers.add(i.patientID.toUpperCase());
    const acc = (i.dataSet.string('x00080050') || '').trim();
    if (acc.length >= 4) identifiers.add(acc.toUpperCase());
  }
  return { series, instances, declared, risky, tooBig, uploadable, modalities, identifiers, patientCount: patients.size };
}

function findIdentifier(text, identifiers) {
  const upper = text.toUpperCase();
  for (const id of identifiers) {
    const re = new RegExp(`(?<![A-Z0-9])${id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}(?![A-Z0-9])`);
    if (re.test(upper)) return 'a patient name or ID from the images';
  }
  if (/\b\d{3}[\s-]?\d{3}[\s-]?\d{4}\b/.test(text)) return 'a 10-digit number (possible NHS number)';
  if (/\b\d{1,2}[/.-]\d{1,2}[/.-](19|20)?\d{2}\b/.test(text)) return 'a date (possible date of birth)';
  return null;
}

function renderForm() {
  if (uploading) return;
  const panel = $('case-panel');
  const info = inspectLoaded();

  if (!info.instances.length) {
    panel.replaceChildren(h('section', { class: 'cp-section' },
      h('h2', {}, 'New upload'),
      h('ol', { class: 'steps' },
        h('li', {}, 'Choose the scan folder with “Open folder” (or drag it in).'),
        h('li', {}, 'Check the images in the viewer.'),
        h('li', {}, 'Choose whether to anonymise, add a case label and clinical details, then upload.')),
      h('p', { class: 'muted small' },
        'By default, patient name, IDs, dates, institution and staff names, private tags and UIDs are removed in your browser before anything is sent. You can turn this off for images shared within your organisation.')));
    return;
  }

  const label = h('input', { id: 'up-label', maxlength: 60, required: true, autocomplete: 'off', placeholder: 'e.g. Neuro MDT case 12' });
  const details = h('textarea', { id: 'up-details', rows: 6, maxlength: 2000, placeholder: 'Clinical question and relevant history' });
  const anonymise = h('input', { type: 'checkbox', id: 'up-anonymise', checked: true });
  const internal = h('input', { type: 'checkbox', id: 'up-internal' });
  const authorised = h('input', { type: 'checkbox', id: 'up-authorised' });
  const burnedOk = h('input', { type: 'checkbox', id: 'up-burned' });
  const errorEl = h('p', { class: 'error-box', hidden: true });
  const submit = h('button', { class: 'btn primary wide', type: 'submit' });
  const labelHint = h('p', { class: 'hint' });
  const detailsHint = h('p', { class: 'hint' });

  // Shown only when anonymising (burned-in text matters only then).
  const anonOnly = [];
  if (info.declared.length) {
    anonOnly.push(h('p', { class: 'warn-box' }, `${info.declared.length} file(s) are marked as containing burned-in annotation and will not be uploaded while anonymising.`));
  }
  if (info.risky.length) {
    anonOnly.push(h('div', { class: 'warn-box' },
      h('p', {}, `${info.risky.length} image(s) are ultrasound, secondary capture or similar, which often have patient details burned into the pixels. These cannot be removed automatically.`),
      h('label', { class: 'check' }, burnedOk, ' I have checked these images and they show no patient identifiers.')));
  }

  const internalBox = h('div', { class: 'warn-box identifiable-box' },
    h('p', {}, h('strong', {}, 'Identifiable images. '),
      'The original files are uploaded unchanged, including patient name, NHS or hospital number, date of birth and dates. They will be visible to every radiologist on this system until claimed.'),
    h('label', { class: 'check' }, internal,
      ' I confirm these images are being shared within my organisation only, with colleagues who have an account on this system, and that sharing identifiable images is permitted for this purpose.'));

  const warnings = [];
  if (info.patientCount > 1) {
    warnings.push(h('p', { class: 'error-box' }, `These files belong to ${info.patientCount} different patients. Upload one patient per case: use “Clear files” and choose one patient's folder.`));
  }
  if (info.tooBig.length) {
    warnings.push(h('p', { class: 'warn-box' }, `${info.tooBig.length} file(s) exceed 50 MB and will not be uploaded.`));
  }

  const filesFor = (anon) => info.instances.filter((i) => !info.tooBig.includes(i) && (!anon || !info.declared.includes(i)));

  function sync() {
    const anon = anonymise.checked;
    anonOnly.forEach((el) => { el.hidden = !anon; });
    internalBox.hidden = anon;
    const n = filesFor(anon).length;
    submit.textContent = anon ? `Anonymise and upload ${n} file(s)` : `Upload ${n} identifiable file(s)`;
    submit.classList.toggle('danger', !anon);
    labelHint.textContent = anon
      ? 'Must not identify the patient: no name, NHS or hospital number, or date of birth.'
      : 'Shown to radiologists on the worklist. Avoid identifiers here unless needed.';
    detailsHint.textContent = anon
      ? 'Clinical question and history only — no identifiers.'
      : 'Clinical question and history.';
    errorEl.hidden = true;
  }

  const form = h('form', { class: 'cp-section upload-form', novalidate: true },
    h('h2', {}, 'New upload'),
    h('p', { class: 'muted small' }, `${info.series.length} series · ${info.instances.length} file(s) · ${info.modalities}`),
    ...warnings,
    h('fieldset', { class: 'privacy' },
      h('legend', {}, 'Privacy'),
      h('label', { class: 'check' }, anonymise, ' ', h('span', {}, h('strong', {}, 'Anonymise before upload'), ' (recommended)')),
      h('p', { class: 'hint' }, 'Removes patient name, IDs, dates, institution and staff names in your browser. Required when sharing outside your organisation.'),
      internalBox,
      ...anonOnly),
    h('label', {}, 'Case label', label),
    labelHint,
    h('label', {}, 'Clinical details', details),
    detailsHint,
    h('label', { class: 'check' }, authorised, ' I am authorised to share these images for reporting.'),
    errorEl,
    submit);

  anonymise.addEventListener('change', () => { if (anonymise.checked) internal.checked = false; sync(); });
  form.addEventListener('input', () => { errorEl.hidden = true; });
  form.addEventListener('submit', async (e) => {
    e.preventDefault();
    const fail = (msg) => { errorEl.textContent = msg; errorEl.hidden = false; };
    errorEl.hidden = true;
    const anon = anonymise.checked;
    const caseLabel = label.value.trim();
    const clinical = details.value.trim();
    if (info.patientCount > 1) return fail('One patient per case: these files are from more than one patient.');
    if (!anon && !internal.checked) return fail('To upload without anonymising, confirm the images are being shared within your organisation, or tick “Anonymise before upload”.');
    if (!caseLabel) return fail('Enter a case label.');
    if (anon) {
      const leak = findIdentifier(`${caseLabel}\n${clinical}`, info.identifiers);
      if (leak) return fail(`The label or clinical details appear to contain ${leak}. Remove it, or upload as identifiable within your organisation.`);
    }
    if (!authorised.checked) return fail('Confirm you are authorised to share these images.');
    if (anon && info.risky.length && !burnedOk.checked) return fail('Confirm you have checked the images for burned-in identifiers.');
    const files = filesFor(anon);
    if (!files.length) return fail('There are no files that can be uploaded.');
    if (!anon && !confirm(`Upload ${files.length} identifiable file(s)?\n\nPatient details in the images will be visible to radiologists on this system. This cannot be changed after upload.`)) return;
    submit.disabled = true;
    await runUpload(info, files, { anonymise: anon, internalConfirmed: !anon && internal.checked }, caseLabel, clinical, fail);
    submit.disabled = false;
  });

  sync();
  panel.replaceChildren(form);
}

async function runUpload(info, files, mode, caseLabel, clinical, fail) {
  uploading = true;
  setLocalLoading(false);
  let studyId = null;
  const uploaded = [];
  try {
    const summary = `${info.series.length} series, ${files.length} file(s)`;
    studyId = must(await supabase.rpc('create_study', {
      p_case_label: caseLabel, p_clinical_details: clinical, p_modality: info.modalities, p_summary: summary,
      p_anonymised: mode.anonymise, p_internal_share_confirmed: mode.internalConfirmed,
    }));
    const anon = mode.anonymise ? createAnonymiser({ caseRef: studyId.slice(0, 8).toUpperCase() }) : null;
    const queue = files.map((inst, i) => ({ inst, path: `${studyId}/${String(i + 1).padStart(5, '0')}.dcm` }));
    let done = 0;
    let aborted = false;

    async function worker() {
      while (queue.length && !aborted) {
        const { inst, path } = queue.shift();
        let bytes;
        if (anon) {
          try {
            bytes = anon.anonymise(await inst.file.arrayBuffer()).buffer;
          } catch (err) {
            throw new Error(`Anonymisation failed for ${inst.file.name}: ${err.message}. Nothing from this case has been submitted.`);
          }
        } else {
          bytes = await inst.file.arrayBuffer(); // identifiable: original file, unchanged
        }
        const blob = new Blob([bytes], { type: 'application/dicom' });
        must(await supabase.storage.from('dicom').upload(path, blob, { contentType: 'application/dicom', upsert: false }));
        uploaded.push(path);
        must(await supabase.from('study_files').insert({ study_id: studyId, path, size_bytes: blob.size }));
        showProgress(`${anon ? 'Anonymised and uploaded' : 'Uploaded'} ${++done} of ${files.length}…`, done / files.length);
      }
    }
    // allSettled: let in-flight uploads finish so rollback sees every stored file.
    const results = await Promise.allSettled(Array.from({ length: Math.min(CONCURRENCY, queue.length) }, () =>
      worker().catch((err) => { aborted = true; throw err; })));
    const failed = results.find((r) => r.status === 'rejected');
    if (failed) throw failed.reason;

    must(await supabase.rpc('submit_study', { p_study: studyId }));
    showProgress(null);
    uploading = false;
    toast(`Uploaded ${done} ${anon ? 'anonymised' : 'identifiable'} file(s). The case is on the radiologists' worklist.`, '', 7000);
    resetViewerUI();
    onDoneCb();
  } catch (err) {
    showProgress(null);
    // Roll back a partial upload so nothing half-finished is left behind.
    if (studyId) {
      try {
        if (uploaded.length) await supabase.storage.from('dicom').remove(uploaded);
        await supabase.rpc('discard_study', { p_study: studyId });
      } catch { /* the uploader can discard it from My cases */ }
    }
    uploading = false;
    setLocalLoading(true, () => renderForm());
    fail(`Upload failed: ${err.message}`);
  }
}
