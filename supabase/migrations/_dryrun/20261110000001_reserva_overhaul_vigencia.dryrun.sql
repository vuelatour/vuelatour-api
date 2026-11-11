-- 20261110000001_reserva_overhaul_vigencia — GENERADO por armar.py (no editar a mano).
-- Proyecto PROD: bjesduasnzbzywofukbf (confirmar el ref en la URL del SQL Editor).
-- DRY-RUN: corre la migración y pruebas con escrituras REALES y lo revierte
-- TODO. Debe terminar en ERROR con el texto «DRYRUN_OK: …». Cualquier otro
-- error ⇒ NO aplicar y avisar.

begin;

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

-- ───────────── PRUEBAS (escrituras REALES; todo se revierte al final) ─────────────
-- Las filas de prueba se insertan DESPUÉS del DDL (regla del workspace).
do $t$
declare
  v_avion uuid;
  v_id uuid;
  v_id2 uuid;
  v_n_legado integer;
  v_n_copiadas integer;
  v_malas integer;
  v_rls boolean;
  v_trg integer;
  v_rechazo boolean;
  v_hist jsonb;
  v_antes integer;
begin
  -- T0: «ningún número cambia al aplicar» depende de que NO haya horas
  -- voladas antes del 01/01/2026 (la fecha de la copia «desde siempre»): un
  -- vuelo anterior se quedaría sin tarifa y su reserva bajaría a $0.
  select count(distinct v.id) into v_antes
    from public.vuelo v
    join public.escala e on e.vuelo_id = v.id
   where v.fecha_vuelo < timestamptz '2026-01-01 00:00:00-05'
     and v.estado::text <> 'CANCELADO'
     and e.cancelada_at is null
     and e.taco_salida is not null
     and e.taco_llegada is not null;
  if v_antes > 0 then
    raise exception 'DRYRUN T0: % vuelo(s) con horas voladas antes del 01/01/2026: la tarifa copiada «desde siempre» no los cubre y su reserva cambiaría. NO aplicar: avisar.', v_antes;
  end if;

  -- T1: la copia «desde siempre» — una tarifa por avión con tarifa en
  -- reserva_overhaul, y por motor × motores = la suma de sus filas.
  select count(distinct aeronave_id) into v_n_legado from public.reserva_overhaul;
  select count(*) into v_n_copiadas
    from public.reserva_overhaul_vigencia
   where vigente_desde = date '2026-01-01' and deleted_at is null;
  if v_n_copiadas <> v_n_legado then
    raise exception 'DRYRUN T1: % aviones con tarifa y % copiadas', v_n_legado, v_n_copiadas;
  end if;
  select count(*) into v_malas
    from (
      select r.aeronave_id, sum(r.monto_por_hora_usd) as total
        from public.reserva_overhaul r group by r.aeronave_id
    ) l
    join public.reserva_overhaul_vigencia v
      on v.aeronave_id = l.aeronave_id and v.deleted_at is null
   where round(v.usd_hr_por_motor * v.motores, 2) <> round(l.total, 2);
  if v_malas > 0 then
    raise exception 'DRYRUN T1: % avion(es) cuya copia no reproduce la suma', v_malas;
  end if;

  -- Un avión cualquiera para las escrituras de prueba.
  select id into v_avion from public.aeronave order by matricula limit 1;
  if v_avion is null then
    raise exception 'DRYRUN: no hay aviones para probar';
  end if;

  -- T2: alta de una tarifa «a partir de» (INSERT real) y su corrección
  -- (UPDATE real: pasa por el trigger de updated_at y guarda el historial).
  insert into public.reserva_overhaul_vigencia
    (aeronave_id, vigente_desde, usd_hr_por_motor, motores, notas)
  values (v_avion, date '2099-01-01', 55, 2, 'prueba dry-run')
  returning id into v_id;
  update public.reserva_overhaul_vigencia
     set usd_hr_por_motor = 60,
         historial = historial || jsonb_build_array(
           jsonb_build_object('usd_hr_por_motor', 55, 'motores', 2))
   where id = v_id;
  select historial into v_hist from public.reserva_overhaul_vigencia where id = v_id;
  if jsonb_array_length(v_hist) <> 1 then
    raise exception 'DRYRUN T2: el historial no guardó la tarifa anterior (%)', v_hist;
  end if;

  -- T3: dos tarifas VIVAS del mismo avión y día ⇒ rechazada.
  v_rechazo := false;
  begin
    insert into public.reserva_overhaul_vigencia
      (aeronave_id, vigente_desde, usd_hr_por_motor, motores)
    values (v_avion, date '2099-01-01', 70, 2);
  exception when unique_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T3: se aceptaron dos tarifas vivas del mismo día';
  end if;

  -- T4: baja con sello (no se borra la fila) y entonces SÍ se puede capturar
  -- otra tarifa para ese mismo día.
  update public.reserva_overhaul_vigencia set deleted_at = now() where id = v_id;
  insert into public.reserva_overhaul_vigencia
    (aeronave_id, vigente_desde, usd_hr_por_motor, motores)
  values (v_avion, date '2099-01-01', 70, 2)
  returning id into v_id2;
  if v_id2 is null then
    raise exception 'DRYRUN T4: no se pudo recapturar la tarifa tras la baja';
  end if;

  -- T5: tarifa negativa y motores en 0 ⇒ rechazadas; tarifa 0 ⇒ aceptada
  -- (= sin reserva desde ese día).
  v_rechazo := false;
  begin
    insert into public.reserva_overhaul_vigencia
      (aeronave_id, vigente_desde, usd_hr_por_motor, motores)
    values (v_avion, date '2099-02-01', -1, 2);
  exception when check_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T5: se aceptó una tarifa negativa';
  end if;
  v_rechazo := false;
  begin
    insert into public.reserva_overhaul_vigencia
      (aeronave_id, vigente_desde, usd_hr_por_motor, motores)
    values (v_avion, date '2099-02-01', 55, 0);
  exception when check_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T5: se aceptaron 0 motores';
  end if;
  insert into public.reserva_overhaul_vigencia
    (aeronave_id, vigente_desde, usd_hr_por_motor, motores)
  values (v_avion, date '2099-03-01', 0, 1);

  -- T6: RLS encendido y el trigger de updated_at en su lugar.
  select relrowsecurity into v_rls
    from pg_class where oid = 'public.reserva_overhaul_vigencia'::regclass;
  select count(*) into v_trg
    from pg_trigger
   where tgrelid = 'public.reserva_overhaul_vigencia'::regclass
     and tgname = 'trg_reserva_overhaul_vigencia_set_updated_at';
  if not coalesce(v_rls, false) or v_trg <> 1 then
    raise exception 'DRYRUN T6: RLS % · trigger %', v_rls, v_trg;
  end if;

  raise exception 'DRYRUN_OK: % tarifas copiadas «desde siempre», sin vuelos anteriores al 01/01/2026, alta, corrección, baja y candados correctos (todo revertido)', v_n_copiadas;
end $t$;

rollback;
