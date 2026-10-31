-- =============================================================================
-- Optional anonymisation
--
-- Anonymisation stays the default. An uploader may instead send identifiable
-- images, but only after confirming the images are being shared within their
-- own organisation. The database refuses an identifiable case without that
-- confirmation, records both flags on the case (they cannot be changed
-- afterwards: clients have no UPDATE rights on studies), and writes them to the
-- audit log. Existing cases were all anonymised, so they default to true.
-- =============================================================================

alter table public.studies
  add column anonymised boolean not null default true,
  add column internal_share_confirmed boolean not null default false,
  add constraint studies_identifiable_needs_confirmation check (anonymised or internal_share_confirmed);

drop function if exists public.create_study(text, text, text, text);

create function public.create_study(
  p_case_label text,
  p_clinical_details text,
  p_modality text,
  p_summary text,
  p_anonymised boolean default true,
  p_internal_share_confirmed boolean default false
)
returns uuid language plpgsql security definer
set search_path = ''
as $$
declare
  v_id uuid;
  v_anon boolean := coalesce(p_anonymised, true);
  v_confirmed boolean := coalesce(p_internal_share_confirmed, false);
begin
  perform public.require_role(array['uploader']::public.app_role[]);
  if not v_anon and not v_confirmed then
    raise exception 'identifiable images can only be uploaded after confirming they are shared within your organisation'
      using errcode = '22023';
  end if;
  insert into public.studies (case_label, clinical_details, modality, summary, uploader_id, anonymised, internal_share_confirmed)
  values (trim(p_case_label), coalesce(p_clinical_details, ''), coalesce(p_modality, ''), coalesce(p_summary, ''),
          auth.uid(), v_anon, (not v_anon) and v_confirmed)
  returning id into v_id;
  perform public.write_audit('study.created', v_id,
    jsonb_build_object('anonymised', v_anon, 'internal_share_confirmed', (not v_anon) and v_confirmed));
  return v_id;
end $$;

revoke execute on function public.create_study(text, text, text, text, boolean, boolean) from public, anon;
grant execute on function public.create_study(text, text, text, text, boolean, boolean) to authenticated;
