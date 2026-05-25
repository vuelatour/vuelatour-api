-- Tarea 10: rol "Mecánico" para carga de combustibles.
ALTER TYPE rol_usuario ADD VALUE IF NOT EXISTS 'MECANICO';

-- Autoriza el alta del mecánico Luis (luis@vuelatour.local) en el trigger de signups.
CREATE OR REPLACE FUNCTION public.tg_block_unauthorized_signups()
 RETURNS trigger
 LANGUAGE plpgsql
 SECURITY DEFINER
 SET search_path TO ''
AS $function$
declare
  v_email text;
  v_domain text;
  v_allowed_domains text[] := array['vuelatour.com', 'eddcode.com'];
  v_allowed_emails  text[] := array[
    'alex.saab@vuelatour.local',
    'angel.alvarez@vuelatour.local',
    'carlos.moreno@vuelatour.local',
    'hernan.garza@vuelatour.local',
    'macedo@vuelatour.local',
    'mauricio.roque@vuelatour.local',
    'aerocharter@vuelatour.local',
    'luis@vuelatour.local'
  ];
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
$function$;
