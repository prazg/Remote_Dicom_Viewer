// DICOM tag viewer. Names come from the dcmjs data dictionary rather than a
// hand-written table, so tag names match the DICOM standard dictionary.

import dcmjs from 'dcmjs';

const DICT = dcmjs.data.DicomMetaDictionary.dictionary;

// Shown masked when "Hide identifiers" is on. This is a display convenience,
// not de-identification: the underlying files are unchanged.
const IDENTIFYING = new Set([
  'PatientName', 'PatientID', 'IssuerOfPatientID', 'OtherPatientIDs', 'OtherPatientIDsSequence',
  'OtherPatientNames', 'PatientBirthDate', 'PatientBirthTime', 'PatientBirthName', 'PatientAddress',
  'PatientTelephoneNumbers', 'PatientMotherBirthName', 'MedicalRecordLocator', 'AccessionNumber',
  'ReferringPhysicianName', 'ReferringPhysicianAddress', 'ReferringPhysicianTelephoneNumbers',
  'PerformingPhysicianName', 'NameOfPhysiciansReadingStudy', 'PhysiciansOfRecord', 'OperatorsName',
  'RequestingPhysician', 'InstitutionName', 'InstitutionAddress', 'InstitutionalDepartmentName',
  'StationName', 'StudyID', 'AdmissionID', 'MilitaryRank', 'EthnicGroup', 'Occupation',
  'AdditionalPatientHistory', 'PatientComments', 'DeviceSerialNumber', 'ResponsiblePerson',
]);

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UI', 'UT', 'UC', 'UR']);
const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);
const MAX_NUMERIC_VALUES = 24;

function tagKey(tag) {
  // dicom-parser tag "x00100010" -> "(0010,0010)"
  const g = tag.slice(1, 5).toUpperCase();
  const e = tag.slice(5, 9).toUpperCase();
  return { g, e, key: `(${g},${e})` };
}

function lookup(tag) {
  const { g, e, key } = tagKey(tag);
  if (parseInt(g, 16) % 2 === 1) {
    const el = parseInt(e, 16);
    return { name: el >= 0x10 && el <= 0xff ? 'Private Creator' : 'Private tag', private: true };
  }
  if (e === '0000') return { name: 'Group Length' };
  const entry = DICT[key] || DICT[`(${g.slice(0, 2)}xx,${e})`] || DICT[`(${g},${e.slice(0, 2)}xx)`];
  return entry ? { name: entry.name, vr: entry.vr } : { name: 'Unknown' };
}

function numericValues(ds, el, vr) {
  const size = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8, AT: 4, UV: 8, SV: 8 }[vr];
  if (!size) return null;
  const count = Math.floor(el.length / size);
  const out = [];
  for (let i = 0; i < Math.min(count, MAX_NUMERIC_VALUES); i++) {
    let v;
    switch (vr) {
      case 'US': v = ds.uint16(el.tag, i); break;
      case 'SS': v = ds.int16(el.tag, i); break;
      case 'UL': v = ds.uint32(el.tag, i); break;
      case 'SL': v = ds.int32(el.tag, i); break;
      case 'FL': v = +ds.float(el.tag, i).toPrecision(7); break;
      case 'FD': v = +ds.double(el.tag, i).toPrecision(12); break;
      case 'AT': v = ds.attributeTag(el.tag); i = count; break;
      default: v = '…';
    }
    out.push(v);
  }
  return out.join('\\') + (count > MAX_NUMERIC_VALUES ? ` … (${count} values)` : '');
}

function formatValue(ds, el, vr) {
  if (el.tag === 'x7fe00010') return `<pixel data, ${el.length >= 0 ? el.length.toLocaleString() + ' bytes' : 'encapsulated'}>`;
  if (BINARY_VRS.has(vr)) return `<binary, ${el.length.toLocaleString()} bytes>`;
  const num = numericValues(ds, el, vr);
  if (num !== null) return num;
  if (STRING_VRS.has(vr) || !vr) {
    try {
      const s = ds.string(el.tag) ?? '';
      return s.length > 400 ? `${s.slice(0, 400)}…` : s;
    } catch { return ''; }
  }
  return `<${el.length} bytes>`;
}

/**
 * Builds a flat list of rows (with depth) from a dicom-parser DataSet.
 */
function collectRows(ds, depth = 0, rows = []) {
  const tags = Object.keys(ds.elements).sort();
  for (const tag of tags) {
    const el = ds.elements[tag];
    const info = lookup(tag);
    const vr = el.vr || info.vr || (el.items ? 'SQ' : '');
    const { key } = tagKey(tag);
    if (el.items) {
      rows.push({ depth, key, vr: 'SQ', name: info.name, value: `${el.items.length} item(s)`, seq: true });
      el.items.forEach((item, i) => {
        rows.push({ depth: depth + 1, key: '', vr: '', name: `Item ${i + 1}`, value: '', seq: true });
        if (item.dataSet) collectRows(item.dataSet, depth + 2, rows);
      });
      continue;
    }
    rows.push({ depth, key, vr, name: info.name, value: formatValue(ds, el, vr) });
  }
  return rows;
}

const els = {};
let currentRows = [];
let hidePHI = true;

export function initTagPanel() {
  els.table = document.getElementById('tag-table');
  els.search = document.getElementById('tag-search');
  els.source = document.getElementById('tag-source');
  els.search.addEventListener('input', render);
}

export function setTagsHidePHI(hide) {
  hidePHI = hide;
  render();
}

export function showTagsFor(record) {
  if (!record) {
    currentRows = [];
    els.source.textContent = '';
    render();
    return;
  }
  const { instance, frameIndex } = record;
  currentRows = collectRows(instance.dataSet);
  const frame = instance.numberOfFrames > 1 ? `, frame ${frameIndex + 1} of ${instance.numberOfFrames}` : '';
  els.source.textContent = `Instance ${instance.instanceNumber ?? '–'}${frame} · ${instance.file.name}`;
  render();
}

function render() {
  if (!els.table) return;
  const q = els.search.value.trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;
  for (const r of currentRows) {
    const masked = hidePHI && IDENTIFYING.has(r.name);
    const value = masked ? 'hidden' : r.value;
    if (q && !`${r.key} ${r.name} ${masked ? '' : r.value}`.toLowerCase().includes(q)) continue;
    const row = document.createElement('div');
    row.className = `tag-row${r.seq ? ' seq' : ''}${masked ? ' hidden-phi' : ''}`;
    row.style.paddingLeft = `${6 + r.depth * 12}px`;
    const t = document.createElement('span'); t.className = 't'; t.textContent = r.key;
    const vr = document.createElement('span'); vr.className = 'vr'; vr.textContent = r.vr;
    const n = document.createElement('span'); n.className = 'n'; n.textContent = r.name;
    const v = document.createElement('span'); v.className = 'v'; v.textContent = value;
    row.append(t, vr, n, v);
    frag.append(row);
    shown++;
  }
  els.table.replaceChildren(frag);
  if (!shown) {
    const p = document.createElement('p');
    p.className = 'muted small';
    p.style.padding = '6px';
    p.textContent = currentRows.length ? 'No tags match the filter.' : 'Load a series to see its tags.';
    els.table.append(p);
  }
}
