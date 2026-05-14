-- Migration: 20260513000007_auth_email_whitelist
-- Restringe qué emails pueden completar el flow OAuth con Google. El trigger
-- corre BEFORE INSERT en auth.users, así que los usuarios ya existentes
-- (Diego incluido) no se ven afectados — solo los signups nuevos.
--
-- Para agregar un dominio o email específico:
--   alter function public.tg_block_unauthorized_signups...
-- O más limpio: mantener una tabla auth_email_allowlist y consultarla desde el trigger.
-- Empezamos con la lista hardcodeada simple; si crece, migramos a tabla.

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
  v_allowed_emails  text[] := array[]::text[];
begin
  v_email  := lower(coalesce(new.email, ''));
  v_domain := split_part(v_email, '@', 2);

  if v_email = '' then
    raise exception 'Email es requerido para crear cuenta.';
  end if;

  if v_domain = any(v_allowed_domains) then
    return new;
  end if;

  if v_email = any(v_allowed_emails) then
    return new;
  end if;

  raise exception 'Email no autorizado. Contacta al administrador del sistema.';
end;
$$;

revoke execute on function public.tg_block_unauthorized_signups() from public, anon, authenticated;

drop trigger if exists trg_block_unauthorized_signups on auth.users;
create trigger trg_block_unauthorized_signups
  before insert on auth.users
  for each row execute function public.tg_block_unauthorized_signups();

comment on function public.tg_block_unauthorized_signups is
  'Whitelist de emails que pueden completar signup. Edita los arrays internos para sumar dominios o emails individuales y vuelve a aplicar la migration.';
