-- =====================================================================
-- 20261013000005_ingreso_aeronave_resultado.sql — INGRESO ASIGNADO A UN
-- AVIÓN (13-oct-2026, API 0.0.75, invariante 67 del CLAUDE.md del API;
-- punto «ingreso por avión» del lote 2 del 13-oct-2026).
--
-- PEDIDO: un ingreso registrado en Ingresos con avión (reembolso del
-- servicio de un avión, venta de una pieza suya…) cuenta para ESE avión:
-- hoja «Otros ingresos» de su balance, línea «(+) OTROS INGRESOS USD» de su
-- cascada y su reparto a socios; deja de ser ingreso de VuelaTour.
--
-- QUÉ HACE (aditiva, idempotente, sin backfill, sin índice, sin enum, sin
-- triggers nuevos):
--  1) CHECK ingreso_aeronave_chk: aeronave_id is null o la categoría SUMA A
--     RESULTADOS (OTRO_INGRESO, INGRESO_BANCARIO, REEMBOLSO_DEVOLUCION,
--     VENTA_ACTIVO) — espejo de categoriaIngresoAdmiteAvion del API (≡
--     categoriaIngresoSumaAResultados). Un anticipo cuenta como cobro del
--     vuelo al aplicarse y una aportación es capital: ninguno es ingreso de
--     un avión. El API ya responde 400 AVION_SOLO_EN_RESULTADO antes de
--     escribir; un 23514 de este CHECK se traduce al MISMO code.
--  2) COMMENT en ingreso.aeronave_id (antes: «solo referencia»).
--  3) Verificación que aborta si el CHECK no quedó validado.
-- ingreso.aeronave_id, su FK a aeronave (queda en null si el avión se
-- borra), el índice idx_ingreso_aeronave y su registro en la bitácora
-- (tg_ingreso_bitacora) existen desde 20260924000004: aquí NO se crean.
-- tg_ingreso_candados NO se toca: aeronave_id es asignación, no dinero del
-- banco (se cambia aunque el ingreso esté conciliado; la bitácora lo
-- registra). Triggers de ingreso (13-oct): trg_ingreso_set_updated_at,
-- trg_ingreso_candados (BEFORE) y trg_ingreso_bitacora (AFTER); NINGUNO
-- diferido.
--
-- DATOS (prod bjesduasnzbzywofukbf, 13-oct-2026): el único ingreso vivo con
-- avión es ING-4 (N990GG, REEMBOLSO_DEVOLUCION, $46,550.80 MXN, 4-sep-2026):
-- cumple el CHECK. 0 anticipos o aportaciones con avión. Sin backfill.
--
-- DEPENDENCIA: ninguna dura. Se recomienda DESPUÉS del push del API 0.0.75
-- (así un 23514 siempre llega traducido a AVION_SOLO_EN_RESULTADO); antes
-- también es seguro: hoy no hay ningún anticipo con avión y la ventana es
-- corta (un API previo respondería 500 genérico a un anticipo con avión).
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; existen DOS proyectos:
-- confirmar con un SELECT del ING-4 antes de escribir):
--  a) DRY-RUN de abajo con mcp__supabase__execute_sql: UNA sentencia, el
--     bloque «do $dry$ … $dry$;» quitando el prefijo «-- » de sus líneas
--     (el cuerpo ya va pegado dentro). Debe terminar en «DRYRUN_OK …».
--     Después (lecturas): select count(*) from pg_constraint where conname
--     = 'ingreso_aeronave_chk' ⇒ 0; select count(*) from public.ingreso
--     where descripcion like 'DRYRUN-20261013000005%' ⇒ 0.
--  b) mcp__supabase__apply_migration con name
--     «20261013000005_ingreso_aeronave_resultado» y query = el archivo
--     completo (o solo el cuerpo entre «>>> CUERPO» y «<<< CUERPO»). El
--     archivo entero NO lleva palabras destructivas: el MCP lo acepta. Si
--     aun así respondiera «declined»: SQL Editor + registrar la versión en
--     supabase_migrations.schema_migrations como en 20261012000002.
--  c) POSTCHECK: select pg_get_constraintdef(oid), convalidated from
--     pg_constraint where conname = 'ingreso_aeronave_chk' ⇒ CHECK (((
--     aeronave_id IS NULL) OR (categoria = ANY (ARRAY[…4…])))) validado; el
--     col_description de ingreso.aeronave_id ⇒ el texto de abajo; ING-4
--     intacto. get_advisors (security y performance): nada nuevo esperado.
--  d) La REVERSA vive en el CLAUDE.md del API («Migraciones y despliegue»)
--     y va SOLO por el SQL Editor.
--
-- DRY-RUN (escrituras REALES; el DDL PRIMERO, luego las filas de prueba,
-- luego las pruebas y al final raise ⇒ todo se revierte, DDL incluido).
-- `ingreso` no tiene constraint triggers diferidos, pero el orden se
-- respeta. `ingreso.folio` es identity ALWAYS: no se inserta. `metodo` y
-- `moneda` son ENUM: los literales se convierten solos y las comparaciones
-- contra enum van con ::text. EFECTIVO sin cuenta cumple ingreso_destino_chk.
-- Los CHECK se evalúan en orden alfabético por nombre: ingreso_aeronave_chk
-- salta primero. Cualquier error distinto de DRYRUN_OK ⇒ NO aplicar.
--
-- do $dry$
-- declare
--   v_admin uuid; v_av uuid; v_cli uuid; v_id uuid; v_n int; v_con text;
-- begin
--   -- A) CONTEXTO (solo lecturas)
--   if exists (select 1 from pg_constraint where conname = 'ingreso_aeronave_chk' and conrelid = 'public.ingreso'::regclass) then
--     raise exception 'DRYRUN_FALLA A: ingreso_aeronave_chk ya existe (¿ya se aplicó?)';
--   end if;
--   select count(*) into v_n from public.ingreso
--    where aeronave_id is not null
--      and categoria not in ('OTRO_INGRESO','INGRESO_BANCARIO','REEMBOLSO_DEVOLUCION','VENTA_ACTIVO');
--   if v_n > 0 then raise exception 'DRYRUN_FALLA A: % ingreso(s) con avión fuera de resultados', v_n; end if;
--   select u.id into v_admin from public.usuario u where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' order by u.created_at limit 1;
--   select a.id into v_av from public.aeronave a where a.activa order by a.matricula limit 1;
--   select c.id into v_cli from public.cliente c where c.activo order by c.nombre limit 1;
--   if v_admin is null or v_av is null or v_cli is null then
--     raise exception 'DRYRUN_FALLA A: falta contexto (admin %, avión %, cliente %)', v_admin, v_av, v_cli;
--   end if;
--   -- B) CUERPO REAL (las mismas sentencias del cuerpo, TAL CUAL)
--   if not exists (select 1 from pg_constraint where conname = 'ingreso_aeronave_chk' and conrelid = 'public.ingreso'::regclass) then
--     alter table public.ingreso add constraint ingreso_aeronave_chk
--       check (aeronave_id is null or categoria in ('OTRO_INGRESO','INGRESO_BANCARIO','REEMBOLSO_DEVOLUCION','VENTA_ACTIVO'));
--   end if;
--   comment on column public.ingreso.aeronave_id is
--     'Avión al que CUENTA el ingreso (13-oct-2026, API 0.0.75): entra a la hoja Otros ingresos de su balance y a su reparto a socios, y deja de ser ingreso de VuelaTour. Solo categorías que suman a resultados (CHECK ingreso_aeronave_chk = categoriaIngresoAdmiteAvion del API): un anticipo cuenta como cobro del vuelo al aplicarse y una aportación es capital. NULL = ingreso de VuelaTour.';
--   -- C1) ESTRUCTURA
--   if not exists (select 1 from pg_constraint where conname = 'ingreso_aeronave_chk' and conrelid = 'public.ingreso'::regclass and convalidated) then
--     raise exception 'DRYRUN_FALLA C1: CHECK ausente o sin validar';
--   end if;
--   if col_description('public.ingreso'::regclass, (select attnum from pg_attribute where attrelid = 'public.ingreso'::regclass and attname = 'aeronave_id')) is null then
--     raise exception 'DRYRUN_FALLA C1: sin COMMENT en aeronave_id';
--   end if;
--   -- C2) INSERT REAL con avión en categoría de resultado (pasa) + bitácora INSERT
--   insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, aeronave_id, created_by, updated_by)
--   values ('REEMBOLSO_DEVOLUCION', current_date, 'DRYRUN-20261013000005 reembolso con avión', 1000, 'MXN', 'EFECTIVO', v_av, v_admin, v_admin)
--   returning id into v_id;
--   select count(*) into v_n from public.ingreso_bitacora where ingreso_id = v_id and accion = 'INSERT' and diff ? 'aeronave_id';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C2: la bitácora del INSERT no trae aeronave_id'; end if;
--   -- C3) UPDATE REAL a anticipo CON avión: debe rechazarlo ingreso_aeronave_chk (23514)
--   begin
--     update public.ingreso set categoria = 'ANTICIPO_CLIENTE', cliente_id = v_cli, updated_by = v_admin where id = v_id;
--     raise exception 'DRYRUN_FALLA C3: aceptó un anticipo con avión';
--   exception when check_violation then
--     get stacked diagnostics v_con = constraint_name;
--     if v_con is distinct from 'ingreso_aeronave_chk' then raise exception 'DRYRUN_FALLA C3: lo rechazó % y no ingreso_aeronave_chk', v_con; end if;
--   end;
--   -- C4) INSERT REAL de aportación con avión: debe rechazarlo ingreso_aeronave_chk
--   begin
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, aeronave_id, created_by)
--     values ('APORTACION_PRESTAMO', current_date, 'DRYRUN-20261013000005 aportación con avión', 10, 'MXN', 'EFECTIVO', v_av, v_admin);
--     raise exception 'DRYRUN_FALLA C4: aceptó una aportación con avión';
--   exception when check_violation then
--     get stacked diagnostics v_con = constraint_name;
--     if v_con is distinct from 'ingreso_aeronave_chk' then raise exception 'DRYRUN_FALLA C4: lo rechazó % y no ingreso_aeronave_chk', v_con; end if;
--   end;
--   -- C5) quitar el avión (bitácora UPDATE); anticipo sin avión pasa; avión en anticipo se rechaza; de vuelta a resultado con avión pasa
--   update public.ingreso set aeronave_id = null, updated_by = v_admin where id = v_id;
--   select count(*) into v_n from public.ingreso_bitacora where ingreso_id = v_id and accion = 'UPDATE' and diff ? 'aeronave_id';
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C5: bitácora UPDATE sin aeronave_id (%)', v_n; end if;
--   update public.ingreso set categoria = 'ANTICIPO_CLIENTE', cliente_id = v_cli, updated_by = v_admin where id = v_id;
--   begin
--     update public.ingreso set aeronave_id = v_av, updated_by = v_admin where id = v_id;
--     raise exception 'DRYRUN_FALLA C5: aceptó avión en un anticipo';
--   exception when check_violation then
--     get stacked diagnostics v_con = constraint_name;
--     if v_con is distinct from 'ingreso_aeronave_chk' then raise exception 'DRYRUN_FALLA C5: lo rechazó % y no ingreso_aeronave_chk', v_con; end if;
--   end;
--   update public.ingreso set categoria = 'OTRO_INGRESO', cliente_id = null, aeronave_id = v_av, updated_by = v_admin where id = v_id;
--   if (select aeronave_id from public.ingreso where id = v_id) is distinct from v_av then raise exception 'DRYRUN_FALLA C5: el avión no quedó en el ingreso de resultado'; end if;
--   -- C6) las filas reales cumplen y re-aplicar no crea otro CHECK
--   select count(*) into v_n from public.ingreso where aeronave_id is not null and categoria not in ('OTRO_INGRESO','INGRESO_BANCARIO','REEMBOLSO_DEVOLUCION','VENTA_ACTIVO');
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C6: % fila(s) violan la regla', v_n; end if;
--   if not exists (select 1 from pg_constraint where conname = 'ingreso_aeronave_chk' and conrelid = 'public.ingreso'::regclass) then
--     alter table public.ingreso add constraint ingreso_aeronave_chk
--       check (aeronave_id is null or categoria in ('OTRO_INGRESO','INGRESO_BANCARIO','REEMBOLSO_DEVOLUCION','VENTA_ACTIVO'));
--   end if;
--   select count(*) into v_n from pg_constraint where conname = 'ingreso_aeronave_chk' and conrelid = 'public.ingreso'::regclass;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C6: % CHECK(s) tras re-aplicar', v_n; end if;
--   raise exception 'DRYRUN_OK · C1 CHECK validado + COMMENT · C2 INSERT con avión y bitácora · C3 anticipo con avión rechazado por ingreso_aeronave_chk · C4 aportación con avión rechazada · C5 quitar/poner avión y bitácora UPDATE · C6 filas reales cumplen e idempotente · todo se revierte';
-- end $dry$;
-- =====================================================================

-- >>> CUERPO

-- 1) CHECK espejo de categoriaIngresoAdmiteAvion (idempotente).
do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ingreso_aeronave_chk'
       and conrelid = 'public.ingreso'::regclass
  ) then
    alter table public.ingreso
      add constraint ingreso_aeronave_chk
      check (aeronave_id is null
             or categoria in ('OTRO_INGRESO','INGRESO_BANCARIO','REEMBOLSO_DEVOLUCION','VENTA_ACTIVO'));
  end if;
end $$;

-- 2) COMMENT (antes el avión era «solo referencia»).
comment on column public.ingreso.aeronave_id is
  'Avión al que CUENTA el ingreso (13-oct-2026, API 0.0.75): entra a la hoja Otros ingresos de su balance y a su reparto a socios, y deja de ser ingreso de VuelaTour. Solo categorías que suman a resultados (CHECK ingreso_aeronave_chk = categoriaIngresoAdmiteAvion del API): un anticipo cuenta como cobro del vuelo al aplicarse y una aportación es capital. NULL = ingreso de VuelaTour.';

-- 3) Verificación: aborta si el CHECK no quedó validado.
do $ver$
begin
  if not exists (
    select 1 from pg_constraint
     where conname = 'ingreso_aeronave_chk'
       and conrelid = 'public.ingreso'::regclass
       and convalidated
  ) then
    raise exception 'MIGRACION_FALLA: falta ingreso_aeronave_chk validado';
  end if;
end $ver$;

-- <<< CUERPO
