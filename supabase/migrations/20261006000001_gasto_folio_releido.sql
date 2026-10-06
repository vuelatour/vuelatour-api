-- 6-oct-2026 · RELECTURA CON IA DEL FOLIO DE LOS COMPROBANTES (API 0.0.58,
-- invariante 46 del CLAUDE.md del API).
--
-- Pedido aprobado por el cliente: el Excel de conciliación pone el número de
-- factura en «Notas» solo si el gasto tiene folio (invariante 44: factura
-- recibida ligada → `folio_ticket` → `valor_ia_extraido->>folio` → UUID). En
-- prod (6-oct) 477 gastos con foto NO tenían ninguno; la IA ya había leído
-- 457 de esas fotos pero devolvió el folio vacío (facturas de ASUR de
-- principios de septiembre, antes de afinar el prompt). El cron del API
-- `gastos-releer-folio` (cada 5 min, lote configurable, default 15) vuelve a
-- leer esas fotos y rellena el folio.
--
-- QUÉ HACE:
--   1. `gasto.folio_releido_at timestamptz null`: cuándo el cron volvió a
--      leer el comprobante. null = pendiente de releer; se sella en CADA
--      intento con lectura (legible o no) y cuando el archivo ya no existe.
--      Sin default: TODAS las filas existentes quedan pendientes (el cron
--      acota por fecha del gasto y fecha de captura).
--   2. COMMENT.
--   3. Índice parcial `gasto_folio_releer_idx (fecha_gasto desc)` sobre la
--      cola del cron (foto, sin folio, sin factura, sin sellar).
--   4. Verificación (`do $ver$`) que ABORTA si la columna o el índice no
--      quedaron.
--
-- Sin triggers nuevos, sin funciones, sin backfill. Los UPDATE del cron
-- disparan los triggers EXISTENTES de `gasto`: `trg_gasto_set_updated_at`
-- (mueve `updated_at`), `trg_gasto_sync_facturacion` y
-- `trg_gasto_personal_dueno_valida` (no cambian nada: el cron no toca
-- factura, categoría, vuelo ni avión) y `trg_gasto_bitacora`, que registra
-- `folio_ticket` y `notas` con `actor_id = new.updated_by`: por eso el cron
-- escribe `updated_by = null` en esos dos casos (la bitácora del panel lo
-- pinta «Sistema»; sin él, el cambio se atribuiría a quien editó el gasto
-- por última vez, típicamente el piloto). El sello solo (`folio_releido_at`)
-- no está en la lista de columnas de la bitácora: no deja renglón y no se
-- toca `updated_by`.
--
-- DEPENDENCIA: ninguna. El API 0.0.58 corre CON o SIN esta migración (sonda
-- `common/folio-releido-gasto-disponible.util` = `columnaOpcional(gasto.
-- folio_releido_at)`, re-sondeo ≤ 10 min): sin ella el cron no hace nada (ni
-- lee fotos ni gasta créditos de IA). Orden: API → migración (o al revés).
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (ANTES de aplicar). UNA sola sentencia `do $dry$` (se ejecuta
-- quitando el prefijo «-- » de las líneas entre `-- do $dry$` y
-- `-- end $dry$;`): el `raise exception` final REVIERTE todo (ALTER e índice
-- incluidos). Escrituras REALES sobre `gasto` EXACTAMENTE como las hace el
-- cron (regla del CLAUDE.md: toda migración se prueba con INSERT/UPDATE
-- reales, nunca solo con selects; los triggers de `gasto` se ejercen con
-- `updated_by` null). Cualquier 'DRYRUN_FALLA …' u otro error = NO aplicar.
--
-- do $dry$
-- declare
--   v_total int;
--   v_cola int;
--   v_n int;
--   v_bit int;
--   v_id1 uuid;
--   v_id2 uuid;
--   v_id3 uuid;
--   v_upd timestamptz;
--   v_updby uuid;
--   v_notas text;
--   v_folio text;
--   v_def text;
--   r record;
-- begin
--   -- A) CONTEXTO: la columna no existe; la cola del cron (mismos filtros
--   --    que el API con la configuración por default) tiene ≥ 3 gastos.
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'gasto'
--                 and column_name = 'folio_releido_at') then
--     raise exception 'DRYRUN_FALLA A: gasto.folio_releido_at ya existe (¿migración aplicada?)';
--   end if;
--   select count(*) into v_total
--     from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null
--      and valor_ia_extraido->>'folio' is null;
--   select count(*) into v_cola
--     from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null
--      and valor_ia_extraido->>'folio' is null
--      and fecha_gasto >= '2026-09-01'
--      and created_at < '2026-10-06T00:00:00-05:00';
--   select id into v_id1 from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null and valor_ia_extraido->>'folio' is null
--      and fecha_gasto >= '2026-09-01' and created_at < '2026-10-06T00:00:00-05:00'
--    order by fecha_gasto desc, id desc limit 1;
--   select id into v_id2 from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null and valor_ia_extraido->>'folio' is null
--      and fecha_gasto >= '2026-09-01' and created_at < '2026-10-06T00:00:00-05:00'
--    order by fecha_gasto desc, id desc offset 1 limit 1;
--   select id into v_id3 from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null and valor_ia_extraido->>'folio' is null
--      and fecha_gasto >= '2026-09-01' and created_at < '2026-10-06T00:00:00-05:00'
--    order by fecha_gasto desc, id desc offset 2 limit 1;
--   if v_id3 is null then
--     raise exception 'DRYRUN_FALLA A: la cola del cron tiene % gastos (se necesitan 3 para el ensayo)', v_cola;
--   end if;
--   raise notice 'okA · % con foto y sin folio, % en la cola del cron', v_total, v_cola;
--
--   -- B) CUERPO REAL (secciones 1–3 pegadas TAL CUAL)
--   alter table public.gasto
--     add column if not exists folio_releido_at timestamptz null;
--   comment on column public.gasto.folio_releido_at is
--     'Cuándo el cron gastos-releer-folio volvió a leer con IA el comprobante para rellenar el folio. null = pendiente de releer; se sella en cada intento con lectura (legible o no) y si el archivo ya no existe (20261006000001).';
--   create index if not exists gasto_folio_releer_idx
--     on public.gasto (fecha_gasto desc)
--     where foto_url is not null
--       and folio_ticket is null
--       and factura_recibida_id is null
--       and folio_releido_at is null;
--   -- (la sección 4 `do $ver$` no se puede anidar: C1 la repite)
--
--   -- C1) ESTRUCTURA: tipo, nulabilidad, sin default, índice con su
--   --     predicado y TODAS las filas existentes pendientes.
--   select data_type, is_nullable, column_default into r
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto'
--      and column_name = 'folio_releido_at';
--   if r.data_type <> 'timestamp with time zone' or r.is_nullable <> 'YES'
--      or r.column_default is not null then
--     raise exception 'DRYRUN_FALLA C1: quedó % / nullable % / default %',
--       r.data_type, r.is_nullable, r.column_default;
--   end if;
--   select indexdef into v_def from pg_indexes
--    where schemaname = 'public' and tablename = 'gasto'
--      and indexname = 'gasto_folio_releer_idx';
--   if v_def is null or v_def not like '%folio_releido_at IS NULL%'
--      or v_def not like '%foto_url IS NOT NULL%'
--      or v_def not like '%factura_recibida_id IS NULL%'
--      or v_def not like '%fecha_gasto DESC%' then
--     raise exception 'DRYRUN_FALLA C1: índice % ', coalesce(v_def, 'ausente');
--   end if;
--   select count(*) into v_n from public.gasto where folio_releido_at is not null;
--   if v_n <> 0 then
--     raise exception 'DRYRUN_FALLA C1: % filas nacieron selladas', v_n;
--   end if;
--   raise notice 'okC1 · columna, índice, % filas pendientes', v_total;
--
--   -- C2) (a) FOLIO LEÍDO: UPDATE REAL como el cron (CAS sobre folio_ticket,
--   --     folio_releido_at, factura_recibida_id y updated_at; updated_by
--   --     null; la llave `folio` de la lectura rellenada). Un folio único
--   --     DRYRUN-… pasa por el índice único de folio_ticket_norm.
--   v_folio := 'DRYRUN-20261006000001-' || left(md5(v_id1::text), 8);
--   select updated_at into v_upd from public.gasto where id = v_id1;
--   select count(*) into v_bit from public.gasto_bitacora where gasto_id = v_id1;
--   update public.gasto
--      set folio_ticket = v_folio,
--          valor_ia_extraido = case
--            when jsonb_typeof(valor_ia_extraido) = 'object'
--              then valor_ia_extraido || jsonb_build_object('folio', v_folio)
--            else jsonb_build_object('legible', true, 'folio', v_folio) end,
--          folio_releido_at = now(),
--          updated_by = null
--    where id = v_id1
--      and folio_ticket is null and folio_releido_at is null
--      and factura_recibida_id is null and updated_at = v_upd;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA C2: el cron escribió % filas (esperado 1)', v_n;
--   end if;
--   if (select count(*) from public.gasto_bitacora where gasto_id = v_id1) <> v_bit + 1
--      or not exists (select 1 from public.gasto_bitacora
--                      where gasto_id = v_id1 and accion = 'UPDATE'
--                        and actor_id is null
--                        and diff->'folio_ticket'->>'despues' = v_folio) then
--     raise exception 'DRYRUN_FALLA C2: la bitácora no registró el folio con actor «Sistema» (null)';
--   end if;
--   if (select updated_by from public.gasto where id = v_id1) is not null
--      or (select valor_ia_extraido->>'folio' from public.gasto where id = v_id1) <> v_folio
--      or (select folio_ticket_norm from public.gasto where id = v_id1)
--           <> upper(regexp_replace(v_folio, '[^A-Za-z0-9]', '', 'g'))
--      or (select updated_at from public.gasto where id = v_id1) = v_upd then
--     raise exception 'DRYRUN_FALLA C2: fila mal escrita (updated_by, lectura IA, folio_ticket_norm o updated_at)';
--   end if;
--
--   -- C3) CAS: la misma escritura otra vez (carrera / reintento) NO toca nada.
--   update public.gasto
--      set folio_ticket = 'PISADO', folio_releido_at = now(), updated_by = null
--    where id = v_id1
--      and folio_ticket is null and folio_releido_at is null
--      and factura_recibida_id is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 0 then
--     raise exception 'DRYRUN_FALLA C3: el CAS dejó pisar un gasto ya sellado';
--   end if;
--   raise notice 'okC2–C3 · folio escrito, bitácora «Sistema», CAS';
--
--   -- C4) (b) FOLIO QUE YA ES DE OTRO GASTO: el índice único lo rechaza
--   --     (23505) y el cron sella SIN folio, con duplicado_sospechado y la
--   --     línea en notas (CAS sobre las notas releídas y updated_at).
--   begin
--     update public.gasto set folio_ticket = v_folio, updated_by = null
--      where id = v_id2;
--     raise exception 'DRYRUN_FALLA C4: el índice único dejó repetir el folio %', v_folio;
--   exception when unique_violation then
--     null;
--   end;
--   select updated_at, notas into v_upd, v_notas from public.gasto where id = v_id2;
--   select count(*) into v_bit from public.gasto_bitacora where gasto_id = v_id2;
--   update public.gasto
--      set duplicado_sospechado = true,
--          notas = case when coalesce(rtrim(v_notas, E' \t\r\n'), '') = ''
--            then '⚠ IA: folio ' || v_folio || ' ya existe en otro gasto — revisar'
--            else rtrim(v_notas, E' \t\r\n') || E'\n⚠ IA: folio ' || v_folio || ' ya existe en otro gasto — revisar' end,
--          folio_releido_at = now(),
--          updated_by = null
--    where id = v_id2
--      and folio_ticket is null and folio_releido_at is null
--      and factura_recibida_id is null and updated_at = v_upd;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA C4: el duplicado escribió % filas (esperado 1)', v_n;
--   end if;
--   if (select folio_ticket from public.gasto where id = v_id2) is not null
--      or not (select duplicado_sospechado from public.gasto where id = v_id2)
--      or (select notas from public.gasto where id = v_id2) not like '%⚠ IA: folio ' || v_folio || ' ya existe en otro gasto — revisar'
--      or (select count(*) from public.gasto_bitacora where gasto_id = v_id2) <> v_bit + 1
--      or not exists (select 1 from public.gasto_bitacora
--                      where gasto_id = v_id2 and accion = 'UPDATE'
--                        and actor_id is null and diff ? 'notas'
--                        and not diff ? 'folio_ticket') then
--     raise exception 'DRYRUN_FALLA C4: duplicado mal escrito';
--   end if;
--   raise notice 'okC4 · 23505 del índice único, duplicado con nota y actor «Sistema»';
--
--   -- C5) (c) SIN FOLIO / ILEGIBLE: solo el sello. No deja renglón en la
--   --     bitácora y NO cambia updated_by (nadie «editó» el gasto).
--   select updated_at, updated_by into v_upd, v_updby from public.gasto where id = v_id3;
--   select count(*) into v_bit from public.gasto_bitacora where gasto_id = v_id3;
--   update public.gasto
--      set folio_releido_at = now()
--    where id = v_id3
--      and folio_ticket is null and folio_releido_at is null
--      and factura_recibida_id is null and updated_at = v_upd;
--   get diagnostics v_n = row_count;
--   if v_n <> 1
--      or (select count(*) from public.gasto_bitacora where gasto_id = v_id3) <> v_bit
--      or (select updated_by from public.gasto where id = v_id3) is distinct from v_updby
--      or (select folio_releido_at from public.gasto where id = v_id3) is null then
--     raise exception 'DRYRUN_FALLA C5: sello sin folio mal escrito (% filas)', v_n;
--   end if;
--
--   -- C6) La cola del cron bajó exactamente en los 3 sellados.
--   select count(*) into v_n
--     from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null and folio_releido_at is null
--      and valor_ia_extraido->>'folio' is null
--      and fecha_gasto >= '2026-09-01'
--      and created_at < '2026-10-06T00:00:00-05:00';
--   if v_n <> v_cola - 3 then
--     raise exception 'DRYRUN_FALLA C6: la cola quedó en % (esperado %)', v_n, v_cola - 3;
--   end if;
--   raise notice 'okC5–C6 · sello sin bitácora, cola % → %', v_cola, v_n;
--
--   -- C7) RE-APLICAR es no-op (IF NOT EXISTS).
--   set constraints all immediate;
--   alter table public.gasto
--     add column if not exists folio_releido_at timestamptz null;
--   create index if not exists gasto_folio_releer_idx
--     on public.gasto (fecha_gasto desc)
--     where foto_url is not null
--       and folio_ticket is null
--       and factura_recibida_id is null
--       and folio_releido_at is null;
--   select count(*) into v_n from pg_indexes
--    where schemaname = 'public' and tablename = 'gasto'
--      and indexname = 'gasto_folio_releer_idx';
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA C7: % índices tras re-aplicar', v_n;
--   end if;
--
--   raise exception 'DRYRUN_OK 20261006000001 · A–C7 (% con foto y sin folio, % en la cola; folio escrito, duplicado 23505 con nota, sello sin bitácora, actor «Sistema», CAS, idempotente)', v_total, v_cola;
-- end $dry$;
--
-- Tras el DRYRUN_OK:
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto'
--      and column_name = 'folio_releido_at';                        ⇒ 0
--   select count(*) from public.gasto where folio_ticket like 'DRYRUN-20261006000001-%';  ⇒ 0
-- Aplicar (MCP `apply_migration`) ⇒ `get_advisors` ⇒ con el API 0.0.58
-- desplegado (la sonda re-sondea en ≤ 10 min):
--   select count(*) from public.gasto
--    where foto_url is not null and folio_ticket is null
--      and factura_recibida_id is null and folio_releido_at is null
--      and valor_ia_extraido->>'folio' is null
--      and fecha_gasto >= '2026-09-01'
--      and created_at < '2026-10-06T00:00:00-05:00';
--   (118 el 6-oct; baja ~15 cada 5 min mientras la IA tenga saldo)
-- ---------------------------------------------------------------------------

-- 1) Columna (idempotente).
alter table public.gasto
  add column if not exists folio_releido_at timestamptz null;

-- 2) Documentación.
comment on column public.gasto.folio_releido_at is
  'Cuándo el cron gastos-releer-folio volvió a leer con IA el comprobante para rellenar el folio. null = pendiente de releer; se sella en cada intento con lectura (legible o no) y si el archivo ya no existe (20261006000001).';

-- 3) Índice parcial sobre la cola del cron.
create index if not exists gasto_folio_releer_idx
  on public.gasto (fecha_gasto desc)
  where foto_url is not null
    and folio_ticket is null
    and factura_recibida_id is null
    and folio_releido_at is null;

-- 4) Verificación: aborta la migración (y la revierte) si algo no quedó.
do $ver$
declare
  v_ok int;
  v_idx int;
begin
  select count(*) into v_ok
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'gasto'
     and column_name = 'folio_releido_at'
     and data_type = 'timestamp with time zone'
     and is_nullable = 'YES';
  select count(*) into v_idx
    from pg_indexes
   where schemaname = 'public'
     and tablename = 'gasto'
     and indexname = 'gasto_folio_releer_idx'
     and indexdef like '%folio_releido_at IS NULL%';
  if v_ok <> 1 or v_idx <> 1 then
    raise exception 'VERIFICACION_FALLA 20261006000001: columna % de 1, índice % de 1', v_ok, v_idx;
  end if;
  raise notice 'VERIFICACION_OK 20261006000001 · gasto.folio_releido_at + gasto_folio_releer_idx';
end
$ver$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (manual, UNA transacción). Seguro con el API 0.0.58 vivo SOLO si
-- después se REINICIA el API: la sonda memoriza el «sí» para siempre y, sin
-- reinicio, el cron fallaría por la columna en cada corrida (warn, sin más
-- daño). Los folios ya escritos en `folio_ticket` se QUEDAN (son datos del
-- gasto); solo se pierde el sello (el cron, re-aplicada, no relee lo que ya
-- tiene folio).
--
-- begin;
--   drop index if exists public.gasto_folio_releer_idx;
--   alter table public.gasto drop column if exists folio_releido_at;
-- commit;
-- ---------------------------------------------------------------------------
