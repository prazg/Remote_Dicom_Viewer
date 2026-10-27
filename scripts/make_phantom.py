# Writes a synthetic, non-patient DICOM study for testing the viewer.
# Usage: python3 scripts/make_phantom.py <output-dir>
import sys, os, numpy as np
from pydicom.dataset import Dataset, FileMetaDataset
from pydicom.uid import ExplicitVRLittleEndian, generate_uid, CTImageStorage, MRImageStorage
out = sys.argv[1]; os.makedirs(out, exist_ok=True)
study = generate_uid(); FOR = generate_uid()
def write(path, arr, modality, series_uid, series_no, desc, inst, ipp, iop, spacing, thick, extra=None):
    meta = FileMetaDataset()
    meta.MediaStorageSOPClassUID = CTImageStorage if modality=='CT' else MRImageStorage
    meta.MediaStorageSOPInstanceUID = generate_uid()
    meta.TransferSyntaxUID = ExplicitVRLittleEndian
    ds = Dataset(); ds.file_meta = meta
    ds.SOPClassUID = meta.MediaStorageSOPClassUID; ds.SOPInstanceUID = meta.MediaStorageSOPInstanceUID
    ds.PatientName = 'PHANTOM^SYNTHETIC'; ds.PatientID = 'TEST0001'; ds.PatientBirthDate='19700101'
    ds.StudyInstanceUID = study; ds.StudyDate='20261026'; ds.StudyDescription='Synthetic head phantom'
    ds.SeriesInstanceUID = series_uid; ds.SeriesNumber = series_no; ds.SeriesDescription = desc
    ds.Modality = modality; ds.InstanceNumber = inst; ds.FrameOfReferenceUID = FOR
    ds.ImagePositionPatient = [f'{v:.3f}' for v in ipp]; ds.ImageOrientationPatient = iop
    ds.PixelSpacing = spacing; ds.SliceThickness = thick
    ds.Rows, ds.Columns = arr.shape; ds.SamplesPerPixel = 1; ds.PhotometricInterpretation = 'MONOCHROME2'
    ds.BitsAllocated = 16; ds.BitsStored = 16; ds.HighBit = 15; ds.PixelRepresentation = 1
    if modality == 'CT':
        ds.RescaleIntercept = -1024; ds.RescaleSlope = 1; ds.RescaleType='HU'
        ds.WindowCenter = 40; ds.WindowWidth = 80
    ds.PixelData = arr.astype(np.int16).tobytes()
    ds.save_as(path, enforce_file_format=True)

# CT phantom: 256x256x64, 0.9 x 0.9 x 2.5 mm
N, Z = 256, 64; sp = 0.9; dz = 2.5
y, x = np.mgrid[0:N, 0:N]; cx = cy = N/2
ct_uid = generate_uid()
for k in range(Z):
    zmm = (k - Z/2) * dz
    hu = np.full((N, N), -1000.0)
    a, b, c = 85, 105, 80  # semi-axes in mm (x,y,z)
    r = ((x-cx)*sp/a)**2 + ((y-cy)*sp/b)**2 + (zmm/c)**2
    hu[r < 1] = 1000                     # skull
    hu[r < 0.85] = 35                    # brain
    vent = (((x-cx)*sp/12)**2 + ((y-cy+8)*sp/30)**2 + (zmm/18)**2) < 1
    hu[vent & (r < 0.85)] = 5            # ventricles
    les = (((x-cx-35)*sp)**2 + ((y-cy-20)*sp)**2 + (zmm-10)**2) < 15**2
    hu[les] = 70                         # hyperdense lesion
    hu += np.random.default_rng(k).normal(0, 4, hu.shape)
    write(os.path.join(out, f'ct_{k:03d}.dcm'), hu + 1024, 'CT', ct_uid, 2, 'Axial head 2.5mm', k+1,
          [-cx*sp, -cy*sp, zmm], [1,0,0,0,1,0], [sp, sp], dz)

# MR localiser: 3 orthogonal images (stack only)
mr_uid = generate_uid()
img = (np.sin(x/9.0)*np.cos(y/11.0)*400 + 600)
orients = [([1,0,0,0,1,0],[-115,-115,0]), ([0,1,0,0,0,-1],[0,-115,115]), ([1,0,0,0,0,-1],[-115,0,115])]
for i,(iop,ipp) in enumerate(orients):
    write(os.path.join(out, f'mr_loc_{i}.dcm'), img, 'MR', mr_uid, 1, 'Localiser 3-plane', i+1, ipp, iop, [0.9,0.9], 5)
open(os.path.join(out, 'notes.txt'),'w').write('not dicom')
print('ok')
