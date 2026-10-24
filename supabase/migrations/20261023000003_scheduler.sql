-- Cloud scheduler (FR-SYNC-001/003): pg_cron → pg_net → sync-dispatch Edge Function.
-- Runs entirely server-side; independent of Claude Code, GitHub Pages and user devices.
-- Requires two Vault secrets (local: supabase/seed.sql; production: see README "Production deployment"):
--   qals_functions_url  e.g. https://<ref>.supabase.co/functions/v1 (local: http://kong:8000/functions/v1)
--   qals_worker_secret  shared secret checked by the worker functions

create extension if not exists pg_cron;
create extension if not exists pg_net;

create function public.invoke_worker(p_function text, p_body jsonb default '{}')
returns bigint language plpgsql security definer set search_path = public, extensions as $$
declare
  v_url text := (select decrypted_secret from vault.decrypted_secrets where name = 'qals_functions_url');
  v_secret text := (select decrypted_secret from vault.decrypted_secrets where name = 'qals_worker_secret');
begin
  if v_url is null or v_secret is null then
    raise warning 'QA LiveSync scheduler secrets missing; skipping %', p_function;
    return null;
  end if;
  return net.http_post(
    url := v_url || '/' || p_function,
    body := p_body,
    headers := jsonb_build_object('Content-Type', 'application/json', 'x-worker-secret', v_secret),
    timeout_milliseconds := 5000
  );
end $$;
revoke execute on function public.invoke_worker(text, jsonb) from anon, authenticated, public;

select cron.schedule('qals-sync-every-3-min', '*/3 * * * *', $$ select public.invoke_worker('sync-dispatch', '{"trigger":"schedule"}'); $$);
select cron.schedule('qals-retention-daily', '17 3 * * *', $$ select public.purge_old_snapshots(); $$);
