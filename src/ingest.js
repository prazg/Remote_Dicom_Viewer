// Reads local files, parses DICOM headers, registers each instance with the
// Cornerstone loaders, and groups instances into studies and series.
// Nothing here makes a network request: files are read with the File API.

import dicomParser from 'dicom-parser';
import dicomImageLoader from '@cornerstonejs/dicom-image-loader';
import { utilities as metadataUtils } from '@cornerstonejs/metadata';

const PIXEL_DATA = 'x7fe00010';
const READ_CONCURRENCY = 8;

/** @type {Map<string, Study>} */
export const studies = new Map();
/** imageId -> instance record (for the tag viewer) */
export const instancesByImageId = new Map();

// ---------- File collection ----------

/** Recursively collects File objects from a drag-and-drop DataTransfer. */
export async function filesFromDataTransfer(dataTransfer) {
  const entries = [];
  for (const item of dataTransfer.items || []) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return Array.from(dataTransfer.files || []);

  const files = [];
  async function walk(entry) {
    if (entry.isFile) {
      files.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      // readEntries returns results in batches; keep reading until empty.
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const entry of entries) await walk(entry);
  return files;
}

// ---------- Parsing ----------

function str(ds, tag) {
  try { return ds.string(tag)?.trim() || ''; } catch { return ''; }
}
function nums(ds, tag) {
  const s = str(ds, tag);
  if (!s) return null;
  const v = s.split('\\').map(Number);
  return v.every(Number.isFinite) ? v : null;
}
function int(ds, tag, fallback = null) {
  const s = str(ds, tag);
  if (s) { const n = parseInt(s, 10); if (Number.isFinite(n)) return n; }
  try { const u = ds.uint16(tag); if (u !== undefined) return u; } catch { /* not US */ }
  return fallback;
}

function looksLikeFileToSkip(file) {
  const n = file.name.toLowerCase();
  return n === 'dicomdir' || n.startsWith('.') || /\.(txt|xml|json|html?|pdf|jpe?g|png|zip|exe|ini|md)$/i.test(n);
}

/**
 * Parses one file. Returns null for anything that is not a DICOM image
 * (non-DICOM files, DICOMDIR, structured reports, etc.).
 */
async function parseFile(file) {
  if (looksLikeFileToSkip(file)) return null;
  const buffer = await file.arrayBuffer();
  const byteArray = new Uint8Array(buffer);
  let dataSet;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch {
    return null; // not Part 10 DICOM
  }
  if (!dataSet.elements[PIXEL_DATA]) return null;

  // Register the File with the loader (returns an id like "dicomfile:12"),
  // then hand the bytes to the metadata layer so geometry is known before
  // any pixels are decoded. That is what MPR needs to build a volume.
  const baseImageId = dicomImageLoader.wadouri.fileManager.add(file);
  await metadataUtils.addDicomPart10Instance(baseImageId, buffer);

  const numberOfFrames = int(dataSet, 'x00280008', 1) || 1;
  const imageIds = numberOfFrames > 1
    ? Array.from({ length: numberOfFrames }, (_, i) => `${baseImageId}?frame=${i + 1}`)
    : [baseImageId];

  return {
    file,
    dataSet,
    baseImageId,
    imageIds,
    numberOfFrames,
    studyUID: str(dataSet, 'x0020000d') || 'unknown-study',
    seriesUID: str(dataSet, 'x0020000e') || `unknown-series-${file.name}`,
    sopUID: str(dataSet, 'x00080018'),
    patientName: str(dataSet, 'x00100010').replace(/\^/g, ' ').trim(),
    patientID: str(dataSet, 'x00100020'),
    studyDate: str(dataSet, 'x00080020'),
    studyDescription: str(dataSet, 'x00081030'),
    seriesDescription: str(dataSet, 'x0008103e'),
    seriesNumber: int(dataSet, 'x00200011'),
    instanceNumber: int(dataSet, 'x00200013'),
    modality: str(dataSet, 'x00080060') || 'OT',
    rows: int(dataSet, 'x00280010'),
    columns: int(dataSet, 'x00280011'),
    samplesPerPixel: int(dataSet, 'x00280002', 1),
    iop: nums(dataSet, 'x00200037'),
    ipp: nums(dataSet, 'x00200032'),
    sliceThickness: nums(dataSet, 'x00180050')?.[0] ?? null,
    pixelSpacing: nums(dataSet, 'x00280030'),
    transferSyntax: str(dataSet, 'x00020010'),
  };
}

// ---------- Grouping & sorting ----------

function cross(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
const sameIop = (a, b) => a && b && a.every((v, i) => Math.abs(v - b[i]) < 1e-3);

function sortInstances(instances) {
  const ref = instances.find((i) => i.iop?.length === 6);
  const geometric = ref && instances.every((i) => i.ipp?.length === 3 && sameIop(i.iop, ref.iop));
  if (geometric) {
    const normal = cross(ref.iop.slice(0, 3), ref.iop.slice(3));
    instances.forEach((i) => { i._pos = dot(i.ipp, normal); });
    instances.sort((a, b) => a._pos - b._pos || (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
  } else {
    instances.sort((a, b) => (a.instanceNumber ?? 0) - (b.instanceNumber ?? 0));
  }
  return geometric;
}

/**
 * Decides whether a series can be reconstructed as a volume for MPR.
 * Conservative on purpose: single-frame, same orientation and matrix,
 * greyscale, at least 3 slices, and no duplicate slice positions.
 */
function mprEligibility(series) {
  const inst = series.instances;
  if (inst.length < 3) return { ok: false, reason: 'Fewer than 3 slices' };
  if (inst.some((i) => i.numberOfFrames > 1)) return { ok: false, reason: 'Multi-frame files are shown as a stack only' };
  if (inst.some((i) => i.samplesPerPixel !== 1)) return { ok: false, reason: 'Colour images are shown as a stack only' };
  if (!series.geometric) return { ok: false, reason: 'Slices lack consistent position / orientation' };
  if (inst.some((i) => i.rows !== inst[0].rows || i.columns !== inst[0].columns)) return { ok: false, reason: 'Slices have different matrix sizes' };
  const gaps = [];
  for (let k = 1; k < inst.length; k++) gaps.push(inst[k]._pos - inst[k - 1]._pos);
  if (gaps.some((g) => Math.abs(g) < 1e-3)) return { ok: false, reason: 'Duplicate slice positions (e.g. multiple echoes or phases)' };
  const mean = gaps.reduce((a, b) => a + b, 0) / gaps.length;
  const irregular = gaps.some((g) => Math.abs(g - mean) > Math.max(0.1, 0.2 * Math.abs(mean)));
  return { ok: true, irregular };
}

function addToCatalogue(instance) {
  let study = studies.get(instance.studyUID);
  if (!study) {
    study = {
      uid: instance.studyUID,
      patientName: instance.patientName,
      patientID: instance.patientID,
      date: instance.studyDate,
      description: instance.studyDescription,
      series: new Map(),
    };
    studies.set(instance.studyUID, study);
  }
  let series = study.series.get(instance.seriesUID);
  if (!series) {
    series = {
      uid: instance.seriesUID,
      studyUID: instance.studyUID,
      number: instance.seriesNumber,
      description: instance.seriesDescription,
      modality: instance.modality,
      instances: [],
      sopUIDs: new Set(),
    };
    study.series.set(instance.seriesUID, series);
  }
  // Skip exact duplicates (same SOP Instance UID dropped twice).
  if (instance.sopUID && series.sopUIDs.has(instance.sopUID)) return false;
  if (instance.sopUID) series.sopUIDs.add(instance.sopUID);
  series.instances.push(instance);
  instance.imageIds.forEach((id, frameIndex) => instancesByImageId.set(id, { instance, frameIndex }));
  return true;
}

function finaliseSeries(series) {
  series.geometric = sortInstances(series.instances);
  series.imageIds = series.instances.flatMap((i) => i.imageIds);
  series.mpr = mprEligibility(series);
}

/**
 * Ingests files with bounded concurrency.
 * @param {File[]} files
 * @param {(done:number,total:number)=>void} onProgress
 * @returns {Promise<{added:number, skipped:number, touchedSeries:object[]}>}
 */
export async function ingestFiles(files, onProgress = () => {}) {
  let done = 0, added = 0, skipped = 0;
  const touched = new Set();
  const queue = files.slice();

  async function worker() {
    while (queue.length) {
      const file = queue.shift();
      try {
        const inst = await parseFile(file);
        if (inst && addToCatalogue(inst)) {
          added++;
          touched.add(studies.get(inst.studyUID).series.get(inst.seriesUID));
        } else {
          skipped++;
        }
      } catch (err) {
        console.warn('Could not read', file.name, err);
        skipped++;
      }
      onProgress(++done, files.length);
    }
  }
  await Promise.all(Array.from({ length: Math.min(READ_CONCURRENCY, files.length) }, worker));

  touched.forEach(finaliseSeries);
  return { added, skipped, touchedSeries: [...touched] };
}

export function allSeries() {
  return [...studies.values()].flatMap((s) => [...s.series.values()]);
}

export function findSeries(seriesUID) {
  for (const study of studies.values()) {
    const s = study.series.get(seriesUID);
    if (s) return s;
  }
  return null;
}

export function clearCatalogue() {
  studies.clear();
  instancesByImageId.clear();
  dicomImageLoader.wadouri.fileManager.purge();
  dicomImageLoader.wadouri.dataSetCacheManager.purge();
  metadataUtils.clearCacheData();
}
