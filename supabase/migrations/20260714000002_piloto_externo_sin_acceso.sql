-- Piloto externo (doc 3.7): freelance que vuela aviones de la flota SIN
-- acceso al sistema. Es una fila en usuario (rol PILOTO, es_piloto_externo)
-- para que la asignación de vuelos, el espejo de tramos y los reportes sigan
-- funcionando, pero NUNCA debe poder autenticarse:
--
-- 1) email opcional (los freelance se coordinan por WhatsApp; obligar un email
--    inventado es fricción y además lo metería a la allowlist de signup).
alter table public.usuario alter column email drop not null;

-- 2) La allowlist de signup OAuth ignora a los pilotos externos: aunque se
--    capture su email real, NO les abre la puerta al login.
create or replace function public.tg_block_unauthorized_signups()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_email text;
  v_domain text;
  v_allowed_domains text[] := array['vuelatour.com', 'eddcode.com'];
begin
  v_email  := lower(coalesce(new.email, ''));
  v_domain := split_part(v_email, '@', 2);

  if v_email = '' then
    raise exception 'Email es requerido para crear cuenta.';
  end if;

  -- Dominios de la empresa: acceso directo.
  if v_domain = any(v_allowed_domains) then
    return new;
  end if;

  -- Invitados: emails pre-cargados por un admin en la tabla usuario.
  -- Los pilotos EXTERNOS no cuentan como invitación (no tienen acceso).
  if exists (
    select 1
    from public.usuario u
    where lower(u.email) = v_email
      and coalesce(u.es_piloto_externo, false) = false
  ) then
    return new;
  end if;

  raise exception 'Email no autorizado. Contacta al administrador del sistema.';
end;
$$;

-- 3) El enlace por email del primer login tampoco toca filas de externos.
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
    and coalesce(es_piloto_externo, false) = false
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
