-- 20261127000001_inventario_salida_algunas_matriculas — dry-run (CUERPO copiado de la migración; pruebas a mano).
-- Proyecto PROD: bjesduasnzbzywofukbf (confirmar el ref antes de correrlo).
-- DRY-RUN: corre la migración y pruebas con escrituras REALES y lo revierte
-- TODO. Debe terminar en ERROR con el texto «DRYRUN_OK: …». Cualquier otro
-- error ⇒ NO aplicar y avisar.
-- No lleva sentencias destructivas: se puede correr por MCP o en el SQL
-- Editor.
--
-- Las filas de prueba van DESPUÉS del cuerpo (regla del workspace). Se
-- insertan directo en `inventario_movimiento` con un producto, un usuario y
-- dos aviones que YA existen: sin gastos (los crea el API, no la base) y sin
-- secuencias que gastar.

begin;

-- >>> CUERPO
alter table public.inventario_movimiento
  add column if not exists aeronave_ids uuid[];

alter table public.inventario_movimiento
  add constraint inventario_movimiento_aeronave_ids_chk
  check (
    aeronave_ids is null
    or (para_flota and cardinality(aeronave_ids) >= 2)
  );

comment on column public.inventario_movimiento.aeronave_ids is
  'Matrículas ELEGIDAS de una salida repartida (para_flota = true): el cargo se divide en partes iguales solo entre ellas, un gasto por avión. NULL = un solo avión (aeronave_id) o toda la flota activa del día de la captura. Mínimo 2.';
-- <<< CUERPO

do $t$
declare
  v_item uuid;
  v_usuario uuid;
  v_a1 uuid;
  v_a2 uuid;
  v_txt text;
  v_def text;
  v_n integer;
  v_antes integer;
  v_id uuid;
  v_id_flota uuid;
  v_constraint text;
  v_choco boolean;
  v_upd_antes timestamptz;
  v_upd_despues timestamptz;
begin
  select id into v_item from public.inventario_item order by created_at limit 1;
  select id into v_usuario from public.usuario order by created_at limit 1;
  select id into v_a1 from public.aeronave where activa order by matricula limit 1;
  select id into v_a2 from public.aeronave where activa order by matricula offset 1 limit 1;
  if v_item is null or v_usuario is null or v_a1 is null or v_a2 is null then
    raise exception 'DRYRUN T0: faltan datos base (item %, usuario %, aviones % %)', v_item, v_usuario, v_a1, v_a2;
  end if;
  select count(*) into v_antes from public.inventario_movimiento;

  -- T1: la columna existe, es un arreglo de uuid, admite null y no tiene
  -- valor por omisión.
  select data_type || '|' || udt_name || '|' || is_nullable || '|' || coalesce(column_default, '')
    into v_txt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'inventario_movimiento'
     and column_name = 'aeronave_ids';
  if v_txt is distinct from 'ARRAY|_uuid|YES|' then
    raise exception 'DRYRUN T1: columna inesperada: %', coalesce(v_txt, '(no existe)');
  end if;

  -- T2: el CHECK existe y dice lo que debe.
  select pg_get_constraintdef(oid) into v_def from pg_constraint
   where conrelid = 'public.inventario_movimiento'::regclass
     and conname = 'inventario_movimiento_aeronave_ids_chk';
  if v_def is null
     or v_def not ilike '%aeronave_ids is null%'
     or v_def not ilike '%para_flota%'
     or v_def not ilike '%cardinality(aeronave_ids) >= 2%' then
    raise exception 'DRYRUN T2: CHECK inesperado: %', coalesce(v_def, '(no existe)');
  end if;

  -- T3: ninguna fila existente quedó con lista (la migración no toca filas).
  select count(*) into v_n from public.inventario_movimiento where aeronave_ids is not null;
  if v_n <> 0 then
    raise exception 'DRYRUN T3: % movimiento(s) existentes con lista', v_n;
  end if;

  -- T4: salida repartida entre DOS matrículas elegidas (lo que manda el API).
  insert into public.inventario_movimiento
    (item_id, tipo, cantidad, costo_unitario_usd, para_flota, aeronave_ids, registrado_por, notas)
  values
    (v_item, 'SALIDA', 1, 0, true, array[v_a1, v_a2], v_usuario, 'DRYRUN 20261127000001 dos matriculas')
  returning id into v_id;
  select cardinality(aeronave_ids) into v_n from public.inventario_movimiento where id = v_id;
  if v_n <> 2 then
    raise exception 'DRYRUN T4: la lista guardó % matrícula(s) (esperaba 2)', v_n;
  end if;

  -- T5: UNA sola matrícula en la lista ⇒ el CHECK la rechaza (es una salida
  -- normal a ese avión).
  v_choco := false;
  begin
    insert into public.inventario_movimiento
      (item_id, tipo, cantidad, costo_unitario_usd, para_flota, aeronave_ids, registrado_por)
    values (v_item, 'SALIDA', 1, 0, true, array[v_a1], v_usuario);
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    v_choco := true;
  end;
  if not v_choco or v_constraint is distinct from 'inventario_movimiento_aeronave_ids_chk' then
    raise exception 'DRYRUN T5: una sola matrícula no chocó con el CHECK nuevo (%)', v_constraint;
  end if;

  -- T6: lista en una salida a UN avión (sin para_flota) ⇒ rechazada.
  v_choco := false;
  begin
    insert into public.inventario_movimiento
      (item_id, tipo, cantidad, costo_unitario_usd, aeronave_id, aeronave_ids, registrado_por)
    values (v_item, 'SALIDA', 1, 0, v_a1, array[v_a1, v_a2], v_usuario);
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    v_choco := true;
  end;
  if not v_choco or v_constraint is distinct from 'inventario_movimiento_aeronave_ids_chk' then
    raise exception 'DRYRUN T6: lista con un avión fijo no chocó con el CHECK nuevo (%)', v_constraint;
  end if;

  -- T7: lista en una ENTRADA ⇒ rechazada.
  v_choco := false;
  begin
    insert into public.inventario_movimiento
      (item_id, tipo, cantidad, costo_unitario_usd, aeronave_ids, registrado_por)
    values (v_item, 'ENTRADA', 1, 0, array[v_a1, v_a2], v_usuario);
  exception when check_violation then
    get stacked diagnostics v_constraint = constraint_name;
    v_choco := true;
  end;
  if not v_choco or v_constraint is distinct from 'inventario_movimiento_aeronave_ids_chk' then
    raise exception 'DRYRUN T7: lista en una ENTRADA no chocó con el CHECK nuevo (%)', v_constraint;
  end if;

  -- T8: «toda la flota» de siempre (para_flota SIN lista) sigue entrando.
  insert into public.inventario_movimiento
    (item_id, tipo, cantidad, costo_unitario_usd, para_flota, registrado_por, notas)
  values (v_item, 'SALIDA', 1, 0, true, v_usuario, 'DRYRUN toda la flota')
  returning id into v_id_flota;

  -- T9: salida normal a un avión y entrada normal (sin lista) siguen entrando.
  insert into public.inventario_movimiento
    (item_id, tipo, cantidad, costo_unitario_usd, aeronave_id, registrado_por, notas)
  values (v_item, 'SALIDA', 1, 0, v_a1, v_usuario, 'DRYRUN un avion');
  insert into public.inventario_movimiento
    (item_id, tipo, cantidad, costo_unitario_usd, registrado_por, notas)
  values (v_item, 'ENTRADA', 3, 0, v_usuario, 'DRYRUN entrada');

  -- T10: un UPDATE también pasa por el CHECK (lista de una matrícula) y el
  -- disparador de `updated_at` sigue vivo en un UPDATE válido.
  v_choco := false;
  begin
    update public.inventario_movimiento set aeronave_ids = array[v_a2] where id = v_id_flota;
  exception when check_violation then
    v_choco := true;
  end;
  if not v_choco then
    raise exception 'DRYRUN T10: el UPDATE a una sola matrícula NO chocó';
  end if;
  select updated_at into v_upd_antes from public.inventario_movimiento where id = v_id_flota;
  update public.inventario_movimiento
     set aeronave_ids = array[v_a1, v_a2], updated_at = '2000-01-01T00:00:00Z'
   where id = v_id_flota;
  select updated_at into v_upd_despues from public.inventario_movimiento where id = v_id_flota;
  if v_upd_despues is null or v_upd_despues < v_upd_antes then
    raise exception 'DRYRUN T10: updated_at no lo selló el disparador (% → %)', v_upd_antes, v_upd_despues;
  end if;

  -- T11: entraron exactamente las 4 filas válidas.
  select count(*) into v_n from public.inventario_movimiento;
  if v_n <> v_antes + 4 then
    raise exception 'DRYRUN T11: entraron % fila(s) (esperaba 4)', v_n - v_antes;
  end if;

  -- T12: RLS sigue encendido y la tabla conserva su único disparador.
  select count(*) into v_n from pg_class
   where oid = 'public.inventario_movimiento'::regclass and relrowsecurity;
  if v_n <> 1 then
    raise exception 'DRYRUN T12: RLS apagado en inventario_movimiento';
  end if;
  select count(*) into v_n from pg_trigger
   where tgrelid = 'public.inventario_movimiento'::regclass and not tgisinternal;
  if v_n <> 1 then
    raise exception 'DRYRUN T12: % disparador(es) en inventario_movimiento (esperaba 1)', v_n;
  end if;

  raise exception 'DRYRUN_OK: inventario_movimiento.aeronave_ids — salida repartida entre 2 matrículas guardada; 1 matrícula, lista con avión fijo y lista en entrada rechazadas (23514 %); toda la flota, salida a un avión y entrada siguen entrando (todo revertido)', v_constraint;
end $t$;

rollback;
