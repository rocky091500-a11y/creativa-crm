-- Same names and signature as pg_net's net.http_post, request queue and response log.
-- Nothing is sent: tests read net.http_request_queue and write net._http_response themselves,
-- the way pg_net's background worker would after the transaction commits.
create schema if not exists net;
create table net.http_request_queue (
  id bigserial primary key, method text not null, url text not null, headers jsonb, body bytea,
  timeout_milliseconds integer not null);
create table net._http_response (
  id bigint, status_code integer, content_type text, headers jsonb, content text,
  timed_out boolean, error_msg text, created timestamptz not null default now());
create function net.http_post(url text, body jsonb default '{}'::jsonb, params jsonb default '{}'::jsonb,
                              headers jsonb default '{"Content-Type": "application/json"}'::jsonb,
                              timeout_milliseconds integer default 5000)
returns bigint language sql as $$
  insert into net.http_request_queue (method, url, headers, body, timeout_milliseconds)
  values ('POST', url, headers, convert_to(body::text, 'UTF8'), timeout_milliseconds) returning id
$$;
