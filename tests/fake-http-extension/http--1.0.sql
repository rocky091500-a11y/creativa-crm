-- Same type and function signature as pgsql-http; responses mimic Cloudflare Turnstile's
-- siteverify with its official test secrets (1x... always passes, 2x... always fails).
create type http_response as (status integer, content_type varchar, headers text[], content varchar);

create function http_post(uri varchar, content varchar, content_type varchar)
returns http_response language plpgsql
-- Pin lookups to the schema the extension is installed in (callers may restrict search_path).
set search_path from current as $$
declare
  b   jsonb := content::jsonb;
  tok text  := coalesce(b->>'response', '');
  sec text  := coalesce(b->>'secret', '');
begin
  if uri <> 'https://challenges.cloudflare.com/turnstile/v0/siteverify' then
    raise exception 'unexpected url %', uri;
  end if;
  if tok = 'SIMULATE-OUTAGE' then
    raise exception 'Could not resolve host: challenges.cloudflare.com';
  end if;
  if tok = '' then
    return row(200, 'application/json', null, '{"success":false,"error-codes":["missing-input-response"]}')::http_response;
  end if;
  if sec like '1x%' then
    return row(200, 'application/json', null, '{"success":true,"error-codes":[]}')::http_response;
  end if;
  return row(200, 'application/json', null, '{"success":false,"error-codes":["invalid-input-response"]}')::http_response;
end $$;
