-- Creativa CRM — "are you human" check (Cloudflare Turnstile) for website form intake.
-- Run once in the Supabase SQL editor, after 001–003. Safe to run again.
--
-- How it works: the website puts a Turnstile token in each submission (cf-turnstile-response).
-- submit_inquiry() asks Cloudflare whether the token is genuine before saving anything, so
-- bots are refused whether they use the website's forms or call the CRM directly.
--
-- The secret key lives in Supabase Vault, never in code. Until it is stored, nothing is
-- checked and forms behave exactly as before. To turn checking on, run (with your key):
--   select vault.create_secret('YOUR-TURNSTILE-SECRET-KEY', 'turnstile_secret_key');
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create extension if not exists http with schema extensions;

-- What was refused, without any of the submitted personal data.
create table if not exists public.intake_blocked (
  id          bigint generated always as identity primary key,
  created_at  timestamptz not null default now(),
  form        text not null,
  reason      text not null
);
alter table public.intake_blocked enable row level security;
revoke all on public.intake_blocked from anon, authenticated;
grant select on public.intake_blocked to authenticated;
drop policy if exists intake_blocked_staff_select on public.intake_blocked;
create policy intake_blocked_staff_select on public.intake_blocked for select to authenticated
  using (public.is_staff());

-- Ask Cloudflare whether a token is genuine.
--   not configured (no secret in Vault) -> allowed, so turning this on is a separate step
--   Cloudflare unreachable              -> allowed: an outage must never lose a real family
create or replace function public._turnstile_check(p_token text, out ok boolean, out reason text)
language plpgsql security definer set search_path = public as '
declare
  v_secret text;
  v_resp   extensions.http_response;
  v_body   jsonb;
begin
  select s.decrypted_secret into v_secret
    from vault.decrypted_secrets s where s.name = ''turnstile_secret_key'' limit 1;
  if v_secret is null or v_secret = '''' then
    ok := true; reason := ''not configured''; return;
  end if;
  if coalesce(p_token, '''') = '''' then
    ok := false; reason := ''missing-input-response''; return;
  end if;
  begin
    perform set_config(''http.timeout_msec'', ''5000'', true);
    v_resp := extensions.http_post(
      ''https://challenges.cloudflare.com/turnstile/v0/siteverify'',
      jsonb_build_object(''secret'', v_secret, ''response'', left(p_token, 2048))::text,
      ''application/json'');
    v_body := v_resp.content::jsonb;
  exception when others then
    ok := true; reason := ''verify unavailable''; return;
  end;
  ok := coalesce((v_body ->> ''success'')::boolean, false);
  reason := case when ok then ''ok'' else coalesce(v_body -> ''error-codes'' ->> 0, ''failed'') end;
end';

-- Keep the existing intake logic as-is under a new name, and put the check in front of it.
do '
begin
  if not exists (select 1 from pg_proc
                  where proname = ''_submit_inquiry_core'' and pronamespace = ''public''::regnamespace) then
    alter function public.submit_inquiry(text, jsonb) rename to _submit_inquiry_core;
  end if;
end';

create or replace function public.submit_inquiry(p_form text, p_data jsonb)
returns void language plpgsql security definer set search_path = public as '
declare
  v_ok boolean;
  v_reason text;
begin
  select c.ok, c.reason into v_ok, v_reason
    from public._turnstile_check(p_data ->> ''cf-turnstile-response'') c;
  if not v_ok then
    -- Bounded, so a bot flood cannot grow this table without limit.
    if (select count(*) from public.intake_blocked where created_at > now() - interval ''1 hour'') < 200 then
      insert into public.intake_blocked (form, reason) values (left(coalesce(p_form, ''?''), 40), left(v_reason, 80));
    end if;
    return;
  end if;
  perform public._submit_inquiry_core(p_form, p_data - ''cf-turnstile-response'');
end';

revoke execute on function public.submit_inquiry(text, jsonb) from public;
grant  execute on function public.submit_inquiry(text, jsonb) to anon, authenticated;
revoke execute on function public._submit_inquiry_core(text, jsonb) from public, anon, authenticated;
revoke execute on function public._turnstile_check(text) from public, anon, authenticated;
