// Tiny DOM helper. Text is always set with textContent, never innerHTML,
// so values from the database cannot inject markup.
export function h(tag, attrs = {}, ...children) {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs || {})) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = v;
    else if (k.startsWith('on') && typeof v === 'function') el.addEventListener(k.slice(2), v);
    else if (k === 'dataset') Object.assign(el.dataset, v);
    else if (v === true) el.setAttribute(k, '');
    else el.setAttribute(k, String(v));
  }
  for (const c of children.flat()) {
    if (c === null || c === undefined || c === false) continue;
    el.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
  return el;
}

export const fmtDateTime = (iso) => (iso ? new Date(iso).toLocaleString('en-GB', {
  day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit',
}) : '—');

export const shortRef = (uuid) => String(uuid || '').slice(0, 8).toUpperCase();

export const STATUS_LABEL = {
  uploading: 'Upload incomplete',
  awaiting_report: 'Awaiting report',
  in_review: 'Being reported',
  reported: 'Reported',
};

export function statusChip(status, addendumCount = 0) {
  const chip = h('span', { class: `chip st-${status}` }, STATUS_LABEL[status] || status);
  if (!addendumCount) return chip;
  const label = addendumCount === 1 ? '+1 addendum' : `+${addendumCount} addenda`;
  return h('span', { class: 'chips' }, chip, h('span', { class: 'chip amended', title: 'The signed report has addenda' }, label));
}

/** Case label with an "Identifiable" marker for cases uploaded without anonymisation. */
export function caseLabel(row) {
  if (row.anonymised !== false) return row.case_label;
  return h('span', { class: 'chips' }, h('span', {}, row.case_label),
    h('span', { class: 'chip identifiable', title: 'Uploaded without anonymisation, for sharing within the organisation' }, 'Identifiable'));
}

export function table(columns, rows, empty = 'Nothing here yet.') {
  if (!rows.length) return h('p', { class: 'muted empty-row' }, empty);
  return h('table', { class: 'data' },
    h('thead', {}, h('tr', {}, columns.map((c) => h('th', {}, c.label)))),
    h('tbody', {}, rows.map((r) => h('tr', {}, columns.map((c) => h('td', { class: c.class }, c.render(r)))))));
}
