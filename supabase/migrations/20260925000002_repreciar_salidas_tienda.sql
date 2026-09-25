-- 25-sep-2026 · RE-PRECIO de las 10 SALIDAS de bodega del 01-sep-2026 a
-- COSTO FIFO + 25 % (utilidad de la tienda VuelaTour). MIGRACIÓN DE DATOS.
--
-- Pedido del cliente (25-sep-2026): «Por ahora ya echamos a andar la venta de
-- VuelaTour, que viene siendo la "tienda"; ya se cargaron varios productos en
-- los aviones y necesitamos ver las ganancias de dichos productos» + la
-- regla «el precio que le ponemos en el costo se le saca el 25 % el cual va
-- a ser nuestra utilidad». Decisión tomada (autorizada por la oficina): las
-- 10 salidas capturadas el 22-sep con fecha 01-sep —que hoy llevan venta =
-- costo (utilidad 0)— se re-precian a costo FIFO + 25 %; cada avión paga ese
-- precio en su gasto BODEGA. Las 3 salidas VIEJAS sin venta (aceite 15W-50:
-- 17-jul N4142R ×4, 20-jul XB-PEV ×2, 06-ago N990GG ×24, en pesos, antes de
-- la tienda) NO se tocan: no están en la tabla de casos.
--
-- REGLA EXACTA DEL API (no hay otra): venta unitaria =
-- `ventaUnitariaConMargen(costo, 25)` = round(costo × 1.25, 4) y monto del
-- gasto = `montoGastoDeSalida` = round(cantidad × venta, 2)
-- (`src/modules/inventory/inventario-cardex.util.ts`). El spec
-- `repreciar-salidas-tienda.spec.ts` LEE las tuplas entre las marcas
-- «CASOS:INICIO» y «CASOS:FIN» de la sección 1) y exige que coincidan al
-- centavo con esas funciones TS (y con el cardex real de prod vía
-- `ventaDeSalida`).
--
--   mov_id                               gasto_id                             avión   producto        cant  costo    venta nueva monto viejo monto nuevo utilidad
--   40da8327-e60f-41aa-a061-8071ed1f9fc3 127a997d-f7e4-4318-af41-e203f86fa12c XA-VGV  Aceite 15W-50   12   21.2500  26.5625       255.00      318.75   63.75
--   19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7 a8983eff-5c07-4391-9d69-acecbadf4be2 N4142R  Aceite 15W-50   24   21.2500  26.5625       510.00      637.50  127.50
--   e8920cba-2c8d-427a-b36c-13683630d1f1 4d33a226-03c0-4428-b113-1364e1a63ab2 N4142R  Filtro CH48108   2   46.0600  57.5750        92.12      115.15   23.03
--   63c2a335-98e3-45f6-a665-6ba8b9d07807 9280535d-1873-467b-8afd-85508a02ba1a XA-VGV  Filtro CH48110   1   46.0600  57.5750        46.06       57.58   11.52
--   8452b4f4-e7fb-4632-972a-a3f7d2bb948c 4af748ab-5db7-475f-8a21-6ebf96c95851 N4142R  Cámara 6.00-6    1  155.9400 194.9250       155.94      194.93   38.99
--   276f0524-ad50-4194-9e00-ca8782026fcb cb907546-b174-45bf-bd24-2e7ed1c7e9fa XA-VGV  Cámara 8.00-6    1  192.1900 240.2375       192.19      240.24   48.05
--   2872370e-c9d1-4926-b0aa-69251621dc99 a213bf39-68ab-4628-9fa7-cb7efb0d4fdd XA-VGV  Llanta 6.00-6    1  373.7500 467.1875       373.75      467.19   93.44
--   e71c2c97-38e2-421e-af31-537ee8c97fe9 385e8123-455a-4f27-b574-989ccb5098ee N4142R  Llanta 6.00-6    1  373.7500 467.1875       373.75      467.19   93.44
--   72b9b33f-facb-4cb7-8677-def258c921d1 3eded68b-a8f3-4f9e-b103-610cab9de88b XA-VGV  Balata 66-105    4   23.1300  28.9125        92.52      115.65   23.13
--   142888c2-2ab4-441e-a8e9-649d9cc97410 bb56720f-2ded-4599-a9f8-bcfc305d9caf N4142R  Cubre pitot      1   50.0000  62.5000        50.00       62.50   12.50
--
--   Totales (USD, sin T.C.): antes 2,141.33 → 2,676.68 · utilidad 535.35.
--   N4142R 1,181.81 → 1,477.27 (+295.46) · XA-VGV 959.52 → 1,199.41 (+239.89).
--
-- ⚠ 1 ¢ POR AVIÓN CONTRA LO AUTORIZADO (+295.45 / +239.88 / +535.33): esas
-- cifras son el 25 % del SUBTOTAL por avión. La regla del API redondea POR
-- SALIDA (así nace cada gasto) y dos casos quedan en medio centavo: 46.06 ×
-- 1.25 = 57.575 → 57.58 y 155.94 × 1.25 = 194.925 → 194.93 (JS y `numeric`
-- de Postgres coinciden: medio hacia arriba). Es la única forma de que el
-- gasto = la venta que lee la utilidad. Avisar a la oficina: N4142R
-- +$295.46, XA-VGV +$239.89, total +$535.35 USD.
--
-- CANDADOS DE GASTO REVISADOS (25-sep, SELECT en prod) — ninguno bloquea:
--   - Ventana semanal (`dias_gracia_gastos_semana`) / `assertOwnSameDay`:
--     candados del API para ROLES DE CAMPO; esta migración escribe por SQL y
--     la oficina edita siempre ⇒ no aplica (fecha_gasto 01-sep ya fuera de la
--     ventana de campo).
--   - Sello de verificación: los 10 SIN sello; igual se limpia
--     (`verificado_por/at = null`), espejo del API al editar un gasto.
--   - Visto bueno: `requiere_visto_bueno = false` en los 10.
--   - Conciliado / cargo bancario ligado (conciliación PARCIAL) / factura
--     recibida / FACTURADA / `compra_id` / `gasto_reparto` / `ingreso`
--     ligado: 0 de 10. Son GUARDAS del WHERE: si alguno cambia antes de
--     aplicar, la función ABORTA sin escribir NADA.
--   - No hay cierre persistido de periodo. EFECTO REAL: el Balance de
--     SEPTIEMBRE de N4142R y XA-VGV (hoja refacciones, cascada y reparto a
--     socios) sube +295.46 / +239.89 USD de costo de refacción. Si alguien ya
--     compartió ese balance, el nuevo difiere.
--   - Bitácora: `trg_gasto_bitacora` registra 10 UPDATE con diff `monto` y
--     `notas`, `actor_id` null ⇒ el panel lo pinta «Sistema».
-- `gasto.moneda`/`categoria`/`medio_pago` son ENUM ⇒ se comparan `::text`;
-- `inventario_movimiento.moneda`/`venta_moneda` son varchar (el `::text` no
-- estorba). No hay variables `text` contra un ENUM.
--
-- La función vive en `pg_temp` (desaparece con la sesión) para que el
-- DRY-RUN pueda correr el MISMO cuerpo varias veces dentro de UNA sentencia.
-- Es IDEMPOTENTE: si las 10 ya están re-preciadas responde
-- REPRECIO_YA_APLICADO y no toca nada; si solo algunas cumplen las guardas,
-- REPRECIO_ABORTADO y no escribe nada.
--
-- ORDEN DE DEPLOY: después de la migración 20260925000001 y del API 0.0.35
-- (la utilidad USD la lee el API nuevo; esta migración no depende del
-- esquema nuevo).
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR — en UNA llamada de `execute_sql`:
-- la sección 1) de abajo TAL CUAL (el `create or replace function`, SIN la
-- sección 2) + este bloque. Termina en `raise exception 'DRYRUN_OK …'` ⇒
-- todo se revierte. Cualquier 'DRYRUN_FALLA …', 'REPRECIO_ABORTADO …' u otro
-- error ⇒ NO aplicar.
--
--   do $dry$
--   declare
--     v_b0 bigint; v_g0 bigint; v_m0 bigint; v_res text; v_n integer; r record;
--     v_n4 numeric; v_xa numeric; v_tot numeric;
--   begin
--     select count(*) into v_b0 from public.gasto_bitacora;
--     select count(*) into v_g0 from public.gasto;
--     select count(*) into v_m0 from public.inventario_movimiento;
--
--     -- C0) CANDADO: con UN gasto conciliado la función ABORTA y no escribe nada (subtransacción)
--     begin
--       update public.gasto set conciliado = true where id = '9280535d-1873-467b-8afd-85508a02ba1a';
--       perform pg_temp.vt_repreciar_salidas_tienda();
--       raise exception 'DRYRUN_FALLA C0: re-precio con un gasto conciliado';
--     exception when others then
--       if sqlerrm not like 'REPRECIO_ABORTADO%' then raise exception 'DRYRUN_FALLA C0: %', sqlerrm; end if;
--     end;
--     if (select monto from public.gasto where id = '9280535d-1873-467b-8afd-85508a02ba1a') <> 46.06
--        or (select conciliado from public.gasto where id = '9280535d-1873-467b-8afd-85508a02ba1a')
--        or (select count(*) from public.gasto_bitacora) <> v_b0 then
--       raise exception 'DRYRUN_FALLA C0: quedó algo escrito tras el aborto'; end if;
--     raise notice 'okC0 · un candado aborta todo';
--
--     -- C1) PRIMERA corrida · C2) SEGUNDA corrida = no-op
--     v_res := pg_temp.vt_repreciar_salidas_tienda();
--     if v_res not like 'REPRECIO_OK%' then raise exception 'DRYRUN_FALLA C1: %', v_res; end if;
--     v_res := pg_temp.vt_repreciar_salidas_tienda();
--     if v_res not like 'REPRECIO_YA_APLICADO%' then raise exception 'DRYRUN_FALLA C2: %', v_res; end if;
--     raise notice 'okC1/C2 · 10/10 y luego idempotente';
--
--     -- C3) IMPORTES AL CENTAVO (literales duplicados A PROPÓSITO: la tabla del cuerpo no se verifica a sí misma)
--     for r in select * from (values
--         ('40da8327-e60f-41aa-a061-8071ed1f9fc3'::uuid, '127a997d-f7e4-4318-af41-e203f86fa12c'::uuid, 26.5625::numeric, 318.75::numeric),
--         ('19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7'::uuid, 'a8983eff-5c07-4391-9d69-acecbadf4be2'::uuid, 26.5625, 637.50),
--         ('e8920cba-2c8d-427a-b36c-13683630d1f1'::uuid, '4d33a226-03c0-4428-b113-1364e1a63ab2'::uuid, 57.5750, 115.15),
--         ('63c2a335-98e3-45f6-a665-6ba8b9d07807'::uuid, '9280535d-1873-467b-8afd-85508a02ba1a'::uuid, 57.5750, 57.58),
--         ('8452b4f4-e7fb-4632-972a-a3f7d2bb948c'::uuid, '4af748ab-5db7-475f-8a21-6ebf96c95851'::uuid, 194.9250, 194.93),
--         ('276f0524-ad50-4194-9e00-ca8782026fcb'::uuid, 'cb907546-b174-45bf-bd24-2e7ed1c7e9fa'::uuid, 240.2375, 240.24),
--         ('2872370e-c9d1-4926-b0aa-69251621dc99'::uuid, 'a213bf39-68ab-4628-9fa7-cb7efb0d4fdd'::uuid, 467.1875, 467.19),
--         ('e71c2c97-38e2-421e-af31-537ee8c97fe9'::uuid, '385e8123-455a-4f27-b574-989ccb5098ee'::uuid, 467.1875, 467.19),
--         ('72b9b33f-facb-4cb7-8677-def258c921d1'::uuid, '3eded68b-a8f3-4f9e-b103-610cab9de88b'::uuid, 28.9125, 115.65),
--         ('142888c2-2ab4-441e-a8e9-649d9cc97410'::uuid, 'bb56720f-2ded-4599-a9f8-bcfc305d9caf'::uuid, 62.5000, 62.50)
--       ) as t(mov_id, gasto_id, venta, monto)
--     loop
--       if (select m.venta_unitaria from public.inventario_movimiento m where m.id = r.mov_id) is distinct from r.venta then
--         raise exception 'DRYRUN_FALLA C3: venta de % ≠ %', r.mov_id, r.venta; end if;
--       if (select g.monto from public.gasto g where g.id = r.gasto_id) is distinct from r.monto then
--         raise exception 'DRYRUN_FALLA C3: gasto % ≠ %', r.gasto_id, r.monto; end if;
--       if (select g.moneda::text || '|' || coalesce(g.tc_gasto::text, 'null') || '|' || g.fecha_gasto::text
--             || '|' || g.categoria::text || '|' || g.medio_pago::text || '|' || g.conciliado::text
--             from public.gasto g where g.id = r.gasto_id) <> 'USD|null|2026-09-01|REFACCION|BODEGA|false' then
--         raise exception 'DRYRUN_FALLA C3: el gasto % cambió algo más que monto/notas', r.gasto_id; end if;
--     end loop;
--     raise notice 'okC3 · importes al centavo';
--
--     -- C4) POR AVIÓN, TOTAL Y UTILIDAD
--     select coalesce(sum(g.monto) filter (where a.matricula = 'N4142R'), 0),
--            coalesce(sum(g.monto) filter (where a.matricula = 'XA-VGV'), 0),
--            coalesce(sum(g.monto), 0)
--       into v_n4, v_xa, v_tot
--       from public.gasto g join public.aeronave a on a.id = g.aeronave_id
--      where g.inventario_movimiento_id in (
--        '40da8327-e60f-41aa-a061-8071ed1f9fc3','19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7','e8920cba-2c8d-427a-b36c-13683630d1f1',
--        '63c2a335-98e3-45f6-a665-6ba8b9d07807','8452b4f4-e7fb-4632-972a-a3f7d2bb948c','276f0524-ad50-4194-9e00-ca8782026fcb',
--        '2872370e-c9d1-4926-b0aa-69251621dc99','e71c2c97-38e2-421e-af31-537ee8c97fe9','72b9b33f-facb-4cb7-8677-def258c921d1',
--        '142888c2-2ab4-441e-a8e9-649d9cc97410');
--     if v_n4 <> 1477.27 or v_xa <> 1199.41 or v_tot <> 2676.68 or v_tot - 2141.33 <> 535.35 then
--       raise exception 'DRYRUN_FALLA C4: N4142R % / XA-VGV % / total %', v_n4, v_xa, v_tot; end if;
--     raise notice 'okC4 · N4142R % · XA-VGV % · total % USD', v_n4, v_xa, v_tot;
--
--     -- C5) LAS 3 SALIDAS DE JUL/AGO INTACTAS
--     if exists (select 1 from public.inventario_movimiento
--                 where id in ('d45dae06-7478-4f33-a412-00ae6a57e588','a9378a18-54e1-4259-b65a-35de6dd533c0',
--                              '533fce35-6088-432b-b41f-a242aa471b42') and venta_unitaria is not null)
--        or (select sum(monto) from public.gasto
--             where id in ('1e0e8aa7-82b3-4d06-90da-471048aab62f','bb355265-1b7c-4a00-8a18-72bcbdbf17a1',
--                          '92fbc961-5e4c-4df7-be44-3ca67f37cae8')) <> 49749.90 then
--       raise exception 'DRYRUN_FALLA C5: se tocaron salidas viejas'; end if;
--     raise notice 'okC5 · jul/ago intactas';
--
--     -- C6) BITÁCORA: +10 exactas (la 2.ª corrida no suma), UPDATE, actor null, diff con monto y notas
--     if (select count(*) from public.gasto_bitacora) - v_b0 <> 10 then
--       raise exception 'DRYRUN_FALLA C6: bitácora +%', (select count(*) from public.gasto_bitacora) - v_b0; end if;
--     select count(*) into v_n from public.gasto_bitacora b
--      where b.created_at = now() and b.accion = 'UPDATE' and b.actor_id is null
--        and b.diff ? 'monto' and b.diff ? 'notas';
--     if v_n <> 10 then raise exception 'DRYRUN_FALLA C6: filas de bitácora bien formadas = %', v_n; end if;
--     if (select b.diff->'monto'->>'antes' || '→' || (b.diff->'monto'->>'despues') from public.gasto_bitacora b
--          where b.gasto_id = '9280535d-1873-467b-8afd-85508a02ba1a' and b.created_at = now()) <> '46.06→57.58' then
--       raise exception 'DRYRUN_FALLA C6: diff del filtro CH48110'; end if;
--     raise notice 'okC6 · bitácora +10 (actor Sistema)';
--
--     -- C7) NADA MÁS CAMBIÓ
--     if (select count(*) from public.gasto) <> v_g0 or (select count(*) from public.inventario_movimiento) <> v_m0 then
--       raise exception 'DRYRUN_FALLA C7: conteos'; end if;
--
--     raise exception 'DRYRUN_OK · C0 candado aborta sin escribir · C1 10/10 · C2 idempotente · C3 importes al centavo · C4 N4142R 1,477.27 / XA-VGV 1,199.41 / 2,676.68 USD (utilidad 535.35) · C5 jul/ago intactas · C6 bitácora +10 (actor Sistema) · C7 conteos · todo se revierte';
--   end $dry$;
--
-- TRAS APLICAR (secciones 1 y 2 juntas, vía MCP, prod bjesduasnzbzywofukbf):
--   - El `select` de la sección 2 responde 'REPRECIO_OK: 10 salidas y 10
--     gastos …' (si responde REPRECIO_YA_APLICADO, ya estaba; cualquier
--     REPRECIO_ABORTADO ⇒ no se escribió nada: revisar qué candado cambió).
--   - `select id, monto from gasto where inventario_movimiento_id in (…10…)`
--     = la columna «monto nuevo» de la tabla de arriba.
--   - `GET /v1/inventory/tienda/resumen` (API 0.0.35) ⇒ `utilidad_usd:
--     535.35`, `ventas_usd: 2676.68`, `costo_ventas_usd: 2141.33`.
--
-- ROLLBACK (al pie, comentado).
-- ---------------------------------------------------------------------------

-- 1) CUERPO (el dry-run lo pega TAL CUAL)
create or replace function pg_temp.vt_repreciar_salidas_tienda()
returns text
language plpgsql
as $fn$
declare
  v_total integer;
  v_listos integer;
  v_hechos integer;
  v_mov integer;
  v_gas integer;
begin
  drop table if exists pg_temp._reprecio_salidas;
  create temp table _reprecio_salidas (
    mov_id uuid primary key,
    gasto_id uuid not null unique,
    matricula text not null,
    cantidad numeric(12,2) not null,
    costo_unitario numeric(14,4) not null,
    venta_nueva numeric(14,4) not null,
    monto_viejo numeric(12,2) not null,
    monto_nuevo numeric(12,2) not null
  ) on commit drop;
  insert into _reprecio_salidas values
  -- CASOS:INICIO (mov_id, gasto_id, matrícula, cantidad, costo, venta_nueva, monto_viejo, monto_nuevo) — el spec jest lee ESTAS líneas
    ('40da8327-e60f-41aa-a061-8071ed1f9fc3'::uuid, '127a997d-f7e4-4318-af41-e203f86fa12c'::uuid, 'XA-VGV', 12.00, 21.2500, 26.5625, 255.00, 318.75),
    ('19b737b8-790d-4fbb-b4bb-dd3aaa7e9fd7'::uuid, 'a8983eff-5c07-4391-9d69-acecbadf4be2'::uuid, 'N4142R', 24.00, 21.2500, 26.5625, 510.00, 637.50),
    ('e8920cba-2c8d-427a-b36c-13683630d1f1'::uuid, '4d33a226-03c0-4428-b113-1364e1a63ab2'::uuid, 'N4142R', 2.00, 46.0600, 57.5750, 92.12, 115.15),
    ('63c2a335-98e3-45f6-a665-6ba8b9d07807'::uuid, '9280535d-1873-467b-8afd-85508a02ba1a'::uuid, 'XA-VGV', 1.00, 46.0600, 57.5750, 46.06, 57.58),
    ('8452b4f4-e7fb-4632-972a-a3f7d2bb948c'::uuid, '4af748ab-5db7-475f-8a21-6ebf96c95851'::uuid, 'N4142R', 1.00, 155.9400, 194.9250, 155.94, 194.93),
    ('276f0524-ad50-4194-9e00-ca8782026fcb'::uuid, 'cb907546-b174-45bf-bd24-2e7ed1c7e9fa'::uuid, 'XA-VGV', 1.00, 192.1900, 240.2375, 192.19, 240.24),
    ('2872370e-c9d1-4926-b0aa-69251621dc99'::uuid, 'a213bf39-68ab-4628-9fa7-cb7efb0d4fdd'::uuid, 'XA-VGV', 1.00, 373.7500, 467.1875, 373.75, 467.19),
    ('e71c2c97-38e2-421e-af31-537ee8c97fe9'::uuid, '385e8123-455a-4f27-b574-989ccb5098ee'::uuid, 'N4142R', 1.00, 373.7500, 467.1875, 373.75, 467.19),
    ('72b9b33f-facb-4cb7-8677-def258c921d1'::uuid, '3eded68b-a8f3-4f9e-b103-610cab9de88b'::uuid, 'XA-VGV', 4.00, 23.1300, 28.9125, 92.52, 115.65),
    ('142888c2-2ab4-441e-a8e9-649d9cc97410'::uuid, 'bb56720f-2ded-4599-a9f8-bcfc305d9caf'::uuid, 'N4142R', 1.00, 50.0000, 62.5000, 50.00, 62.50)
  -- CASOS:FIN
  ;
  select count(*) into v_total from _reprecio_salidas;

  -- ¿Ya re-preciadas? (idempotente: no se toca nada)
  select count(*) into v_hechos
    from _reprecio_salidas r
    join public.inventario_movimiento m on m.id = r.mov_id
    join public.gasto g on g.id = r.gasto_id
   where m.venta_unitaria = r.venta_nueva and g.monto = r.monto_nuevo;
  if v_hechos = v_total then
    return format('REPRECIO_YA_APLICADO: %s de %s salidas ya estaban a costo + 25 %%; no se tocó nada.', v_hechos, v_total);
  end if;

  -- GUARDAS: siguen EXACTAMENTE como el 22-sep (venta = costo, gasto = cant × costo,
  -- mismo avión) y sin candados de dinero.
  select count(*) into v_listos
    from _reprecio_salidas r
    join public.inventario_movimiento m on m.id = r.mov_id
    join public.gasto g on g.id = r.gasto_id and g.inventario_movimiento_id = m.id
    join public.aeronave a on a.id = g.aeronave_id and a.id = m.aeronave_id
   where m.tipo::text = 'SALIDA' and not m.para_flota
     and a.matricula = r.matricula
     and m.moneda::text = 'USD' and m.venta_moneda::text = 'USD' and m.tc_usd_mxn is null
     and m.cantidad = r.cantidad and m.costo_unitario_usd = r.costo_unitario
     and m.venta_unitaria = r.costo_unitario
     and g.monto = r.monto_viejo and g.moneda::text = 'USD' and g.tc_gasto is null
     and g.categoria::text = 'REFACCION' and g.medio_pago::text = 'BODEGA'
     and not g.conciliado and g.factura_recibida_id is null and g.compra_id is null
     and coalesce(g.estatus_facturacion, '') <> 'FACTURADA'
     and not exists (select 1 from public.movimiento_bancario b where b.gasto_id = g.id)
     and not exists (select 1 from public.factura_recibida f where f.gasto_id = g.id)
     and not exists (select 1 from public.gasto_reparto p where p.gasto_id = g.id)
     and not exists (select 1 from public.ingreso i where i.gasto_id = g.id)
     and (select count(*) from public.gasto g2 where g2.inventario_movimiento_id = m.id) = 1;
  if v_listos <> v_total then
    raise exception 'REPRECIO_ABORTADO: solo % de % salidas siguen como el 22-sep-2026 y sin candados (ya re-preciadas: %). No se escribió nada.',
      v_listos, v_total, v_hechos;
  end if;

  update public.inventario_movimiento m
     set venta_unitaria = r.venta_nueva,
         notas = concat_ws(' · ', nullif(btrim(m.notas), ''),
           format('Re-preciada 25-sep-2026: costo FIFO + 25 %% (utilidad de la tienda VuelaTour, autorizado por la oficina); antes $%s USD c/u',
                  to_char(r.costo_unitario, 'FM999990.00'))),
         updated_by = null
    from _reprecio_salidas r
   where m.id = r.mov_id and m.venta_unitaria = r.costo_unitario;
  get diagnostics v_mov = row_count;

  update public.gasto g
     set monto = r.monto_nuevo,
         notas = concat_ws(' · ', nullif(btrim(g.notas), ''),
           format('Re-preciado 25-sep-2026: costo FIFO + 25 %% (utilidad de la tienda VuelaTour, autorizado por la oficina); antes $%s USD',
                  to_char(r.monto_viejo, 'FM999990.00'))),
         updated_by = null,          -- bitácora: actor null ⇒ «Sistema»
         verificado_por = null,      -- espejo del API: editar limpia el sello
         verificado_at = null
    from _reprecio_salidas r
   where g.id = r.gasto_id and g.monto = r.monto_viejo;
  get diagnostics v_gas = row_count;

  if v_mov <> v_total or v_gas <> v_total then
    raise exception 'REPRECIO_ABORTADO: se actualizaron % movimientos y % gastos de %; se revierte todo.', v_mov, v_gas, v_total;
  end if;
  return format('REPRECIO_OK: %s salidas y %s gastos a costo + 25 %% (N4142R +295.46 USD, XA-VGV +239.89 USD, total +535.35 USD).', v_mov, v_gas);
end
$fn$;

-- 2) EJECUCIÓN (NO va en el dry-run)
select pg_temp.vt_repreciar_salidas_tienda();

-- ---------------------------------------------------------------------------
-- ROLLBACK (NO correr salvo decisión explícita de la oficina). Misma tabla de
-- casos (copiar el bloque CASOS de arriba a un `create temp table` igual) y:
--
--   update public.inventario_movimiento m
--      set venta_unitaria = r.costo_unitario,
--          notas = concat_ws(' · ', nullif(btrim(m.notas), ''), 'Re-precio revertido <fecha>'),
--          updated_by = null
--     from _reprecio_salidas r
--    where m.id = r.mov_id and m.venta_unitaria = r.venta_nueva;
--   update public.gasto g
--      set monto = r.monto_viejo,
--          notas = concat_ws(' · ', nullif(btrim(g.notas), ''), 'Re-precio revertido <fecha>'),
--          updated_by = null, verificado_por = null, verificado_at = null
--     from _reprecio_salidas r
--    where g.id = r.gasto_id and g.monto = r.monto_nuevo and not g.conciliado;
-- ---------------------------------------------------------------------------
