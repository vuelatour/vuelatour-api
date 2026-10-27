-- =====================================================================
-- DRY-RUN de 20261027000002_inventario_movimiento_ubicacion.sql — NO ES UNA
-- MIGRACIÓN. Vive en `supabase/migrations/_dryrun/` (subcarpeta que el CLI
-- de Supabase NO recorre).
--
-- Cómo correrlo: UNA sentencia por mcp__supabase__execute_sql en el proyecto
-- bjesduasnzbzywofukbf. Termina SIEMPRE en `raise exception` ⇒ todo se
-- revierte. Resultado esperado: el error «DRYRUN_OK 20261027000002 · …».
-- Cualquier otro error ⇒ NO aplicar.
--
-- Orden (regla del CLAUDE.md del workspace): cuerpo (DDL) → filas de prueba
-- DESPUÉS del DDL → pruebas con INSERT/UPDATE REALES → DRYRUN_OK. Sin DROP,
-- DELETE ni REVOKE. `inventario_movimiento` no tiene constraint triggers
-- diferidos (solo set_updated_at; verificado 27-oct-2026).
--
-- LÍMITE conocido: el valor TRASPASO no se puede USAR en la misma
-- transacción que lo crea (55P04) — se prueba que así sea (C4); la escritura
-- de un TRASPASO real se verifica DESPUÉS de aplicar, con un `do … raise
-- exception` aparte (ver el pie de este archivo).
-- =====================================================================

do $dry$
declare
  v_admin uuid;
  v_item uuid;
  v_loc1 uuid;
  v_loc2 uuid;
  v_mov uuid;
  v_n0 int;
  v_n int;
  v_ult text;
begin
  -- A) Precondiciones.
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'inventario_movimiento'
      and column_name = 'ubicacion_id'
  ) then
    raise exception 'DRYRUN_FALLA A: inventario_movimiento.ubicacion_id ya existe (¿migración ya aplicada?)';
  end if;
  if exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'tipo_movimiento_inventario' and e.enumlabel = 'TRASPASO'
  ) then
    raise exception 'DRYRUN_FALLA A: el enum ya tiene TRASPASO';
  end if;
  select count(*) into v_n0 from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'tipo_movimiento_inventario';
  select u.id into v_admin from public.usuario u
   where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' order by u.created_at limit 1;
  select i.id into v_item from public.inventario_item i
   where i.activo and exists (select 1 from public.inventario_movimiento m where m.item_id = i.id)
   order by i.nombre limit 1;
  select id into v_loc1 from public.inventario_ubicacion where activo order by orden, nombre limit 1;
  select id into v_loc2 from public.inventario_ubicacion where activo and id <> v_loc1 order by orden, nombre limit 1;
  if v_admin is null or v_item is null or v_loc1 is null or v_loc2 is null then
    raise exception 'DRYRUN_FALLA A: sin ADMIN activo, ítem con cardex o dos ubicaciones activas';
  end if;

  -- B) >>> CUERPO de 20261027000002, tal cual
  alter type public.tipo_movimiento_inventario add value if not exists 'TRASPASO';

  alter table public.inventario_movimiento
    add column if not exists ubicacion_id uuid null references public.inventario_ubicacion(id),
    add column if not exists ubicacion_destino_id uuid null references public.inventario_ubicacion(id);

  comment on column public.inventario_movimiento.ubicacion_id is
    'Bodega donde ocurrió el movimiento (20261027000002, API 0.0.111, invariante 111). null = la ubicación PRINCIPAL del producto (inventario_item.ubicacion_id) al momento de leer; sin principal, «Sin ubicación». En un TRASPASO es el ORIGEN. La existencia por ubicación se deriva del cardex (API, fuente única inventario-cardex.util).';
  comment on column public.inventario_movimiento.ubicacion_destino_id is
    'Solo en tipo TRASPASO: bodega que RECIBE las piezas (CHECK inventario_movimiento_traspaso_chk). Un traspaso no cambia la existencia total ni el dinero: solo reparte el stock entre ubicaciones.';

  create index if not exists idx_inventario_movimiento_ubicacion
    on public.inventario_movimiento (ubicacion_id)
    where ubicacion_id is not null;
  create index if not exists idx_inventario_movimiento_ubicacion_destino
    on public.inventario_movimiento (ubicacion_destino_id)
    where ubicacion_destino_id is not null;

  if not exists (
    select 1 from pg_constraint
    where conname = 'inventario_movimiento_traspaso_chk'
      and conrelid = 'public.inventario_movimiento'::regclass
  ) then
    alter table public.inventario_movimiento
      add constraint inventario_movimiento_traspaso_chk check (
        (tipo::text <> 'TRASPASO' and ubicacion_destino_id is null)
        or (
          tipo::text = 'TRASPASO'
          and ubicacion_destino_id is not null
          and (ubicacion_id is null or ubicacion_id <> ubicacion_destino_id)
        )
      );
  end if;
  -- <<< CUERPO

  -- C1) El enum ganó UN valor y es el último.
  select count(*) into v_n from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'tipo_movimiento_inventario';
  if v_n <> v_n0 + 1 then raise exception 'DRYRUN_FALLA C1: % valores (esperado %)', v_n, v_n0 + 1; end if;
  select e.enumlabel into v_ult from pg_enum e join pg_type t on t.oid = e.enumtypid
   where t.typname = 'tipo_movimiento_inventario' order by e.enumsortorder desc limit 1;
  if v_ult is distinct from 'TRASPASO' then raise exception 'DRYRUN_FALLA C1: el último valor es %', v_ult; end if;

  -- C2) Fila de prueba DESPUÉS del DDL: una ENTRADA real con ubicación.
  insert into public.inventario_movimiento
    (item_id, tipo, cantidad, costo_unitario_usd, moneda, fecha_movimiento, notas, registrado_por, created_by, updated_by, ubicacion_id)
  values
    (v_item, 'ENTRADA', 1, 0, 'USD', date '2026-10-27', 'DRYRUN 20261027000002', v_admin, v_admin, v_admin, v_loc1)
  returning id into v_mov;
  if (select ubicacion_id from public.inventario_movimiento where id = v_mov) is distinct from v_loc1 then
    raise exception 'DRYRUN_FALLA C2: la ENTRADA no guardó su ubicación';
  end if;
  -- La fila puede cambiar de bodega (corrección) y volver a null (= principal).
  update public.inventario_movimiento set ubicacion_id = v_loc2 where id = v_mov;
  update public.inventario_movimiento set ubicacion_id = null where id = v_mov;

  -- C3) El destino NO vive fuera de un TRASPASO (CHECK).
  begin
    update public.inventario_movimiento set ubicacion_destino_id = v_loc2 where id = v_mov;
    raise exception 'DRYRUN_FALLA C3: una ENTRADA aceptó ubicacion_destino_id';
  exception when check_violation then
    raise notice 'okC3 · 23514 destino fuera de TRASPASO';
  end;

  -- C4) El valor nuevo NO se puede usar antes del COMMIT (55P04): por eso el
  --     TRASPASO real se prueba después de aplicar.
  begin
    update public.inventario_movimiento set tipo = 'TRASPASO', ubicacion_destino_id = v_loc2 where id = v_mov;
    raise exception 'DRYRUN_FALLA C4: se escribió el valor nuevo antes del commit';
  exception when sqlstate '55P04' then
    raise notice 'okC4 · 55P04 al usar TRASPASO antes del commit';
  end;

  -- C5) Los 96 movimientos previos siguen sin ubicación (sin backfill).
  select count(*) into v_n from public.inventario_movimiento
   where id <> v_mov and (ubicacion_id is not null or ubicacion_destino_id is not null);
  if v_n <> 0 then raise exception 'DRYRUN_FALLA C5: % movimientos previos con ubicación', v_n; end if;

  raise exception 'DRYRUN_OK 20261027000002 · enum % → % (TRASPASO al final), columnas, índices, CHECK (23514) y 55P04 verificados con filas reales; todo revertido',
    v_n0, v_n0 + 1;
end $dry$;

-- =====================================================================
-- POST-APLICACIÓN (con la migración ya aplicada): un TRASPASO real que se
-- revierte, para probar el CHECK completo. Esperado: «POSTCHECK_OK …».
--
-- do $post$
-- declare v_admin uuid; v_item uuid; v_loc1 uuid; v_loc2 uuid; v_mov uuid;
-- begin
--   select u.id into v_admin from public.usuario u where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' order by u.created_at limit 1;
--   select i.id into v_item from public.inventario_item i where i.activo order by i.nombre limit 1;
--   select id into v_loc1 from public.inventario_ubicacion where activo order by orden, nombre limit 1;
--   select id into v_loc2 from public.inventario_ubicacion where activo and id <> v_loc1 order by orden, nombre limit 1;
--   insert into public.inventario_movimiento (item_id, tipo, cantidad, costo_unitario_usd, moneda, fecha_movimiento, notas, registrado_por, created_by, updated_by, ubicacion_id, ubicacion_destino_id)
--   values (v_item, 'TRASPASO', 1, 0, 'USD', date '2026-10-27', 'POSTCHECK 20261027000002', v_admin, v_admin, v_admin, v_loc1, v_loc2) returning id into v_mov;
--   begin
--     update public.inventario_movimiento set ubicacion_destino_id = v_loc1 where id = v_mov;
--     raise exception 'POSTCHECK_FALLA: origen = destino aceptado';
--   exception when check_violation then raise notice 'ok · origen <> destino'; end;
--   begin
--     update public.inventario_movimiento set ubicacion_destino_id = null where id = v_mov;
--     raise exception 'POSTCHECK_FALLA: TRASPASO sin destino aceptado';
--   exception when check_violation then raise notice 'ok · TRASPASO exige destino'; end;
--   update public.inventario_movimiento set ubicacion_id = null where id = v_mov; -- origen = la principal: válido
--   raise exception 'POSTCHECK_OK 20261027000002 · TRASPASO real escrito y revertido';
-- end $post$;
-- =====================================================================
