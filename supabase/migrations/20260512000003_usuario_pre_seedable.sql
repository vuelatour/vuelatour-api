-- Migration: 20260512000003_usuario_pre_seedable
-- Adjustments to public.usuario so we can pre-seed partners (socios) and
-- corporate entities (Aerocharter / Aerodinámica) without an auth.users row.
-- When a pre-seeded usuario later signs in via Google, the trigger links the
-- new auth.users.id to the existing row instead of creating a duplicate.

alter table public.usuario
  alter column supabase_auth_id drop not null;

alter table public.usuario
  add column es_empresa boolean not null default false;

comment on column public.usuario.supabase_auth_id is
  'NULL for pre-seeded usuarios (partners not yet logged in) and corporate entities.';
comment on column public.usuario.es_empresa is
  'True for company-level usuarios (Aerocharter, Aerodinámica) used as ownership holders.';

create or replace function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_existing_id uuid;
begin
  select id into v_existing_id
  from public.usuario
  where lower(email) = lower(new.email)
    and supabase_auth_id is null
    and es_empresa = false
  limit 1;

  if v_existing_id is not null then
    update public.usuario
    set supabase_auth_id = new.id,
        nombre = coalesce(
          nullif(nombre, ''),
          new.raw_user_meta_data->>'full_name',
          new.raw_user_meta_data->>'name',
          new.email
        )
    where id = v_existing_id;
  else
    insert into public.usuario (supabase_auth_id, nombre, email, rol, estado)
    values (
      new.id,
      coalesce(
        new.raw_user_meta_data->>'full_name',
        new.raw_user_meta_data->>'name',
        new.email
      ),
      new.email,
      'PILOTO',
      'INVITADO'
    )
    on conflict (supabase_auth_id) do nothing;
  end if;
  return new;
end;
$$;

revoke execute on function public.tg_handle_new_auth_user() from public, anon, authenticated;
