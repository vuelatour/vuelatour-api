-- =====================================================================
-- 20261016000004_cierre_mes.sql — CIERRE DE MES FORMAL + VUELOS PENDIENTES
-- DE COBRO PASAN AL MES SIGUIENTE (16-oct-2026, API 0.0.88; invariante 89
-- del CLAUDE.md del API).
--
-- PEDIDO DEL CLIENTE: «Necesito una opción para cerrar el mes que no es el
-- corriente, para el mes anterior, y los vuelos que aún no se cobren se
-- marquen en el balance y se muevan para el siguiente mes hasta que se cobre
-- y complete.» Decisiones del 16-oct-2026: el vuelo pasa COMPLETO (venta,
-- gastos de eje vuelo y comisiones); las HORAS se quedan en su fecha real;
-- cobro parcial ⇒ pasa completo; los 5 de septiembre cobrados en octubre
-- pasan a octubre; mes cerrado = bloqueado para capturas; «Reabrir» solo
-- ADMIN.
--
-- QUÉ HACE (aditiva, idempotente; NINGUNA sentencia destructiva — las FK de
-- las tablas nuevas no llevan cláusula de borrado: un vuelo con un
-- diferimiento en la bitácora no se puede borrar físicamente, y hoy solo se
-- borran vuelos CANCELADOS sin cobros, que jamás se difieren):
--  1) vuelo.periodo_contable timestamptz NULL = medianoche Cancún del día 1
--     del mes contable al que se DIFIRIÓ el vuelo al cerrar un mes. null = el
--     vuelo cuenta en el mes de su fecha_vuelo (TODO lo de hoy). CHECK
--     vuelo_periodo_contable_dia1_chk (día 1 a las 00:00 Cancún). Lo escribe
--     SOLO el servicio de cierres del API (cerrar / reabrir).
--  2) vuelo.fecha_contable timestamptz GENERATED ALWAYS AS
--     (coalesce(periodo_contable, fecha_vuelo)) STORED + índice: la ÚNICA
--     expresión de «¿en qué mes cuenta este vuelo?» que filtran los lectores
--     de dinero (reparto, pre-cierre, balances, Libro Dinero, tableros).
--     Sin ningún cierre, fecha_contable = fecha_vuelo en TODAS las filas
--     ⇒ cada lector da byte a byte lo de hoy. Los 4 triggers de vuelo NO
--     cambian (trg_vuelo_calendar_sync es «UPDATE OF» columnas que no
--     incluyen periodo_contable).
--  3) public.cierre_mes (PK periodo = día 1 del mes): estado CERRADO |
--     REABIERTO, sellos de quién/cuándo cerró y reabrió (con motivo), número
--     de cierre (version) y los snapshots jsonb del cierre (pre-cierre,
--     reparto, utilidad por socio — la FUENTE de la cuenta corriente de los
--     socios para ese mes — y totales). RLS sin policies (la API usa la
--     service key). Trigger de updated_at (tg_set_updated_at, ya existe).
--  4) public.cierre_mes_vuelo: bitácora REVERSIBLE de cada diferimiento
--     (vuelo, origen, destino, valor previo de periodo_contable, montos y
--     motivo SIN_COBRO | COBRO_PARCIAL | COBRO_POSTERIOR, revertido_at/por).
--     «Reabrir» la recorre para regresar cada vuelo. RLS sin policies.
--  5) Verificación que aborta si algo no quedó.
--
-- SIN BACKFILL: todo vuelo arranca con periodo_contable = null.
-- `moneda` (ENUM) no se compara en este archivo.
--
-- DEPENDE de vuelo, usuario y tg_set_updated_at (base). El API 0.0.88 es
-- desplegable ANTES o DESPUÉS: sondea vuelo.periodo_contable
-- (common/cierre-mes-disponible.util); sin la columna se comporta como
-- 0.0.87 (lectores por fecha_vuelo, GET /v1/cierres ⇒ disponible:false,
-- escrituras ⇒ 503 CIERRE_NO_DISPONIBLE, sin candado MES_CERRADO). OJO: el
-- «sí» de la sonda se memoriza — tras un ROLLBACK hay que reiniciar el API.
-- Con la migración y el API 0.0.87 no cambia nada (columnas nulas que nadie
-- lee; nadie puede cerrar).
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar el proyecto con un
-- SELECT antes):
--  a) DRY-RUN con mcp__supabase__execute_sql: el bloque «do $dry$ … $dry$;»
--     del archivo dryrun-mcp.sql del paquete. Debe terminar en ERROR
--     «DRYRUN_OK 20261016000004 …». Cualquier otro error ⇒ NO aplicar.
--  b) mcp__supabase__apply_migration con name «20261016000004_cierre_mes» y
--     query = SOLO el cuerpo entre «>>> CUERPO» y «<<< CUERPO».
--  c) Postcheck por SELECT: columnas, CHECK, índice, tablas, RLS y
--     `select count(*) from vuelo where periodo_contable is not null` = 0;
--     get_advisors (esperado: solo el INFO «RLS sin policies» de siempre,
--     ahora también para cierre_mes y cierre_mes_vuelo).
--
-- PLAN B (si a) o b) responden {"status":"declined"}), SQL Editor:
--  B1) Pegar el DRY-RUN y ejecutar: debe terminar en «DRYRUN_OK …».
--  B2) En UNA corrida:
--        begin;
--        <el CUERPO entre «>>> CUERPO» y «<<< CUERPO», tal cual>
--        insert into supabase_migrations.schema_migrations (version, name, statements)
--        values ('20261016000004', 'cierre_mes',
--                array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261016000004_cierre_mes.sql'])
--        on conflict (version) do nothing;
--        commit;
--  B3) Postcheck por MCP y get_advisors.
--
-- ROLLBACK (SOLO desde el SQL Editor y SOLO si ningún mes se cerró; REINICIAR
-- el API después): retirar, con la sentencia de retiro de objetos que este
-- archivo no escribe (el MCP la rechaza incluso en comentarios), en este
-- orden: la tabla cierre_mes_vuelo, el trigger trg_cierre_mes_set_updated_at
-- y la tabla cierre_mes, el índice idx_vuelo_fecha_contable, el índice
-- idx_vuelo_periodo_contable, la columna vuelo.fecha_contable, el CHECK
-- vuelo_periodo_contable_dia1_chk y la columna vuelo.periodo_contable. Si ya
-- hubo cierres: primero «Reabrir» cada mes desde el panel (regresa los
-- vuelos) y verificar `count(*) from vuelo where periodo_contable is not
-- null` = 0.
-- =====================================================================

-- >>> CUERPO
-- ===========================================================================
-- 1) vuelo.periodo_contable — mes contable al que se DIFIRIÓ el vuelo
-- ===========================================================================
alter table public.vuelo
  add column if not exists periodo_contable timestamptz null;

comment on column public.vuelo.periodo_contable is
  'Medianoche Cancún del día 1 del mes contable al que se DIFIRIÓ el vuelo al cerrar un mes con su cobro pendiente (20261016000004, API 0.0.88, invariante 89). null = el vuelo cuenta en el mes de su fecha_vuelo. Lo escriben SOLO cerrar/reabrir mes del API; la bitácora vive en cierre_mes_vuelo.';

do $chk$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.vuelo'::regclass
       and conname = 'vuelo_periodo_contable_dia1_chk'
  ) then
    alter table public.vuelo
      add constraint vuelo_periodo_contable_dia1_chk
      check (
        periodo_contable is null
        or (periodo_contable at time zone 'America/Cancun')
           = date_trunc('month', periodo_contable at time zone 'America/Cancun')
      );
  end if;
end $chk$;

-- ===========================================================================
-- 2) vuelo.fecha_contable — LA expresión del mes contable (generada, STORED)
-- ===========================================================================
alter table public.vuelo
  add column if not exists fecha_contable timestamptz
    generated always as (coalesce(periodo_contable, fecha_vuelo)) stored;

comment on column public.vuelo.fecha_contable is
  'coalesce(periodo_contable, fecha_vuelo) (GENERADA, 20261016000004): el eje de los lectores de DINERO (reparto, pre-cierre, balances, Libro Dinero, tableros). Las HORAS y todo lo operativo siguen por fecha_vuelo. Un vuelo diferido a octubre vale 2026-10-01 00:00 Cancún.';

create index if not exists idx_vuelo_fecha_contable
  on public.vuelo (fecha_contable);

create index if not exists idx_vuelo_periodo_contable
  on public.vuelo (periodo_contable)
  where periodo_contable is not null;

-- ===========================================================================
-- 3) cierre_mes — un renglón por mes cerrado (o reabierto)
-- ===========================================================================
create table if not exists public.cierre_mes (
  periodo date primary key,
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
  constraint cierre_mes_periodo_dia1_chk
    check (extract(day from periodo) = 1),
  constraint cierre_mes_estado_chk
    check (estado in ('CERRADO', 'REABIERTO')),
  constraint cierre_mes_version_chk
    check (version >= 1),
  constraint cierre_mes_reabierto_motivo_chk
    check (
      estado <> 'REABIERTO'
      or (reabierto_motivo is not null
          and char_length(btrim(reabierto_motivo)) between 5 and 300)
    )
);

comment on table public.cierre_mes is
  'Cierre formal de un mes (20261016000004, API 0.0.88, invariante 89). estado = CERRADO es la ÚNICA verdad de «mes cerrado» (candado 409 MES_CERRADO de capturas). Reabrir conserva la fila (REABIERTO + sellos); cerrar de nuevo la actualiza (version + 1, snapshots nuevos). socios_snapshot es la utilidad del mes por socio que lee la cuenta corriente de los socios (congelada al cerrar).';

do $trg$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.cierre_mes'::regclass
       and tgname = 'trg_cierre_mes_set_updated_at'
  ) then
    create trigger trg_cierre_mes_set_updated_at
      before update on public.cierre_mes
      for each row execute function public.tg_set_updated_at();
  end if;
end $trg$;

alter table public.cierre_mes enable row level security;

-- ===========================================================================
-- 4) cierre_mes_vuelo — bitácora REVERSIBLE de los diferimientos
-- ===========================================================================
create table if not exists public.cierre_mes_vuelo (
  id uuid primary key default gen_random_uuid(),
  periodo date not null references public.cierre_mes(periodo),
  cierre_version integer not null,
  vuelo_id uuid not null references public.vuelo(id),
  periodo_origen date not null,
  periodo_destino date not null,
  periodo_contable_anterior timestamptz null,
  folio bigint not null,
  cliente text null,
  aeronave_id uuid null,
  matricula text null,
  venta_usd numeric(14,2) not null,
  cobrado_usd numeric(14,2) not null,
  por_cobrar_usd numeric(14,2) not null,
  motivo text not null,
  revertido_at timestamptz null,
  revertido_por uuid null references public.usuario(id),
  created_at timestamptz not null default now(),
  created_by uuid null references public.usuario(id),
  constraint cierre_mes_vuelo_unico unique (periodo, cierre_version, vuelo_id),
  constraint cierre_mes_vuelo_motivo_chk
    check (motivo in ('SIN_COBRO', 'COBRO_PARCIAL', 'COBRO_POSTERIOR')),
  constraint cierre_mes_vuelo_destino_chk
    check (periodo_destino > periodo_origen
           and extract(day from periodo_origen) = 1
           and extract(day from periodo_destino) = 1)
);

comment on table public.cierre_mes_vuelo is
  'Bitácora de cada vuelo que un cierre de mes pasó al mes siguiente (20261016000004): origen/destino, valor previo de vuelo.periodo_contable (para revertir EXACTO al reabrir), montos al corte y motivo. revertido_at/por = lo regresó un «Reabrir».';

create index if not exists idx_cierre_mes_vuelo_vuelo
  on public.cierre_mes_vuelo (vuelo_id);

alter table public.cierre_mes_vuelo enable row level security;

-- ===========================================================================
-- 5) Verificación (aborta la migración si algo no quedó)
-- ===========================================================================
do $ver$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'vuelo'
                    and column_name = 'periodo_contable'
                    and data_type = 'timestamp with time zone') then
    raise exception 'VERIFICACIÓN 20261016000004: falta vuelo.periodo_contable (timestamptz)';
  end if;
  if not exists (select 1 from pg_attribute
                  where attrelid = 'public.vuelo'::regclass
                    and attname = 'fecha_contable' and attgenerated = 's') then
    raise exception 'VERIFICACIÓN 20261016000004: falta vuelo.fecha_contable GENERADA STORED';
  end if;
  if to_regclass('public.idx_vuelo_fecha_contable') is null then
    raise exception 'VERIFICACIÓN 20261016000004: falta el índice idx_vuelo_fecha_contable';
  end if;
  if not exists (select 1 from pg_constraint
                  where conrelid = 'public.vuelo'::regclass
                    and conname = 'vuelo_periodo_contable_dia1_chk') then
    raise exception 'VERIFICACIÓN 20261016000004: falta el CHECK vuelo_periodo_contable_dia1_chk';
  end if;
  if to_regclass('public.cierre_mes') is null
     or to_regclass('public.cierre_mes_vuelo') is null then
    raise exception 'VERIFICACIÓN 20261016000004: faltan las tablas cierre_mes / cierre_mes_vuelo';
  end if;
  if exists (select 1 from pg_class
              where oid in ('public.cierre_mes'::regclass, 'public.cierre_mes_vuelo'::regclass)
                and not relrowsecurity) then
    raise exception 'VERIFICACIÓN 20261016000004: RLS no quedó habilitado en las tablas del cierre';
  end if;
  if exists (select 1 from public.vuelo
              where fecha_contable is distinct from coalesce(periodo_contable, fecha_vuelo)) then
    raise exception 'VERIFICACIÓN 20261016000004: fecha_contable ≠ coalesce(periodo_contable, fecha_vuelo) en algún vuelo';
  end if;
end $ver$;
-- <<< CUERPO
