// Cornerstone3D setup: rendering engine, viewports (stack + 3-plane MPR),
// tool groups, window/level, cine and on-image overlays.
// API names here were checked against the installed 5.13.2 type definitions.

import {
  RenderingEngine,
  Enums,
  init as initCore,
  volumeLoader,
  cornerstoneStreamingImageVolumeLoader,
  setVolumesForViewports,
  cache,
} from '@cornerstonejs/core';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import * as cornerstoneTools from '@cornerstonejs/tools';

const { ViewportType, OrientationAxis, Events } = Enums;
const {
  ToolGroupManager,
  SynchronizerManager,
  synchronizers,
  annotation,
  utilities: toolUtils,
  Enums: { MouseBindings },
} = cornerstoneTools;

const ENGINE_ID = 'dv-engine';
const STACK_TG = 'dv-stack-tools';
const MPR_TG = 'dv-mpr-tools';
const MPR_VOI_SYNC = 'dv-mpr-voi';
const VOLUME_SCHEME = 'cornerstoneStreamingImageVolume';

const TOOL_CLASSES = {
  WindowLevel: cornerstoneTools.WindowLevelTool,
  Pan: cornerstoneTools.PanTool,
  Zoom: cornerstoneTools.ZoomTool,
  StackScroll: cornerstoneTools.StackScrollTool,
  Length: cornerstoneTools.LengthTool,
  Angle: cornerstoneTools.AngleTool,
  EllipticalROI: cornerstoneTools.EllipticalROITool,
  RectangleROI: cornerstoneTools.RectangleROITool,
  Probe: cornerstoneTools.ProbeTool,
  Crosshairs: cornerstoneTools.CrosshairsTool,
};
const toolName = (key) => TOOL_CLASSES[key].toolName;

const MPR_VIEWS = [
  { id: 'MPR_AXIAL', label: 'Axial', orientation: OrientationAxis.AXIAL },
  { id: 'MPR_SAGITTAL', label: 'Sagittal', orientation: OrientationAxis.SAGITTAL },
  { id: 'MPR_CORONAL', label: 'Coronal', orientation: OrientationAxis.CORONAL },
];
const STACK_VIEW = { id: 'STACK', label: '' };

const state = {
  engine: null,
  layout: 'stack',
  series: null,
  primaryTool: 'WindowLevel',
  focusedViewportId: STACK_VIEW.id,
  cineViewportId: null,
  hidePHI: true,
  listeners: [],
  onImageChange: () => {},
  onError: () => {},
};

// ---------- Initialisation ----------

export async function initViewer({ onImageChange, onError } = {}) {
  if (onImageChange) state.onImageChange = onImageChange;
  if (onError) state.onError = onError;

  await initCore();
  const cores = navigator.hardwareConcurrency || 2;
  dicomImageLoader.init({ maxWebWorkers: Math.max(1, Math.min(4, cores - 1)) });
  cornerstoneTools.init();
  volumeLoader.registerVolumeLoader(VOLUME_SCHEME, cornerstoneStreamingImageVolumeLoader);

  Object.values(TOOL_CLASSES).forEach((cls) => cornerstoneTools.addTool(cls));

  for (const [groupId, withCrosshairs] of [[STACK_TG, false], [MPR_TG, true]]) {
    const group = ToolGroupManager.createToolGroup(groupId);
    for (const key of Object.keys(TOOL_CLASSES)) {
      if (key === 'Crosshairs' && !withCrosshairs) continue;
      group.addTool(toolName(key));
    }
    group.setToolActive(toolName('WindowLevel'), { bindings: [{ mouseButton: MouseBindings.Primary }] });
    group.setToolActive(toolName('Pan'), { bindings: [{ mouseButton: MouseBindings.Auxiliary }] });
    group.setToolActive(toolName('Zoom'), { bindings: [{ mouseButton: MouseBindings.Secondary }] });
    group.setToolActive(toolName('StackScroll'), { bindings: [{ mouseButton: MouseBindings.Wheel }] });
    for (const key of ['Length', 'Angle', 'EllipticalROI', 'RectangleROI', 'Probe']) {
      group.setToolPassive(toolName(key));
    }
  }

  state.engine = new RenderingEngine(ENGINE_ID);
  window.addEventListener('resize', debounce(() => state.engine?.resize(true, true), 80));
  new ResizeObserver(debounce(() => state.engine?.resize(true, true), 80))
    .observe(document.getElementById('viewport-grid'));
}

// ---------- Viewport DOM ----------

function buildViewportDom(views) {
  const grid = document.getElementById('viewport-grid');
  grid.innerHTML = '';
  grid.className = `viewport-grid layout-${state.layout}`;
  const elements = {};
  for (const v of views) {
    const wrap = document.createElement('div');
    wrap.className = 'vp';
    wrap.dataset.viewportId = v.id;
    const el = document.createElement('div');
    el.className = 'vp-element';
    el.oncontextmenu = (e) => e.preventDefault();
    const overlay = document.createElement('div');
    overlay.className = 'vp-overlay';
    overlay.innerHTML = '<div class="c tl"></div><div class="c tr"></div><div class="c bl"></div><div class="c br"></div>';
    wrap.append(el, overlay);
    wrap.addEventListener('pointerdown', () => setFocused(v.id), true);
    grid.append(wrap);
    elements[v.id] = el;
  }
  return elements;
}

function setFocused(viewportId) {
  state.focusedViewportId = viewportId;
  document.querySelectorAll('.vp').forEach((n) => n.classList.toggle('focused',
    state.layout === 'mpr' && n.dataset.viewportId === viewportId));
}

function teardownViewports() {
  stopCine();
  state.listeners.forEach(({ el, type, fn }) => el.removeEventListener(type, fn));
  state.listeners = [];
  // Crosshairs warns if left active while its viewports are removed.
  const mprGroup = ToolGroupManager.getToolGroup(MPR_TG);
  if (mprGroup?.getActivePrimaryMouseButtonTool() === toolName('Crosshairs')) mprGroup.setToolPassive(toolName('Crosshairs'));
  for (const gid of [STACK_TG, MPR_TG]) ToolGroupManager.getToolGroup(gid)?.removeViewports(ENGINE_ID);
  if (SynchronizerManager.getSynchronizer(MPR_VOI_SYNC)) SynchronizerManager.destroySynchronizer(MPR_VOI_SYNC);
  for (const vp of state.engine.getViewports()) state.engine.disableElement(vp.id);
}

function listen(el, type, fn) {
  el.addEventListener(type, fn);
  state.listeners.push({ el, type, fn });
}

function attachOverlayListeners(viewportId, element) {
  const update = rafThrottle(() => updateOverlay(viewportId));
  for (const ev of [Events.IMAGE_RENDERED, Events.VOI_MODIFIED, Events.CAMERA_MODIFIED]) listen(element, ev, update);
  listen(element, Events.STACK_NEW_IMAGE, () => {
    const vp = state.engine.getViewport(viewportId);
    state.onImageChange(vp?.getCurrentImageId?.());
  });
}

// ---------- Loading series ----------

export async function showSeries(series, layout = state.layout) {
  if (layout === 'mpr' && !series.mpr?.ok) layout = 'stack';
  state.series = series;
  state.layout = layout;
  teardownViewports();
  if (layout === 'mpr') await showMpr(series);
  else await showStack(series);
  applyPrimaryTool(state.primaryTool);
  return layout;
}

async function showStack(series) {
  const elements = buildViewportDom([STACK_VIEW]);
  state.engine.enableElement({
    viewportId: STACK_VIEW.id,
    type: ViewportType.STACK,
    element: elements[STACK_VIEW.id],
    defaultOptions: { background: [0, 0, 0] },
  });
  ToolGroupManager.getToolGroup(STACK_TG).addViewport(STACK_VIEW.id, ENGINE_ID);
  attachOverlayListeners(STACK_VIEW.id, elements[STACK_VIEW.id]);
  setFocused(STACK_VIEW.id);

  const vp = state.engine.getViewport(STACK_VIEW.id);
  // Volumetric series open on the middle slice; others on the first image.
  const start = series.mpr?.ok ? Math.floor(series.imageIds.length / 2) : 0;
  try {
    await vp.setStack(series.imageIds, start);
  } catch (err) {
    state.onError(describeLoadError(err));
  }
  vp.render();
  state.onImageChange(vp.getCurrentImageId());
}

async function showMpr(series) {
  const elements = buildViewportDom(MPR_VIEWS);
  state.engine.setViewports(MPR_VIEWS.map((v) => ({
    viewportId: v.id,
    type: ViewportType.ORTHOGRAPHIC,
    element: elements[v.id],
    defaultOptions: { orientation: v.orientation, background: [0, 0, 0] },
  })));
  const group = ToolGroupManager.getToolGroup(MPR_TG);
  const voiSync = synchronizers.createVOISynchronizer(MPR_VOI_SYNC, { syncInvertState: true, syncColormap: false });
  for (const v of MPR_VIEWS) {
    group.addViewport(v.id, ENGINE_ID);
    voiSync.add({ renderingEngineId: ENGINE_ID, viewportId: v.id });
    attachOverlayListeners(v.id, elements[v.id]);
  }
  setFocused(MPR_VIEWS[0].id);

  const volumeId = `${VOLUME_SCHEME}:${series.uid}`;
  try {
    const volume = await volumeLoader.createAndCacheVolume(volumeId, { imageIds: series.imageIds });
    volume.load();
    await setVolumesForViewports(state.engine, [{ volumeId }], MPR_VIEWS.map((v) => v.id));
  } catch (err) {
    state.onError(describeLoadError(err));
  }
  state.engine.renderViewports(MPR_VIEWS.map((v) => v.id));
  state.onImageChange(series.imageIds[Math.floor(series.imageIds.length / 2)]);
}

function describeLoadError(err) {
  const msg = err?.error?.message || err?.message || String(err);
  return `Could not display this series: ${msg}`;
}

// ---------- Tools ----------

export function applyPrimaryTool(key) {
  if (key === 'Crosshairs' && state.layout !== 'mpr') key = 'WindowLevel';
  const groupId = state.layout === 'mpr' ? MPR_TG : STACK_TG;
  const group = ToolGroupManager.getToolGroup(groupId);
  const current = group.getActivePrimaryMouseButtonTool?.();
  if (current && current !== toolName(key)) {
    // Removes only the left-button binding; Pan (middle), Zoom (right) and
    // StackScroll (wheel) keep their secondary bindings.
    group.setToolPassive(current);
  }
  group.setToolActive(toolName(key), { bindings: [{ mouseButton: MouseBindings.Primary }] });
  state.primaryTool = key;
  // Keep the other group in step so switching layouts preserves the choice.
  const other = ToolGroupManager.getToolGroup(groupId === MPR_TG ? STACK_TG : MPR_TG);
  if (other && (key !== 'Crosshairs')) {
    const otherCurrent = other.getActivePrimaryMouseButtonTool?.();
    if (otherCurrent && otherCurrent !== toolName(key)) other.setToolPassive(otherCurrent);
    other.setToolActive(toolName(key), { bindings: [{ mouseButton: MouseBindings.Primary }] });
  }
  return key;
}

export function clearAnnotations() {
  annotation.state.removeAllAnnotations();
  state.engine?.render();
}

// ---------- Display properties ----------

function targetViewports() {
  if (!state.engine) return [];
  const vps = state.engine.getViewports();
  return state.layout === 'mpr' ? vps : vps.filter((v) => v.id === state.focusedViewportId);
}

export function setWindow(center, width) {
  for (const vp of targetViewports()) {
    vp.setProperties({ voiRange: { lower: center - width / 2, upper: center + width / 2 } });
    vp.render();
  }
}

export function resetWindow() {
  for (const vp of targetViewports()) {
    vp.resetProperties?.();
    vp.render();
  }
}

export function toggleInvert() {
  for (const vp of targetViewports()) {
    const { invert } = vp.getProperties();
    vp.setProperties({ invert: !invert });
    vp.render();
  }
}

export function resetView() {
  for (const vp of targetViewports()) {
    vp.resetCamera();
    vp.resetProperties?.();
    vp.render();
  }
}

export function scrollFocused(delta) {
  const vp = state.engine?.getViewport(state.focusedViewportId);
  if (!vp) return;
  vp.scroll(delta);
}

// ---------- Cine ----------

export function toggleCine(fps) {
  if (state.cineViewportId) { stopCine(); return false; }
  const vp = state.engine?.getViewport(state.focusedViewportId);
  if (!vp || vp.getNumberOfSlices() < 2) return false;
  toolUtils.cine.playClip(vp.element, { framesPerSecond: fps, loop: true });
  state.cineViewportId = vp.id;
  return true;
}

export function stopCine() {
  if (!state.cineViewportId) return;
  const vp = state.engine?.getViewport(state.cineViewportId);
  if (vp) toolUtils.cine.stopClip(vp.element);
  state.cineViewportId = null;
}

// ---------- Overlay text ----------

export function setHidePHI(hide) {
  state.hidePHI = hide;
  state.engine?.getViewports().forEach((vp) => updateOverlay(vp.id));
}

function updateOverlay(viewportId) {
  const vp = state.engine?.getViewport(viewportId);
  const wrap = document.querySelector(`.vp[data-viewport-id="${viewportId}"]`);
  if (!vp || !wrap || !state.series) return;
  const first = state.series.instances[0];
  const q = (c) => wrap.querySelector(`.c.${c}`);

  const patient = state.hidePHI
    ? 'Identifiers hidden'
    : [first.patientName || '(no name)', first.patientID && `ID ${first.patientID}`].filter(Boolean).join('\n');
  q('tl').textContent = [patient, formatDate(first.studyDate)].filter(Boolean).join('\n');

  const view = MPR_VIEWS.find((v) => v.id === viewportId);
  q('tr').innerHTML = '';
  if (view) {
    const label = document.createElement('div');
    label.className = 'label';
    label.textContent = view.label;
    q('tr').append(label);
  }
  q('tr').append(document.createTextNode([
    state.series.description || '(no description)',
    `${state.series.modality}  Se ${state.series.number ?? '–'}`,
  ].join('\n')));

  let idx = 0, n = 0;
  try {
    if (vp.getSliceIndex && state.layout === 'mpr') { idx = vp.getSliceIndex(); n = vp.getNumberOfSlices(); }
    else { idx = vp.getCurrentImageIdIndex(); n = vp.getNumberOfSlices(); }
  } catch { /* viewport not ready yet */ }
  const lines = [`Im ${n ? idx + 1 : 0} / ${n}`];
  if (state.layout === 'stack' && first.sliceThickness) lines.push(`Thk ${round(first.sliceThickness, 2)} mm`);
  q('bl').textContent = lines.join('\n');

  const props = vp.getProperties?.() || {};
  const voi = props.voiRange;
  const wl = voi ? `W ${Math.round(voi.upper - voi.lower)}  L ${Math.round((voi.upper + voi.lower) / 2)}` : '';
  let zoom = '';
  try { zoom = `Zoom ${round(vp.getZoom(), 2)}×`; } catch { /* not available */ }
  q('br').textContent = [wl, zoom, props.invert ? 'Inverted' : ''].filter(Boolean).join('\n');
}

// ---------- Close all ----------

export function closeAll() {
  teardownViewports();
  state.series = null;
  annotation.state.removeAllAnnotations();
  cache.purgeCache();
  document.getElementById('viewport-grid').innerHTML = '';
}

export function currentLayout() { return state.layout; }
export function currentSeries() { return state.series; }

// ---------- Small helpers ----------

function round(v, d) { const f = 10 ** d; return Math.round(v * f) / f; }
function formatDate(s) { return /^\d{8}$/.test(s) ? `${s.slice(0, 4)}-${s.slice(4, 6)}-${s.slice(6)}` : s; }
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function rafThrottle(fn) {
  let queued = false;
  return () => { if (queued) return; queued = true; requestAnimationFrame(() => { queued = false; fn(); }); };
}
