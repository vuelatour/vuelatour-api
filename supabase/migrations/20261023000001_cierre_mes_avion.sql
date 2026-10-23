-- =====================================================================
-- 20261023000001_cierre_mes_avion.sql — CIERRE DE MES POR AVIÓN
-- (23-oct-2026, API 0.0.104; invariante 105 del CLAUDE.md del API).
--
-- PEDIDO DEL CLIENTE (23-oct-2026, con capturas de /admin/reportes):
-- «eliminar la burbuja independiente de cierre de mes, y poner un botón de
-- cierre de mes individual en cada avión».
--
-- HECHOS DE PRODUCCIÓN (verificados por SQL el 23-oct-2026): `cierre_mes`
-- VACÍA (ningún mes cerrado nunca), `cierre_mes_vuelo` vacía, 0 vuelos con
-- `periodo_contable`, 7 aviones activos de 8. ⇒ NO hay datos que migrar.
--
-- QUÉ HACE (aditiva, idempotente; NINGUNA sentencia destructiva — ni DROP,
-- ni DELETE, ni REVOKE: el MCP de Supabase las rechaza):
--  1) public.cierre_mes_avion (PK periodo + aeronave_id): el cierre de UN
--     avión en UN mes. estado CERRADO | REABIERTO, sellos de quién/cuándo
--     cerró y reabrió (motivo 5–300), version (CAS como `cierre_mes`) y los
--     snapshots jsonb de ESE avión: precierre_snapshot (los renglones
--     bloqueantes evaluados: globales + del avión), reparto_snapshot (EL
--     avión de `despues.aviones[]` del reparto simulado sin sus diferidos),
--     socios_snapshot (utilidad por socio de ESE avión) y totales (vuelos,
--     diferidos, saldo, incluidos). RLS sin policies (la API usa la service
--     key). Trigger de updated_at (tg_set_updated_at, ya existe).
--  2) public.cierre_mes_avion_vuelo: bitácora REVERSIBLE de los vuelos que
--     el cierre de UN avión pasó al mes siguiente (`aeronave_id` = el avión
--     que CERRÓ, que en un vuelo multi-avión puede ser el secundario;
--     `vuelo_aeronave_id` = el avión principal del vuelo). «Reabrir» ese
--     avión la recorre para regresar cada vuelo. RLS sin policies.
--  3) `cierre_mes` (la fila global del mes) se vuelve DERIVADA: la escribe
--     el API cuando el ÚLTIMO avión activo del mes queda cerrado y pasa a
--     REABIERTO cuando cualquier avión se reabre con la flota cerrada.
--     NO cambia de forma: ningún lector global se toca. `cierre_mes_vuelo`
--     queda como LEGADO (sin filas en prod): la bitácora viva es la 2).
--  4) Verificación que aborta si algo no quedó.
--
-- SIN BACKFILL (no hay datos). `moneda` (ENUM) no se compara aquí.
--
-- DEPENDE de aeronave, vuelo, usuario y tg_set_updated_at (base) y de
-- 20261016000004 (cierre_mes, periodo_contable). El API 0.0.104 es
-- desplegable ANTES o DESPUÉS: sondea `cierre_mes_avion.periodo`
-- (common/cierre-mes-disponible.util#cierrePorAvionDisponible); sin la tabla
-- responde como el 0.0.103 (cierre global de toda la flota, `GET /v1/cierres`
-- ⇒ `por_avion: false`). OJO: el «sí» de la sonda se memoriza — tras un
-- ROLLBACK hay que reiniciar el API. Con la migración y el API 0.0.103 no
-- cambia nada (tablas vacías que nadie lee).
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar el proyecto con un
-- SELECT antes):
--  a) DRY-RUN con mcp__supabase__execute_sql: el bloque «do $dry$ … $dry$;»
--     de supabase/migrations/_dryrun/20261023000001_cierre_mes_avion.dryrun.sql
--     (NO es una migración: vive fuera de la carpeta que el CLI recorre).
--     Debe terminar en ERROR «DRYRUN_OK 20261023000001 …». Cualquier otro
--     error ⇒ NO aplicar.
--  b) mcp__supabase__apply_migration con name
--     «20261023000001_cierre_mes_avion» y query = SOLO el cuerpo entre
--     «>>> CUERPO» y «<<< CUERPO».
--  c) Postcheck por SELECT: tablas, PK, CHECKs, índice, RLS y
--     `select count(*) from cierre_mes_avion` = 0; get_advisors (esperado:
--     solo el INFO «RLS sin policies» de siempre, ahora también para
--     cierre_mes_avion y cierre_mes_avion_vuelo).
--
-- PLAN B (si a) o b) responden {"status":"declined"}), SQL Editor:
--  B1) Pegar el DRY-RUN y ejecutar: debe terminar en «DRYRUN_OK …».
--  B2) En UNA corrida:
--        begin;
--        <el CUERPO entre «>>> CUERPO» y «<<< CUERPO», tal cual>
--        insert into supabase_migrations.schema_migrations (version, name, statements)
--        values ('20261023000001', 'cierre_mes_avion',
--                array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261023000001_cierre_mes_avion.sql'])
--        on conflict (version) do nothing;
--        commit;
--  B3) Postcheck por MCP y get_advisors.
--
-- ROLLBACK (SOLO desde el SQL Editor y SOLO si ningún avión se cerró;
-- REINICIAR el API después): retirar, con la sentencia de retiro de objetos
-- que este archivo no escribe (el MCP la rechaza incluso en comentarios), en
-- este orden: la tabla cierre_mes_avion_vuelo, el trigger
-- trg_cierre_mes_avion_set_updated_at y la tabla cierre_mes_avion. Si ya hubo
-- cierres por avión: primero «Reabrir» cada avión desde el panel (regresa los
-- vuelos) y verificar `count(*) from vuelo where periodo_contable is not
-- null` = 0.
-- =====================================================================

-- >>> CUERPO
-- ===========================================================================
-- 1) cierre_mes_avion — un renglón por (mes, avión) cerrado (o reabierto)
-- ===========================================================================
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

do $trg$
begin
  if not exists (
    select 1 from pg_trigger
     where tgrelid = 'public.cierre_mes_avion'::regclass
       and tgname = 'trg_cierre_mes_avion_set_updated_at'
  ) then
    create trigger trg_cierre_mes_avion_set_updated_at
      before update on public.cierre_mes_avion
      for each row execute function public.tg_set_updated_at();
  end if;
end $trg$;

alter table public.cierre_mes_avion enable row level security;

-- ===========================================================================
-- 2) cierre_mes_avion_vuelo — bitácora REVERSIBLE de los diferimientos
--    hechos por el cierre de UN avión
-- ===========================================================================
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

-- ===========================================================================
-- 3) cierre_mes_vuelo queda como LEGADO (sin filas en prod)
-- ===========================================================================
comment on table public.cierre_mes_vuelo is
  'LEGADO desde el 23-oct-2026 (invariante 105): la bitácora viva es cierre_mes_avion_vuelo. Sin filas en prod. El lector del API la sigue leyendo por compatibilidad (unión con la viva).';

comment on table public.cierre_mes is
  'Cierre formal de un mes (20261016000004, API 0.0.88, invariante 89). Desde el 23-oct-2026 (invariante 105) la fila es DERIVADA del cierre por avión (cierre_mes_avion): el API la escribe CERRADO cuando el último avión activo del mes queda cerrado y REABIERTO cuando cualquier avión se reabre con la flota cerrada. estado = CERRADO sigue siendo la verdad de «toda la flota está cerrada» para los lectores globales (candado de registros sin avión, AFAC editable, grupos, Dinero, balance general). socios_snapshot / reparto_snapshot / totales = agregado de las filas por avión.';

-- ===========================================================================
-- 4) Verificación (aborta la migración si algo no quedó)
-- ===========================================================================
do $ver$
begin
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
end $ver$;
-- <<< CUERPO
