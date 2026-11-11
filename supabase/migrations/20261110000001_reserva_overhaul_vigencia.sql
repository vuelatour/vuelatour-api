-- 20261110000001_reserva_overhaul_vigencia.sql
--
-- RESERVA DE OVERHAUL CON VIGENCIA — «a partir de» (10-nov-2026, API 0.0.135,
-- invariante 130).
--
-- Pedido del cliente con la captura del campo «Reserva overhaul USD/hr (por
-- motor)» de la ficha del avión: «que pudiéramos ponerle desde cuándo entra
-- en vigor esa reserva de overhaul, porque nomás aparece el monto… que
-- dijera ahí "a partir de" y la fecha a partir de cuándo quiere que afecte».
--
-- Hasta hoy la tarifa era UNA sola por avión (tabla `reserva_overhaul`, una
-- fila por motor) y se aplicaba EN VIVO a todo mes sin cierre formal:
-- capturarla o corregirla movía septiembre y octubre, que ya se habían
-- entregado a los socios sin reserva. Aquí cada tarifa tiene su «a partir
-- de»: las horas de un vuelo generan reserva con la tarifa vigente el día del
-- vuelo (día Cancún) y lo volado antes de la primera tarifa no genera nada.
--
-- QUÉ HACE (ADITIVA):
--   1. Crea `reserva_overhaul_vigencia` (una fila por avión y fecha).
--   2. Copia la tarifa que cada avión tiene HOY en `reserva_overhaul` como
--      una tarifa «desde siempre» (2026-01-01, anterior a cualquier vuelo del
--      sistema): con eso los números de TODOS los libros quedan idénticos a
--      los de antes de aplicar. La oficina cambia después la fecha o agrega
--      tarifas desde la ficha del avión.
--   3. Verifica que la copia reproduce EXACTO la suma de cada avión; si no,
--      la migración se cancela sola (nada queda aplicado).
-- La tabla `reserva_overhaul` NO se toca (el API la sigue alineando con la
-- tarifa vigente por si hay que regresar a un API anterior).
--
-- Sin llaves foráneas a `usuario` A PROPÓSITO (patrón de las bitácoras): los
-- sellos sobreviven a la baja del usuario. Una tarifa eliminada conserva su
-- fila (`deleted_at` / `deleted_by`) y una corregida guarda la anterior en
-- `historial`: se sabe quién cambió qué y cuándo.
--
-- ROLLBACK (solo si el API vuelve a ≤ 0.0.134; el 0.0.135 funciona sin la
-- tabla): eliminar la tabla `reserva_overhaul_vigencia` desde el SQL Editor.
-- Las tarifas de la tabla por motor siguen ahí.
--
-- Aplicar desde el SQL Editor (el MCP declina las sentencias destructivas y
-- esta lleva `on … cascade`); después:
--   insert into supabase_migrations.schema_migrations (version, name, statements)
--   values ('20261110000001', 'reserva_overhaul_vigencia',
--     array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261110000001_reserva_overhaul_vigencia.sql']);
-- (paquete listo en docs/sql-aplicar-10-nov-2026-reserva-overhaul-vigencia/)

-- >>> CUERPO
create table if not exists public.reserva_overhaul_vigencia (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  vigente_desde date not null,
  usd_hr_por_motor numeric(10,2) not null,
  motores integer not null default 1,
  notas text,
  historial jsonb not null default '[]'::jsonb,
  created_by uuid,
  created_at timestamptz not null default now(),
  updated_by uuid,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid,
  constraint reserva_overhaul_vigencia_tarifa_chk check (usd_hr_por_motor >= 0),
  constraint reserva_overhaul_vigencia_motores_chk check (motores between 1 and 8),
  constraint reserva_overhaul_vigencia_notas_chk
    check (notas is null or char_length(notas) <= 300)
);

comment on table public.reserva_overhaul_vigencia is
  'Tarifas de la reserva de overhaul con vigencia (10-nov-2026, invariante 130 del API): una fila por avión y fecha «a partir de». Las horas de un vuelo generan reserva con la tarifa vigente el día del vuelo; total por hora = usd_hr_por_motor × motores. Baja = deleted_at (no se borra); una corrección guarda la tarifa anterior en historial.';
comment on column public.reserva_overhaul_vigencia.vigente_desde is
  'Día (Cancún) desde el que vale la tarifa: aplica a los vuelos con fecha >= este día.';
comment on column public.reserva_overhaul_vigencia.usd_hr_por_motor is
  'USD por hora POR MOTOR (0 = sin reserva desde ese día).';
comment on column public.reserva_overhaul_vigencia.motores is
  'Motores que aportan (Seneca = 2). El balance y el reparto multiplican por usd_hr_por_motor × motores.';
comment on column public.reserva_overhaul_vigencia.historial is
  'Tarifas anteriores de ESTA fecha (una entrada por corrección): {usd_hr_por_motor, motores, notas, hasta, cambio_por}.';

-- Una sola tarifa VIVA por avión y fecha.
create unique index if not exists uq_reserva_overhaul_vigencia_viva
  on public.reserva_overhaul_vigencia (aeronave_id, vigente_desde)
  where deleted_at is null;

create trigger trg_reserva_overhaul_vigencia_set_updated_at
  before update on public.reserva_overhaul_vigencia
  for each row execute function public.tg_set_updated_at();

alter table public.reserva_overhaul_vigencia enable row level security;

-- La tarifa que cada avión tiene HOY, «desde siempre»: los libros no se
-- mueven al aplicar. Por motor = suma ÷ motores (las filas de un avión
-- llevan la misma tarifa desde que la ficha manda, API 0.0.131).
insert into public.reserva_overhaul_vigencia
  (aeronave_id, vigente_desde, usd_hr_por_motor, motores, notas)
select
  r.aeronave_id,
  date '2026-01-01',
  round(sum(r.monto_por_hora_usd) / count(*), 2),
  count(*)::integer,
  'Tarifa que ya tenía el avión al crear las vigencias (10-nov-2026)'
from public.reserva_overhaul r
where not exists (
  select 1
    from public.reserva_overhaul_vigencia v
   where v.aeronave_id = r.aeronave_id
     and v.deleted_at is null
)
group by r.aeronave_id;

-- La copia debe reproducir EXACTO lo que multiplican hoy los libros (la suma
-- de las filas por motor). Si algún avión no cuadra, se cancela todo.
do $$
declare
  v_malas integer;
  v_faltan integer;
begin
  select count(*) into v_malas
    from (
      select r.aeronave_id, sum(r.monto_por_hora_usd) as total
        from public.reserva_overhaul r
       group by r.aeronave_id
    ) l
    join public.reserva_overhaul_vigencia v
      on v.aeronave_id = l.aeronave_id
     and v.vigente_desde = date '2026-01-01'
     and v.deleted_at is null
   where round(v.usd_hr_por_motor * v.motores, 2) <> round(l.total, 2);
  if v_malas > 0 then
    raise exception
      'RESERVA_VIGENCIA_BACKFILL: % avion(es) con motores de tarifa distinta: la tarifa por motor no reproduce la suma. Iguala las filas de reserva_overhaul de ese avion y vuelve a aplicar.',
      v_malas;
  end if;
  select count(distinct r.aeronave_id) into v_faltan
    from public.reserva_overhaul r
   where not exists (
     select 1
       from public.reserva_overhaul_vigencia v
      where v.aeronave_id = r.aeronave_id
        and v.deleted_at is null
   );
  if v_faltan > 0 then
    raise exception
      'RESERVA_VIGENCIA_BACKFILL: % avion(es) con tarifa en reserva_overhaul se quedaron sin vigencia.',
      v_faltan;
  end if;
end $$;
-- <<< CUERPO

-- Verificación (después de aplicar):
-- select a.matricula, v.vigente_desde, v.usd_hr_por_motor, v.motores,
--        v.usd_hr_por_motor * v.motores as usd_por_hora
--   from public.reserva_overhaul_vigencia v
--   join public.aeronave a on a.id = v.aeronave_id
--  where v.deleted_at is null
--  order by a.matricula, v.vigente_desde;
