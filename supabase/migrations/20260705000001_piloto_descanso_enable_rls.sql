-- piloto_descanso quedó sin RLS al crearse; se habilita para igualarla al
-- resto de las tablas (el API accede con service key, que ignora RLS).
alter table public.piloto_descanso enable row level security;
