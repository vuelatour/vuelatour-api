-- Volcada desde prod (ya aplicada como 20260622185247_escala_pasajeros_nombres):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.

alter table public.escala
  add column if not exists pasajeros_nombres jsonb not null default '[]'::jsonb;

comment on column public.escala.pasajeros_nombres is
  'Manifiesto de nombres de pasajeros de ESTE tramo (puede variar por escala y estar vacío). Reemplaza al manifiesto a nivel vuelo.';
