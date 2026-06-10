-- Nombres de pasajeros del vuelo (manifiesto).
--
-- Itzel los necesita para tramitar los permisos de pista/operación, y el piloto
-- debe verlos en su app al revisar la ruta asignada. Lista simple de nombres a
-- nivel vuelo (jsonb array de strings); editable al cotizar, apartar o editar.

alter table public.vuelo
  add column if not exists pasajeros_nombres jsonb not null default '[]'::jsonb;

comment on column public.vuelo.pasajeros_nombres is
  'Nombres de los pasajeros (array de strings). Necesarios para tramitar permisos; visibles para el piloto en su app.';
