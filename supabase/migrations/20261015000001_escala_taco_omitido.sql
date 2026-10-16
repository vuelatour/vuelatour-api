-- =====================================================================
-- 20261015000001_escala_taco_omitido.sql — TACÓMETRO OMITIDO POR TRAMO
-- (15-oct-2026, pedido del cliente con la captura del vuelo #300; API 0.0.81;
-- invariante 79 del CLAUDE.md del API).
--
-- QUÉ HACE (aditiva, idempotente, sin backfill, sin índice, sin enum):
--  1) escala.taco_omitido_at timestamptz, escala.taco_omitido_por uuid (FK usuario,
--     acción set null) y escala.taco_omitido_motivo text, los tres NULL.
--  2) CHECK escala_taco_omitido_chk: at ⇔ motivo (10–500 tras btrim) y, si está
--     omitido, taco_llegada IS NULL (una llegada real retira la omisión en el
--     MISMO update: captureTaco / confirmTaco / resolverLecturaPendiente).
--  3) COMMENT en las tres columnas.
--  4) Verificación que aborta si algo no quedó.
-- PALABRAS (revisión 0.0.81: la versión anterior de esta cabecera afirmaba que
-- el cuerpo no las llevaba, y no era cierto): la cláusula de la FK
-- «on delete set null» es la ÚNICA aparición de la palabra en el CUERPO (una
-- vez) y en el DRY-RUN (dos: el DDL y su re-aplicación); comentarios, COMMENT
-- y mensajes ya no la repiten. NO es una sentencia destructiva, pero el MCP de
-- Supabase desde VS Code responde {"status":"declined"} SIN diálogo a SQL que
-- contenga drop/delete/revoke (CLAUDE.md del workspace) y nunca se probó con un
-- `on delete` de FK. Por eso hay PLAN A (MCP) y PLAN B (SQL Editor), abajo; si
-- el PLAN A vuelve «declined» NO se reintenta: se pasa al B.
--
-- DEPENDENCIA: NINGUNA dura. El API 0.0.81 es desplegable ANTES o DESPUÉS
-- (sonda única common/taco-omitido-disponible.util: sin la columna todo como el
-- 0.0.80 con las llaves taco_omitido_* en null, y POST/DELETE …/taco/omitir ⇒
-- 503 MIGRACION_PENDIENTE; la sonda se enciende sola en ≤ 10 min). OJO: el «sí»
-- de la sonda se memoriza — tras un ROLLBACK hay que reiniciar el API.
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar el proyecto con un SELECT):
--  a) DRY-RUN de abajo con mcp__supabase__execute_sql: UNA sentencia, el bloque
--     «do $dry$ … $dry$;» quitando el prefijo «-- » de sus líneas. Debe terminar
--     en «DRYRUN_OK …». Después: las columnas NO existen (comprobación al pie).
--  b) mcp__supabase__apply_migration con name «20261015000001_escala_taco_omitido»
--     y query = SOLO el cuerpo entre «>>> CUERPO» y «<<< CUERPO».
--  c) get_advisors (esperado: nada nuevo) y
--     select count(*) from public.escala where taco_omitido_at is not null; ⇒ 0
--
-- PLAN B (si a) o b) responden {"status":"declined"}), en el SQL Editor de
-- Supabase del proyecto bjesduasnzbzywofukbf:
--  B1) Pegar el DRY-RUN (sin el prefijo «-- ») y ejecutar: debe terminar en
--      «DRYRUN_OK 20261015000001 …» (error esperado: todo se revierte).
--  B2) Pegar y ejecutar, en UNA corrida:
--        begin;
--        <el CUERPO entre «>>> CUERPO» y «<<< CUERPO», tal cual>
--        insert into supabase_migrations.schema_migrations (version, name, statements)
--        values ('20261015000001', 'escala_taco_omitido',
--                array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261015000001_escala_taco_omitido.sql'])
--        on conflict (version) do nothing;
--        commit;
--      (la verificación 4) del cuerpo aborta TODO, historial incluido, si algo
--      no quedó).
--  B3) POSTCHECK por MCP (execute_sql; sin palabras destructivas; termina
--      SIEMPRE en raise, no escribe nada). Debe responder «POSTCHECK_OK …»:
--      do $post$
--      declare v_n int;
--      begin
--        select count(*) into v_n from information_schema.columns
--         where table_schema = 'public' and table_name = 'escala'
--           and column_name in ('taco_omitido_at','taco_omitido_por','taco_omitido_motivo')
--           and is_nullable = 'YES' and column_default is null;
--        if v_n <> 3 then raise exception 'POSTCHECK_FALLA: % columnas', v_n; end if;
--        perform 1 from pg_constraint c
--         where c.conrelid = 'public.escala'::regclass
--           and c.conname = 'escala_taco_omitido_chk' and c.contype = 'c';
--        if not found then raise exception 'POSTCHECK_FALLA: CHECK'; end if;
--        perform 1 from pg_constraint c
--         where c.conrelid = 'public.escala'::regclass
--           and c.conname = 'escala_taco_omitido_por_fkey' and c.contype = 'f'
--           and c.confdeltype = 'n';
--        if not found then raise exception 'POSTCHECK_FALLA: FK (acción set null)'; end if;
--        perform 1 from supabase_migrations.schema_migrations where version = '20261015000001';
--        if not found then raise exception 'POSTCHECK_FALLA: historial'; end if;
--        select count(*) into v_n from public.escala where taco_omitido_at is not null;
--        raise exception 'POSTCHECK_OK 20261015000001 · omitidos=%', v_n;
--      end
--      $post$;
--  B4) get_advisors (esperado: nada nuevo).
--
-- DRY-RUN (escrituras REALES; el DDL PRIMERO, su re-aplicación ANTES de cualquier
-- fila de prueba; las filas de prueba DESPUÉS del DDL; termina SIEMPRE en raise ⇒
-- todo se revierte, DDL incluido).
-- do $dry$
-- declare
--   v_escala uuid;
--   v_vuelo uuid;
--   v_actor uuid;
--   v_n int;
--   v_at timestamptz;
--   v_upd_antes timestamptz;
--   v_upd_despues timestamptz;
--   v_def text;
--   v_cola_antes bigint := -1;
--   v_cola_despues bigint := -1;
-- begin
--   -- A) CONTEXTO
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'escala'
--                 and column_name like 'taco_omitido%') then
--     raise exception 'DRYRUN_FALLA A: escala.taco_omitido_* ya existe (¿ya está aplicada?)';
--   end if;
--   select u.id into v_actor from public.usuario u
--    where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--    order by u.created_at limit 1;
--   if v_actor is null then
--     raise exception 'DRYRUN_FALLA A: no hay ADMIN activo para firmar las escrituras';
--   end if;
--
--   -- B) CUERPO REAL (secciones 1–4 del cuerpo, TAL CUAL)
--   alter table public.escala
--     add column if not exists taco_omitido_at timestamptz,
--     add column if not exists taco_omitido_por uuid references public.usuario(id) on delete set null,
--     add column if not exists taco_omitido_motivo text;
--   if not exists (select 1 from pg_constraint
--                   where conrelid = 'public.escala'::regclass
--                     and conname = 'escala_taco_omitido_chk') then
--     alter table public.escala
--       add constraint escala_taco_omitido_chk check (
--         (taco_omitido_at is null and taco_omitido_motivo is null)
--         or (
--           taco_omitido_at is not null
--           and taco_omitido_motivo is not null
--           and length(btrim(taco_omitido_motivo)) between 10 and 500
--           and taco_llegada is null
--         )
--       );
--   end if;
--   comment on column public.escala.taco_omitido_at is
--     'Tacómetro OMITIDO por la oficina (15-oct-2026): cuándo. NULL = el tramo pide su lectura de llegada como siempre. Omitido = no exige llegada para completar el vuelo, aporta 0 h (no se inventa ninguna lectura), sale de los avisos al piloto, del tablero de vencidos y del pre-cierre bloqueante; se DICE en reporte, balance y pre-cierre informativo. Una llegada real posterior lo pone en NULL en el mismo UPDATE (CHECK escala_taco_omitido_chk).';
--   comment on column public.escala.taco_omitido_por is
--     'Usuario de oficina (ADMIN/COORDINADOR/FACTURACION) que omitió la lectura. Si ese usuario se borra, queda en NULL (FK con acción set null): el nombre sobrevive en el bloque «Registro:» de revision_motivo.';
--   comment on column public.escala.taco_omitido_motivo is
--     'Por qué no se pudo capturar el tacómetro (obligatorio, 10–500 caracteres tras btrim), p. ej. «Falló el tacómetro». Solo lo escribe el API (POST /v1/flights/legs/:legId/taco/omitir).';
--
--   -- C0) RE-APLICAR el cuerpo = no-op, ANTES de cualquier fila de prueba
--   alter table public.escala
--     add column if not exists taco_omitido_at timestamptz,
--     add column if not exists taco_omitido_por uuid references public.usuario(id) on delete set null,
--     add column if not exists taco_omitido_motivo text;
--   if not exists (select 1 from pg_constraint
--                   where conrelid = 'public.escala'::regclass
--                     and conname = 'escala_taco_omitido_chk') then
--     raise exception 'DRYRUN_FALLA C0: el CHECK desapareció';
--   end if;
--   select count(*) into v_n from information_schema.columns
--    where table_schema = 'public' and table_name = 'escala'
--      and column_name in ('taco_omitido_at','taco_omitido_por','taco_omitido_motivo');
--   if v_n <> 3 then raise exception 'DRYRUN_FALLA C0: % columnas (esperado 3)', v_n; end if;
--   select count(*) into v_n from pg_constraint
--    where conrelid = 'public.escala'::regclass and conname = 'escala_taco_omitido_chk';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C0: % CHECK (esperado 1)', v_n; end if;
--
--   -- C1) ESTRUCTURA
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'escala'
--      and column_name = 'taco_omitido_at' and data_type = 'timestamp with time zone'
--      and is_nullable = 'YES' and column_default is null;
--   if not found then raise exception 'DRYRUN_FALLA C1: taco_omitido_at'; end if;
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'escala'
--      and column_name = 'taco_omitido_por' and data_type = 'uuid'
--      and is_nullable = 'YES' and column_default is null;
--   if not found then raise exception 'DRYRUN_FALLA C1: taco_omitido_por'; end if;
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'escala'
--      and column_name = 'taco_omitido_motivo' and data_type = 'text'
--      and is_nullable = 'YES' and column_default is null;
--   if not found then raise exception 'DRYRUN_FALLA C1: taco_omitido_motivo'; end if;
--   select pg_get_constraintdef(c.oid) into v_def from pg_constraint c
--    where c.conrelid = 'public.escala'::regclass and c.conname = 'escala_taco_omitido_chk';
--   if v_def is null or position('taco_llegada IS NULL' in v_def) = 0
--      or position('btrim(taco_omitido_motivo)' in v_def) = 0 then
--     raise exception 'DRYRUN_FALLA C1: CHECK (%)', v_def;
--   end if;
--   perform 1 from pg_constraint c
--    where c.conrelid = 'public.escala'::regclass
--      and c.conname = 'escala_taco_omitido_por_fkey' and c.contype = 'f' and c.confdeltype = 'n';
--   if not found then raise exception 'DRYRUN_FALLA C1: FK escala_taco_omitido_por_fkey (acción set null)'; end if;
--
--   -- FILA DE PRUEBA (DESPUÉS del DDL): un tramo VIVO sin llegada de un vuelo
--   -- propio EN_VUELO/CONFIRMADO (el caso del #300).
--   select e.id, e.vuelo_id into v_escala, v_vuelo
--     from public.escala e join public.vuelo v on v.id = e.vuelo_id
--    where e.taco_llegada is null and e.cancelada_at is null
--      and v.es_externo = false and v.estado::text in ('EN_VUELO','CONFIRMADO')
--    order by v.fecha_vuelo desc limit 1;
--   if v_escala is null then
--     raise exception 'DRYRUN_FALLA: no hay tramo vivo sin llegada para probar';
--   end if;
--
--   -- C2) OMITIR como lo escribe el API (UPDATE REAL con CAS)
--   select updated_at into v_upd_antes from public.escala where id = v_escala;
--   if to_regclass('public.calendar_sync_cola') is not null then
--     execute 'select count(*) from public.calendar_sync_cola' into v_cola_antes;
--   end if;
--   update public.escala
--      set taco_omitido_at = now(), taco_omitido_por = v_actor,
--          taco_omitido_motivo = 'DRYRUN 20261015000001 · falló el tacómetro',
--          revision_requerida = false, updated_by = v_actor
--    where id = v_escala and taco_omitido_at is null and taco_llegada is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C2: % filas (esperado 1)', v_n; end if;
--   select updated_at, taco_omitido_at into v_upd_despues, v_at from public.escala where id = v_escala;
--   if v_at is null or not (v_upd_despues > v_upd_antes) then
--     raise exception 'DRYRUN_FALLA C2: at % · updated_at no se movió', v_at;
--   end if;
--   if v_cola_antes >= 0 then
--     execute 'select count(*) from public.calendar_sync_cola' into v_cola_despues;
--     if v_cola_despues <> v_cola_antes then
--       raise exception 'DRYRUN_FALLA C2: el trigger de calendario encoló por una columna que no es suya';
--     end if;
--   end if;
--
--   -- C3) segunda omisión con el MISMO CAS ⇒ 0 filas (carrera / doble clic)
--   update public.escala set taco_omitido_at = now()
--    where id = v_escala and taco_omitido_at is null and taco_llegada is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C3: el CAS dejó pasar una segunda omisión'; end if;
--
--   -- C4) CHECK: llegada sobre un tramo omitido SIN retirar la omisión ⇒ 23514
--   begin
--     update public.escala set taco_llegada = coalesce(taco_salida, 0) + 1 where id = v_escala;
--     raise exception 'DRYRUN_FALLA C4: el CHECK dejó una llegada sobre un tramo omitido';
--   exception when check_violation then null;
--   end;
--
--   -- C5) CHECK: motivo corto ⇒ 23514
--   begin
--     update public.escala set taco_omitido_motivo = 'corto' where id = v_escala;
--     raise exception 'DRYRUN_FALLA C5: el CHECK dejó un motivo de 5 caracteres';
--   exception when check_violation then null;
--   end;
--
--   -- C6) CHECK: at sin motivo ⇒ 23514
--   begin
--     update public.escala set taco_omitido_motivo = null where id = v_escala;
--     raise exception 'DRYRUN_FALLA C6: el CHECK dejó at sin motivo';
--   exception when check_violation then null;
--   end;
--
--   -- C7) FK: usuario inexistente ⇒ 23503
--   begin
--     update public.escala set taco_omitido_por = '00000000-0000-4000-8000-000000000000' where id = v_escala;
--     raise exception 'DRYRUN_FALLA C7: la FK dejó un usuario inexistente';
--   exception when foreign_key_violation then null;
--   end;
--
--   -- C8) LLEGADA REAL retira la omisión en el MISMO update (captureTaco/confirmTaco) ⇒ pasa
--   update public.escala
--      set taco_llegada = coalesce(taco_salida, 0) + 1, taco_llegada_origen = 'OFICINA',
--          taco_omitido_at = null, taco_omitido_por = null, taco_omitido_motivo = null,
--          updated_by = v_actor
--    where id = v_escala;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C8: % filas', v_n; end if;
--   select count(*) into v_n from public.escala
--    where id = v_escala and taco_omitido_at is null and taco_omitido_motivo is null
--      and taco_omitido_por is null and taco_llegada is not null;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C8: la omisión no quedó retirada'; end if;
--
--   -- C9) volver a omitir y DESHACER (la ruta de deshacer = tres NULL con CAS)
--   update public.escala set taco_llegada = null, taco_llegada_origen = null where id = v_escala;
--   update public.escala
--      set taco_omitido_at = now(), taco_omitido_por = v_actor,
--          taco_omitido_motivo = 'DRYRUN 20261015000001 · lectura ilegible y sin forma de recuperarla'
--    where id = v_escala and taco_omitido_at is null and taco_llegada is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C9: re-omitir % filas', v_n; end if;
--   update public.escala
--      set taco_omitido_at = null, taco_omitido_por = null, taco_omitido_motivo = null
--    where id = v_escala and taco_omitido_at is not null;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C9: deshacer % filas', v_n; end if;
--
--   raise exception 'DRYRUN_OK 20261015000001 · A–C9 · escala % (vuelo %) · todo se revierte', v_escala, v_vuelo;
-- end
-- $dry$;
--
-- Comprobación DESPUÉS del dry-run (debe dar 0):
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'escala' and column_name like 'taco_omitido%';
-- =====================================================================

-- >>> CUERPO
-- 1) Columnas (aditivas, idempotentes).
alter table public.escala
  add column if not exists taco_omitido_at timestamptz,
  add column if not exists taco_omitido_por uuid references public.usuario(id) on delete set null,
  add column if not exists taco_omitido_motivo text;

-- 2) CHECK de coherencia (idempotente; sin palabras destructivas).
do $chk$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.escala'::regclass and conname = 'escala_taco_omitido_chk'
  ) then
    alter table public.escala
      add constraint escala_taco_omitido_chk check (
        (taco_omitido_at is null and taco_omitido_motivo is null)
        or (
          taco_omitido_at is not null
          and taco_omitido_motivo is not null
          and length(btrim(taco_omitido_motivo)) between 10 and 500
          and taco_llegada is null
        )
      );
  end if;
end
$chk$;

-- 3) Comentarios.
comment on column public.escala.taco_omitido_at is
  'Tacómetro OMITIDO por la oficina (15-oct-2026): cuándo. NULL = el tramo pide su lectura de llegada como siempre. Omitido = no exige llegada para completar el vuelo, aporta 0 h (no se inventa ninguna lectura), sale de los avisos al piloto, del tablero de vencidos y del pre-cierre bloqueante; se DICE en reporte, balance y pre-cierre informativo. Una llegada real posterior lo pone en NULL en el mismo UPDATE (CHECK escala_taco_omitido_chk).';
comment on column public.escala.taco_omitido_por is
  'Usuario de oficina (ADMIN/COORDINADOR/FACTURACION) que omitió la lectura. Si ese usuario se borra, queda en NULL (FK con acción set null): el nombre sobrevive en el bloque «Registro:» de revision_motivo.';
comment on column public.escala.taco_omitido_motivo is
  'Por qué no se pudo capturar el tacómetro (obligatorio, 10–500 caracteres tras btrim), p. ej. «Falló el tacómetro». Solo lo escribe el API (POST /v1/flights/legs/:legId/taco/omitir).';

-- 4) Verificación (aborta la migración si algo no quedó).
do $ver$
declare
  v_def text;
begin
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'escala'
     and column_name = 'taco_omitido_at' and data_type = 'timestamp with time zone'
     and is_nullable = 'YES' and column_default is null;
  if not found then
    raise exception 'VERIFICACIÓN 20261015000001: escala.taco_omitido_at no quedó timestamptz nullable sin default';
  end if;
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'escala'
     and column_name = 'taco_omitido_por' and data_type = 'uuid'
     and is_nullable = 'YES' and column_default is null;
  if not found then
    raise exception 'VERIFICACIÓN 20261015000001: escala.taco_omitido_por no quedó uuid nullable';
  end if;
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'escala'
     and column_name = 'taco_omitido_motivo' and data_type = 'text'
     and is_nullable = 'YES' and column_default is null;
  if not found then
    raise exception 'VERIFICACIÓN 20261015000001: escala.taco_omitido_motivo no quedó text nullable';
  end if;
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.escala'::regclass and c.conname = 'escala_taco_omitido_chk';
  if v_def is null or position('taco_llegada IS NULL' in v_def) = 0
     or position('btrim(taco_omitido_motivo)' in v_def) = 0 then
    raise exception 'VERIFICACIÓN 20261015000001: falta el CHECK escala_taco_omitido_chk (%)', v_def;
  end if;
  perform 1 from pg_constraint c
   where c.conrelid = 'public.escala'::regclass
     and c.conname = 'escala_taco_omitido_por_fkey' and c.contype = 'f' and c.confdeltype = 'n';
  if not found then
    raise exception 'VERIFICACIÓN 20261015000001: falta la FK escala_taco_omitido_por_fkey (acción set null)';
  end if;
end
$ver$;
-- <<< CUERPO

-- =====================================================================
-- ROLLBACK (SOLO desde el SQL Editor; antes exportar
--   select id, vuelo_id, taco_omitido_at, taco_omitido_por, taco_omitido_motivo
--     from public.escala where taco_omitido_at is not null;
-- y reiniciar el API después: la sonda memoriza el «sí»):
-- begin;
-- alter table public.escala drop constraint if exists escala_taco_omitido_chk;
-- alter table public.escala drop column if exists taco_omitido_motivo;
-- alter table public.escala drop column if exists taco_omitido_por;
-- alter table public.escala drop column if exists taco_omitido_at;
-- commit;
-- =====================================================================
