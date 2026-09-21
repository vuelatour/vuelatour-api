-- 21-sep-2026 · ELIMINAR UN MOVIMIENTO DE CARDEX CON JUSTIFICACIÓN Y AUTOR.
--
-- Pedido del cliente (captura del «Cardex completo» del aceite 15W-50, con
-- tres movimientos capturados por error el 29-ago: SALIDA −10 a XA-VGV $0,
-- ENTRADA +1 a $350 MXN y SALIDA −1 a XA-VGV $0):
--   «podemos agregar una opcion para eliminar algunos movimientos, pero que
--    al momento de eliminarlos pida justificacion y sepamos quien lo hizo».
--
-- Hasta hoy el cardex era APPEND-ONLY: lo único corregible era el COSTO de
-- una ENTRADA (`inventario_eliminar_movimiento` NO cambia eso — sigue
-- viviendo en updateCostoEntrada). El stock y los costos FIFO no se guardan:
-- se derivan del cardex cada vez, así que borrar un movimiento REESCRIBE la
-- historia de todo lo que vino después. Por eso:
--
--   (1) La AUDITORÍA es obligatoria y nace ANTES que el borrado, en la misma
--       transacción: `inventario_movimiento_eliminado` guarda la fila
--       COMPLETA del movimiento, la de los gastos que se van con él, el
--       MOTIVO (≥ 10 caracteres), QUIÉN y CUÁNDO. Sin FK a propósito (patrón
--       `vuelo_eliminado` / `gasto_bitacora`): la historia sobrevive al
--       borrado del movimiento y del ítem.
--   (2) El borrado es ATÓMICO (una sola función, no N pasos sueltos del API):
--       el gasto REFACCION medio BODEGA que la SALIDA generó (invariante 8)
--       se va CON el movimiento o no se va nada. Un movimiento sin su gasto
--       —o al revés— descuadra el costo del avión en silencio.
--   (3) Candados de dinero: un movimiento que nace de una COMPRA no se borra
--       (se corrige desde la compra), y un gasto ya conciliado / facturado /
--       con cargo bancario ligado BLOQUEA el borrado completo.
--
-- Los candados de CARDEX (que el stock no quede negativo en ningún punto de
-- la cronología y que NINGUNA otra salida cambie su costo FIFO) viven en el
-- API (`src/modules/inventory/eliminar-movimiento.util.ts`, con specs): son
-- una simulación del FIFO, no una restricción expresable en SQL. La función
-- de BD es la última defensa del DINERO, no del FIFO.
--
-- ATENCIÓN · ENUMs (verificado contra prod `bjesduasnzbzywofukbf` por
-- information_schema el 21-sep-2026): `inventario_movimiento.tipo` es ENUM
-- (`public.tipo_movimiento_inventario`) y `gasto.categoria` / `gasto.moneda`
-- / `gasto.medio_pago` también (`categoria_gasto`, `moneda`, `medio_pago`).
-- En plpgsql se comparan SIEMPRE `::text` (regla del repo tras el incidente
-- del 15-sep-2026: «operator does not exist: public.moneda = text» tiró la
-- conciliación entera y era invisible para cualquier `select`).
-- NO son enum, aunque aquí también se casteen por uniformidad:
-- `gasto.estatus_facturacion` e `inventario_movimiento.moneda` son `text` /
-- `varchar`. El `::text` sobre ellos es inocuo — quitarlo, no: el día que
-- alguien los convierta a enum, el cast es lo único que evita repetir el 15-sep.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES, begin … rollback).
-- Esta migración borra filas y dispara `trg_gasto_bitacora` (la función
-- `tg_gasto_bitacora`, verificada en prod el 21-sep): un `select` no
-- prueba nada. Los CINCO pasos son ASERCIONES: cada uno imprime «ok N/5» o
-- REVIENTA la transacción con «DRY-RUN FALLÓ». Nada que verificar a ojo.
--
-- CÓMO CORRERLO: en UNA sola sesión con control de transacción propio (psql,
-- o el editor SQL de Supabase). NO sirve una herramienta que envuelva cada
-- llamada en su propia transacción o que corra en modo solo-lectura: el
-- `rollback` final es lo que hace seguro el ensayo.
--
--   begin;
--     -- 0) Contexto: un ADMIN real y una SALIDA real CON su gasto de bodega.
--     --    (hoy: la salida de 24 pzas del 6-ago a N990GG, gasto $39,799.92 MXN)
--     create temporary table dry (k text primary key, v uuid) on commit drop;
--     insert into dry values
--       ('usuario', (select id from public.usuario
--                     where rol::text = 'ADMIN' and estado::text = 'ACTIVO' limit 1)),
--       ('mov',     (select g.inventario_movimiento_id from public.gasto g
--                     where g.inventario_movimiento_id is not null
--                       and g.categoria::text = 'REFACCION'
--                       and g.medio_pago::text = 'BODEGA'
--                     order by g.fecha_gasto desc limit 1));
--     insert into dry values
--       ('item', (select item_id from public.inventario_movimiento
--                  where id = (select v from dry where k = 'mov')));
--     do $dry$
--     begin
--       if (select v from dry where k = 'usuario') is null
--          or (select v from dry where k = 'mov') is null
--          or (select v from dry where k = 'item') is null then
--         raise exception 'DRY-RUN SIN CONTEXTO: falta un ADMIN activo o una SALIDA con gasto BODEGA'
--           using errcode = 'assert_failure';
--       end if;
--       if not exists (select 1 from public.compra_linea) then
--         raise exception 'DRY-RUN SIN CONTEXTO: no hay ninguna compra_linea para probar el candado 2'
--           using errcode = 'assert_failure';
--       end if;
--     end $dry$;
--
--     -- 1) CANDADO de motivo corto: debe REVENTAR con MOTIVO_REQUERIDO.
--     --    (se corre solo, porque aborta la transacción: usar savepoints)
--     savepoint s1;
--     do $dry$
--     begin
--       perform public.inventario_eliminar_movimiento(
--         (select v from dry where k = 'mov'),
--         (select v from dry where k = 'item'),
--         'corto', (select v from dry where k = 'usuario'));
--       raise exception 'DRY-RUN FALLÓ: aceptó un motivo de 5 caracteres'
--         using errcode = 'assert_failure';
--     exception when sqlstate 'P0001' then
--       raise notice 'ok 1/5 · motivo corto rechazado: %', sqlerrm;
--     end $dry$;
--     rollback to savepoint s1;
--
--     -- 2) CANDADO de compra: se liga una compra_linea real al movimiento y
--     --    la función debe reventar con MOVIMIENTO_DE_COMPRA.
--     savepoint s2;
--     update public.compra_linea
--        set inventario_movimiento_id = (select v from dry where k = 'mov')
--      where id = (select id from public.compra_linea order by id limit 1);
--     do $dry$
--     begin
--       perform public.inventario_eliminar_movimiento(
--         (select v from dry where k = 'mov'),
--         (select v from dry where k = 'item'),
--         'dry-run candado de compra', (select v from dry where k = 'usuario'));
--       raise exception 'DRY-RUN FALLÓ: borró un movimiento de compra'
--         using errcode = 'assert_failure';
--     exception when sqlstate 'P0001' then
--       raise notice 'ok 2/5 · compra rechazada: %', sqlerrm;
--     end $dry$;
--     rollback to savepoint s2;
--
--     -- 3) CANDADO de gasto conciliado: se concilia el gasto ligado y la
--     --    función debe reventar con GASTO_BLOQUEADO (y NO borrar nada).
--     savepoint s3;
--     update public.gasto set conciliado = true
--      where inventario_movimiento_id = (select v from dry where k = 'mov');
--     do $dry$
--     begin
--       perform public.inventario_eliminar_movimiento(
--         (select v from dry where k = 'mov'),
--         (select v from dry where k = 'item'),
--         'dry-run candado de gasto', (select v from dry where k = 'usuario'));
--       raise exception 'DRY-RUN FALLÓ: borró un movimiento con gasto conciliado'
--         using errcode = 'assert_failure';
--     exception when sqlstate 'P0001' then
--       raise notice 'ok 3/5 · gasto conciliado rechazado: %', sqlerrm;
--     end $dry$;
--     rollback to savepoint s3;
--
--     -- 4) CAMINO FELIZ (escritura REAL) + 5) lo que quedó. Van en UN bloque
--     --    para poder comparar los conteos de antes y después sin leerlos a
--     --    ojo: si algo no cuadra, la transacción revienta.
--     do $dry$
--     declare
--       v_mov uuid := (select v from dry where k = 'mov');
--       v_item uuid := (select v from dry where k = 'item');
--       v_usr uuid := (select v from dry where k = 'usuario');
--       v_movs_antes int;   v_movs_despues int;
--       v_gastos_antes int; v_gastos_despues int;
--       v_res jsonb; v_aud record; v_bit record;
--     begin
--       select count(*) into v_movs_antes from public.inventario_movimiento
--        where item_id = v_item;
--       select count(*) into v_gastos_antes from public.gasto
--        where inventario_movimiento_id = v_mov;
--
--       v_res := public.inventario_eliminar_movimiento(
--         v_mov, v_item, 'dry-run 21-sep: captura duplicada del 29-ago', v_usr);
--       raise notice 'ok 4/5 · borrado atómico: %', v_res;
--
--       select count(*) into v_movs_despues from public.inventario_movimiento
--        where item_id = v_item;
--       select count(*) into v_gastos_despues from public.gasto
--        where inventario_movimiento_id = v_mov;
--       select * into v_aud from public.inventario_movimiento_eliminado
--        order by eliminado_at desc limit 1;
--       select * into v_bit from public.gasto_bitacora
--        where accion = 'DELETE' order by created_at desc limit 1;
--
--       if v_movs_despues <> v_movs_antes - 1 then
--         raise exception 'DRY-RUN FALLÓ: movimientos % → % (se esperaba −1)',
--           v_movs_antes, v_movs_despues using errcode = 'assert_failure';
--       end if;
--       if v_gastos_despues <> 0 then
--         raise exception 'DRY-RUN FALLÓ: quedaron % gastos ligados', v_gastos_despues
--           using errcode = 'assert_failure';
--       end if;
--       if (v_res->>'gastos_eliminados')::int <> v_gastos_antes then
--         raise exception 'DRY-RUN FALLÓ: dijo % gastos y había %',
--           v_res->>'gastos_eliminados', v_gastos_antes using errcode = 'assert_failure';
--       end if;
--       if v_aud.movimiento_id is distinct from v_mov
--          or v_aud.eliminado_por is distinct from v_usr
--          or v_aud.eliminado_por_nombre is null
--          or v_aud.snapshot is null
--          or jsonb_array_length(v_aud.gastos_snapshot) <> v_gastos_antes then
--         raise exception 'DRY-RUN FALLÓ: la auditoría no coincide (%)', to_jsonb(v_aud)
--           using errcode = 'assert_failure';
--       end if;
--       -- La atribución del DELETE: trg_gasto_bitacora toma OLD.updated_by.
--       if v_gastos_antes > 0 and v_bit.actor_id is distinct from v_usr then
--         raise exception 'DRY-RUN FALLÓ: el DELETE del gasto quedó a nombre de % (se esperaba %)',
--           v_bit.actor_id, v_usr using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 5/5 · movimientos % → %, gastos % → 0, auditoría % por %, bitácora DELETE de %',
--         v_movs_antes, v_movs_despues, v_gastos_antes,
--         v_aud.id, v_aud.eliminado_por_nombre, v_bit.actor_id;
--     end $dry$;
--   rollback;
--
--   -- Y COMPROBAR que el rollback dejó todo como estaba:
--   select count(*) as movs from public.inventario_movimiento;            -- 75
--   select count(*) as gastos_bodega from public.gasto
--    where inventario_movimiento_id is not null;                          -- 3
--   select count(*) as auditorias from public.inventario_movimiento_eliminado; -- 0
--
-- Tras aplicar: `get_advisors` (la tabla nueva queda con RLS y sin políticas)
-- y `GET /v1/inventory/items/:id/movimientos/:movId/eliminacion` desde el
-- panel (debe responder 200 con `permitido`, no 503).
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1) Bitácora forense de movimientos de cardex eliminados
-- ===========================================================================
create table if not exists public.inventario_movimiento_eliminado (
  id uuid primary key default gen_random_uuid(),
  -- Sin FK a propósito (patrón vuelo_eliminado / gasto_bitacora): la historia
  -- sobrevive al borrado del movimiento Y al del ítem.
  movimiento_id uuid not null,
  item_id uuid not null,
  -- Ficha legible congelada: el ítem puede renombrarse o desaparecer después.
  item_codigo text,
  item_nombre text,
  tipo text not null,
  cantidad numeric not null,
  fecha_movimiento date not null,
  aeronave_matricula text,
  -- El cliente pidió JUSTIFICACIÓN: no es un campo decorativo.
  motivo text not null check (char_length(btrim(motivo)) >= 10),
  -- Fila COMPLETA del movimiento al momento del borrado (forense).
  snapshot jsonb not null,
  -- Filas COMPLETAS de los gastos BODEGA que se fueron con él (con su
  -- matrícula y sus repartos, que la FK de gasto_reparto borra en cascada).
  gastos_snapshot jsonb not null default '[]'::jsonb,
  -- Llave del outbox de la app: un reintento NO debe resucitar lo eliminado.
  client_request_id uuid,
  eliminado_por uuid not null,
  eliminado_por_nombre text,
  eliminado_at timestamptz not null default now()
);

comment on table public.inventario_movimiento_eliminado is
  'Bitácora forense de movimientos de cardex borrados (solo ADMIN, con motivo obligatorio ≥ 10 caracteres). No es un soft-delete: el movimiento ya no existe y el stock/costo FIFO se recalculan sin él. Guarda la fila completa del movimiento y la de los gastos BODEGA que se fueron con él. Sin FK a propósito: sobrevive al borrado del ítem.';
comment on column public.inventario_movimiento_eliminado.snapshot is
  'Fila COMPLETA de inventario_movimiento (to_jsonb) al momento del borrado.';
comment on column public.inventario_movimiento_eliminado.gastos_snapshot is
  'Arreglo con la fila COMPLETA de cada gasto REFACCION/BODEGA eliminado junto al movimiento, más aeronave_matricula y sus repartos. [] = el movimiento no tenía gastos (salida a costo $0).';
comment on column public.inventario_movimiento_eliminado.client_request_id is
  'client_request_id del movimiento borrado (idempotencia del outbox). El API responde 409 MOVIMIENTO_ELIMINADO si esa llave vuelve a llegar, para que un reintento del teléfono no resucite lo que la oficina eliminó.';
comment on column public.inventario_movimiento_eliminado.motivo is
  'Justificación tecleada por quien elimina (obligatoria, ≥ 10 caracteres tras recortar espacios).';

create index if not exists idx_inv_mov_eliminado_item
  on public.inventario_movimiento_eliminado (item_id, eliminado_at desc);
create index if not exists idx_inv_mov_eliminado_client_request
  on public.inventario_movimiento_eliminado (client_request_id)
  where client_request_id is not null;

-- Solo service key (el API): RLS habilitado y SIN políticas, como
-- vuelo_eliminado y gasto_bitacora.
alter table public.inventario_movimiento_eliminado enable row level security;

-- ===========================================================================
-- 2) Borrado ATÓMICO: auditoría + gastos ligados + movimiento
-- ===========================================================================
create or replace function public.inventario_eliminar_movimiento(
  p_movimiento uuid,
  p_item uuid,
  p_motivo text,
  p_usuario uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_mov public.inventario_movimiento%rowtype;
  v_motivo text := btrim(coalesce(p_motivo, ''));
  v_item_codigo text;
  v_item_nombre text;
  v_matricula text;
  v_usuario_nombre text;
  v_folio_compra text;
  v_gasto_ids uuid[] := '{}'::uuid[];
  v_gastos_snapshot jsonb := '[]'::jsonb;
  v_ajenos integer := 0;
  v_bloqueados integer := 0;
  v_auditoria uuid;
begin
  if p_usuario is null then
    raise exception 'USUARIO_REQUERIDO: no se sabe quién elimina el movimiento.'
      using errcode = 'P0001', hint = 'USUARIO_REQUERIDO';
  end if;
  if char_length(v_motivo) < 10 then
    raise exception 'MOTIVO_REQUERIDO: la justificación debe tener al menos 10 caracteres (llegaron %).', char_length(v_motivo)
      using errcode = 'P0001', hint = 'MOTIVO_REQUERIDO';
  end if;

  -- (i) Fila BLOQUEADA: dos borrados simultáneos del mismo movimiento se
  -- serializan y el segundo encuentra «no existe».
  select * into v_mov
    from public.inventario_movimiento
   where id = p_movimiento
     for update;
  if not found then
    raise exception 'MOVIMIENTO_NO_EXISTE: el movimiento % ya no está en el cardex.', p_movimiento
      using errcode = 'P0001', hint = 'MOVIMIENTO_NO_EXISTE';
  end if;
  if v_mov.item_id is distinct from p_item then
    raise exception 'MOVIMIENTO_DE_OTRO_ITEM: el movimiento % no pertenece al producto %.', p_movimiento, p_item
      using errcode = 'P0001', hint = 'MOVIMIENTO_DE_OTRO_ITEM';
  end if;

  -- (ii) CANDADO DE COMPRA: la ENTRADA que nace de una compra se corrige
  -- desde la compra (ahí se prorratean envío e impuestos). Borrarla dejaría
  -- la línea de compra apuntando a nada (FK set null) en silencio.
  select coalesce(c.folio::text, '?')
    into v_folio_compra
    from public.compra_linea cl
    left join public.compra c on c.id = cl.compra_id
   where cl.inventario_movimiento_id = p_movimiento
   limit 1;
  if v_folio_compra is not null then
    raise exception 'MOVIMIENTO_DE_COMPRA: esta entrada nace de la compra #%; quítala o corrígela desde Compras.', v_folio_compra
      using errcode = 'P0001', hint = 'MOVIMIENTO_DE_COMPRA';
  end if;

  -- (iii) Ficha legible congelada (el ítem puede renombrarse o irse después).
  select i.codigo, i.nombre into v_item_codigo, v_item_nombre
    from public.inventario_item i where i.id = v_mov.item_id;
  if v_mov.aeronave_id is not null then
    select a.matricula into v_matricula
      from public.aeronave a where a.id = v_mov.aeronave_id;
  end if;
  select u.nombre into v_usuario_nombre
    from public.usuario u where u.id = p_usuario;

  -- (iv) Gastos ligados al movimiento, BLOQUEADOS en orden estable (id) para
  -- que dos borrados concurrentes no se traben entre sí.
  select coalesce(array_agg(s.id), '{}'::uuid[])
    into v_gasto_ids
    from (
      select g.id
        from public.gasto g
       where g.inventario_movimiento_id = p_movimiento
       order by g.id
         for update
    ) s;

  if array_length(v_gasto_ids, 1) > 0 then
    -- ENUMs comparados SIEMPRE como texto (categoria_gasto, medio_pago).
    select
        count(*) filter (
          where not (g.categoria::text = 'REFACCION'
                 and g.medio_pago::text = 'BODEGA')),
        count(*) filter (
          where g.conciliado
             or g.factura_recibida_id is not null
             or g.estatus_facturacion::text = 'FACTURADA'
             -- Pago de una COMPRA (la FK es set null: lo dejaría suelto).
             or g.compra_id is not null
             -- Conciliación PARCIAL (14-sep): cargos ligados sin la bandera.
             or exists (select 1 from public.movimiento_bancario mb
                         where mb.gasto_id = g.id)
             -- El amarre factura↔gasto NO es simétrico (pendiente conocido:
             -- `factura_recibida.gasto_id` no siempre escribe el espejo en
             -- `gasto.factura_recibida_id`). Esa FK también es `set null`:
             -- sin esta condición, borrar el gasto dejaría la factura
             -- recibida apuntando a nada, en silencio.
             or exists (select 1 from public.factura_recibida fr
                         where fr.gasto_id = g.id))
      into v_ajenos, v_bloqueados
      from public.gasto g
     where g.id = any(v_gasto_ids);

    if v_bloqueados > 0 then
      raise exception 'GASTO_BLOQUEADO: % de los gastos de este movimiento ya están conciliados con el banco o facturados; desconcílialos o desfactúralos antes de eliminarlo.', v_bloqueados
        using errcode = 'P0001', hint = 'GASTO_BLOQUEADO';
    end if;
    if v_ajenos > 0 then
      raise exception 'GASTO_BLOQUEADO: % gasto(s) ligados a este movimiento ya no son REFACCION de bodega (alguien los cambió en Gastos); revísalos ahí antes de eliminarlo.', v_ajenos
        using errcode = 'P0001', hint = 'GASTO_BLOQUEADO';
    end if;

    -- Snapshot COMPLETO de cada gasto + matrícula + repartos (gasto_reparto
    -- se borra en CASCADA con el gasto: sin esto, el reparto desaparecería
    -- sin dejar rastro).
    select coalesce(jsonb_agg(s.fila order by s.orden), '[]'::jsonb)
      into v_gastos_snapshot
      from (
        select g.created_at as orden,
               to_jsonb(g) || jsonb_build_object(
                 'aeronave_matricula',
                 (select a.matricula from public.aeronave a where a.id = g.aeronave_id),
                 'repartos',
                 coalesce((select jsonb_agg(to_jsonb(r))
                             from public.gasto_reparto r where r.gasto_id = g.id),
                          '[]'::jsonb)
               ) as fila
          from public.gasto g
         where g.id = any(v_gasto_ids)
      ) s;

    -- ATRIBUCIÓN del DELETE en gasto_bitacora: el trigger trg_gasto_bitacora
    -- (función public.tg_gasto_bitacora) toma OLD.updated_by como actor, así
    -- que se sella ANTES de borrar. El UPDATE solo de updated_by no deja fila
    -- propia: esa columna NO está en la lista de campos de negocio del
    -- trigger, y con el diff vacío hace `return new` sin insertar.
    update public.gasto
       set updated_by = p_usuario
     where id = any(v_gasto_ids);

    delete from public.gasto where id = any(v_gasto_ids);
  end if;

  -- (v) AUDITORÍA ANTES DEL BORRADO, en la misma transacción: si el delete
  -- falla, no queda auditoría; si la auditoría falla, no hay borrado.
  insert into public.inventario_movimiento_eliminado (
    movimiento_id, item_id, item_codigo, item_nombre, tipo, cantidad,
    fecha_movimiento, aeronave_matricula, motivo, snapshot, gastos_snapshot,
    client_request_id, eliminado_por, eliminado_por_nombre
  ) values (
    v_mov.id, v_mov.item_id, v_item_codigo, v_item_nombre,
    v_mov.tipo::text, v_mov.cantidad, v_mov.fecha_movimiento, v_matricula,
    v_motivo, to_jsonb(v_mov), v_gastos_snapshot,
    v_mov.client_request_id, p_usuario, v_usuario_nombre
  )
  returning id into v_auditoria;

  delete from public.inventario_movimiento where id = p_movimiento;

  return jsonb_build_object(
    'auditoria_id', v_auditoria,
    'gastos_eliminados', coalesce(array_length(v_gasto_ids, 1), 0)
  );
end $function$;

comment on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) is
  'Borra ATÓMICAMENTE un movimiento de cardex, los gastos REFACCION/BODEGA que generó y deja la fila de auditoría (motivo, quién, snapshots). Candados: movimiento de COMPRA, gasto conciliado/facturado/con cargo bancario, gasto que ya no es de bodega. Los candados de FIFO (stock negativo, costo de otras salidas) los evalúa el API antes de llamarla.';

-- Solo el API (service key). El default de Postgres es EXECUTE a PUBLIC.
revoke execute on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) to service_role;
