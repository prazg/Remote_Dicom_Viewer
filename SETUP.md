# Deployment guide

You do about 15 minutes of set-up once. After that, every push to `main` updates everything automatically: database, sign-in security settings, server functions and the website.

## Before you start: governance

The app anonymises scans in the browser before upload (see README). If you intend to use it with NHS patient data, even anonymised, check with your Trust's information governance team first. You will likely need a DPIA and data-processing agreements with Supabase (and Resend, if you use email). Using it for clinical reporting may also bring it under medical-device regulation. This guide covers the technical set-up only.

## One-time set-up

### 1. Supabase project
1. Sign in at supabase.com and create a **new project**:
   - **Region: London (eu-west-2)**, so data stays in the UK. The workflow warns if it's anywhere else.
   - Database password: generate a strong one and store it in your password manager. The deployment doesn't need it.
2. Copy the **project reference**: the 20 letters in the dashboard URL (`supabase.com/dashboard/project/<ref>`), also shown under Project Settings → General.

### 2. Supabase access token
Account (avatar) → **Access Tokens** (supabase.com/dashboard/account/tokens) → *Generate new token*, named e.g. `github-deploy`. Copy it once; you'll paste it into GitHub next.

Keep this token only in GitHub's encrypted secrets. Revoke any token that has ever been pasted anywhere else.

### 3. GitHub repository
1. Create a repository and push this folder to its `main` branch.
   - On free GitHub plans, GitHub Pages needs a **public** repository. That is fine: the code contains no secrets.
   - In a public repository, workflow logs are also public. The workflow masks every secret and the admin email in its logs.
2. **Settings → Pages → Build and deployment → Source: GitHub Actions.**
3. **Settings → Secrets and variables → Actions → New repository secret**, add:

| Secret | Value |
|---|---|
| `SUPABASE_ACCESS_TOKEN` | the token from step 2 |
| `SUPABASE_PROJECT_REF` | the 20-letter reference from step 1 |
| `ADMIN_EMAIL` | your email. **Without email set up (below), use the address of your Supabase account**, because Supabase's built-in mailer only sends to members of your Supabase organisation. |

### 4. Deploy
**Actions → Deploy → Run workflow** (or push any commit). It takes about 3–5 minutes. The workflow:
1. applies the database schema and access rules (`supabase/migrations/`)
2. sets sign-in security:
   - invitation only
   - two-factor enabled
   - 12+ character passwords with mixed case and digits
   - re-authentication to change password
   - 24-hour invitation links
   - the site address for links
3. on Supabase Pro, adds a 12-hour session limit, a 30-minute server-side inactivity timeout and a leaked-password check. On the free plan it logs a warning and continues; the app's own 15-minute idle sign-out still applies.
4. deploys the two server functions (report email and user management)
5. invites `ADMIN_EMAIL` as the first administrator, only if there is no admin yet
6. builds the website with your project's public address and key, and publishes it to GitHub Pages.

### 5. First sign-in
Open the invitation email: set up your authenticator app (Microsoft or Google Authenticator), then choose a password. You land on **Users & audit** as the administrator.

From there, invite colleagues as **uploader** or **radiologist**.

## Email (optional, recommended)

Without email:
- New users get a **one-time sign-up link** in the app, which you send them yourself by secure email (e.g. NHSmail). It works once and expires after 24 hours.
- Report-ready notifications appear in the app only.

To email invitations, password resets and report-ready notifications automatically:
1. Create a [Resend](https://resend.com) account and **verify a sending domain** you control.
2. Create an API key.
3. Add two more repository secrets:
   - `RESEND_API_KEY`
   - `EMAIL_FROM`, e.g. `DICOM Reporting <reports@your-domain.org>` (the address must be on the verified domain)
4. Re-run the workflow. It sets Resend as Supabase's mail server and turns on report emails.

Emails never contain patient or clinical details: just a short case reference and a link.

## Day-to-day administration (in the app, **Users & audit**)

- **Invite** someone and choose their role.
- **Change role** or choose **No access**, which locks them out immediately. Their history stays in the audit log.
- **Reset 2FA** when someone loses their phone. They set up the authenticator again at next sign-in.
- **Audit log** shows every case created, submitted, opened, claimed, released and signed, every addendum, and every role change, invitation and 2FA reset.

You can also manage users in the Supabase dashboard (Authentication → Users), e.g. to delete an account.

## Updating

Push to `main`. New files in `supabase/migrations/` are applied automatically; applied ones are skipped.

## Troubleshooting

| Symptom | Fix |
|---|---|
| Site says "Not configured" | `SUPABASE_ACCESS_TOKEN` or `SUPABASE_PROJECT_REF` is missing; add it and re-run |
| Workflow warning "Could not email the admin invitation" | Set up email (above), or invite yourself in the Supabase dashboard (Authentication → Users → Invite user) and re-run the workflow, which then gives that account the admin role |
| Workflow fails at "Set up Supabase backend" with 401/403 | The access token is wrong, revoked or expired |
| Invitation or reset link says "expired" | Links last 24 hours; send a new invitation |
| Workflow warning about region | The project isn't in London; create a new project in eu-west-2 if UK residency matters |

## What has and hasn't been tested

- Everything was tested against a local Supabase stack (same database, auth, storage and functions software):
  - security suite
  - browser flows
  - both invitation modes
  - report email
- The deploy script ran against a mock of the Management API that checks every request against Supabase's published API schema, while doing the real database work locally. It ran twice to confirm re-runs are safe.
- **Not tested against a real hosted Supabase project or a real GitHub Actions run.** If the first run fails, the workflow log names the failing step. Send me the message (with secrets removed) and I'll fix it.

## Local development

Requires Docker.

```bash
npm ci
npx supabase@2.122.0 start            # local database, auth, storage, functions, test mailbox
npx supabase@2.122.0 db reset         # applies the migrations
cp .env.example .env.local            # fill in the publishable key printed by `start`
cp supabase/functions/.env.example supabase/functions/.env
npm run dev
```

Invitation emails appear in the local mailbox at http://127.0.0.1:54324. For local report emails, insert the functions URL the database should call: `insert into public.app_config values ('functions_url', 'http://host.docker.internal:54321/functions/v1');`

### Security tests

```bash
SUPABASE_URL=http://127.0.0.1:54321 \
SUPABASE_PUBLISHABLE_KEY=<publishable> SUPABASE_SECRET_KEY=<secret> \
DB_URL=postgresql://postgres:postgres@127.0.0.1:54322/postgres \
npm run test:security
```

The suite runs 93 checks against a running stack, covering:
- cross-user access and role escalation
- uploads outside permitted paths
- tampering with signed reports and the audit log
- password-only sessions and anonymous access
- forged email calls
- the user-management function (non-admins, admins without 2FA, tampered tokens)
- report addenda (who can add and read them, immutability, notifications)

Run it only locally; it creates users.
