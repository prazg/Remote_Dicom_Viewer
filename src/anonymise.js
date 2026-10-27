// Browser-side DICOM anonymisation, applied to every file before upload.
//
// Based on a subset of the DICOM PS3.15 Basic Application Level Confidentiality
// Profile, with the "Retain Patient Characteristics" (sex, age, size, weight)
// and "Retain Description" (study/series/protocol descriptions) options so the
// images remain reportable. It is NOT a certified de-identification:
//   * text burned into the pixels is not removed (such files are flagged),
//   * free-text descriptions are kept, though they are scanned for identifiers.
// After rewriting, each file is re-parsed and scanned byte-for-byte (outside the
// pixel data) for the original patient name, IDs, accession number and birth
// date. A file that fails the scan is not uploaded.

import dcmjs from 'dcmjs';
import dicomParser from 'dicom-parser';

const { DicomMessage, DicomMetaDictionary } = dcmjs.data;

const tagOf = (keyword) => {
  const e = DicomMetaDictionary.nameMap[keyword];
  if (!e) throw new Error(`Unknown DICOM keyword ${keyword}`);
  return e.tag.replace(/[(),]/g, '').toUpperCase();
};

// Removed wherever they occur (including inside sequences).
const REMOVE = new Set([
  ...[
    'AccessionNumber', 'InstitutionName', 'InstitutionAddress', 'InstitutionalDepartmentName',
    'ReferringPhysicianName', 'ReferringPhysicianAddress', 'ReferringPhysicianTelephoneNumbers',
    'ReferringPhysicianIdentificationSequence', 'StationName', 'PhysiciansOfRecord',
    'PhysiciansOfRecordIdentificationSequence', 'PerformingPhysicianName',
    'PerformingPhysicianIdentificationSequence', 'NameOfPhysiciansReadingStudy',
    'PhysiciansReadingStudyIdentificationSequence', 'OperatorsName', 'OperatorIdentificationSequence',
    'AdmittingDiagnosesDescription', 'AdmittingDiagnosesCodeSequence', 'PatientBirthDate',
    'PatientBirthTime', 'OtherPatientIDs', 'OtherPatientNames', 'OtherPatientIDsSequence',
    'PatientBirthName', 'PatientAddress', 'PatientTelephoneNumbers', 'PatientMotherBirthName',
    'MedicalRecordLocator', 'EthnicGroup', 'Occupation', 'AdditionalPatientHistory', 'PatientComments',
    'IssuerOfPatientID', 'IssuerOfPatientIDQualifiersSequence', 'MilitaryRank', 'BranchOfService',
    'CountryOfResidence', 'RegionOfResidence', 'ResponsiblePerson', 'ResponsibleOrganization', 'StudyID',
    'RequestingPhysician', 'RequestingService', 'DeviceSerialNumber', 'PlateID', 'DetectorID', 'GantryID',
    'ImageComments', 'RequestAttributesSequence', 'PerformedProcedureStepID', 'ScheduledProcedureStepID',
    'AdmissionID', 'CurrentPatientLocation', 'PatientInstitutionResidence', 'ReferencedPatientSequence',
    'ReferencedStudySequence', 'ReferencedPatientAliasSequence', 'ContentCreatorName',
    'VerifyingObserverName', 'PersonName', 'DigitalSignaturesSequence', 'EncryptedAttributesSequence',
    'OriginalAttributesSequence', 'IconImageSequence', 'PatientInsurancePlanCodeSequence',
    'PatientPrimaryLanguageCodeSequence', 'PatientReligiousPreference', 'SmokingStatus', 'PregnancyStatus',
    'LastMenstrualDate', 'MedicalAlerts', 'Allergies', 'SpecialNeeds', 'PatientState', 'VisitComments',
    'ServiceEpisodeID', 'ServiceEpisodeDescription', 'OrderEnteredBy', 'OrderEntererLocation',
    'OrderCallbackPhoneNumber', 'ImagingServiceRequestComments', 'RequestedProcedureComments',
    'ReasonForTheRequestedProcedure', 'PlacerOrderNumberImagingServiceRequest',
    'FillerOrderNumberImagingServiceRequest', 'NamesOfIntendedRecipientsOfResults', 'PersonAddress',
    'PersonTelephoneNumbers',
  ].map(tagOf),
  // Retired identifiers not in the current keyword list.
  '00324000', // Study Comments
  '00380011', // Issuer of Admission ID
  '00321030', // Reason for Study
  '00101050', // Insurance Plan Identification
]);

const PATIENT_NAME = tagOf('PatientName');
const PATIENT_ID = tagOf('PatientID');
const IDENTITY_REMOVED = tagOf('PatientIdentityRemoved');
const DEID_METHOD = tagOf('DeidentificationMethod');
const MEDIA_SOP_INSTANCE = tagOf('MediaStorageSOPInstanceUID');
const DATE_VRS = new Set(['DA', 'DT', 'TM']);
const TEXT_VRS = new Set(['LO', 'SH', 'ST', 'LT', 'UT', 'UC', 'PN', 'CS', 'AE']);
const STANDARD_UID_ROOT = '1.2.840.10008.'; // SOP classes, transfer syntaxes: not identifying

/** New UID in the 2.25 (UUID-derived) arc. */
function newUid() {
  const hex = crypto.randomUUID().replace(/-/g, '');
  return `2.25.${BigInt(`0x${hex}`).toString(10)}`;
}

const isPrivate = (tag) => parseInt(tag.slice(0, 4), 16) % 2 === 1;
// Curve (50xx) and overlay (60xx) groups can carry annotations.
const isOverlayOrCurve = (tag) => /^(50|60)[0-9A-F]{2}/.test(tag) && parseInt(tag.slice(0, 4), 16) % 2 === 0;

function personNameText(v) {
  if (!v) return '';
  if (typeof v === 'string') return v;
  return [v.Alphabetic, v.Ideographic, v.Phonetic].filter(Boolean).join('=');
}

/**
 * Creates an anonymiser for one upload. UIDs are replaced consistently across
 * all files of the upload, so series and cross-references stay intact.
 */
export function createAnonymiser({ caseRef }) {
  const uidMap = new Map();
  const mapUid = (uid) => {
    if (!uid || uid.startsWith(STANDARD_UID_ROOT)) return uid;
    if (!uidMap.has(uid)) uidMap.set(uid, newUid());
    return uidMap.get(uid);
  };

  function scrub(dict) {
    for (const tag of Object.keys(dict)) {
      const el = dict[tag];
      if (isPrivate(tag) || REMOVE.has(tag) || isOverlayOrCurve(tag) || DATE_VRS.has(el.vr)) {
        delete dict[tag];
        continue;
      }
      if (el.vr === 'UI' && Array.isArray(el.Value)) {
        el.Value = el.Value.map(mapUid);
      } else if (el.vr === 'SQ' && Array.isArray(el.Value)) {
        el.Value.forEach((item) => item && scrub(item));
      }
    }
  }

  /**
   * @param {ArrayBuffer} buffer original Part 10 file
   * @returns {{ buffer: ArrayBuffer, identifiers: string[] }}
   */
  function anonymise(buffer) {
    const dicom = DicomMessage.readFile(buffer);
    const { dict, meta } = dicom;

    // Values to hunt for afterwards. Name parts match whole words only.
    const ids = [];
    const nameText = personNameText(dict[PATIENT_NAME]?.Value?.[0]);
    nameText.split(/[\^=\s]+/).filter((p) => p.length >= 3).forEach((p) => ids.push({ value: p, word: true }));
    for (const kw of ['PatientID', 'OtherPatientIDs', 'AccessionNumber', 'PatientBirthDate', 'MedicalRecordLocator']) {
      const v = dict[tagOf(kw)]?.Value;
      (v || []).forEach((x) => { if (typeof x === 'string' && x.trim().length >= 4) ids.push({ value: x.trim(), word: false }); });
    }
    const matcher = buildMatcher(ids);

    scrub(dict);
    // Kept free text (descriptions etc.) that mentions an identifier is dropped.
    if (matcher) dropTextContaining(dict, matcher);
    dict[PATIENT_NAME] = { vr: 'PN', Value: [{ Alphabetic: `ANON^${caseRef}` }] };
    dict[PATIENT_ID] = { vr: 'LO', Value: [`ANON-${caseRef}`] };
    dict[IDENTITY_REMOVED] = { vr: 'CS', Value: ['YES'] };
    dict[DEID_METHOD] = { vr: 'LO', Value: ['Browser anonymiser: subset of PS3.15 Basic Profile'] };
    if (meta[MEDIA_SOP_INSTANCE]?.Value) meta[MEDIA_SOP_INSTANCE].Value = meta[MEDIA_SOP_INSTANCE].Value.map(mapUid);

    const out = dicom.write();
    verify(out, matcher);
    return { buffer: out, identifierCount: ids.length };
  }

  return { anonymise };
}

function escapeRe(s) { return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/** One case-insensitive regex for all identifiers; name parts need word boundaries. */
function buildMatcher(ids) {
  if (!ids.length) return null;
  const parts = ids.map(({ value, word }) => (word ? `(?<![A-Z0-9])${escapeRe(value)}(?![A-Z0-9])` : escapeRe(value)));
  return new RegExp(parts.join('|'), 'i');
}

function elementText(el) {
  return (el.Value || []).map((v) => (typeof v === 'string' ? v : personNameText(v))).join(' ');
}

function dropTextContaining(dict, matcher) {
  for (const tag of Object.keys(dict)) {
    const el = dict[tag];
    if (TEXT_VRS.has(el.vr) && tag !== PATIENT_NAME && tag !== PATIENT_ID && matcher.test(elementText(el))) {
      delete dict[tag];
    } else if (el.vr === 'SQ' && Array.isArray(el.Value)) {
      el.Value.forEach((item) => item && dropTextContaining(item, matcher));
    }
  }
}

/** Re-parses the output and searches every byte outside the pixel data for original identifiers. */
function verify(buffer, matcher) {
  const bytes = new Uint8Array(buffer);
  const ds = dicomParser.parseDicom(bytes); // throws if the rewrite produced invalid DICOM
  const px = ds.elements.x7fe00010;
  if (!px) throw new Error('Pixel data missing after anonymisation');
  const pxStart = px.dataOffset;
  const pxEnd = px.length > 0 ? px.dataOffset + px.length : bytes.length;
  const decoder = new TextDecoder('latin1');
  const header = decoder.decode(bytes.subarray(0, pxStart)) + '\n' + decoder.decode(bytes.subarray(pxEnd));
  if (matcher && matcher.test(header)) {
    throw new Error('An original identifier is still present after anonymisation');
  }
}

/** Flags files whose pixels may contain burned-in text. */
export function burnedInRisk(dataSet) {
  const flag = (dataSet.string('x00280301') || '').trim().toUpperCase();
  if (flag === 'YES') return 'declared';
  const modality = (dataSet.string('x00080060') || '').trim().toUpperCase();
  const sopClass = (dataSet.string('x00080016') || '').trim();
  if (['US', 'SC', 'OT', 'XC', 'ES', 'DOC', 'SM'].includes(modality)) return 'modality';
  if (sopClass.startsWith('1.2.840.10008.5.1.4.1.1.7')) return 'modality'; // Secondary Capture family
  return null;
}
