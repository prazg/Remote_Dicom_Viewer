-- =============================================================================
-- Deployment automation
--   * Report-ready emails are queued straight from the database (pg_net), so no
--     dashboard webhook or shared secret is needed. The deploy workflow stores
--     the project's Functions URL in app_config.
--   * Admins can revoke access by setting a user's role to null.
-- =============================================================================

create extension if not exists pg_net;

-- Deployment settings. Readable only by the service role (deploy workflow, functions).
create table if not exists public.app_config (
  key   text primary key,
  value text not null
);
alter table public.app_config enable row level security;
revoke all on public.app_config from anon, authenticated;

-- Queue an email for each "report ready" notification. The request carries only
-- the notification id; the function looks everything else up itself and sends at
-- most one email per notification, so a forged call can't send anything new.
create or replace function public.queue_report_email()
returns trigger language plpgsql security definer
set search_path = ''
as $$
declare v_url text;
begin
  if new.kind <> 'report_ready' then return new; end if;
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
  -- Never let an email problem stop a report being signed.
  raise warning 'could not queue report email: %', sqlerrm;
  return new;
end $$;

revoke execute on function public.queue_report_email() from public, anon, authenticated;

drop trigger if exists notifications_queue_email on public.notifications;
create trigger notifications_queue_email
after insert on public.notifications
for each row execute function public.queue_report_email();

-- admin_set_role: a null role now revokes access (the user keeps their account
-- and audit history but can no longer read anything).
create or replace function public.admin_set_role(p_user uuid, p_role public.app_role)
returns void language plpgsql security definer
set search_path = ''
as $$
begin
  perform public.require_role(array['admin']::public.app_role[]);
  if p_user = auth.uid() then raise exception 'admins cannot change their own role' using errcode = '42501'; end if;
  update public.profiles set role = p_role where id = p_user;
  if not found then raise exception 'no such user' using errcode = '22023'; end if;
  perform public.write_audit(case when p_role is null then 'user.access_revoked' else 'user.role_set' end,
                             null, jsonb_build_object('user', p_user, 'role', p_role));
end $$;

-- Explicit privileges for the server-side functions (service role bypasses RLS).
grant select, insert, update on public.app_config, public.profiles, public.notifications to service_role;
grant select, insert on public.audit_log to service_role;
