-- =====================================================================
-- 20261019000001_gasto_por_pagar.sql — GASTOS «POR PAGAR» (FECHA A FUTURO)
-- (19-oct-2026, API 0.0.95; invariante 93 del CLAUDE.md del API).
--
-- PEDIDO DEL CLIENTE (19-oct-2026, captura de «Gasto rápido» de la app):
-- «que se puedan capturar gastos a futuro en la app y en el admin, a veces
-- yo anoto cosas que ya sé que voy a pagar en efectivo al día siguiente
-- para que no se me olvide». Decisiones (no se vuelven a preguntar): hasta
-- fin de mes, para todos los roles, con estado «por pagar». La fecha del
-- gasto sigue siendo la FECHA DEL PAGO (decisión del 13-oct-2026): un gasto
-- con fecha futura nace «por pagar» y se confirma con «Marcar pagado».
--
-- QUÉ HACE (aditiva, idempotente, SIN backfill, sin CHECK con «hoy» — la
-- regla del tiempo la impone el API al escribir; ninguna sentencia
-- destructiva, ni en el texto del cuerpo: el MCP lo acepta):
--  1) gasto.por_pagar boolean NOT NULL DEFAULT false + COMMENT + índice
--     parcial gasto_por_pagar_idx (fecha_gasto) WHERE por_pagar. Todas las
--     filas existentes quedan en false (pagadas) ⇒ ningún número cambia.
--  2) tg_gasto_bitacora con 'por_pagar' en su lista de columnas de negocio
--     (texto VIGENTE en prod = el de 20261016000005, leído con
--     pg_get_functiondef el 19-oct-2026, + la columna): «quién lo marcó
--     pagado» queda en la bitácora con actor = updated_by. El trigger
--     trg_gasto_bitacora NO se recrea.
--  3) Verificación que aborta si la columna, el índice o la función no
--     quedaron.
-- Triggers de gasto en prod (19-oct): trg_gasto_bitacora (AFTER),
-- trg_gasto_factura_principal_en_puente (AFTER), trg_gasto_pago_afac_solo_
-- permiso, trg_gasto_personal_dueno_valida, trg_gasto_set_updated_at y
-- trg_gasto_sync_facturacion (BEFORE); NINGUNO diferido.
--
-- DEPENDENCIA: NINGUNA dura. El API 0.0.95 sondea gasto.por_pagar (sonda
-- ÚNICA common/por-pagar-disponible.util): sin la columna todo como el
-- 0.0.94 (límites de fecha de siempre, `config.gastos_por_pagar: false`,
-- `por_pagar: true` en un alta/PATCH ⇒ 503 POR_PAGAR_NO_DISPONIBLE). Con la
-- migración y un API ≤ 0.0.94 no cambia nada (columna en false que nadie
-- lee). El «sí» de la sonda se memoriza: tras un ROLLBACK hay que
-- reiniciar el API.
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar con un SELECT —
-- p. ej. `select max(folio) from vuelo` ≈ 468 el 19-oct-2026):
--  a) DRY-RUN de abajo con mcp__supabase__execute_sql: UNA sentencia, el
--     bloque «do $dry$ … $dry$;» quitando el prefijo «-- » de sus líneas
--     (el cuerpo ya va pegado dentro, dos veces: B y su re-aplicación C0).
--     Debe terminar en «ERROR: P0001: DRYRUN_OK 20261019000001 · A–C6 …».
--     Cualquier otro error ⇒ NO aplicar. Después, la comprobación del pie
--     del bloque debe dar 0 / 0 / 0 / 0.
--  b) mcp__supabase__apply_migration con name «20261019000001_gasto_por_pagar»
--     y query = SOLO el texto entre «>>> CUERPO» y «<<< CUERPO».
--     PLAN B (si respondiera {"status":"declined"}): SQL Editor, en UNA
--     corrida: begin; <CUERPO>; insert into supabase_migrations.
--     schema_migrations (version, name, statements) values
--     ('20261019000001', 'gasto_por_pagar', array['-- aplicada desde el SQL
--     Editor: ver supabase/migrations/20261019000001_gasto_por_pagar.sql'])
--     on conflict (version) do nothing; commit;
--  c) POSTCHECK (debe dar columna 1, indice 1, por_pagar 0, funcion > 0):
--       select (select count(*) from information_schema.columns
--                where table_schema = 'public' and table_name = 'gasto'
--                  and column_name = 'por_pagar') as columna,
--              (select count(*) from pg_class where relname = 'gasto_por_pagar_idx') as indice,
--              (select count(*) from public.gasto where por_pagar) as por_pagar,
--              position('''por_pagar''' in pg_get_functiondef('public.tg_gasto_bitacora'::regproc)) as funcion;
--  d) get_advisors (security y performance; esperado: nada nuevo).
--
-- RESULTADO DEL DRY-RUN EN PROD (19-oct-2026 ~10:40 Cancún, por MCP
-- execute_sql): «DRYRUN_OK 20261019000001 · A–C6 · base 801276f9-… · alta
-- de prueba 921944ed-… · todo se revierte»; comprobación posterior: columna
-- 0, índice 0, residuos 0, bitácora de la alta de prueba 0, la función sin
-- 'por_pagar', 1,197 gastos (igual que antes).
--
-- DRY-RUN (escrituras REALES; el DDL PRIMERO y su re-aplicación ANTES de
-- cualquier fila de prueba; termina SIEMPRE en raise ⇒ todo se revierte,
-- DDL incluido). El renglón NUEVO de la bitácora se identifica por id
-- contra los ya vistos, nunca por «el más reciente» (created_at = now(),
-- igual en toda la transacción).
-- do $dry$
-- declare
--   v_base uuid;
--   v_actor uuid;
--   v_actor2 uuid;
--   v_nuevo uuid;
--   v_def text;
--   v_vistos uuid[];
--   v_n int;
--   v_diff jsonb;
--   v_actor_bit uuid;
--   v_accion text;
--   v_hoy date := (now() at time zone 'America/Cancun')::date;
--   v_valor boolean;
--   v_fecha date;
-- begin
--   -- A) CONTEXTO (solo lectura)
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'gasto'
--                 and column_name = 'por_pagar') then
--     raise exception 'DRYRUN_FALLA A: gasto.por_pagar ya existe (¿ya está aplicada?)';
--   end if;
--   v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
--   if position('''por_pagar''' in v_def) > 0
--      or position('''tua_incluida'',''es_pago_afac''' in v_def) = 0
--      or position('tg_op, old.updated_by' in v_def) = 0 then
--     raise exception 'DRYRUN_FALLA A: tg_gasto_bitacora de prod no es la de 20261016000005: re-copia su texto antes de aplicar';
--   end if;
--   -- Un gasto EFECTIVO sin conciliar, sin folio y sin factura (se COPIA; el
--   -- original no se toca).
--   select g.id into v_base
--     from public.gasto g
--    where g.medio_pago::text = 'EFECTIVO'
--      and g.conciliado = false
--      and g.factura_recibida_id is null
--      and g.categoria::text not in ('PERSONAL_DUENO', 'COMISION_VENDEDOR', 'COMISION_VENDEDOR_AVION', 'PERMISO')
--    order by g.created_at desc
--    limit 1;
--   if v_base is null then
--     raise exception 'DRYRUN_FALLA A: no hay gasto EFECTIVO sin conciliar ni factura para copiar';
--   end if;
--   select u.id into v_actor
--     from public.usuario u
--    where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--    order by u.created_at
--    limit 1;
--   select u.id into v_actor2
--     from public.usuario u
--    where u.estado::text = 'ACTIVO' and u.id <> v_actor
--    order by u.created_at
--    limit 1;
--   if v_actor is null or v_actor2 is null then
--     raise exception 'DRYRUN_FALLA A: faltan dos usuarios activos para firmar las escrituras';
--   end if;
--
--   -- B) CUERPO REAL (secciones 1, 2 y 3 del cuerpo, TAL CUAL)
-- -- 1) Columna: el gasto todavía NO se paga (fecha a futuro) -----------------
-- alter table public.gasto
--   add column if not exists por_pagar boolean not null default false;
--
-- comment on column public.gasto.por_pagar is
--   'Gasto «por pagar» (20261019000001, API 0.0.95, invariante 93 del CLAUDE.md del API). true = se capturó ANTES de pagarse (fecha a futuro, hasta fin de mes); se confirma con «Marcar pagado» (PATCH por_pagar=false con la fecha REAL del pago, ≤ hoy). false (default) = pagado: todas las filas anteriores a la migración. El API escribe la regla al guardar (fecha > hoy Cancún ⇒ true); el tiempo avanza solo: true con fecha < hoy = VENCIDO. Estado de pago (fuente única expenses/por-pagar.util#estadoPagoGasto): conciliado ⇒ PAGADO (el banco prueba el pago); si no, por_pagar ⇒ POR_PAGAR / VENCIDO. Un EFECTIVO por pagar no entra al libro de caja chica hasta marcarse pagado. Balance, reparto y Libro Dinero NO lo leen (cuenta en el mes de su fecha como cualquier gasto); el pre-cierre lo BLOQUEA (gastos_por_pagar).';
--
-- create index if not exists gasto_por_pagar_idx
--   on public.gasto (fecha_gasto)
--   where por_pagar;
--
-- -- 2) Bitácora: la columna entra a la lista de negocio de tg_gasto_bitacora
-- --    (texto VIGENTE en prod el 19-oct-2026 = el de 20261016000005 + la
-- --    columna; quién lo marcó pagado queda con actor = updated_by). El
-- --    trigger trg_gasto_bitacora NO se recrea (apunta a la función).
-- create or replace function public.tg_gasto_bitacora()
--  returns trigger
--  language plpgsql
--  set search_path to ''
-- as $function$
-- declare
--   cols text[] := array[
--     'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
--     'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
--     'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
--     'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
--     'folio_ticket','conciliado','tua_incluida','es_pago_afac','por_pagar'
--   ];
--   v_diff jsonb := '{}'::jsonb;
--   v_old jsonb;
--   v_new jsonb;
--   c text;
-- begin
--   if tg_op = 'INSERT' then
--     v_new := to_jsonb(new);
--     foreach c in array cols loop
--       if v_new->c is not null and v_new->c <> 'null'::jsonb then
--         v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
--       end if;
--     end loop;
--     insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
--     values (new.id, new.vuelo_id, 'INSERT', new.created_by, v_diff);
--     return new;
--   elsif tg_op = 'UPDATE' then
--     v_old := to_jsonb(old);
--     v_new := to_jsonb(new);
--     foreach c in array cols loop
--       if v_old->c is distinct from v_new->c then
--         v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
--       end if;
--     end loop;
--     if v_diff = '{}'::jsonb then
--       return new;
--     end if;
--     insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
--     values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
--     return new;
--   else
--     -- Baja del gasto: tg_op vale el mismo texto de siempre.
--     insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
--     values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
--     return old;
--   end if;
-- end
-- $function$;
--
-- -- 3) Verificación (aborta la migración si algo no quedó) -------------------
-- do $ver$
-- declare
--   v_def text;
-- begin
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto'
--      and column_name = 'por_pagar' and data_type = 'boolean'
--      and is_nullable = 'NO' and column_default = 'false';
--   if not found then
--     raise exception 'VERIFICACION 20261019000001: gasto.por_pagar no quedó boolean NOT NULL DEFAULT false';
--   end if;
--   select pg_get_indexdef(i.indexrelid) into v_def
--     from pg_index i
--     join pg_class c on c.oid = i.indexrelid
--    where i.indrelid = 'public.gasto'::regclass and c.relname = 'gasto_por_pagar_idx';
--   if v_def is null or position('WHERE por_pagar' in v_def) = 0 or position('(fecha_gasto)' in v_def) = 0 then
--     raise exception 'VERIFICACION 20261019000001: falta el índice parcial gasto_por_pagar_idx (%)', v_def;
--   end if;
--   v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
--   if position('''por_pagar''' in v_def) = 0
--      or position('''es_pago_afac''' in v_def) = 0
--      or position('''tua_incluida''' in v_def) = 0
--      or position('tg_op, old.updated_by' in v_def) = 0 then
--     raise exception 'VERIFICACION 20261019000001: tg_gasto_bitacora no registra por_pagar (o perdió tua_incluida / es_pago_afac)';
--   end if;
-- end
-- $ver$;
--
--   -- C0) RE-APLICAR el cuerpo = no-op, ANTES de cualquier fila de prueba
--   --     (ADD COLUMN / CREATE INDEX IF NOT EXISTS saltan; la función se
--   --     reemplaza por el mismo texto).
-- -- 1) Columna: el gasto todavía NO se paga (fecha a futuro) -----------------
-- alter table public.gasto
--   add column if not exists por_pagar boolean not null default false;
--
-- comment on column public.gasto.por_pagar is
--   'Gasto «por pagar» (20261019000001, API 0.0.95, invariante 93 del CLAUDE.md del API). true = se capturó ANTES de pagarse (fecha a futuro, hasta fin de mes); se confirma con «Marcar pagado» (PATCH por_pagar=false con la fecha REAL del pago, ≤ hoy). false (default) = pagado: todas las filas anteriores a la migración. El API escribe la regla al guardar (fecha > hoy Cancún ⇒ true); el tiempo avanza solo: true con fecha < hoy = VENCIDO. Estado de pago (fuente única expenses/por-pagar.util#estadoPagoGasto): conciliado ⇒ PAGADO (el banco prueba el pago); si no, por_pagar ⇒ POR_PAGAR / VENCIDO. Un EFECTIVO por pagar no entra al libro de caja chica hasta marcarse pagado. Balance, reparto y Libro Dinero NO lo leen (cuenta en el mes de su fecha como cualquier gasto); el pre-cierre lo BLOQUEA (gastos_por_pagar).';
--
-- create index if not exists gasto_por_pagar_idx
--   on public.gasto (fecha_gasto)
--   where por_pagar;
--
-- -- 2) Bitácora: la columna entra a la lista de negocio de tg_gasto_bitacora
-- --    (texto VIGENTE en prod el 19-oct-2026 = el de 20261016000005 + la
-- --    columna; quién lo marcó pagado queda con actor = updated_by). El
-- --    trigger trg_gasto_bitacora NO se recrea (apunta a la función).
-- create or replace function public.tg_gasto_bitacora()
--  returns trigger
--  language plpgsql
--  set search_path to ''
-- as $function$
-- declare
--   cols text[] := array[
--     'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
--     'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
--     'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
--     'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
--     'folio_ticket','conciliado','tua_incluida','es_pago_afac','por_pagar'
--   ];
--   v_diff jsonb := '{}'::jsonb;
--   v_old jsonb;
--   v_new jsonb;
--   c text;
-- begin
--   if tg_op = 'INSERT' then
--     v_new := to_jsonb(new);
--     foreach c in array cols loop
--       if v_new->c is not null and v_new->c <> 'null'::jsonb then
--         v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
--       end if;
--     end loop;
--     insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
--     values (new.id, new.vuelo_id, 'INSERT', new.created_by, v_diff);
--     return new;
--   elsif tg_op = 'UPDATE' then
--     v_old := to_jsonb(old);
--     v_new := to_jsonb(new);
--     foreach c in array cols loop
--       if v_old->c is distinct from v_new->c then
--         v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
--       end if;
--     end loop;
--     if v_diff = '{}'::jsonb then
--       return new;
--     end if;
--     insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
--     values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
--     return new;
--   else
--     -- Baja del gasto: tg_op vale el mismo texto de siempre.
--     insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
--     values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
--     return old;
--   end if;
-- end
-- $function$;
--
-- -- 3) Verificación (aborta la migración si algo no quedó) -------------------
-- do $ver$
-- declare
--   v_def text;
-- begin
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto'
--      and column_name = 'por_pagar' and data_type = 'boolean'
--      and is_nullable = 'NO' and column_default = 'false';
--   if not found then
--     raise exception 'VERIFICACION 20261019000001: gasto.por_pagar no quedó boolean NOT NULL DEFAULT false';
--   end if;
--   select pg_get_indexdef(i.indexrelid) into v_def
--     from pg_index i
--     join pg_class c on c.oid = i.indexrelid
--    where i.indrelid = 'public.gasto'::regclass and c.relname = 'gasto_por_pagar_idx';
--   if v_def is null or position('WHERE por_pagar' in v_def) = 0 or position('(fecha_gasto)' in v_def) = 0 then
--     raise exception 'VERIFICACION 20261019000001: falta el índice parcial gasto_por_pagar_idx (%)', v_def;
--   end if;
--   v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
--   if position('''por_pagar''' in v_def) = 0
--      or position('''es_pago_afac''' in v_def) = 0
--      or position('''tua_incluida''' in v_def) = 0
--      or position('tg_op, old.updated_by' in v_def) = 0 then
--     raise exception 'VERIFICACION 20261019000001: tg_gasto_bitacora no registra por_pagar (o perdió tua_incluida / es_pago_afac)';
--   end if;
-- end
-- $ver$;
--   select count(*) into v_n
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto' and column_name = 'por_pagar';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C0: % columnas por_pagar', v_n; end if;
--   select count(*) into v_n
--     from pg_index i join pg_class c on c.oid = i.indexrelid
--    where i.indrelid = 'public.gasto'::regclass and c.relname = 'gasto_por_pagar_idx';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C0: % índices gasto_por_pagar_idx', v_n; end if;
--
--   -- C1) SIN BACKFILL: todas las filas existentes quedan pagadas (false)
--   select count(*) into v_n from public.gasto where por_pagar;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C1: % gastos nacieron por pagar', v_n; end if;
--
--   -- C2) ALTA REAL como la del API: copia del gasto base con fecha a futuro y
--   --     por_pagar = true (sin folio ni llave de idempotencia)
--   insert into public.gasto (usuario_captura_id, categoria, monto, propina, moneda, fecha_gasto,
--                             medio_pago, vuelo_id, aeronave_id, estatus_comprobante, notas,
--                             origen, created_by, updated_by, por_pagar)
--   select g.usuario_captura_id, g.categoria, g.monto, 0, g.moneda, v_hoy + 3,
--          g.medio_pago, g.vuelo_id, g.aeronave_id, g.estatus_comprobante, 'DRYRUN-20261019000001',
--          'OFICINA', v_actor, v_actor, true
--     from public.gasto g where g.id = v_base
--   returning id into v_nuevo;
--   select count(*), (array_agg(b.diff))[1], (array_agg(b.accion))[1], (array_agg(b.actor_id))[1]
--     into v_n, v_diff, v_accion, v_actor_bit
--     from public.gasto_bitacora b where b.gasto_id = v_nuevo;
--   if v_n <> 1 or v_accion <> 'INSERT' or v_actor_bit is distinct from v_actor
--      or (v_diff->'por_pagar'->>'despues') is distinct from 'true' then
--     raise exception 'DRYRUN_FALLA C2: % · % · %', v_n, v_accion, v_diff;
--   end if;
--   select count(*) into v_n from public.gasto where por_pagar and id = v_nuevo;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C2: el alta no quedó por pagar'; end if;
--
--   -- C3) «MARCAR PAGADO» REAL como el PATCH del API: por_pagar = false con
--   --     la fecha REAL del pago (hoy) y OTRO actor ⇒ bitácora UPDATE con
--   --     por_pagar y fecha_gasto en el diff y actor = updated_by
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_nuevo;
--   update public.gasto set por_pagar = false, fecha_gasto = v_hoy, updated_by = v_actor2 where id = v_nuevo;
--   select count(*), (array_agg(b.diff))[1], (array_agg(b.accion))[1], (array_agg(b.actor_id))[1]
--     into v_n, v_diff, v_accion, v_actor_bit
--     from public.gasto_bitacora b where b.gasto_id = v_nuevo and not (b.id = any(v_vistos));
--   if v_n <> 1 or v_accion <> 'UPDATE'
--      or (v_diff->'por_pagar'->>'antes') is distinct from 'true'
--      or (v_diff->'por_pagar'->>'despues') is distinct from 'false'
--      or (v_diff->'fecha_gasto'->>'despues') is distinct from v_hoy::text then
--     raise exception 'DRYRUN_FALLA C3: % · % · %', v_n, v_accion, v_diff;
--   end if;
--   if v_actor_bit is distinct from v_actor2 then raise exception 'DRYRUN_FALLA C3: actor %', v_actor_bit; end if;
--
--   -- C4) re-programar (por_pagar = true otra vez, misma fecha) ⇒ solo
--   --     por_pagar en el diff
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_nuevo;
--   update public.gasto set por_pagar = true, updated_by = v_actor where id = v_nuevo;
--   select count(*), (array_agg(b.diff))[1] into v_n, v_diff
--     from public.gasto_bitacora b where b.gasto_id = v_nuevo and not (b.id = any(v_vistos));
--   if v_n <> 1 or (select count(*) from jsonb_object_keys(v_diff)) <> 1
--      or (v_diff->'por_pagar'->>'despues') is distinct from 'true' then
--     raise exception 'DRYRUN_FALLA C4: % · %', v_n, v_diff;
--   end if;
--
--   -- C5) el MISMO valor otra vez ⇒ sin renglón; un UPDATE de notas no
--   --     nombra por_pagar ni lo cambia
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_nuevo;
--   update public.gasto set por_pagar = true, updated_by = v_actor where id = v_nuevo;
--   select count(*) into v_n from public.gasto_bitacora b where b.gasto_id = v_nuevo and not (b.id = any(v_vistos));
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C5: % renglones por un UPDATE sin cambio', v_n; end if;
--   update public.gasto set notas = 'DRYRUN-20261019000001 · notas', updated_by = v_actor where id = v_nuevo;
--   select count(*), (array_agg(b.diff))[1] into v_n, v_diff
--     from public.gasto_bitacora b where b.gasto_id = v_nuevo and not (b.id = any(v_vistos));
--   select g.por_pagar, g.fecha_gasto into v_valor, v_fecha from public.gasto g where g.id = v_nuevo;
--   if v_n <> 1 or not (v_diff ? 'notas') or (v_diff ? 'por_pagar') or v_valor is not true or v_fecha <> v_hoy then
--     raise exception 'DRYRUN_FALLA C5: % · % · % · %', v_n, v_diff, v_valor, v_fecha;
--   end if;
--
--   -- C6) el índice parcial ve SOLO la fila por pagar (la de prueba)
--   select count(*) into v_n from public.gasto where por_pagar and fecha_gasto >= v_hoy - 400;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C6: % filas por pagar (esperada 1)', v_n; end if;
--
--   raise exception 'DRYRUN_OK 20261019000001 · A–C6 · base % · alta de prueba % · todo se revierte', v_base, v_nuevo;
-- end
-- $dry$;
--
-- Comprobación DESPUÉS del dry-run (debe dar 0 / 0 / 0 / 0):
--   select (select count(*) from information_schema.columns where table_schema = 'public'
--             and table_name = 'gasto' and column_name = 'por_pagar') as columna,
--          (select count(*) from pg_class where relname = 'gasto_por_pagar_idx') as indice,
--          (select count(*) from public.gasto where notas like 'DRYRUN-20261019000001%') as residuos,
--          position('''por_pagar''' in pg_get_functiondef('public.tg_gasto_bitacora'::regproc)) as funcion;
-- =====================================================================

-- >>> CUERPO
-- 1) Columna: el gasto todavía NO se paga (fecha a futuro) -----------------
alter table public.gasto
  add column if not exists por_pagar boolean not null default false;

comment on column public.gasto.por_pagar is
  'Gasto «por pagar» (20261019000001, API 0.0.95, invariante 93 del CLAUDE.md del API). true = se capturó ANTES de pagarse (fecha a futuro, hasta fin de mes); se confirma con «Marcar pagado» (PATCH por_pagar=false con la fecha REAL del pago, ≤ hoy). false (default) = pagado: todas las filas anteriores a la migración. El API escribe la regla al guardar (fecha > hoy Cancún ⇒ true); el tiempo avanza solo: true con fecha < hoy = VENCIDO. Estado de pago (fuente única expenses/por-pagar.util#estadoPagoGasto): conciliado ⇒ PAGADO (el banco prueba el pago); si no, por_pagar ⇒ POR_PAGAR / VENCIDO. Un EFECTIVO por pagar no entra al libro de caja chica hasta marcarse pagado. Balance, reparto y Libro Dinero NO lo leen (cuenta en el mes de su fecha como cualquier gasto); el pre-cierre lo BLOQUEA (gastos_por_pagar).';

create index if not exists gasto_por_pagar_idx
  on public.gasto (fecha_gasto)
  where por_pagar;

-- 2) Bitácora: la columna entra a la lista de negocio de tg_gasto_bitacora
--    (texto VIGENTE en prod el 19-oct-2026 = el de 20261016000005 + la
--    columna; quién lo marcó pagado queda con actor = updated_by). El
--    trigger trg_gasto_bitacora NO se recrea (apunta a la función).
create or replace function public.tg_gasto_bitacora()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  cols text[] := array[
    'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
    'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
    'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
    'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
    'folio_ticket','conciliado','tua_incluida','es_pago_afac','por_pagar'
  ];
  v_diff jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
  c text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    foreach c in array cols loop
      if v_new->c is not null and v_new->c <> 'null'::jsonb then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
      end if;
    end loop;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, new.vuelo_id, 'INSERT', new.created_by, v_diff);
    return new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    foreach c in array cols loop
      if v_old->c is distinct from v_new->c then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      return new;
    end if;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
    return new;
  else
    -- Baja del gasto: tg_op vale el mismo texto de siempre.
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
    values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
    return old;
  end if;
end
$function$;

-- 3) Verificación (aborta la migración si algo no quedó) -------------------
do $ver$
declare
  v_def text;
begin
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'gasto'
     and column_name = 'por_pagar' and data_type = 'boolean'
     and is_nullable = 'NO' and column_default = 'false';
  if not found then
    raise exception 'VERIFICACION 20261019000001: gasto.por_pagar no quedó boolean NOT NULL DEFAULT false';
  end if;
  select pg_get_indexdef(i.indexrelid) into v_def
    from pg_index i
    join pg_class c on c.oid = i.indexrelid
   where i.indrelid = 'public.gasto'::regclass and c.relname = 'gasto_por_pagar_idx';
  if v_def is null or position('WHERE por_pagar' in v_def) = 0 or position('(fecha_gasto)' in v_def) = 0 then
    raise exception 'VERIFICACION 20261019000001: falta el índice parcial gasto_por_pagar_idx (%)', v_def;
  end if;
  v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
  if position('''por_pagar''' in v_def) = 0
     or position('''es_pago_afac''' in v_def) = 0
     or position('''tua_incluida''' in v_def) = 0
     or position('tg_op, old.updated_by' in v_def) = 0 then
    raise exception 'VERIFICACION 20261019000001: tg_gasto_bitacora no registra por_pagar (o perdió tua_incluida / es_pago_afac)';
  end if;
end
$ver$;
-- <<< CUERPO

-- =====================================================================
-- ROLLBACK (SOLO desde el SQL Editor y con confirmación; ANTES bajar el API
-- a 0.0.94 o reiniciarlo después —la sonda memoriza el «sí»— y exportar
--   select id, fecha_gasto, monto, moneda, created_by from public.gasto where por_pagar;
-- porque esos gastos quedarían como PAGADOS):
-- begin;
-- (quitar la columna por_pagar de public.gasto; el índice parcial se va con
--  ella)
-- create or replace function public.tg_gasto_bitacora() … (el mismo texto
--   de la sección 2 SIN 'por_pagar' en el arreglo cols)
-- commit;
-- =====================================================================
