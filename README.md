# DICOM Reporting

A secure web app for sending scans for remote reporting. An **uploader** signs in, selects a scan, and it is anonymised in their browser before upload. A **radiologist** signs in, views it in a full DICOM viewer, and writes and signs a report. The uploader is notified in the app and by email when the report is ready.

- Frontend: static site on GitHub Pages (Vite, Cornerstone3D viewer)
- Backend: Supabase (Postgres with row-level security, Auth with two-factor, private Storage, Edge Function)

**Deploying:** create a Supabase project, add three secrets to the GitHub repository, and run the workflow. It sets up the database, sign-in security, server functions and website, and invites you as the first admin. See **[SETUP.md](SETUP.md)**.

> Not a medical device. Read the governance note in SETUP.md before using real patient data.

## Workflow

| | Uploader | Radiologist | Admin |
|---|---|---|---|
| Upload a case | ✓ (own cases) | | |
| See a case | own cases | unclaimed cases and those they claimed | metadata only, **no images** |
| Download images | own cases | unclaimed and own claimed | ✗ |
| Report | | claim → draft (autosaved) → sign | |
| Add addendum to a signed report | | own signed reports | |
| Read report and addenda | once signed | own reports | ✗ |
| Notifications | report signed | | |
| Invite users, change roles, remove access, reset 2FA, audit log | | | ✓ |

Case status runs from *uploading* to *awaiting report*, then *being reported* (claimed by one radiologist), then *reported*. A radiologist can release a claimed case back to the worklist.

**Addenda.** A signed report is never edited. To correct or add to it, the radiologist who signed it writes an addendum, which is signed immediately. Addenda are numbered and shown in order below the unchanged original, in the app and in the text download. The uploader is notified in the app and by email, and the case is marked "+1 addendum" in their list.

## Security design

**Identity**
- Invitation only; public sign-up is disabled.
- Password (12+ characters, mixed case and digits) **plus a mandatory authenticator-app code** (TOTP). The database itself requires a two-factor session for every read and write, so a stolen password alone gives no access.
- A new account has no role, and so no access, until an admin assigns one. Users cannot change their own role.
- Sessions are held per browser tab (closing the tab signs out). The app signs out after 15 minutes of inactivity, and signing out reloads the page to clear images from memory.

**Data access, enforced in Postgres rather than the browser**
- Row-level security on every table, with a restrictive two-factor policy on top.
- No direct writes to cases or reports. Every change goes through a database function that re-checks the caller's role, ownership, case status and two-factor sign-in.
- Images sit in a private bucket and are only accepted under `<case-id>/<file>` while that case is still uploading, only as `application/dicom`, and with a 50 MB limit per file. They are only readable by the people above.
- Signed reports are locked by a trigger, which also blocks the database owner. Corrections are added as signed addenda, which are equally permanent: a trigger blocks any edit or deletion, even by the database owner. Only the signing radiologist can add one, through a function that checks their role, that they signed the report, and two-factor sign-in.
- An append-only audit log, protected by a trigger, records case creation, submission, every time a case's images are opened, claims, releases, signatures, addenda and role changes.

**Anonymisation before upload (in the browser)**
- Removes patient name and IDs (replaced with `ANON^<case ref>`), birth date, every date and time, institution, staff names, accession number, private tags, overlays, icon images and "original attributes" history, plus about 100 other identifying fields. UIDs are replaced with new ones.
- Keeps sex, age, size and weight, and study/series/protocol descriptions, so the scan stays reportable. Any kept text containing the patient's name or ID is dropped.
- Each rewritten file is re-parsed and scanned byte by byte, outside the pixel data, for the original identifiers. A file that fails is not uploaded and nothing is submitted.
- Blocks uploads that mix patients, and blocks case labels or clinical details containing the patient's name or ID, a 10-digit number (possible NHS number) or a date.
- **Limitation:** text burned into the pixels cannot be removed. Files flagged as containing burned-in text are excluded, and ultrasound, secondary-capture and similar images need the uploader to confirm they've checked them.
- It is based on a subset of the DICOM PS3.15 Basic Profile but is **not a certified de-identification**.

**Site**
- A Content-Security-Policy that only allows this site and your Supabase project; no third-party scripts or analytics.
- Database values are inserted as text, never as HTML.
- Notification emails contain no clinical or patient details. The database queues them itself and the email function sends each one at most once, so forged or replayed calls send nothing.
- User management runs in a server function that verifies the caller's session with the Auth server and requires an admin with two-factor sign-in. When email isn't configured, it returns a one-time, 24-hour sign-up link for the admin to send securely.

### What was tested

Tested against a local Supabase stack:
- **93 automated security checks** (`npm run test:security`). These include:
  - cross-user reads and downloads
  - role escalation
  - uploads to other cases or outside permitted paths
  - direct status changes
  - tampering with signed reports and the audit log
  - password-only (non-two-factor) sessions
  - anonymous access
  - forged or replayed email calls
  - the user-management function refusing non-admins, admins without two-factor, and tampered tokens
  - addenda: only the signing radiologist can add one, never before signing, never by direct insert; addenda can't be edited or deleted; the original report is unchanged; only the right people can read them; notifications and emails are sent
- **Deploy script** run against a schema-validating mock of the Supabase Management API, twice, to confirm it is safe to re-run. It has **not yet run against a real hosted project.**
- **Addendum in the browser**: the radiologist adds an addendum to a signed case; the uploader gets the notification and email, sees "+1 addendum" in their list, reads it below the original, and downloads both.
- **Upgrade path**: an existing deployment picks up the addendum migration on its next push.
- **First-day flow**: the admin accepts the emailed invitation and invites an uploader, both by email and by one-time link; the uploader signs up.
- **End-to-end browser runs** with real two-factor codes:
  - invitation → set up authenticator → choose password → no-role screen → role assigned → sign in
  - upload with all identifier guards → radiologist claims, drafts and signs → uploader sees the notification and report → email sent → admin audit log
- **Server-side inspection of all 68 uploaded files**: no original identifiers found.
- **Idle sign-out**, using a simulated clock.

All test data was synthetic.

### Known limits
- Free-text descriptions are kept, though scanned for the patient's own identifiers. A description naming someone else would not be caught.
- PET SUV calculation won't work after anonymisation (dates and times are removed).
- Only the radiologist who signed a report can add addenda. If they leave, an admin can't add one on their behalf.
- No second-reader workflow, no PDF report export (a text download is provided).
- Server-side session time-limits and leaked-password checks need a Supabase Pro plan.
- No DICOMweb/PACS connection. Uploads come from files on the uploader's computer.

## Viewer

Stack and MPR (axial, sagittal, coronal with crosshairs), window/level with CT presets, pan, zoom, cine, measurements (length, angle, ellipse and rectangle ROI with HU statistics, probe) and a DICOM tag viewer. It includes decoders for uncompressed, RLE, JPEG baseline/lossless, JPEG-LS, JPEG 2000, HTJ2K and JPEG XL; uncompressed, RLE and JPEG 2000 have been tested.

| Input | Action |
|---|---|
| Left drag | Active tool (W/L by default) |
| Middle / right drag | Pan / zoom |
| Wheel, ↑ ↓, PgUp PgDn | Scroll slices |
| W P Z S L A E R B C | Tools |
| I · Esc · Space · T | Invert · reset · cine · tags |

## Project layout

```
index.html                     Sign-in, app shell, viewer
src/app.js                     Sign-in, two-factor, password set-up, idle sign-out
src/pages.js                   Case list, worklist, admin, notifications, opening cases
src/upload.js                  Upload flow and identifier guards
src/anonymise.js               Browser anonymiser with post-write leak scan
src/casepanel.js               Case details and report editor
src/viewer-ui.js, viewer.js    DICOM viewer UI and Cornerstone3D setup
src/ingest.js, tags.js         DICOM parsing, series grouping, tag panel
supabase/migrations/           Schema, access rules, workflow functions, storage policies
supabase/functions/notify-email  Email on signed report (Resend), queued by the database
supabase/functions/admin-users   Invite users and reset two-factor (admins only)
scripts/deploy-backend.mjs     Backend set-up run by the GitHub workflow
supabase/tests/                Security test suite
supabase/config.toml           Local stack config (two-factor on, sign-up off, strong passwords)
scripts/make_phantom.py        Synthetic DICOM test data
```

## Versions

Cornerstone3D 5.13.2 · supabase-js 2.118.0 · Supabase CLI 2.122.0 · dcmjs 0.52.0 · Vite 8.3.5 · Node 20.19+ or 22.12+.

## Licence

MIT for this project's code. Dependencies carry their own licences.
