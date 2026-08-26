-- Mantenimiento robusto: etapas de servicio con tareas, bitácora de
-- componentes rotables (motor/hélice) y tiempo total del planeador.
--
-- 1) aeronave_servicio_etapa: cada intervalo del programa cíclico (50/100/200)
--    es una ETAPA con nombre opcional y lista de TAREAS mayores (cambio de
--    aceite, bujías, ...). Antes solo existía aeronave.servicio_intervalos
--    numeric[] y las tareas tecleadas por coma se descartaban en silencio.
--    servicio_intervalos se conserva como columna derivada (fuente de lectura
--    para app/alertas); el API la mantiene en sync al escribir etapas.
-- 2) componente_evento: bitácora de vida de componentes rotables. "El motor
--    se instaló cuando el avión llevaba X horas" queda grabado (como en la
--    bitácora física AFAC): instalación, traslado entre aviones, overhaul y
--    ajustes de base, con el taco del avión y las horas del componente.
-- 3) motor.tso_base / helice.tso_base: horas del componente DESDE el último
--    overhaul en el momento del ancla (aeronave_horas_ref), en MARCO DEL
--    COMPONENTE. TSO vivo = tso_base + (hobbs − aeronave_horas_ref). El turm
--    legado (taco del AVIÓN al último overhaul) se corrompía al trasladar el
--    componente a otro avión (otro tacómetro); tso_base viaja con el motor.
--    Puede ser negativo (overhaul posterior al ancla): el API recorta a 0 al
--    mostrar. NULL = sin overhaul registrado (TSO = TSN, respaldo actual).
-- 4) aeronave.planeador_horas_base/planeador_taco_ref: tiempo total del
--    planeador = planeador_horas_base + (hobbs − planeador_taco_ref).
--    Con defaults 0/0 equivale al tacómetro (comportamiento actual).
-- 5) mantenimiento: liga opcional a la etapa del programa que cubre, al
--    componente (motor/hélice) y checklist de tareas realizadas.

-- ============ 1) Etapas del programa de servicio ============

create table public.aeronave_servicio_etapa (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  intervalo_hr numeric(10,2) not null check (intervalo_hr > 0),
  nombre varchar(80),
  tareas text[] not null default '{}',
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  unique (aeronave_id, intervalo_hr)
);

comment on table public.aeronave_servicio_etapa is
  'Etapas del programa cíclico de servicio del avión: intervalo en horas + tareas mayores de la etapa. aeronave.servicio_intervalos es la vista derivada (el API la sincroniza).';
comment on column public.aeronave_servicio_etapa.tareas is
  'Tareas mayores de la etapa (ej. cambio de aceite, filtros). En hitos coincidentes el servicio mayor incluye las tareas de los menores.';

create index idx_servicio_etapa_aeronave on public.aeronave_servicio_etapa (aeronave_id);

create trigger trg_servicio_etapa_set_updated_at
  before update on public.aeronave_servicio_etapa
  for each row execute function public.tg_set_updated_at();

alter table public.aeronave_servicio_etapa enable row level security;

-- Dedupe del programa existente (N58BT quedó con {100,100} por el bug del
-- parser por comas del panel).
update public.aeronave
set servicio_intervalos = (
  select coalesce(array_agg(distinct v order by v), '{}')
  from unnest(servicio_intervalos) as v
  where v > 0
)
where servicio_intervalos is distinct from '{}';

-- Backfill: una etapa (sin tareas aún) por cada intervalo ya configurado.
insert into public.aeronave_servicio_etapa (aeronave_id, intervalo_hr)
select a.id, v
from public.aeronave a
cross join lateral unnest(a.servicio_intervalos) as v
where v > 0
group by a.id, v
on conflict do nothing;

-- ============ 2) Bitácora de componentes rotables ============

create table public.componente_evento (
  id uuid primary key default gen_random_uuid(),
  motor_id uuid references public.motor(id) on delete cascade,
  helice_id uuid references public.helice(id) on delete cascade,
  tipo_evento varchar(12) not null
    check (tipo_evento in ('INSTALACION', 'TRASLADO', 'OVERHAUL', 'AJUSTE')),
  aeronave_id uuid references public.aeronave(id) on delete set null,
  aeronave_origen_id uuid references public.aeronave(id) on delete set null,
  posicion varchar(10),
  hobbs_avion numeric(10,2),
  hobbs_avion_origen numeric(10,2),
  horas_componente numeric(10,2),
  horas_desde_overhaul numeric(10,2),
  fecha date not null default ((now() at time zone 'America/Cancun')::date),
  motivo text,
  realizado_por uuid references public.usuario(id) on delete set null,
  created_at timestamptz not null default now(),
  check (num_nonnulls(motor_id, helice_id) = 1)
);

comment on table public.componente_evento is
  'Bitácora de vida de componentes rotables (motor/hélice): instalación, traslado, overhaul y ajustes de base. Registra el taco del avión y las horas del componente al momento del evento (equivalente a la entrada de bitácora física).';
comment on column public.componente_evento.aeronave_id is 'Avión del evento (destino en un TRASLADO).';
comment on column public.componente_evento.hobbs_avion is 'Tacómetro del avión (destino) al momento del evento.';
comment on column public.componente_evento.hobbs_avion_origen is 'Tacómetro del avión origen (solo TRASLADO).';
comment on column public.componente_evento.horas_componente is 'Horas de vida del componente (TSN) al momento del evento.';
comment on column public.componente_evento.horas_desde_overhaul is 'Horas desde el último overhaul (TSO) al momento del evento; null si nunca se ha registrado overhaul.';

create index idx_componente_evento_motor on public.componente_evento (motor_id) where motor_id is not null;
create index idx_componente_evento_helice on public.componente_evento (helice_id) where helice_id is not null;
create index idx_componente_evento_aeronave on public.componente_evento (aeronave_id);

alter table public.componente_evento enable row level security;

-- ============ 3) TSO en marco del componente ============

alter table public.motor add column tso_base numeric(10,2);
alter table public.helice add column tso_base numeric(10,2);

comment on column public.motor.tso_base is
  'Horas del MOTOR desde su último overhaul en el momento del ancla (aeronave_horas_ref). TSO vivo = tso_base + (hobbs − ref); viaja con el motor al trasladarlo. NULL = sin overhaul registrado (TSO = TSN). Sustituye al turm legado (taco del avión), que no sobrevive un traslado.';
comment on column public.helice.tso_base is
  'Horas de la HÉLICE desde su último overhaul en el momento del ancla (aeronave_horas_ref). TSO vivo = tso_base + (hobbs − ref). NULL = sin overhaul registrado.';

-- Conversión del turm legado (marco del taco del avión) al marco del
-- componente: TSO vivo actual = hobbs − turm = (ref − turm) + (hobbs − ref).
update public.motor
set tso_base = aeronave_horas_ref - turm
where turm > 0 and aeronave_horas_ref is not null;

update public.helice
set tso_base = aeronave_horas_ref - turm
where turm > 0 and aeronave_horas_ref is not null;

-- Backfill de bitácora: evento de alta por cada componente existente, con el
-- ancla actual como referencia de instalación conocida.
insert into public.componente_evento
  (motor_id, tipo_evento, aeronave_id, posicion, hobbs_avion, horas_componente, horas_desde_overhaul, fecha, motivo)
select m.id, 'INSTALACION', m.aeronave_id, m.posicion::text,
       m.aeronave_horas_ref, m.horas_totales,
       case when m.tso_base is not null then greatest(m.tso_base, 0) end,
       (m.created_at at time zone 'America/Cancun')::date,
       'Alta inicial en el sistema (backfill)'
from public.motor m;

insert into public.componente_evento
  (helice_id, tipo_evento, aeronave_id, posicion, hobbs_avion, horas_componente, horas_desde_overhaul, fecha, motivo)
select h.id, 'INSTALACION', h.aeronave_id, h.posicion::text,
       h.aeronave_horas_ref, h.horas_totales,
       case when h.tso_base is not null then greatest(h.tso_base, 0) end,
       (h.created_at at time zone 'America/Cancun')::date,
       'Alta inicial en el sistema (backfill)'
from public.helice h;

-- ============ 4) Tiempo total del planeador ============

alter table public.aeronave
  add column planeador_horas_base numeric(10,2) not null default 0
    check (planeador_horas_base >= 0),
  add column planeador_taco_ref numeric(10,2) not null default 0
    check (planeador_taco_ref >= 0);

comment on column public.aeronave.planeador_horas_base is
  'Horas TOTALES del planeador (célula) cuando el tacómetro marcaba planeador_taco_ref. Tiempo total del planeador = base + (hobbs − ref). Con 0/0 equivale al tacómetro.';
comment on column public.aeronave.planeador_taco_ref is
  'Lectura del tacómetro del avión en el momento en que se capturó planeador_horas_base.';

-- ============ 5) Mantenimiento ligado a etapa/componente/tareas ============

alter table public.mantenimiento
  add column etapa_intervalo_hr numeric(10,2) check (etapa_intervalo_hr is null or etapa_intervalo_hr > 0),
  add column tareas_realizadas text[] not null default '{}',
  add column motor_id uuid references public.motor(id) on delete set null,
  add column helice_id uuid references public.helice(id) on delete set null;

comment on column public.mantenimiento.etapa_intervalo_hr is
  'Etapa del programa cíclico que cubre este servicio (ej. 50, 100, 200). Null = servicio fuera del programa.';
comment on column public.mantenimiento.tareas_realizadas is
  'Tareas ejecutadas en el servicio (checklist de la etapa + tareas libres).';
comment on column public.mantenimiento.motor_id is 'Componente al que aplica el servicio (opcional; null = planeador/avión en general).';

create index idx_mantenimiento_motor on public.mantenimiento (motor_id) where motor_id is not null;
create index idx_mantenimiento_helice on public.mantenimiento (helice_id) where helice_id is not null;
