// Browser-local DICOM Sandbox ("Zero Upload" Quick-Viewer).
//
// Parses local Part 10 (Explicit/Implicit VR Little Endian & Big Endian) and
// raw Implicit-VR DICOM files 100% in browser RAM via dicom-parser + dcmjs,
// and includes a built-in multi-slice Synthetic Brain MRI (T1w+Gd) & Head CT
// (Hounsfield Unit) DICOM Part 10 phantom generator for instant exploration
// without any server or login.

import dicomParser from 'dicom-parser';
import dcmjs from 'dcmjs';
import { h } from './dom.js';

const $ = (id) => document.getElementById(id);
const DICT = dcmjs?.data?.DicomMetaDictionary?.dictionary || {};

const FALLBACK_TAGS = {
  '(0002,0000)': { name: 'FileMetaInformationGroupLength', vr: 'UL' },
  '(0002,0001)': { name: 'FileMetaInformationVersion', vr: 'OB' },
  '(0002,0002)': { name: 'MediaStorageSOPClassUID', vr: 'UI' },
  '(0002,0003)': { name: 'MediaStorageSOPInstanceUID', vr: 'UI' },
  '(0002,0010)': { name: 'TransferSyntaxUID', vr: 'UI' },
  '(0002,0012)': { name: 'ImplementationClassUID', vr: 'UI' },
  '(0002,0013)': { name: 'ImplementationVersionName', vr: 'SH' },
  '(0008,0008)': { name: 'ImageType', vr: 'CS' },
  '(0008,0016)': { name: 'SOPClassUID', vr: 'UI' },
  '(0008,0018)': { name: 'SOPInstanceUID', vr: 'UI' },
  '(0008,0020)': { name: 'StudyDate', vr: 'DA' },
  '(0008,0030)': { name: 'StudyTime', vr: 'TM' },
  '(0008,0050)': { name: 'AccessionNumber', vr: 'SH' },
  '(0008,0060)': { name: 'Modality', vr: 'CS' },
  '(0008,0070)': { name: 'Manufacturer', vr: 'LO' },
  '(0008,0080)': { name: 'InstitutionName', vr: 'LO' },
  '(0008,1030)': { name: 'StudyDescription', vr: 'LO' },
  '(0008,103E)': { name: 'SeriesDescription', vr: 'LO' },
  '(0010,0010)': { name: 'PatientName', vr: 'PN' },
  '(0010,0020)': { name: 'PatientID', vr: 'LO' },
  '(0010,0030)': { name: 'PatientBirthDate', vr: 'DA' },
  '(0010,0040)': { name: 'PatientSex', vr: 'CS' },
  '(0010,4000)': { name: 'PatientComments', vr: 'LT' },
  '(0018,0050)': { name: 'SliceThickness', vr: 'DS' },
  '(0018,0060)': { name: 'KVP', vr: 'DS' },
  '(0018,0080)': { name: 'RepetitionTime', vr: 'DS' },
  '(0018,0081)': { name: 'EchoTime', vr: 'DS' },
  '(0018,0087)': { name: 'MagneticFieldStrength', vr: 'DS' },
  '(0018,0088)': { name: 'SpacingBetweenSlices', vr: 'DS' },
  '(0018,1030)': { name: 'ProtocolName', vr: 'LO' },
  '(0020,000D)': { name: 'StudyInstanceUID', vr: 'UI' },
  '(0020,000E)': { name: 'SeriesInstanceUID', vr: 'UI' },
  '(0020,0010)': { name: 'StudyID', vr: 'SH' },
  '(0020,0011)': { name: 'SeriesNumber', vr: 'IS' },
  '(0020,0013)': { name: 'InstanceNumber', vr: 'IS' },
  '(0020,0032)': { name: 'ImagePositionPatient', vr: 'DS' },
  '(0020,0037)': { name: 'ImageOrientationPatient', vr: 'DS' },
  '(0020,0052)': { name: 'FrameOfReferenceUID', vr: 'UI' },
  '(0020,1041)': { name: 'SliceLocation', vr: 'DS' },
  '(0028,0002)': { name: 'SamplesPerPixel', vr: 'US' },
  '(0028,0004)': { name: 'PhotometricInterpretation', vr: 'CS' },
  '(0028,0008)': { name: 'NumberOfFrames', vr: 'IS' },
  '(0028,0010)': { name: 'Rows', vr: 'US' },
  '(0028,0011)': { name: 'Columns', vr: 'US' },
  '(0028,0030)': { name: 'PixelSpacing', vr: 'DS' },
  '(0028,0100)': { name: 'BitsAllocated', vr: 'US' },
  '(0028,0101)': { name: 'BitsStored', vr: 'US' },
  '(0028,0102)': { name: 'HighBit', vr: 'US' },
  '(0028,0103)': { name: 'PixelRepresentation', vr: 'US' },
  '(0028,1050)': { name: 'WindowCenter', vr: 'DS' },
  '(0028,1051)': { name: 'WindowWidth', vr: 'DS' },
  '(0028,1052)': { name: 'RescaleIntercept', vr: 'DS' },
  '(0028,1053)': { name: 'RescaleSlope', vr: 'DS' },
  '(0028,1054)': { name: 'RescaleType', vr: 'LO' },
  '(7FE0,0010)': { name: 'PixelData', vr: 'OW' },
};

const IDENTIFYING_NAMES = new Set([
  'PatientName', 'PatientID', 'IssuerOfPatientID', 'OtherPatientIDs', 'PatientBirthDate',
  'PatientBirthTime', 'PatientAddress', 'PatientTelephoneNumbers', 'AccessionNumber',
  'ReferringPhysicianName', 'PerformingPhysicianName', 'OperatorsName', 'InstitutionName',
  'InstitutionAddress', 'StationName', 'StudyID', 'DeviceSerialNumber', 'PatientComments',
]);

const TRANSFER_SYNTAX_LABELS = {
  '1.2.840.10008.1.2': 'Implicit VR Little Endian',
  '1.2.840.10008.1.2.1': 'Explicit VR Little Endian',
  '1.2.840.10008.1.2.2': 'Explicit VR Big Endian',
  '1.2.840.10008.1.2.1.99': 'Deflated Explicit VR LE',
};

const STRING_VRS = new Set(['AE', 'AS', 'CS', 'DA', 'DS', 'DT', 'IS', 'LO', 'LT', 'PN', 'SH', 'ST', 'TM', 'UI', 'UT', 'UC', 'UR']);
const BINARY_VRS = new Set(['OB', 'OW', 'OF', 'OD', 'OL', 'OV', 'UN']);

// Modality-aware radiology presets so presets look diagnostic on both CT (HU) and MRI (signal).
const PRESETS = {
  brain: { ct: [40, 80], mr: [530, 860], label: 'Brain' },
  subdural: { ct: [80, 200], mr: [640, 620], label: 'Subdural / Contrast' },
  stroke: { ct: [40, 40], mr: [560, 340], label: 'Stroke / Tight' },
  bone: { ct: [600, 2800], mr: [380, 1180], label: 'Bone / Calvarium' },
  soft: { ct: [50, 350], mr: [480, 940], label: 'Soft Tissue' },
  lung: { ct: [-600, 1500], mr: [220, 600], label: 'Lung' },
  angio: { ct: [300, 600], mr: [760, 520], label: 'Angio / High Signal' },
};

const state = {
  initialized: false,
  onExit: () => {},
  studies: [],
  activeSeries: null,
  plane: 'axial', // 'axial' | 'coronal' | 'sagittal'
  sliceIndex: 0,
  windowCenter: 40,
  windowWidth: 80,
  invert: false,
  zoom: 1,
  panX: 0,
  panY: 0,
  tool: 'wl', // 'wl' | 'scroll' | 'pan' | 'zoom' | 'length' | 'probe'
  hidePHI: false,
  cineTimer: null,
  rulers: [], // { seriesUid, plane, slice, x1, y1, x2, y2 }
  pendingRuler: null,
  hover: null, // { col, row, value, unit }
  drag: null,
  tagRows: [],
  lutDirty: true,
  toastTimer: null,
};

const offscreen = document.createElement('canvas');
const offCtx = offscreen.getContext('2d');

// ---------- Pure-JS DICOM Part 10 Explicit VR Little Endian Encoder ----------

function asciiBytes(str) {
  const s = String(str ?? '');
  const out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i) & 0x7f;
  return out;
}

function encStr(group, elem, vr, value) {
  const raw = asciiBytes(value);
  const padByte = vr === 'UI' ? 0x00 : 0x20;
  const paddedLen = raw.length + (raw.length % 2);
  const out = new Uint8Array(8 + paddedLen);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  dv.setUint16(6, paddedLen, true);
  out.set(raw, 8);
  if (paddedLen > raw.length) out[8 + raw.length] = padByte;
  return out;
}

function encUS(group, elem, val) {
  const out = new Uint8Array(10);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  out[4] = 0x55; out[5] = 0x53; // 'US'
  dv.setUint16(6, 2, true);
  dv.setUint16(8, val & 0xffff, true);
  return out;
}

function encUL(group, elem, val) {
  const out = new Uint8Array(12);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  out[4] = 0x55; out[5] = 0x4c; // 'UL'
  dv.setUint16(6, 4, true);
  dv.setUint32(8, val >>> 0, true);
  return out;
}

function encLongBytes(group, elem, vr, bytes) {
  const paddedLen = bytes.byteLength + (bytes.byteLength % 2);
  const out = new Uint8Array(12 + paddedLen);
  const dv = new DataView(out.buffer);
  dv.setUint16(0, group, true);
  dv.setUint16(2, elem, true);
  out[4] = vr.charCodeAt(0);
  out[5] = vr.charCodeAt(1);
  dv.setUint16(6, 0, true);
  dv.setUint32(8, paddedLen, true);
  out.set(new Uint8Array(bytes.buffer, bytes.byteOffset, bytes.byteLength), 12);
  return out;
}

function concatChunks(chunks) {
  let total = 0;
  for (const c of chunks) total += c.byteLength;
  const out = new Uint8Array(total);
  let offset = 0;
  for (const c of chunks) {
    out.set(c, offset);
    offset += c.byteLength;
  }
  return out;
}

function buildPart10Slice({
  sopClassUid, sopInstanceUid, studyUid, seriesUid, frameUid,
  modality, seriesNumber, instanceNumber, seriesDesc, protocolName,
  rows, cols, spacingMm, sliceThicknessMm, zMm,
  windowCenter, windowWidth, rescaleIntercept, rescaleSlope, rescaleType,
  extraGroup18 = [], pixelsInt16,
}) {
  const preamble = new Uint8Array(132);
  preamble[128] = 0x44; preamble[129] = 0x49; preamble[130] = 0x43; preamble[131] = 0x4d; // 'DICM'

  const metaBody = concatChunks([
    encLongBytes(0x0002, 0x0001, 'OB', new Uint8Array([0x00, 0x01])),
    encStr(0x0002, 0x0002, 'UI', sopClassUid),
    encStr(0x0002, 0x0003, 'UI', sopInstanceUid),
    encStr(0x0002, 0x0010, 'UI', '1.2.840.10008.1.2.1'),
    encStr(0x0002, 0x0012, 'UI', '1.2.826.0.1.3680043.8.498.1'),
    encStr(0x0002, 0x0013, 'SH', 'RDV_LOCAL_1_0'),
  ]);

  const halfSpanX = ((cols / 2) * spacingMm).toFixed(2);
  const halfSpanY = ((rows / 2) * spacingMm).toFixed(2);
  const zStr = zMm.toFixed(2);
  const spStr = `${spacingMm.toFixed(2)}\\${spacingMm.toFixed(2)}`;
  const thkStr = sliceThicknessMm.toFixed(2);

  const pixelBytes = new Uint8Array(pixelsInt16.buffer, pixelsInt16.byteOffset, pixelsInt16.byteLength);

  return concatChunks([
    preamble,
    encUL(0x0002, 0x0000, metaBody.byteLength),
    metaBody,
    // Group 0008
    encStr(0x0008, 0x0008, 'CS', 'DERIVED\\PRIMARY\\AXIAL'),
    encStr(0x0008, 0x0016, 'UI', sopClassUid),
    encStr(0x0008, 0x0018, 'UI', sopInstanceUid),
    encStr(0x0008, 0x0020, 'DA', '20261120'),
    encStr(0x0008, 0x0030, 'TM', '120000'),
    encStr(0x0008, 0x0050, 'SH', 'SYNTH-0001'),
    encStr(0x0008, 0x0060, 'CS', modality),
    encStr(0x0008, 0x0070, 'LO', 'Open Neuro & Pathology AI Suite'),
    encStr(0x0008, 0x0080, 'LO', 'Browser-Local Synthetic Phantom'),
    encStr(0x0008, 0x1030, 'LO', 'Synthetic Brain MRI & Head CT Reference Phantom'),
    encStr(0x0008, 0x103e, 'LO', seriesDesc),
    // Group 0010
    encStr(0x0010, 0x0010, 'PN', 'PHANTOM^NEURO^SYNTHETIC'),
    encStr(0x0010, 0x0020, 'LO', 'SYNTH-BRAIN-001'),
    encStr(0x0010, 0x0030, 'DA', '19800101'),
    encStr(0x0010, 0x0040, 'CS', 'O'),
    encStr(0x0010, 0x4000, 'LT', '100% synthetic mathematical phantom generated in browser RAM (zero patient data)'),
    // Group 0018 (strictly ascending element numbers)
    encStr(0x0018, 0x0050, 'DS', thkStr),
    ...extraGroup18,
    encStr(0x0018, 0x0088, 'DS', thkStr),
    encStr(0x0018, 0x1030, 'LO', protocolName),
    // Group 0020
    encStr(0x0020, 0x000d, 'UI', studyUid),
    encStr(0x0020, 0x000e, 'UI', seriesUid),
    encStr(0x0020, 0x0010, 'SH', 'SYNTH01'),
    encStr(0x0020, 0x0011, 'IS', String(seriesNumber)),
    encStr(0x0020, 0x0013, 'IS', String(instanceNumber)),
    encStr(0x0020, 0x0032, 'DS', `-${halfSpanX}\\-${halfSpanY}\\${zStr}`),
    encStr(0x0020, 0x0037, 'DS', '1\\0\\0\\0\\1\\0'),
    encStr(0x0020, 0x0052, 'UI', frameUid),
    encStr(0x0020, 0x1041, 'DS', zStr),
    // Group 0028
    encUS(0x0028, 0x0002, 1),
    encStr(0x0028, 0x0004, 'CS', 'MONOCHROME2'),
    encUS(0x0028, 0x0010, rows),
    encUS(0x0028, 0x0011, cols),
    encStr(0x0028, 0x0030, 'DS', spStr),
    encUS(0x0028, 0x0100, 16),
    encUS(0x0028, 0x0101, 16),
    encUS(0x0028, 0x0102, 15),
    encUS(0x0028, 0x0103, 1),
    encStr(0x0028, 0x1050, 'DS', String(windowCenter)),
    encStr(0x0028, 0x1051, 'DS', String(windowWidth)),
    encStr(0x0028, 0x1052, 'DS', String(rescaleIntercept)),
    encStr(0x0028, 0x1053, 'DS', String(rescaleSlope)),
    encStr(0x0028, 0x1054, 'LO', rescaleType),
    // Group 7FE0
    encLongBytes(0x7fe0, 0x0010, 'OW', pixelBytes),
  ]);
}

// ---------- Synthetic Brain MRI + Head CT Multi-Slice Phantom Generator ----------

function mulberry32(seed) {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function generateSyntheticPhantomFiles() {
  const N = 224;
  const Z = 24;
  const sp = 0.95; // mm in-plane
  const dz = 4.0;  // mm slice thickness
  const cx = N / 2;
  const cy = N / 2;

  const studyUid = '2.25.90184726150019283746501';
  const frameUid = '2.25.90184726150019283746502';
  const mrSeriesUid = '2.25.90184726150019283746510';
  const ctSeriesUid = '2.25.90184726150019283746520';
  const MR_SOP = '1.2.840.10008.5.1.4.1.1.4';
  const CT_SOP = '1.2.840.10008.5.1.4.1.1.2';

  const files = [];

  for (let k = 0; k < Z; k++) {
    const zMm = (k - (Z - 1) / 2) * dz; // -46 mm to +46 mm
    const mrPixels = new Int16Array(N * N);
    const ctPixels = new Int16Array(N * N);
    const rng = mulberry32(1000 + k * 97);

    // Semi-axes of outer head ellipsoid at this Z
    const aHead = 76;
    const bHead = 94;
    const cHead = 74;
    const zNorm = zMm / cHead;
    const zFactor = 1 - zNorm * zNorm;

    for (let row = 0; row < N; row++) {
      const yMm = (row - cy) * sp;
      for (let col = 0; col < N; col++) {
        const xMm = (col - cx) * sp;
        const idx = row * N + col;
        const n1 = (rng() + rng() - 1); // [-1, 1] triangular noise

        const rEllip = (xMm * xMm) / (aHead * aHead) + (yMm * yMm) / (bHead * bHead) + zNorm * zNorm;
        if (rEllip >= 1.0 || zFactor <= 0.04) {
          // Background air
          mrPixels[idx] = Math.max(0, Math.round(12 + Math.abs(n1) * 10));
          ctPixels[idx] = Math.round((-1000 + n1 * 6) + 1024);
          continue;
        }

        const theta = Math.atan2(yMm, xMm);
        const gyralWave = 0.032 * Math.cos(8 * theta + zMm * 0.08) + 0.022 * Math.sin(14 * theta - zMm * 0.11);

        let mrVal = 90;
        let ctHu = 8;

        if (rEllip >= 0.93) {
          // Scalp / subcutaneous lipid rim
          mrVal = 790;
          ctHu = 42;
        } else if (rEllip >= 0.84) {
          // Calvarium: outer/inner cortical tables + diploic marrow
          const midSkull = Math.abs(rEllip - 0.885) < 0.018;
          mrVal = midSkull ? 320 : 55;
          ctHu = midSkull ? 720 : 1380;
          // Linear right parietal fracture cleft on slices 11..15 (visible on Bone window!)
          if (k >= 11 && k <= 15 && xMm < -42 && Math.abs(yMm - 14 - (xMm + 58) * 0.35) < 1.35) {
            ctHu = -60;
            mrVal = 150;
          }
        } else if (rEllip >= 0.79 + gyralWave) {
          // Subarachnoid CSF space
          mrVal = 95;
          ctHu = 8;
        } else {
          // Intracranial parenchyma
          const inCortex = rEllip >= 0.66 + gyralWave * 1.35;
          const interhemispheric = Math.abs(xMm) < (1.4 + 0.6 * Math.max(0, Math.abs(yMm) - 24) / 40);

          if (interhemispheric && (Math.abs(yMm) > 22 || zMm > 20)) {
            // Interhemispheric fissure & falx cerebri
            const falxCore = Math.abs(xMm) < 0.65;
            mrVal = falxCore ? 470 : 105;
            ctHu = falxCore ? 48 : 9;
          } else if (inCortex) {
            // Cortical grey matter ribbon
            mrVal = 515;
            ctHu = 39;
          } else {
            // Subcortical & deep white matter
            mrVal = 685;
            ctHu = 28;
          }

          // Corpus callosum genu & splenium bridges
          const ccGenu = Math.abs(zMm - 2) < 11 && Math.abs(xMm) < 18 && yMm > -32 && yMm < -18;
          const ccSplen = Math.abs(zMm - 4) < 11 && Math.abs(xMm) < 22 && yMm > 20 && yMm < 34;
          if (ccGenu || ccSplen) {
            mrVal = 745;
            ctHu = 26;
          }

          // Paired butterfly-shaped lateral ventricles + midline 3rd ventricle
          if (Math.abs(zMm - 2) < 18) {
            const zVent = (zMm - 2) / 18;
            const axX = Math.abs(xMm) - (8.5 + 0.14 * Math.abs(yMm + 4));
            const latVent = (axX * axX) / (7.8 * 7.8) + ((yMm - 2) * (yMm - 2)) / (29 * 29) + zVent * zVent < 1.0;
            const thirdVent = Math.abs(xMm) < 2.1 && Math.abs(yMm - 4) < 11 && Math.abs(zMm + 4) < 9;
            if (latVent || thirdVent) {
              mrVal = 82;
              ctHu = 7;
            }
          }

          // Deep grey nuclei (caudate, lentiform, thalamus)
          if (Math.abs(zMm + 2) < 14) {
            const axX = Math.abs(xMm);
            const caudate = ((axX - 13) ** 2) / 22 + ((yMm + 15) ** 2) / 65 < 1;
            const lentiform = ((axX - 24) ** 2) / 42 + ((yMm + 3) ** 2) / 120 < 1;
            const thalamus = ((axX - 12) ** 2) / 48 + ((yMm - 13) ** 2) / 95 < 1;
            if ((caudate || lentiform || thalamus) && mrVal > 200) {
              mrVal = 545;
              ctHu = 38;
            }
          }

          // Pathology 1 (MRI focus): Right frontal 24.0 mm ring-enhancing glioma (radiological right = image left, xMm < 0)
          const lx = xMm + 29;
          const ly = yMm + 22;
          const lz = zMm - 6;
          const rLesionMm = Math.sqrt(lx * lx + ly * ly + lz * lz);
          if (rLesionMm < 21.0) {
            if (rLesionMm < 8.5) {
              // Central necrotic core
              mrVal = 185;
              ctHu = 19;
            } else if (rLesionMm <= 12.0) {
              // Enhancing outer rim (exact outer diameter = 24.0 mm!)
              mrVal = 1090;
              ctHu = 46;
            } else {
              // Perilesional vasogenic edema finger
              const blend = (rLesionMm - 12.0) / 9.0;
              mrVal = Math.round(370 * (1 - blend) + mrVal * blend);
              ctHu = Math.round(18 * (1 - blend) + ctHu * blend);
            }
          }

          // Pathology 2 (CT focus): Acute hyperdense convexity subdural crescent hematoma (+74 HU)
          if (zMm > -14 && zMm < 26 && xMm < -18 && yMm > -45 && yMm < 45 && rEllip > 0.69 && rEllip < 0.835) {
            ctHu = 74;
            mrVal = Math.round(mrVal * 0.5 + 430 * 0.5);
          }
        }

        mrPixels[idx] = Math.max(0, Math.round(mrVal + n1 * 14));
        ctPixels[idx] = Math.round((ctHu + n1 * 3.5) + 1024);
      }
    }

    const sliceNum = String(k + 1).padStart(3, '0');
    const mrBytes = buildPart10Slice({
      sopClassUid: MR_SOP,
      sopInstanceUid: `${mrSeriesUid}.${k + 1}`,
      studyUid,
      seriesUid: mrSeriesUid,
      frameUid,
      modality: 'MR',
      seriesNumber: 1,
      instanceNumber: k + 1,
      seriesDesc: 'Ax T1w +Gd Brain MRI (24mm Frontal Lesion)',
      protocolName: 'AX_3D_T1_POST_GAD',
      rows: N,
      cols: N,
      spacingMm: sp,
      sliceThicknessMm: dz,
      zMm,
      windowCenter: 530,
      windowWidth: 860,
      rescaleIntercept: 0,
      rescaleSlope: 1,
      rescaleType: 'AU',
      extraGroup18: [
        encStr(0x0018, 0x0080, 'DS', '650'),
        encStr(0x0018, 0x0081, 'DS', '14'),
        encStr(0x0018, 0x0087, 'DS', '3.0'),
      ],
      pixelsInt16: mrPixels,
    });
    files.push(new File([mrBytes], `synth_brain_mri_t1gd_${sliceNum}.dcm`, { type: 'application/dicom' }));

    const ctBytes = buildPart10Slice({
      sopClassUid: CT_SOP,
      sopInstanceUid: `${ctSeriesUid}.${k + 1}`,
      studyUid,
      seriesUid: ctSeriesUid,
      frameUid,
      modality: 'CT',
      seriesNumber: 2,
      instanceNumber: k + 1,
      seriesDesc: 'Ax Non-Contrast Head CT (Subdural + Skull Fx)',
      protocolName: 'HEAD_NCCT_TRAUMA',
      rows: N,
      cols: N,
      spacingMm: sp,
      sliceThicknessMm: dz,
      zMm,
      windowCenter: 40,
      windowWidth: 80,
      rescaleIntercept: -1024,
      rescaleSlope: 1,
      rescaleType: 'HU',
      extraGroup18: [
        encStr(0x0018, 0x0060, 'DS', '120'),
      ],
      pixelsInt16: ctPixels,
    });
    files.push(new File([ctBytes], `synth_head_ct_hu_${sliceNum}.dcm`, { type: 'application/dicom' }));
  }

  return files;
}

// ---------- DICOM Reader (Explicit / Implicit VR + Uncompressed Pixels) ----------

function dsStr(ds, tag) {
  try { return (ds.string(tag) || '').trim(); } catch { return ''; }
}

function dsNums(ds, tag) {
  const s = dsStr(ds, tag);
  if (!s) return null;
  const arr = s.split('\\').map(Number);
  return arr.every(Number.isFinite) ? arr : null;
}

function dsInt(ds, tag, fallback = null) {
  const s = dsStr(ds, tag);
  if (s) {
    const n = parseInt(s, 10);
    if (Number.isFinite(n)) return n;
  }
  try {
    const u = ds.uint16(tag);
    if (u !== undefined) return u;
  } catch { /* ignore */ }
  return fallback;
}

function shouldSkipNonDicom(file) {
  const n = file.name.toLowerCase();
  return n === 'dicomdir' || n.startsWith('.') || /\.(txt|xml|json|html?|pdf|jpe?g|png|zip|exe|ini|md|csv)$/i.test(n);
}

function decodeFrames(ds, fileBytes) {
  const pxEl = ds.elements.x7fe00010;
  if (!pxEl) return null;

  const transferSyntax = dsStr(ds, 'x00020010') || '1.2.840.10008.1.2.1';
  const bigEndian = transferSyntax === '1.2.840.10008.1.2.2';
  const rows = dsInt(ds, 'x00280010', 0);
  const cols = dsInt(ds, 'x00280011', 0);
  if (!rows || !cols) return null;

  const samplesPerPixel = dsInt(ds, 'x00280002', 1) || 1;
  const photometric = (dsStr(ds, 'x00280004') || 'MONOCHROME2').toUpperCase();
  const planarConfig = dsInt(ds, 'x00280006', 0) || 0;
  const numberOfFrames = Math.max(1, dsInt(ds, 'x00280008', 1) || 1);
  const bitsAllocated = dsInt(ds, 'x00280100', 16) || 16;
  const bitsStored = dsInt(ds, 'x00280101', bitsAllocated) || bitsAllocated;
  const pixelRep = dsInt(ds, 'x00280103', 0) || 0;
  const slope = dsNums(ds, 'x00281053')?.[0] ?? 1;
  const intercept = dsNums(ds, 'x00281052')?.[0] ?? 0;

  if (pxEl.encapsulatedPixelData || (transferSyntax.startsWith('1.2.840.10008.1.2.4') || transferSyntax.startsWith('1.2.840.10008.1.2.5'))) {
    return { unsupportedCodec: transferSyntax, rows, cols, samplesPerPixel, photometric, numberOfFrames };
  }

  const numPixels = rows * cols;
  const availBytes = fileBytes.byteLength - pxEl.dataOffset;
  const dv = new DataView(fileBytes.buffer, fileBytes.byteOffset + pxEl.dataOffset, Math.max(0, availBytes));

  const frames = [];

  if (samplesPerPixel === 3 && bitsAllocated === 8) {
    const frameBytes = numPixels * 3;
    for (let f = 0; f < numberOfFrames; f++) {
      const base = f * frameBytes;
      if (base + frameBytes > availBytes) break;
      const rgba = new Uint8ClampedArray(numPixels * 4);
      if (planarConfig === 0) {
        for (let i = 0; i < numPixels; i++) {
          rgba[i * 4] = dv.getUint8(base + i * 3);
          rgba[i * 4 + 1] = dv.getUint8(base + i * 3 + 1);
          rgba[i * 4 + 2] = dv.getUint8(base + i * 3 + 2);
          rgba[i * 4 + 3] = 255;
        }
      } else {
        for (let i = 0; i < numPixels; i++) {
          rgba[i * 4] = dv.getUint8(base + i);
          rgba[i * 4 + 1] = dv.getUint8(base + numPixels + i);
          rgba[i * 4 + 2] = dv.getUint8(base + 2 * numPixels + i);
          rgba[i * 4 + 3] = 255;
        }
      }
      frames.push({ kind: 'rgb', rgba, min: 0, max: 255 });
    }
    return { frames, rows, cols, samplesPerPixel, photometric, transferSyntax };
  }

  // Monochrome 8 / 16 / 32-bit
  const bytesPerSample = Math.max(1, Math.ceil(bitsAllocated / 8));
  const frameBytes = numPixels * bytesPerSample;
  const shift = Math.max(0, Math.min(24, 32 - bitsStored));
  const unsignedMask = bitsStored >= 16 ? 0xffff : ((1 << bitsStored) - 1);

  for (let f = 0; f < numberOfFrames; f++) {
    const base = f * frameBytes;
    if (base + frameBytes > availBytes) break;
    const scalars = new Float32Array(numPixels);
    let min = Infinity;
    let max = -Infinity;

    for (let i = 0; i < numPixels; i++) {
      const off = base + i * bytesPerSample;
      let raw = 0;
      if (bytesPerSample === 1) {
        raw = pixelRep === 1 ? dv.getInt8(off) : dv.getUint8(off);
      } else if (bytesPerSample === 2) {
        const u16 = dv.getUint16(off, !bigEndian);
        raw = pixelRep === 1 ? ((u16 << shift) >> shift) : (u16 & unsignedMask);
      } else if (bytesPerSample === 4) {
        raw = pixelRep === 1 ? dv.getInt32(off, !bigEndian) : dv.getUint32(off, !bigEndian);
      }
      const v = raw * slope + intercept;
      scalars[i] = v;
      if (v < min) min = v;
      if (v > max) max = v;
    }
    if (!Number.isFinite(min)) { min = 0; max = 1; }
    frames.push({ kind: 'mono', scalars, min, max });
  }

  return { frames, rows, cols, samplesPerPixel: 1, photometric, transferSyntax };
}

async function parseLocalDicomFile(file) {
  if (shouldSkipNonDicom(file)) return null;
  const buffer = await file.arrayBuffer();
  const byteArray = new Uint8Array(buffer);
  let dataSet = null;
  try {
    dataSet = dicomParser.parseDicom(byteArray);
  } catch {
    // Fallback for legacy NEMA / raw Implicit VR Little Endian files without 128-byte preamble
    try {
      dataSet = dicomParser.parseDicom(byteArray, { TransferSyntaxUID: '1.2.840.10008.1.2' });
    } catch {
      return null;
    }
  }
  if (!dataSet?.elements?.x7fe00010) return null;

  const decoded = decodeFrames(dataSet, byteArray);
  if (!decoded) return null;

  const spacing = dsNums(dataSet, 'x00280030') || dsNums(dataSet, 'x00181164');
  const modality = (dsStr(dataSet, 'x00080060') || 'OT').toUpperCase();
  const rescaleType = dsStr(dataSet, 'x00281054') || (modality === 'CT' ? 'HU' : 'AU');
  const wc = dsNums(dataSet, 'x00281050')?.[0] ?? null;
  const ww = dsNums(dataSet, 'x00281051')?.[0] ?? null;
  const iop = dsNums(dataSet, 'x00200037');
  const ipp = dsNums(dataSet, 'x00200032');
  const sliceLoc = dsNums(dataSet, 'x00201041')?.[0] ?? null;
  const sliceThickness = dsNums(dataSet, 'x00180050')?.[0] ?? null;
  const spacingBetween = dsNums(dataSet, 'x00180088')?.[0] ?? null;

  return {
    file,
    byteArray,
    dataSet,
    decoded,
    studyUID: dsStr(dataSet, 'x0020000d') || 'local-study',
    seriesUID: dsStr(dataSet, 'x0020000e') || `local-series-${modality}`,
    sopUID: dsStr(dataSet, 'x00080018'),
    patientName: dsStr(dataSet, 'x00100010').replace(/\^/g, ' ').trim(),
    patientID: dsStr(dataSet, 'x00100020'),
    studyDate: dsStr(dataSet, 'x00080020'),
    studyDescription: dsStr(dataSet, 'x00081030'),
    seriesDescription: dsStr(dataSet, 'x0008103e'),
    seriesNumber: dsInt(dataSet, 'x00200011', 1),
    instanceNumber: dsInt(dataSet, 'x00200013', 1),
    modality,
    rescaleType,
    rows: decoded.rows,
    cols: decoded.cols,
    rowSpacing: spacing?.[0] ?? null,
    colSpacing: spacing?.[1] ?? null,
    sliceThickness,
    spacingBetween,
    iop,
    ipp,
    sliceLoc,
    windowCenter: wc,
    windowWidth: ww,
    photometric: decoded.photometric,
    transferSyntax: decoded.transferSyntax || dsStr(dataSet, 'x00020010') || '1.2.840.10008.1.2.1',
  };
}

function cross3(a, b) {
  return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
}
function dot3(a, b) {
  return a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
}

async function groupFilesIntoStudies(files) {
  const studyMap = new Map();
  let addedSlices = 0;
  let skipped = 0;

  for (const file of files) {
    const rec = await parseLocalDicomFile(file);
    if (!rec) {
      skipped++;
      continue;
    }

    let study = studyMap.get(rec.studyUID);
    if (!study) {
      study = {
        uid: rec.studyUID,
        patientName: rec.patientName,
        patientID: rec.patientID,
        studyDate: rec.studyDate,
        description: rec.studyDescription,
        seriesMap: new Map(),
      };
      studyMap.set(rec.studyUID, study);
    }

    let series = study.seriesMap.get(rec.seriesUID);
    if (!series) {
      series = {
        uid: rec.seriesUID,
        study,
        number: rec.seriesNumber,
        description: rec.seriesDescription,
        modality: rec.modality,
        rescaleType: rec.rescaleType,
        slices: [],
        seenSop: new Set(),
      };
      study.seriesMap.set(rec.seriesUID, series);
    }

    if (rec.sopUID && series.seenSop.has(rec.sopUID)) continue;
    if (rec.sopUID) series.seenSop.add(rec.sopUID);

    if (rec.decoded.unsupportedCodec) {
      series.slices.push({
        ...rec,
        frameIndex: 0,
        frame: null,
        unsupportedCodec: rec.decoded.unsupportedCodec,
      });
      addedSlices++;
      continue;
    }

    rec.decoded.frames.forEach((frame, frameIndex) => {
      series.slices.push({
        ...rec,
        frameIndex,
        frame,
        unsupportedCodec: null,
      });
      addedSlices++;
    });
  }

  const studies = [...studyMap.values()].map((study) => {
    const seriesList = [...study.seriesMap.values()].map((s) => {
      // Geometric sort along slice normal if IOP & IPP are present
      const ref = s.slices.find((sl) => sl.iop?.length === 6 && sl.ipp?.length === 3);
      if (ref && s.slices.every((sl) => sl.ipp?.length === 3)) {
        const normal = cross3(ref.iop.slice(0, 3), ref.iop.slice(3));
        s.slices.forEach((sl) => { sl._zPos = dot3(sl.ipp, normal); });
        s.slices.sort((a, b) => a._zPos - b._zPos || a.instanceNumber - b.instanceNumber || a.frameIndex - b.frameIndex);
      } else {
        s.slices.sort((a, b) => a.instanceNumber - b.instanceNumber || a.frameIndex - b.frameIndex);
        s.slices.forEach((sl, idx) => { sl._zPos = sl.sliceLoc ?? idx * (sl.sliceThickness || 1); });
      }

      const first = s.slices[0];
      const uniformMono = s.slices.length >= 3 && s.slices.every((sl) =>
        sl.frame?.kind === 'mono' && sl.rows === first.rows && sl.cols === first.cols);
      let dz = first?.spacingBetween || first?.sliceThickness || 1;
      if (s.slices.length >= 2) {
        const diff = Math.abs((s.slices[s.slices.length - 1]._zPos - s.slices[0]._zPos) / (s.slices.length - 1));
        if (diff > 0.05) dz = diff;
      }

      let seriesMin = Infinity;
      let seriesMax = -Infinity;
      for (const sl of s.slices) {
        if (sl.frame) {
          if (sl.frame.min < seriesMin) seriesMin = sl.frame.min;
          if (sl.frame.max > seriesMax) seriesMax = sl.frame.max;
        }
      }
      if (!Number.isFinite(seriesMin)) { seriesMin = -1024; seriesMax = 2000; }

      const defaultWidth = Math.max(1, first?.windowWidth || (seriesMax - seriesMin) * 0.85 || 100);
      const defaultCenter = first?.windowCenter ?? (seriesMin + seriesMax) / 2;

      return {
        ...s,
        canMpr: uniformMono,
        dzMm: dz,
        minVal: seriesMin,
        maxVal: seriesMax,
        defaultCenter,
        defaultWidth,
      };
    }).sort((a, b) => (a.number ?? 999) - (b.number ?? 999));

    return { ...study, series: seriesList };
  });

  return { studies, addedSlices, skipped };
}

// ---------- Recursive Folder Drop Helper ----------

async function collectDroppedFiles(dataTransfer) {
  const entries = [];
  for (const item of dataTransfer?.items || []) {
    const entry = item.webkitGetAsEntry?.();
    if (entry) entries.push(entry);
  }
  if (!entries.length) return Array.from(dataTransfer?.files || []);

  const out = [];
  async function walk(entry) {
    if (entry.isFile) {
      out.push(await new Promise((res, rej) => entry.file(res, rej)));
    } else if (entry.isDirectory) {
      const reader = entry.createReader();
      for (;;) {
        const batch = await new Promise((res, rej) => reader.readEntries(res, rej));
        if (!batch.length) break;
        for (const child of batch) await walk(child);
      }
    }
  }
  for (const e of entries) await walk(e);
  return out;
}

// ---------- Tag Extraction & Inspector ----------

function tagKeyParts(tag) {
  const g = tag.slice(1, 5).toUpperCase();
  const e = tag.slice(5, 9).toUpperCase();
  return { g, e, key: `(${g},${e})` };
}

function lookupTag(tag, ds) {
  const { g, e, key } = tagKeyParts(tag);
  if (parseInt(g, 16) % 2 === 1) {
    const elNum = parseInt(e, 16);
    return { name: elNum >= 0x10 && elNum <= 0xff ? 'PrivateCreator' : 'PrivateTag', vr: '' };
  }
  if (e === '0000') return { name: 'GroupLength', vr: 'UL' };
  const entry = DICT[key] || FALLBACK_TAGS[key] || DICT[`(${g.slice(0, 2)}xx,${e})`];
  let vr = entry?.vr || '';
  if (vr === 'OB|OW' || vr === 'OB or OW') vr = 'OW';
  if (vr === 'US|SS' || vr === 'US or SS') {
    vr = dsInt(ds, 'x00280103', 0) === 1 ? 'SS' : 'US';
  }
  return { name: entry?.name || 'UnknownTag', vr };
}

function formatNumericTag(ds, el, vr) {
  const bytes = { US: 2, SS: 2, UL: 4, SL: 4, FL: 4, FD: 8 }[vr];
  if (!bytes) return null;
  const count = Math.min(16, Math.floor(el.length / bytes));
  const vals = [];
  for (let i = 0; i < count; i++) {
    try {
      if (vr === 'US') vals.push(ds.uint16(el.tag, i));
      else if (vr === 'SS') vals.push(ds.int16(el.tag, i));
      else if (vr === 'UL') vals.push(ds.uint32(el.tag, i));
      else if (vr === 'SL') vals.push(ds.int32(el.tag, i));
      else if (vr === 'FL') vals.push(+ds.float(el.tag, i).toPrecision(6));
      else if (vr === 'FD') vals.push(+ds.double(el.tag, i).toPrecision(10));
    } catch { break; }
  }
  return vals.join('\\');
}

function extractTagRows(ds, depth = 0, out = []) {
  if (!ds?.elements) return out;
  for (const tag of Object.keys(ds.elements).sort()) {
    const el = ds.elements[tag];
    const info = lookupTag(tag, ds);
    const vr = el.vr || info.vr || (el.items ? 'SQ' : '');
    const { key } = tagKeyParts(tag);
    if (el.items) {
      out.push({ depth, key, vr: 'SQ', name: info.name, value: `${el.items.length} item(s)`, seq: true });
      el.items.forEach((item, idx) => {
        out.push({ depth: depth + 1, key: '', vr: '', name: `Item ${idx + 1}`, value: '', seq: true });
        if (item.dataSet) extractTagRows(item.dataSet, depth + 2, out);
      });
      continue;
    }
    let value = '';
    if (tag === 'x7fe00010') {
      value = `<Pixel Data · ${el.length >= 0 ? el.length.toLocaleString() + ' bytes' : 'encapsulated'}>`;
    } else if (BINARY_VRS.has(vr)) {
      value = `<Binary · ${el.length.toLocaleString()} bytes>`;
    } else {
      const num = formatNumericTag(ds, el, vr);
      if (num !== null) value = num;
      else if (STRING_VRS.has(vr) || !vr) {
        const s = dsStr(ds, tag);
        value = s.length > 320 ? `${s.slice(0, 320)}…` : s;
      } else {
        value = `<${el.length} bytes>`;
      }
    }
    out.push({ depth, key, vr, name: info.name, value, seq: false });
  }
  return out;
}

function renderTagTable() {
  const tableEl = $('sb-tag-table');
  const countEl = $('sb-tags-count');
  if (!tableEl) return;

  const query = ($('sb-tag-search')?.value || '').trim().toLowerCase();
  const frag = document.createDocumentFragment();
  let shown = 0;

  for (const r of state.tagRows) {
    const masked = state.hidePHI && IDENTIFYING_NAMES.has(r.name);
    const displayVal = masked ? '[PHI masked locally]' : r.value;
    if (query) {
      const hay = `${r.key} ${r.vr} ${r.name} ${masked ? '' : r.value}`.toLowerCase();
      if (!hay.includes(query)) continue;
    }
    const row = h('div', {
      class: `tag-row${r.seq ? ' seq' : ''}${masked ? ' hidden-phi' : ''}`,
    },
      h('span', { class: 't' }, r.depth ? `${'  '.repeat(r.depth)}${r.key}` : r.key),
      h('span', { class: 'vr' }, r.vr),
      h('span', { class: 'n' }, r.name),
      h('span', { class: 'v' }, displayVal));
    frag.append(row);
    shown++;
  }

  tableEl.replaceChildren(frag);
  if (countEl) countEl.textContent = String(shown);

  if (!shown) {
    tableEl.append(h('p', { class: 'muted small pad' },
      state.tagRows.length ? 'No DICOM tags match your filter.' : 'Load a DICOM series to inspect metadata tags.'));
  }
}

function refreshTagsForCurrentSlice() {
  const series = state.activeSeries;
  const srcEl = $('sb-tag-source');
  if (!series || !series.slices.length) {
    state.tagRows = [];
    if (srcEl) srcEl.textContent = '';
    renderTagTable();
    return;
  }
  // In coronal/sagittal planes, show metadata from the middle axial slice (or active axial slice)
  const axialIdx = state.plane === 'axial'
    ? Math.min(series.slices.length - 1, Math.max(0, state.sliceIndex))
    : Math.floor(series.slices.length / 2);
  const sl = series.slices[axialIdx];
  state.tagRows = extractTagRows(sl.dataSet);
  const tsName = TRANSFER_SYNTAX_LABELS[sl.transferSyntax] || sl.transferSyntax;
  if (srcEl) {
    srcEl.textContent = `${sl.file.name} · ${tsName}`;
  }
  renderTagTable();
}

// ---------- Plane Geometry & Rendering ----------

function sliceCountForPlane(series, plane) {
  if (!series || !series.slices.length) return 0;
  if (plane === 'coronal' && series.canMpr) return series.slices[0].rows;
  if (plane === 'sagittal' && series.canMpr) return series.slices[0].cols;
  return series.slices.length;
}

function getPlaneRaster(series, plane, index) {
  if (!series || !series.slices.length) return null;
  const first = series.slices[0];

  if (plane === 'axial' || !series.canMpr) {
    const sl = series.slices[Math.max(0, Math.min(series.slices.length - 1, index))];
    return {
      width: sl.cols,
      height: sl.rows,
      dxMm: sl.colSpacing || 1,
      dyMm: sl.rowSpacing || 1,
      calibrated: Boolean(sl.colSpacing && sl.rowSpacing),
      zMm: sl._zPos,
      thicknessMm: sl.sliceThickness,
      photometric: sl.photometric,
      unsupportedCodec: sl.unsupportedCodec,
      frame: sl.frame,
      sampleAt: (col, row) => {
        if (!sl.frame || col < 0 || row < 0 || col >= sl.cols || row >= sl.rows) return null;
        if (sl.frame.kind === 'mono') return sl.frame.scalars[row * sl.cols + col];
        const o = (row * sl.cols + col) * 4;
        return `RGB(${sl.frame.rgba[o]},${sl.frame.rgba[o + 1]},${sl.frame.rgba[o + 2]})`;
      },
    };
  }

  const Z = series.slices.length;
  const R = first.rows;
  const C = first.cols;

  if (plane === 'coronal') {
    const rFixed = Math.max(0, Math.min(R - 1, index));
    const scalars = new Float32Array(C * Z);
    for (let z = 0; z < Z; z++) {
      const outRow = Z - 1 - z; // superior at top
      const src = series.slices[z].frame.scalars;
      const srcRowBase = rFixed * C;
      const dstRowBase = outRow * C;
      for (let c = 0; c < C; c++) scalars[dstRowBase + c] = src[srcRowBase + c];
    }
    const yMm = (rFixed - R / 2) * (first.rowSpacing || 1);
    return {
      width: C,
      height: Z,
      dxMm: first.colSpacing || 1,
      dyMm: series.dzMm || 1,
      calibrated: Boolean(first.colSpacing && series.dzMm),
      zMm: yMm,
      thicknessMm: first.rowSpacing,
      photometric: first.photometric,
      unsupportedCodec: null,
      frame: { kind: 'mono', scalars },
      sampleAt: (col, row) => {
        if (col < 0 || row < 0 || col >= C || row >= Z) return null;
        return scalars[row * C + col];
      },
    };
  }

  // Sagittal
  const cFixed = Math.max(0, Math.min(C - 1, index));
  const scalars = new Float32Array(R * Z);
  for (let z = 0; z < Z; z++) {
    const outRow = Z - 1 - z;
    const src = series.slices[z].frame.scalars;
    const dstRowBase = outRow * R;
    for (let r = 0; r < R; r++) scalars[dstRowBase + r] = src[r * C + cFixed];
  }
  const xMm = (cFixed - C / 2) * (first.colSpacing || 1);
  return {
    width: R,
    height: Z,
    dxMm: first.rowSpacing || 1,
    dyMm: series.dzMm || 1,
    calibrated: Boolean(first.rowSpacing && series.dzMm),
    zMm: xMm,
    thicknessMm: first.colSpacing,
    photometric: first.photometric,
    unsupportedCodec: null,
    frame: { kind: 'mono', scalars },
    sampleAt: (col, row) => {
      if (col < 0 || row < 0 || col >= R || row >= Z) return null;
      return scalars[row * R + col];
    },
  };
}

let cachedRaster = null;

function rebuildOffscreenLut() {
  const series = state.activeSeries;
  if (!series) {
    cachedRaster = null;
    return;
  }
  const raster = getPlaneRaster(series, state.plane, state.sliceIndex);
  cachedRaster = raster;
  if (!raster || !raster.frame || raster.unsupportedCodec) return;

  offscreen.width = raster.width;
  offscreen.height = raster.height;
  const imgData = offCtx.createImageData(raster.width, raster.height);
  const out = imgData.data;

  if (raster.frame.kind === 'rgb') {
    const src = raster.frame.rgba;
    if (state.invert) {
      for (let i = 0; i < src.length; i += 4) {
        out[i] = 255 - src[i];
        out[i + 1] = 255 - src[i + 1];
        out[i + 2] = 255 - src[i + 2];
        out[i + 3] = 255;
      }
    } else {
      out.set(src);
    }
    offCtx.putImageData(imgData, 0, 0);
    state.lutDirty = false;
    return;
  }

  const scalars = raster.frame.scalars;
  const ww = Math.max(1, state.windowWidth);
  const lower = state.windowCenter - ww / 2;
  const invRange = 255 / ww;
  const invertMono = (raster.photometric === 'MONOCHROME1') !== state.invert;

  for (let i = 0; i < scalars.length; i++) {
    let g = (scalars[i] - lower) * invRange;
    if (g <= 0) g = 0;
    else if (g >= 255) g = 255;
    const byte = invertMono ? (255 - (g | 0)) : (g | 0);
    const o = i * 4;
    out[o] = byte;
    out[o + 1] = byte;
    out[o + 2] = byte;
    out[o + 3] = 255;
  }
  offCtx.putImageData(imgData, 0, 0);
  state.lutDirty = false;
}

function getViewportGeometry(canvas, raster) {
  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, rect.width);
  const cssH = Math.max(1, rect.height);
  if (!raster) return { cssW, cssH, originX: 0, originY: 0, drawW: 0, drawH: 0, scale: 1 };

  const physW = raster.width * raster.dxMm;
  const physH = raster.height * raster.dyMm;
  const fit = Math.max(0.05, Math.min((cssW - 28) / physW, (cssH - 28) / physH));
  const scale = fit * state.zoom;
  const drawW = physW * scale;
  const drawH = physH * scale;
  const originX = (cssW - drawW) / 2 + state.panX;
  const originY = (cssH - drawH) / 2 + state.panY;
  return { cssW, cssH, originX, originY, drawW, drawH, scale };
}

function renderViewport() {
  const shell = $('local-sandbox');
  const canvas = $('sb-canvas');
  if (!shell || shell.hidden || !canvas) return;

  if (state.lutDirty) rebuildOffscreenLut();

  const rect = canvas.getBoundingClientRect();
  const cssW = Math.max(1, Math.floor(rect.width));
  const cssH = Math.max(1, Math.floor(rect.height));
  const dpr = Math.min(2.5, window.devicePixelRatio || 1);
  const targetW = Math.floor(cssW * dpr);
  const targetH = Math.floor(cssH * dpr);
  if (canvas.width !== targetW || canvas.height !== targetH) {
    canvas.width = targetW;
    canvas.height = targetH;
  }

  const ctx = canvas.getContext('2d');
  ctx.save();
  ctx.scale(dpr, dpr);
  ctx.fillStyle = '#000000';
  ctx.fillRect(0, 0, cssW, cssH);

  const series = state.activeSeries;
  const raster = cachedRaster;

  if (!series || !raster) {
    ctx.fillStyle = '#7d8aa3';
    ctx.font = '14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText('Drop DICOM (.dcm) files or click "Load Phantom"', cssW / 2, cssH / 2);
    ctx.restore();
    updateHud(null);
    return;
  }

  if (raster.unsupportedCodec) {
    ctx.fillStyle = '#fbbf24';
    ctx.font = '600 14px system-ui, sans-serif';
    ctx.textAlign = 'center';
    ctx.fillText(`Compressed transfer syntax (${raster.unsupportedCodec})`, cssW / 2, cssH / 2 - 10);
    ctx.fillStyle = '#94a3b8';
    ctx.font = '12.5px system-ui, sans-serif';
    ctx.fillText('All DICOM metadata tags remain inspectable in the right-hand panel.', cssW / 2, cssH / 2 + 14);
    ctx.restore();
    updateHud(raster);
    return;
  }

  const geom = getViewportGeometry(canvas, raster);
  ctx.imageSmoothingEnabled = state.zoom < 3.5 || state.plane !== 'axial';
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(offscreen, geom.originX, geom.originY, geom.drawW, geom.drawH);

  // Subtle image frame border
  ctx.strokeStyle = 'rgba(56, 189, 248, 0.18)';
  ctx.lineWidth = 1;
  ctx.strokeRect(geom.originX, geom.originY, geom.drawW, geom.drawH);

  // Draw distance rulers for active series, plane, and slice
  const activeRulers = state.rulers.filter((r) =>
    r.seriesUid === series.uid && r.plane === state.plane && r.slice === state.sliceIndex);
  const toDraw = state.pendingRuler ? [...activeRulers, state.pendingRuler] : activeRulers;

  for (const r of toDraw) {
    const x1 = geom.originX + r.x1 * raster.dxMm * geom.scale;
    const y1 = geom.originY + r.y1 * raster.dyMm * geom.scale;
    const x2 = geom.originX + r.x2 * raster.dxMm * geom.scale;
    const y2 = geom.originY + r.y2 * raster.dyMm * geom.scale;

    ctx.save();
    ctx.strokeStyle = '#38bdf8';
    ctx.lineWidth = 2;
    ctx.shadowColor = 'rgba(0, 0, 0, 0.85)';
    ctx.shadowBlur = 4;
    ctx.beginPath();
    ctx.moveTo(x1, y1);
    ctx.lineTo(x2, y2);
    ctx.stroke();

    // Endpoint handles
    for (const [px, py] of [[x1, y1], [x2, y2]]) {
      ctx.beginPath();
      ctx.arc(px, py, 4, 0, Math.PI * 2);
      ctx.fillStyle = '#05080f';
      ctx.fill();
      ctx.strokeStyle = '#38bdf8';
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    const dist = raster.calibrated
      ? `${Math.hypot((r.x2 - r.x1) * raster.dxMm, (r.y2 - r.y1) * raster.dyMm).toFixed(1)} mm`
      : `${Math.hypot(r.x2 - r.x1, r.y2 - r.y1).toFixed(1)} px`;

    ctx.font = '600 12px ui-monospace, SFMono-Regular, Menlo, Consolas, monospace';
    const textW = ctx.measureText(dist).width;
    const mx = (x1 + x2) / 2;
    const my = (y1 + y2) / 2 - 12;
    ctx.shadowBlur = 0;
    ctx.fillStyle = 'rgba(7, 13, 24, 0.88)';
    ctx.strokeStyle = 'rgba(56, 189, 248, 0.65)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    if (ctx.roundRect) ctx.roundRect(mx - textW / 2 - 6, my - 9, textW + 12, 19, 5);
    else ctx.rect(mx - textW / 2 - 6, my - 9, textW + 12, 19);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#e0f2fe';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(dist, mx, my + 0.5);
    ctx.restore();
  }

  ctx.restore();
  updateHud(raster);
}

function fmtStudyDate(d) {
  return /^\d{8}$/.test(d) ? `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6)}` : (d || '');
}

function updateHud(raster) {
  const series = state.activeSeries;
  const tl = $('sb-hud-tl');
  const tr = $('sb-hud-tr');
  const bl = $('sb-hud-bl');
  const br = $('sb-hud-br');
  if (!tl || !tr || !bl || !br) return;

  if (!series || !raster) {
    tl.textContent = ''; tr.textContent = ''; bl.textContent = ''; br.textContent = '';
    return;
  }

  const study = series.study;
  const pat = state.hidePHI
    ? 'Patient [PHI Masked]'
    : [study.patientName || '(Unnamed)', study.patientID ? `ID: ${study.patientID}` : ''].filter(Boolean).join('\n');
  tl.textContent = [pat, fmtStudyDate(study.studyDate), study.description].filter(Boolean).join('\n');

  const planeLabel = state.plane.toUpperCase();
  tr.textContent = [
    `${planeLabel} · ${series.modality}`,
    series.description || `Series ${series.number ?? 1}`,
    `${raster.width}×${raster.height} px`,
  ].join('\n');

  const total = sliceCountForPlane(series, state.plane);
  const posAxis = state.plane === 'axial' ? 'Z' : (state.plane === 'coronal' ? 'Y' : 'X');
  const locLine = Number.isFinite(raster.zMm) ? ` · ${posAxis} ${raster.zMm >= 0 ? '+' : ''}${raster.zMm.toFixed(1)} mm` : '';
  const spLine = raster.calibrated ? `Sp ${raster.dxMm.toFixed(2)}×${raster.dyMm.toFixed(2)} mm` : 'Uncalibrated px';
  const probeLine = state.hover
    ? `Probe (${state.hover.col}, ${state.hover.row}): ${state.hover.value} ${state.hover.unit}`
    : 'Hover image to probe intensity';
  bl.textContent = [`Slice ${state.sliceIndex + 1} / ${total}${locLine}`, spLine, probeLine].join('\n');

  const toolLabels = { wl: 'W/L', scroll: 'Scroll', pan: 'Pan', zoom: 'Zoom', length: 'Ruler (mm)', probe: 'Probe' };
  br.textContent = [
    `W ${Math.round(state.windowWidth)}  L ${Math.round(state.windowCenter)}`,
    `Zoom ${state.zoom.toFixed(2)}×${state.invert ? ' · Inverted' : ''}`,
    `Tool: ${toolLabels[state.tool] || state.tool}`,
  ].join('\n');

  // Sync scrubber & W/L sliders
  const slider = $('sb-slice-slider');
  const sliceLabel = $('sb-slice-label');
  if (slider) {
    slider.max = String(Math.max(1, total));
    slider.value = String(state.sliceIndex + 1);
  }
  if (sliceLabel) sliceLabel.textContent = `${state.sliceIndex + 1} / ${total}`;

  const cSlider = $('sb-wl-center');
  const wSlider = $('sb-wl-width');
  const cVal = $('sb-wl-center-val');
  const wVal = $('sb-wl-width-val');
  if (cSlider && wSlider) {
    const span = Math.max(200, series.maxVal - series.minVal);
    cSlider.min = String(Math.round(series.minVal - span * 0.25));
    cSlider.max = String(Math.round(series.maxVal + span * 0.25));
    cSlider.value = String(Math.round(state.windowCenter));
    wSlider.min = '1';
    wSlider.max = String(Math.round(Math.max(3200, span * 2)));
    wSlider.value = String(Math.round(state.windowWidth));
  }
  if (cVal) cVal.textContent = String(Math.round(state.windowCenter));
  if (wVal) wVal.textContent = String(Math.round(state.windowWidth));
}

// ---------- Series Thumbnails & Sidebar ----------

function drawSeriesThumb(series) {
  const thumbCanvas = document.createElement('canvas');
  thumbCanvas.width = 54;
  thumbCanvas.height = 54;
  const ctx = thumbCanvas.getContext('2d');
  ctx.fillStyle = '#000';
  ctx.fillRect(0, 0, 54, 54);

  const mid = series.slices[Math.floor(series.slices.length / 2)];
  if (!mid?.frame) return thumbCanvas;

  const tmp = document.createElement('canvas');
  tmp.width = mid.cols;
  tmp.height = mid.rows;
  const tctx = tmp.getContext('2d');
  const img = tctx.createImageData(mid.cols, mid.rows);
  const out = img.data;

  if (mid.frame.kind === 'rgb') {
    out.set(mid.frame.rgba);
  } else {
    const ww = Math.max(1, series.defaultWidth);
    const lower = series.defaultCenter - ww / 2;
    const inv = 255 / ww;
    const invert = mid.photometric === 'MONOCHROME1';
    const sc = mid.frame.scalars;
    for (let i = 0; i < sc.length; i++) {
      let g = (sc[i] - lower) * inv;
      if (g < 0) g = 0;
      else if (g > 255) g = 255;
      const b = invert ? (255 - (g | 0)) : (g | 0);
      const o = i * 4;
      out[o] = b; out[o + 1] = b; out[o + 2] = b; out[o + 3] = 255;
    }
  }
  tctx.putImageData(img, 0, 0);
  const scale = Math.min(54 / mid.cols, 54 / mid.rows);
  const dw = mid.cols * scale;
  const dh = mid.rows * scale;
  ctx.drawImage(tmp, (54 - dw) / 2, (54 - dh) / 2, dw, dh);
  return thumbCanvas;
}

function renderSidebarSeries() {
  const list = $('sb-series-list');
  if (!list) return;
  list.replaceChildren();

  if (!state.studies.length) {
    list.append(h('p', { class: 'muted small' }, 'No DICOM series loaded.'));
    return;
  }

  for (const study of state.studies) {
    const headTitle = state.hidePHI ? 'Patient [PHI Masked]' : (study.patientName || 'Unnamed Patient');
    const headSub = [fmtStudyDate(study.studyDate), study.description].filter(Boolean).join(' · ') || 'Local DICOM Study';
    const sec = h('section', { class: 'study' },
      h('div', { class: 'study-head' },
        h('div', { class: 'title' }, headTitle),
        h('div', { class: 'sub' }, headSub)));

    for (const s of study.series) {
      const first = s.slices[0];
      const thumbHolder = h('div', { class: 'thumb' });
      thumbHolder.append(drawSeriesThumb(s));

      const badges = h('div', {},
        h('span', { class: 'badge' }, s.modality),
        s.canMpr ? h('span', { class: 'badge', title: 'Supports Axial, Coronal & Sagittal reslicing' }, '3-Plane') : null);

      const btn = h('button', {
        type: 'button',
        class: `series${state.activeSeries?.uid === s.uid ? ' active' : ''}`,
        onclick: () => activateSeries(s),
      },
        thumbHolder,
        h('div', {},
          h('div', { class: 'name' }, s.description || `Series ${s.number ?? 1}`),
          h('div', { class: 'meta' }, `${s.slices.length} sl · ${first?.cols ?? 0}×${first?.rows ?? 0}`),
          badges));
      sec.append(btn);
    }
    list.append(sec);
  }
}

// ---------- Actions & Controls ----------

function sandboxToast(msg, kind = '', ms = 4200) {
  const el = $('sb-toast');
  if (!el) return;
  el.textContent = msg;
  el.className = `toast ${kind}`.trim();
  el.hidden = false;
  clearTimeout(state.toastTimer);
  state.toastTimer = setTimeout(() => { el.hidden = true; }, ms);
}

function stopSandboxCine() {
  if (state.cineTimer) {
    clearInterval(state.cineTimer);
    state.cineTimer = null;
  }
  const btn = $('sb-cine');
  if (btn) {
    btn.textContent = '▶';
    btn.setAttribute('aria-pressed', 'false');
  }
}

function toggleSandboxCine() {
  if (state.cineTimer) {
    stopSandboxCine();
    return;
  }
  const total = sliceCountForPlane(state.activeSeries, state.plane);
  if (total < 2) return;
  const btn = $('sb-cine');
  if (btn) {
    btn.textContent = '❚❚';
    btn.setAttribute('aria-pressed', 'true');
  }
  state.cineTimer = setInterval(() => {
    const n = sliceCountForPlane(state.activeSeries, state.plane);
    if (n < 2) { stopSandboxCine(); return; }
    setSliceIndex((state.sliceIndex + 1) % n);
  }, 95);
}

function setPlane(plane) {
  const s = state.activeSeries;
  if (!s) return;
  if (plane !== 'axial' && !s.canMpr) plane = 'axial';
  stopSandboxCine();
  state.plane = plane;
  state.pendingRuler = null;
  const total = sliceCountForPlane(s, plane);
  state.sliceIndex = Math.floor(total / 2);
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.lutDirty = true;

  document.querySelectorAll('[data-sb-plane]').forEach((b) => {
    const on = b.dataset.sbPlane === plane;
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    if (b.dataset.sbPlane !== 'axial') b.disabled = !s.canMpr;
  });

  refreshTagsForCurrentSlice();
  renderViewport();
}

function setSliceIndex(nextIdx) {
  const total = sliceCountForPlane(state.activeSeries, state.plane);
  if (!total) return;
  const clamped = Math.max(0, Math.min(total - 1, nextIdx));
  if (clamped === state.sliceIndex && !state.lutDirty) return;
  state.sliceIndex = clamped;
  state.pendingRuler = null;
  state.lutDirty = true;
  if (state.plane === 'axial') refreshTagsForCurrentSlice();
  renderViewport();
}

function setTool(tool) {
  state.tool = tool;
  state.pendingRuler = null;
  document.querySelectorAll('[data-sb-tool]').forEach((b) => {
    b.classList.toggle('active', b.dataset.sbTool === tool);
  });
  renderViewport();
}

function applyPreset(key) {
  const s = state.activeSeries;
  if (!s) return;
  if (key === 'auto') {
    state.windowCenter = s.defaultCenter;
    state.windowWidth = s.defaultWidth;
  } else if (PRESETS[key]) {
    const isCt = s.modality === 'CT' || s.rescaleType === 'HU';
    const [c, w] = isCt ? PRESETS[key].ct : PRESETS[key].mr;
    state.windowCenter = c;
    state.windowWidth = w;
  }
  document.querySelectorAll('[data-sb-quick-preset]').forEach((b) => {
    b.classList.toggle('active', b.dataset.sbQuickPreset === key);
  });
  state.lutDirty = true;
  renderViewport();
}

function activateSeries(series) {
  stopSandboxCine();
  state.activeSeries = series;
  state.windowCenter = series.defaultCenter;
  state.windowWidth = series.defaultWidth;
  state.invert = false;
  state.zoom = 1;
  state.panX = 0;
  state.panY = 0;
  state.hover = null;
  state.pendingRuler = null;
  state.plane = 'axial';
  state.sliceIndex = Math.floor(series.slices.length / 2);
  state.lutDirty = true;

  document.querySelectorAll('[data-sb-plane]').forEach((b) => {
    const on = b.dataset.sbPlane === 'axial';
    b.classList.toggle('active', on);
    b.setAttribute('aria-checked', String(on));
    if (b.dataset.sbPlane !== 'axial') b.disabled = !series.canMpr;
  });
  document.querySelectorAll('[data-sb-quick-preset]').forEach((b) => {
    b.classList.toggle('active', b.dataset.sbQuickPreset === 'auto');
  });

  renderSidebarSeries();
  refreshTagsForCurrentSlice();
  renderViewport();
  $('local-sandbox')?.classList.remove('sb-sidebar-open');
}

async function ingestSandboxFiles(files, sourceLabel = 'local files') {
  if (!files?.length) return;
  stopSandboxCine();
  const started = performance.now();
  const { studies, addedSlices, skipped } = await groupFilesIntoStudies(files);
  if (!studies.length || !addedSlices) {
    sandboxToast(`No readable DICOM Part 10 / Implicit-VR images found in ${files.length} file(s).`, 'error', 6500);
    return;
  }
  state.studies = studies;
  state.rulers = [];
  const allSeries = studies.flatMap((st) => st.series);
  const initial = allSeries[0];
  activateSeries(initial);
  const elapsed = ((performance.now() - started) / 1000).toFixed(2);
  const skipNote = skipped ? ` (${skipped} non-DICOM skipped)` : '';
  sandboxToast(`Loaded ${addedSlices} slice(s) across ${allSeries.length} series from ${sourceLabel} in ${elapsed}s${skipNote}. Zero bytes uploaded.`);
}

async function loadBuiltInPhantom() {
  const files = generateSyntheticPhantomFiles();
  await ingestSandboxFiles(files, 'Built-in Neuro MRI & Head CT Phantom');
}

function downloadActiveSliceDcm() {
  const s = state.activeSeries;
  if (!s || !s.slices.length) return;
  const idx = state.plane === 'axial' ? Math.min(s.slices.length - 1, state.sliceIndex) : Math.floor(s.slices.length / 2);
  const sl = s.slices[idx];
  const blob = new Blob([sl.byteArray], { type: 'application/dicom' });
  const url = URL.createObjectURL(blob);
  const a = h('a', { href: url, download: sl.file.name || 'slice.dcm' });
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
  sandboxToast(`Downloaded ${sl.file.name} locally.`);
}

// ---------- Canvas Pointer & Keyboard Wiring ----------

function canvasCoordsToImage(canvas, clientX, clientY) {
  const rect = canvas.getBoundingClientRect();
  const cssX = clientX - rect.left;
  const cssY = clientY - rect.top;
  if (!cachedRaster) return { cssX, cssY, imgX: 0, imgY: 0, inside: false };
  const geom = getViewportGeometry(canvas, cachedRaster);
  const imgX = (cssX - geom.originX) / (cachedRaster.dxMm * geom.scale);
  const imgY = (cssY - geom.originY) / (cachedRaster.dyMm * geom.scale);
  const inside = imgX >= 0 && imgY >= 0 && imgX <= cachedRaster.width && imgY <= cachedRaster.height;
  return { cssX, cssY, imgX, imgY, inside };
}

function updateHoverProbe(imgX, imgY, inside) {
  if (!inside || !cachedRaster || !state.activeSeries) {
    if (state.hover) {
      state.hover = null;
      updateHud(cachedRaster);
    }
    return;
  }
  const col = Math.min(cachedRaster.width - 1, Math.max(0, Math.floor(imgX)));
  const row = Math.min(cachedRaster.height - 1, Math.max(0, Math.floor(imgY)));
  const sample = cachedRaster.sampleAt(col, row);
  if (sample === null || sample === undefined) return;
  const unit = typeof sample === 'number' ? (state.activeSeries.rescaleType || '') : '';
  const value = typeof sample === 'number' ? Math.round(sample) : sample;
  state.hover = { col, row, value, unit };
  updateHud(cachedRaster);
}

function wireSandboxEvents() {
  $('sb-back').addEventListener('click', () => {
    stopSandboxCine();
    state.onExit();
  });

  $('sb-sidebar-toggle')?.addEventListener('click', () => {
    $('local-sandbox')?.classList.toggle('sb-sidebar-open');
  });

  $('sb-open-files').addEventListener('click', () => $('sb-input-files').click());
  $('sb-open-folder').addEventListener('click', () => $('sb-input-folder').click());
  $('sb-load-phantom').addEventListener('click', () => loadBuiltInPhantom());

  for (const id of ['sb-input-files', 'sb-input-folder']) {
    $(id).addEventListener('change', (e) => {
      const files = Array.from(e.target.files || []);
      e.target.value = '';
      if (files.length) ingestSandboxFiles(files, 'selected local files');
    });
  }

  document.querySelectorAll('[data-sb-plane]').forEach((b) => {
    b.addEventListener('click', () => setPlane(b.dataset.sbPlane));
  });

  document.querySelectorAll('[data-sb-tool]').forEach((b) => {
    b.addEventListener('click', () => setTool(b.dataset.sbTool));
  });

  $('sb-preset').addEventListener('change', (e) => {
    const val = e.target.value;
    e.target.value = '';
    if (val) applyPreset(val);
  });

  document.querySelectorAll('[data-sb-quick-preset]').forEach((b) => {
    b.addEventListener('click', () => applyPreset(b.dataset.sbQuickPreset));
  });

  $('sb-invert').addEventListener('click', () => {
    state.invert = !state.invert;
    state.lutDirty = true;
    renderViewport();
  });

  $('sb-reset').addEventListener('click', () => {
    if (!state.activeSeries) return;
    state.windowCenter = state.activeSeries.defaultCenter;
    state.windowWidth = state.activeSeries.defaultWidth;
    state.invert = false;
    state.zoom = 1;
    state.panX = 0;
    state.panY = 0;
    state.pendingRuler = null;
    state.lutDirty = true;
    renderViewport();
  });

  $('sb-cine').addEventListener('click', toggleSandboxCine);

  $('sb-clear-rulers').addEventListener('click', () => {
    state.rulers = [];
    state.pendingRuler = null;
    renderViewport();
  });

  $('sb-download-dcm').addEventListener('click', downloadActiveSliceDcm);

  $('sb-toggle-tags').addEventListener('click', () => {
    const panel = $('sb-tags-panel');
    panel.hidden = !panel.hidden;
    $('sb-toggle-tags').setAttribute('aria-pressed', String(!panel.hidden));
    requestAnimationFrame(renderViewport);
  });

  $('sb-tags-close').addEventListener('click', () => {
    $('sb-tags-panel').hidden = true;
    $('sb-toggle-tags').setAttribute('aria-pressed', 'false');
    requestAnimationFrame(renderViewport);
  });

  $('sb-tag-search').addEventListener('input', renderTagTable);

  $('sb-hide-phi').addEventListener('change', (e) => {
    state.hidePHI = e.target.checked;
    renderSidebarSeries();
    renderTagTable();
    updateHud(cachedRaster);
  });

  $('sb-prev-slice').addEventListener('click', () => setSliceIndex(state.sliceIndex - 1));
  $('sb-next-slice').addEventListener('click', () => setSliceIndex(state.sliceIndex + 1));
  $('sb-slice-slider').addEventListener('input', (e) => setSliceIndex(Number(e.target.value) - 1));

  $('sb-wl-center').addEventListener('input', (e) => {
    state.windowCenter = Number(e.target.value);
    state.lutDirty = true;
    renderViewport();
  });
  $('sb-wl-width').addEventListener('input', (e) => {
    state.windowWidth = Math.max(1, Number(e.target.value));
    state.lutDirty = true;
    renderViewport();
  });

  // Canvas pointer interactions
  const canvas = $('sb-canvas');
  canvas.addEventListener('contextmenu', (e) => e.preventDefault());

  canvas.addEventListener('pointerdown', (e) => {
    if (!state.activeSeries || !cachedRaster) return;
    canvas.focus({ preventScroll: true });
    canvas.setPointerCapture?.(e.pointerId);
    const pt = canvasCoordsToImage(canvas, e.clientX, e.clientY);

    let mode = state.tool;
    if (e.button === 1) mode = 'pan';
    else if (e.button === 2) mode = 'zoom';

    if (mode === 'length' && e.button === 0) {
      if (state.pendingRuler) {
        // Second click completes pending ruler
        state.pendingRuler.x2 = Math.max(0, Math.min(cachedRaster.width, pt.imgX));
        state.pendingRuler.y2 = Math.max(0, Math.min(cachedRaster.height, pt.imgY));
        state.rulers.push(state.pendingRuler);
        state.pendingRuler = null;
        renderViewport();
        return;
      }
      const x = Math.max(0, Math.min(cachedRaster.width, pt.imgX));
      const y = Math.max(0, Math.min(cachedRaster.height, pt.imgY));
      state.pendingRuler = {
        seriesUid: state.activeSeries.uid,
        plane: state.plane,
        slice: state.sliceIndex,
        x1: x,
        y1: y,
        x2: x,
        y2: y,
      };
      state.drag = { mode: 'length', startClientX: e.clientX, startClientY: e.clientY, pointerId: e.pointerId };
      renderViewport();
      return;
    }

    state.drag = {
      mode,
      startClientX: e.clientX,
      startClientY: e.clientY,
      startWC: state.windowCenter,
      startWW: state.windowWidth,
      startPanX: state.panX,
      startPanY: state.panY,
      startZoom: state.zoom,
      startSlice: state.sliceIndex,
      pointerId: e.pointerId,
    };
    if (mode === 'probe') updateHoverProbe(pt.imgX, pt.imgY, pt.inside);
  });

  canvas.addEventListener('pointermove', (e) => {
    const pt = canvasCoordsToImage(canvas, e.clientX, e.clientY);
    updateHoverProbe(pt.imgX, pt.imgY, pt.inside);

    if (state.pendingRuler && (!state.drag || state.drag.mode === 'length') && cachedRaster) {
      state.pendingRuler.x2 = Math.max(0, Math.min(cachedRaster.width, pt.imgX));
      state.pendingRuler.y2 = Math.max(0, Math.min(cachedRaster.height, pt.imgY));
      renderViewport();
      if (!state.drag) return;
    }

    if (!state.drag || !state.activeSeries) return;
    const dx = e.clientX - state.drag.startClientX;
    const dy = e.clientY - state.drag.startClientY;

    if (state.drag.mode === 'wl') {
      const span = Math.max(80, state.activeSeries.maxVal - state.activeSeries.minVal);
      const sensitivity = Math.max(0.5, span / 320);
      state.windowWidth = Math.max(1, state.drag.startWW + dx * sensitivity);
      state.windowCenter = state.drag.startWC - dy * sensitivity;
      state.lutDirty = true;
      renderViewport();
    } else if (state.drag.mode === 'pan') {
      state.panX = state.drag.startPanX + dx;
      state.panY = state.drag.startPanY + dy;
      renderViewport();
    } else if (state.drag.mode === 'zoom') {
      const factor = Math.exp(-dy * 0.008);
      state.zoom = Math.max(0.25, Math.min(14, state.drag.startZoom * factor));
      renderViewport();
    } else if (state.drag.mode === 'scroll') {
      const step = Math.round(dy / 10);
      setSliceIndex(state.drag.startSlice + step);
    }
  });

  const endDrag = (e) => {
    if (!state.drag) return;
    if (state.drag.mode === 'length' && state.pendingRuler) {
      const moved = Math.hypot(e.clientX - state.drag.startClientX, e.clientY - state.drag.startClientY);
      if (moved >= 4) {
        // Click-drag-release completed the measurement
        state.rulers.push(state.pendingRuler);
        state.pendingRuler = null;
        renderViewport();
      }
      // Otherwise (<4 px click), keep pendingRuler alive so second click completes it
    }
    state.drag = null;
  };
  canvas.addEventListener('pointerup', endDrag);
  canvas.addEventListener('pointercancel', endDrag);
  canvas.addEventListener('pointerleave', () => {
    if (!state.drag) updateHoverProbe(0, 0, false);
  });

  canvas.addEventListener('wheel', (e) => {
    e.preventDefault();
    if (!state.activeSeries) return;
    if (e.ctrlKey || e.metaKey) {
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      state.zoom = Math.max(0.25, Math.min(14, state.zoom * factor));
      renderViewport();
      return;
    }
    setSliceIndex(state.sliceIndex + (e.deltaY > 0 ? 1 : -1));
  }, { passive: false });

  // Drag-and-drop onto sandbox
  let dragDepth = 0;
  window.addEventListener('dragenter', (e) => {
    if ($('local-sandbox')?.hidden) return;
    e.preventDefault();
    dragDepth++;
    $('sb-drop-overlay').hidden = false;
  });
  window.addEventListener('dragover', (e) => {
    if ($('local-sandbox')?.hidden) return;
    e.preventDefault();
  });
  window.addEventListener('dragleave', () => {
    if ($('local-sandbox')?.hidden) return;
    if (--dragDepth <= 0) {
      dragDepth = 0;
      $('sb-drop-overlay').hidden = true;
    }
  });
  window.addEventListener('drop', async (e) => {
    if ($('local-sandbox')?.hidden) return;
    e.preventDefault();
    dragDepth = 0;
    $('sb-drop-overlay').hidden = true;
    const files = await collectDroppedFiles(e.dataTransfer);
    if (files.length) await ingestSandboxFiles(files, 'dropped items');
  });

  // Keyboard shortcuts when sandbox is active
  const keyToolMap = { w: 'wl', s: 'scroll', p: 'pan', z: 'zoom', l: 'length', b: 'probe' };
  window.addEventListener('keydown', (e) => {
    if ($('local-sandbox')?.hidden) return;
    if (e.target.closest('input, select, textarea') || e.metaKey || e.ctrlKey || e.altKey) return;
    const k = e.key.toLowerCase();
    if (keyToolMap[k]) {
      e.preventDefault();
      setTool(keyToolMap[k]);
    } else if (k === 'i') {
      e.preventDefault();
      $('sb-invert').click();
    } else if (k === 't') {
      e.preventDefault();
      $('sb-toggle-tags').click();
    } else if (e.key === 'Escape') {
      if (state.pendingRuler) {
        state.pendingRuler = null;
        renderViewport();
      } else {
        $('sb-reset').click();
      }
    } else if (e.key === ' ') {
      e.preventDefault();
      toggleSandboxCine();
    } else if (e.key === 'ArrowUp' || e.key === 'ArrowLeft') {
      e.preventDefault();
      setSliceIndex(state.sliceIndex - 1);
    } else if (e.key === 'ArrowDown' || e.key === 'ArrowRight') {
      e.preventDefault();
      setSliceIndex(state.sliceIndex + 1);
    } else if (e.key === 'PageUp') {
      e.preventDefault();
      setSliceIndex(state.sliceIndex - 5);
    } else if (e.key === 'PageDown') {
      e.preventDefault();
      setSliceIndex(state.sliceIndex + 5);
    }
  });

  new ResizeObserver(() => {
    if (!$('local-sandbox')?.hidden) renderViewport();
  }).observe($('sb-stage'));
}

// ---------- Public Entry Points ----------

export function initLocalSandbox({ onExit } = {}) {
  if (onExit) state.onExit = onExit;
  if (state.initialized) return;
  if (!$('local-sandbox')) return;
  state.initialized = true;
  wireSandboxEvents();
}

export async function openLocalSandbox() {
  const shell = $('local-sandbox');
  if (!shell) return;
  $('boot').hidden = true;
  $('auth').hidden = true;
  $('app').hidden = true;
  shell.hidden = false;

  if (!state.studies.length) {
    await loadBuiltInPhantom();
  } else {
    requestAnimationFrame(renderViewport);
  }
  $('sb-canvas')?.focus({ preventScroll: true });
}
