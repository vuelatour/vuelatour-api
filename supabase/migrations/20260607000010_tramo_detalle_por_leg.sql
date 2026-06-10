-- Detalle por tramo: pasajeros, ferry (empty leg), pernocta + costo, parada de servicio.
--
-- Itzel necesita capturar info distinta por tramo de un itinerario multiescala:
-- pax por tramo (recalcula TUAS por tramo), tramos ferry (vacíos: cobran tiempo y
-- calzos pero 0 pax/sin TUAS), pernocta (suma viáticos configurables), y paradas de
-- servicio (p. ej. bajar en Toledo a cambiar llanta).
--
-- Aplica a ruta_predefinida_tramo (defaults de plantilla reutilizable) y a escala
-- (valores reales por cotización/vuelo, editables al cotizar). Idempotente.

-- 1) Enum tipo_parada.
do $$ begin
  create type public.tipo_parada as enum ('NORMAL', 'SERVICIO');
exception when duplicate_object then null; end $$;

-- 2) Columnas en ruta_predefinida_tramo (plantilla / defaults).
alter table public.ruta_predefinida_tramo
  add column if not exists pasajeros int,
  add column if not exists es_ferry boolean not null default false,
  add column if not exists requiere_pernocta boolean not null default false,
  add column if not exists pernocta_costo_usd numeric(10,2),
  add column if not exists tipo_parada public.tipo_parada not null default 'NORMAL',
  add column if not exists servicio_notas text;

comment on column public.ruta_predefinida_tramo.pasajeros is
  'Pax sugeridos para este tramo en la plantilla. NULL = el cotizador usa los pax globales.';
comment on column public.ruta_predefinida_tramo.es_ferry is
  'Tramo vacío (empty leg): se cobra tiempo+calzos pero 0 pax / sin TUAS.';
comment on column public.ruta_predefinida_tramo.requiere_pernocta is
  'Marca pernocta en este tramo; agrega una línea de viáticos a la cotización.';
comment on column public.ruta_predefinida_tramo.pernocta_costo_usd is
  'Costo de pernocta/viáticos del tramo. NULL = usa la constante PERNOCTA_COSTO_DEFAULT_USD.';
comment on column public.ruta_predefinida_tramo.tipo_parada is
  'NORMAL o SERVICIO (parada técnica/servicio, p. ej. cambiar llanta).';

-- 3) Columnas en escala (por cotización; editable al cotizar).
alter table public.escala
  add column if not exists pasajeros int,
  add column if not exists es_ferry boolean not null default false,
  add column if not exists requiere_pernocta boolean not null default false,
  add column if not exists pernocta_costo_usd numeric(10,2),
  add column if not exists tipo_parada public.tipo_parada not null default 'NORMAL',
  add column if not exists servicio_notas text;

comment on column public.escala.pasajeros is
  'Pax reales de este tramo (para TUAS por tramo). NULL/legacy = vuelo.pasajeros.';
comment on column public.escala.es_ferry is
  'Tramo vacío: 0 pax, sin TUAS, sí cuenta calzo.';
comment on column public.escala.requiere_pernocta is
  'Pernocta en este tramo; suma viáticos a la cotización.';
comment on column public.escala.tipo_parada is
  'NORMAL o SERVICIO (parada técnica/servicio).';

-- 4) Backfill: pax del tramo = vuelo.pasajeros para escalas existentes sin valor.
update public.escala e
set pasajeros = v.pasajeros
from public.vuelo v
where e.vuelo_id = v.id
  and e.pasajeros is null;
