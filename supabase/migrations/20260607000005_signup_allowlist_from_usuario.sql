-- "Invitar usuario" = pre-cargarlo en public.usuario. El gate de signup OAuth
-- ahora permite cualquier email que ya exista en public.usuario (además de los
-- dominios de la empresa), en vez de una lista hardcodeada. Así un admin invita
-- creando el usuario, y alguien ajeno (no invitado, sin dominio de empresa)
-- sigue bloqueado.

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

  -- Invitados: cualquier email pre-cargado por un admin en la tabla usuario.
  if exists (select 1 from public.usuario u where lower(u.email) = v_email) then
    return new;
  end if;

  raise exception 'Email no autorizado. Contacta al administrador del sistema.';
end;
$$;

comment on function public.tg_block_unauthorized_signups is
  'Gate de signup OAuth: permite dominios de empresa o emails pre-cargados en public.usuario (invitados). Editar v_allowed_domains para sumar dominios.';
