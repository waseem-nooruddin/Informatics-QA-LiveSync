-- OAuth credentials encrypted at rest in Supabase Vault (SEC-004, FR-SRC-006).
-- Only the service role (Edge Functions) can execute these; never exposed to the frontend.

create function public.store_credential(
  p_project text, p_provider text, p_account text, p_secret jsonb, p_scopes text[])
returns uuid language plpgsql security definer set search_path = public, vault as $$
declare v_secret uuid; v_id uuid;
begin
  v_secret := vault.create_secret(p_secret::text, 'qals-cred-' || gen_random_uuid()::text, 'QA LiveSync OAuth credential');
  insert into source_credentials (project_id, provider, account_ref, vault_secret_id, scopes)
  values (p_project, p_provider, p_account, v_secret, p_scopes) returning id into v_id;
  insert into audit_log (project_id, actor, action, detail)
  values (p_project, 'admin', 'credential.stored', jsonb_build_object('credentialId', v_id, 'provider', p_provider, 'account', p_account));
  return v_id;
end $$;

create function public.read_credential(p_project text, p_id uuid)
returns jsonb language sql stable security definer set search_path = public, vault as $$
  select ds.decrypted_secret::jsonb
  from source_credentials c join vault.decrypted_secrets ds on ds.id = c.vault_secret_id
  where c.project_id = p_project and c.id = p_id and c.revoked_at is null;
$$;

create function public.update_credential(p_project text, p_id uuid, p_secret jsonb)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_secret uuid;
begin
  select vault_secret_id into v_secret from source_credentials where project_id = p_project and id = p_id and revoked_at is null;
  if v_secret is null then raise exception 'CREDENTIAL_NOT_FOUND' using errcode = 'P0001'; end if;
  perform vault.update_secret(v_secret, p_secret::text);
end $$;

create function public.revoke_credential(p_project text, p_id uuid, p_actor text)
returns void language plpgsql security definer set search_path = public, vault as $$
declare v_secret uuid;
begin
  update source_credentials set revoked_at = now() where project_id = p_project and id = p_id returning vault_secret_id into v_secret;
  if v_secret is not null then perform vault.update_secret(v_secret, '{}'); end if;
  insert into audit_log (project_id, actor, action, detail) values (p_project, p_actor, 'credential.revoked', jsonb_build_object('credentialId', p_id));
end $$;

revoke execute on function public.store_credential(text, text, text, jsonb, text[]) from anon, authenticated, public;
revoke execute on function public.read_credential(text, uuid) from anon, authenticated, public;
revoke execute on function public.update_credential(text, uuid, jsonb) from anon, authenticated, public;
revoke execute on function public.revoke_credential(text, uuid, text) from anon, authenticated, public;
grant execute on all functions in schema public to service_role;

-- Private bucket for uploaded XLSX/CSV sources (also created lazily by admin-api).
do $$
begin
  if to_regclass('storage.buckets') is not null then
    insert into storage.buckets (id, name, public, file_size_limit)
    values ('sources', 'sources', false, 26214400)
    on conflict (id) do nothing;
  end if;
end $$;
