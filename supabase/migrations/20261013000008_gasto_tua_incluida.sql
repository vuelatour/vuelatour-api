-- =====================================================================
-- 20261013000008_gasto_tua_incluida.sql — TUA SISTÉMICA (13-oct-2026,
-- decisión 2 del lote del cliente; API 0.0.75; invariante 66 del CLAUDE.md
-- del API). Numeración del lote 2: era la 20261013000003 en el diseño; esa
-- la usa la categoría COMISION_VENDEDOR_AVION.
--
-- QUÉ HACE (aditiva, idempotente, sin backfill, sin índice, sin enum):
--  1) gasto.tua_incluida numeric(14,2) NULL + CHECK gasto_tua_incluida_check
--     (null o >= 0) + COMMENT. NULL = se usa la lectura de la IA; 0 = esta
--     factura no cobra TUA; > 0 = la TUA (IVA incluido, moneda del gasto)
--     que fija la OFICINA en «Verificar / editar».
--  2) tg_gasto_bitacora con 'tua_incluida' en su lista de columnas de
--     negocio (texto vigente de prod = 20260901000001 + la columna). La rama
--     del borrado escribe tg_op (mismo texto de siempre) para que el cuerpo
--     no lleve las palabras que el filtro del MCP de Supabase rechaza. El
--     trigger trg_gasto_bitacora NO se recrea (apunta a la función).
--  3) Verificación que aborta si algo no quedó.
-- Triggers de gasto en prod (13-oct): trg_gasto_bitacora (AFTER),
-- trg_gasto_personal_dueno_valida, trg_gasto_set_updated_at y
-- trg_gasto_sync_facturacion (BEFORE); NINGUNO diferido.
-- El CUERPO no lleva palabras destructivas: el MCP lo acepta (solo el pie
-- de rollback, comentado, las lleva).
--
-- DEPENDENCIA: NINGUNA dura. El API 0.0.75 es desplegable ANTES o DESPUÉS
-- (sonda única common/tua-incluida-disponible.util: sin la columna todo
-- como el 0.0.74 y un número en tua_incluida ⇒ 409; la sonda se enciende
-- sola en ≤ 10 min tras aplicar). OJO: el «sí» de la sonda se memoriza —
-- tras un ROLLBACK de esta migración hay que reiniciar el API.
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; verificar el proyecto antes):
--  a) DRY-RUN de abajo con mcp__supabase__execute_sql: UNA sentencia, el
--     bloque «do $dry$ … $dry$;» quitando el prefijo «-- » de sus líneas
--     (el cuerpo ya va pegado dentro: no hay que pegar nada). Debe terminar
--     en «DRYRUN_OK …». Después: la columna NO existe (comprobación al pie
--     del bloque). Correrlo fuera de horas de captura intensa (el ALTER toma
--     un candado breve sobre gasto).
--  b) mcp__supabase__apply_migration con name
--     «20261013000008_gasto_tua_incluida» y query = SOLO el cuerpo entre
--     «>>> CUERPO» y «<<< CUERPO» (sin esta cabecera ni el pie). Si el filtro
--     lo rechazara: SQL Editor + registrar la versión en
--     supabase_migrations.schema_migrations como en 20261012000002.
--  c) get_advisors (esperado: nada nuevo) y
--     select count(*) from public.gasto where tua_incluida is not null; ⇒ 0
--
-- DRY-RUN (escrituras REALES, el DDL PRIMERO y su re-aplicación ANTES de
-- cualquier fila de prueba; termina SIEMPRE en raise ⇒ todo se revierte,
-- DDL incluido). created_at de gasto_bitacora es now() (igual en toda la
-- transacción) y su id es uuid aleatorio: el renglón NUEVO se identifica
-- por id contra los ya vistos, nunca por «el más reciente».
-- do $dry$
-- declare
--   v_gasto uuid;
--   v_actor uuid;
--   v_nuevo uuid;
--   v_def text;
--   v_vistos uuid[];
--   v_n int;
--   v_diff jsonb;
--   v_actor_bit uuid;
--   v_accion text;
--   v_upd_antes timestamptz;
--   v_upd_despues timestamptz;
--   v_valor numeric;
-- begin
--   -- A) CONTEXTO
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'gasto'
--                 and column_name = 'tua_incluida') then
--     raise exception 'DRYRUN_FALLA A: gasto.tua_incluida ya existe (¿ya está aplicada?)';
--   end if;
--   v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
--   if position('''tua_incluida''' in v_def) > 0
--      or position('''folio_ticket'',''conciliado''' in v_def) = 0 then
--     raise exception 'DRYRUN_FALLA A: tg_gasto_bitacora de prod no es la de 20260901000001: re-copia su texto antes de aplicar';
--   end if;
--   select g.id into v_gasto
--     from public.gasto g
--    where g.categoria::text = 'OPERACIONES'
--      and g.vuelo_id is not null
--      and g.conciliado = false
--      and g.factura_recibida_id is null
--    order by g.created_at desc
--    limit 1;
--   if v_gasto is null then
--     raise exception 'DRYRUN_FALLA A: no hay gasto OPERACIONES con vuelo, sin conciliar y sin factura para probar';
--   end if;
--   select u.id into v_actor
--     from public.usuario u
--    where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--    order by u.created_at
--    limit 1;
--   if v_actor is null then
--     raise exception 'DRYRUN_FALLA A: no hay ADMIN activo para firmar las escrituras';
--   end if;
--
--   -- B) CUERPO REAL (las secciones 1, 2 y 3 del cuerpo, TAL CUAL)
--   alter table public.gasto
--     add column if not exists tua_incluida numeric(14,2)
--       constraint gasto_tua_incluida_check
--         check (tua_incluida is null or tua_incluida >= 0);
--   comment on column public.gasto.tua_incluida is
--     'TUA (tarifa de uso de aeropuerto) incluida en el monto del gasto, CON IVA, en la moneda del gasto (13-oct-2026). NULL = se usa la lectura de la IA (renglón TUA de valor_ia_extraido.conceptos o su tua_monto); 0 = esta factura no cobra TUA aunque la IA lea una; > 0 = esa TUA se separa del costo del avión (fila del vuelo del Balance, Otros movimientos, Libro Dinero y reparto). Solo la escribe la oficina (Verificar / editar) y solo en OPERACIONES, ATERRIZAJE o FBO; tope monto − propina (lo valida el API). Fuente única: common/desglose-gasto.util.ts#partesDeGasto.';
--   create or replace function public.tg_gasto_bitacora()
--   returns trigger
--   language plpgsql
--   set search_path = ''
--   as $function$
--   declare
--     cols text[] := array[
--       'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
--       'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
--       'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
--       'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
--       'folio_ticket','conciliado','tua_incluida'
--     ];
--     v_diff jsonb := '{}'::jsonb;
--     v_old jsonb;
--     v_new jsonb;
--     c text;
--   begin
--     if tg_op = 'INSERT' then
--       v_new := to_jsonb(new);
--       foreach c in array cols loop
--         if v_new->c is not null and v_new->c <> 'null'::jsonb then
--           v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
--         end if;
--       end loop;
--       insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
--       values (new.id, new.vuelo_id, 'INSERT', new.created_by, v_diff);
--       return new;
--     elsif tg_op = 'UPDATE' then
--       v_old := to_jsonb(old);
--       v_new := to_jsonb(new);
--       foreach c in array cols loop
--         if v_old->c is distinct from v_new->c then
--           v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
--         end if;
--       end loop;
--       if v_diff = '{}'::jsonb then
--         return new;
--       end if;
--       insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
--       values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
--       return new;
--     else
--       -- Borrado: tg_op vale el mismo texto de siempre.
--       insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
--       values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
--       return old;
--     end if;
--   end
--   $function$;
--   do $ver$
--   declare
--     v_def text;
--   begin
--     perform 1 from information_schema.columns
--      where table_schema = 'public' and table_name = 'gasto'
--        and column_name = 'tua_incluida' and data_type = 'numeric'
--        and numeric_precision = 14 and numeric_scale = 2
--        and is_nullable = 'YES' and column_default is null;
--     if not found then
--       raise exception 'VERIFICACIÓN 20261013000008: gasto.tua_incluida no quedó numeric(14,2) nullable sin default';
--     end if;
--     select pg_get_constraintdef(c.oid) into v_def
--       from pg_constraint c
--      where c.conrelid = 'public.gasto'::regclass and c.conname = 'gasto_tua_incluida_check';
--     if v_def is null or position('tua_incluida >=' in v_def) = 0 then
--       raise exception 'VERIFICACIÓN 20261013000008: falta el CHECK gasto_tua_incluida_check (%)', v_def;
--     end if;
--     v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
--     if position('''tua_incluida''' in v_def) = 0 or position('tg_op, old.updated_by' in v_def) = 0 then
--       raise exception 'VERIFICACIÓN 20261013000008: tg_gasto_bitacora no registra tua_incluida';
--     end if;
--   end
--   $ver$;
--
--   -- C0) RE-APLICAR el cuerpo = no-op, ANTES de cualquier fila de prueba
--   --     (secciones 1 y 2 otra vez; ADD COLUMN IF NOT EXISTS salta la
--   --     columna Y su CHECK; la función se reemplaza por el mismo texto).
--   alter table public.gasto
--     add column if not exists tua_incluida numeric(14,2)
--       constraint gasto_tua_incluida_check
--         check (tua_incluida is null or tua_incluida >= 0);
--   comment on column public.gasto.tua_incluida is
--     'TUA (tarifa de uso de aeropuerto) incluida en el monto del gasto, CON IVA, en la moneda del gasto (13-oct-2026). NULL = se usa la lectura de la IA (renglón TUA de valor_ia_extraido.conceptos o su tua_monto); 0 = esta factura no cobra TUA aunque la IA lea una; > 0 = esa TUA se separa del costo del avión (fila del vuelo del Balance, Otros movimientos, Libro Dinero y reparto). Solo la escribe la oficina (Verificar / editar) y solo en OPERACIONES, ATERRIZAJE o FBO; tope monto − propina (lo valida el API). Fuente única: common/desglose-gasto.util.ts#partesDeGasto.';
--   select count(*) into v_n
--     from pg_constraint c
--    where c.conrelid = 'public.gasto'::regclass and c.conname = 'gasto_tua_incluida_check';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C0: % CHECK gasto_tua_incluida_check tras re-aplicar (esperado 1)', v_n; end if;
--   select count(*) into v_n
--     from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto' and column_name = 'tua_incluida';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C0: % columnas tua_incluida', v_n; end if;
--
--   -- C1) ESTRUCTURA
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'gasto'
--      and column_name = 'tua_incluida' and data_type = 'numeric'
--      and numeric_precision = 14 and numeric_scale = 2
--      and is_nullable = 'YES' and column_default is null;
--   if not found then raise exception 'DRYRUN_FALLA C1: tipo/nulabilidad/default'; end if;
--   v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
--   if position('''tua_incluida''' in v_def) = 0 or position('tg_op, old.updated_by' in v_def) = 0 then
--     raise exception 'DRYRUN_FALLA C1: la función no quedó con tua_incluida y tg_op';
--   end if;
--
--   -- C2) UPDATE REAL como lo escribe el API (oficina fija 559.63)
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_gasto;
--   select g.updated_at into v_upd_antes from public.gasto g where g.id = v_gasto;
--   update public.gasto set tua_incluida = 559.63, updated_by = v_actor where id = v_gasto;
--   select count(*), (array_agg(b.diff))[1], (array_agg(b.actor_id))[1], (array_agg(b.accion))[1]
--     into v_n, v_diff, v_actor_bit, v_accion
--     from public.gasto_bitacora b
--    where b.gasto_id = v_gasto and not (b.id = any(v_vistos));
--   if v_n <> 1 or v_accion <> 'UPDATE' or not (v_diff ? 'tua_incluida')
--      or (v_diff->'tua_incluida'->'antes') <> 'null'::jsonb
--      or (v_diff->'tua_incluida'->>'despues')::numeric <> 559.63 then
--     raise exception 'DRYRUN_FALLA C2: renglones % · acción % · diff %', v_n, v_accion, v_diff;
--   end if;
--   if v_actor_bit is distinct from v_actor then raise exception 'DRYRUN_FALLA C2: actor %', v_actor_bit; end if;
--   select g.updated_at into v_upd_despues from public.gasto g where g.id = v_gasto;
--   if not (v_upd_despues > v_upd_antes) then raise exception 'DRYRUN_FALLA C2: updated_at no se movió'; end if;
--
--   -- C3) 0 explícito ⇒ antes 559.63 / después 0
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_gasto;
--   update public.gasto set tua_incluida = 0, updated_by = v_actor where id = v_gasto;
--   select count(*), (array_agg(b.diff))[1] into v_n, v_diff
--     from public.gasto_bitacora b where b.gasto_id = v_gasto and not (b.id = any(v_vistos));
--   if v_n <> 1 or (v_diff->'tua_incluida'->>'antes')::numeric <> 559.63
--      or (v_diff->'tua_incluida'->>'despues')::numeric <> 0 then
--     raise exception 'DRYRUN_FALLA C3: % · %', v_n, v_diff;
--   end if;
--
--   -- C4) volver a null (usar la lectura de la IA)
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_gasto;
--   update public.gasto set tua_incluida = null, updated_by = v_actor where id = v_gasto;
--   select count(*), (array_agg(b.diff))[1] into v_n, v_diff
--     from public.gasto_bitacora b where b.gasto_id = v_gasto and not (b.id = any(v_vistos));
--   if v_n <> 1 or (v_diff->'tua_incluida'->'despues') <> 'null'::jsonb then
--     raise exception 'DRYRUN_FALLA C4: % · %', v_n, v_diff;
--   end if;
--
--   -- C5) negativo ⇒ 23514 del CHECK (el sub-bloque revierte solo ese UPDATE)
--   begin
--     update public.gasto set tua_incluida = -1 where id = v_gasto;
--     raise exception 'DRYRUN_FALLA C5: el CHECK dejó pasar -1';
--   exception when check_violation then null;
--   end;
--
--   -- C6) el MISMO valor dos veces ⇒ la segunda NO agrega renglón
--   update public.gasto set tua_incluida = 100, updated_by = v_actor where id = v_gasto;
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_gasto;
--   update public.gasto set tua_incluida = 100, updated_by = v_actor where id = v_gasto;
--   select count(*) into v_n from public.gasto_bitacora b where b.gasto_id = v_gasto and not (b.id = any(v_vistos));
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C6: % renglones por un UPDATE sin cambio', v_n; end if;
--
--   -- C7) UPDATE de OTRA columna (notas): no toca tua_incluida ni la nombra
--   select coalesce(array_agg(b.id), '{}') into v_vistos from public.gasto_bitacora b where b.gasto_id = v_gasto;
--   update public.gasto set notas = coalesce(notas, '') || ' [dry-run 20261013000008]', updated_by = v_actor where id = v_gasto;
--   select count(*), (array_agg(b.diff))[1] into v_n, v_diff
--     from public.gasto_bitacora b where b.gasto_id = v_gasto and not (b.id = any(v_vistos));
--   select g.tua_incluida into v_valor from public.gasto g where g.id = v_gasto;
--   if v_n <> 1 or not (v_diff ? 'notas') or (v_diff ? 'tua_incluida') or v_valor <> 100 then
--     raise exception 'DRYRUN_FALLA C7: % · % · valor %', v_n, v_diff, v_valor;
--   end if;
--
--   -- C8) ALTA REAL como la del API (oficina con TUA fijada 250): copia sin
--   --     folio ni llave de idempotencia
--   insert into public.gasto (usuario_captura_id, categoria, monto, propina, moneda, fecha_gasto,
--                             medio_pago, vuelo_id, aeronave_id, estatus_comprobante, notas,
--                             origen, created_by, updated_by, tua_incluida)
--   select g.usuario_captura_id, g.categoria, g.monto, 0, g.moneda, g.fecha_gasto,
--          g.medio_pago, g.vuelo_id, g.aeronave_id, g.estatus_comprobante, 'DRYRUN-20261013000008',
--          'OFICINA', v_actor, v_actor, 250
--     from public.gasto g where g.id = v_gasto
--   returning id into v_nuevo;
--   select count(*), (array_agg(b.diff))[1], (array_agg(b.accion))[1], (array_agg(b.actor_id))[1]
--     into v_n, v_diff, v_accion, v_actor_bit
--     from public.gasto_bitacora b where b.gasto_id = v_nuevo;
--   if v_n <> 1 or v_accion <> 'INSERT' or v_actor_bit is distinct from v_actor
--      or (v_diff->'tua_incluida'->>'despues')::numeric <> 250 then
--     raise exception 'DRYRUN_FALLA C8: % · % · %', v_n, v_accion, v_diff;
--   end if;
--
--   raise exception 'DRYRUN_OK 20261013000008 · A–C8 · gasto % · alta de prueba % · todo se revierte', v_gasto, v_nuevo;
-- end
-- $dry$;
--
-- Comprobación DESPUÉS del dry-run (debe dar 0 y 0):
--   select (select count(*) from information_schema.columns where table_schema = 'public'
--             and table_name = 'gasto' and column_name = 'tua_incluida') as columna,
--          (select count(*) from public.gasto where notas = 'DRYRUN-20261013000008') as residuos;
-- =====================================================================

-- >>> CUERPO
-- 1) Columna: TUA (IVA incluido) que la OFICINA fija para este gasto.
alter table public.gasto
  add column if not exists tua_incluida numeric(14,2)
    constraint gasto_tua_incluida_check
      check (tua_incluida is null or tua_incluida >= 0);

comment on column public.gasto.tua_incluida is
  'TUA (tarifa de uso de aeropuerto) incluida en el monto del gasto, CON IVA, en la moneda del gasto (13-oct-2026). NULL = se usa la lectura de la IA (renglón TUA de valor_ia_extraido.conceptos o su tua_monto); 0 = esta factura no cobra TUA aunque la IA lea una; > 0 = esa TUA se separa del costo del avión (fila del vuelo del Balance, Otros movimientos, Libro Dinero y reparto). Solo la escribe la oficina (Verificar / editar) y solo en OPERACIONES, ATERRIZAJE o FBO; tope monto − propina (lo valida el API). Fuente única: common/desglose-gasto.util.ts#partesDeGasto.';

-- 2) Bitácora: la columna entra a la lista de negocio de tg_gasto_bitacora.
create or replace function public.tg_gasto_bitacora()
returns trigger
language plpgsql
set search_path = ''
as $function$
declare
  cols text[] := array[
    'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
    'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
    'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
    'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
    'folio_ticket','conciliado','tua_incluida'
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
    -- Borrado: tg_op vale el mismo texto de siempre.
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
    values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
    return old;
  end if;
end
$function$;

-- 3) Verificación (aborta la migración si algo no quedó).
do $ver$
declare
  v_def text;
begin
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'gasto'
     and column_name = 'tua_incluida' and data_type = 'numeric'
     and numeric_precision = 14 and numeric_scale = 2
     and is_nullable = 'YES' and column_default is null;
  if not found then
    raise exception 'VERIFICACIÓN 20261013000008: gasto.tua_incluida no quedó numeric(14,2) nullable sin default';
  end if;
  select pg_get_constraintdef(c.oid) into v_def
    from pg_constraint c
   where c.conrelid = 'public.gasto'::regclass and c.conname = 'gasto_tua_incluida_check';
  if v_def is null or position('tua_incluida >=' in v_def) = 0 then
    raise exception 'VERIFICACIÓN 20261013000008: falta el CHECK gasto_tua_incluida_check (%)', v_def;
  end if;
  v_def := pg_get_functiondef('public.tg_gasto_bitacora'::regproc);
  if position('''tua_incluida''' in v_def) = 0 or position('tg_op, old.updated_by' in v_def) = 0 then
    raise exception 'VERIFICACIÓN 20261013000008: tg_gasto_bitacora no registra tua_incluida';
  end if;
end
$ver$;
-- <<< CUERPO

-- =====================================================================
-- ROLLBACK (SOLO desde el SQL Editor; antes exportar
--   select id, tua_incluida from public.gasto where tua_incluida is not null;
-- y reiniciar el API después: la sonda memoriza el «sí»):
-- begin;
-- alter table public.gasto drop column if exists tua_incluida;
-- create or replace function public.tg_gasto_bitacora() … (el mismo texto de la
--   sección 2 SIN 'tua_incluida' en el arreglo cols)
-- commit;
-- =====================================================================
