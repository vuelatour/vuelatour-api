-- 5-oct-2026 · COMBUSTIBLE POR AERONAVE (API 0.0.56, invariante 43 del
-- CLAUDE.md del API).
--
-- Caso real: Luis capturó desde la app una carga de 74 L para el XB-PEV
-- (vuelo #280, Chetumal, tarjeta ****0585) y eligió «Turbosina»; el PEV
-- (Cessna 205, pistón) solo carga AVGAS y el balance Excel del avión mostró
-- «Combustible TURBOSINA». Pedido aprobado por el cliente: «dejar registrado
-- en cada avión qué combustible usa, y que al capturar una carga el sistema
-- la ajuste al combustible del avión y la marque para revisión si el piloto
-- eligió otro».
--
-- QUÉ HACE:
--   1. `aeronave.combustible text not null default 'AVGAS'` con CHECK
--      `aeronave_combustible_chk` (AVGAS | TURBOSINA). Texto + CHECK, NO un
--      enum (sin el incidente del ENUM `moneda` del 15-sep en plpgsql).
--   2. Marca TURBOSINA las dos turbinas de la flota: N58BT (Piper Meridian)
--      y N621TX (Kodiak 100). El resto (N4142R, N990GG, XA-VGV, XB-IJP,
--      XB-PEV, XB-ANU) se queda en el default AVGAS.
--   3. COMMENT de la columna.
--   4. Verificación (`do $ver$`) que ABORTA la migración si las turbinas no
--      quedaron en TURBOSINA, si alguna de las dos NO existe con esa
--      matrícula exacta o si algún valor quedó fuera del CHECK.
--
-- Sin triggers nuevos, sin funciones, sin tocar `gasto`. El UPDATE de la
-- sección 2 dispara los triggers EXISTENTES de `aeronave`:
--   - `trg_aeronave_set_updated_at` (BEFORE UPDATE): mueve `updated_at` de
--     las 2 turbinas (es un cambio real de la ficha; nadie hace CAS sobre
--     `aeronave.updated_at`, solo sobre sus squawks).
--   - `trg_aeronave_calendar_fanout` es `AFTER UPDATE OF matricula,
--     color_calendario`: NO se dispara (no encola nada a Google Calendar).
-- `gasto.tipo_combustible` (TEXT 'AVGAS' | 'TURBOSINA', sin enum) NO se
-- toca: el 5-oct en prod las 134 cargas GAS ya coinciden con su avión (0
-- AVGAS en turbina, 0 TURBOSINA en pistón; 82 en null) y el API 0.0.56
-- ajusta las nuevas al capturarlas.
--
-- DEPENDENCIA: ninguna. El API 0.0.56 corre CON o SIN esta migración (sonda
-- `common/combustible-disponible.util` = `columnaOpcional(aeronave.
-- combustible)`, re-sondeo ≤ 10 min): sin ella la flota se lee sin el campo
-- y las cargas GAS se guardan tal cual. Orden recomendado: migración → API →
-- panel → app.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (ANTES de aplicar). UNA sola sentencia `do $dry$`: el `raise
-- exception` final REVIERTE todo (ALTER incluido). Escrituras REALES sobre
-- `aeronave` (regla del CLAUDE.md: toda migración que dispare triggers se
-- prueba con UPDATE/INSERT reales, nunca solo con selects). Cualquier
-- 'DRYRUN_FALLA …' u otro error = NO aplicar.
--
-- do $dry$
-- declare
--   v_n int;
--   v_turbo int;
--   v_cola_antes bigint := null;
--   v_cola_despues bigint := null;
--   v_upd_antes timestamptz;
--   v_upd_despues timestamptz;
--   v_def text;
--   v_id uuid;
-- begin
--   -- A) CONTEXTO
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'aeronave'
--                 and column_name = 'combustible') then
--     raise exception 'DRYRUN_FALLA A: aeronave.combustible ya existe (¿migración aplicada?)';
--   end if;
--   select count(*) into v_n from public.aeronave where matricula in ('N58BT', 'N621TX');
--   if v_n <> 2 then
--     raise exception 'DRYRUN_FALLA A: se esperaban N58BT y N621TX, hay %', v_n;
--   end if;
--   -- C2–C4 escriben sobre el XB-PEV (el avión del caso real).
--   if not exists (select 1 from public.aeronave where matricula = 'XB-PEV') then
--     raise exception 'DRYRUN_FALLA A: no existe el XB-PEV';
--   end if;
--   select updated_at into v_upd_antes from public.aeronave where matricula = 'N58BT';
--   if to_regclass('public.calendar_sync_cola') is not null then
--     execute 'select count(*) from public.calendar_sync_cola' into v_cola_antes;
--   end if;
--   raise notice 'okA · 2 turbinas, sin columna';
--
--   -- B) CUERPO REAL (secciones 1–4 pegadas TAL CUAL)
--   alter table public.aeronave
--     add column if not exists combustible text not null default 'AVGAS'
--     constraint aeronave_combustible_chk check (combustible in ('AVGAS', 'TURBOSINA'));
--   update public.aeronave
--      set combustible = 'TURBOSINA'
--    where matricula in ('N58BT', 'N621TX')
--      and combustible is distinct from 'TURBOSINA';
--   comment on column public.aeronave.combustible is
--     'Combustible que carga el avión (AVGAS = pistón, TURBOSINA = turbina). Toda carga GAS se ajusta a este valor al capturarla (20261005000001).';
--   -- (la sección 4 `do $ver$` no se puede anidar: C1 la repite)
--
--   -- C1) VALORES: 2 turbinas, el resto AVGAS, nada fuera del CHECK
--   select count(*) into v_turbo from public.aeronave where combustible = 'TURBOSINA';
--   if v_turbo <> 2 then
--     raise exception 'DRYRUN_FALLA C1: % aviones en TURBOSINA (esperado 2)', v_turbo;
--   end if;
--   if exists (select 1 from public.aeronave
--               where matricula in ('N58BT', 'N621TX') and combustible <> 'TURBOSINA') then
--     raise exception 'DRYRUN_FALLA C1: una turbina no quedó en TURBOSINA';
--   end if;
--   if exists (select 1 from public.aeronave
--               where combustible is null or combustible not in ('AVGAS', 'TURBOSINA')) then
--     raise exception 'DRYRUN_FALLA C1: valor fuera del CHECK';
--   end if;
--   select column_default into v_def from information_schema.columns
--    where table_schema = 'public' and table_name = 'aeronave' and column_name = 'combustible';
--   if v_def is distinct from '''AVGAS''::text' then
--     raise exception 'DRYRUN_FALLA C1: default inesperado %', v_def;
--   end if;
--   select updated_at into v_upd_despues from public.aeronave where matricula = 'N58BT';
--   raise notice 'okC1 · 2 TURBOSINA · default % · updated_at N58BT % → %', v_def, v_upd_antes, v_upd_despues;
--
--   -- C2) CHECK con UPDATE REAL (dispara los triggers de aeronave)
--   begin
--     update public.aeronave set combustible = 'DIESEL' where matricula = 'XB-PEV';
--     raise exception 'DRYRUN_FALLA C2: el CHECK aceptó DIESEL';
--   exception when check_violation then
--     raise notice 'okC2 · DIESEL ⇒ 23514';
--   end;
--   begin
--     update public.aeronave set combustible = 'avgas' where matricula = 'XB-PEV';
--     raise exception 'DRYRUN_FALLA C2: el CHECK aceptó minúsculas';
--   exception when check_violation then
--     raise notice 'okC2b · avgas ⇒ 23514';
--   end;
--
--   -- C3) NOT NULL con UPDATE REAL
--   begin
--     update public.aeronave set combustible = null where matricula = 'XB-PEV';
--     raise exception 'DRYRUN_FALLA C3: aceptó null';
--   exception when not_null_violation then
--     raise notice 'okC3 · null ⇒ 23502';
--   end;
--
--   -- C4) UPDATE REAL válido (como lo escribe el PATCH del API) + INSERT
--   --     REAL de un avión sin el campo (como el alta de un API viejo) ⇒
--   --     default AVGAS
--   update public.aeronave set combustible = 'TURBOSINA' where matricula = 'XB-PEV';
--   update public.aeronave set combustible = 'AVGAS' where matricula = 'XB-PEV';
--   insert into public.aeronave (matricula, modelo, pais_registro, num_motores,
--                                velocidad_crucero_kts, asientos)
--   values ('XX-DRY1', 'Dry run', 'MX', 1, 120, 4)
--   returning id into v_id;
--   if (select combustible from public.aeronave where id = v_id) <> 'AVGAS' then
--     raise exception 'DRYRUN_FALLA C4: el alta sin campo no quedó en AVGAS';
--   end if;
--   raise notice 'okC4 · PATCH real y alta con default AVGAS';
--
--   -- C5) Google Calendar: nada encolado (el fan-out solo escucha
--   --     matricula/color_calendario)
--   if v_cola_antes is not null then
--     execute 'select count(*) from public.calendar_sync_cola' into v_cola_despues;
--     if v_cola_despues <> v_cola_antes then
--       raise exception 'DRYRUN_FALLA C5: la cola de Google pasó de % a %', v_cola_antes, v_cola_despues;
--     end if;
--   end if;
--   raise notice 'okC5 · cola % → %', v_cola_antes, v_cola_despues;
--
--   -- C6) RE-APLICAR es no-op (IF NOT EXISTS + update con guarda)
--   alter table public.aeronave
--     add column if not exists combustible text not null default 'AVGAS'
--     constraint aeronave_combustible_chk check (combustible in ('AVGAS', 'TURBOSINA'));
--   update public.aeronave
--      set combustible = 'TURBOSINA'
--    where matricula in ('N58BT', 'N621TX')
--      and combustible is distinct from 'TURBOSINA';
--   get diagnostics v_n = row_count;
--   if v_n <> 0 then
--     raise exception 'DRYRUN_FALLA C6: la segunda pasada tocó % filas', v_n;
--   end if;
--   select count(*) into v_n from pg_constraint
--    where conrelid = 'public.aeronave'::regclass and conname = 'aeronave_combustible_chk';
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA C6: % CHECK aeronave_combustible_chk', v_n;
--   end if;
--
--   raise exception 'DRYRUN_OK 20261005000001 · A–C6 (2 TURBOSINA, default AVGAS, CHECK y NOT NULL con UPDATE real, alta real, cola sin cambios, idempotente)';
-- end $dry$;
--
-- Tras el DRYRUN_OK:
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'aeronave'
--      and column_name = 'combustible';                       ⇒ 0 (nada quedó)
--   select count(*) from public.aeronave where matricula = 'XX-DRY1'; ⇒ 0
-- Aplicar (MCP `apply_migration`) ⇒ `get_advisors` ⇒
--   select matricula, combustible from public.aeronave order by matricula;
--   (N58BT y N621TX en TURBOSINA, el resto AVGAS) ⇒ sondear
--   `GET /v1/aircraft` (cada fila con `combustible`; la sonda del API
--   re-sondea en ≤ 10 min o reiniciar el API).
-- ---------------------------------------------------------------------------

-- 1) Columna con default y CHECK (idempotente).
alter table public.aeronave
  add column if not exists combustible text not null default 'AVGAS'
  constraint aeronave_combustible_chk check (combustible in ('AVGAS', 'TURBOSINA'));

-- 2) Las dos turbinas de la flota (verificadas en prod el 5-oct-2026).
update public.aeronave
   set combustible = 'TURBOSINA'
 where matricula in ('N58BT', 'N621TX')
   and combustible is distinct from 'TURBOSINA';

-- 3) Documentación.
comment on column public.aeronave.combustible is
  'Combustible que carga el avión (AVGAS = pistón, TURBOSINA = turbina). Toda carga GAS se ajusta a este valor al capturarla (20261005000001).';

-- 4) Verificación: aborta la migración (y la revierte) si algo no quedó.
do $ver$
declare
  v_faltan int;
  v_ok int;
  v_fuera int;
begin
  select count(*) into v_faltan
    from public.aeronave
   where matricula in ('N58BT', 'N621TX')
     and combustible <> 'TURBOSINA';
  if v_faltan > 0 then
    raise exception 'VERIFICACION_FALLA 20261005000001: % turbina(s) sin TURBOSINA', v_faltan;
  end if;
  -- Que las DOS existan con esa ortografía: si una matrícula estuviera
  -- escrita distinto (p. ej. «N-58BT») el UPDATE no tocaría nada, v_faltan
  -- daría 0 y esa turbina quedaría en AVGAS (cada carga suya se
  -- «corregiría» a AVGAS con nota y push).
  select count(*) into v_ok
    from public.aeronave
   where matricula in ('N58BT', 'N621TX')
     and combustible = 'TURBOSINA';
  if v_ok <> 2 then
    raise exception 'VERIFICACION_FALLA 20261005000001: % de 2 turbinas en TURBOSINA (¿matrícula distinta?)', v_ok;
  end if;
  select count(*) into v_fuera
    from public.aeronave
   where combustible is null
      or combustible not in ('AVGAS', 'TURBOSINA');
  if v_fuera > 0 then
    raise exception 'VERIFICACION_FALLA 20261005000001: % avión(es) con combustible fuera del CHECK', v_fuera;
  end if;
  raise notice 'VERIFICACION_OK 20261005000001 · turbinas en TURBOSINA, resto AVGAS';
end
$ver$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (manual, UNA transacción). Seguro con el API 0.0.56 vivo SOLO si
-- después se REINICIA el API: la sonda memoriza el «sí» para siempre y,
-- sin reinicio, `GET /v1/aircraft` respondería 500 por la columna.
--
-- begin;
--   alter table public.aeronave drop constraint if exists aeronave_combustible_chk;
--   alter table public.aeronave drop column if exists combustible;
-- commit;
-- ---------------------------------------------------------------------------
