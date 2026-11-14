-- Provisioning runs and secret storage. Run once in the Supabase SQL editor after schema.sql.
-- Secrets live in Supabase Vault (encrypted at rest). The app reaches them only through the two
-- functions below, which only the service role may execute.

create table if not exists public.provision_runs (
  id          text primary key,
  app         text not null,
  slug        text not null,
  mode        text not null check (mode in ('human', 'auto')),
  status      text not null,
  data        jsonb not null,           -- vault names and masked values only, never a secret
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);
create index if not exists provision_runs_created_idx on public.provision_runs (created_at desc);
create index if not exists provision_runs_state_idx on public.provision_runs ((data->'verify'->>'state'));
alter table public.provision_runs enable row level security;

-- Every reveal of a secret is logged.
create table if not exists public.provision_reveals (
  id          bigint generated always as identity primary key,
  run_id      text not null,
  secret_name text not null,
  revealed_at timestamptz not null default now()
);
alter table public.provision_reveals enable row level security;

create extension if not exists supabase_vault with schema vault;

create or replace function public.provision_store_secret(p_name text, p_secret text, p_description text default '')
returns uuid
language plpgsql
security definer
set search_path = ''
as $$
declare v_id uuid;
begin
  select id into v_id from vault.secrets where name = p_name;
  if v_id is null then
    v_id := vault.create_secret(p_secret, p_name, p_description);
  else
    perform vault.update_secret(v_id, p_secret, p_name, p_description);
  end if;
  return v_id;
end;
$$;

create or replace function public.provision_read_secret(p_name text)
returns text
language sql
security definer
set search_path = ''
as $$
  select decrypted_secret from vault.decrypted_secrets where name = p_name limit 1;
$$;

revoke all on function public.provision_store_secret(text, text, text) from public, anon, authenticated;
revoke all on function public.provision_read_secret(text) from public, anon, authenticated;
grant execute on function public.provision_store_secret(text, text, text) to service_role;
grant execute on function public.provision_read_secret(text) to service_role;

notify pgrst, 'reload schema';
