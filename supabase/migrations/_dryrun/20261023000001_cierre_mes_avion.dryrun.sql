-- =====================================================================
-- DRY-RUN de 20261023000001_cierre_mes_avion.sql — NO ES UNA MIGRACIÓN.
-- Vive en `supabase/migrations/_dryrun/` (subcarpeta que el CLI de Supabase
-- NO recorre) para que ni `supabase db push` ni `apply_migration` lo tomen.
--
-- Cómo correrlo: UNA sentencia por mcp__supabase__execute_sql (o pegado en el
-- SQL Editor) en el proyecto bjesduasnzbzywofukbf. Termina SIEMPRE en
-- `raise exception` ⇒ todo se revierte. Resultado esperado: el error
-- «DRYRUN_OK 20261023000001 · …». Cualquier otro error ⇒ NO aplicar.
--
-- Orden (regla del CLAUDE.md del workspace): cuerpo (DDL) → filas de prueba
-- DESPUÉS del DDL → pruebas con INSERT/UPDATE REALES → DRYRUN_OK. Sin DROP,
-- DELETE ni REVOKE (el MCP los rechaza): las filas de prueba se van con el
-- rollback del `raise exception`.
-- =====================================================================

do $dry$
declare
  v_av uuid;
  v_vuelo uuid;
  v_user uuid;
  v_updated_1 timestamptz;
  v_updated_2 timestamptz;
  v_n integer;
  v_estado text;
begin
  -- A) Precondiciones: la migración del cierre (20261016000004) está y las
  --    tablas nuevas todavía NO (si ya existen, la migración es idempotente
  --    pero este dry-run no tiene sentido).
  if to_regclass('public.cierre_mes') is null then
    raise exception 'DRYRUN_FALLA A: falta cierre_mes (migración 20261016000004)';
  end if;
  if to_regclass('public.cierre_mes_avion') is not null then
    raise exception 'DRYRUN_FALLA A2: cierre_mes_avion ya existe (¿migración ya aplicada?)';
  end if;

  -- B) >>> CUERPO de 20261023000001_cierre_mes_avion.sql, tal cual
  create table if not exists public.cierre_mes_avion (
    periodo date not null,
    aeronave_id uuid not null references public.aeronave(id),
    estado text not null default 'CERRADO',
    cerrado_at timestamptz not null default now(),
    cerrado_por uuid null references public.usuario(id),
    reabierto_at timestamptz null,
    reabierto_por uuid null references public.usuario(id),
    reabierto_motivo text null,
    version integer not null default 1,
    precierre_snapshot jsonb not null default '{}'::jsonb,
    reparto_snapshot jsonb not null default '{}'::jsonb,
    socios_snapshot jsonb not null default '{}'::jsonb,
    totales jsonb not null default '{}'::jsonb,
    created_at timestamptz not null default now(),
    updated_at timestamptz not null default now(),
    constraint cierre_mes_avion_pkey primary key (periodo, aeronave_id),
    constraint cierre_mes_avion_periodo_dia1_chk
      check (extract(day from periodo) = 1),
    constraint cierre_mes_avion_estado_chk
      check (estado in ('CERRADO', 'REABIERTO')),
    constraint cierre_mes_avion_version_chk
      check (version >= 1),
    constraint cierre_mes_avion_reabierto_motivo_chk
      check (
        reabierto_motivo is null
        or char_length(btrim(reabierto_motivo)) between 5 and 300
      )
  );

  comment on table public.cierre_mes_avion is
    'Cierre formal de UN avión en UN mes (20261023000001, API 0.0.104, invariante 105). estado = CERRADO es la verdad de «este avión está cerrado en este mes» (candado 409 MES_CERRADO de las capturas que lo tocan). Reabrir conserva la fila (REABIERTO + sellos); cerrar de nuevo la actualiza (version + 1, snapshots nuevos). La fila global cierre_mes del mes es DERIVADA: la escribe el API cuando el último avión activo queda cerrado.';

  comment on column public.cierre_mes_avion.precierre_snapshot is
    'Renglones bloqueantes del pre-cierre evaluados al cerrar: los «sin avión» (globales) + los atribuibles a este avión.';
  comment on column public.cierre_mes_avion.reparto_snapshot is
    'EL avión de despues.aviones[] del reparto simulado sin sus vuelos diferidos (compute con excluirVuelos) — su cascada congelada.';
  comment on column public.cierre_mes_avion.socios_snapshot is
    'Utilidad por socio de ESTE avión en el mes (aeronave, reparto_porcentaje_total, socios[] {socio_id, porcentaje, monto_mxn}): la cuenta corriente la lee congelada.';
  comment on column public.cierre_mes_avion.totales is
    'vuelos, vuelos_diferidos, diferidos_venta_usd, diferidos_cobrado_usd, diferidos_por_cobrar_usd, saldo_usd, saldo_mxn, vuelos_incluidos, incluidos[] {id, folio, cobrado_posterior_usd, fecha_cobro_posterior}.';

  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.cierre_mes_avion'::regclass
       and tgname = 'trg_cierre_mes_avion_set_updated_at'
  ) then
    create trigger trg_cierre_mes_avion_set_updated_at
      before update on public.cierre_mes_avion
      for each row execute function public.tg_set_updated_at();
  end if;

  alter table public.cierre_mes_avion enable row level security;

  create table if not exists public.cierre_mes_avion_vuelo (
    id uuid primary key default gen_random_uuid(),
    periodo date not null,
    aeronave_id uuid not null,
    cierre_version integer not null,
    vuelo_id uuid not null references public.vuelo(id),
    periodo_origen date not null,
    periodo_destino date not null,
    periodo_contable_anterior timestamptz null,
    folio bigint null,
    cliente text null,
    vuelo_aeronave_id uuid null,
    matricula text null,
    venta_usd numeric(14,2) null,
    cobrado_usd numeric(14,2) null,
    por_cobrar_usd numeric(14,2) null,
    motivo text not null,
    revertido_at timestamptz null,
    revertido_por uuid null references public.usuario(id),
    created_at timestamptz not null default now(),
    created_by uuid null references public.usuario(id),
    constraint cierre_mes_avion_vuelo_cierre_fkey
      foreign key (periodo, aeronave_id)
      references public.cierre_mes_avion(periodo, aeronave_id),
    constraint cierre_mes_avion_vuelo_unico
      unique (periodo, aeronave_id, cierre_version, vuelo_id),
    constraint cierre_mes_avion_vuelo_motivo_chk
      check (motivo in ('SIN_COBRO', 'COBRO_PARCIAL', 'COBRO_POSTERIOR')),
    constraint cierre_mes_avion_vuelo_destino_chk
      check (periodo_destino > periodo_origen
             and extract(day from periodo_origen) = 1
             and extract(day from periodo_destino) = 1)
  );

  comment on table public.cierre_mes_avion_vuelo is
    'Bitácora de cada vuelo que el cierre de UN avión pasó al mes siguiente (20261023000001, invariante 105): aeronave_id = el avión que CERRÓ (en un vuelo multi-avión puede ser el secundario: el primero que cierra decide por el vuelo entero), vuelo_aeronave_id = el avión principal del vuelo, origen/destino, valor previo de vuelo.periodo_contable (para revertir EXACTO al reabrir ese avión), montos al corte y motivo. revertido_at/por = lo regresó un «Reabrir».';

  create index if not exists idx_cierre_mes_avion_vuelo_vuelo
    on public.cierre_mes_avion_vuelo (vuelo_id);

  alter table public.cierre_mes_avion_vuelo enable row level security;

  comment on table public.cierre_mes_vuelo is
    'LEGADO desde el 23-oct-2026 (invariante 105): la bitácora viva es cierre_mes_avion_vuelo. Sin filas en prod. El lector del API la sigue leyendo por compatibilidad (unión con la viva).';

  comment on table public.cierre_mes is
    'Cierre formal de un mes (20261016000004, API 0.0.88, invariante 89). Desde el 23-oct-2026 (invariante 105) la fila es DERIVADA del cierre por avión (cierre_mes_avion): el API la escribe CERRADO cuando el último avión activo del mes queda cerrado y REABIERTO cuando cualquier avión se reabre con la flota cerrada. estado = CERRADO sigue siendo la verdad de «toda la flota está cerrada» para los lectores globales (candado de registros sin avión, AFAC editable, grupos, Dinero, balance general). socios_snapshot / reparto_snapshot / totales = agregado de las filas por avión.';

  if to_regclass('public.cierre_mes_avion') is null
     or to_regclass('public.cierre_mes_avion_vuelo') is null then
    raise exception 'VERIFICACIÓN 20261023000001: faltan las tablas cierre_mes_avion / cierre_mes_avion_vuelo';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cierre_mes_avion'::regclass
                    and conname = 'cierre_mes_avion_pkey'
                    and contype = 'p') then
    raise exception 'VERIFICACIÓN 20261023000001: falta la PK (periodo, aeronave_id) de cierre_mes_avion';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.cierre_mes_avion_vuelo'::regclass
                    and conname = 'cierre_mes_avion_vuelo_unico') then
    raise exception 'VERIFICACIÓN 20261023000001: falta el UNIQUE de cierre_mes_avion_vuelo';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.cierre_mes_avion'::regclass
                    and tgname = 'trg_cierre_mes_avion_set_updated_at') then
    raise exception 'VERIFICACIÓN 20261023000001: falta el trigger de updated_at de cierre_mes_avion';
  end if;
  if to_regclass('public.idx_cierre_mes_avion_vuelo_vuelo') is null then
    raise exception 'VERIFICACIÓN 20261023000001: falta el índice idx_cierre_mes_avion_vuelo_vuelo';
  end if;
  if exists (select 1 from pg_class
              where oid in ('public.cierre_mes_avion'::regclass,
                            'public.cierre_mes_avion_vuelo'::regclass)
                and not relrowsecurity) then
    raise exception 'VERIFICACIÓN 20261023000001: RLS no quedó habilitado en las tablas del cierre por avión';
  end if;
  -- <<< CUERPO

  -- C) Filas de prueba DESPUÉS del DDL (se van con el rollback final).
  select id into v_av from public.aeronave order by matricula limit 1;
  select id into v_vuelo from public.vuelo order by created_at limit 1;
  select id into v_user from public.usuario order by created_at limit 1;
  if v_av is null or v_vuelo is null then
    raise exception 'DRYRUN_FALLA C: no hay aeronave o vuelo para probar';
  end if;

  -- C1) Insert de un cierre de avión en un periodo sintético (año 2000).
  insert into public.cierre_mes_avion (periodo, aeronave_id, cerrado_por, totales)
  values ('2000-01-01', v_av, v_user, '{"vuelos": 0}'::jsonb);
  select updated_at into v_updated_1
    from public.cierre_mes_avion where periodo = '2000-01-01' and aeronave_id = v_av;

  -- C2) PK: el mismo (periodo, aeronave) ⇒ 23505.
  begin
    insert into public.cierre_mes_avion (periodo, aeronave_id) values ('2000-01-01', v_av);
    raise exception 'DRYRUN_FALLA C2: aceptó dos cierres del mismo avión en el mismo mes';
  exception when unique_violation then null;
  end;

  -- C3) CHECK día 1.
  begin
    insert into public.cierre_mes_avion (periodo, aeronave_id) values ('2000-02-15', v_av);
    raise exception 'DRYRUN_FALLA C3: aceptó un periodo que no es día 1';
  exception when check_violation then null;
  end;

  -- C4) CHECK estado.
  begin
    update public.cierre_mes_avion set estado = 'ABIERTO'
     where periodo = '2000-01-01' and aeronave_id = v_av;
    raise exception 'DRYRUN_FALLA C4: aceptó estado ABIERTO';
  exception when check_violation then null;
  end;

  -- C5) CHECK motivo corto.
  begin
    update public.cierre_mes_avion set reabierto_motivo = 'ab'
     where periodo = '2000-01-01' and aeronave_id = v_av;
    raise exception 'DRYRUN_FALLA C5: aceptó un motivo de 2 caracteres';
  exception when check_violation then null;
  end;

  -- C6) UPDATE real REABIERTO (CAS como el API) + trigger updated_at.
  perform pg_sleep(0.01);
  update public.cierre_mes_avion
     set estado = 'REABIERTO', reabierto_at = now(), reabierto_por = v_user,
         reabierto_motivo = 'dry-run: prueba de reapertura'
   where periodo = '2000-01-01' and aeronave_id = v_av
     and estado = 'CERRADO' and version = 1;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'DRYRUN_FALLA C6: el CAS CERRADO→REABIERTO no tocó 1 fila (tocó %)', v_n;
  end if;
  select updated_at, estado into v_updated_2, v_estado
    from public.cierre_mes_avion where periodo = '2000-01-01' and aeronave_id = v_av;
  if v_estado <> 'REABIERTO' then
    raise exception 'DRYRUN_FALLA C6b: el estado no quedó REABIERTO';
  end if;
  if v_updated_2 <= v_updated_1 then
    raise exception 'DRYRUN_FALLA C6c: el trigger de updated_at no corrió (% → %)', v_updated_1, v_updated_2;
  end if;

  -- C7) Volver a cerrar: version + 1 (CAS por REABIERTO y version 1).
  update public.cierre_mes_avion
     set estado = 'CERRADO', cerrado_at = now(), version = 2
   where periodo = '2000-01-01' and aeronave_id = v_av
     and estado = 'REABIERTO' and version = 1;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'DRYRUN_FALLA C7: el CAS REABIERTO→CERRADO no tocó 1 fila';
  end if;

  -- D) Bitácora: insert real, UNIQUE, CHECK destino, FK al cierre.
  insert into public.cierre_mes_avion_vuelo
    (periodo, aeronave_id, cierre_version, vuelo_id, periodo_origen, periodo_destino,
     periodo_contable_anterior, folio, vuelo_aeronave_id, venta_usd, cobrado_usd,
     por_cobrar_usd, motivo, created_by)
  values ('2000-01-01', v_av, 2, v_vuelo, '2000-01-01', '2000-02-01',
          null, 1, v_av, 100.00, 0, 100.00, 'SIN_COBRO', v_user);

  begin
    insert into public.cierre_mes_avion_vuelo
      (periodo, aeronave_id, cierre_version, vuelo_id, periodo_origen, periodo_destino, motivo)
    values ('2000-01-01', v_av, 2, v_vuelo, '2000-01-01', '2000-02-01', 'SIN_COBRO');
    raise exception 'DRYRUN_FALLA D1: aceptó dos bitácoras del mismo vuelo en el mismo cierre';
  exception when unique_violation then null;
  end;

  begin
    insert into public.cierre_mes_avion_vuelo
      (periodo, aeronave_id, cierre_version, vuelo_id, periodo_origen, periodo_destino, motivo)
    values ('2000-01-01', v_av, 3, v_vuelo, '2000-02-01', '2000-01-01', 'SIN_COBRO');
    raise exception 'DRYRUN_FALLA D2: aceptó destino ≤ origen';
  exception when check_violation then null;
  end;

  begin
    insert into public.cierre_mes_avion_vuelo
      (periodo, aeronave_id, cierre_version, vuelo_id, periodo_origen, periodo_destino, motivo)
    values ('2000-01-01', v_av, 3, v_vuelo, '2000-01-01', '2000-02-01', 'OTRO');
    raise exception 'DRYRUN_FALLA D3: aceptó un motivo fuera del catálogo';
  exception when check_violation then null;
  end;

  begin
    insert into public.cierre_mes_avion_vuelo
      (periodo, aeronave_id, cierre_version, vuelo_id, periodo_origen, periodo_destino, motivo)
    values ('2000-03-01', v_av, 1, v_vuelo, '2000-03-01', '2000-04-01', 'SIN_COBRO');
    raise exception 'DRYRUN_FALLA D4: aceptó una bitácora sin cierre de avión (FK)';
  exception when foreign_key_violation then null;
  end;

  -- D5) Revertir (UPDATE real, como «Reabrir»).
  update public.cierre_mes_avion_vuelo
     set revertido_at = now(), revertido_por = v_user
   where periodo = '2000-01-01' and aeronave_id = v_av and cierre_version = 2
     and vuelo_id = v_vuelo and revertido_at is null;
  get diagnostics v_n = row_count;
  if v_n <> 1 then
    raise exception 'DRYRUN_FALLA D5: la reversión de la bitácora no tocó 1 fila';
  end if;

  -- E) Informativo: cuántas filas globales hay (en prod, 0 al 23-oct-2026).
  --    Nada de este dry-run las toca; si hubiera alguna, el API la trata
  --    como cierre global vigente (sin filas por avión) hasta que se reabra.
  raise notice 'cierre_mes tiene % fila(s) y cierre_mes_vuelo % fila(s)',
    (select count(*) from public.cierre_mes),
    (select count(*) from public.cierre_mes_vuelo);

  raise exception 'DRYRUN_OK 20261023000001 · tablas + PK + CHECKs + UNIQUE + FK + trigger updated_at + RLS (todo revertido)';
end $dry$;
