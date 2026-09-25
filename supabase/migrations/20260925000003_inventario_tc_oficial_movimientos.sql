-- 25-sep-2026 · T.C. OFICIAL DEL DÍA en los movimientos de inventario en
-- DÓLARES que no traen tipo de cambio. MIGRACIÓN DE DATOS (API 0.0.36).
--
-- Pedido del cliente (25-sep-2026, ficha del producto): «En el tipo de
-- cambio, que sea los mismos que usan en las cotizaciones (Tipo de cambio del
-- día de la venta)» — la ficha decía «$21.25 USD sin TC · no se cuenta en
-- pesos» y «Total compras … $0.00 MXN». Desde el API 0.0.36 todo movimiento
-- NUEVO en dólares sella al escribirse el T.C. oficial de SU día
-- (`TipoCambioService.oficialDetallePara`, la función del cotizador). Esta
-- migración le pone ESE MISMO T.C. a los que ya existían sin él.
--
-- REGLA (idéntica a la del cotizador, pero SOLO con la tabla — nada de
-- descargas desde SQL): T.C. = la fila de `tipo_cambio_oficial` más reciente
-- con `fecha ∈ [fecha_movimiento − 7, fecha_movimiento]` (ventana de 7 días de
-- `oficialDetallePara`). Compras al T.C. del día de la compra; la venta Y el
-- costo de una salida al T.C. del día de la VENTA (el de la fila de la
-- salida).
--
-- POBLACIÓN EXACTA (SELECT del 25-sep-2026): movimientos con `tc_usd_mxn`
-- null, capturados en USD (costo o venta) y REGISTRADOS antes del 23-sep-2026
-- 00:00 Cancún (`created_at`). Son 77, en tres grupos, cada uno con el T.C. de
-- SU propio día:
--
--   grupo                                        n   T.C.      total USD                  total MXN (round2(total × tc))
--   ENTRADA 2026-08-29 (carga VTF-INV-001)      63   17.0115   79,470.29                  1,351,908.88
--   ENTRADA 2026-09-01 (capturadas el 21-sep)    4   17.0077    1,069.92                     18,196.87
--   SALIDA  2026-09-01 (tienda, re-preciadas)   10   17.0077   costo 2,141.33             costo 36,419.10
--                                                             venta 2,676.68             venta 45,524.17 · utilidad 9,105.07
--
-- Las 10 salidas, fila por fila (el spec `inventario-tc-oficial.spec.ts` LEE
-- las líneas entre «SALIDAS:INICIO» y «SALIDAS:FIN» y las ata al util del
-- inventario — `ventaDeSalida` — con el T.C. 17.0077):
--
-- SALIDAS:INICIO
--   mov_id                               cant  costo     venta     venta_usd  venta_mxn  costo_mxn  utilidad_mxn  utilidad_usd
--   40da8327-e60f-41aa-a061-8071ed1f9fc3  12   21.2500   26.5625   318.75     5421.20    4336.96    1084.24       63.75
--   19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7  24   21.2500   26.5625   637.50     10842.41   8673.93    2168.48       127.50
--   e8920cba-2c8d-427a-b36c-13683630d1f1   2   46.0600   57.5750   115.15     1958.44    1566.75    391.69        23.03
--   63c2a335-98e3-45f6-a665-6ba8b9d07807   1   46.0600   57.5750   57.58      979.30     783.37     195.93        11.52
--   8452b4f4-e7fb-4632-972a-a3f7d2bb948c   1   155.9400  194.9250  194.93     3315.31    2652.18    663.13        38.99
--   276f0524-ad50-4194-9e00-ca8782026fcb   1   192.1900  240.2375  240.24     4085.93    3268.71    817.22        48.05
--   2872370e-c9d1-4926-b0aa-69251621dc99   1   373.7500  467.1875  467.19     7945.83    6356.63    1589.20       93.44
--   e71c2c97-38e2-421e-af31-537ee8c97fe9   1   373.7500  467.1875  467.19     7945.83    6356.63    1589.20       93.44
--   72b9b33f-facb-4cb7-8677-def258c921d1   4   23.1300   28.9125   115.65     1966.94    1573.55    393.39        23.13
--   142888c2-2ab4-441e-a8e9-649d9cc97410   1   50.0000   62.5000   62.50      1062.98    850.39     212.59        12.50
-- SALIDAS:FIN
--   Σ venta 45,524.17 · costo 36,419.10 · utilidad 9,105.07 MXN (535.35 USD
--   original). Por avión: N4142R +5,025.09 · XA-VGV +4,079.98 MXN.
--
-- QUÉ NO SE TOCA:
--   - `gasto` (ni `monto` ni `tc_gasto`): los 10 gastos BODEGA del 01-sep
--     siguen con `tc_gasto` null. El Balance general NO se mueve: desde el API
--     0.0.36 su hoja «refacciones» convierte el COSTO de cada salida con el
--     MISMO T.C. con que convierte su VENTA (el `tc_gasto` de su gasto, o el
--     T.C. promedio del libro — `refacciones-costo.util.ts`), ya no con el
--     `tc_usd_mxn` del movimiento. Sin ese ajuste esta migración habría subido
--     ≈ $250 MXN la ganancia de septiembre en esa hoja.
--   - Los 4 movimientos en PESOS (aceite 13-jul y sus 3 salidas, T.C. 17.51).
--   - `notas` / `updated_by` de los 77 (el rastro es este archivo; `updated_at`
--     lo pone el trigger `trg_inventario_movimiento_set_updated_at`).
--   - Lo registrado DESPUÉS del corte: jamás se toca a ciegas, se informa en
--     el mensaje (con el API 0.0.36 ya nace con su T.C.).
--
-- DIFERENCIA VISIBLE QUE QUEDA (aceptada, R2 del diseño): en la hoja
-- «inventario» del Balance general de SEPTIEMBRE, la utilidad por ítem
-- (bloque 1, T.C. 17.0077 del día de la venta) y el detalle de salidas
-- (bloque 2, T.C. del gasto ⇒ promedio del libro) difieren ≈ $60 MXN para las
-- MISMAS 10 salidas; pyservices lo explica con una nota bajo el bloque 2.
--
-- TOLERANCIA A UN SUBCONJUNTO: con el API 0.0.36 vivo, un «Editar costo»
-- sobre una de estas entradas le pone su T.C. y la saca del WHERE; la guarda
-- POR FILA exige que cada candidato sea de uno de los 3 grupos y reciba
-- EXACTAMENTE el T.C. de su día, y acepta ≤ 63/4/10. Cualquier fila ajena ⇒
-- TC_ABORTADO sin escribir nada.
--
-- `inventario_movimiento.moneda`/`venta_moneda` son varchar (el `::text` no
-- estorba); `tipo` es ENUM ⇒ `tipo::text`. No hay variables `text` contra un
-- ENUM.
--
-- ORDEN DE DEPLOY: DESPUÉS del API 0.0.36 (con el 0.0.35 vivo las ventas
-- quedarían a 17.0077 contra un costo FIFO a 17.0115 hasta desplegar). El API
-- 0.0.36 tolera la migración sin aplicar (los 77 siguen «sin T.C.» con el
-- respaldo en dólares de 0.0.35). Tras aplicar: `TC_OK: 77 …`;
-- `GET /v1/inventory/tienda/resumen` ⇒ `utilidad_mxn 9105.07`,
-- `utilidad_usd null`, `utilidad_usd_original 535.35`; `get_advisors` (sin
-- DDL, por regla).
--
-- La función vive en `pg_temp` (desaparece con la sesión) para que el
-- DRY-RUN pueda correr el MISMO cuerpo varias veces dentro de UNA sentencia.
-- Es IDEMPOTENTE: si ya no queda ningún candidato responde TC_YA_APLICADO y
-- no toca nada.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR — en UNA llamada de `execute_sql`:
-- la sección 1) de abajo TAL CUAL (el `create or replace function`, SIN la
-- sección 2) + este bloque. Escrituras REALES (DELETE de T.C., INSERT de un
-- movimiento posterior, la migración dos veces, el UPDATE de la sección 3)
-- que terminan en `raise exception 'DRYRUN_OK …'` ⇒ todo se revierte.
-- Cualquier 'DRYRUN_FALLA …', 'TC_ABORTADO …' u otro error ⇒ NO aplicar.
--
--   do $dry$
--   declare
--     v_g0 text; v_g1 text; v_b0 bigint; v_m0 bigint; v_h0 text; v_h1 text; v_res text;
--     v_venta numeric; v_costo numeric; v_c1 numeric; v_c2 numeric; v_n integer;
--     v_fake uuid; v_item uuid; v_user uuid;
--   begin
--     -- Huellas de FILA COMPLETA (`to_jsonb` cubre TODAS las columnas). En el
--     -- cardex se excluye SOLO lo que la migración puede mover (tc_usd_mxn, y
--     -- updated_at que pone el trigger).
--     select md5(string_agg(to_jsonb(g)::text, ',' order by g.id)) into v_g0 from public.gasto g;
--     select count(*) into v_b0 from public.gasto_bitacora;
--     select count(*) into v_m0 from public.inventario_movimiento;
--     select md5(string_agg((to_jsonb(m) - 'tc_usd_mxn' - 'updated_at')::text, ',' order by m.id))
--       into v_h0 from public.inventario_movimiento m;
--
--     -- C0) CANDADO: sin T.C. oficial para esos días la función ABORTA y no escribe (subtransacción).
--     --     La fila más cercana fuera del rango borrado es el 21-ago, que NO cae en la
--     --     ventana [22-ago, 29-ago] ⇒ se ejerce de verdad la rama «sin T.C.».
--     begin
--       delete from public.tipo_cambio_oficial where fecha between date '2026-08-25' and date '2026-09-01';
--       perform pg_temp.vt_tc_oficial_inventario();
--       raise exception 'DRYRUN_FALLA C0: corrió sin T.C. oficial';
--     exception when others then
--       if sqlerrm not like 'TC_ABORTADO%' then raise exception 'DRYRUN_FALLA C0: %', sqlerrm; end if;
--     end;
--     if (select count(*) from public.inventario_movimiento
--          where tc_usd_mxn is null and (moneda::text = 'USD' or coalesce(venta_moneda::text, '') = 'USD')) <> 77
--        or (select count(*) from public.tipo_cambio_oficial where fecha between date '2026-08-25' and date '2026-09-01') < 4 then
--       raise exception 'DRYRUN_FALLA C0: quedó algo escrito o no se restauró el T.C.'; end if;
--     raise notice 'okC0 · sin T.C. oficial aborta sin escribir';
--
--     -- C0b) Movimiento POSTERIOR sin T.C. (INSERT REAL, created_at = now()): la migración NO lo toca y lo informa
--     select item_id, registrado_por into v_item, v_user from public.inventario_movimiento
--      where tipo::text = 'ENTRADA' and fecha_movimiento = date '2026-08-29' limit 1;
--     insert into public.inventario_movimiento (item_id, tipo, cantidad, costo_unitario_usd, moneda, fecha_movimiento, registrado_por, notas)
--     values (v_item, 'ENTRADA', 1, 1, 'USD', date '2026-09-01', v_user, 'DRYRUN posterior sin TC')
--     returning id into v_fake;
--
--     -- C1) PRIMERA corrida · C2) SEGUNDA = no-op
--     v_res := pg_temp.vt_tc_oficial_inventario();
--     if v_res not like 'TC_OK: %' or v_res not like '%1 movimiento(s) posteriores%' then
--       raise exception 'DRYRUN_FALLA C1: %', v_res; end if;
--     if (select tc_usd_mxn from public.inventario_movimiento where id = v_fake) is not null then
--       raise exception 'DRYRUN_FALLA C1: tocó un movimiento posterior al 22-sep'; end if;
--     v_res := pg_temp.vt_tc_oficial_inventario();
--     if v_res not like 'TC_YA_APLICADO%(77 de los 77%' then raise exception 'DRYRUN_FALLA C2: %', v_res; end if;
--     delete from public.inventario_movimiento where id = v_fake;
--     raise notice 'okC0b/C1/C2 · 77, el posterior intacto y luego idempotente';
--
--     -- C3) T.C. por grupo; ya no queda USD sin T.C.
--     if (select count(*) from public.inventario_movimiento where tipo::text = 'ENTRADA' and moneda::text = 'USD' and fecha_movimiento = date '2026-08-29' and tc_usd_mxn = 17.0115) <> 63
--        or (select count(*) from public.inventario_movimiento where tipo::text = 'ENTRADA' and moneda::text = 'USD' and fecha_movimiento = date '2026-09-01' and tc_usd_mxn = 17.0077) <> 4
--        or (select count(*) from public.inventario_movimiento where tipo::text = 'SALIDA'  and moneda::text = 'USD' and fecha_movimiento = date '2026-09-01' and tc_usd_mxn = 17.0077) <> 10
--        or exists (select 1 from public.inventario_movimiento where tc_usd_mxn is null and (moneda::text = 'USD' or coalesce(venta_moneda::text, '') = 'USD')) then
--       raise exception 'DRYRUN_FALLA C3: T.C. por grupo'; end if;
--     -- C4) los 4 movimientos en PESOS conservan su 17.51
--     if (select count(*) from public.inventario_movimiento where moneda::text = 'MXN' and tc_usd_mxn = 17.51) <> 4 then
--       raise exception 'DRYRUN_FALLA C4: se tocó un movimiento en pesos'; end if;
--     raise notice 'okC3/C4 · 63 × 17.0115 · 4 + 10 × 17.0077 · pesos intactos';
--
--     -- C5) PESOS con la regla del API (total nativo redondeado × T.C., redondeado)
--     select sum(round(round(cantidad * venta_unitaria, 2) * tc_usd_mxn, 2)),
--            sum(round(round(cantidad * costo_unitario_usd, 2) * tc_usd_mxn, 2))
--       into v_venta, v_costo
--       from public.inventario_movimiento
--      where tipo::text = 'SALIDA' and moneda::text = 'USD' and fecha_movimiento = date '2026-09-01';
--     if v_venta <> 45524.17 or v_costo <> 36419.10 or v_venta - v_costo <> 9105.07 then
--       raise exception 'DRYRUN_FALLA C5: ventas % / costo %', v_venta, v_costo; end if;
--     select sum(round(round(cantidad * costo_unitario_usd, 2) * tc_usd_mxn, 2)) filter (where fecha_movimiento = date '2026-08-29'),
--            sum(round(round(cantidad * costo_unitario_usd, 2) * tc_usd_mxn, 2)) filter (where fecha_movimiento = date '2026-09-01')
--       into v_c1, v_c2
--       from public.inventario_movimiento where tipo::text = 'ENTRADA' and moneda::text = 'USD';
--     if v_c1 <> 1351908.88 or v_c2 <> 18196.87 then
--       raise exception 'DRYRUN_FALLA C5: compras % / %', v_c1, v_c2; end if;
--     raise notice 'okC5 · ventas 45,524.17 · costo 36,419.10 · utilidad 9,105.07 · compras 1,351,908.88 + 18,196.87 MXN';
--
--     -- C6) NADA MÁS CAMBIÓ: gastos (fila completa), bitácora, conteo y el resto de columnas del cardex
--     select md5(string_agg(to_jsonb(g)::text, ',' order by g.id)) into v_g1 from public.gasto g;
--     select md5(string_agg((to_jsonb(m) - 'tc_usd_mxn' - 'updated_at')::text, ',' order by m.id))
--       into v_h1 from public.inventario_movimiento m;
--     if v_g1 <> v_g0 or v_h1 <> v_h0
--        or (select count(*) from public.gasto_bitacora) <> v_b0
--        or (select count(*) from public.inventario_movimiento) <> v_m0 then
--       raise exception 'DRYRUN_FALLA C6: cambió algo más que tc_usd_mxn'; end if;
--
--     -- C7) SECCIÓN 3 (UPDATE REAL de la descripción): 1 fila la primera vez, 0 la segunda
--     update public.configuracion_sistema
--        set descripcion = 'Utilidad de la tienda VuelaTour: porcentaje que se suma al ÚLTIMO PRECIO DE COMPRA cuando una salida de bodega a un avión no trae precio de venta (25 = el avión paga el último precio + 25 %). 0 = las salidas sin precio se cargan a costo. Aplica a las salidas NUEVAS.'
--      where clave = 'inventario_margen_venta_pct' and descripcion ilike '%costo FIFO%';
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA C7: descripción % filas', v_n; end if;
--     update public.configuracion_sistema set descripcion = descripcion
--      where clave = 'inventario_margen_venta_pct' and descripcion ilike '%costo FIFO%';
--     get diagnostics v_n = row_count;
--     if v_n <> 0 then raise exception 'DRYRUN_FALLA C7: la descripción no es idempotente'; end if;
--     if (select valor_numerico from public.configuracion_sistema where clave = 'inventario_margen_venta_pct') <> 25 then
--       raise exception 'DRYRUN_FALLA C7: cambió el margen'; end if;
--
--     raise exception 'DRYRUN_OK · C0 sin T.C. aborta · C0b posterior intacto · C1 77 · C2 idempotente · C3/C4 T.C. por grupo, pesos intactos · C5 ventas 45,524.17 / costo 36,419.10 / utilidad 9,105.07 / compras 1,351,908.88 + 18,196.87 · C6 gastos y cardex intactos (fila completa) · C7 descripción 1→0 · todo se revierte';
--   end $dry$;
-- ---------------------------------------------------------------------------

-- 1) CUERPO (el dry-run lo pega TAL CUAL)
create or replace function pg_temp.vt_tc_oficial_inventario()
returns text
language plpgsql
as $fn$
declare
  v_pend integer;
  v_sin_tc integer;
  v_ajenos integer;
  v_listos integer;
  v_nuevos integer;
  v_upd integer;
begin
  drop table if exists pg_temp._tc_inv;
  -- Movimientos que piden T.C.: capturados en USD (costo o venta), sin T.C. y
  -- REGISTRADOS ANTES del 23-sep-2026 (la población del 25-sep: carga del
  -- 29-ago, 4 entradas capturadas el 21-sep y 10 salidas capturadas el
  -- 22-sep). Lo que se capture DESPUÉS (API 0.0.36 ya les pone el T.C. al
  -- escribir; si alguno quedara sin T.C. porque no había dato) NO entra: se
  -- informa en el mensaje, jamás se toca a ciegas.
  -- T.C. = el de tipo_cambio_oficial más reciente en [fecha−7, fecha] (misma
  -- ventana que TipoCambioService.oficialDetallePara, la del cotizador).
  create temp table _tc_inv on commit drop as
  select m.id, m.tipo::text as tipo, m.fecha_movimiento, t.tc, t.fecha as fecha_dato
    from public.inventario_movimiento m
    left join lateral (
      select o.tc, o.fecha
        from public.tipo_cambio_oficial o
       where o.fecha between m.fecha_movimiento - 7 and m.fecha_movimiento
         and o.tc > 0
       order by o.fecha desc
       limit 1
    ) t on true
   where m.tc_usd_mxn is null
     and (m.moneda::text = 'USD' or coalesce(m.venta_moneda::text, '') = 'USD')
     and m.created_at < timestamptz '2026-09-23 00:00:00-05';
  select count(*) into v_pend from _tc_inv;
  select count(*) into v_nuevos
    from public.inventario_movimiento m
   where m.tc_usd_mxn is null
     and (m.moneda::text = 'USD' or coalesce(m.venta_moneda::text, '') = 'USD')
     and m.created_at >= timestamptz '2026-09-23 00:00:00-05';

  if v_pend = 0 then
    select count(*) into v_listos
      from public.inventario_movimiento m
     where m.moneda::text = 'USD'
       and m.created_at < timestamptz '2026-09-23 00:00:00-05'
       and (   (m.tipo::text = 'ENTRADA' and m.fecha_movimiento = date '2026-08-29' and m.tc_usd_mxn = 17.0115)
            or (m.tipo::text = 'ENTRADA' and m.fecha_movimiento = date '2026-09-01' and m.tc_usd_mxn = 17.0077)
            or (m.tipo::text = 'SALIDA'  and m.fecha_movimiento = date '2026-09-01' and m.tc_usd_mxn = 17.0077));
    return format('TC_YA_APLICADO: no queda ningún movimiento USD sin tipo de cambio de antes del 23-sep (%s de los 77 ya tienen el T.C. oficial; %s posteriores sin T.C. no se tocan); no se tocó nada.', v_listos, v_nuevos);
  end if;

  select count(*) into v_sin_tc from _tc_inv where tc is null;
  if v_sin_tc > 0 then
    raise exception 'TC_ABORTADO: % movimiento(s) sin T.C. oficial en tipo_cambio_oficial dentro de la ventana de 7 días. No se escribió nada.', v_sin_tc;
  end if;

  -- GUARDAS EXACTAS POR FILA: todo candidato es de uno de los 3 grupos del
  -- 25-sep-2026 y recibe EXACTAMENTE el T.C. de su propio día. Se tolera un
  -- SUBCONJUNTO (≤ 63/4/10: una entrada a la que el API 0.0.36 ya le puso su
  -- T.C. al «Editar costo» sale sola del WHERE), jamás una fila ajena.
  select count(*) into v_ajenos
    from _tc_inv
   where not (   (tipo = 'ENTRADA' and fecha_movimiento = date '2026-08-29' and tc = 17.0115 and fecha_dato = date '2026-08-29')
              or (tipo = 'ENTRADA' and fecha_movimiento = date '2026-09-01' and tc = 17.0077 and fecha_dato = date '2026-09-01')
              or (tipo = 'SALIDA'  and fecha_movimiento = date '2026-09-01' and tc = 17.0077 and fecha_dato = date '2026-09-01'));
  if v_ajenos > 0
     or v_pend > 77
     or (select count(*) from _tc_inv where tipo = 'ENTRADA' and fecha_movimiento = date '2026-08-29') > 63
     or (select count(*) from _tc_inv where tipo = 'ENTRADA' and fecha_movimiento = date '2026-09-01') > 4
     or (select count(*) from _tc_inv where tipo = 'SALIDA'  and fecha_movimiento = date '2026-09-01') > 10
  then
    raise exception 'TC_ABORTADO: los movimientos USD sin T.C. ya no son (un subconjunto de) los 77 del 25-sep-2026 (hay %, % fuera de los 3 grupos). Revisa antes de aplicar. No se escribió nada.', v_pend, v_ajenos;
  end if;

  update public.inventario_movimiento m
     set tc_usd_mxn = t.tc
    from _tc_inv t
   where m.id = t.id
     and m.tc_usd_mxn is null;
  get diagnostics v_upd = row_count;
  if v_upd <> v_pend then
    raise exception 'TC_ABORTADO: se actualizaron % de % movimientos; se revierte todo.', v_upd, v_pend;
  end if;

  return format('TC_OK: %s movimientos con el T.C. oficial de su día (entradas del 29-ago a 17.0115; entradas y salidas del 01-sep a 17.0077). Ningún gasto se tocó. %s movimiento(s) posteriores al 22-sep sin T.C. no se tocaron.', v_upd, v_nuevos);
end
$fn$;

-- 2) EJECUCIÓN (NO va en el dry-run)
select pg_temp.vt_tc_oficial_inventario();

-- 3) Descripción de la configuración (solo texto; idempotente por el ilike)
update public.configuracion_sistema
   set descripcion = 'Utilidad de la tienda VuelaTour: porcentaje que se suma al ÚLTIMO PRECIO DE COMPRA cuando una salida de bodega a un avión no trae precio de venta (25 = el avión paga el último precio + 25 %). 0 = las salidas sin precio se cargan a costo. Aplica a las salidas NUEVAS.'
 where clave = 'inventario_margen_venta_pct' and descripcion ilike '%costo FIFO%';

-- ---------------------------------------------------------------------------
-- ROLLBACK (comentado; solo con decisión de la oficina). Mismo corte de
-- población que el WHERE de la migración: registrados antes del 23-sep.
--
-- update public.inventario_movimiento set tc_usd_mxn = null
--  where moneda::text = 'USD' and created_at < timestamptz '2026-09-23 00:00:00-05'
--    and ((tipo::text = 'ENTRADA' and fecha_movimiento in (date '2026-08-29', date '2026-09-01'))
--      or (tipo::text = 'SALIDA'  and fecha_movimiento = date '2026-09-01'))
--    and tc_usd_mxn in (17.0115, 17.0077);
