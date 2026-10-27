-- =============================================================================
-- Secure DICOM upload and reporting workflow
--
-- Security model
--   * No self sign-up. Accounts are invited by an administrator, and an account
--     has no access at all until an admin assigns a role.
--   * Every table requires a two-factor (aal2) session, enforced in the
--     database with RESTRICTIVE policies, not just in the browser.
--   * Clients cannot UPDATE or DELETE workflow tables directly. Every state change
--     goes through a SECURITY DEFINER function that re-checks role, ownership,
--     status and aal2, and writes an audit entry.
--   * Signed reports cannot be changed or deleted, even by the service role (trigger).
--   * The audit log is append-only and readable by admins only.
--   * Images live in a private storage bucket; access is checked per study.
-- =============================================================================

create extension if not exists pgcrypto with schema extensions;

-- ---------------------------------------------------------------------------
-- Types and tables
-- ---------------------------------------------------------------------------

create type public.app_role as enum ('uploader', 'radiologist', 'admin');
create type public.study_status as enum ('uploading', 'awaiting_report', 'in_review', 'reported');
create type public.report_status as enum ('draft', 'final');

create table public.profiles (
  id          uuid primary key references auth.users (id) on delete cascade,
  email       text not null,
  full_name   text not null default '' check (char_length(full_name) <= 120),
  role        public.app_role,                    -- null = no access yet
  created_at  timestamptz not null default now()
);

create table public.studies (
  id                uuid primary key default gen_random_uuid(),
  case_label        text not null check (char_length(case_label) between 1 and 60),
  clinical_details  text not null default '' check (char_length(clinical_details) <= 2000),
  modality          text not null default '' check (char_length(modality) <= 40),
  summary           text not null default '' check (char_length(summary) <= 500),
  file_count        integer not null default 0 check (file_count >= 0),
  total_bytes       bigint not null default 0 check (total_bytes >= 0),
  status            public.study_status not null default 'uploading',
  uploader_id       uuid not null references public.profiles (id),
  radiologist_id    uuid references public.profiles (id),
  created_at        timestamptz not null default now(),
  submitted_at      timestamptz,
  claimed_at        timestamptz,
  reported_at       timestamptz
);
create index studies_uploader_idx on public.studies (uploader_id, created_at desc);
create index studies_status_idx on public.studies (status, submitted_at);
create index studies_radiologist_idx on public.studies (radiologist_id);

create table public.study_files (
  id          bigint generated always as identity primary key,
  study_id    uuid not null references public.studies (id) on delete cascade,
  path        text not null unique,
  size_bytes  bigint not null check (size_bytes > 0),
  created_at  timestamptz not null default now(),
  constraint study_files_path_in_study check (path like study_id::text || '/%')
);
create index study_files_study_idx on public.study_files (study_id);

create table public.reports (
  study_id        uuid primary key references public.studies (id) on delete cascade,
  radiologist_id  uuid not null references public.profiles (id),
  body            text not null default '' check (char_length(body) <= 20000),
  status          public.report_status not null default 'draft',
  signed_by_name  text,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  signed_at       timestamptz
);

create table public.notifications (
  id          bigint generated always as identity primary key,
  user_id     uuid not null references public.profiles (id) on delete cascade,
  study_id    uuid references public.studies (id) on delete cascade,
  kind        text not null,
  message     text not null,
  created_at  timestamptz not null default now(),
  read_at     timestamptz,
  emailed_at  timestamptz                         -- set by the notify-email function
);
create index notifications_user_idx on public.notifications (user_id, created_at desc);

create table public.audit_log (
  id          bigint generated always as identity primary key,
  at          timestamptz not null default now(),
  actor_id    uuid,
  actor_email text,
  action      text not null,
  study_id    uuid,
  detail      jsonb not null default '{}'::jsonb
);
create index audit_log_study_idx on public.audit_log (study_id, at);

-- ---------------------------------------------------------------------------
-- Helpers (SECURITY DEFINER so they can read profiles without RLS recursion)
-- ---------------------------------------------------------------------------

create or replace function public.is_aal2()
returns boolean language sql stable
set search_path = ''
as $$ select coalesce((select auth.jwt() ->> 'aal') = 'aal2', false) $$;

create or replace function public.my_role()
returns public.app_role language sql stable security definer
set search_path = ''
as $$ select role from public.profiles where id = (select auth.uid()) $$;

create or replace function public.write_audit(p_action text, p_study uuid, p_detail jsonb default '{}'::jsonb)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.audit_log (actor_id, actor_email, action, study_id, detail)
  values (auth.uid(), (select email from public.profiles where id = auth.uid()), p_action, p_study, coalesce(p_detail, '{}'::jsonb));
end $$;

-- Raises unless the caller is signed in with two factors and holds one of the roles.
create or replace function public.require_role(p_roles public.app_role[])
returns public.app_role language plpgsql stable security definer
set search_path = ''
as $$
declare r public.app_role;
begin
  if auth.uid() is null then raise exception 'not signed in' using errcode = '42501'; end if;
  if not public.is_aal2() then raise exception 'two-factor sign-in required' using errcode = '42501'; end if;
  select role into r from public.profiles where id = auth.uid();
  if r is null or not (r = any (p_roles)) then raise exception 'not permitted' using errcode = '42501'; end if;
  return r;
end $$;

-- Who may read a study's images and metadata.
create or replace function public.can_read_study(p_study uuid)
returns boolean language sql stable security definer
set search_path = ''
as $$
  select public.is_aal2() and exists (
    select 1
    from public.studies s
    join public.profiles p on p.id = (select auth.uid())
    where s.id = p_study
      and (
        (p.role = 'uploader' and s.uploader_id = p.id)
        or (p.role = 'radiologist' and (s.status = 'awaiting_report' or s.radiologist_id = p.id))
      )
  )
$$;

-- Safe text -> uuid (storage object names are user-supplied).
create or replace function public.try_uuid(p text)
returns uuid language sql immutable
set search_path = ''
as $$
  select case when p ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then p::uuid end
$$;

-- ---------------------------------------------------------------------------
-- New auth users get a profile with no role
-- ---------------------------------------------------------------------------

create or replace function public.handle_new_user()
returns trigger language plpgsql security definer
set search_path = ''
as $$
begin
  insert into public.profiles (id, email, full_name)
  values (new.id, new.email, coalesce(new.raw_user_meta_data ->> 'full_name', ''));
  return new;
end $$;

create trigger on_auth_user_created
after insert on auth.users
for each row execute function public.handle_new_user();

-- ---------------------------------------------------------------------------
-- Integrity triggers
-- ---------------------------------------------------------------------------

create or replace function public.protect_final_report()
returns trigger language plpgsql
set search_path = ''
as $$
begin
  if old.status = 'final' then
    raise exception 'signed reports cannot be changed or deleted' using errcode = '42501';
  end if;
  if tg_op = 'UPDATE' then new.updated_at := now(); return new; end if;
  return old;
end $$;

create trigger reports_protect_final
before update or delete on public.reports
for each row execute function public.protect_final_report();

create or replace function public.audit_log_append_only()
returns trigger language plpgsql
set search_path = ''
as $$ begin raise exception 'audit log is append-only' using errcode = '42501'; end $$;

create trigger audit_log_no_update
before update or delete on public.audit_log
for each row execute function public.audit_log_append_only();

-- ---------------------------------------------------------------------------
-- Privileges: nothing for anon; read-only table access for signed-in users
-- (row filtering below); all writes go through functions.
-- ---------------------------------------------------------------------------

revoke all on public.profiles, public.studies, public.study_files, public.reports,
              public.notifications, public.audit_log from anon, authenticated;
grant select on public.profiles, public.studies, public.study_files, public.reports,
                public.notifications, public.audit_log to authenticated;
grant insert (study_id, path, size_bytes) on public.study_files to authenticated;

alter table public.profiles      enable row level security;
alter table public.studies       enable row level security;
alter table public.study_files   enable row level security;
alter table public.reports       enable row level security;
alter table public.notifications enable row level security;
alter table public.audit_log     enable row level security;

-- Two-factor gate on every table (RESTRICTIVE: combined with AND).
create policy "aal2 required" on public.profiles      as restrictive to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy "aal2 required" on public.studies       as restrictive to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy "aal2 required" on public.study_files   as restrictive to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy "aal2 required" on public.reports       as restrictive to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy "aal2 required" on public.notifications as restrictive to authenticated using (public.is_aal2()) with check (public.is_aal2());
create policy "aal2 required" on public.audit_log     as restrictive to authenticated using (public.is_aal2()) with check (public.is_aal2());

-- Profiles: yourself; admins see everyone. (Role changes only via admin_set_role.)
-- Exception: a signed-in user may read their own profile before two-factor
-- set-up, so the app can show their name. It exposes nothing else.
create policy "own profile" on public.profiles for select to authenticated
  using (id = (select auth.uid()));
create policy "admin reads profiles" on public.profiles for select to authenticated
  using (public.my_role() = 'admin');
drop policy "aal2 required" on public.profiles;
create policy "aal2 required except own row" on public.profiles as restrictive to authenticated
  using (public.is_aal2() or id = (select auth.uid()));

-- Studies
create policy "uploader reads own studies" on public.studies for select to authenticated
  using (uploader_id = (select auth.uid()) and public.my_role() = 'uploader');
create policy "radiologist reads worklist" on public.studies for select to authenticated
  using (public.my_role() = 'radiologist' and (status = 'awaiting_report' or radiologist_id = (select auth.uid())));
create policy "admin reads studies" on public.studies for select to authenticated
  using (public.my_role() = 'admin');

-- Study files: readable with the study; the uploader may register files while uploading.
create policy "read files of readable study" on public.study_files for select to authenticated
  using (public.can_read_study(study_id));
create policy "uploader registers files" on public.study_files for insert to authenticated
  with check (
    public.my_role() = 'uploader'
    and exists (select 1 from public.studies s
                where s.id = study_id and s.uploader_id = (select auth.uid()) and s.status = 'uploading')
  );

-- Reports: the reporting radiologist (draft and final); the uploader only once signed.
create policy "radiologist reads own reports" on public.reports for select to authenticated
  using (radiologist_id = (select auth.uid()) and public.my_role() = 'radiologist');
create policy "uploader reads final report" on public.reports for select to authenticated
  using (status = 'final' and exists (
    select 1 from public.studies s where s.id = study_id and s.uploader_id = (select auth.uid())));

-- Notifications: your own only.
create policy "own notifications" on public.notifications for select to authenticated
  using (user_id = (select auth.uid()));

-- Audit log: admins only.
create policy "admin reads audit" on public.audit_log for select to authenticated
  using (public.my_role() = 'admin');

-- ---------------------------------------------------------------------------
-- Workflow functions (the only way to change state)
-- ---------------------------------------------------------------------------

create or replace function public.create_study(p_case_label text, p_clinical_details text, p_modality text, p_summary text)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  perform public.require_role(array['uploader']::public.app_role[]);
  insert into public.studies (case_label, clinical_details, modality, summary, uploader_id)
  values (trim(p_case_label), coalesce(p_clinical_details, ''), coalesce(p_modality, ''), coalesce(p_summary, ''), auth.uid())
  returning id into v_id;
  perform public.write_audit('study.created', v_id);
  return v_id;
end $$;

create or replace function public.submit_study(p_study uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
declare v_count int; v_bytes bigint;
begin
  perform public.require_role(array['uploader']::public.app_role[]);
  select count(*), coalesce(sum(size_bytes), 0) into v_count, v_bytes from public.study_files where study_id = p_study;
  update public.studies
     set status = 'awaiting_report', submitted_at = now(), file_count = v_count, total_bytes = v_bytes
   where id = p_study and uploader_id = auth.uid() and status = 'uploading' and v_count > 0;
  if not found then raise exception 'study cannot be submitted' using errcode = '42501'; end if;
  perform public.write_audit('study.submitted', p_study, jsonb_build_object('files', v_count, 'bytes', v_bytes));
end $$;

-- Abandon an upload that has not been submitted. The client deletes the stored objects first.
create or replace function public.discard_study(p_study uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['uploader']::public.app_role[]);
  delete from public.studies where id = p_study and uploader_id = auth.uid() and status = 'uploading';
  if not found then raise exception 'study cannot be discarded' using errcode = '42501'; end if;
  perform public.write_audit('study.discarded', p_study);
end $$;

create or replace function public.claim_study(p_study uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['radiologist']::public.app_role[]);
  update public.studies
     set status = 'in_review', radiologist_id = auth.uid(), claimed_at = now()
   where id = p_study and status = 'awaiting_report';
  if not found then raise exception 'study is not available to claim' using errcode = '42501'; end if;
  insert into public.reports (study_id, radiologist_id) values (p_study, auth.uid())
  on conflict (study_id) do update set radiologist_id = excluded.radiologist_id, body = '';
  perform public.write_audit('study.claimed', p_study);
end $$;

create or replace function public.release_study(p_study uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['radiologist']::public.app_role[]);
  delete from public.reports where study_id = p_study and radiologist_id = auth.uid() and status = 'draft';
  update public.studies
     set status = 'awaiting_report', radiologist_id = null, claimed_at = null
   where id = p_study and radiologist_id = auth.uid() and status = 'in_review';
  if not found then raise exception 'study cannot be released' using errcode = '42501'; end if;
  perform public.write_audit('study.released', p_study);
end $$;

create or replace function public.save_report_draft(p_study uuid, p_body text)
returns timestamptz language plpgsql security definer
set search_path = ''
as $$
declare v_at timestamptz;
begin
  perform public.require_role(array['radiologist']::public.app_role[]);
  update public.reports r
     set body = coalesce(p_body, '')
    from public.studies s
   where r.study_id = p_study and s.id = p_study
     and r.radiologist_id = auth.uid() and r.status = 'draft'
     and s.radiologist_id = auth.uid() and s.status = 'in_review'
  returning r.updated_at into v_at;
  if v_at is null then raise exception 'draft cannot be saved' using errcode = '42501'; end if;
  return v_at;
end $$;

create or replace function public.sign_report(p_study uuid, p_body text)
returns timestamptz language plpgsql security definer
set search_path = ''
as $$
declare v_uploader uuid; v_name text; v_at timestamptz := now();
begin
  perform public.require_role(array['radiologist']::public.app_role[]);
  if char_length(trim(coalesce(p_body, ''))) < 10 then
    raise exception 'report is too short to sign' using errcode = '22023';
  end if;
  select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = auth.uid();

  update public.reports r
     set body = p_body, status = 'final', signed_at = v_at, signed_by_name = v_name
    from public.studies s
   where r.study_id = p_study and s.id = p_study
     and r.radiologist_id = auth.uid() and r.status = 'draft'
     and s.radiologist_id = auth.uid() and s.status = 'in_review';
  if not found then raise exception 'report cannot be signed' using errcode = '42501'; end if;

  update public.studies set status = 'reported', reported_at = v_at
   where id = p_study returning uploader_id into v_uploader;

  -- In-app notification. A database webhook on this table sends the email.
  insert into public.notifications (user_id, study_id, kind, message)
  values (v_uploader, p_study, 'report_ready', 'A report has been signed and is ready to view.');

  perform public.write_audit('report.signed', p_study, jsonb_build_object('length', char_length(p_body)));
  return v_at;
end $$;

create or replace function public.mark_notifications_read(p_ids bigint[] default null)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if auth.uid() is null or not public.is_aal2() then raise exception 'two-factor sign-in required' using errcode = '42501'; end if;
  update public.notifications set read_at = now()
   where user_id = auth.uid() and read_at is null and (p_ids is null or id = any (p_ids));
end $$;

-- Records that a user opened a study's images (for the audit trail).
create or replace function public.log_study_opened(p_study uuid)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  if not public.can_read_study(p_study) then raise exception 'not permitted' using errcode = '42501'; end if;
  perform public.write_audit('study.opened', p_study);
end $$;

create or replace function public.admin_set_role(p_user uuid, p_role public.app_role)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['admin']::public.app_role[]);
  if p_user = auth.uid() then raise exception 'admins cannot change their own role' using errcode = '42501'; end if;
  update public.profiles set role = p_role where id = p_user;
  if not found then raise exception 'no such user' using errcode = '22023'; end if;
  perform public.write_audit('user.role_set', null, jsonb_build_object('user', p_user, 'role', p_role));
end $$;

-- Function privileges: signed-in users only; helpers are internal.
revoke execute on all functions in schema public from public, anon;
grant execute on function
  public.create_study(text, text, text, text),
  public.submit_study(uuid),
  public.discard_study(uuid),
  public.claim_study(uuid),
  public.release_study(uuid),
  public.save_report_draft(uuid, text),
  public.sign_report(uuid, text),
  public.mark_notifications_read(bigint[]),
  public.log_study_opened(uuid),
  public.admin_set_role(uuid, public.app_role),
  public.is_aal2(), public.my_role(), public.can_read_study(uuid), public.try_uuid(text)
to authenticated;
revoke execute on function public.write_audit(text, uuid, jsonb), public.require_role(public.app_role[]),
  public.handle_new_user(), public.protect_final_report(), public.audit_log_append_only()
from authenticated;

-- ---------------------------------------------------------------------------
-- Private storage bucket for anonymised DICOM files: <study_id>/<file>.dcm
-- ---------------------------------------------------------------------------

insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('dicom', 'dicom', false, 52428800, array['application/dicom'])
on conflict (id) do nothing;

create policy "dicom: uploader adds files while uploading" on storage.objects
for insert to authenticated
with check (
  bucket_id = 'dicom'
  and public.is_aal2()
  and public.my_role() = 'uploader'
  and array_length(storage.foldername(name), 1) = 1
  and exists (
    select 1 from public.studies s
    where s.id = public.try_uuid((storage.foldername(name))[1])
      and s.uploader_id = (select auth.uid())
      and s.status = 'uploading'
  )
);

create policy "dicom: read files of readable study" on storage.objects
for select to authenticated
using (
  bucket_id = 'dicom'
  and public.can_read_study(public.try_uuid((storage.foldername(name))[1]))
);

create policy "dicom: uploader removes files of unsubmitted study" on storage.objects
for delete to authenticated
using (
  bucket_id = 'dicom'
  and public.is_aal2()
  and exists (
    select 1 from public.studies s
    where s.id = public.try_uuid((storage.foldername(name))[1])
      and s.uploader_id = (select auth.uid())
      and s.status = 'uploading'
  )
);
