-- =============================================================================
-- Report addenda
--
-- A signed report is never changed. Corrections and additions are appended as
-- addenda: each is written and signed in one step by the radiologist who signed
-- the report, numbered in order, and cannot be edited or deleted afterwards
-- (enforced by a trigger, which also binds the database owner). The uploader is
-- notified in the app and, when email is configured, by email.
-- =============================================================================

create table public.report_addenda (
  id              bigint generated always as identity primary key,
  study_id        uuid not null references public.reports (study_id),
  seq             integer not null check (seq >= 1),
  radiologist_id  uuid not null references public.profiles (id),
  body            text not null check (char_length(body) between 10 and 20000),
  signed_by_name  text not null,
  signed_at       timestamptz not null default now(),
  unique (study_id, seq)
);
create index report_addenda_study_idx on public.report_addenda (study_id, seq);

alter table public.studies
  add column addendum_count integer not null default 0 check (addendum_count >= 0),
  add column last_addendum_at timestamptz;

-- Addenda are permanent.
create or replace function public.protect_addendum()
returns trigger language plpgsql
set search_path = ''
as $$ begin raise exception 'addenda cannot be changed or deleted' using errcode = '42501'; end $$;

create trigger report_addenda_immutable
before update or delete on public.report_addenda
for each row execute function public.protect_addendum();

-- Read access: the reporting radiologist, and the uploader of the study.
revoke all on public.report_addenda from anon, authenticated;
grant select on public.report_addenda to authenticated;
grant select on public.report_addenda to service_role;
alter table public.report_addenda enable row level security;

create policy "aal2 required" on public.report_addenda as restrictive to authenticated
  using (public.is_aal2()) with check (public.is_aal2());
create policy "radiologist reads addenda of own reports" on public.report_addenda for select to authenticated
  using (public.my_role() = 'radiologist' and exists (
    select 1 from public.reports r where r.study_id = report_addenda.study_id and r.radiologist_id = (select auth.uid())));
create policy "uploader reads addenda of own studies" on public.report_addenda for select to authenticated
  using (public.my_role() = 'uploader' and exists (
    select 1 from public.studies s where s.id = report_addenda.study_id and s.uploader_id = (select auth.uid())));

-- Sign an addendum: the only way to create one.
create or replace function public.add_report_addendum(p_study uuid, p_body text)
returns timestamptz language plpgsql security definer
set search_path = ''
as $$
declare
  v_body text := trim(coalesce(p_body, ''));
  v_name text;
  v_seq integer;
  v_uploader uuid;
  v_at timestamptz := now();
begin
  perform public.require_role(array['radiologist']::public.app_role[]);
  if char_length(v_body) < 10 then raise exception 'addendum is too short to sign' using errcode = '22023'; end if;
  if char_length(v_body) > 20000 then raise exception 'addendum is too long' using errcode = '22023'; end if;

  -- Lock the signed report so concurrent addenda get distinct numbers.
  perform 1 from public.reports r
    join public.studies s on s.id = r.study_id
   where r.study_id = p_study and r.status = 'final' and r.radiologist_id = auth.uid() and s.status = 'reported'
   for update of r;
  if not found then
    raise exception 'only the radiologist who signed this report can add an addendum' using errcode = '42501';
  end if;

  select coalesce(max(seq), 0) + 1 into v_seq from public.report_addenda where study_id = p_study;
  select coalesce(nullif(full_name, ''), email) into v_name from public.profiles where id = auth.uid();

  insert into public.report_addenda (study_id, seq, radiologist_id, body, signed_by_name, signed_at)
  values (p_study, v_seq, auth.uid(), v_body, v_name, v_at);

  update public.studies set addendum_count = v_seq, last_addendum_at = v_at
   where id = p_study returning uploader_id into v_uploader;

  insert into public.notifications (user_id, study_id, kind, message)
  values (v_uploader, p_study, 'report_addended', 'An addendum has been added to a signed report.');

  perform public.write_audit('report.addendum_signed', p_study, jsonb_build_object('seq', v_seq, 'length', char_length(v_body)));
  return v_at;
end $$;

revoke execute on function public.add_report_addendum(uuid, text) from public, anon;
grant execute on function public.add_report_addendum(uuid, text) to authenticated;
revoke execute on function public.protect_addendum() from public, anon, authenticated;

-- Email for addenda as well as new reports.
create or replace function public.queue_report_email()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_url text;
begin
  if new.kind not in ('report_ready', 'report_addended') then return new; end if;
  select value into v_url from public.app_config where key = 'functions_url';
  if v_url is null then return new; end if;  -- email not configured: in-app notification only
  perform net.http_post(
    url := v_url || '/notify-email',
    body := jsonb_build_object('notification_id', new.id),
    params := '{}'::jsonb,
    headers := '{"Content-Type": "application/json"}'::jsonb,
    timeout_milliseconds := 10000
  );
  return new;
exception when others then
  raise warning 'could not queue report email: %', sqlerrm;
  return new;
end $$;
