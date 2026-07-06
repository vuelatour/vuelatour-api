-- Doble rol (doc §3: "cada persona tendrá uno o más roles"): Pablo es ADMIN y
-- también vuela. El rol principal sigue mandando en permisos; es_piloto lo
-- incluye en todo lo de pilotos (selectores de asignación, disponibilidad,
-- horas, app). Los selectores filtran: rol = 'PILOTO' OR es_piloto.
alter table public.usuario
  add column es_piloto boolean not null default false;

comment on column public.usuario.es_piloto is
  'También vuela (rol secundario). PILOTO de rol lo implica; ADMIN/SOCIO que vuelan lo marcan.';

-- Backfill: los de rol PILOTO vuelan por definición.
update public.usuario set es_piloto = true where rol = 'PILOTO';
