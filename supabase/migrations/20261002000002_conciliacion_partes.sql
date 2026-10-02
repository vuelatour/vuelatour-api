-- 2-oct-2026 · CONCILIACIÓN 1 CARGO ↔ N GASTOS («lote») — PUENTE
-- movimiento_bancario_gasto como FUENTE ÚNICA de la liga cargo ↔ gasto.
--
-- CASO REAL (verificado en prod el 2-oct-2026): Jimmy Chi capturó el 30-sep
-- 29 gastos «Pago VIP SAESA» (OPERACIONES, TRANSFERENCIA, MXN; suman
-- $59,569.87). SAESA no se paga gasto por gasto: el 24-sep salieron de
-- GASTOS GNRAL SPEI que pagan VARIOS a la vez — $8,404.20 = 3 × $2,801.40
-- (vuelos #315, #319, #326), $4,462.75 ×2 (= $2,231.37 + $2,231.38, o
-- 2 × $2,231.37 + $0.01: SAESA factura $2,231.375), $2,236.25 (= 2 ×
-- $1,118.12 + $0.01) — y el modelo era 1 gasto ↔ N cargos
-- (`movimiento_bancario.gasto_id` + `tg_mov_bancario_gasto_suma`): un cargo
-- solo podía pagar UN gasto y la regla rechazaba cualquier cargo mayor que
-- el gasto + $1.00. Además el auto-cruce ligó el cargo de $2,231.38 al gasto
-- #318 de $2,231.37 cuando el gasto EXACTO (#321, $2,231.38) se capturó 15
-- minutos después.
--
-- QUÉ CREA / CAMBIA:
--   0) Aserciones previas (abortan): ninguna liga a gasto en un movimiento
--      que no sea CARGO, con cobro/sobre/ingreso/clasificación, emparejado
--      por reverso o sin conciliar (hoy: 0 en todas).
--   1) public.movimiento_bancario_gasto (movimiento_id, gasto_id,
--      monto_parte, moneda, created_at, created_by), PK (movimiento_id,
--      gasto_id), índice por gasto, RLS con la política de lectura de
--      movimiento_bancario. Movimiento ON DELETE CASCADE; gasto ON DELETE
--      RESTRICT (un gasto con partes no se borra: candado del API + BD).
--   2) movimiento_bancario.gastos_n (espejo, default 0) y el CHECK de
--      ingresos gana `and gastos_n = 0`. `gasto_id` queda como ESPEJO
--      DERIVADO (= la parte cuando gastos_n = 1; NULL con 0 o ≥ 2): es lo que
--      leen el panel/app viejos y el embed `gasto:gasto!gasto_id(...)`. El
--      CHECK `movimiento_bancario_check` (gasto_id ⇒ conciliado) NO cambia y
--      ningún otro CHECK nombra gastos_n.
--   3) BACKFILL: cada liga de hoy (375) ⇒ UNA parte por |monto| con la
--      moneda de la cuenta, created_at/created_by = updated_at/updated_by del
--      movimiento; gastos_n = 1. updated_at NO se mueve (trigger apagado
--      durante el backfill). gasto.conciliado NO se toca.
--   4) vt_actor_id(), tolerancia_lote(n) = least(1.00, greatest(0.02,
--      0.01 × N)), regla_gasto_cubierto(...) (el CASE ordenado de
--      gasto.conciliado, UNA vez), la vista v_gasto_conciliacion (gasto_id,
--      n_partes, cruzado, suma, monto_vinculado, faltante, cubierto) y
--      recalcular_gasto_conciliado(gasto, actor, monto_desligado): ÚNICO
--      escritor de gasto.conciliado y del tc_gasto derivado del banco.
--   5) Triggers de la puente: A tg_mov_gasto_parte_valida (BEFORE ROW:
--      candados por gasto y por cargo) y B tg_mov_gasto_parte_sync (AFTER
--      STATEMENT con tablas de transición: espejos del cargo + bandera de
--      cada gasto tocado). Postgres no admite tablas de transición en un
--      trigger de varios eventos: B son 3 triggers (insert/update/delete)
--      sobre la MISMA función.
--   6) Triggers de movimiento_bancario: C tg_mov_bancario_gasto_id_sync
--      (espejo LEGADO: una escritura directa de gasto_id —API 0.0.51 o SQL a
--      mano— se traduce a la puente; con un lote ⇒ LOTE_SOLO_API_NUEVO;
--      `when (pg_trigger_depth() = 0)`: el WHEN de un AFTER trigger se evalúa
--      con la profundidad de la sentencia que escribe —0 en una escritura
--      directa, ≥ 1 en las de B—; con `= 1` NO se dispara nunca para el API
--      viejo, probado en el dry-run), D
--      tg_mov_bancario_gasto_suma REESCRITO (ahora BEFORE UPDATE OF monto,
--      cuenta_bancaria_id: con gastos ligados ⇒ CARGO_LIGADO), E
--      tg_mov_bancario_reverso REESCRITO (lee `gasto_id is not null or
--      gastos_n > 0`) y K trg_mov_bancario_partes_coherentes (CONSTRAINT
--      TRIGGER DIFERIDO: al commit, espejos = puente —y un cargo con partes
--      sin clasificación/cobro/sobre/ingreso—; si no, PARTES_INCOHERENTES;
--      vigila TODAS las columnas que juzga: gastos_n, conciliado, gasto_id,
--      monto, clasificacion_id, cobro_id, cobro_grupo_id e ingreso_id).
--   7) F inventario_eliminar_movimiento: el candado «gasto con cargo
--      bancario» lee la PUENTE.
--   8) RPC del API 0.0.52: G conciliacion_ligar_cargo_gastos(movimiento,
--      gasto_ids[], actor) y H conciliacion_desligar_cargo_gastos(movimiento,
--      actor).
--   9) Permisos: todo SECURITY DEFINER + search_path '' y EXECUTE solo para
--      service_role (revoke a public/anon/authenticated); la vista solo
--      service_role.
--  10) Verificación final (aborta si falla): partes = ligas gasto_id y 0
--      cargos incoherentes. Reporte informativo (no aborta): gastos con la
--      bandera distinta a la regla (hoy exactamente 1: ASUR 0e8ead24…,
--      $136.99 con un cargo de $121.91; la oficina liga su cargo de $15.08 y
--      queda coherente).
--
-- REGLAS (espejo exacto en el API `conciliacion-parcial.util.ts`; el
-- candado real es la BD):
--   - Por GASTO: Σ partes NO cruzadas ≤ gasto.monto + 1.00. Una parte
--     CRUZADA (moneda de la cuenta ≠ moneda del gasto: USD ↔ MXN) solo si es
--     la ÚNICA del gasto Y del cargo (1↔1, de ahí sale el T.C.).
--   - Por CARGO: Σ monto_parte ≤ |monto| + 1.00; solo tipo CARGO; sin
--     cobro/sobre/ingreso; sin reverso en ningún sentido.
--   - LOTE (N ≥ 2, solo vía G): todos en la moneda de la cuenta; cada gasto
--     entra por su FALTANTE fuera de este cargo (0 ⇒ GASTO_YA_CUBIERTO);
--     |Σ − |monto|| ≤ tolerancia_lote(N) (si no, CARGO_NO_CUADRA). No existe
--     el «cargo parcial»: el centavo de SAESA ($2,231.375) vive en la
--     diferencia del lote, jamás se ajusta un gasto.
--   - N = 1: la regla de hoy (parte = |monto|, el gasto puede quedar
--     parcial, cargo > gasto + 1.00 ⇒ GASTO_YA_CUBIERTO con el texto de hoy).
--   - gasto.conciliado = cruzada ⇒ true; sin partes ⇒ false; monto 0 ⇒ true;
--     round(Σ no cruzadas, 2) + 1e-6 ≥ round(|monto|, 2) − 1.00. Se escribe
--     SOLO si cambia (bitácora limpia).
--   - Errores: 23514, message «CODIGO: texto», hint = CODIGO, detail =
--     jsonb::text con los números (el API: code = hint).
--   - ENUMs (`moneda`, `tipo`) SIEMPRE `::text` (incidente del 15-sep-2026).
--
-- LO QUE NO CAMBIA: ningún número del dinero (los movimientos bancarios no
-- entran al Libro Dinero, al balance ni al reparto), ninguna bandera de
-- gasto (el backfill copia la liga tal cual), el CHECK gasto_id ⇒
-- conciliado, el trigger de updated_at, cobros/sobres/ingresos/reversos.
--
-- CONVIVENCIA CON EL API (orden: migración → API 0.0.52 → panel ENSEGUIDA):
--   - API 0.0.51 + migración: sigue ligando (UPDATE de gasto_id ⇒ C crea la
--     parte y B recalcula), re-ligando idéntico (no-op) y desligando
--     (gasto_id = null + conciliado = false: el CHECK lo permite y C borra
--     la parte; la coherencia se juzga al commit). Un lote no se toca desde
--     el API viejo (LOTE_SOLO_API_NUEVO); el panel viejo lo pinta como
--     conciliado sin detalle.
--   - API 0.0.52 sin migración: su sonda (`gastos_n`) lo detecta y responde
--     como el 0.0.51 (N ≥ 2 ⇒ 503 CONCILIACION_PARTES_NO_DISPONIBLE).
--   - En esa ventana (migración aplicada + API 0.0.51) dos rechazos nuevos
--     de la BD le llegan al usuario como 500 genérico, no como 409/400: el
--     link() del 0.0.51 solo traduce GASTO_YA_CUBIERTO y relanza lo demás
--     como `new Error(msg)`. (a) Ligar un gasto a un ABONO ⇒ A responde
--     LOTE_INVALIDO (antes D lo permitía; 2-oct: 0 abonos con gasto_id).
--     (b) Toda escritura legada de gasto_id sobre un lote ⇒ C responde
--     LOTE_SOLO_API_NUEVO. Por eso: migración → API 0.0.52 ENSEGUIDA, y con
--     un lote vivo el API NO se regresa al 0.0.51 (respondería 500 al tocar
--     esos cargos); si hay que regresarlo, primero desligar los lotes desde
--     Conciliación o revertir esta migración (su paso 0 lo exige).
--   - K es DIFERIDO: una transacción que escribe en movimiento_bancario
--     (conciliado, gasto_id, gastos_n, monto, clasificación, cobro, sobre o
--     ingreso) y DESPUÉS hace ALTER TABLE sobre ella falla con 55006
--     «cannot ALTER TABLE … because it has pending trigger events». Una
--     migración o un dry-run futuro que mezcle DML y DDL sobre la tabla
--     corre `set constraints all immediate;` antes del ALTER (el ROLLBACK
--     del pie ya lo hace justo después de `begin;`).
--   - Una limpieza SQL a mano que BORRE movimientos con partes (estilo
--     20260929000001) recalcula sus gastos por la cascada, pero la bitácora
--     atribuye la desconciliación a quien ligó la parte (created_by), no a
--     quien borra: antes del DELETE, en la MISMA transacción,
--     `select set_config('vt.actor_id', '<uuid del usuario que limpia>', true);`.
--
-- TRAS APLICAR: `get_advisors` (esperado: sin hallazgos nuevos de seguridad;
-- funciones con search_path fijo y EXECUTE solo service_role); repetir la
-- verificación del punto 10 a mano (`select count(*) from
-- public.movimiento_bancario_gasto` = `select count(*) from
-- public.movimiento_bancario where gasto_id is not null`, y 0 filas en
-- `select id from public.movimiento_bancario where
-- public.motivo_partes_incoherentes(id) is not null`); sondear con el API
-- 0.0.52 `GET /v1/conciliacion/movimientos/<cargo>/gastos-candidatos`
-- (200, no 503).
--
-- ⚠ PENDIENTE DE APLICAR (la aplica el orquestador).
-- DRY-RUN CORRIDO EN PROD el 2-oct-2026 (bjesduasnzbzywofukbf, UNA llamada de
-- execute_sql con el bloque de abajo + las secciones 0–10 + el ROLLBACK del
-- pie, sin líneas de comentario ni sangría), versión corregida tras la
-- revisión (K vigila las 8 columnas que juzga; set constraints all immediate
-- en el pie): «DRYRUN_OK · huella fc41134798faddb5afc628f6f99d2ec8 · ligas
-- 375 = partes backfill 375 · reporte bandera≠regla:
-- 0e8ead24-46c8-4b47-a128-64a2ad493321 · C0 estructura/permisos/backfill · 1
-- G simple · 2 espejo API 0.0.51 (liga, re-liga idéntica, desligue) · 3 lote
-- SAESA 8,404.20 · 3b 4,462.75 dif 0.01 · 4 CARGO_NO_CUADRA · 5
-- LOTE_MONEDA_DISTINTA · 6 REVERSO_INVALIDO (G, A, legado, E) · 8
-- CARGO_LIGADO · 10 LOTE_SOLO_API_NUEVO · 9a reemplazo sin bitácora · 7 H
-- lote · 9b re-liga idéntica no-op + extras · 11 1↔1 cruzado T.C. 17.866840
-- · 12 PARTES_INCOHERENTES · F inventario GASTO_BLOQUEADO · 13 service_role
-- sí/anon no · 10b clasificación sola y cobro solo ⇒ PARTES_INCOHERENTES ·
-- Rt DML+ALTER sin immediate ⇒ 55006 · R rollback (bloqueo con lote + set
-- constraints del pie + restauración exacta) · todo se revierte». La HUELLA
-- (md5 del prosrc de las 14 funciones + vista + triggers + CHECKs de las dos
-- tablas) es IDÉNTICA a la del mismo texto ensayado en local (PGlite, PG 17)
-- ⇒ prod probó exactamente estas definiciones. En local, mutantes del
-- ensayo: K con la lista vieja ⇒ DRYRUN_FALLA C0; sin el chequeo de C0 ⇒
-- DRYRUN_FALLA 10 (clasificación sola); K solo con clasificacion_id ⇒
-- DRYRUN_FALLA 10 (cobro solo); pie sin `set constraints all immediate` ⇒
-- 55006 en R1. Después (solo SELECT): puente y vista NULL, columnas gastos_n
-- y x_dryrun_trampa ausentes, 0 funciones nuevas, 3 triggers en
-- movimiento_bancario, md5 del prosrc de D igual al de antes
-- (85ef8bb4…), 375 ligas, 375 gastos conciliados, 1,105 filas de
-- bitácora, 728 movimientos, el lote c5819d4b… sin conciliar y el 2,231.38
-- sigue ligado a #318: NADA quedó escrito.
-- Ids reales usados: cargo c5819d4b… (8,404.20) con #315/#319/#326; cargo
-- ae9033f3… (4,462.75) con #318 + #322 tras soltar 5e879489… (2,231.38 ↔
-- #318); 2,231.38 ↔ #321 (el exacto); 1↔1 cruzado real 613ad49a… (14,197.17
-- MXN) ↔ gasto USD 340c3dc6… (794.61, T.C. 17.866840); par de reverso real
-- ASUR 2baee742… ↔ 35d5c5eb… (825.13); gasto de bodega c4b10200… (351.88)
-- con su SALIDA 5babc69b…; el primer cobro_vuelo por id (paso 10b, solo
-- dentro del ensayo).
-- HUELLA tras aplicar (opcional): la consulta `select md5(string_agg(x, '|'
-- order by x)) …` del paso C0 sobre el archivo TAL CUAL (con comentarios)
-- da 8edb19de1f536d88ae64518e59338e86 en el ensayo local; si el texto se
-- aplica sin comentarios (como el dry-run), fc41134798faddb5afc628f6f99d2ec8.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- UNA sola llamada de `execute_sql` con UN bloque `do $dry$ … $dry$;` que
-- lleva dentro TODO el cuerpo de la migración (secciones 0–10, tal cual; el
-- `select pg_notify` final como `perform`) seguido de estos pasos y del
-- ROLLBACK del pie (sin begin/commit, con su `set constraints all
-- immediate`), y que TERMINA SIEMPRE con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL, backfill y
-- escrituras) aunque la herramienta haga autocommit. Cualquier
-- 'DRYRUN_FALLA …' u otro error = NO aplicar. Después:
-- `select to_regclass('public.movimiento_bancario_gasto')` ⇒ NULL.
-- Cada paso que debe fallar atrapa el error y compara `message`/`hint`/
-- `detail`; la coherencia diferida se fuerza con
-- `set constraints all immediate` (y vuelve a deferred) al final de cada paso.
--
--   do $dry$
--   declare
--     -- Ids REALES de prod (verificados con SELECT el 2-oct-2026). GASTOS GNRAL
--     -- (MXN) y los SPEI del 24-sep que pagan los «Pago VIP SAESA».
--     k_cuenta    constant uuid := '76a931e0-7c06-47c6-a574-6c7d4a698c14';
--     k_lote      constant uuid := 'c5819d4b-a4ad-45c0-9fbd-23cb31a137a9';  -- 8,404.20 = 3 × 2,801.40
--     k_lote2     constant uuid := 'ae9033f3-f4a0-45b2-9872-24f11eb04a91';  -- 4,462.75
--     k_4462b     constant uuid := '0a2c28a1-5e39-435a-b885-0e5c3c4fa3ea';  -- 4,462.75 (el otro)
--     k_2231      constant uuid := '5e879489-a73c-469b-9d1f-0a27456f59be';  -- 2,231.38 ligado HOY a #318
--     k_1118a     constant uuid := '211b813a-bec1-4533-8204-c46bc8642f44';  -- 1,118.12
--     k_1118b     constant uuid := 'f0606758-884a-4d30-a430-011683d64a1a';  -- 1,118.12
--     k_7a        constant uuid := 'def3309c-89fd-4f98-ae8d-5cd990ea0f8a';  -- comisión SPEI 7.00
--     k_7b        constant uuid := '256180e0-902b-4330-9c6b-b857175dffd7';  -- comisión SPEI 7.00
--     g315        constant uuid := '6af6ac1d-94f4-49a0-bf9d-0cb02d590176';  -- SAESA vuelo #315 2,801.40
--     g319        constant uuid := '393ee621-ecf7-4351-872d-ed556c4597d3';  -- #319 2,801.40
--     g326        constant uuid := '33963654-88ee-496f-8716-1483db71e345';  -- #326 2,801.40
--     g236        constant uuid := 'c8eff8a5-8b40-4277-ae66-8cc4157fd8e2';  -- #236 2,801.40
--     g318        constant uuid := 'a08a025f-0581-4a5a-98a5-b5ae68090466';  -- #318 2,231.37 (liga equivocada)
--     g322        constant uuid := 'ff5f7fd6-288a-422c-a44c-1e7b3b410e6a';  -- #322 2,231.37
--     g321        constant uuid := 'cc7d64b0-cb0a-44cc-9782-20af116c7bcf';  -- #321 2,231.38 (el exacto)
--     g237        constant uuid := '031dca28-5986-4d7e-9f4c-889743636539';  -- #237 2,231.37
--     g247        constant uuid := '5c245993-282b-4651-9306-beb1105e61f9';  -- #247 2,231.37
--     g248        constant uuid := '7725211d-6b84-402c-ab73-8b399d09db05';  -- #248 1,118.12
--     g249        constant uuid := '6cd093f8-e709-4cc1-9865-18e9467df1e9';  -- #249 1,118.12
--     k_cruz      constant uuid := '613ad49a-33fd-4f01-8168-ded2434676f0';  -- cargo MXN 14,197.17
--     g_usd       constant uuid := '340c3dc6-f040-4527-8858-d285b110ee86';  -- gasto USD 794.61 (T.C. 17.866840)
--     k_rev_cargo constant uuid := '2baee742-cf9f-460a-8032-2ed9d6917d6d';  -- ASUR 825.13 del 21-sep
--     k_rev_abono constant uuid := '35d5c5eb-ebf6-4959-a22a-e5282cde329d';  -- CARGO INDEBIDO 825.13 del 23-sep
--     g_bodega    constant uuid := 'c4b10200-4fbc-432f-9b90-c15588f1af8a';  -- REFACCION/BODEGA 351.88 MXN
--     k_inv_mov   constant uuid := '5babc69b-7bcc-4cb2-8226-50a701dfb9a4';  -- su SALIDA de cardex
--     k_inv_item  constant uuid := 'd99df930-16e2-499a-877a-37e9518c1041';
--     v_admin uuid;
--     v_admin2 uuid;
--     v_clasif uuid;
--     v_cobro uuid;
--     v_otra_cuenta uuid;
--     g_usd_libre uuid;
--     v_res jsonb;
--     v_det jsonb;
--     v_txt text;
--     v_hint text;
--     v_dettxt text;
--     v_n integer;
--     v_b0 bigint;
--     v_ctid tid;
--     v_ctid2 tid;
--     v_ctid3 tid;
--     v_ts timestamptz;
--     v_tc0 numeric;
--     v_ligas0 bigint;
--     v_partes_backfill bigint;
--     v_reporte text;
--     v_def_trg_d text;
--     v_def_trg_e text;
--     v_def_chk text;
--     v_fn_d text;
--     v_fn_e text;
--     v_fn_f text;
--     v_huella text;
--   begin
--     -- A) CONTEXTO: el estado real de prod que el ensayo da por hecho.
--     if to_regclass('public.movimiento_bancario_gasto') is not null then
--       raise exception 'DRYRUN_FALLA A: la puente ya existe (¿migración aplicada?)';
--     end if;
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--        and u.id <> 'ca9564a1-eef0-4fdb-b4e9-beceaa5a2428'
--      order by u.created_at limit 1;
--     select u.id into v_admin2 from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--        and u.id <> 'ca9564a1-eef0-4fdb-b4e9-beceaa5a2428' and u.id <> v_admin
--      order by u.created_at limit 1;
--     select c.id into v_clasif from public.conciliacion_clasificacion c
--      where lower(c.nombre) = lower('Reverso de un cargo') limit 1;
--     select cv.id into v_cobro from public.cobro_vuelo cv order by cv.id limit 1;
--     select c.id into v_otra_cuenta from public.cuenta_bancaria c
--      where c.moneda::text = 'MXN' and c.id <> k_cuenta order by c.created_at limit 1;
--     select g.id into g_usd_libre from public.gasto g
--      where g.moneda::text = 'USD' and not g.conciliado
--        and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--      order by g.fecha_gasto desc, g.id limit 1;
--     if v_admin is null or v_admin2 is null or v_clasif is null or v_cobro is null or v_otra_cuenta is null or g_usd_libre is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto (admin %, admin2 %, clasificación reverso %, cobro %, otra cuenta %, gasto USD libre %)',
--         v_admin, v_admin2, v_clasif, v_cobro, v_otra_cuenta, g_usd_libre;
--     end if;
--     if (select count(*) from public.movimiento_bancario m
--          where m.id in (k_lote, k_lote2, k_4462b, k_1118a, k_1118b, k_7a, k_7b, k_rev_cargo)
--            and m.tipo::text = 'CARGO' and not m.conciliado and m.gasto_id is null
--            and m.cuenta_bancaria_id = k_cuenta and m.reverso_de_id is null) <> 8
--        or not exists (select 1 from public.movimiento_bancario m
--                        where m.id = k_2231 and m.gasto_id = g318 and m.conciliado and m.monto = 2231.38)
--        or not exists (select 1 from public.movimiento_bancario m
--                        where m.id = k_cruz and m.gasto_id = g_usd and m.monto = 14197.17)
--        or not exists (select 1 from public.movimiento_bancario m
--                        where m.id = k_rev_abono and m.tipo::text = 'ABONO' and not m.conciliado
--                          and m.reverso_de_id is null and m.monto = 825.13)
--        or (select count(*) from public.gasto g
--             where g.id in (g315, g319, g326, g236, g322, g321, g237, g247, g248, g249, g_bodega)
--               and not g.conciliado
--               and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)) <> 11
--        or not exists (select 1 from public.gasto g where g.id = g_usd and g.conciliado
--                        and g.tc_gasto = 17.866840 and g.monto = 794.61 and g.moneda::text = 'USD') then
--       raise exception 'DRYRUN_FALLA A: el estado real de los cargos/gastos del ensayo cambió; revisa los ids';
--     end if;
--     select count(*) into v_ligas0 from public.movimiento_bancario where gasto_id is not null;
--     create temporary table _dry_mov on commit drop as
--       select id, updated_at, updated_by from public.movimiento_bancario;
--     -- Definiciones ORIGINALES (para comprobar el ROLLBACK al final).
--     select pg_get_triggerdef(t.oid) into v_def_trg_d from pg_trigger t
--      where t.tgrelid = 'public.movimiento_bancario'::regclass and t.tgname = 'trg_mov_bancario_gasto_suma';
--     select pg_get_triggerdef(t.oid) into v_def_trg_e from pg_trigger t
--      where t.tgrelid = 'public.movimiento_bancario'::regclass and t.tgname = 'trg_mov_bancario_reverso';
--     select pg_get_constraintdef(c.oid) into v_def_chk from pg_constraint c
--      where c.conrelid = 'public.movimiento_bancario'::regclass
--        and c.conname = 'movimiento_bancario_ingreso_excluyente_chk';
--     v_fn_d := regexp_replace(regexp_replace(pg_get_functiondef('public.tg_mov_bancario_gasto_suma()'::regprocedure),
--                 '--[^' || chr(10) || ']*', '', 'g'), '\s+', '', 'g');
--     v_fn_e := regexp_replace(regexp_replace(pg_get_functiondef('public.tg_mov_bancario_reverso()'::regprocedure),
--                 '--[^' || chr(10) || ']*', '', 'g'), '\s+', '', 'g');
--     v_fn_f := regexp_replace(regexp_replace(pg_get_functiondef('public.inventario_eliminar_movimiento(uuid,uuid,text,uuid)'::regprocedure),
--                 '--[^' || chr(10) || ']*', '', 'g'), '\s+', '', 'g');
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN (secciones 0–10, TAL CUAL; el
--     --    `select pg_notify` final va como `perform`).
--
--     -- (pegar AQUÍ las secciones 0–10 de abajo, TAL CUAL)
--
--     -- C0) ESTRUCTURA, PERMISOS y BACKFILL
--     select count(*) into v_partes_backfill from public.movimiento_bancario_gasto;
--     if v_partes_backfill <> v_ligas0
--        or (select count(*) from public.movimiento_bancario where gastos_n = 1) <> v_ligas0
--        or exists (select 1 from public.movimiento_bancario where gastos_n <> 0 and gastos_n <> 1) then
--       raise exception 'DRYRUN_FALLA C0: backfill % partes para % ligas', v_partes_backfill, v_ligas0;
--     end if;
--     if exists (select 1 from public.movimiento_bancario_gasto p
--                  join public.movimiento_bancario m on m.id = p.movimiento_id
--                  join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
--                 where p.gasto_id is distinct from m.gasto_id or p.monto_parte <> abs(m.monto)
--                    or p.moneda::text <> c.moneda::text or p.created_by is distinct from m.updated_by
--                    or p.created_at is distinct from m.updated_at) then
--       raise exception 'DRYRUN_FALLA C0: una parte del backfill no copia su liga';
--     end if;
--     if exists (select 1 from public.movimiento_bancario m join _dry_mov d on d.id = m.id
--                 where m.updated_at is distinct from d.updated_at or m.updated_by is distinct from d.updated_by) then
--       raise exception 'DRYRUN_FALLA C0: el backfill movió updated_at/updated_by';
--     end if;
--     if (select tgenabled from pg_trigger where tgrelid = 'public.movimiento_bancario'::regclass
--           and tgname = 'trg_movimiento_bancario_set_updated_at') <> 'O' then
--       raise exception 'DRYRUN_FALLA C0: el trigger de updated_at quedó apagado';
--     end if;
--     if (select count(*) from pg_trigger where tgrelid = 'public.movimiento_bancario_gasto'::regclass and not tgisinternal) <> 4
--        or (select count(*) from pg_trigger where tgrelid = 'public.movimiento_bancario'::regclass and not tgisinternal) <> 5
--        or not exists (select 1 from pg_trigger where tgname = 'trg_mov_bancario_partes_coherentes'
--                        and tgdeferrable and tginitdeferred)
--        -- K vigila TODAS las columnas que juzga motivo_partes_incoherentes.
--        or (select pg_get_triggerdef(t.oid) from pg_trigger t
--             where t.tgrelid = 'public.movimiento_bancario'::regclass
--               and t.tgname = 'trg_mov_bancario_partes_coherentes')
--           not like '%UPDATE OF gastos_n, conciliado, gasto_id, monto, clasificacion_id, cobro_id, cobro_grupo_id, ingreso_id ON %'
--        or not exists (select 1 from pg_policies where tablename = 'movimiento_bancario_gasto'
--                        and policyname = 'movimiento_bancario_gasto_read_active_user' and cmd = 'SELECT')
--        or not (select relrowsecurity from pg_class where oid = 'public.movimiento_bancario_gasto'::regclass) then
--       raise exception 'DRYRUN_FALLA C0: faltan triggers, el diferido (con todas sus columnas) o la RLS';
--     end if;
--     if has_function_privilege('anon', 'public.conciliacion_ligar_cargo_gastos(uuid,uuid[],uuid)', 'execute')
--        or has_function_privilege('authenticated', 'public.conciliacion_ligar_cargo_gastos(uuid,uuid[],uuid)', 'execute')
--        or not has_function_privilege('service_role', 'public.conciliacion_ligar_cargo_gastos(uuid,uuid[],uuid)', 'execute')
--        or has_function_privilege('anon', 'public.conciliacion_desligar_cargo_gastos(uuid,uuid)', 'execute')
--        or not has_function_privilege('service_role', 'public.conciliacion_desligar_cargo_gastos(uuid,uuid)', 'execute')
--        or has_function_privilege('authenticated', 'public.recalcular_gasto_conciliado(uuid,uuid,numeric)', 'execute')
--        or has_table_privilege('anon', 'public.v_gasto_conciliacion', 'select')
--        or not has_table_privilege('service_role', 'public.v_gasto_conciliacion', 'select')
--        or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--                    where n.nspname = 'public'
--                      and p.proname in ('vt_actor_id', 'tolerancia_lote', 'regla_gasto_cubierto',
--                                        'recalcular_gasto_conciliado', 'motivo_partes_incoherentes',
--                                        'tg_mov_gasto_parte_valida', 'tg_mov_gasto_parte_sync',
--                                        'tg_mov_bancario_gasto_id_sync', 'tg_mov_bancario_partes_coherentes',
--                                        'conciliacion_ligar_cargo_gastos', 'conciliacion_desligar_cargo_gastos')
--                      and (not p.prosecdef or p.proconfig is null)) then
--       raise exception 'DRYRUN_FALLA C0: permisos o security definer/search_path';
--     end if;
--     if public.tolerancia_lote(1) <> 0.02 or public.tolerancia_lote(2) <> 0.02 or public.tolerancia_lote(3) <> 0.03
--        or public.tolerancia_lote(29) <> 0.29 or public.tolerancia_lote(250) <> 1.00 then
--       raise exception 'DRYRUN_FALLA C0: tolerancia_lote';
--     end if;
--     perform set_config('vt.actor_id', 'no-es-uuid', true);
--     if public.vt_actor_id() is not null then raise exception 'DRYRUN_FALLA C0: vt_actor_id aceptó basura'; end if;
--     perform set_config('vt.actor_id', '', true);
--     -- Reporte informativo: bandera distinta a la regla (hoy: solo ASUR 0e8ead24).
--     select string_agg(g.id::text, ',' order by g.id) into v_reporte
--       from public.gasto g join public.v_gasto_conciliacion v on v.gasto_id = g.id
--      where g.conciliado is distinct from v.cubierto;
--     if v_reporte is distinct from '0e8ead24-46c8-4b47-a128-64a2ad493321' then
--       raise exception 'DRYRUN_FALLA C0: el reporte de banderas cambió: %', v_reporte;
--     end if;
--     -- HUELLA de lo creado (funciones, vista, triggers y CHECK): la misma en el
--     -- ensayo local y en prod ⇒ prod probó EXACTAMENTE este texto.
--     select md5(string_agg(x, '|' order by x)) into v_huella
--       from (
--         select p.proname || ':' || p.prosrc as x
--           from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--          where n.nspname = 'public'
--            and p.proname in ('vt_actor_id', 'tolerancia_lote', 'regla_gasto_cubierto',
--                              'recalcular_gasto_conciliado', 'motivo_partes_incoherentes',
--                              'tg_mov_gasto_parte_valida', 'tg_mov_gasto_parte_sync',
--                              'tg_mov_bancario_gasto_id_sync', 'tg_mov_bancario_partes_coherentes',
--                              'conciliacion_ligar_cargo_gastos', 'conciliacion_desligar_cargo_gastos',
--                              'tg_mov_bancario_gasto_suma', 'tg_mov_bancario_reverso',
--                              'inventario_eliminar_movimiento')
--         union all
--         select 'vista:' || pg_get_viewdef('public.v_gasto_conciliacion'::regclass)
--         union all
--         select 'trigger:' || pg_get_triggerdef(t.oid)
--           from pg_trigger t
--          where t.tgrelid in ('public.movimiento_bancario'::regclass, 'public.movimiento_bancario_gasto'::regclass)
--            and not t.tgisinternal
--         union all
--         select 'check:' || c.conname || ':' || pg_get_constraintdef(c.oid)
--           from pg_constraint c
--          where c.conrelid in ('public.movimiento_bancario'::regclass, 'public.movimiento_bancario_gasto'::regclass)
--            and c.contype = 'c'
--       ) h;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (1) LIGA SIMPLE vía G (1 gasto)
--     select count(*) into v_b0 from public.gasto_bitacora where gasto_id = g248;
--     v_res := public.conciliacion_ligar_cargo_gastos(k_1118a, array[g248], v_admin);
--     if jsonb_array_length(v_res -> 'partes') <> 1 or jsonb_array_length(v_res -> 'salientes') <> 0
--        or jsonb_array_length(v_res -> 'anteriores') <> 0
--        or (v_res -> 'partes' -> 0 ->> 'monto_parte')::numeric <> 1118.12
--        or v_res -> 'partes' -> 0 ->> 'moneda' <> 'MXN' then
--       raise exception 'DRYRUN_FALLA 1: respuesta %', v_res;
--     end if;
--     if not exists (select 1 from public.movimiento_bancario where id = k_1118a and gastos_n = 1
--                     and gasto_id = g248 and conciliado and clasificacion_id is null and updated_by = v_admin)
--        or not exists (select 1 from public.movimiento_bancario_gasto where movimiento_id = k_1118a
--                        and gasto_id = g248 and monto_parte = 1118.12 and created_by = v_admin)
--        or not exists (select 1 from public.v_gasto_conciliacion where gasto_id = g248 and n_partes = 1
--                        and not cruzado and suma = 1118.12 and monto_vinculado = 1118.12 and faltante = 0 and cubierto)
--        or not (select conciliado from public.gasto where id = g248) then
--       raise exception 'DRYRUN_FALLA 1: espejo/parte/gasto no quedaron';
--     end if;
--     if (select count(*) from public.gasto_bitacora where gasto_id = g248) - v_b0 <> 1
--        or not exists (select 1 from public.gasto_bitacora where gasto_id = g248 and accion = 'UPDATE'
--                        and actor_id = v_admin and (diff -> 'conciliado' ->> 'despues')::boolean) then
--       raise exception 'DRYRUN_FALLA 1: bitácora del gasto (actor = p_actor)';
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (2) CAMINO DEL API 0.0.51 (escritura directa de gasto_id ⇒ trigger C)
--     select count(*) into v_b0 from public.gasto_bitacora where gasto_id = g249;
--     update public.movimiento_bancario
--        set gasto_id = g249, conciliado = true, clasificacion_id = null, updated_by = v_admin2
--      where id = k_1118b;
--     select p.ctid, p.created_at into v_ctid, v_ts from public.movimiento_bancario_gasto p
--      where p.movimiento_id = k_1118b and p.gasto_id = g249 and p.monto_parte = 1118.12 and p.created_by = v_admin2;
--     if v_ctid is null then
--       raise exception 'DRYRUN_FALLA 2: C no creó la parte (¿WHEN de profundidad?)';
--     end if;
--     if not exists (select 1 from public.movimiento_bancario where id = k_1118b and gastos_n = 1
--                     and gasto_id = g249 and conciliado and updated_by = v_admin2)
--        or not (select conciliado from public.gasto where id = g249)
--        or (select count(*) from public.gasto_bitacora where gasto_id = g249) - v_b0 <> 1
--        or not exists (select 1 from public.gasto_bitacora where gasto_id = g249 and accion = 'UPDATE'
--                        and actor_id = v_admin2 and diff ? 'conciliado') then
--       raise exception 'DRYRUN_FALLA 2: espejo/gasto/bitácora tras la liga legada';
--     end if;
--     update public.movimiento_bancario
--        set gasto_id = g249, conciliado = true, clasificacion_id = null, updated_by = v_admin2
--      where id = k_1118b;
--     if (select count(*) from public.gasto_bitacora where gasto_id = g249) - v_b0 <> 1
--        or (select p.ctid from public.movimiento_bancario_gasto p
--             where p.movimiento_id = k_1118b and p.gasto_id = g249) is distinct from v_ctid
--        or (select p.created_at from public.movimiento_bancario_gasto p
--             where p.movimiento_id = k_1118b and p.gasto_id = g249) is distinct from v_ts then
--       raise exception 'DRYRUN_FALLA 2: la re-liga idéntica reescribió la parte o la bitácora';
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--     update public.movimiento_bancario
--        set gasto_id = null, conciliado = false, clasificacion_id = null, updated_by = v_admin2
--      where id = k_1118b;
--     if exists (select 1 from public.movimiento_bancario_gasto where movimiento_id = k_1118b)
--        or not exists (select 1 from public.movimiento_bancario where id = k_1118b and gastos_n = 0
--                        and gasto_id is null and not conciliado and updated_by = v_admin2)
--        or (select conciliado from public.gasto where id = g249)
--        or (select count(*) from public.gasto_bitacora where gasto_id = g249) - v_b0 <> 2 then
--       raise exception 'DRYRUN_FALLA 2: el desligue legado no limpió';
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (3) LOTE SAESA real: 8,404.20 = #315 + #319 + #326
--     v_res := public.conciliacion_ligar_cargo_gastos(k_lote, array[g315, g319, g326], v_admin);
--     if jsonb_array_length(v_res -> 'partes') <> 3
--        or exists (select 1 from jsonb_array_elements(v_res -> 'partes') e
--                    where (e ->> 'monto_parte')::numeric <> 2801.40 or e ->> 'moneda' <> 'MXN') then
--       raise exception 'DRYRUN_FALLA 3: respuesta %', v_res;
--     end if;
--     if not exists (select 1 from public.movimiento_bancario where id = k_lote and gastos_n = 3
--                     and gasto_id is null and conciliado and updated_by = v_admin)
--        or (select count(*) from public.gasto where id in (g315, g319, g326) and conciliado) <> 3 then
--       raise exception 'DRYRUN_FALLA 3: el lote no quedó (gastos_n 3, gasto_id NULL, 3 cubiertos)';
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (3b) 4,462.75 = #318 + #322 (2 × 2,231.37, diferencia 0.01), tras soltar
--     --      la liga equivocada 2,231.38 ↔ #318 del auto-cruce.
--     v_res := public.conciliacion_desligar_cargo_gastos(k_2231, v_admin);
--     if jsonb_array_length(v_res -> 'salientes') <> 1
--        or (v_res -> 'salientes' -> 0 ->> 'gasto_id')::uuid <> g318
--        or (v_res -> 'salientes' -> 0 ->> 'monto_parte')::numeric <> 2231.38
--        or (select conciliado from public.gasto where id = g318)
--        or not exists (select 1 from public.movimiento_bancario where id = k_2231 and gastos_n = 0
--                        and gasto_id is null and not conciliado) then
--       raise exception 'DRYRUN_FALLA 3b: el desligue de #318 %', v_res;
--     end if;
--     v_res := public.conciliacion_ligar_cargo_gastos(k_lote2, array[g318, g322], v_admin);
--     if jsonb_array_length(v_res -> 'partes') <> 2
--        or (select sum(monto_parte) from public.movimiento_bancario_gasto where movimiento_id = k_lote2) <> 4462.74
--        or not exists (select 1 from public.movimiento_bancario where id = k_lote2 and gastos_n = 2
--                        and gasto_id is null and conciliado)
--        or (select count(*) from public.gasto where id in (g318, g322) and conciliado) <> 2 then
--       raise exception 'DRYRUN_FALLA 3b: el lote 4,462.75 no cuadró con diferencia 0.01 (%)', v_res;
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (4) LOTE QUE NO CUADRA: 2 × 2,801.40 contra 8,404.20
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_lote, array[g315, g319], v_admin);
--       raise exception 'DRYRUN_FALLA 4: aceptó un lote que no cuadra';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_dettxt = pg_exception_detail;
--       if v_hint is distinct from 'CARGO_NO_CUADRA' or v_txt not like 'CARGO_NO_CUADRA: %' then
--         raise exception 'DRYRUN_FALLA 4: %', v_txt;
--       end if;
--       v_det := v_dettxt::jsonb;
--       if (v_det ->> 'monto_cargo')::numeric <> 8404.20 or (v_det ->> 'suma_gastos')::numeric <> 5602.80
--          or (v_det ->> 'diferencia')::numeric <> 2801.40 or (v_det ->> 'tolerancia')::numeric <> 0.02
--          or v_det ->> 'moneda' <> 'MXN' or jsonb_array_length(v_det -> 'gastos') <> 2
--          or (v_det -> 'gastos' -> 0 ->> 'faltante')::numeric <> 2801.40 then
--         raise exception 'DRYRUN_FALLA 4: detail %', v_dettxt;
--       end if;
--     end;
--     if (select count(*) from public.movimiento_bancario_gasto where movimiento_id = k_lote) <> 3 then
--       raise exception 'DRYRUN_FALLA 4: el rechazo tocó el lote';
--     end if;
--
--     -- (5) LOTE CON MONEDA DISTINTA
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_4462b, array[g237, g_usd_libre], v_admin);
--       raise exception 'DRYRUN_FALLA 5: aceptó un gasto USD en un lote de cuenta MXN';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_dettxt = pg_exception_detail;
--       v_det := v_dettxt::jsonb;
--       if v_hint is distinct from 'LOTE_MONEDA_DISTINTA' or v_txt not like 'LOTE_MONEDA_DISTINTA: %'
--          or v_det ->> 'moneda_gasto' <> 'USD' or v_det ->> 'moneda_cuenta' <> 'MXN'
--          or (v_det ->> 'gasto_id')::uuid <> g_usd_libre then
--         raise exception 'DRYRUN_FALLA 5: % / %', v_txt, v_dettxt;
--       end if;
--     end;
--
--     -- (6) REVERSO: se empareja el par REAL (ASUR 825.13) como lo escribe el API
--     update public.movimiento_bancario
--        set reverso_de_id = k_rev_cargo, clasificacion_id = v_clasif, conciliado = true
--      where id = k_rev_abono and conciliado = false and reverso_de_id is null and gasto_id is null
--        and gastos_n = 0 and cobro_id is null and cobro_grupo_id is null and clasificacion_id is null
--        and ingreso_id is null;
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA 6: el abono no se emparejó'; end if;
--     update public.movimiento_bancario
--        set clasificacion_id = v_clasif, conciliado = true
--      where id = k_rev_cargo and conciliado = false and gasto_id is null and gastos_n = 0
--        and clasificacion_id is null;
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA 6: el cargo devuelto no se concilió'; end if;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_rev_cargo, array[g236], v_admin);
--       raise exception 'DRYRUN_FALLA 6: G ligó un cargo emparejado por reverso';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--       if v_hint is distinct from 'REVERSO_INVALIDO' or v_txt not like 'REVERSO_INVALIDO: %' then
--         raise exception 'DRYRUN_FALLA 6: G %', v_txt;
--       end if;
--     end;
--     begin
--       insert into public.movimiento_bancario_gasto (movimiento_id, gasto_id, monto_parte)
--       values (k_rev_cargo, g236, 825.13);
--       raise exception 'DRYRUN_FALLA 6: A aceptó una parte en un cargo emparejado';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'REVERSO_INVALIDO: %' then raise exception 'DRYRUN_FALLA 6: A %', v_txt; end if;
--     end;
--     begin
--       update public.movimiento_bancario set gasto_id = g236, conciliado = true where id = k_rev_cargo;
--       raise exception 'DRYRUN_FALLA 6: el espejo legado ligó un cargo emparejado';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'REVERSO_INVALIDO: %' then raise exception 'DRYRUN_FALLA 6: legado %', v_txt; end if;
--     end;
--     begin
--       update public.movimiento_bancario set gastos_n = 1 where id = k_rev_cargo;
--       raise exception 'DRYRUN_FALLA 6: E dejó crecer gastos_n en un cargo emparejado';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'REVERSO_INVALIDO: este cargo está emparejado%' then
--         raise exception 'DRYRUN_FALLA 6: E lado cargo %', v_txt;
--       end if;
--     end;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_rev_abono, array[g236], v_admin);
--       raise exception 'DRYRUN_FALLA 6: G ligó un ABONO';
--     exception when check_violation then
--       get stacked diagnostics v_hint = pg_exception_hint, v_txt = message_text;
--       if v_hint is distinct from 'LOTE_INVALIDO' then raise exception 'DRYRUN_FALLA 6: abono %', v_txt; end if;
--     end;
--     begin
--       -- Devolución sintética del LOTE (gasto_id NULL, gastos_n 3): E la rechaza.
--       insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, reverso_de_id, conciliado)
--       values (k_cuenta, date '2026-09-25', 'ABONO', 8404.20, 'DRYRUN DEVOLUCION LOTE', k_lote, true);
--       raise exception 'DRYRUN_FALLA 6: E emparejó una devolución con un cargo que paga un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'REVERSO_INVALIDO: el cargo ya está conciliado%' then
--         raise exception 'DRYRUN_FALLA 6: E lote %', v_txt;
--       end if;
--     end;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (8) MONTO/CUENTA de un cargo con partes ⇒ CARGO_LIGADO (lote y 1 parte)
--     begin
--       update public.movimiento_bancario set monto = monto + 1 where id = k_lote;
--       raise exception 'DRYRUN_FALLA 8: cambió el monto de un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--       if v_hint is distinct from 'CARGO_LIGADO' or v_txt not like 'CARGO_LIGADO: %' then
--         raise exception 'DRYRUN_FALLA 8: %', v_txt;
--       end if;
--     end;
--     begin
--       update public.movimiento_bancario set cuenta_bancaria_id = v_otra_cuenta where id = k_lote;
--       raise exception 'DRYRUN_FALLA 8: cambió la cuenta de un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'CARGO_LIGADO: %' then raise exception 'DRYRUN_FALLA 8: cuenta %', v_txt; end if;
--     end;
--     begin
--       update public.movimiento_bancario set monto = 1118.13 where id = k_1118a;
--       raise exception 'DRYRUN_FALLA 8: cambió el monto de un cargo con 1 parte';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'CARGO_LIGADO: %' then raise exception 'DRYRUN_FALLA 8: 1 parte %', v_txt; end if;
--     end;
--
--     -- (10) El API 0.0.51 NO desliga ni cambia un lote
--     begin
--       update public.movimiento_bancario set gasto_id = null where id = k_lote;
--       raise exception 'DRYRUN_FALLA 10: gasto_id = null directo sobre un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--       if v_hint is distinct from 'LOTE_SOLO_API_NUEVO' or v_txt not like 'LOTE_SOLO_API_NUEVO: %' then
--         raise exception 'DRYRUN_FALLA 10: %', v_txt;
--       end if;
--     end;
--     begin
--       update public.movimiento_bancario
--          set gasto_id = null, conciliado = false, clasificacion_id = null, updated_by = v_admin2
--        where id = k_lote;
--       raise exception 'DRYRUN_FALLA 10: desligue legado completo sobre un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'LOTE_SOLO_API_NUEVO: %' then raise exception 'DRYRUN_FALLA 10: completo %', v_txt; end if;
--     end;
--     begin
--       update public.movimiento_bancario
--          set gasto_id = g236, conciliado = true, clasificacion_id = null, updated_by = v_admin2
--        where id = k_lote;
--       raise exception 'DRYRUN_FALLA 10: liga legada de 1 gasto sobre un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'LOTE_SOLO_API_NUEVO: %' then raise exception 'DRYRUN_FALLA 10: liga %', v_txt; end if;
--     end;
--     begin
--       -- «Clasificar» del API 0.0.51 (CAS gasto_id IS NULL: un lote pasa el CAS)
--       update public.movimiento_bancario
--          set clasificacion_id = v_clasif, conciliado = true, updated_by = v_admin2
--        where id = k_lote and gasto_id is null and clasificacion_id is null;
--       set constraints all immediate;
--       raise exception 'DRYRUN_FALLA 10: el API viejo clasificó un lote';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'PARTES_INCOHERENTES: %' then raise exception 'DRYRUN_FALLA 10: clasificar %', v_txt; end if;
--     end;
--     set constraints all deferred;
--     begin
--       -- Clasificación SOLA, sin `conciliado` (SQL a mano o código futuro): K
--       -- vigila clasificacion_id ⇒ el commit la rechaza (revisión 2-oct, T1).
--       update public.movimiento_bancario set clasificacion_id = v_clasif where id = k_lote;
--       set constraints all immediate;
--       raise exception 'DRYRUN_FALLA 10: la clasificación sola sobre un lote pasó el commit';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_dettxt = pg_exception_detail;
--       if v_hint is distinct from 'PARTES_INCOHERENTES' or v_txt not like 'PARTES_INCOHERENTES: %'
--          or (v_dettxt::jsonb ->> 'motivo') not like 'tiene gastos ligados y además%' then
--         raise exception 'DRYRUN_FALLA 10: clasificación sola % / %', v_txt, v_dettxt;
--       end if;
--     end;
--     set constraints all deferred;
--     begin
--       -- Cobro SOLO sobre un lote: K vigila cobro_id ⇒ el commit lo rechaza.
--       update public.movimiento_bancario set cobro_id = v_cobro where id = k_lote;
--       set constraints all immediate;
--       raise exception 'DRYRUN_FALLA 10: el cobro solo sobre un lote pasó el commit';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_dettxt = pg_exception_detail;
--       if v_hint is distinct from 'PARTES_INCOHERENTES' or v_txt not like 'PARTES_INCOHERENTES: %'
--          or (v_dettxt::jsonb ->> 'motivo') not like 'tiene gastos ligados y además%' then
--         raise exception 'DRYRUN_FALLA 10: cobro solo % / %', v_txt, v_dettxt;
--       end if;
--     end;
--     set constraints all deferred;
--     update public.movimiento_bancario set notas = notas where id = k_lote;  -- lo que no toca la liga, pasa
--     if (select count(*) from public.movimiento_bancario_gasto where movimiento_id = k_lote) <> 3
--        or not exists (select 1 from public.movimiento_bancario where id = k_lote and gastos_n = 3
--                        and gasto_id is null and conciliado) then
--       raise exception 'DRYRUN_FALLA 10: las partes no quedaron intactas';
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (9a) REEMPLAZO dentro del lote: [#315, #319, #326] → [#315, #319, #236].
--     --      Las partes de ESTE cargo no cuentan en el faltante: #315 y #319 no
--     --      rebotan como «ya cubiertos» y NO se reescriben.
--     select p.ctid into v_ctid from public.movimiento_bancario_gasto p where p.movimiento_id = k_lote and p.gasto_id = g315;
--     select p.ctid into v_ctid2 from public.movimiento_bancario_gasto p where p.movimiento_id = k_lote and p.gasto_id = g319;
--     select count(*) into v_b0 from public.gasto_bitacora where gasto_id in (g315, g319);
--     v_res := public.conciliacion_ligar_cargo_gastos(k_lote, array[g315, g319, g236], v_admin);
--     if jsonb_array_length(v_res -> 'partes') <> 3 or jsonb_array_length(v_res -> 'anteriores') <> 3
--        or jsonb_array_length(v_res -> 'salientes') <> 1
--        or (v_res -> 'salientes' -> 0 ->> 'gasto_id')::uuid <> g326
--        or (select p.ctid from public.movimiento_bancario_gasto p where p.movimiento_id = k_lote and p.gasto_id = g315) is distinct from v_ctid
--        or (select p.ctid from public.movimiento_bancario_gasto p where p.movimiento_id = k_lote and p.gasto_id = g319) is distinct from v_ctid2
--        or (select count(*) from public.gasto_bitacora where gasto_id in (g315, g319)) <> v_b0
--        or (select conciliado from public.gasto where id = g326)
--        or not (select conciliado from public.gasto where id = g236)
--        or not exists (select 1 from public.movimiento_bancario where id = k_lote and gastos_n = 3 and conciliado) then
--       raise exception 'DRYRUN_FALLA 9a: reemplazo %', v_res;
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (7) H desliga el lote completo
--     v_res := public.conciliacion_desligar_cargo_gastos(k_lote, v_admin);
--     if jsonb_array_length(v_res -> 'salientes') <> 3
--        or exists (select 1 from public.movimiento_bancario_gasto where movimiento_id = k_lote)
--        or not exists (select 1 from public.movimiento_bancario where id = k_lote and gastos_n = 0
--                        and gasto_id is null and not conciliado)
--        or (select count(*) from public.gasto where id in (g315, g319, g236) and conciliado) <> 0 then
--       raise exception 'DRYRUN_FALLA 7: H %', v_res;
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (9b) Liga EXACTA 2,231.38 ↔ #321 y re-liga IDÉNTICA ⇒ no-op sin bitácora
--     v_res := public.conciliacion_ligar_cargo_gastos(k_2231, array[g321], v_admin);
--     if not (select conciliado from public.gasto where id = g321) then
--       raise exception 'DRYRUN_FALLA 9b: #321 no quedó cubierto';
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--     select p.ctid into v_ctid from public.movimiento_bancario_gasto p where p.movimiento_id = k_2231;
--     select m.ctid into v_ctid3 from public.movimiento_bancario m where m.id = k_2231;
--     select count(*) into v_b0 from public.gasto_bitacora where gasto_id = g321;
--     v_res := public.conciliacion_ligar_cargo_gastos(k_2231, array[g321], v_admin);
--     if jsonb_array_length(v_res -> 'salientes') <> 0 or jsonb_array_length(v_res -> 'anteriores') <> 1
--        or jsonb_array_length(v_res -> 'partes') <> 1
--        or (select count(*) from public.gasto_bitacora where gasto_id = g321) <> v_b0
--        or (select p.ctid from public.movimiento_bancario_gasto p where p.movimiento_id = k_2231) is distinct from v_ctid
--        or (select m.ctid from public.movimiento_bancario m where m.id = k_2231) is distinct from v_ctid3 then
--       raise exception 'DRYRUN_FALLA 9b: la re-liga idéntica escribió algo (%)', v_res;
--     end if;
--     -- Extras de G: 1 gasto que el cargo rebasa (texto de hoy, sin «MONEDA»),
--     -- MOVIMIENTO_CON_LOTE, LOTE_INVALIDO y GASTO_YA_CUBIERTO dentro de un lote.
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_4462b, array[g237], v_admin);
--       raise exception 'DRYRUN_FALLA 9b: 4,462.75 contra un gasto de 2,231.37';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_dettxt = pg_exception_detail;
--       if v_hint is distinct from 'GASTO_YA_CUBIERTO' or v_txt not like '%rebasan su monto%'
--          or v_txt like '%MONEDA%' or (v_dettxt::jsonb ->> 'motivo') <> 'GASTO_YA_CUBIERTO' then
--         raise exception 'DRYRUN_FALLA 9b: rebasa %', v_txt;
--       end if;
--     end;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_lote2, array[g236], v_admin);
--       raise exception 'DRYRUN_FALLA 9b: 1 gasto ajeno sobre un lote';
--     exception when check_violation then
--       get stacked diagnostics v_hint = pg_exception_hint, v_txt = message_text;
--       if v_hint is distinct from 'MOVIMIENTO_CON_LOTE' then raise exception 'DRYRUN_FALLA 9b: con lote %', v_txt; end if;
--     end;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_4462b, array[g237, g237], v_admin);
--       raise exception 'DRYRUN_FALLA 9b: aceptó repetidos';
--     exception when check_violation then
--       get stacked diagnostics v_hint = pg_exception_hint;
--       if v_hint is distinct from 'LOTE_INVALIDO' then raise exception 'DRYRUN_FALLA 9b: repetidos %', v_hint; end if;
--     end;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_4462b, '{}'::uuid[], v_admin);
--       raise exception 'DRYRUN_FALLA 9b: aceptó lista vacía';
--     exception when check_violation then
--       get stacked diagnostics v_hint = pg_exception_hint;
--       if v_hint is distinct from 'LOTE_INVALIDO' then raise exception 'DRYRUN_FALLA 9b: vacía %', v_hint; end if;
--     end;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_4462b, array[gen_random_uuid(), g237], v_admin);
--       raise exception 'DRYRUN_FALLA 9b: aceptó un gasto inexistente';
--     exception when check_violation then
--       get stacked diagnostics v_hint = pg_exception_hint;
--       if v_hint is distinct from 'LOTE_INVALIDO' then raise exception 'DRYRUN_FALLA 9b: inexistente %', v_hint; end if;
--     end;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_4462b, array[g321, g237], v_admin);
--       raise exception 'DRYRUN_FALLA 9b: metió en un lote un gasto ya cubierto';
--     exception when check_violation then
--       get stacked diagnostics v_hint = pg_exception_hint, v_txt = message_text;
--       if v_hint is distinct from 'GASTO_YA_CUBIERTO' or v_txt like '%MONEDA%' then
--         raise exception 'DRYRUN_FALLA 9b: cubierto %', v_txt;
--       end if;
--     end;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (11) 1↔1 CRUZADO REAL (gasto USD 794.61, cuenta MXN 14,197.17)
--     select tc_gasto into v_tc0 from public.gasto where id = g_usd;
--     v_res := public.conciliacion_desligar_cargo_gastos(k_cruz, v_admin);
--     if jsonb_array_length(v_res -> 'salientes') <> 1
--        or (v_res -> 'salientes' -> 0 ->> 'monto_parte')::numeric <> 14197.17
--        or v_res -> 'salientes' -> 0 ->> 'moneda' <> 'MXN'
--        or (select tc_gasto is not null or conciliado from public.gasto where id = g_usd) then
--       raise exception 'DRYRUN_FALLA 11: H no limpió el T.C. derivado (%)', v_res;
--     end if;
--     v_res := public.conciliacion_ligar_cargo_gastos(k_cruz, array[g_usd], v_admin);
--     if (v_res -> 'partes' -> 0 ->> 'moneda') <> 'MXN'
--        or (select tc_gasto from public.gasto where id = g_usd) is distinct from round(14197.17 / 794.61, 6)
--        or (select tc_gasto from public.gasto where id = g_usd) is distinct from v_tc0
--        or not (select conciliado from public.gasto where id = g_usd)
--        or not exists (select 1 from public.v_gasto_conciliacion where gasto_id = g_usd and cruzado
--                        and monto_vinculado = 794.61 and faltante = 0 and cubierto and n_partes = 1) then
--       raise exception 'DRYRUN_FALLA 11: G no derivó el T.C. (%)', v_res;
--     end if;
--     begin
--       v_res := public.conciliacion_ligar_cargo_gastos(k_7b, array[g_usd], v_admin);
--       raise exception 'DRYRUN_FALLA 11: un segundo cargo sobre un 1↔1 cruzado';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_dettxt = pg_exception_detail;
--       if v_hint is distinct from 'GASTO_YA_CUBIERTO' or v_txt not like '%MONEDA%'
--          or (v_dettxt::jsonb ->> 'motivo') <> 'MONEDA_DISTINTA' then
--         raise exception 'DRYRUN_FALLA 11: segundo %', v_txt;
--       end if;
--     end;
--     set constraints all immediate;
--     set constraints all deferred;
--     v_res := public.conciliacion_desligar_cargo_gastos(k_cruz, v_admin);
--     if (v_res -> 'salientes' -> 0 ->> 'monto_parte')::numeric <> 14197.17
--        or v_res -> 'salientes' -> 0 ->> 'moneda' <> 'MXN'
--        or (select tc_gasto is not null or conciliado from public.gasto where id = g_usd) then
--       raise exception 'DRYRUN_FALLA 11: el segundo H no limpió (%)', v_res;
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (12) Escrituras A MANO en la puente que dejan un cargo a medias ⇒
--     --      PARTES_INCOHERENTES al COMMIT (aquí: set constraints immediate).
--     begin
--       insert into public.movimiento_bancario_gasto (movimiento_id, gasto_id, monto_parte)
--       values (k_4462b, g237, 1000.00), (k_4462b, g247, 1000.00);
--       if not exists (select 1 from public.movimiento_bancario where id = k_4462b and gastos_n = 2 and conciliado) then
--         raise exception 'DRYRUN_FALLA 12: B no sincronizó el insert a mano';
--       end if;
--       set constraints all immediate;
--       raise exception 'DRYRUN_FALLA 12: 2 partes que no cuadran pasaron el commit';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--       if v_hint is distinct from 'PARTES_INCOHERENTES' or v_txt not like 'PARTES_INCOHERENTES: %' then
--         raise exception 'DRYRUN_FALLA 12: %', v_txt;
--       end if;
--     end;
--     set constraints all deferred;
--     begin
--       insert into public.movimiento_bancario_gasto (movimiento_id, gasto_id, monto_parte)
--       values (k_4462b, g237, 1000.00);
--       set constraints all immediate;
--       raise exception 'DRYRUN_FALLA 12: 1 parte que no vale el cargo pasó el commit';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'PARTES_INCOHERENTES: %' then raise exception 'DRYRUN_FALLA 12: 1 parte %', v_txt; end if;
--     end;
--     set constraints all deferred;
--     begin
--       delete from public.movimiento_bancario_gasto where movimiento_id = k_lote2 and gasto_id = g322;
--       set constraints all immediate;
--       raise exception 'DRYRUN_FALLA 12: borrar a mano una parte del lote pasó el commit';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'PARTES_INCOHERENTES: %' then raise exception 'DRYRUN_FALLA 12: delete %', v_txt; end if;
--     end;
--     set constraints all deferred;
--     if exists (select 1 from public.movimiento_bancario_gasto where movimiento_id = k_4462b)
--        or (select count(*) from public.movimiento_bancario_gasto where movimiento_id = k_lote2) <> 2
--        or not exists (select 1 from public.movimiento_bancario where id = k_4462b and gastos_n = 0 and not conciliado) then
--       raise exception 'DRYRUN_FALLA 12: el rechazo no revirtió';
--     end if;
--
--     -- (F) inventario_eliminar_movimiento: una parte PARCIAL (7.00 de 351.88,
--     --     gasto NO conciliado) bloquea el borrado del movimiento de cardex.
--     v_res := public.conciliacion_ligar_cargo_gastos(k_7a, array[g_bodega], v_admin);
--     if (select conciliado from public.gasto where id = g_bodega) then
--       raise exception 'DRYRUN_FALLA F: 7.00 cubrió un gasto de 351.88';
--     end if;
--     begin
--       v_res := public.inventario_eliminar_movimiento(k_inv_mov, k_inv_item, 'dry-run 2-oct: una parte parcial bloquea', v_admin);
--       raise exception 'DRYRUN_FALLA F: borró un movimiento con su gasto ligado a un cargo';
--     exception when raise_exception then
--       get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--       if v_hint is distinct from 'GASTO_BLOQUEADO' then raise exception 'DRYRUN_FALLA F: %', v_txt; end if;
--     end;
--     v_res := public.conciliacion_desligar_cargo_gastos(k_7a, v_admin);
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (13) Los ROLES: service_role ejecuta la RPC; anon no.
--     set local role service_role;
--     v_res := public.conciliacion_desligar_cargo_gastos(k_lote2, v_admin);
--     reset role;
--     if jsonb_array_length(v_res -> 'salientes') <> 2
--        or exists (select 1 from public.movimiento_bancario_gasto where movimiento_id = k_lote2) then
--       raise exception 'DRYRUN_FALLA 13: service_role %', v_res;
--     end if;
--     begin
--       set local role anon;
--       v_res := public.conciliacion_ligar_cargo_gastos(k_lote2, array[g318, g322], v_admin);
--       raise exception 'DRYRUN_FALLA 13: anon ejecutó la RPC';
--     exception when insufficient_privilege then
--       null;
--     end;
--     if current_user <> 'postgres' then
--       raise exception 'DRYRUN_FALLA 13: el rol no volvió (%)', current_user;
--     end if;
--     set constraints all immediate;
--     set constraints all deferred;
--
--     -- (R) ROLLBACK DE LA MIGRACIÓN, tal cual el pie del archivo.
--     --     R0: con un lote vivo el paso 0 aborta.
--     v_res := public.conciliacion_ligar_cargo_gastos(k_lote, array[g315, g319, g326], v_admin);
--     set constraints all immediate;
--     set constraints all deferred;
--     begin
--       -- (pegar aquí el PASO 0 del ROLLBACK del pie: el bloque do $rb$ … $rb$)
--       raise exception 'DRYRUN_FALLA R0: el rollback no se bloqueó con un lote vivo';
--     exception when raise_exception then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'ROLLBACK_BLOQUEADO: %' then raise exception 'DRYRUN_FALLA R0: %', v_txt; end if;
--     end;
--     v_res := public.conciliacion_desligar_cargo_gastos(k_lote, v_admin);
--     --     Rt: la TRAMPA del diferido. Con eventos de K pendientes (el desligue
--     --     de arriba), ALTER TABLE sobre movimiento_bancario falla con 55006.
--     begin
--       update public.movimiento_bancario set conciliado = conciliado where id = k_7a;
--       alter table public.movimiento_bancario add column x_dryrun_trampa integer;
--       raise exception 'DRYRUN_FALLA Rt: ALTER TABLE con eventos de K pendientes pasó (¿K dejó de ser diferido?)';
--     exception when object_in_use then
--       null;
--     end;
--     --     R1: el rollback completo en la MISMA transacción que acaba de
--     --     desligar el lote, SIN forzar antes los eventos de K: el
--     --     `set constraints all immediate` del pie (tras su `begin;`) es lo que
--     --     deja pasar sus ALTER TABLE.
--     -- (pegar aquí el ROLLBACK COMPLETO del pie —desde su `set constraints all immediate`—, sin begin/commit; el select pg_notify como perform)
--     if to_regclass('public.movimiento_bancario_gasto') is not null
--        or to_regclass('public.v_gasto_conciliacion') is not null
--        or exists (select 1 from information_schema.columns where table_schema = 'public'
--                    and table_name = 'movimiento_bancario' and column_name = 'gastos_n')
--        or exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--                    where n.nspname = 'public'
--                      and p.proname in ('vt_actor_id', 'tolerancia_lote', 'regla_gasto_cubierto',
--                                        'recalcular_gasto_conciliado', 'motivo_partes_incoherentes',
--                                        'tg_mov_gasto_parte_valida', 'tg_mov_gasto_parte_sync',
--                                        'tg_mov_bancario_gasto_id_sync', 'tg_mov_bancario_partes_coherentes',
--                                        'conciliacion_ligar_cargo_gastos', 'conciliacion_desligar_cargo_gastos'))
--        or (select count(*) from pg_trigger where tgrelid = 'public.movimiento_bancario'::regclass and not tgisinternal) <> 3 then
--       raise exception 'DRYRUN_FALLA R1: el rollback dejó objetos';
--     end if;
--     if (select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.movimiento_bancario'::regclass
--           and t.tgname = 'trg_mov_bancario_gasto_suma') is distinct from v_def_trg_d
--        or (select pg_get_triggerdef(t.oid) from pg_trigger t where t.tgrelid = 'public.movimiento_bancario'::regclass
--           and t.tgname = 'trg_mov_bancario_reverso') is distinct from v_def_trg_e
--        or (select pg_get_constraintdef(c.oid) from pg_constraint c where c.conrelid = 'public.movimiento_bancario'::regclass
--           and c.conname = 'movimiento_bancario_ingreso_excluyente_chk') is distinct from v_def_chk then
--       raise exception 'DRYRUN_FALLA R1: triggers/CHECK no volvieron a su definición original';
--     end if;
--     if regexp_replace(regexp_replace(pg_get_functiondef('public.tg_mov_bancario_gasto_suma()'::regprocedure),
--          '--[^' || chr(10) || ']*', '', 'g'), '\s+', '', 'g') is distinct from v_fn_d
--        or regexp_replace(regexp_replace(pg_get_functiondef('public.tg_mov_bancario_reverso()'::regprocedure),
--          '--[^' || chr(10) || ']*', '', 'g'), '\s+', '', 'g') is distinct from v_fn_e
--        or regexp_replace(regexp_replace(pg_get_functiondef('public.inventario_eliminar_movimiento(uuid,uuid,text,uuid)'::regprocedure),
--          '--[^' || chr(10) || ']*', '', 'g'), '\s+', '', 'g') is distinct from v_fn_f then
--       raise exception 'DRYRUN_FALLA R1: un cuerpo restaurado no es el original';
--     end if;
--     -- El modelo viejo funciona tras el rollback: liga legada + regla vieja.
--     update public.movimiento_bancario set gasto_id = g315, conciliado = true where id = k_1118b;
--     begin
--       update public.movimiento_bancario set gasto_id = g315, conciliado = true where id = k_2231;
--       raise exception 'DRYRUN_FALLA R1: la regla vieja no rechazó 1,118.12 + 2,231.38 sobre 2,801.40';
--     exception when check_violation then
--       get stacked diagnostics v_txt = message_text;
--       if v_txt not like 'GASTO_YA_CUBIERTO: %' then raise exception 'DRYRUN_FALLA R1: regla vieja %', v_txt; end if;
--     end;
--
--     raise exception 'DRYRUN_OK · huella % · ligas % = partes backfill % · reporte bandera≠regla: % · C0 estructura/permisos/backfill · 1 G simple · 2 espejo API 0.0.51 (liga, re-liga idéntica, desligue) · 3 lote SAESA 8,404.20 · 3b 4,462.75 dif 0.01 · 4 CARGO_NO_CUADRA · 5 LOTE_MONEDA_DISTINTA · 6 REVERSO_INVALIDO (G, A, legado, E) · 8 CARGO_LIGADO · 10 LOTE_SOLO_API_NUEVO · 9a reemplazo sin bitácora · 7 H lote · 9b re-liga idéntica no-op + extras · 11 1↔1 cruzado T.C. % · 12 PARTES_INCOHERENTES · F inventario GASTO_BLOQUEADO · 13 service_role sí/anon no · 10b clasificación sola y cobro solo ⇒ PARTES_INCOHERENTES · Rt DML+ALTER sin immediate ⇒ 55006 · R rollback (bloqueo con lote + set constraints del pie + restauración exacta) · todo se revierte',
--       v_huella, v_ligas0, v_partes_backfill, v_reporte, round(14197.17 / 794.61, 6);
--   end $dry$;

-- ===========================================================================
-- 0) ASERCIONES PREVIAS — abortan la migración ANTES de escribir nada.
--    La puente nace de `movimiento_bancario.gasto_id`; una liga fuera de
--    regla (no CARGO, con cobro/sobre/ingreso/clasificación, emparejada por
--    reverso o sin conciliar) se convertiría en una parte inválida.
--    (2-oct-2026: 0 en todas.)
-- ===========================================================================
do $pre$
declare
  v_no_cargo integer;
  v_otra_liga integer;
  v_reverso integer;
  v_sin_conciliar integer;
begin
  if to_regclass('public.movimiento_bancario_gasto') is not null then
    raise exception 'MIGRACION_ABORTADA: public.movimiento_bancario_gasto ya existe (¿migración 20261002000002 aplicada?)';
  end if;
  select count(*) filter (where m.tipo::text <> 'CARGO'),
         count(*) filter (where num_nonnulls(m.cobro_id, m.cobro_grupo_id,
                                             m.ingreso_id, m.clasificacion_id) > 0),
         count(*) filter (where m.reverso_de_id is not null
                             or exists (select 1 from public.movimiento_bancario r
                                         where r.reverso_de_id = m.id)),
         count(*) filter (where not m.conciliado)
    into v_no_cargo, v_otra_liga, v_reverso, v_sin_conciliar
    from public.movimiento_bancario m
   where m.gasto_id is not null;
  if v_no_cargo + v_otra_liga + v_reverso + v_sin_conciliar > 0 then
    raise exception 'MIGRACION_ABORTADA: ligas a gasto fuera de regla (no CARGO %, con cobro/sobre/ingreso/clasificación %, emparejadas por reverso %, sin conciliar %): corrígelas antes de aplicar',
      v_no_cargo, v_otra_liga, v_reverso, v_sin_conciliar;
  end if;
end $pre$;

-- ===========================================================================
-- 1) TABLA PUENTE = FUENTE ÚNICA de la liga cargo ↔ gasto
-- ===========================================================================
create table public.movimiento_bancario_gasto (
  movimiento_id uuid not null references public.movimiento_bancario(id) on delete cascade,
  gasto_id      uuid not null references public.gasto(id) on delete restrict,
  monto_parte   numeric(14,2) not null check (monto_parte > 0),
  moneda        public.moneda not null,
  created_at    timestamptz not null default now(),
  created_by    uuid references public.usuario(id) on delete set null,
  primary key (movimiento_id, gasto_id)
);

create index idx_mov_gasto_parte_gasto
  on public.movimiento_bancario_gasto (gasto_id);

comment on table public.movimiento_bancario_gasto is
  'Fuente ÚNICA de la liga cargo del banco ↔ gasto (2-oct-2026, migración 20261002000002). Una fila = la PARTE de un cargo que paga un gasto: 1 cargo ↔ N gastos (lote, p. ej. 1 SPEI que paga 3 «Pago VIP SAESA») y 1 gasto ↔ N cargos (pago parcial). movimiento_bancario.gasto_id y gastos_n son ESPEJOS derivados (los mantiene tg_mov_gasto_parte_sync). Se escribe SOLO por conciliacion_ligar_cargo_gastos / conciliacion_desligar_cargo_gastos (o el espejo legado tg_mov_bancario_gasto_id_sync). gasto ON DELETE RESTRICT: un gasto con partes no se borra.';
comment on column public.movimiento_bancario_gasto.monto_parte is
  'Lo que ESTE cargo aporta a ESE gasto, en la moneda de la CUENTA del cargo (= moneda del gasto salvo el caso 1↔1 cruzado USD↔MXN, donde es el importe en pesos del que se deriva gasto.tc_gasto y NO se compara con gasto.monto).';
comment on column public.movimiento_bancario_gasto.moneda is
  'Moneda de la CUENTA del cargo (la fija el trigger tg_mov_gasto_parte_valida; lo que mande el cliente se ignora). Parte CRUZADA = moneda::text <> gasto.moneda::text (solo 1↔1).';
comment on column public.movimiento_bancario_gasto.created_by is
  'Quién ligó la parte (p_actor de la RPC o updated_by del UPDATE legado). Respaldo del actor cuando no hay vt.actor_id.';

alter table public.movimiento_bancario_gasto enable row level security;

-- Misma regla que movimiento_bancario_read_active_user (lectura para
-- usuarios activos; el API escribe con service key y no necesita política).
create policy "movimiento_bancario_gasto_read_active_user"
  on public.movimiento_bancario_gasto for select using (
    exists (select 1 from public.usuario u
             where u.supabase_auth_id = (select auth.uid())
               and u.estado::text = 'ACTIVO')
  );

-- ===========================================================================
-- 2) ESPEJO `gastos_n` + CHECK de ingresos
-- ===========================================================================
alter table public.movimiento_bancario
  add column gastos_n integer not null default 0;

comment on column public.movimiento_bancario.gastos_n is
  'ESPEJO derivado: cuántos gastos paga este cargo (= filas en movimiento_bancario_gasto). gasto_id = el gasto cuando gastos_n = 1; NULL con 0 o ≥ 2 (lote). Ligado a gasto = gasto_id is not null or gastos_n > 0. Lo mantiene tg_mov_gasto_parte_sync; lo custodia trg_mov_bancario_partes_coherentes (diferido). 20261002000002.';

-- `ingreso_id` solo se escribe en ABONOS y un ABONO nunca tiene partes: el
-- `gastos_n = 0` no puede romper ninguna escritura vigente. NINGÚN otro CHECK
-- nombra `gastos_n` (los CHECK se evalúan ANTES de los AFTER triggers y el
-- desligue del API 0.0.51 —gasto_id = null + conciliado = false— chocaría).
alter table public.movimiento_bancario
  drop constraint movimiento_bancario_ingreso_excluyente_chk,
  add constraint movimiento_bancario_ingreso_excluyente_chk
    check (ingreso_id is null
           or (num_nonnulls(gasto_id, cobro_id, cobro_grupo_id, clasificacion_id) = 0
               and gastos_n = 0));

-- ===========================================================================
-- 3) BACKFILL — cada liga de hoy (gasto_id) pasa a ser UNA parte por |monto|.
--    Sin triggers nuevos todavía (se crean después) y sin mover updated_at:
--    el backfill no es un cambio de negocio. `gasto.conciliado` NO se toca
--    (el reporte del final lista los que difieren de la regla).
-- ===========================================================================
alter table public.movimiento_bancario disable trigger trg_movimiento_bancario_set_updated_at;

insert into public.movimiento_bancario_gasto
  (movimiento_id, gasto_id, monto_parte, moneda, created_at, created_by)
select m.id, m.gasto_id, abs(m.monto), c.moneda, m.updated_at, m.updated_by
  from public.movimiento_bancario m
  join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
 where m.gasto_id is not null;

update public.movimiento_bancario
   set gastos_n = 1
 where gasto_id is not null;

alter table public.movimiento_bancario enable trigger trg_movimiento_bancario_set_updated_at;

-- ===========================================================================
-- 4) FUNCIONES PURAS Y LA REGLA DE «CUBIERTO» (una sola expresión)
-- ===========================================================================

-- Actor de la transacción: lo fijan las RPC (p_actor) y el espejo legado
-- (updated_by del UPDATE) con set_config('vt.actor_id', …, true).
create or replace function public.vt_actor_id()
returns uuid
language plpgsql
stable
security definer
set search_path = ''
as $fn_actor$
declare
  v text := nullif(btrim(coalesce(current_setting('vt.actor_id', true), '')), '');
begin
  if v is not null
     and v ~* '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$' then
    return v::uuid;
  end if;
  return null;
end $fn_actor$;

comment on function public.vt_actor_id() is
  'Usuario que firma la escritura en curso: current_setting(''vt.actor_id'') si es un uuid válido; si no, NULL (20261002000002).';

-- Tolerancia del LOTE (N ≥ 2 partes en un cargo). Misma fórmula en el API
-- (conciliacion-parcial.util.ts#toleranciaLote) y en el panel
-- (lib/admin/conciliacion-lote.ts): N=2 ⇒ 0.02 · N=3 ⇒ 0.03 · N=29 ⇒ 0.29.
create or replace function public.tolerancia_lote(n integer)
returns numeric
language sql
immutable
security definer
set search_path = ''
as $fn_tol$
  select least(1.00::numeric, greatest(0.02::numeric, 0.01::numeric * coalesce(n, 0)));
$fn_tol$;

comment on function public.tolerancia_lote(integer) is
  'Tolerancia del lote: least(1.00, greatest(0.02, 0.01 × N)). Espejo exacto de toleranciaLote(n) del API y del panel (20261002000002).';

-- LA regla de «gasto cubierto» (= gasto.conciliado). CASE ORDENADO, una sola
-- vez en la BD: la usan v_gasto_conciliacion (⇒ recalcular_gasto_conciliado)
-- y el faltante del lote de conciliacion_ligar_cargo_gastos. Espejo del API:
-- estadoConciliacion + cubreGasto (tolerancia 1.00 por GASTO).
create or replace function public.regla_gasto_cubierto(
  p_monto numeric,
  p_n_partes integer,
  p_cruzado boolean,
  p_suma numeric
)
returns boolean
language sql
immutable
security definer
set search_path = ''
as $fn_regla$
  select case
           -- (1) parte en OTRA moneda (1↔1 USD↔MXN): cubre, de ahí sale el T.C.
           when coalesce(p_cruzado, false) then true
           -- (2) sin partes: no está conciliado
           when coalesce(p_n_partes, 0) = 0 then false
           -- (3) gasto de $0 con alguna parte: nunca «pendiente para siempre»
           when round(abs(coalesce(p_monto, 0)), 2) <= 0 then true
           -- (4) Σ partes de su moneda ≥ monto − 1.00
           else round(coalesce(p_suma, 0), 2) + 0.000001 >= round(abs(p_monto), 2) - 1.00
         end;
$fn_regla$;

comment on function public.regla_gasto_cubierto(numeric, integer, boolean, numeric) is
  'Regla única de gasto.conciliado (CASE ordenado): cruzada ⇒ true; sin partes ⇒ false; monto 0 ⇒ true; Σ no cruzadas + 1e-6 ≥ monto − 1.00. Espejo de cubreGasto/estadoConciliacion del API (20261002000002).';

-- Lectura canónica por gasto: la usan el API (sumasLigadasDe,
-- anexarConciliacionParcial, cargosBancariosDe, gastosDeMovimiento, el
-- endpoint de candidatos) y recalcular_gasto_conciliado. security_invoker:
-- respeta la RLS de quien la lee (el API la lee con service key).
create view public.v_gasto_conciliacion
with (security_invoker = true)
as
select g.id as gasto_id,
       s.n_partes,
       s.cruzado,
       s.suma,
       case when s.cruzado then g.monto else s.suma end as monto_vinculado,
       case when s.cruzado then 0::numeric
            else greatest(round(abs(round(g.monto, 2)) - s.suma, 2), 0::numeric)
       end as faltante,
       public.regla_gasto_cubierto(g.monto, s.n_partes, s.cruzado, s.suma) as cubierto
  from public.gasto g
  cross join lateral (
    select count(p.gasto_id)::integer as n_partes,
           coalesce(bool_or(p.moneda::text <> g.moneda::text), false) as cruzado,
           round(coalesce(sum(p.monto_parte) filter (where p.moneda::text = g.moneda::text), 0), 2) as suma
      from public.movimiento_bancario_gasto p
     where p.gasto_id = g.id
  ) s;

comment on view public.v_gasto_conciliacion is
  'Estado de conciliación de cada gasto desde la puente (20261002000002): n_partes, cruzado (alguna parte en otra moneda: 1↔1), suma (Σ partes de SU moneda), monto_vinculado (cruzado ⇒ gasto.monto), faltante (cruzado ⇒ 0; si no, faltanteDe) y cubierto (regla_gasto_cubierto = lo que vale gasto.conciliado).';

-- I) ÚNICO escritor de gasto.conciliado y del tc_gasto DERIVADO del banco.
create or replace function public.recalcular_gasto_conciliado(
  p_gasto_id uuid,
  p_actor uuid default null,
  p_monto_desligado numeric default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $fn_recalcular$
declare
  v_g record;
  v_e record;
  v_parte record;
  v_tc numeric;
  v_tc_implicito numeric;
begin
  -- `for update`: dos ligas simultáneas del mismo gasto se serializan.
  select g.id, g.monto, g.moneda::text as moneda, g.tc_gasto, g.conciliado
    into v_g
    from public.gasto g
   where g.id = p_gasto_id
     for update;
  if not found then
    return null;
  end if;

  select v.n_partes, v.cruzado, v.suma, v.cubierto
    into v_e
    from public.v_gasto_conciliacion v
   where v.gasto_id = p_gasto_id;

  v_tc := v_g.tc_gasto;
  if v_e.n_partes = 1 and v_e.cruzado
     and v_g.moneda = 'USD' and v_g.tc_gasto is null and v_g.monto > 0 then
    -- Compra en DÓLARES pagada con un cargo en PESOS: el estado de cuenta
    -- revela el T.C. real del banco (6 decimales, tc.util del API).
    select p.monto_parte, p.moneda::text as moneda
      into v_parte
      from public.movimiento_bancario_gasto p
     where p.gasto_id = p_gasto_id;
    if v_parte.moneda = 'MXN' then
      v_tc_implicito := v_parte.monto_parte / v_g.monto;
      if v_tc_implicito >= 15 and v_tc_implicito <= 25 then
        v_tc := round(v_tc_implicito, 6);
      end if;
    end if;
  elsif v_e.n_partes = 0
        and p_monto_desligado is not null
        and v_g.moneda = 'USD'
        and v_g.tc_gasto is not null
        and v_g.monto > 0
        and abs(v_g.tc_gasto - abs(p_monto_desligado) / v_g.monto) < 0.001 then
    -- Se soltó el cargo del que se DERIVÓ el T.C.: se limpia (un T.C.
    -- capturado a mano no coincide con ese cociente y se respeta).
    v_tc := null;
  end if;

  -- Solo si algo cambia: la bitácora del gasto no se llena de no-cambios.
  if v_e.cubierto is distinct from v_g.conciliado
     or v_tc is distinct from v_g.tc_gasto then
    update public.gasto
       set conciliado = v_e.cubierto,
           tc_gasto = v_tc,
           updated_by = coalesce(p_actor, public.vt_actor_id(), updated_by)
     where id = p_gasto_id;
  end if;
  return v_e.cubierto;
end $fn_recalcular$;

comment on function public.recalcular_gasto_conciliado(uuid, uuid, numeric) is
  'ÚNICO escritor de gasto.conciliado y del tc_gasto derivado del banco (20261002000002). conciliado = v_gasto_conciliacion.cubierto. T.C.: se DERIVA con exactamente 1 parte cruzada (gasto USD, cuenta MXN, tc_gasto null, cociente en [15, 25], 6 decimales) y se LIMPIA al quedar 0 partes si |tc_gasto − p_monto_desligado / monto| < 0.001. Escribe solo si algo cambia, con updated_by = coalesce(p_actor, vt_actor_id(), updated_by).';

-- ===========================================================================
-- 5) TRIGGERS DE LA PUENTE
-- ===========================================================================

-- A) Candado por FILA: cada parte se valida contra su cargo y su gasto con
--    los dos BLOQUEADOS (`for update`, primero el movimiento y luego el
--    gasto, el mismo orden que la RPC). Ve las filas que la MISMA sentencia
--    ya procesó (función VOLATILE): un INSERT de N partes se valida
--    acumulado. Fija `moneda` desde la cuenta del cargo.
create or replace function public.tg_mov_gasto_parte_valida()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_parte_valida$
declare
  v_mov record;
  v_moneda_cuenta text;
  v_monto_gasto numeric;
  v_moneda_gasto text;
  v_cruzada boolean;
  v_devolucion uuid;
  v_old_mov uuid;
  v_old_gasto uuid;
  v_g_n integer := 0;
  v_g_cruzadas integer := 0;
  v_g_suma numeric := 0;
  v_m_n integer := 0;
  v_m_suma numeric := 0;
  v_m_cruzado uuid;
  v_m_cruzado_moneda text;
begin
  if tg_op = 'UPDATE' then
    v_old_mov := old.movimiento_id;
    v_old_gasto := old.gasto_id;
  end if;

  select m.id, m.tipo::text as tipo, m.monto, m.cuenta_bancaria_id,
         m.cobro_id, m.cobro_grupo_id, m.ingreso_id, m.reverso_de_id
    into v_mov
    from public.movimiento_bancario m
   where m.id = new.movimiento_id
     for update;
  if not found then
    -- Movimiento inexistente: lo rechaza la FK, no este trigger.
    return new;
  end if;
  select c.moneda::text
    into v_moneda_cuenta
    from public.cuenta_bancaria c
   where c.id = v_mov.cuenta_bancaria_id;
  new.moneda := v_moneda_cuenta::public.moneda;

  -- UPDATE que no cambia nada de la parte: nada que revalidar.
  if tg_op = 'UPDATE'
     and new.movimiento_id = old.movimiento_id
     and new.gasto_id = old.gasto_id
     and new.monto_parte = old.monto_parte
     and new.moneda::text = old.moneda::text then
    return new;
  end if;

  if v_mov.tipo <> 'CARGO' then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: solo un CARGO del banco se concilia con gastos (este movimiento es un %s)', v_mov.tipo),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'tipo', v_mov.tipo)::text;
  end if;
  if v_mov.cobro_id is not null or v_mov.cobro_grupo_id is not null
     or v_mov.ingreso_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_YA_LIGADO',
      message = 'MOVIMIENTO_YA_LIGADO: el movimiento ya está conciliado con un cobro, un sobre de grupo o un ingreso; desvincúlalo antes de ligarle gastos',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'cobro_id', v_mov.cobro_id,
                                  'cobro_grupo_id', v_mov.cobro_grupo_id,
                                  'ingreso_id', v_mov.ingreso_id)::text;
  end if;
  if v_mov.reverso_de_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'REVERSO_INVALIDO',
      message = 'REVERSO_INVALIDO: este movimiento es la devolución de un cargo: no se liga a gastos',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'reverso_de_id', v_mov.reverso_de_id)::text;
  end if;
  select r.id into v_devolucion
    from public.movimiento_bancario r
   where r.reverso_de_id = v_mov.id
   limit 1;
  if v_devolucion is not null then
    raise exception using
      errcode = '23514',
      hint = 'REVERSO_INVALIDO',
      message = format('REVERSO_INVALIDO: este cargo está emparejado con su devolución (abono %s): quita el emparejamiento antes de ligarle gastos', v_devolucion),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'devolucion_id', v_devolucion)::text;
  end if;

  select g.monto, g.moneda::text
    into v_monto_gasto, v_moneda_gasto
    from public.gasto g
   where g.id = new.gasto_id
     for update;
  if not found then
    -- Gasto inexistente: lo rechaza la FK.
    return new;
  end if;
  v_cruzada := new.moneda::text <> v_moneda_gasto;

  -- OTRAS partes del gasto (sin esta llave ni la vieja de un UPDATE).
  select count(*),
         count(*) filter (where p.moneda::text <> v_moneda_gasto),
         coalesce(sum(p.monto_parte) filter (where p.moneda::text = v_moneda_gasto), 0)
    into v_g_n, v_g_cruzadas, v_g_suma
    from public.movimiento_bancario_gasto p
   where p.gasto_id = new.gasto_id
     and (p.movimiento_id, p.gasto_id) <> (new.movimiento_id, new.gasto_id)
     and (p.movimiento_id, p.gasto_id) is distinct from (v_old_mov, v_old_gasto);

  -- OTRAS partes del cargo.
  select count(*), coalesce(sum(p.monto_parte), 0)
    into v_m_n, v_m_suma
    from public.movimiento_bancario_gasto p
   where p.movimiento_id = new.movimiento_id
     and (p.movimiento_id, p.gasto_id) <> (new.movimiento_id, new.gasto_id)
     and (p.movimiento_id, p.gasto_id) is distinct from (v_old_mov, v_old_gasto);
  select p.gasto_id, g.moneda::text
    into v_m_cruzado, v_m_cruzado_moneda
    from public.movimiento_bancario_gasto p
    join public.gasto g on g.id = p.gasto_id
   where p.movimiento_id = new.movimiento_id
     and p.moneda::text <> g.moneda::text
     and (p.movimiento_id, p.gasto_id) <> (new.movimiento_id, new.gasto_id)
     and (p.movimiento_id, p.gasto_id) is distinct from (v_old_mov, v_old_gasto)
   limit 1;

  -- Reglas por GASTO (textos de tg_mov_bancario_gasto_suma, 15-sep-2026).
  if v_cruzada then
    -- Parte en OTRA moneda: solo 1↔1 (única del gasto Y única del cargo).
    if v_g_n > 0 then
      raise exception using
        errcode = '23514',
        hint = 'GASTO_YA_CUBIERTO',
        message = format('GASTO_YA_CUBIERTO: el gasto %s (%s) ya tiene %s cargo(s) ligado(s); un cargo en otra MONEDA (%s) solo se concilia 1 a 1',
                         new.gasto_id, v_moneda_gasto, v_g_n, v_moneda_cuenta),
        detail = jsonb_build_object('motivo', 'MONEDA_DISTINTA', 'gasto_id', new.gasto_id,
                                    'movimiento_id', new.movimiento_id,
                                    'moneda', v_moneda_gasto, 'moneda_cuenta', v_moneda_cuenta,
                                    'monto_gasto', round(v_monto_gasto, 2),
                                    'suma_ligada', round(v_g_suma, 2),
                                    'monto_nuevo', round(new.monto_parte, 2),
                                    'partes_otras', v_g_n)::text;
    end if;
    if v_m_n > 0 then
      raise exception using
        errcode = '23514',
        hint = 'LOTE_MONEDA_DISTINTA',
        message = format('LOTE_MONEDA_DISTINTA: el gasto %s está en %s y la cuenta en %s',
                         new.gasto_id, v_moneda_gasto, v_moneda_cuenta),
        detail = jsonb_build_object('gasto_id', new.gasto_id, 'movimiento_id', new.movimiento_id,
                                    'moneda_gasto', v_moneda_gasto,
                                    'moneda_cuenta', v_moneda_cuenta)::text;
    end if;
  else
    if v_g_cruzadas > 0 then
      raise exception using
        errcode = '23514',
        hint = 'GASTO_YA_CUBIERTO',
        message = format('GASTO_YA_CUBIERTO: el gasto %s ya está conciliado contra un cargo de otra MONEDA (1 a 1)',
                         new.gasto_id),
        detail = jsonb_build_object('motivo', 'MONEDA_DISTINTA', 'gasto_id', new.gasto_id,
                                    'movimiento_id', new.movimiento_id,
                                    'moneda', v_moneda_gasto, 'moneda_cuenta', v_moneda_cuenta,
                                    'monto_gasto', round(v_monto_gasto, 2),
                                    'suma_ligada', round(v_g_suma, 2),
                                    'monto_nuevo', round(new.monto_parte, 2),
                                    'partes_otras', v_g_n)::text;
    end if;
    if v_m_cruzado is not null then
      raise exception using
        errcode = '23514',
        hint = 'LOTE_MONEDA_DISTINTA',
        message = format('LOTE_MONEDA_DISTINTA: el gasto %s está en %s y la cuenta en %s',
                         v_m_cruzado, v_m_cruzado_moneda, v_moneda_cuenta),
        detail = jsonb_build_object('gasto_id', v_m_cruzado, 'movimiento_id', new.movimiento_id,
                                    'moneda_gasto', v_m_cruzado_moneda,
                                    'moneda_cuenta', v_moneda_cuenta)::text;
    end if;
    -- Misma moneda: Σ partes ≤ monto del gasto + 1.00 (también rechaza el
    -- PRIMER cargo que él solo rebasa el ticket: regla de hoy).
    if v_g_suma + new.monto_parte > abs(v_monto_gasto) + 1.00 + 0.000001 then
      raise exception using
        errcode = '23514',
        hint = 'GASTO_YA_CUBIERTO',
        message = format('GASTO_YA_CUBIERTO: los cargos ligados al gasto %s suman %s y con este (%s) rebasan su monto (%s)',
                         new.gasto_id, round(v_g_suma, 2), round(new.monto_parte, 2),
                         round(abs(v_monto_gasto), 2)),
        detail = jsonb_build_object('motivo', 'GASTO_YA_CUBIERTO', 'gasto_id', new.gasto_id,
                                    'movimiento_id', new.movimiento_id,
                                    'moneda', v_moneda_gasto, 'moneda_cuenta', v_moneda_cuenta,
                                    'monto_gasto', round(abs(v_monto_gasto), 2),
                                    'suma_ligada', round(v_g_suma, 2),
                                    'monto_nuevo', round(new.monto_parte, 2),
                                    'partes_otras', v_g_n)::text;
    end if;
  end if;

  -- Regla por CARGO: Σ partes ≤ |monto| + 1.00.
  if v_m_suma + new.monto_parte > abs(v_mov.monto) + 1.00 + 0.000001 then
    raise exception using
      errcode = '23514',
      hint = 'CARGO_EXCEDIDO',
      message = format('CARGO_EXCEDIDO: las partes del cargo %s suman %s y con esta (%s) rebasan su monto (%s)',
                       new.movimiento_id, round(v_m_suma, 2), round(new.monto_parte, 2),
                       round(abs(v_mov.monto), 2)),
      detail = jsonb_build_object('movimiento_id', new.movimiento_id, 'gasto_id', new.gasto_id,
                                  'monto_cargo', round(abs(v_mov.monto), 2),
                                  'suma_partes', round(v_m_suma, 2),
                                  'monto_parte', round(new.monto_parte, 2),
                                  'moneda', v_moneda_cuenta, 'partes_otras', v_m_n)::text;
  end if;

  return new;
end $fn_parte_valida$;

comment on function public.tg_mov_gasto_parte_valida() is
  'Trigger A (BEFORE INSERT/UPDATE en movimiento_bancario_gasto, 20261002000002): fija moneda desde la cuenta; for update movimiento → gasto; solo CARGO (LOTE_INVALIDO), sin cobro/sobre/ingreso (MOVIMIENTO_YA_LIGADO), sin reverso (REVERSO_INVALIDO); por gasto: cruzada solo 1↔1 y Σ ≤ monto + 1.00 (GASTO_YA_CUBIERTO, textos de hoy; LOTE_MONEDA_DISTINTA); por cargo Σ ≤ |monto| + 1.00 (CARGO_EXCEDIDO). 23514 + hint = código + detail jsonb.';

drop trigger if exists trg_mov_gasto_parte_valida on public.movimiento_bancario_gasto;
create trigger trg_mov_gasto_parte_valida
  before insert or update on public.movimiento_bancario_gasto
  for each row execute function public.tg_mov_gasto_parte_valida();

-- B) Sincronía por SENTENCIA: tras cualquier cambio en la puente recalcula
--    los espejos del cargo (gastos_n, gasto_id, conciliado, clasificación)
--    y la bandera de cada gasto tocado. Las tablas de transición solo
--    existen para su evento (INSERT ⇒ ins; DELETE ⇒ del; UPDATE ⇒ ambas).
create or replace function public.tg_mov_gasto_parte_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_parte_sync$
declare
  v_ctx uuid := public.vt_actor_id();
  v_filas jsonb := '[]'::jsonb;
  r record;
begin
  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'm', i.movimiento_id, 'g', i.gasto_id, 'monto', i.monto_parte,
             'por', i.created_by, 'lado', 'I')), '[]'::jsonb)
      into v_filas
      from ins i;
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(jsonb_build_object(
             'm', d.movimiento_id, 'g', d.gasto_id, 'monto', d.monto_parte,
             'por', d.created_by, 'lado', 'D')), '[]'::jsonb)
      into v_filas
      from del d;
  else
    select coalesce(jsonb_agg(t.fila), '[]'::jsonb)
      into v_filas
      from (
        select jsonb_build_object('m', i.movimiento_id, 'g', i.gasto_id, 'monto', i.monto_parte,
                                  'por', i.created_by, 'lado', 'I') as fila
          from ins i
        union all
        select jsonb_build_object('m', d.movimiento_id, 'g', d.gasto_id, 'monto', d.monto_parte,
                                  'por', d.created_by, 'lado', 'D')
          from del d
      ) t;
  end if;

  if jsonb_array_length(v_filas) = 0 then
    return null;
  end if;

  -- Espejos del CARGO: UN update por movimiento. Si el movimiento ya no
  -- existe (borrado en cascada) afecta 0 filas y no es error. `updated_by`
  -- NUNCA se pisa con NULL.
  update public.movimiento_bancario mb
     set gastos_n = s.n,
         gasto_id = case when s.n = 1 then s.unico else null end,
         conciliado = (s.n > 0
                       or mb.cobro_id is not null
                       or mb.cobro_grupo_id is not null
                       or mb.ingreso_id is not null
                       or mb.clasificacion_id is not null
                       or mb.reverso_de_id is not null),
         clasificacion_id = case when s.n > 0 then null else mb.clasificacion_id end,
         updated_by = coalesce(s.actor, mb.updated_by)
    from (
      select x.m,
             coalesce(v_ctx,
                      (array_agg(x.por order by x.lado desc) filter (where x.por is not null))[1]) as actor,
             (select count(*)::integer
                from public.movimiento_bancario_gasto p
               where p.movimiento_id = x.m) as n,
             (select (array_agg(p.gasto_id))[1]
                from public.movimiento_bancario_gasto p
               where p.movimiento_id = x.m) as unico
        from jsonb_to_recordset(v_filas) as x(m uuid, g uuid, monto numeric, por uuid, lado text)
       group by x.m
    ) s
   where mb.id = s.m;

  -- Bandera (y T.C. derivado) de cada GASTO tocado, en orden estable de id.
  -- `p_monto_desligado` = la parte soltada cuando el gasto SOLO aparece del
  -- lado borrado (y en una sola fila: la parte cruzada es 1↔1).
  for r in
    select x.g,
           coalesce(v_ctx,
                    (array_agg(x.por order by x.lado desc) filter (where x.por is not null))[1]) as actor,
           bool_or(x.lado = 'I') as en_ins,
           count(*) filter (where x.lado = 'D') as n_del,
           max(x.monto) filter (where x.lado = 'D') as monto_del
      from jsonb_to_recordset(v_filas) as x(m uuid, g uuid, monto numeric, por uuid, lado text)
     group by x.g
     order by x.g
  loop
    perform public.recalcular_gasto_conciliado(
      r.g,
      r.actor,
      case when not r.en_ins and r.n_del = 1 then r.monto_del end
    );
  end loop;

  return null;
end $fn_parte_sync$;

comment on function public.tg_mov_gasto_parte_sync() is
  'Trigger B (AFTER INSERT/UPDATE/DELETE por SENTENCIA en movimiento_bancario_gasto, tablas de transición ins/del, 20261002000002): por cada cargo tocado UN update de gastos_n, gasto_id (la única parte o NULL), conciliado, clasificacion_id (NULL con partes) y updated_by = coalesce(vt_actor_id() o created_by de la parte, updated_by); por cada gasto tocado recalcular_gasto_conciliado (con la parte soltada como p_monto_desligado).';

-- Postgres NO admite tablas de transición en un trigger de varios eventos
-- («transition tables cannot be specified for triggers with more than one
-- event»): B son TRES triggers por sentencia —uno por evento— sobre la MISMA
-- función, que distingue por TG_OP qué tabla de transición existe.
drop trigger if exists trg_mov_gasto_parte_sync_ins on public.movimiento_bancario_gasto;
create trigger trg_mov_gasto_parte_sync_ins
  after insert on public.movimiento_bancario_gasto
  referencing new table as ins
  for each statement execute function public.tg_mov_gasto_parte_sync();
drop trigger if exists trg_mov_gasto_parte_sync_upd on public.movimiento_bancario_gasto;
create trigger trg_mov_gasto_parte_sync_upd
  after update on public.movimiento_bancario_gasto
  referencing new table as ins old table as del
  for each statement execute function public.tg_mov_gasto_parte_sync();
drop trigger if exists trg_mov_gasto_parte_sync_del on public.movimiento_bancario_gasto;
create trigger trg_mov_gasto_parte_sync_del
  after delete on public.movimiento_bancario_gasto
  referencing old table as del
  for each statement execute function public.tg_mov_gasto_parte_sync();

-- ===========================================================================
-- 6) TRIGGERS DE movimiento_bancario
-- ===========================================================================

-- C) ESPEJO LEGADO: el API 0.0.51 (y cualquier SQL a mano) escribe
--    `movimiento_bancario.gasto_id` directo. Este trigger lo traduce a la
--    puente para que la fuente única nunca se desfase. Solo actúa ante una
--    escritura DIRECTA: el WHEN se evalúa con la profundidad de la sentencia
--    que escribe (0 = sentencia del API o de una función llamada por él);
--    las escrituras de los espejos que hace B ocurren DENTRO de un trigger
--    (profundidad ≥ 1) y no lo disparan. La guarda del cuerpo
--    (pg_trigger_depth() > 1 ⇒ nada) es la misma regla vista desde dentro.
create or replace function public.tg_mov_bancario_gasto_id_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_gasto_id_sync$
declare
  v_n integer;
  v_coincide boolean;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  -- Un LOTE (2+ gastos) no se desliga ni se cambia con el espejo: el API
  -- viejo no sabe de partes y dejaría el cargo «a medias».
  if tg_op = 'UPDATE' then
    if old.gastos_n >= 2 then
      raise exception using
        errcode = '23514',
        hint = 'LOTE_SOLO_API_NUEVO',
        message = format('LOTE_SOLO_API_NUEVO: este cargo paga %s gastos; desligarlo o cambiarlo exige la conciliación actualizada', old.gastos_n),
        detail = jsonb_build_object('movimiento_id', new.id, 'gastos_n', old.gastos_n,
                                    'gasto_id_pedido', new.gasto_id)::text;
    end if;
    if new.gasto_id is not distinct from old.gasto_id then
      return null;
    end if;
  end if;
  -- ¿La puente ya refleja el espejo? (re-ligar idempotente, o lo escribió B)
  select count(*)::integer, coalesce(bool_and(p.gasto_id = new.gasto_id), false)
    into v_n, v_coincide
    from public.movimiento_bancario_gasto p
   where p.movimiento_id = new.id;
  if (new.gasto_id is null and v_n = 0)
     or (new.gasto_id is not null and v_n = 1 and v_coincide) then
    return null;
  end if;
  perform set_config('vt.actor_id', coalesce(new.updated_by::text, ''), true);
  delete from public.movimiento_bancario_gasto where movimiento_id = new.id;
  if new.gasto_id is not null then
    insert into public.movimiento_bancario_gasto (movimiento_id, gasto_id, monto_parte, created_by)
    values (new.id, new.gasto_id, abs(new.monto), new.updated_by);
  end if;
  return null;
end $fn_gasto_id_sync$;

comment on function public.tg_mov_bancario_gasto_id_sync() is
  'Trigger C (AFTER INSERT/UPDATE OF gasto_id en movimiento_bancario, solo escritura DIRECTA, 20261002000002): traduce el espejo legado gasto_id a la puente (borra las partes y crea UNA por |monto| con created_by = updated_by). Lote (gastos_n ≥ 2) ⇒ LOTE_SOLO_API_NUEVO. Mantiene coherente la conciliación con el API 0.0.51 en la ventana de deploy.';

drop trigger if exists trg_mov_bancario_gasto_id_sync on public.movimiento_bancario;
create trigger trg_mov_bancario_gasto_id_sync
  after insert or update of gasto_id on public.movimiento_bancario
  for each row
  when (pg_trigger_depth() = 0)
  execute function public.tg_mov_bancario_gasto_id_sync();

-- D) REESCRITO (mismo nombre): la regla de la suma vive ahora en A. Aquí
--    queda el candado del CARGO: con gastos ligados no cambia su monto ni su
--    cuenta (de ella sale la moneda de las partes).
create or replace function public.tg_mov_bancario_gasto_suma()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
begin
  if (new.gastos_n > 0 or old.gastos_n > 0)
     and (new.monto is distinct from old.monto
          or new.cuenta_bancaria_id is distinct from old.cuenta_bancaria_id) then
    raise exception using
      errcode = '23514',
      hint = 'CARGO_LIGADO',
      message = format('CARGO_LIGADO: el cargo %s tiene %s gasto(s) ligado(s); desvincúlalos antes de cambiar su monto o su cuenta',
                       new.id, greatest(new.gastos_n, old.gastos_n)),
      detail = jsonb_build_object('movimiento_id', new.id,
                                  'gastos_n', greatest(new.gastos_n, old.gastos_n),
                                  'monto_actual', old.monto, 'monto_nuevo', new.monto,
                                  'cuenta_actual', old.cuenta_bancaria_id,
                                  'cuenta_nueva', new.cuenta_bancaria_id)::text;
  end if;
  return new;
end $function$;

comment on function public.tg_mov_bancario_gasto_suma() is
  'Trigger D (BEFORE UPDATE OF monto, cuenta_bancaria_id, 20261002000002): un cargo con gastos ligados (gastos_n > 0) no cambia su monto ni su cuenta ⇒ 23514 CARGO_LIGADO. La regla 1 gasto ↔ N cargos (suma ≤ monto + 1.00, moneda distinta 1↔1) pasó a tg_mov_gasto_parte_valida.';

drop trigger if exists trg_mov_bancario_gasto_suma on public.movimiento_bancario;
create trigger trg_mov_bancario_gasto_suma
  before update of monto, cuenta_bancaria_id
  on public.movimiento_bancario
  for each row execute function public.tg_mov_bancario_gasto_suma();

-- E) REESCRITO: el par cargo devuelto ↔ devolución mira también el LOTE
--    (`gasto_id is not null or gastos_n > 0`); `gastos_n` entra al UPDATE OF
--    y el lado CARGO rechaza que le crezcan partes mientras esté emparejado.
create or replace function public.tg_mov_bancario_reverso()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $function$
declare
  v_cargo record;
  v_otro uuid;
begin
  -- (1) LADO ABONO: la fila apunta al cargo que devuelve.
  if new.reverso_de_id is not null then
    if tg_op = 'UPDATE'
       and new.reverso_de_id is not distinct from old.reverso_de_id
       and new.tipo is not distinct from old.tipo
       and new.monto is not distinct from old.monto
       and new.cuenta_bancaria_id is not distinct from old.cuenta_bancaria_id
       and new.gasto_id is not distinct from old.gasto_id
       and new.gastos_n is not distinct from old.gastos_n
       and new.cobro_id is not distinct from old.cobro_id
       and new.cobro_grupo_id is not distinct from old.cobro_grupo_id
       and new.ingreso_id is not distinct from old.ingreso_id then
      -- Nada que decida el par cambió (notas, clasificación, flags).
      null;
    else
      if new.reverso_de_id = new.id then
        raise exception 'REVERSO_INVALIDO: un movimiento no puede ser su propia devolución'
          using errcode = '23514';
      end if;
      if new.tipo::text <> 'ABONO' then
        raise exception 'REVERSO_INVALIDO: solo un ABONO puede ser la devolución de un cargo (este movimiento es un %)',
          new.tipo::text
          using errcode = '23514';
      end if;
      if new.gasto_id is not null or new.gastos_n > 0 or new.cobro_id is not null
         or new.cobro_grupo_id is not null or new.ingreso_id is not null then
        raise exception 'REVERSO_INVALIDO: el abono ya está conciliado con un gasto, cobro o ingreso'
          using errcode = '23514';
      end if;
      -- `for update`: un emparejado y una liga (o dos emparejados) del
      -- mismo cargo se serializan y el segundo ve al primero.
      select m.id, m.tipo::text as tipo, m.cuenta_bancaria_id, m.monto,
             m.gasto_id, m.gastos_n, m.cobro_id, m.cobro_grupo_id, m.ingreso_id,
             m.reverso_de_id
        into v_cargo
        from public.movimiento_bancario m
       where m.id = new.reverso_de_id
         for update;
      if not found then
        -- Cargo inexistente: lo rechaza la FK, no este trigger.
        return new;
      end if;
      if v_cargo.tipo <> 'CARGO' then
        raise exception 'REVERSO_INVALIDO: el movimiento devuelto debe ser un CARGO (es un %)',
          v_cargo.tipo
          using errcode = '23514';
      end if;
      if v_cargo.cuenta_bancaria_id <> new.cuenta_bancaria_id then
        raise exception 'REVERSO_INVALIDO: el cargo y su devolución deben ser de la misma cuenta bancaria'
          using errcode = '23514';
      end if;
      if abs(abs(v_cargo.monto) - abs(new.monto)) > 0.005 then
        raise exception 'REVERSO_INVALIDO: los montos no coinciden (cargo %, devolución %)',
          round(v_cargo.monto, 2), round(new.monto, 2)
          using errcode = '23514';
      end if;
      if v_cargo.gasto_id is not null or v_cargo.gastos_n > 0 or v_cargo.cobro_id is not null
         or v_cargo.cobro_grupo_id is not null or v_cargo.ingreso_id is not null then
        raise exception 'REVERSO_INVALIDO: el cargo ya está conciliado con un gasto, cobro o ingreso'
          using errcode = '23514';
      end if;
      if v_cargo.reverso_de_id is not null then
        raise exception 'REVERSO_INVALIDO: el cargo no puede ser a su vez una devolución'
          using errcode = '23514';
      end if;
      select m.id into v_otro
        from public.movimiento_bancario m
       where m.reverso_de_id = new.reverso_de_id
         and m.id <> new.id
       limit 1;
      if v_otro is not null then
        raise exception 'REVERSO_INVALIDO: ese cargo ya tiene su devolución emparejada (abono %)',
          v_otro
          using errcode = '23514';
      end if;
    end if;
  end if;

  -- (2) LADO CARGO: la fila es el cargo devuelto de alguna devolución.
  if tg_op = 'UPDATE'
     and (new.tipo is distinct from old.tipo
          or new.monto is distinct from old.monto
          or new.cuenta_bancaria_id is distinct from old.cuenta_bancaria_id
          or new.gasto_id is distinct from old.gasto_id
          or new.gastos_n > old.gastos_n
          or new.cobro_id is distinct from old.cobro_id
          or new.cobro_grupo_id is distinct from old.cobro_grupo_id
          or new.ingreso_id is distinct from old.ingreso_id) then
    select m.id into v_otro
      from public.movimiento_bancario m
     where m.reverso_de_id = new.id
       and m.id <> new.id
     limit 1;
    if v_otro is not null then
      raise exception 'REVERSO_INVALIDO: este cargo está emparejado con su devolución (abono %): quita el emparejamiento antes de cambiarle la liga, el monto, el tipo o la cuenta',
        v_otro
        using errcode = '23514';
    end if;
  end if;

  return new;
end;
$function$;

comment on function public.tg_mov_bancario_reverso() is
  'Candado del par cargo devuelto ↔ devolución (movimiento_bancario.reverso_de_id, 30-sep-2026; lote 20261002000002: ligado a gasto = gasto_id is not null or gastos_n > 0). 23514 con prefijo REVERSO_INVALIDO ⇒ el API responde 409. Espejo: reverso-cruce.util#motivoParInvalido.';

drop trigger if exists trg_mov_bancario_reverso on public.movimiento_bancario;
create trigger trg_mov_bancario_reverso
  before insert or update of reverso_de_id, tipo, monto, cuenta_bancaria_id,
    gasto_id, cobro_id, cobro_grupo_id, ingreso_id, gastos_n
  on public.movimiento_bancario
  for each row execute function public.tg_mov_bancario_reverso();

-- K) COHERENCIA de los espejos, como CONSTRAINT TRIGGER DIFERIDO: se evalúa
--    al COMMIT (o con `set constraints … immediate`), cuando B ya dejó todo
--    en su lugar. Re-lee la fila por id (varias escrituras del mismo cargo en
--    una transacción ⇒ se juzga el estado FINAL). Así ningún INSERT/DELETE a
--    mano en la puente deja un «cargo parcial».
--    El `update of` del trigger lista TODAS las columnas que juzga
--    motivo_partes_incoherentes: los espejos (gastos_n, gasto_id,
--    conciliado), el monto y las OTRAS ligas (clasificacion_id, cobro_id,
--    cobro_grupo_id, ingreso_id). Una columna que la regla lea y el trigger
--    no vigile es un hueco: en la revisión del 2-oct, un UPDATE que solo
--    ponía clasificacion_id sobre un lote pasaba el commit en silencio.
--    Columna nueva en la regla ⇒ columna nueva en el `update of`.
--    TRAMPA OPERATIVA (por ser diferido): una transacción que escribe en
--    movimiento_bancario y DESPUÉS hace ALTER TABLE sobre ella falla con
--    55006 «cannot ALTER TABLE … because it has pending trigger events»;
--    corre `set constraints all immediate;` antes del ALTER (el ROLLBACK del
--    pie ya lo hace).
create or replace function public.motivo_partes_incoherentes(p_movimiento_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn_motivo$
declare
  v record;
  v_n integer;
  v_suma numeric;
  v_unico uuid;
  v_parte numeric;
begin
  select m.monto, m.gastos_n, m.gasto_id, m.conciliado,
         num_nonnulls(m.clasificacion_id, m.cobro_id, m.cobro_grupo_id, m.ingreso_id) as otras_ligas
    into v
    from public.movimiento_bancario m
   where m.id = p_movimiento_id;
  if not found then
    return null;
  end if;
  select count(*)::integer, coalesce(sum(p.monto_parte), 0),
         (array_agg(p.gasto_id))[1], (array_agg(p.monto_parte))[1]
    into v_n, v_suma, v_unico, v_parte
    from public.movimiento_bancario_gasto p
   where p.movimiento_id = p_movimiento_id;
  return case
    when v.gastos_n is distinct from v_n then
      format('gastos_n = %s pero tiene %s parte(s)', v.gastos_n, v_n)
    when v_n > 0 and not v.conciliado then
      'tiene gastos ligados y no está conciliado'
    when v_n > 0 and v.otras_ligas > 0 then
      'tiene gastos ligados y además una clasificación, un cobro, un sobre o un ingreso'
    when v_n = 1 and v.gasto_id is distinct from v_unico then
      'el espejo gasto_id no es su única parte'
    when v_n = 1 and v_parte <> abs(v.monto) then
      format('su única parte (%s) no vale el cargo completo (%s)', round(v_parte, 2), round(abs(v.monto), 2))
    when v_n <> 1 and v.gasto_id is not null then
      format('gasto_id debe quedar vacío con %s parte(s)', v_n)
    when v_n >= 2 and abs(v_suma - abs(v.monto)) > public.tolerancia_lote(v_n) + 0.000001 then
      format('sus %s partes suman %s y el cargo es de %s (tolerancia %s)',
             v_n, round(v_suma, 2), round(abs(v.monto), 2), public.tolerancia_lote(v_n))
  end;
end $fn_motivo$;

comment on function public.motivo_partes_incoherentes(uuid) is
  'NULL si los espejos del cargo cuadran con la puente; si no, el motivo (20261002000002): gastos_n = count(partes); partes ⇒ conciliado y sin clasificación/cobro/sobre/ingreso; 1 parte ⇔ gasto_id = esa parte y vale |monto|; 0 o 2+ partes ⇒ gasto_id NULL; 2+ partes ⇒ |Σ − |monto|| ≤ tolerancia_lote(N). La usan el constraint trigger y la verificación de la migración.';

create or replace function public.tg_mov_bancario_partes_coherentes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_coherentes$
declare
  v_motivo text;
begin
  v_motivo := public.motivo_partes_incoherentes(new.id);
  if v_motivo is not null then
    raise exception using
      errcode = '23514',
      hint = 'PARTES_INCOHERENTES',
      message = format('PARTES_INCOHERENTES: el cargo %s quedó con sus gastos a medias (%s); liga o desliga sus gastos desde Conciliación, nunca a mano en la tabla', new.id, v_motivo),
      detail = jsonb_build_object('movimiento_id', new.id, 'motivo', v_motivo)::text;
  end if;
  return null;
end $fn_coherentes$;

comment on function public.tg_mov_bancario_partes_coherentes() is
  'Constraint trigger DIFERIDO (20261002000002): al COMMIT re-lee el cargo y lanza 23514 PARTES_INCOHERENTES si motivo_partes_incoherentes no es NULL.';

drop trigger if exists trg_mov_bancario_partes_coherentes on public.movimiento_bancario;
create constraint trigger trg_mov_bancario_partes_coherentes
  after insert or update of gastos_n, conciliado, gasto_id, monto,
    clasificacion_id, cobro_id, cobro_grupo_id, ingreso_id
  on public.movimiento_bancario
  deferrable initially deferred
  for each row execute function public.tg_mov_bancario_partes_coherentes();

-- ===========================================================================
-- 7) F: inventario_eliminar_movimiento — el candado «con cargo bancario
--    ligado» lee la PUENTE (un gasto de un lote tiene gasto_id NULL en el
--    cargo). Resto del cuerpo IDÉNTICO a 20260921000001.
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
             -- Conciliación PARCIAL (14-sep) y LOTES (2-oct): CUALQUIER parte
             -- en la puente bloquea, aunque el gasto no esté cubierto (un
             -- gasto de un lote tiene gasto_id NULL en el cargo: leer el
             -- espejo lo dejaría pasar).
             or exists (select 1 from public.movimiento_bancario_gasto p
                         where p.gasto_id = g.id)
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
  'Borra ATÓMICAMENTE un movimiento de cardex, los gastos REFACCION/BODEGA que generó y deja la fila de auditoría (motivo, quién, snapshots). Candados: movimiento de COMPRA, gasto conciliado/facturado/con CUALQUIER parte en movimiento_bancario_gasto (20261002000002), gasto que ya no es de bodega. Los candados de FIFO (stock negativo, costo de otras salidas) los evalúa el API antes de llamarla.';

-- ===========================================================================
-- 8) RPC del API 0.0.52 (las ÚNICAS escrituras de la puente del API nuevo)
-- ===========================================================================

-- G) Ligar un cargo con 1..N gastos. Escribe como DIFF (lo que sale se
--    borra, lo nuevo se inserta, lo que cambia de monto se actualiza):
--    A valida cada fila, B recalcula solo lo tocado y una re-liga idéntica
--    es un no-op sin bitácora. Todo en UNA transacción (la de la llamada).
create or replace function public.conciliacion_ligar_cargo_gastos(
  p_movimiento_id uuid,
  p_gasto_ids uuid[],
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn_ligar$
declare
  v_mov record;
  v_moneda_cuenta text;
  v_monto_cargo numeric;
  v_n integer;
  v_distintos integer;
  v_falta_id uuid;
  v_devolucion uuid;
  v_actuales uuid[];
  v_anteriores jsonb;
  v_salientes jsonb;
  v_partes jsonb;
  v_nuevas jsonb := '[]'::jsonb;
  v_gastos jsonb := '[]'::jsonb;
  v_g record;
  v_faltante numeric;
  v_suma numeric := 0;
  v_diferencia numeric;
  v_tolerancia numeric;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);

  -- (1) El cargo, BLOQUEADO: dos ligas del mismo cargo se serializan.
  select m.id, m.tipo::text as tipo, m.monto, m.cuenta_bancaria_id,
         m.cobro_id, m.cobro_grupo_id, m.ingreso_id, m.reverso_de_id, m.gastos_n
    into v_mov
    from public.movimiento_bancario m
   where m.id = p_movimiento_id
     for update;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: el movimiento %s no existe', coalesce(p_movimiento_id::text, 'null')),
      detail = jsonb_build_object('movimiento_id', p_movimiento_id)::text;
  end if;
  if v_mov.tipo <> 'CARGO' then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: solo un CARGO del banco se concilia con gastos (este movimiento es un %s)', v_mov.tipo),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'tipo', v_mov.tipo)::text;
  end if;
  if v_mov.cobro_id is not null or v_mov.cobro_grupo_id is not null
     or v_mov.ingreso_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_YA_LIGADO',
      message = 'MOVIMIENTO_YA_LIGADO: el movimiento ya está conciliado con un cobro, un sobre de grupo o un ingreso; desvincúlalo antes de ligarle gastos',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'cobro_id', v_mov.cobro_id,
                                  'cobro_grupo_id', v_mov.cobro_grupo_id,
                                  'ingreso_id', v_mov.ingreso_id)::text;
  end if;
  if v_mov.reverso_de_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'REVERSO_INVALIDO',
      message = 'REVERSO_INVALIDO: este movimiento es la devolución de un cargo: no se liga a gastos',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'reverso_de_id', v_mov.reverso_de_id)::text;
  end if;
  select r.id into v_devolucion
    from public.movimiento_bancario r
   where r.reverso_de_id = v_mov.id
   limit 1;
  if v_devolucion is not null then
    raise exception using
      errcode = '23514',
      hint = 'REVERSO_INVALIDO',
      message = format('REVERSO_INVALIDO: este cargo está emparejado con su devolución (abono %s): quita el emparejamiento antes de ligarle gastos', v_devolucion),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'devolucion_id', v_devolucion)::text;
  end if;

  -- (2) La lista: ids presentes, sin nulos ni repetidos.
  v_n := coalesce(array_length(p_gasto_ids, 1), 0);
  if v_n = 0 then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: manda al menos un gasto (para desvincular todos usa conciliacion_desligar_cargo_gastos)',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gasto_ids', '[]'::jsonb)::text;
  end if;
  if array_position(p_gasto_ids, null) is not null then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae un gasto vacío',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gasto_ids', to_jsonb(p_gasto_ids))::text;
  end if;
  select count(distinct x) into v_distintos from unnest(p_gasto_ids) as x;
  if v_distintos <> v_n then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae el mismo gasto repetido',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gasto_ids', to_jsonb(p_gasto_ids))::text;
  end if;

  -- (3) Lo que el cargo paga HOY (para el diff y la respuesta).
  select coalesce(array_agg(p.gasto_id order by p.gasto_id), '{}'::uuid[]),
         coalesce(jsonb_agg(jsonb_build_object('gasto_id', p.gasto_id,
                                               'monto_parte', p.monto_parte,
                                               'moneda', p.moneda::text)
                            order by p.created_at, p.gasto_id), '[]'::jsonb)
    into v_actuales, v_anteriores
    from public.movimiento_bancario_gasto p
   where p.movimiento_id = p_movimiento_id;

  if v_mov.gastos_n >= 2 and v_n = 1 and not (p_gasto_ids[1] = any(v_actuales)) then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_CON_LOTE',
      message = format('MOVIMIENTO_CON_LOTE: este cargo ya paga %s gastos; desvincúlalos primero', v_mov.gastos_n),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gastos_n', v_mov.gastos_n,
                                  'gasto_ids', to_jsonb(v_actuales))::text;
  end if;

  -- (4) Gastos BLOQUEADOS en orden estable de id —los pedidos Y los que hoy
  --     paga el cargo (los que van a salir también se recalculan)—: dos
  --     ligas concurrentes que comparten gastos no se traban entre sí.
  perform 1
     from public.gasto g
    where g.id = any(p_gasto_ids || v_actuales)
    order by g.id
      for update;
  select x into v_falta_id
    from unnest(p_gasto_ids) as x
   where not exists (select 1 from public.gasto g where g.id = x)
   limit 1;
  if v_falta_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: el gasto %s no existe', v_falta_id),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gasto_id', v_falta_id)::text;
  end if;

  select c.moneda::text
    into v_moneda_cuenta
    from public.cuenta_bancaria c
   where c.id = v_mov.cuenta_bancaria_id;
  v_monto_cargo := round(abs(v_mov.monto), 2);

  if v_n = 1 then
    -- 1 gasto: la regla de hoy. La parte vale el cargo completo; puede
    -- quedar parcial y admite el cruce 1↔1 de moneda (lo valida A).
    v_nuevas := jsonb_build_array(jsonb_build_object('gasto_id', p_gasto_ids[1],
                                                     'monto_parte', v_monto_cargo));
  else
    -- LOTE: cada gasto entra por su FALTANTE fuera de este cargo (las
    -- partes de ESTE cargo no cuentan: un reemplazo no rebota).
    for v_g in
      select g.id, round(g.monto, 2) as monto, g.moneda::text as moneda,
             o.n_otras, o.cruzada_otras, o.suma_otras
        from public.gasto g
        cross join lateral (
          select count(p.gasto_id)::integer as n_otras,
                 coalesce(bool_or(p.moneda::text <> g.moneda::text), false) as cruzada_otras,
                 round(coalesce(sum(p.monto_parte) filter (where p.moneda::text = g.moneda::text), 0), 2) as suma_otras
            from public.movimiento_bancario_gasto p
           where p.gasto_id = g.id
             and p.movimiento_id <> p_movimiento_id
        ) o
       where g.id = any(p_gasto_ids)
       order by array_position(p_gasto_ids, g.id)
    loop
      if v_g.moneda <> v_moneda_cuenta then
        raise exception using
          errcode = '23514',
          hint = 'LOTE_MONEDA_DISTINTA',
          message = format('LOTE_MONEDA_DISTINTA: el gasto %s está en %s y la cuenta en %s',
                           v_g.id, v_g.moneda, v_moneda_cuenta),
          detail = jsonb_build_object('gasto_id', v_g.id, 'movimiento_id', v_mov.id,
                                      'moneda_gasto', v_g.moneda,
                                      'moneda_cuenta', v_moneda_cuenta)::text;
      end if;
      v_faltante := case
        when public.regla_gasto_cubierto(v_g.monto, v_g.n_otras, v_g.cruzada_otras, v_g.suma_otras) then 0
        else greatest(round(abs(v_g.monto) - v_g.suma_otras, 2), 0)
      end;
      if v_faltante <= 0 then
        raise exception using
          errcode = '23514',
          hint = 'GASTO_YA_CUBIERTO',
          message = format('GASTO_YA_CUBIERTO: el gasto %s ya está cubierto por otros cargos (%s de %s)',
                           v_g.id, v_g.suma_otras, abs(v_g.monto)),
          detail = jsonb_build_object('motivo', 'GASTO_YA_CUBIERTO', 'gasto_id', v_g.id,
                                      'movimiento_id', v_mov.id, 'moneda', v_g.moneda,
                                      'monto_gasto', abs(v_g.monto),
                                      'suma_ligada', v_g.suma_otras,
                                      'faltante', 0, 'partes_otras', v_g.n_otras)::text;
      end if;
      v_suma := v_suma + v_faltante;
      v_gastos := v_gastos || jsonb_build_object('id', v_g.id, 'monto', abs(v_g.monto),
                                                 'faltante', v_faltante);
      v_nuevas := v_nuevas || jsonb_build_object('gasto_id', v_g.id, 'monto_parte', v_faltante);
    end loop;
    -- Cuadre: |Σ faltantes − |cargo|| ≤ tolerancia_lote(N). El centavo que
    -- sobra o falta NO se reparte ni ajusta ningún gasto: vive en la
    -- diferencia del lote (gastos_diferencia del API).
    v_tolerancia := public.tolerancia_lote(v_n);
    v_diferencia := round(v_monto_cargo - v_suma, 2);
    if abs(v_diferencia) > v_tolerancia + 0.000001 then
      raise exception using
        errcode = '23514',
        hint = 'CARGO_NO_CUADRA',
        message = format('CARGO_NO_CUADRA: los %s gastos suman %s y el cargo es de %s (diferencia %s, tolerancia %s)',
                         v_n, round(v_suma, 2), v_monto_cargo, v_diferencia, v_tolerancia),
        detail = jsonb_build_object('movimiento_id', v_mov.id,
                                    'monto_cargo', v_monto_cargo,
                                    'suma_gastos', round(v_suma, 2),
                                    'diferencia', v_diferencia,
                                    'tolerancia', v_tolerancia,
                                    'moneda', v_moneda_cuenta,
                                    'gastos', v_gastos)::text;
    end if;
  end if;

  -- (5) ESCRITURA como DIFF. Primero salen los que ya no van.
  with d as (
    delete from public.movimiento_bancario_gasto p
     where p.movimiento_id = p_movimiento_id
       and p.gasto_id <> all(p_gasto_ids)
    returning p.gasto_id, p.monto_parte, p.moneda, p.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('gasto_id', d.gasto_id,
                                               'monto_parte', d.monto_parte,
                                               'moneda', d.moneda::text)
                            order by d.created_at, d.gasto_id), '[]'::jsonb)
    into v_salientes
    from d;

  -- Luego entran/cambian. Las partes que BAJAN de monto van primero: A
  -- valida fila por fila contra lo ya escrito y así ningún estado
  -- intermedio rebasa el cargo. Una parte idéntica no se toca (WHERE).
  insert into public.movimiento_bancario_gasto as p
    (movimiento_id, gasto_id, monto_parte, moneda, created_by)
  select p_movimiento_id, x.gasto_id, x.monto_parte, v_moneda_cuenta::public.moneda, p_actor
    from jsonb_to_recordset(v_nuevas) as x(gasto_id uuid, monto_parte numeric)
    left join public.movimiento_bancario_gasto a
      on a.movimiento_id = p_movimiento_id and a.gasto_id = x.gasto_id
   order by case when a.monto_parte is not null and x.monto_parte < a.monto_parte then 0 else 1 end,
            x.gasto_id
  on conflict (movimiento_id, gasto_id) do update
     set monto_parte = excluded.monto_parte
   where p.monto_parte is distinct from excluded.monto_parte;

  select coalesce(jsonb_agg(jsonb_build_object('gasto_id', p.gasto_id,
                                               'monto_parte', p.monto_parte,
                                               'moneda', p.moneda::text)
                            order by array_position(p_gasto_ids, p.gasto_id)), '[]'::jsonb)
    into v_partes
    from public.movimiento_bancario_gasto p
   where p.movimiento_id = p_movimiento_id;

  return jsonb_build_object(
    'movimiento_id', p_movimiento_id,
    'partes', v_partes,
    'salientes', v_salientes,
    'anteriores', v_anteriores
  );
end $fn_ligar$;

comment on function public.conciliacion_ligar_cargo_gastos(uuid, uuid[], uuid) is
  'RPC G (API 0.0.52, 20261002000002): liga un CARGO con 1..N gastos en UNA transacción. 1 gasto ⇒ parte = |monto| (regla de hoy, admite el 1↔1 cruzado). N ≥ 2 ⇒ misma moneda que la cuenta (LOTE_MONEDA_DISTINTA), cada gasto por su faltante fuera de este cargo (GASTO_YA_CUBIERTO si es 0) y |Σ − |monto|| ≤ tolerancia_lote(N) (CARGO_NO_CUADRA). Errores 23514 con message «CODIGO: …», hint = CODIGO, detail = jsonb. Devuelve {movimiento_id, partes, salientes, anteriores}.';

-- H) Desligar TODOS los gastos de un cargo (= `gasto_id: null` del API).
create or replace function public.conciliacion_desligar_cargo_gastos(
  p_movimiento_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn_desligar$
declare
  v_salientes jsonb;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);
  perform 1
     from public.movimiento_bancario m
    where m.id = p_movimiento_id
      for update;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: el movimiento %s no existe', coalesce(p_movimiento_id::text, 'null')),
      detail = jsonb_build_object('movimiento_id', p_movimiento_id)::text;
  end if;
  -- Mismo orden de candados que G: cargo y luego sus gastos por id.
  perform 1
     from public.gasto g
    where g.id in (select p.gasto_id from public.movimiento_bancario_gasto p
                    where p.movimiento_id = p_movimiento_id)
    order by g.id
      for update;
  with d as (
    delete from public.movimiento_bancario_gasto p
     where p.movimiento_id = p_movimiento_id
    returning p.gasto_id, p.monto_parte, p.moneda, p.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('gasto_id', d.gasto_id,
                                               'monto_parte', d.monto_parte,
                                               'moneda', d.moneda::text)
                            order by d.created_at, d.gasto_id), '[]'::jsonb)
    into v_salientes
    from d;
  return jsonb_build_object('movimiento_id', p_movimiento_id, 'salientes', v_salientes);
end $fn_desligar$;

comment on function public.conciliacion_desligar_cargo_gastos(uuid, uuid) is
  'RPC H (API 0.0.52, 20261002000002): borra TODAS las partes del cargo (B recalcula espejos y gastos con p_actor) y devuelve {movimiento_id, salientes:[{gasto_id, monto_parte, moneda}]} (monto_parte en la moneda de la CUENTA: en el 1↔1 cruzado, los pesos).';

-- ===========================================================================
-- 9) PERMISOS — nada de esto se expone a anon/authenticated; el API usa la
--    service key. (Las funciones de trigger corren igual: no las invoca el
--    rol, las invoca el motor.)
-- ===========================================================================
revoke execute on function public.vt_actor_id() from public, anon, authenticated;
grant execute on function public.vt_actor_id() to service_role;
revoke execute on function public.tolerancia_lote(integer) from public, anon, authenticated;
grant execute on function public.tolerancia_lote(integer) to service_role;
revoke execute on function public.regla_gasto_cubierto(numeric, integer, boolean, numeric) from public, anon, authenticated;
grant execute on function public.regla_gasto_cubierto(numeric, integer, boolean, numeric) to service_role;
revoke execute on function public.recalcular_gasto_conciliado(uuid, uuid, numeric) from public, anon, authenticated;
grant execute on function public.recalcular_gasto_conciliado(uuid, uuid, numeric) to service_role;
revoke execute on function public.motivo_partes_incoherentes(uuid) from public, anon, authenticated;
grant execute on function public.motivo_partes_incoherentes(uuid) to service_role;
revoke execute on function public.tg_mov_gasto_parte_valida() from public, anon, authenticated;
grant execute on function public.tg_mov_gasto_parte_valida() to service_role;
revoke execute on function public.tg_mov_gasto_parte_sync() from public, anon, authenticated;
grant execute on function public.tg_mov_gasto_parte_sync() to service_role;
revoke execute on function public.tg_mov_bancario_gasto_id_sync() from public, anon, authenticated;
grant execute on function public.tg_mov_bancario_gasto_id_sync() to service_role;
revoke execute on function public.tg_mov_bancario_partes_coherentes() from public, anon, authenticated;
grant execute on function public.tg_mov_bancario_partes_coherentes() to service_role;
revoke execute on function public.conciliacion_ligar_cargo_gastos(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.conciliacion_ligar_cargo_gastos(uuid, uuid[], uuid) to service_role;
revoke execute on function public.conciliacion_desligar_cargo_gastos(uuid, uuid) from public, anon, authenticated;
grant execute on function public.conciliacion_desligar_cargo_gastos(uuid, uuid) to service_role;
-- Reescritas (create or replace conserva los permisos; se reafirman).
revoke execute on function public.tg_mov_bancario_gasto_suma() from public, anon, authenticated;
revoke execute on function public.tg_mov_bancario_reverso() from public, anon, authenticated;
revoke execute on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) from public, anon, authenticated;
grant execute on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) to service_role;
-- La vista: solo el API.
revoke all on public.v_gasto_conciliacion from public, anon, authenticated;
grant select on public.v_gasto_conciliacion to service_role;

-- ===========================================================================
-- 10) VERIFICACIÓN FINAL (aborta la migración si algo no cuadra) y REPORTE
-- ===========================================================================
do $ver$
declare
  v_partes bigint;
  v_espejo bigint;
  v_incoherentes integer;
  v_muestra text;
begin
  select count(*) into v_partes from public.movimiento_bancario_gasto;
  select count(*) into v_espejo from public.movimiento_bancario where gasto_id is not null;
  if v_partes <> v_espejo then
    raise exception 'MIGRACION_ABORTADA: la puente tiene % partes y el espejo gasto_id % ligas', v_partes, v_espejo;
  end if;
  select count(*), string_agg(t.id::text || ' (' || t.motivo || ')', '; ' order by t.id)
    into v_incoherentes, v_muestra
    from (select m.id, public.motivo_partes_incoherentes(m.id) as motivo
            from public.movimiento_bancario m) t
   where t.motivo is not null;
  if v_incoherentes > 0 then
    raise exception 'MIGRACION_ABORTADA: % cargo(s) con espejos incoherentes: %', v_incoherentes, left(v_muestra, 800);
  end if;
  raise notice 'VERIFICACION_OK · % partes = % ligas gasto_id · 0 cargos incoherentes', v_partes, v_espejo;
end $ver$;

-- Informativo (NO aborta): gastos cuya bandera `conciliado` difiere de la
-- regla. 2-oct-2026: exactamente 1 — ASUR 0e8ead24… $136.99 con un cargo de
-- $121.91 (la oficina liga su cargo de $15.08 y queda coherente). La
-- migración NO lo corrige: la bandera la recalcula el siguiente cambio de
-- sus partes.
do $rep$
declare
  r record;
  v_n integer := 0;
begin
  for r in
    select g.id, g.monto, g.moneda::text as moneda, g.conciliado,
           v.cubierto, v.n_partes, v.suma
      from public.gasto g
      join public.v_gasto_conciliacion v on v.gasto_id = g.id
     where g.conciliado is distinct from v.cubierto
     order by g.id
  loop
    v_n := v_n + 1;
    raise notice 'REPORTE · gasto % (% %): conciliado = % y la regla dice % (% parte(s) suman %)',
      r.id, r.monto, r.moneda, r.conciliado, r.cubierto, r.n_partes, r.suma;
  end loop;
  raise notice 'REPORTE · % gasto(s) con la bandera distinta a la regla (esperado el 2-oct-2026: 1, ASUR 0e8ead24)', v_n;
end $rep$;

select pg_notify('pgrst', 'reload schema');

-- ---------------------------------------------------------------------------
-- ROLLBACK — SIEMPRE en UNA transacción (begin … commit): si un paso falla no
-- queda nada a medias. Paso 0: aborta si existe algún lote (gastos_n >= 2):
-- el modelo viejo (un gasto_id por cargo) no lo puede expresar. Restaura D,
-- E y F con sus cuerpos EXACTOS (20260915000001, 20260930000001,
-- 20260921000001), sus triggers y el CHECK de ingresos originales. Los
-- espejos gasto_id de las ligas 1↔1 siguen intactos y gasto.conciliado queda
-- como lo dejó la regla (misma que la del API 0.0.51). Probado DENTRO del
-- dry-run (paso R: bloqueo con un lote vivo y restauración comparada contra
-- las definiciones de prod).
-- `set constraints all immediate` VA JUSTO DESPUÉS DE `begin;`: K es un
-- constraint trigger DIFERIDO; si en esta misma transacción alguien desligó
-- lotes con la RPC H (o escribió en movimiento_bancario), sus eventos
-- pendientes harían fallar los ALTER TABLE del final con 55006 «cannot ALTER
-- TABLE … because it has pending trigger events». Forzarlos al inicio no
-- hace daño y lo vuelve robusto (el ensayo R lo corre así, sin forzar antes).
--   begin;
--   set constraints all immediate;
--   do $rb$
--   declare
--     v_lotes integer;
--   begin
--     select count(*) into v_lotes from public.movimiento_bancario where gastos_n >= 2;
--     if v_lotes > 0 then
--       raise exception 'ROLLBACK_BLOQUEADO: % cargo(s) pagan 2 o más gastos (lotes) y el modelo viejo (un gasto_id por cargo) no los puede expresar; desvincúlalos desde Conciliación (o exporta movimiento_bancario_gasto y decide con la oficina) antes de revertir', v_lotes;
--     end if;
--   end $rb$;
--   drop trigger if exists trg_mov_bancario_partes_coherentes on public.movimiento_bancario;
--   drop trigger if exists trg_mov_bancario_gasto_id_sync on public.movimiento_bancario;
--   drop function if exists public.conciliacion_ligar_cargo_gastos(uuid, uuid[], uuid);
--   drop function if exists public.conciliacion_desligar_cargo_gastos(uuid, uuid);
--   drop view if exists public.v_gasto_conciliacion;
--   drop table if exists public.movimiento_bancario_gasto;
--   drop function if exists public.tg_mov_gasto_parte_valida();
--   drop function if exists public.tg_mov_gasto_parte_sync();
--   drop function if exists public.tg_mov_bancario_gasto_id_sync();
--   drop function if exists public.tg_mov_bancario_partes_coherentes();
--   drop function if exists public.motivo_partes_incoherentes(uuid);
--   drop function if exists public.recalcular_gasto_conciliado(uuid, uuid, numeric);
--   drop function if exists public.regla_gasto_cubierto(numeric, integer, boolean, numeric);
--   drop function if exists public.tolerancia_lote(integer);
--   drop function if exists public.vt_actor_id();
--
--   -- D) cuerpo EXACTO de 20260915000001 y su trigger original.
--   create or replace function public.tg_mov_bancario_gasto_suma()
--   returns trigger
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $function$
--   declare
--     v_monto_gasto numeric;
--     v_moneda_gasto text;
--     v_moneda_cuenta text;
--     v_suma numeric := 0;
--     v_otros integer := 0;
--     v_cruzados integer := 0;
--   begin
--     if new.gasto_id is null then
--       return new;
--     end if;
--     if tg_op = 'UPDATE'
--        and new.gasto_id is not distinct from old.gasto_id
--        and new.monto is not distinct from old.monto
--        and new.cuenta_bancaria_id is not distinct from old.cuenta_bancaria_id then
--       return new;
--     end if;
--     -- `moneda` es un ENUM (public.moneda) en gasto y cuenta_bancaria: se compara
--     -- SIEMPRE como texto (enum = text no tiene operador: 15-sep-2026).
--     select g.monto, g.moneda::text
--       into v_monto_gasto, v_moneda_gasto
--       from public.gasto g
--      where g.id = new.gasto_id
--        for update;
--     if not found then
--       return new;
--     end if;
--     select c.moneda::text
--       into v_moneda_cuenta
--       from public.cuenta_bancaria c
--      where c.id = new.cuenta_bancaria_id;
--     select
--         coalesce(sum(abs(m.monto)) filter (
--           where c.moneda is null
--              or v_moneda_gasto is null
--              or c.moneda::text = v_moneda_gasto), 0),
--         count(*),
--         count(*) filter (
--           where c.moneda is not null
--             and v_moneda_gasto is not null
--             and c.moneda::text <> v_moneda_gasto)
--       into v_suma, v_otros, v_cruzados
--       from public.movimiento_bancario m
--       left join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
--      where m.gasto_id = new.gasto_id
--        and m.id <> new.id;
--     if v_moneda_cuenta is not null
--        and v_moneda_gasto is not null
--        and v_moneda_cuenta <> v_moneda_gasto then
--       if v_otros > 0 then
--         raise exception
--           'GASTO_YA_CUBIERTO: el gasto % (%) ya tiene % cargo(s) ligado(s); un cargo en otra MONEDA (%) solo se concilia 1 a 1',
--           new.gasto_id, v_moneda_gasto, v_otros, v_moneda_cuenta
--           using errcode = '23514';
--       end if;
--       return new;
--     end if;
--     if v_cruzados > 0 then
--       raise exception
--         'GASTO_YA_CUBIERTO: el gasto % ya está conciliado contra un cargo de otra MONEDA (1 a 1)',
--         new.gasto_id
--         using errcode = '23514';
--     end if;
--     if v_suma + abs(new.monto) > coalesce(v_monto_gasto, 0) + 1.00 + 0.000001 then
--       raise exception
--         'GASTO_YA_CUBIERTO: los cargos ligados al gasto % suman % y con este (%) rebasan su monto (%)',
--         new.gasto_id, round(v_suma, 2), round(abs(new.monto), 2),
--         round(coalesce(v_monto_gasto, 0), 2)
--         using errcode = '23514';
--     end if;
--     return new;
--   end $function$;
--
--   comment on function public.tg_mov_bancario_gasto_suma() is
--     'Regla 1 gasto ↔ N cargos (14-sep-2026): misma moneda y suma <= monto + 1.00; moneda distinta = 1 a 1. Espejo del util puro conciliacion-parcial.util.ts. Lanza 23514 con prefijo GASTO_YA_CUBIERTO (el API lo traduce a 409 GASTO_YA_CUBIERTO).';
--   revoke execute on function public.tg_mov_bancario_gasto_suma() from public, anon, authenticated;
--   drop trigger if exists trg_mov_bancario_gasto_suma on public.movimiento_bancario;
--   create trigger trg_mov_bancario_gasto_suma
--     before insert or update of gasto_id, monto, cuenta_bancaria_id
--     on public.movimiento_bancario
--     for each row execute function public.tg_mov_bancario_gasto_suma();
--
--   -- E) cuerpo EXACTO de 20260930000001 y su trigger original.
--   create or replace function public.tg_mov_bancario_reverso()
--   returns trigger
--   language plpgsql
--   security invoker
--   set search_path = ''
--   as $function$
--   declare
--     v_cargo record;
--     v_otro uuid;
--   begin
--     -- (1) LADO ABONO: la fila apunta al cargo que devuelve.
--     if new.reverso_de_id is not null then
--       if tg_op = 'UPDATE'
--          and new.reverso_de_id is not distinct from old.reverso_de_id
--          and new.tipo is not distinct from old.tipo
--          and new.monto is not distinct from old.monto
--          and new.cuenta_bancaria_id is not distinct from old.cuenta_bancaria_id
--          and new.gasto_id is not distinct from old.gasto_id
--          and new.cobro_id is not distinct from old.cobro_id
--          and new.cobro_grupo_id is not distinct from old.cobro_grupo_id
--          and new.ingreso_id is not distinct from old.ingreso_id then
--         -- Nada que decida el par cambió (notas, clasificación, flags).
--         null;
--       else
--         if new.reverso_de_id = new.id then
--           raise exception 'REVERSO_INVALIDO: un movimiento no puede ser su propia devolución'
--             using errcode = '23514';
--         end if;
--         if new.tipo::text <> 'ABONO' then
--           raise exception 'REVERSO_INVALIDO: solo un ABONO puede ser la devolución de un cargo (este movimiento es un %)',
--             new.tipo::text
--             using errcode = '23514';
--         end if;
--         if new.gasto_id is not null or new.cobro_id is not null
--            or new.cobro_grupo_id is not null or new.ingreso_id is not null then
--           raise exception 'REVERSO_INVALIDO: el abono ya está conciliado con un gasto, cobro o ingreso'
--             using errcode = '23514';
--         end if;
--         -- `for update`: un emparejado y una liga (o dos emparejados) del
--         -- mismo cargo se serializan y el segundo ve al primero.
--         select m.id, m.tipo::text as tipo, m.cuenta_bancaria_id, m.monto,
--                m.gasto_id, m.cobro_id, m.cobro_grupo_id, m.ingreso_id,
--                m.reverso_de_id
--           into v_cargo
--           from public.movimiento_bancario m
--          where m.id = new.reverso_de_id
--            for update;
--         if not found then
--           -- Cargo inexistente: lo rechaza la FK, no este trigger.
--           return new;
--         end if;
--         if v_cargo.tipo <> 'CARGO' then
--           raise exception 'REVERSO_INVALIDO: el movimiento devuelto debe ser un CARGO (es un %)',
--             v_cargo.tipo
--             using errcode = '23514';
--         end if;
--         if v_cargo.cuenta_bancaria_id <> new.cuenta_bancaria_id then
--           raise exception 'REVERSO_INVALIDO: el cargo y su devolución deben ser de la misma cuenta bancaria'
--             using errcode = '23514';
--         end if;
--         if abs(abs(v_cargo.monto) - abs(new.monto)) > 0.005 then
--           raise exception 'REVERSO_INVALIDO: los montos no coinciden (cargo %, devolución %)',
--             round(v_cargo.monto, 2), round(new.monto, 2)
--             using errcode = '23514';
--         end if;
--         if v_cargo.gasto_id is not null or v_cargo.cobro_id is not null
--            or v_cargo.cobro_grupo_id is not null or v_cargo.ingreso_id is not null then
--           raise exception 'REVERSO_INVALIDO: el cargo ya está conciliado con un gasto, cobro o ingreso'
--             using errcode = '23514';
--         end if;
--         if v_cargo.reverso_de_id is not null then
--           raise exception 'REVERSO_INVALIDO: el cargo no puede ser a su vez una devolución'
--             using errcode = '23514';
--         end if;
--         select m.id into v_otro
--           from public.movimiento_bancario m
--          where m.reverso_de_id = new.reverso_de_id
--            and m.id <> new.id
--          limit 1;
--         if v_otro is not null then
--           raise exception 'REVERSO_INVALIDO: ese cargo ya tiene su devolución emparejada (abono %)',
--             v_otro
--             using errcode = '23514';
--         end if;
--       end if;
--     end if;
--
--     -- (2) LADO CARGO: la fila es el cargo devuelto de alguna devolución.
--     if tg_op = 'UPDATE'
--        and (new.tipo is distinct from old.tipo
--             or new.monto is distinct from old.monto
--             or new.cuenta_bancaria_id is distinct from old.cuenta_bancaria_id
--             or new.gasto_id is distinct from old.gasto_id
--             or new.cobro_id is distinct from old.cobro_id
--             or new.cobro_grupo_id is distinct from old.cobro_grupo_id
--             or new.ingreso_id is distinct from old.ingreso_id) then
--       select m.id into v_otro
--         from public.movimiento_bancario m
--        where m.reverso_de_id = new.id
--          and m.id <> new.id
--        limit 1;
--       if v_otro is not null then
--         raise exception 'REVERSO_INVALIDO: este cargo está emparejado con su devolución (abono %): quita el emparejamiento antes de cambiarle la liga, el monto, el tipo o la cuenta',
--           v_otro
--           using errcode = '23514';
--       end if;
--     end if;
--
--     return new;
--   end;
--   $function$;
--
--   comment on function public.tg_mov_bancario_reverso() is
--     'Candado del par cargo devuelto ↔ devolución (movimiento_bancario.reverso_de_id, 30-sep-2026). 23514 con prefijo REVERSO_INVALIDO ⇒ el API responde 409. Espejo: reverso-cruce.util#motivoParInvalido.';
--   drop trigger if exists trg_mov_bancario_reverso on public.movimiento_bancario;
--   create trigger trg_mov_bancario_reverso
--     before insert or update of reverso_de_id, tipo, monto, cuenta_bancaria_id,
--       gasto_id, cobro_id, cobro_grupo_id, ingreso_id
--     on public.movimiento_bancario
--     for each row execute function public.tg_mov_bancario_reverso();
--   revoke execute on function public.tg_mov_bancario_reverso() from public, anon, authenticated;
--
--   -- F) cuerpo EXACTO de 20260921000001.
--   create or replace function public.inventario_eliminar_movimiento(
--     p_movimiento uuid,
--     p_item uuid,
--     p_motivo text,
--     p_usuario uuid
--   )
--   returns jsonb
--   language plpgsql
--   security definer
--   set search_path = ''
--   as $function$
--   declare
--     v_mov public.inventario_movimiento%rowtype;
--     v_motivo text := btrim(coalesce(p_motivo, ''));
--     v_item_codigo text;
--     v_item_nombre text;
--     v_matricula text;
--     v_usuario_nombre text;
--     v_folio_compra text;
--     v_gasto_ids uuid[] := '{}'::uuid[];
--     v_gastos_snapshot jsonb := '[]'::jsonb;
--     v_ajenos integer := 0;
--     v_bloqueados integer := 0;
--     v_auditoria uuid;
--   begin
--     if p_usuario is null then
--       raise exception 'USUARIO_REQUERIDO: no se sabe quién elimina el movimiento.'
--         using errcode = 'P0001', hint = 'USUARIO_REQUERIDO';
--     end if;
--     if char_length(v_motivo) < 10 then
--       raise exception 'MOTIVO_REQUERIDO: la justificación debe tener al menos 10 caracteres (llegaron %).', char_length(v_motivo)
--         using errcode = 'P0001', hint = 'MOTIVO_REQUERIDO';
--     end if;
--
--     -- (i) Fila BLOQUEADA: dos borrados simultáneos del mismo movimiento se
--     -- serializan y el segundo encuentra «no existe».
--     select * into v_mov
--       from public.inventario_movimiento
--      where id = p_movimiento
--        for update;
--     if not found then
--       raise exception 'MOVIMIENTO_NO_EXISTE: el movimiento % ya no está en el cardex.', p_movimiento
--         using errcode = 'P0001', hint = 'MOVIMIENTO_NO_EXISTE';
--     end if;
--     if v_mov.item_id is distinct from p_item then
--       raise exception 'MOVIMIENTO_DE_OTRO_ITEM: el movimiento % no pertenece al producto %.', p_movimiento, p_item
--         using errcode = 'P0001', hint = 'MOVIMIENTO_DE_OTRO_ITEM';
--     end if;
--
--     -- (ii) CANDADO DE COMPRA: la ENTRADA que nace de una compra se corrige
--     -- desde la compra (ahí se prorratean envío e impuestos). Borrarla dejaría
--     -- la línea de compra apuntando a nada (FK set null) en silencio.
--     select coalesce(c.folio::text, '?')
--       into v_folio_compra
--       from public.compra_linea cl
--       left join public.compra c on c.id = cl.compra_id
--      where cl.inventario_movimiento_id = p_movimiento
--      limit 1;
--     if v_folio_compra is not null then
--       raise exception 'MOVIMIENTO_DE_COMPRA: esta entrada nace de la compra #%; quítala o corrígela desde Compras.', v_folio_compra
--         using errcode = 'P0001', hint = 'MOVIMIENTO_DE_COMPRA';
--     end if;
--
--     -- (iii) Ficha legible congelada (el ítem puede renombrarse o irse después).
--     select i.codigo, i.nombre into v_item_codigo, v_item_nombre
--       from public.inventario_item i where i.id = v_mov.item_id;
--     if v_mov.aeronave_id is not null then
--       select a.matricula into v_matricula
--         from public.aeronave a where a.id = v_mov.aeronave_id;
--     end if;
--     select u.nombre into v_usuario_nombre
--       from public.usuario u where u.id = p_usuario;
--
--     -- (iv) Gastos ligados al movimiento, BLOQUEADOS en orden estable (id) para
--     -- que dos borrados concurrentes no se traben entre sí.
--     select coalesce(array_agg(s.id), '{}'::uuid[])
--       into v_gasto_ids
--       from (
--         select g.id
--           from public.gasto g
--          where g.inventario_movimiento_id = p_movimiento
--          order by g.id
--            for update
--       ) s;
--
--     if array_length(v_gasto_ids, 1) > 0 then
--       -- ENUMs comparados SIEMPRE como texto (categoria_gasto, medio_pago).
--       select
--           count(*) filter (
--             where not (g.categoria::text = 'REFACCION'
--                    and g.medio_pago::text = 'BODEGA')),
--           count(*) filter (
--             where g.conciliado
--                or g.factura_recibida_id is not null
--                or g.estatus_facturacion::text = 'FACTURADA'
--                -- Pago de una COMPRA (la FK es set null: lo dejaría suelto).
--                or g.compra_id is not null
--                -- Conciliación PARCIAL (14-sep): cargos ligados sin la bandera.
--                or exists (select 1 from public.movimiento_bancario mb
--                            where mb.gasto_id = g.id)
--                -- El amarre factura↔gasto NO es simétrico (pendiente conocido:
--                -- `factura_recibida.gasto_id` no siempre escribe el espejo en
--                -- `gasto.factura_recibida_id`). Esa FK también es `set null`:
--                -- sin esta condición, borrar el gasto dejaría la factura
--                -- recibida apuntando a nada, en silencio.
--                or exists (select 1 from public.factura_recibida fr
--                            where fr.gasto_id = g.id))
--         into v_ajenos, v_bloqueados
--         from public.gasto g
--        where g.id = any(v_gasto_ids);
--
--       if v_bloqueados > 0 then
--         raise exception 'GASTO_BLOQUEADO: % de los gastos de este movimiento ya están conciliados con el banco o facturados; desconcílialos o desfactúralos antes de eliminarlo.', v_bloqueados
--           using errcode = 'P0001', hint = 'GASTO_BLOQUEADO';
--       end if;
--       if v_ajenos > 0 then
--         raise exception 'GASTO_BLOQUEADO: % gasto(s) ligados a este movimiento ya no son REFACCION de bodega (alguien los cambió en Gastos); revísalos ahí antes de eliminarlo.', v_ajenos
--           using errcode = 'P0001', hint = 'GASTO_BLOQUEADO';
--       end if;
--
--       -- Snapshot COMPLETO de cada gasto + matrícula + repartos (gasto_reparto
--       -- se borra en CASCADA con el gasto: sin esto, el reparto desaparecería
--       -- sin dejar rastro).
--       select coalesce(jsonb_agg(s.fila order by s.orden), '[]'::jsonb)
--         into v_gastos_snapshot
--         from (
--           select g.created_at as orden,
--                  to_jsonb(g) || jsonb_build_object(
--                    'aeronave_matricula',
--                    (select a.matricula from public.aeronave a where a.id = g.aeronave_id),
--                    'repartos',
--                    coalesce((select jsonb_agg(to_jsonb(r))
--                                from public.gasto_reparto r where r.gasto_id = g.id),
--                             '[]'::jsonb)
--                  ) as fila
--             from public.gasto g
--            where g.id = any(v_gasto_ids)
--         ) s;
--
--       -- ATRIBUCIÓN del DELETE en gasto_bitacora: el trigger trg_gasto_bitacora
--       -- (función public.tg_gasto_bitacora) toma OLD.updated_by como actor, así
--       -- que se sella ANTES de borrar. El UPDATE solo de updated_by no deja fila
--       -- propia: esa columna NO está en la lista de campos de negocio del
--       -- trigger, y con el diff vacío hace `return new` sin insertar.
--       update public.gasto
--          set updated_by = p_usuario
--        where id = any(v_gasto_ids);
--
--       delete from public.gasto where id = any(v_gasto_ids);
--     end if;
--
--     -- (v) AUDITORÍA ANTES DEL BORRADO, en la misma transacción: si el delete
--     -- falla, no queda auditoría; si la auditoría falla, no hay borrado.
--     insert into public.inventario_movimiento_eliminado (
--       movimiento_id, item_id, item_codigo, item_nombre, tipo, cantidad,
--       fecha_movimiento, aeronave_matricula, motivo, snapshot, gastos_snapshot,
--       client_request_id, eliminado_por, eliminado_por_nombre
--     ) values (
--       v_mov.id, v_mov.item_id, v_item_codigo, v_item_nombre,
--       v_mov.tipo::text, v_mov.cantidad, v_mov.fecha_movimiento, v_matricula,
--       v_motivo, to_jsonb(v_mov), v_gastos_snapshot,
--       v_mov.client_request_id, p_usuario, v_usuario_nombre
--     )
--     returning id into v_auditoria;
--
--     delete from public.inventario_movimiento where id = p_movimiento;
--
--     return jsonb_build_object(
--       'auditoria_id', v_auditoria,
--       'gastos_eliminados', coalesce(array_length(v_gasto_ids, 1), 0)
--     );
--   end $function$;
--
--   comment on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) is
--     'Borra ATÓMICAMENTE un movimiento de cardex, los gastos REFACCION/BODEGA que generó y deja la fila de auditoría (motivo, quién, snapshots). Candados: movimiento de COMPRA, gasto conciliado/facturado/con cargo bancario, gasto que ya no es de bodega. Los candados de FIFO (stock negativo, costo de otras salidas) los evalúa el API antes de llamarla.';
--   revoke execute on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) from public, anon, authenticated;
--   grant execute on function public.inventario_eliminar_movimiento(uuid, uuid, text, uuid) to service_role;
--
--   -- CHECK de ingresos original (20260924000004) y fuera el espejo gastos_n.
--   alter table public.movimiento_bancario
--     drop constraint movimiento_bancario_ingreso_excluyente_chk,
--     add constraint movimiento_bancario_ingreso_excluyente_chk
--       check (ingreso_id is null or num_nonnulls(gasto_id, cobro_id, cobro_grupo_id, clasificacion_id) = 0);
--   alter table public.movimiento_bancario drop column gastos_n;
--
--   select pg_notify('pgrst', 'reload schema');
--   commit;
