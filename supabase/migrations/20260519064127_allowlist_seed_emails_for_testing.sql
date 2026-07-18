-- Volcada desde prod (ya aplicada como 20260519064127_allowlist_seed_emails_for_testing):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.
-- Nota: versiones posteriores redefinen esta funcion (20260523000001_rol_mecanico
-- agrega a luis@vuelatour.local y 20260607000005_signup_allowlist_from_usuario la
-- vuelve dinamica desde la tabla usuario).

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
    'aerocharter@vuelatour.local'
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
