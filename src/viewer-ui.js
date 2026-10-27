import { utilities as csUtils } from '@cornerstonejs/core';
import {
  ingestFiles, filesFromDataTransfer, studies, instancesByImageId, clearCatalogue,
} from './ingest.js';
import {
  initViewer, showSeries, applyPrimaryTool, clearAnnotations, setWindow, resetWindow, toggleInvert,
  resetView, scrollFocused, toggleCine, stopCine, setHidePHI, closeAll, currentLayout, currentSeries,
} from './viewer.js';
import { initTagPanel, showTagsFor, setTagsHidePHI } from './tags.js';

const $ = (id) => document.getElementById(id);
const ui = {
  list: $('series-list'),
  empty: $('empty'),
  dropOverlay: $('drop-overlay'),
  progress: $('progress'),
  progressText: $('progress-text'),
  progressFill: $('progress-fill'),
  toast: $('toast'),
  tagsPanel: $('tags-panel'),
  btnTags: $('btn-tags'),
  btnMpr: $('btn-mpr'),
  btnCine: $('btn-cine'),
  hidePHI: $('hide-phi'),
};

let hidePHI = true;
let toastTimer;
let localLoadingEnabled = false;
let onFilesLoaded = () => {};

export function toast(message, kind = '', ms = 4500) {
  ui.toast.textContent = message;
  ui.toast.className = `toast ${kind}`;
  ui.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { ui.toast.hidden = true; }, ms);
}

// ---------- Series list ----------

const fmtDate = (s) => (/^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s || '');

function renderSeriesList() {
  ui.list.innerHTML = '';
  if (!studies.size) {
    ui.list.innerHTML = '<p class="muted small">No images loaded.</p>';
    return;
  }
  const active = currentSeries()?.uid;
  for (const study of studies.values()) {
    const block = document.createElement('section');
    block.className = 'study';
    const head = document.createElement('div');
    head.className = 'study-head';
    const title = document.createElement('div');
    title.className = 'title';
    title.textContent = hidePHI ? 'Patient (hidden)' : (study.patientName || '(no name)');
    const sub = document.createElement('div');
    sub.className = 'sub';
    sub.textContent = [fmtDate(study.date), study.description].filter(Boolean).join(' · ') || 'Study';
    head.append(title, sub);
    block.append(head);

    const seriesSorted = [...study.series.values()].sort((a, b) => (a.number ?? 1e9) - (b.number ?? 1e9));
    for (const s of seriesSorted) {
      const btn = document.createElement('button');
      btn.className = `series${s.uid === active ? ' active' : ''}`;
      btn.dataset.uid = s.uid;
      const thumb = document.createElement('div');
      thumb.className = 'thumb';
      thumb.textContent = s.modality;
      const info = document.createElement('div');
      info.style.minWidth = '0';
      const name = document.createElement('div');
      name.className = 'name';
      name.textContent = s.description || `Series ${s.number ?? ''}`.trim();
      const meta = document.createElement('div');
      meta.className = 'meta';
      const first = s.instances[0];
      const dims = first.rows && first.columns ? ` · ${first.columns}×${first.rows}` : '';
      meta.textContent = `#${s.number ?? '–'} · ${s.imageIds.length} im${dims}`;
      const badges = document.createElement('div');
      const mod = document.createElement('span'); mod.className = 'badge'; mod.textContent = s.modality;
      badges.append(mod);
      if (s.mpr.ok) {
        const b = document.createElement('span'); b.className = 'badge'; b.textContent = 'MPR';
        b.title = 'Can be reconstructed in three planes';
        badges.append(b);
      }
      if (s.mpr.ok && s.mpr.irregular) {
        const b = document.createElement('span'); b.className = 'badge warn'; b.textContent = 'gaps';
        b.title = 'Irregular slice spacing: MPR geometry may be distorted';
        badges.append(b);
      }
      info.append(name, meta, badges);
      btn.append(thumb, info);
      btn.title = s.mpr.ok ? 'Open series' : `Open series (stack only: ${s.mpr.reason})`;
      btn.addEventListener('click', () => openSeries(s, currentLayout()));
      block.append(btn);
      queueThumbnail(s, thumb);
    }
    ui.list.append(block);
  }
}

const thumbCache = new Map();
let thumbChain = Promise.resolve();
function queueThumbnail(series, holder) {
  const cached = thumbCache.get(series.uid);
  if (cached) { holder.replaceChildren(cloneCanvas(cached)); return; }
  thumbChain = thumbChain.then(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 108; canvas.height = 108;
    try {
      const imageId = series.imageIds[Math.floor(series.imageIds.length / 2)];
      await csUtils.loadImageToCanvas({ canvas, imageId, thumbnail: true });
      thumbCache.set(series.uid, canvas);
      document.querySelectorAll(`.series[data-uid="${CSS.escape(series.uid)}"] .thumb`)
        .forEach((h) => h.replaceChildren(cloneCanvas(canvas)));
    } catch (err) {
      console.warn('Thumbnail failed for series', series.uid, err);
    }
  });
}
function cloneCanvas(src) {
  const c = document.createElement('canvas');
  c.width = src.width; c.height = src.height;
  c.getContext('2d').drawImage(src, 0, 0);
  return c;
}

function markActiveSeries(uid) {
  document.querySelectorAll('.series').forEach((b) => b.classList.toggle('active', b.dataset.uid === uid));
}

// ---------- Opening series / layouts ----------

async function openSeries(series, layout) {
  stopCine();
  setCineButton(false);
  ui.empty.hidden = true;
  markActiveSeries(series.uid);
  ui.btnMpr.disabled = !series.mpr.ok;
  ui.btnMpr.title = series.mpr.ok ? 'Axial, sagittal and coronal views' : `MPR unavailable: ${series.mpr.reason}`;
  if (layout === 'mpr' && !series.mpr.ok) toast(`MPR unavailable for this series: ${series.mpr.reason}.`, 'warn');
  const used = await showSeries(series, layout);
  setLayoutButtons(used);
  if (used === 'mpr' && series.mpr.irregular) {
    toast('Slice spacing in this series is irregular, so reconstructed planes may be geometrically distorted.', 'warn', 7000);
  }
  document.body.classList.remove('sidebar-open');
}

function setLayoutButtons(layout) {
  document.querySelectorAll('.seg[data-layout]').forEach((b) => {
    const on = b.dataset.layout === layout;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
  });
  const xh = document.querySelector('.tool[data-tool="Crosshairs"]');
  xh.disabled = layout !== 'mpr';
  const active = document.querySelector('.tool.active')?.dataset.tool;
  if (layout !== 'mpr' && active === 'Crosshairs') selectTool('WindowLevel');
}

function selectTool(key) {
  const used = applyPrimaryTool(key);
  document.querySelectorAll('.tool').forEach((b) => b.classList.toggle('active', b.dataset.tool === used));
}

// ---------- Loading files ----------

/**
 * Loads files into the viewer (from the user's disk or downloaded from storage).
 * @returns {Promise<{added:number, skipped:number, touchedSeries:object[]}|null>}
 */
export async function loadFiles(files, { label = 'Reading' } = {}) {
  if (!files.length) return null;
  ui.progress.hidden = false;
  const started = performance.now();
  const result = await ingestFiles(files, (done, total) => {
    ui.progressText.textContent = `${label} ${done.toLocaleString()} of ${total.toLocaleString()} files…`;
    ui.progressFill.style.width = `${(100 * done) / total}%`;
  });
  ui.progress.hidden = true;
  const secs = ((performance.now() - started) / 1000).toFixed(1);

  if (!result.added) {
    toast(`No viewable DICOM images found in ${files.length} file(s). Only DICOM Part 10 files with pixel data are supported.`, 'error', 8000);
    return result;
  }
  const skipped = result.skipped ? ` ${result.skipped} file(s) skipped (not DICOM images, or duplicates).` : '';
  toast(`Loaded ${result.added} image file(s) in ${secs}s.${skipped}`);
  renderSeriesList();
  if (!currentSeries()) {
    // Open the series with the most images first: usually the main volume.
    const best = result.touchedSeries.sort((a, b) => b.imageIds.length - a.imageIds.length)[0];
    if (best) openSeries(best, 'stack');
  }
  onFilesLoaded(result);
  return result;
}

/** Shows the progress card for work done outside the viewer (downloads, uploads). */
export function showProgress(text, fraction) {
  if (text === null) { ui.progress.hidden = true; return; }
  ui.progress.hidden = false;
  ui.progressText.textContent = text;
  ui.progressFill.style.width = `${Math.round(100 * Math.max(0, Math.min(1, fraction)))}%`;
}

/** Unloads every image and resets the viewer to its empty state. */
export function resetViewerUI() {
  closeAll();
  clearCatalogue();
  thumbCache.clear();
  renderSeriesList();
  showTagsFor(null);
  ui.empty.hidden = false;
  ui.btnMpr.disabled = true;
  setLayoutButtons('stack');
}

/** Local "Open folder" / drag-and-drop are only offered while preparing an upload. */
export function setLocalLoading(enabled, callback = () => {}) {
  localLoadingEnabled = enabled;
  onFilesLoaded = callback;
  document.querySelectorAll('.local-only').forEach((el) => { el.hidden = !enabled; });
}

// ---------- Event wiring ----------

function wire() {
  $('btn-open-folder').onclick = () => $('input-folder').click();
  $('btn-open-files').onclick = () => $('input-files').click();
  for (const id of ['input-folder', 'input-files']) {
    $(id).addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (localLoadingEnabled) loadFiles(files);
    });
  }

  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => { e.preventDefault(); if (!localLoadingEnabled) return; dragDepth++; ui.dropOverlay.hidden = false; });
  window.addEventListener('dragover', (e) => e.preventDefault());
  window.addEventListener('dragleave', () => { if (--dragDepth <= 0) { dragDepth = 0; ui.dropOverlay.hidden = true; } });
  window.addEventListener('drop', async (e) => {
    e.preventDefault();
    dragDepth = 0;
    ui.dropOverlay.hidden = true;
    if (localLoadingEnabled) loadFiles(await filesFromDataTransfer(e.dataTransfer));
  });

  document.querySelectorAll('.seg[data-layout]').forEach((b) => b.addEventListener('click', () => {
    const s = currentSeries();
    if (s && b.dataset.layout !== currentLayout()) openSeries(s, b.dataset.layout);
  }));

  document.querySelectorAll('.tool').forEach((b) => b.addEventListener('click', () => selectTool(b.dataset.tool)));

  $('preset').addEventListener('change', (e) => {
    const v = e.target.value;
    e.target.value = '';
    if (!currentSeries() || !v) return;
    if (v === 'auto') resetWindow();
    else { const [c, w] = v.split(',').map(Number); setWindow(c, w); }
  });
  $('btn-invert').onclick = toggleInvert;
  $('btn-reset').onclick = resetView;
  ui.btnCine.onclick = () => setCineButton(toggleCine(Math.max(1, Math.min(60, Number($('fps').value) || 15))));
  $('btn-clear-annot').onclick = () => { if (confirm('Delete all measurements?')) clearAnnotations(); };

  ui.btnTags.onclick = () => setTagsOpen(ui.tagsPanel.hidden);
  $('btn-tags-close').onclick = () => setTagsOpen(false);

  $('btn-close-all').onclick = () => {
    if (!studies.size || !confirm('Remove the selected files?')) return;
    resetViewerUI();
    onFilesLoaded(null);
  };

  $('btn-sidebar')?.addEventListener('click', () => document.body.classList.toggle('sidebar-open'));

  ui.hidePHI.addEventListener('change', () => {
    hidePHI = ui.hidePHI.checked;
    setHidePHI(hidePHI);
    setTagsHidePHI(hidePHI);
    renderSeriesList();
  });

  const keyTools = { w: 'WindowLevel', p: 'Pan', z: 'Zoom', s: 'StackScroll', l: 'Length', a: 'Angle', e: 'EllipticalROI', r: 'RectangleROI', b: 'Probe', c: 'Crosshairs' };
  window.addEventListener('keydown', (e) => {
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    if (!currentSeries() || $('page-viewer').hidden) return;
    const k = e.key.toLowerCase();
    if (keyTools[k]) { if (k !== 'c' || currentLayout() === 'mpr') selectTool(keyTools[k]); }
    else if (k === 'i') toggleInvert();
    else if (k === 't') setTagsOpen(ui.tagsPanel.hidden);
    else if (e.key === 'Escape') resetView();
    else if (e.key === ' ') { e.preventDefault(); ui.btnCine.click(); }
    else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') { e.preventDefault(); scrollFocused(-1); }
    else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') { e.preventDefault(); scrollFocused(1); }
    else if (e.key === 'PageUp') { e.preventDefault(); scrollFocused(-10); }
    else if (e.key === 'PageDown') { e.preventDefault(); scrollFocused(10); }
  });
}

function setTagsOpen(open) {
  ui.tagsPanel.hidden = !open;
  ui.btnTags.setAttribute('aria-pressed', String(open));
}

function setCineButton(playing) {
  ui.btnCine.textContent = playing ? '❚❚' : '▶';
  ui.btnCine.setAttribute('aria-pressed', String(playing));
}

// ---------- Boot ----------

export async function initViewerUI() {
  initTagPanel();
  wire();
  try {
    await initViewer({
      onImageChange: (imageId) => showTagsFor(imageId ? instancesByImageId.get(imageId) : null),
      onError: (msg) => toast(msg, 'error', 9000),
    });
  } catch (err) {
    console.error(err);
    toast(`The viewer could not start: ${err?.message || err}. A browser with WebGL 2 is required.`, 'error', 20000);
  }
}
