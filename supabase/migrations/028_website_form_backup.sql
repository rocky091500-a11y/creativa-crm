-- Creativa CRM — a backup path for website forms, so a request never reaches Telegram but not the CRM.
-- Run once in the Supabase SQL editor, after 027_pause.sql. Safe to run again.
--
--   The website sends each enrollment form to the CRM from the family's browser (submit_inquiry, with the robot check)
--   and to Netlify, which keeps a copy and passes it on (Telegram). A browser copy can fail: the robot check expired
--   while the family was typing, the phone dropped the connection as the thank-you page opened. Now Netlify also sends
--   its copy to the CRM's website-form function (netlify/functions/website-form.mjs), signed with a shared secret, which
--   calls:
--   submit_inquiry_netlify   saves Netlify's copy of a form unless the CRM already has it: the same Netlify submission
--                            (a retry), or the browser copy of it (same form, same email or phone, within an hour), which
--                            just gets the Netlify id. Blocked senders and the per-device limit still apply; the robot
--                            check doesn't (Netlify already filtered its copy, and the request is signed). Server only:
--                            the website and staff can't call it.
--
-- No dollar-quoting or backslashes in this file, so it survives copy-paste intact.

create or replace function public.submit_inquiry_netlify(p_form text, p_data jsonb, p_netlify_id text, p_received_at timestamptz)
returns text language plpgsql security definer set search_path = public as '
declare
  v_email text;
  v_phone text;
  v_ip    text;
  v_at    timestamptz := coalesce(p_received_at, now());
  v_id    uuid;
  v_why   text;
begin
  if p_form is null or p_form not in (''schedule-tour'', ''waitlist'', ''contact'', ''bloom-interest'', ''family-support'') then
    return ''not a CRM form'';
  end if;
  if p_data is null or jsonb_typeof(p_data) <> ''object'' or coalesce(btrim(p_netlify_id), '''') = '''' then
    return ''not saved: no form data'';
  end if;
  if coalesce(p_data ->> ''bot-field'', '''') <> '''' then return ''not saved: a bot''; end if;
  if exists (select 1 from public.inquiries i where i.raw ->> ''netlify_id'' = p_netlify_id) then
    return ''already in the CRM'';
  end if;

  v_email := lower(public._form_txt(p_data, ''parent-email'', ''email''));
  v_phone := nullif(right(regexp_replace(coalesce(public._form_txt(p_data, ''parent-phone'', ''phone''), ''''), ''[^0-9]'', '''', ''g''), 10), '''');
  v_ip := nullif(btrim(p_data ->> ''ip''), '''');

  -- The browser copy of this same request already arrived: note Netlify''s id on it and stop.
  select i.id into v_id from public.inquiries i
   where i.source = p_form and i.created_at between v_at - interval ''1 hour'' and v_at + interval ''1 hour''
     and ((v_email is not null and lower(i.email) = v_email) or (v_phone is not null and right(i.phone_digits, 10) = v_phone))
   order by i.created_at desc limit 1;
  if v_id is not null then
    update public.inquiries set raw = coalesce(raw, ''{}''::jsonb) || jsonb_build_object(''netlify_id'', p_netlify_id) where id = v_id;
    return ''already in the CRM'';
  end if;

  if exists (select 1 from public.intake_blocklist b
              where (b.kind = ''email'' and b.value = v_email) or (b.kind = ''phone'' and b.value = v_phone)
                 or (b.kind = ''ip'' and b.value = v_ip)) then
    v_why := ''blocked-sender'';
  elsif v_ip is not null and (select count(*) from public.inquiries
                               where client_ip = v_ip and created_at > now() - interval ''1 hour'') >= 5 then
    v_why := ''too-many-from-device'';
  end if;
  if v_why is not null then
    if (select count(*) from public.intake_blocked where created_at > now() - interval ''1 hour'') < 200 then
      insert into public.intake_blocked (form, reason) values (p_form, v_why);
    end if;
    return ''not saved: '' || v_why;
  end if;

  perform set_config(''crm.client_ip'', coalesce(v_ip, ''''), true);
  begin
    perform public._submit_inquiry_core(p_form,
      (p_data - ''cf-turnstile-response'' - ''ip'' - ''user_agent'' - ''referrer'') || jsonb_build_object(''netlify_id'', p_netlify_id));
  exception when others then
    return ''not saved: '' || left(sqlerrm, 200);
  end;
  if exists (select 1 from public.inquiries i where i.raw ->> ''netlify_id'' = p_netlify_id) then return ''saved''; end if;
  return ''not saved: too many from this family at once'';
end';

revoke execute on function public.submit_inquiry_netlify(text, jsonb, text, timestamptz) from public, anon, authenticated;
grant  execute on function public.submit_inquiry_netlify(text, jsonb, text, timestamptz) to service_role;
