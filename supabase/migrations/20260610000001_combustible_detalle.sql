-- Detalle estructurado de las cargas de combustible (gasto categoria GAS).
--
-- - litros: apartado propio (no en notas) — la oficina divide monto/litros para
--   el costo por litro.
-- - tipo_combustible: turbosina (Jet A) o avgas (100LL), lo extrae la IA.
-- - lugar: aeropuerto/FBO del ticket (CUN, CTM, MID…).
-- - fecha_hora_carga: momento PRECISO de la carga — con la matrícula identifica
--   a qué vuelo corresponde el ticket (carga 6am → vuelos de la mañana; 6pm →
--   previno del siguiente vuelo). fecha_gasto (date) se conserva para reportes.

alter table public.gasto
  add column if not exists litros decimal(10,2),
  add column if not exists tipo_combustible text,
  add column if not exists lugar text,
  add column if not exists fecha_hora_carga timestamptz;

alter table public.gasto
  drop constraint if exists gasto_tipo_combustible_check;
alter table public.gasto
  add constraint gasto_tipo_combustible_check
  check (tipo_combustible is null or tipo_combustible in ('TURBOSINA', 'AVGAS'));

comment on column public.gasto.litros is
  'Litros cargados (solo combustible). costo/litro = monto / litros.';
comment on column public.gasto.tipo_combustible is
  'TURBOSINA (Jet A) o AVGAS (100LL).';
comment on column public.gasto.lugar is
  'Aeropuerto/FBO donde se hizo la carga (del ticket).';
comment on column public.gasto.fecha_hora_carga is
  'Momento preciso de la carga; con la aeronave permite sugerir el vuelo al que corresponde.';
