-- 24-sep-2026 · INGRESOS (otros ingresos, anticipos de clientes, reembolsos
-- recibidos, aportaciones) + CONCILIACIÓN DE INGRESOS (abono del banco ↔
-- ingreso) + ANTICIPO → COBRO DE VUELO.
--
-- Pedido del cliente: «faltarían las categorías de "ingresos" de igual manera
-- de como están ya ahorita las de "gastos" … Otros Ingresos, Anticipos y
-- depósitos, Ingresos en cuentas de banco». Pedido del usuario: «un espacio
-- para ingresos como en Gastos y podamos conciliar como los gastos pero ahora
-- los ingresos subiendo un estado de cuenta y con IA marcar los que sí empatan
-- con los cobros de los vuelos … y la sección de ingresos para registrar
-- otros ingresos».
--
-- QUÉ CREA (aditivo, sin backfill):
--   1. public.ingreso — todo el dinero que entra y NO es un cobro de vuelo
--      (los cobros de vuelo siguen en cobro_vuelo, intactos). Categoría =
--      texto + CHECK (NO enum: sin repetir el incidente del ENUM del
--      15-sep). `monto` = BRUTO; neto = monto − comision_monto. Soft delete
--      (deleted_at + motivo_baja): TODO lector filtra `deleted_at is null`.
--      `vuelo_id` SOLO en REEMBOLSO_DEVOLUCION (anti doble conteo: el pago de
--      un vuelo es un COBRO del vuelo, nunca «otro ingreso»). Un ingreso de
--      RESULTADO en USD exige TC (sin él desaparecería de los libros en pesos).
--   2. public.ingreso_bitacora — patrón gasto_bitacora (sin FK a propósito).
--   3. cobro_vuelo.ingreso_anticipo_id — «Aplicar anticipo a un vuelo» crea
--      un cobro de vuelo NORMAL ligado a su anticipo. Trigger
--      `tg_cobro_vuelo_anticipo` (for update sobre el anticipo): Σ cobros ≤
--      anticipo, misma moneda (comparación ::text), solo cobros positivos sin
--      sobre, y la liga es INMUTABLE (soltarla devolvería saldo con el cobro
--      vivo ⇒ el mismo dinero aplicable a otro vuelo).
--   4. Trigger `tg_ingreso_candados` — espejo en BD de los 409 del API: un
--      anticipo con aplicaciones no cambia categoría/moneda, no vale menos de
--      lo aplicado ni se da de baja; un ingreso conciliado no cambia su
--      dinero/cuenta ni se da de baja.
--   5. movimiento_bancario.ingreso_id — abono ↔ ingreso 1 ↔ 1 (índice único),
--      solo ABONO conciliado y EXCLUYENTE con gasto/cobro/sobre/clasificación.
--   6. Bucket PRIVADO `ingresos` (comprobantes; solo el API sube/firma con la
--      service key; sin policies).
--   7. Clasificación canónica «Reverso de un cargo» (los reversos no son
--      ingreso).
--
-- LO QUE NO CAMBIA: ningún trigger existente (el dry-run C9 igual ejercita
-- `trg_mov_bancario_gasto_suma` con un UPDATE real), ningún número existente
-- (la tabla nace vacía: Libro Dinero, Balance general, reparto, pre-cierre y
-- cobros dicen exactamente lo mismo), ninguna fila existente. En prod
-- (24-sep): 697 movimientos, 0 con más de una liga y `conciliado` coherente
-- ⇒ los CHECK nuevos validan sin backfill.
--
-- EL API 0.0.34 ES DESPLEGABLE SIN ESTA MIGRACIÓN: sonda única
-- `common/ingreso-disponible.util` (columna movimiento_bancario.ingreso_id,
-- re-sondeo ≤ 10 min). Sin ella: /v1/ingresos/* y las rutas nuevas de
-- conciliación responden 503 INGRESOS_NO_DISPONIBLE; conciliación, cobros,
-- pre-cierre y reportes responden EXACTAMENTE como hoy.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL, bucket y
-- filas) aunque la herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' o
-- CUALQUIER otro error (p. ej. 42883 «operator does not exist», un
-- not_null_violation inesperado) = NO aplicar. Tras el error DRYRUN_OK:
-- `select to_regclass('public.ingreso')` ⇒ NULL, `select count(*) from
-- storage.buckets where id = 'ingresos'` ⇒ 0, la columna
-- movimiento_bancario.ingreso_id no existe y `select count(*) from
-- conciliacion_clasificacion` ⇒ 2 (la de «Reverso» también se revirtió).
--
--   do $dry$
--   declare
--     v_admin uuid; v_cli uuid; v_cta uuid; v_cta_usd uuid; v_vuelo uuid;
--     v_cobro_normal uuid; v_abono uuid; v_abono2 uuid; v_cargo_gasto uuid; v_gasto uuid;
--     v_traspaso uuid;
--     v_ing_otro uuid; v_ing_ant uuid; v_ing_efe uuid; v_ing3 uuid;
--     v_c1 uuid; v_c2 uuid; v_cn uuid;
--     v_folio integer; v_n integer; v_upd timestamptz; v_con text;
--   begin
--     -- A) CONTEXTO
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' limit 1;
--     select c.id into v_cli from public.cliente c where c.activo order by c.created_at limit 1;
--     select m.id, m.cuenta_bancaria_id into v_abono, v_cta
--       from public.movimiento_bancario m join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
--      where m.tipo::text = 'ABONO' and not m.conciliado and c.moneda::text = 'MXN'
--        and num_nonnulls(m.gasto_id, m.cobro_id, m.cobro_grupo_id, m.clasificacion_id) = 0
--      order by m.fecha desc, m.id limit 1;
--     select m.id into v_abono2 from public.movimiento_bancario m
--      where m.tipo::text = 'ABONO' and not m.conciliado and m.cuenta_bancaria_id = v_cta
--        and m.id <> v_abono
--        and num_nonnulls(m.gasto_id, m.cobro_id, m.cobro_grupo_id, m.clasificacion_id) = 0
--      order by m.fecha desc, m.id limit 1;
--     select c.id into v_cta_usd from public.cuenta_bancaria c where c.moneda::text = 'USD' limit 1;
--     select v.id into v_vuelo from public.vuelo v
--      where v.estado::text in ('CONFIRMADO','COMPLETADO') and coalesce(v.monto_total_usd, 0) > 0
--      order by v.created_at desc limit 1;
--     select c.id into v_cobro_normal from public.cobro_vuelo c
--      where c.cobro_grupo_id is null and c.monto > 0 order by c.created_at desc limit 1;
--     select m.id, m.gasto_id into v_cargo_gasto, v_gasto from public.movimiento_bancario m
--      where m.tipo::text = 'CARGO' and m.gasto_id is not null limit 1;
--     select c.id into v_traspaso from public.conciliacion_clasificacion c
--      where lower(c.nombre) = lower('Traspaso entre cuentas');
--     if v_admin is null or v_cli is null or v_abono is null or v_abono2 is null or v_cta_usd is null
--        or v_vuelo is null or v_cobro_normal is null or v_cargo_gasto is null or v_traspaso is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto';
--     end if;
--     if to_regclass('public.ingreso') is not null then
--       raise exception 'DRYRUN_FALLA A: public.ingreso YA existe (¿migración aplicada?)';
--     end if;
--     raise notice 'okA · abono % / % en cuenta %, vuelo %, cobro normal %', v_abono, v_abono2, v_cta, v_vuelo, v_cobro_normal;
--
--     -- B) CUERPO REAL: pegar AQUÍ, TAL CUAL, las secciones 1) a 7) de abajo (son sentencias SQL planas). NO una copia a mano.
--
--     -- C1) ESTRUCTURA
--     if to_regclass('public.ingreso') is null or to_regclass('public.ingreso_bitacora') is null then
--       raise exception 'DRYRUN_FALLA C1: faltan tablas'; end if;
--     if not (select relrowsecurity from pg_class where oid = 'public.ingreso'::regclass)
--        or not (select relrowsecurity from pg_class where oid = 'public.ingreso_bitacora'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: RLS apagado'; end if;
--     if (select count(*) from pg_trigger where not tgisinternal and tgname in
--         ('trg_ingreso_set_updated_at','trg_ingreso_bitacora','trg_ingreso_candados','trg_cobro_vuelo_anticipo')) <> 4 then
--       raise exception 'DRYRUN_FALLA C1: faltan triggers'; end if;
--     if not exists (select 1 from storage.buckets where id = 'ingresos' and not public) then
--       raise exception 'DRYRUN_FALLA C1: falta el bucket privado ingresos'; end if;
--     if not exists (select 1 from public.conciliacion_clasificacion where nombre = 'Reverso de un cargo') then
--       raise exception 'DRYRUN_FALLA C1: falta la clasificación Reverso de un cargo'; end if;
--     raise notice 'okC1 · tablas, RLS, triggers, bucket, clasificación';
--
--     -- C2) INSERT VÁLIDO + folio identity + bitácora INSERT
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, cuenta_bancaria_id, created_by, updated_by)
--     values ('OTRO_INGRESO', current_date, 'dry-run otro ingreso', 1234.56, 'MXN', 'TRANSFERENCIA', v_cta, v_admin, v_admin)
--     returning id, folio into v_ing_otro, v_folio;
--     if v_folio is null then raise exception 'DRYRUN_FALLA C2: folio null'; end if;
--     select count(*) into v_n from public.ingreso_bitacora where ingreso_id = v_ing_otro and accion = 'INSERT' and diff ? 'monto';
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA C2: bitácora INSERT = %', v_n; end if;
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, created_by)
--     values ('REEMBOLSO_DEVOLUCION', current_date, 'dry-run efectivo', 50, 'MXN', 'EFECTIVO', v_admin)
--     returning id into v_ing_efe;
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, cuenta_bancaria_id, created_by)
--     values ('INGRESO_BANCARIO', current_date, 'dry-run intereses', 10, 'MXN', 'TRANSFERENCIA', v_cta, v_admin)
--     returning id into v_ing3;
--     raise notice 'okC2 · insert válido (folio %), efectivo sin cuenta, bitácora', v_folio;
--
--     -- C3) CHECKs y FK (cada uno DEBE reventar)
--     begin update public.ingreso set categoria = 'XXX' where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: categoría'; exception when check_violation then null; end;
--     begin update public.ingreso set monto = 0 where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: monto 0'; exception when check_violation then null; end;
--     begin update public.ingreso set comision_monto = 10 where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: comisión = monto'; exception when check_violation then null; end;
--     begin update public.ingreso set tc_usd_mxn = 0 where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: tc 0'; exception when check_violation then null; end;
--     begin update public.ingreso set descripcion = 'ab' where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: descripción corta'; exception when check_violation then null; end;
--     begin update public.ingreso set descripcion = ' con espacio' where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: descripción sin trim'; exception when check_violation then null; end;
--     begin update public.ingreso set cuenta_bancaria_id = null where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: sin cuenta con TRANSFERENCIA'; exception when check_violation then null; end;
--     begin update public.ingreso set categoria = 'ANTICIPO_CLIENTE' where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: anticipo sin cliente'; exception when check_violation then null; end;
--     begin update public.ingreso set categoria = 'ANTICIPO_CLIENTE', cliente_id = v_cli, vuelo_id = v_vuelo where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: anticipo con vuelo'; exception when check_violation then null; end;
--     begin update public.ingreso set gasto_id = v_gasto where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: gasto en categoría no reembolso'; exception when check_violation then null; end;
--     begin update public.ingreso set vuelo_id = v_vuelo where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: vuelo en categoría no reembolso'; exception when check_violation then null; end;
--     begin
--       insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, cuenta_bancaria_id, created_by)
--       values ('OTRO_INGRESO', current_date, 'dry-run usd sin tc', 10, 'USD', 'TRANSFERENCIA', v_cta_usd, v_admin);
--       raise exception 'DRYRUN_FALLA C3: ingreso USD de resultado sin TC';
--     exception when check_violation then null; end;
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, cuenta_bancaria_id, tc_usd_mxn, created_by)
--     values ('OTRO_INGRESO', current_date, 'dry-run usd con tc', 10, 'USD', 'TRANSFERENCIA', v_cta_usd, 18.25, v_admin);
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, cuenta_bancaria_id, created_by)
--     values ('APORTACION_PRESTAMO', current_date, 'dry-run aportación usd', 10, 'USD', 'TRANSFERENCIA', v_cta_usd, v_admin);
--     update public.ingreso set vuelo_id = v_vuelo, categoria = 'REEMBOLSO_DEVOLUCION' where id = v_ing_efe;  -- sí se permite
--     update public.ingreso set vuelo_id = null where id = v_ing_efe;
--     begin update public.ingreso set deleted_at = now() where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: baja sin motivo'; exception when check_violation then null; end;
--     begin update public.ingreso set archivo_path = 'x/y.pdf' where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: archivo sin nombre'; exception when check_violation then null; end;
--     begin update public.ingreso set archivos_historial = '{}'::jsonb where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: historial objeto'; exception when check_violation then null; end;
--     begin update public.ingreso set cliente_id = gen_random_uuid() where id = v_ing3;
--       raise exception 'DRYRUN_FALLA C3: cliente inexistente'; exception when foreign_key_violation then null; end;
--     update public.ingreso set updated_at = '2000-01-01' where id = v_ing3;
--     select updated_at into v_upd from public.ingreso where id = v_ing3;
--     if v_upd < '2001-01-01' then raise exception 'DRYRUN_FALLA C3: tg_set_updated_at no corre'; end if;
--     raise notice 'okC3 · CHECKs/FK rechazan lo inválido; updated_at se mueve';
--
--     -- C4) ANTICIPO: INSERT REAL de cobros de vuelo ligados
--     insert into public.ingreso (categoria, fecha, descripcion, monto, moneda, metodo, cuenta_bancaria_id, cliente_id, created_by)
--     values ('ANTICIPO_CLIENTE', current_date, 'dry-run anticipo', 1000, 'MXN', 'TRANSFERENCIA', v_cta, v_cli, v_admin)
--     returning id into v_ing_ant;
--     insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, ingreso_anticipo_id, registrado_por, created_by, updated_by, notas)
--     values (v_vuelo, 600, 'MXN', 'TRANSFERENCIA', 18.5, v_ing_ant, v_admin, v_admin, v_admin, 'dry-run')
--     returning id into v_c1;
--     begin  -- moneda distinta: ejercita la comparación ::text del trigger
--       insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, ingreso_anticipo_id)
--       values (v_vuelo, 10, 'USD', 'TRANSFERENCIA', v_ing_ant);
--       raise exception 'DRYRUN_FALLA C4: entró un cobro USD contra un anticipo MXN';
--     exception when check_violation then
--       if sqlerrm not like 'ANTICIPO_MONEDA_DISTINTA%' then
--         raise exception 'DRYRUN_FALLA C4: esperaba ANTICIPO_MONEDA_DISTINTA y salió %', sqlerrm; end if;
--     end;
--     begin
--       insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, ingreso_anticipo_id)
--       values (v_vuelo, 500, 'MXN', 'TRANSFERENCIA', v_ing_ant);
--       raise exception 'DRYRUN_FALLA C4: sobregiro 600+500 > 1000';
--     exception when check_violation then
--       if sqlerrm not like 'ANTICIPO_SIN_SALDO%' then
--         raise exception 'DRYRUN_FALLA C4: esperaba ANTICIPO_SIN_SALDO y salió %', sqlerrm; end if;
--     end;
--     insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, ingreso_anticipo_id, created_by)
--     values (v_vuelo, 400, 'MXN', 'TRANSFERENCIA', v_ing_ant, v_admin) returning id into v_c2;
--     begin
--       insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, ingreso_anticipo_id)
--       values (v_vuelo, -50, 'MXN', 'TRANSFERENCIA', v_ing_ant);
--       raise exception 'DRYRUN_FALLA C4: reembolso ligado a anticipo';
--     exception when check_violation then null; end;
--     begin
--       insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, ingreso_anticipo_id)
--       values (v_vuelo, 1, 'MXN', 'TRANSFERENCIA', v_ing3);
--       raise exception 'DRYRUN_FALLA C4: cobro contra un ingreso que no es anticipo';
--     exception when check_violation then
--       if sqlerrm not like 'NO_ES_ANTICIPO%' then
--         raise exception 'DRYRUN_FALLA C4: esperaba NO_ES_ANTICIPO y salió %', sqlerrm; end if;
--     end;
--     raise notice 'okC4 · aplicaciones 600+400 = 1000; moneda/sobregiro/negativo/no-anticipo rechazados';
--
--     -- C5) UPDATE REAL de cobros de anticipo
--     begin update public.cobro_vuelo set monto = 700 where id = v_c1;
--       raise exception 'DRYRUN_FALLA C5: 700+400 > 1000';
--     exception when check_violation then null; end;
--     update public.cobro_vuelo set monto = 500 where id = v_c1;
--     begin update public.cobro_vuelo set moneda = 'USD' where id = v_c1;
--       raise exception 'DRYRUN_FALLA C5: cambio de moneda';
--     exception when check_violation then null; end;
--     update public.cobro_vuelo set notas = 'dry-run 2', comision_banco_monto = 5 where id = v_c1;
--     update public.cobro_vuelo set vuelo_id = vuelo_id, tc_usd_mxn = 18.75 where id = v_c1;  -- patchCobrosAlClon / TC: libres
--     begin update public.cobro_vuelo set ingreso_anticipo_id = null where id = v_c1;
--       raise exception 'DRYRUN_FALLA C5: se soltó la liga cobro↔anticipo';
--     exception when check_violation then
--       if sqlerrm not like 'ANTICIPO_LIGA_INMUTABLE%' then raise exception 'DRYRUN_FALLA C5: %', sqlerrm; end if; end;
--     begin update public.cobro_vuelo set ingreso_anticipo_id = v_ing_ant where id = v_cobro_normal;
--       raise exception 'DRYRUN_FALLA C5: se colgó un cobro normal de un anticipo';
--     exception when check_violation then
--       if sqlerrm not like 'ANTICIPO_LIGA_INMUTABLE%' then raise exception 'DRYRUN_FALLA C5: %', sqlerrm; end if; end;
--     raise notice 'okC5 · update real de cobros de anticipo; liga inmutable';
--
--     -- C6) LOS COBROS NORMALES NO CAMBIAN (trigger con early return)
--     update public.cobro_vuelo set monto = monto, moneda = moneda where id = v_cobro_normal;
--     insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, created_by)
--     values (v_vuelo, 1, 'USD', 'TRANSFERENCIA', v_admin) returning id into v_cn;
--     update public.cobro_vuelo set monto = 2 where id = v_cn;
--     raise notice 'okC6 · cobro normal: update e insert reales pasan';
--
--     -- C7) CANDADOS DEL ANTICIPO CON APLICACIONES (aplicado = 500 + 400 = 900)
--     begin update public.ingreso set categoria = 'OTRO_INGRESO' where id = v_ing_ant;
--       raise exception 'DRYRUN_FALLA C7: categoría con aplicaciones';
--     exception when check_violation then
--       if sqlerrm not like 'ANTICIPO_CON_APLICACIONES%' then raise exception 'DRYRUN_FALLA C7: %', sqlerrm; end if; end;
--     begin update public.ingreso set moneda = 'USD' where id = v_ing_ant;
--       raise exception 'DRYRUN_FALLA C7: moneda con aplicaciones';
--     exception when check_violation then null; end;
--     begin update public.ingreso set monto = 800 where id = v_ing_ant;
--       raise exception 'DRYRUN_FALLA C7: monto menor a lo aplicado';
--     exception when check_violation then
--       if sqlerrm not like 'ANTICIPO_MONTO_MENOR_A_APLICADO%' then raise exception 'DRYRUN_FALLA C7: %', sqlerrm; end if; end;
--     update public.ingreso set monto = 950 where id = v_ing_ant;
--     begin update public.ingreso set deleted_at = now(), deleted_by = v_admin, motivo_baja = 'dry-run baja' where id = v_ing_ant;
--       raise exception 'DRYRUN_FALLA C7: baja con aplicaciones';
--     exception when check_violation then null; end;
--     begin delete from public.ingreso where id = v_ing_ant;
--       raise exception 'DRYRUN_FALLA C7: borrado duro con aplicaciones';
--     exception when foreign_key_violation then
--       get stacked diagnostics v_con = constraint_name;
--       if v_con <> 'cobro_vuelo_ingreso_anticipo_id_fkey' then
--         raise exception 'DRYRUN_FALLA C7: el RESTRICT lo dio %', v_con; end if; end;
--     delete from public.cobro_vuelo where id in (v_c1, v_c2);        -- desaplicar
--     update public.ingreso set categoria = 'OTRO_INGRESO' where id = v_ing_ant;   -- ya sin aplicaciones
--     update public.ingreso set categoria = 'ANTICIPO_CLIENTE' where id = v_ing_ant;
--     raise notice 'okC7 · candados del anticipo y desaplicar';
--
--     -- C8) ABONO ↔ INGRESO (UPDATE REAL de movimiento_bancario)
--     update public.movimiento_bancario set ingreso_id = v_ing_otro, conciliado = true, updated_by = v_admin where id = v_abono;
--     begin update public.movimiento_bancario set ingreso_id = v_ing_otro, conciliado = true where id = v_abono2;
--       raise exception 'DRYRUN_FALLA C8: mismo ingreso en dos abonos';
--     exception when unique_violation then null; end;
--     begin update public.movimiento_bancario set ingreso_id = v_ing3, conciliado = false where id = v_abono2;
--       raise exception 'DRYRUN_FALLA C8: ingreso sin conciliado';
--     exception when check_violation then null; end;
--     begin update public.movimiento_bancario set ingreso_id = v_ing3, conciliado = true, clasificacion_id = v_traspaso where id = v_abono2;
--       raise exception 'DRYRUN_FALLA C8: ingreso + clasificación';
--     exception when check_violation then null; end;
--     begin update public.movimiento_bancario set ingreso_id = v_ing3 where id = v_cargo_gasto;
--       raise exception 'DRYRUN_FALLA C8: ingreso en un CARGO con gasto';
--     exception when check_violation then null; end;
--     -- candados del ingreso conciliado
--     begin update public.ingreso set monto = monto + 1 where id = v_ing_otro;
--       raise exception 'DRYRUN_FALLA C8: monto de ingreso conciliado';
--     exception when check_violation then
--       if sqlerrm not like 'INGRESO_CONCILIADO%' then raise exception 'DRYRUN_FALLA C8: %', sqlerrm; end if; end;
--     begin update public.ingreso set moneda = 'USD' where id = v_ing_otro;   -- rama ::text
--       raise exception 'DRYRUN_FALLA C8: moneda de ingreso conciliado';
--     exception when check_violation then null; end;
--     begin update public.ingreso set cuenta_bancaria_id = v_cta_usd where id = v_ing_otro;
--       raise exception 'DRYRUN_FALLA C8: cuenta de ingreso conciliado';
--     exception when check_violation then null; end;
--     begin update public.ingreso set deleted_at = now(), deleted_by = v_admin, motivo_baja = 'dry-run baja' where id = v_ing_otro;
--       raise exception 'DRYRUN_FALLA C8: baja de ingreso conciliado';
--     exception when check_violation then null; end;
--     update public.ingreso set descripcion = 'dry-run reclasificado', categoria = 'REEMBOLSO_DEVOLUCION' where id = v_ing_otro;
--     begin delete from public.ingreso where id = v_ing_otro;
--       raise exception 'DRYRUN_FALLA C8: borrado duro de ingreso conciliado';
--     exception when foreign_key_violation then null; end;
--     update public.movimiento_bancario set ingreso_id = null, conciliado = false where id = v_abono;   -- desvincular
--     update public.ingreso set monto = monto + 1 where id = v_ing_otro;                                -- ya se puede
--     raise notice 'okC8 · abono↔ingreso: único, excluyente, solo ABONO, candados y desvincular';
--
--     -- C9) LOS FLUJOS DE SIEMPRE NO CAMBIAN
--     update public.movimiento_bancario set gasto_id = gasto_id, conciliado = conciliado where id = v_cargo_gasto;
--     update public.movimiento_bancario set clasificacion_id = v_traspaso, conciliado = true where id = v_abono2;
--     update public.movimiento_bancario set clasificacion_id = null, conciliado = false where id = v_abono2;
--     raise notice 'okC9 · liga cargo↔gasto (trigger de suma) y clasificar/desclasificar siguen pasando';
--
--     -- C10) BITÁCORA y BAJA VÁLIDA
--     select count(*) into v_n from public.ingreso_bitacora where ingreso_id = v_ing_ant and accion = 'UPDATE';
--     if v_n < 3 then raise exception 'DRYRUN_FALLA C10: bitácora UPDATE del anticipo = %', v_n; end if;
--     update public.ingreso set deleted_at = now(), deleted_by = v_admin, motivo_baja = 'dry-run baja válida' where id = v_ing3;
--     delete from public.ingreso where id = v_ing_efe;
--     select count(*) into v_n from public.ingreso_bitacora where ingreso_id = v_ing_efe and accion = 'DELETE' and snapshot is not null;
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA C10: bitácora DELETE = %', v_n; end if;
--     raise notice 'okC10 · bitácora INSERT/UPDATE/DELETE y baja válida';
--
--     raise exception 'DRYRUN_OK · C1 estructura · C2 insert/folio/bitácora · C3 checks/FK/updated_at/vuelo solo reembolso/TC USD de resultado · C4 anticipo (moneda ::text, sobregiro, negativo, no-anticipo) · C5 update cobros anticipo + liga inmutable · C6 cobros normales intactos · C7 candados anticipo · C8 abono↔ingreso · C9 flujos de siempre · C10 bitácora · todo se revierte';
--   end $dry$;
--
-- Contexto verificado en prod (24-sep, SELECT): usuario.estado (ACTIVO…),
-- cliente.activo, vuelo.monto_total_usd, cuenta_bancaria USD, abonos MXN
-- pendientes sin ligas (≥ 2 en la misma cuenta), cargo con gasto,
-- clasificación «Traspaso entre cuentas», public.tg_set_updated_at();
-- cobro_vuelo.registrado_por/created_by/updated_by NULLABLE; en
-- movimiento_bancario solo existen trg_mov_bancario_gasto_suma (early return
-- con gasto/monto/cuenta sin cambio: C9) y trg_movimiento_bancario_set_updated_at;
-- en cobro_vuelo solo trg_cobro_vuelo_set_updated_at; storage.buckets trae
-- file_size_limit y allowed_mime_types; conciliacion_clasificacion.activo
-- default true.
--
-- TRAS APLICAR: `get_advisors` (esperado: INFO «RLS sin policies» de
-- ingreso e ingreso_bitacora, patrón del repo); conteos intactos
-- (movimiento_bancario 697+, cobro_vuelo 225+, 0 filas con ingreso_id /
-- ingreso_anticipo_id); sondear GET /v1/ingresos/resumen (200, no 503; la
-- sonda re-sondea ≤ 10 min o reiniciar el API).
-- ORDEN DE DESPLIEGUE: migración → API 0.0.34 → pyservices → panel (el API es
-- tolerante en cualquier orden gracias a la sonda).
-- ROLLBACK (pierde lo registrado): alter table public.movimiento_bancario
-- drop constraint movimiento_bancario_ingreso_excluyente_chk, drop constraint
-- movimiento_bancario_ingreso_abono_chk, drop column ingreso_id; alter table
-- public.cobro_vuelo drop constraint cobro_vuelo_anticipo_chk; drop trigger
-- trg_cobro_vuelo_anticipo on public.cobro_vuelo; alter table public.cobro_vuelo
-- drop column ingreso_anticipo_id; drop table public.ingreso_bitacora; drop
-- table public.ingreso; drop function public.tg_cobro_vuelo_anticipo(),
-- public.tg_ingreso_candados(), public.tg_ingreso_bitacora(); (bucket
-- `ingresos`: borrarlo si está vacío; la clasificación «Reverso de un cargo»
-- puede quedarse).

-- 1) INGRESO
create table if not exists public.ingreso (
  id uuid primary key default gen_random_uuid(),
  folio integer generated always as identity,
  categoria text not null,
  fecha date not null,
  descripcion text not null,
  monto numeric(14,2) not null,
  comision_monto numeric(14,2),
  moneda public.moneda not null,
  tc_usd_mxn numeric(12,6),
  metodo public.metodo_cobro not null,
  cuenta_bancaria_id uuid references public.cuenta_bancaria(id) on delete restrict,
  referencia text,
  pagador text,
  cliente_id uuid references public.cliente(id) on delete restrict,
  vuelo_id uuid references public.vuelo(id) on delete set null,
  aeronave_id uuid references public.aeronave(id) on delete set null,
  gasto_id uuid references public.gasto(id) on delete set null,
  notas text,
  archivo_path text,
  archivo_nombre text,
  archivo_subido_at timestamptz,
  archivo_subido_por uuid references public.usuario(id) on delete set null,
  archivos_historial jsonb not null default '[]'::jsonb,
  client_request_id uuid,
  deleted_at timestamptz,
  deleted_by uuid references public.usuario(id) on delete set null,
  motivo_baja text,
  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuario(id) on delete set null,
  constraint ingreso_folio_key unique (folio),
  constraint ingreso_categoria_chk check (categoria in ('OTRO_INGRESO','ANTICIPO_CLIENTE',
    'INGRESO_BANCARIO','REEMBOLSO_DEVOLUCION','VENTA_ACTIVO','APORTACION_PRESTAMO')),
  constraint ingreso_monto_chk check (monto > 0
    and (comision_monto is null or (comision_monto >= 0 and comision_monto < monto))),
  constraint ingreso_tc_chk check (tc_usd_mxn is null or tc_usd_mxn > 0),
  constraint ingreso_descripcion_chk check (
    descripcion = btrim(descripcion) and char_length(descripcion) between 3 and 300),
  constraint ingreso_textos_chk check (
    (referencia is null or char_length(referencia) between 1 and 120)
    and (pagador is null or char_length(pagador) between 1 and 200)
    and (notas is null or char_length(notas) <= 1000)
    and (archivo_nombre is null or char_length(archivo_nombre) <= 200)),
  -- Sin cuenta bancaria = efectivo en mano (no conciliable con el banco).
  constraint ingreso_destino_chk check (
    cuenta_bancaria_id is not null or metodo in ('EFECTIVO','DOLARES')),
  -- Anticipo: siempre de un cliente y SIN vuelo (si el vuelo existe es un cobro del vuelo).
  constraint ingreso_anticipo_chk check (
    categoria <> 'ANTICIPO_CLIENTE' or (cliente_id is not null and vuelo_id is null)),
  constraint ingreso_gasto_chk check (gasto_id is null or categoria = 'REEMBOLSO_DEVOLUCION'),
  -- Anti doble conteo (crítica): el pago de un vuelo es COBRO, nunca «otro ingreso».
  constraint ingreso_vuelo_chk check (vuelo_id is null or categoria = 'REEMBOLSO_DEVOLUCION'),
  -- Un ingreso de RESULTADO en USD sin TC desaparecería de los libros en pesos: se exige.
  -- (Literal contra ENUM en un CHECK — no es plpgsql; el literal se convierte al enum.)
  constraint ingreso_tc_resultado_chk check (
    moneda = 'MXN' or tc_usd_mxn is not null
    or categoria in ('ANTICIPO_CLIENTE','APORTACION_PRESTAMO')),
  constraint ingreso_baja_chk check (
    (deleted_at is null) = (motivo_baja is null)
    and (motivo_baja is null or char_length(btrim(motivo_baja)) between 5 and 500)),
  constraint ingreso_archivo_chk check ((archivo_path is null) = (archivo_nombre is null)),
  constraint ingreso_historial_chk check (jsonb_typeof(archivos_historial) = 'array')
);

comment on table public.ingreso is
  'Ingresos que NO son cobros de vuelo (otros ingresos, anticipos, reembolsos, aportaciones). Los cobros de vuelo siguen en cobro_vuelo. Anticipo aplicado = cobro_vuelo.ingreso_anticipo_id. Soft delete: todo lector filtra deleted_at is null. Conciliado = existe movimiento_bancario.ingreso_id.';
comment on column public.ingreso.monto is
  'BRUTO recibido (como cobro_vuelo.monto). Neto = monto − comision_monto; el banco se concilia por neto (o bruto en pasarela).';

create unique index if not exists uq_ingreso_client_request
  on public.ingreso (client_request_id) where client_request_id is not null;
create index if not exists idx_ingreso_fecha on public.ingreso (fecha desc) where deleted_at is null;
create index if not exists idx_ingreso_categoria_fecha on public.ingreso (categoria, fecha) where deleted_at is null;
create index if not exists idx_ingreso_cuenta_fecha on public.ingreso (cuenta_bancaria_id, fecha)
  where cuenta_bancaria_id is not null and deleted_at is null;
create index if not exists idx_ingreso_cliente on public.ingreso (cliente_id) where cliente_id is not null;
create index if not exists idx_ingreso_vuelo on public.ingreso (vuelo_id) where vuelo_id is not null;
create index if not exists idx_ingreso_aeronave on public.ingreso (aeronave_id) where aeronave_id is not null;
create index if not exists idx_ingreso_gasto on public.ingreso (gasto_id) where gasto_id is not null;

alter table public.ingreso enable row level security;

drop trigger if exists trg_ingreso_set_updated_at on public.ingreso;
create trigger trg_ingreso_set_updated_at before update on public.ingreso
  for each row execute function public.tg_set_updated_at();

-- 2) BITÁCORA (patrón gasto_bitacora: sin FK a propósito, sobrevive a todo)
create table if not exists public.ingreso_bitacora (
  id uuid primary key default gen_random_uuid(),
  ingreso_id uuid not null,
  accion text not null,
  actor_id uuid,
  diff jsonb not null default '{}'::jsonb,
  snapshot jsonb,
  nota text,
  created_at timestamptz not null default now(),
  constraint ingreso_bitacora_accion_chk check (accion in
    ('INSERT','UPDATE','DELETE','APLICAR','DESAPLICAR','CONCILIAR','DESCONCILIAR'))
);
create index if not exists idx_ingreso_bitacora_ingreso
  on public.ingreso_bitacora (ingreso_id, created_at desc);
alter table public.ingreso_bitacora enable row level security;

create or replace function public.tg_ingreso_bitacora()
returns trigger language plpgsql set search_path to '' as $fn$
declare
  cols text[] := array['categoria','fecha','descripcion','monto','comision_monto','moneda',
    'tc_usd_mxn','metodo','cuenta_bancaria_id','referencia','pagador','cliente_id','vuelo_id',
    'aeronave_id','gasto_id','notas','archivo_path','deleted_at','motivo_baja'];
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
    insert into public.ingreso_bitacora (ingreso_id, accion, actor_id, diff)
    values (new.id, 'INSERT', new.created_by, v_diff);
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
    insert into public.ingreso_bitacora (ingreso_id, accion, actor_id, diff)
    values (new.id, 'UPDATE', new.updated_by, v_diff);
    return new;
  else
    insert into public.ingreso_bitacora (ingreso_id, accion, actor_id, diff, snapshot)
    values (old.id, 'DELETE', old.updated_by, '{}'::jsonb, to_jsonb(old));
    return old;
  end if;
end $fn$;

drop trigger if exists trg_ingreso_bitacora on public.ingreso;
create trigger trg_ingreso_bitacora after insert or update or delete on public.ingreso
  for each row execute function public.tg_ingreso_bitacora();

-- 3) ANTICIPO → COBRO DE VUELO
alter table public.cobro_vuelo
  add column if not exists ingreso_anticipo_id uuid references public.ingreso(id) on delete restrict;
create index if not exists idx_cobro_vuelo_ingreso_anticipo
  on public.cobro_vuelo (ingreso_anticipo_id) where ingreso_anticipo_id is not null;
alter table public.cobro_vuelo add constraint cobro_vuelo_anticipo_chk
  check (ingreso_anticipo_id is null or (monto > 0 and cobro_grupo_id is null));

create or replace function public.tg_cobro_vuelo_anticipo()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare
  v_folio integer;
  v_categoria text;
  v_monto numeric;
  v_moneda text;
  v_baja timestamptz;
  v_suma numeric := 0;
begin
  -- La liga es INMUTABLE (crítica): soltarla devolvería el saldo con el cobro
  -- vivo (doble venta) y colgar un cobro existente saltaría el camino createCobro.
  if tg_op = 'UPDATE'
     and new.ingreso_anticipo_id is distinct from old.ingreso_anticipo_id then
    raise exception 'ANTICIPO_LIGA_INMUTABLE: la liga del cobro con su anticipo no se cambia; desaplica el cobro y vuelve a aplicar el anticipo'
      using errcode = '23514';
  end if;
  if new.ingreso_anticipo_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.monto is not distinct from old.monto
     and new.moneda::text is not distinct from old.moneda::text
     and new.cobro_grupo_id is not distinct from old.cobro_grupo_id then
    return new;
  end if;
  select i.folio, i.categoria, i.monto, i.moneda::text, i.deleted_at
    into v_folio, v_categoria, v_monto, v_moneda, v_baja
    from public.ingreso i
   where i.id = new.ingreso_anticipo_id
     for update;
  if not found then
    raise exception 'ANTICIPO_NO_EXISTE: el ingreso % no existe', new.ingreso_anticipo_id
      using errcode = '23514';
  end if;
  if v_categoria <> 'ANTICIPO_CLIENTE' then
    raise exception 'NO_ES_ANTICIPO: el ingreso ING-% no es un anticipo de cliente', v_folio
      using errcode = '23514';
  end if;
  if v_baja is not null then
    raise exception 'INGRESO_DADO_DE_BAJA: el anticipo ING-% está dado de baja', v_folio
      using errcode = '23514';
  end if;
  if new.moneda::text <> v_moneda then
    raise exception 'ANTICIPO_MONEDA_DISTINTA: el anticipo ING-% es en % y el cobro en %',
      v_folio, v_moneda, new.moneda::text using errcode = '23514';
  end if;
  select coalesce(sum(c.monto), 0) into v_suma
    from public.cobro_vuelo c
   where c.ingreso_anticipo_id = new.ingreso_anticipo_id
     and c.id <> new.id;
  if v_suma + new.monto > v_monto + 0.005 then
    raise exception 'ANTICIPO_SIN_SALDO: el anticipo ING-% vale %, ya se aplicaron % y este cobro (%) lo rebasa',
      v_folio, round(v_monto, 2), round(v_suma, 2), round(new.monto, 2) using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_cobro_vuelo_anticipo on public.cobro_vuelo;
create trigger trg_cobro_vuelo_anticipo
  before insert or update of ingreso_anticipo_id, monto, moneda, cobro_grupo_id
  on public.cobro_vuelo for each row execute function public.tg_cobro_vuelo_anticipo();

-- 4) CANDADOS DEL INGRESO (espejo en BD de los 409 del API)
create or replace function public.tg_ingreso_candados()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare
  v_aplicado numeric := 0;
  v_aplicaciones integer := 0;
  v_conciliado boolean := false;
begin
  select coalesce(sum(c.monto), 0), count(*)
    into v_aplicado, v_aplicaciones
    from public.cobro_vuelo c
   where c.ingreso_anticipo_id = new.id;
  if v_aplicaciones > 0 then
    if new.categoria is distinct from old.categoria
       or new.moneda::text is distinct from old.moneda::text then
      raise exception 'ANTICIPO_CON_APLICACIONES: el anticipo ING-% ya se aplicó a % vuelo(s): no cambia de categoría ni de moneda',
        old.folio, v_aplicaciones using errcode = '23514';
    end if;
    if new.deleted_at is not null and old.deleted_at is null then
      raise exception 'ANTICIPO_CON_APLICACIONES: el anticipo ING-% ya se aplicó a % vuelo(s): desaplícalo antes de darlo de baja',
        old.folio, v_aplicaciones using errcode = '23514';
    end if;
    if new.monto < v_aplicado - 0.005 then
      raise exception 'ANTICIPO_MONTO_MENOR_A_APLICADO: el anticipo ING-% ya tiene % aplicados; no puede valer %',
        old.folio, round(v_aplicado, 2), round(new.monto, 2) using errcode = '23514';
    end if;
  end if;
  select exists (select 1 from public.movimiento_bancario m where m.ingreso_id = new.id)
    into v_conciliado;
  if v_conciliado and (
       new.monto is distinct from old.monto
       or new.comision_monto is distinct from old.comision_monto
       or new.moneda::text is distinct from old.moneda::text
       or new.cuenta_bancaria_id is distinct from old.cuenta_bancaria_id
       or (new.deleted_at is not null and old.deleted_at is null)) then
    raise exception 'INGRESO_CONCILIADO: el ingreso ING-% está conciliado con un abono del banco: desvincúlalo antes de cambiar su dinero, su cuenta o darlo de baja',
      old.folio using errcode = '23514';
  end if;
  return new;
end $fn$;

drop trigger if exists trg_ingreso_candados on public.ingreso;
create trigger trg_ingreso_candados
  before update of categoria, moneda, monto, comision_monto, cuenta_bancaria_id, deleted_at
  on public.ingreso for each row execute function public.tg_ingreso_candados();

-- 5) ABONO DEL BANCO → INGRESO (1 ↔ 1, excluyente con toda otra liga)
alter table public.movimiento_bancario
  add column if not exists ingreso_id uuid references public.ingreso(id) on delete restrict;
create unique index if not exists uq_mov_bancario_ingreso
  on public.movimiento_bancario (ingreso_id) where ingreso_id is not null;
alter table public.movimiento_bancario add constraint movimiento_bancario_ingreso_abono_chk
  check (ingreso_id is null or (tipo = 'ABONO' and conciliado));
alter table public.movimiento_bancario add constraint movimiento_bancario_ingreso_excluyente_chk
  check (ingreso_id is null or num_nonnulls(gasto_id, cobro_id, cobro_grupo_id, clasificacion_id) = 0);

-- 6) BUCKET PRIVADO del comprobante (solo el API sube/firma con service key; sin policies)
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('ingresos', 'ingresos', false, 10485760,
        array['image/jpeg','image/png','image/webp','application/pdf'])
on conflict (id) do nothing;

-- 7) CLASIFICACIÓN CANÓNICA de los reversos (no son ingreso)
insert into public.conciliacion_clasificacion (nombre)
select 'Reverso de un cargo'
 where not exists (select 1 from public.conciliacion_clasificacion
                    where lower(nombre) = lower('Reverso de un cargo'));

-- ---------------------------------------------------------------------------
-- 8) Las funciones de trigger SECURITY DEFINER no se exponen por RPC
--    (advisor 0028/0029, 24-sep-2026). Los triggers siguen corriendo: probado
--    con `set local role service_role` dentro de un dry-run (DRYRUN_OK). En
--    prod se aplicó como migración aparte «ingresos_revoke_trigger_rpc».
-- ---------------------------------------------------------------------------
revoke execute on function public.tg_cobro_vuelo_anticipo() from public, anon, authenticated;
revoke execute on function public.tg_ingreso_candados() from public, anon, authenticated;
