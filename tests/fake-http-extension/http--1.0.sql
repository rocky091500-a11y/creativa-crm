-- Same type and function signature as pgsql-http; responses mimic Cloudflare Turnstile's
-- siteverify with its official test secrets (1x... always passes, 2x... always fails),
-- and the Telegram Bot API (sendMessage, getUpdates). Telegram calls are recorded in http_calls.
create type http_response as (status integer, content_type varchar, headers text[], content varchar);
create table http_calls (id serial primary key, at timestamptz not null default now(), uri text, content text);

create function http_post(uri varchar, content varchar, content_type varchar)
returns http_response language plpgsql
-- Pin lookups to the schema the extension is installed in (callers may restrict search_path).
set search_path from current as $$
declare
  b   jsonb := content::jsonb;
  tok text  := coalesce(b->>'response', '');
  sec text  := coalesce(b->>'secret', '');
begin
  if uri like 'https://api.telegram.org/bot%' then
    insert into http_calls (uri, content) values (uri, content);
    if uri like '%TIMEOUT%' then
      raise exception 'Operation timed out after 4000 milliseconds';
    end if;
    if uri like '%/bot000000000:%' then
      return row(401, 'application/json', null, '{"ok":false,"error_code":401,"description":"Unauthorized"}')::http_response;
    end if;
    if uri like '%/getUpdates' then
      return row(200, 'application/json', null, '{"ok":true,"result":[
        {"update_id":1,"message":{"message_id":5,"chat":{"id":555111222,"first_name":"Emily","last_name":"Owner","type":"private"},"text":"hi"}},
        {"update_id":2,"my_chat_member":{"chat":{"id":-1009876543210,"title":"Creativa front desk","type":"supergroup"}}},
        {"update_id":3,"message":{"message_id":6,"chat":{"id":555111222,"first_name":"Emily","last_name":"Owner","type":"private"},"text":"again"}}]}')::http_response;
    end if;
    if b->>'chat_id' = '999' then
      return row(400, 'application/json', null, '{"ok":false,"error_code":400,"description":"Bad Request: chat not found"}')::http_response;
    end if;
    return row(200, 'application/json', null, '{"ok":true,"result":{"message_id":42}}')::http_response;
  end if;
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
