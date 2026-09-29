-- 29-sep-2026 · LIMPIEZA de los movimientos bancarios DUPLICADOS por las
-- re-importaciones de estados de cuenta. MIGRACIÓN DE DATOS.
--
-- ⚠ NO APLICAR SIN AUTORIZACIÓN EXPLÍCITA DEL USUARIO. Borra filas de
-- `movimiento_bancario` (con respaldo completo). Se aplica DESPUÉS del API
-- 0.0.42 (dedupe nuevo: `emparejarDuplicados` por leyenda tolerante, la
-- referencia ya no veta); si se limpia antes, la siguiente re-importación
-- vuelve a insertar lo mismo. Y conviene aplicarla EN CUANTO salga el 0.0.42,
-- ANTES de otra importación: un estado de cuenta nuevo que se traslape se
-- «pega» a las copias que esta limpieza borra (la cota por archivo del paso
-- 12c lo detecta y aborta, pero obliga a revisar a mano). Antes de aplicar:
-- repetir el DRY-RUN (abajo) y usar en la sección 2 el número y la HUELLA
-- que dé (213 y 53cdb316… el 29-sep-2026).
--
-- Reporte del cliente (29-sep-2026): «Chicos, se me están duplicando los
-- gastos, por favor ayúdenme con este tema». Lo que se duplica son los
-- MOVIMIENTOS del banco: GASTOS GNRAL (Scotiabank) tiene 396 filas en
-- septiembre para 207 movimientos reales, y COMBUSTIBLE 99 para 75.
--
-- CAUSA (verificada en prod): `emparejarDuplicados` dejaba que «la REFERENCIA
-- mande cuando existe de los dos lados», pero la referencia que la IA
-- transcribe del PDF NO es estable entre lecturas. El MISMO cargo del 7-sep
-- (AEROPUERTO DE COZUMEL $125.82) llegó como «0025830577» (importación del
-- 8-sep: número de TARJETA, se repite en muchas filas), «00000000000000000001»
-- (22-sep, consecutivo) y «00000000000000000001 AUT. 456529» (29-sep). Como
-- diferían, cada estado de cuenta que se traslapaba con uno anterior insertó
-- el movimiento OTRA vez. Además la IA trunca/redacta distinto la leyenda
-- («REST HOTEL ZOMAY HOLBOX» vs «REST HOTEL ZOMAY HOLBO»).
--
-- Importaciones (estado_cuenta_archivo · líneas leídas según
-- conciliacion_import_job · filas insertadas):
--   GASTOS GNRAL 76a931e0…  (lote LEGADO sin archivo, 17-jul 00:34 UTC:
--                            97 filas del 1 al 16-jul)
--                           4e6f0e7f 27-jul  ?/93  (16–27 jul; sin job)
--                           c881b2aa 08-sep  65/65  (1–7 sep)
--                           5cef8abf 15-sep 101/37  (1–14 sep; el job murió
--                                            por el ENUM del 15-sep; los dos
--                                            reintentos insertaron 0)
--                           81cb80eb 22-sep 141/140 (1–21 sep)
--                           83dda1f9 29-sep 207/154 (1–28 sep; 53 omitidas,
--                                            que cuadran como 37 del 1 al 4,
--                                            15 del 7 y 1 del 17)
--   COMBUSTIBLE  0752514c…  a4f56e91 08-sep  24/24  (1–7 sep)
--                           caa0a50a 29-sep  75/75  (1–28 sep)
--   Paywise 51740293…: 530470fc 34/34 y 4d3ac74f 35/1 (misma relación
--   re-subida: el dedupe viejo sí la cachó). Agosto: sin traslape.
--
-- ---------------------------------------------------------------------------
-- ALGORITMO (por cuenta bancaria; solo `origen = IMPORTADO`)
-- ---------------------------------------------------------------------------
--  1. CLÚSTER = movimientos con la misma (cuenta, fecha, tipo, monto) cuya
--     LEYENDA empata con tolerancia (componentes conexos). Leyenda = la
--     `descDedupe` del API (`normalizarTextoBanco`: sin acentos, MAYÚSCULAS,
--     sin signos, espacios simples y sin prefijos de agregador «MERPAGO»,
--     «SEL», «SPEI»…) y empate = `nivelDescripcionDedupe` ≠ null: iguales, o
--     una es prefijo de la otra con el lado corto ≥ 8, o comparten los
--     primeros 12 (lado corto ≥ 12), en los dos últimos casos SIN nombrar
--     plazas o números distintos (`leyendasNombranDistinto`: «AEROPUERTO DE
--     CANCUN» ≠ «AEROPUERTO DE COZUMEL», «AUTOZONE 7226» ≠ «… 7227»). Es EL
--     MISMO criterio del dedupe nuevo (frente A, `auto-cruce.util.ts`); si
--     uno cambia, el otro también (`pg_temp.vt_lmb_*`). La REFERENCIA no
--     participa (es justo la señal que falló): el nivel 4 del importador
--     («misma referencia y leyendas que no se contradicen») NO se replica,
--     así que la limpieza nunca es más agresiva que el importador. Re-jugar
--     las 13 importaciones con el `emparejarDuplicados` REAL del API da, por
--     (cuenta, fecha, tipo, monto), EXACTAMENTE los mismos sobrevivientes.
--  2. CANTIDAD REAL del clúster = MÁXIMO, sobre cada importación
--     (`estado_cuenta_id`), de cuántas filas de esa importación caen en el
--     clúster. Cada archivo lista cada cargo real UNA vez y la IA no duplica
--     dentro de un archivo, así que dos cargos legítimos iguales el mismo día
--     (Cozumel $125.82 ×2 el 4 y el 7-sep, ASUR $825.13 ×8 el 21-sep) salen
--     como 2 y 8 en su archivo y se CONSERVAN. Las filas sin archivo (lote
--     legado del 17-jul) cuentan como una importación («LEGADO <día Cancún>»).
--  3. DÍA COMPLETO (revisión adversaria): el máximo solo es confiable si
--     ALGUNA importación vio el día ENTERO: el día cae DENTRO de su rango de
--     fechas, o es el día 1 del mes y la importación arranca ahí. En un día
--     de ORILLA para todas las importaciones el máximo puede SUBESTIMAR y
--     borrar un cargo legítimo: el lote legado se cargó la tarde del 16-jul
--     (trae ASUR $1,541.95, ABTS $359 y OXXO $140 de ese día) y el PDF del
--     27-jul arranca a media jornada del 16-jul (trae 9 cargos del día, OXXO
--     incluido, pero NO el ASUR ni el ABTS). Ese clúster queda DUDOSO: no se
--     toca y va al reporte para que lo decida una persona. Fallar visible
--     (un duplicado que se ve en la bandeja) es mejor que fallar callado (un
--     cargo real que desaparece).
--  4. SOBREVIVIENTES = esa cantidad, por prioridad: (1) ligadas a gasto /
--     cobro / sobre de grupo / ingreso, (2) conciliadas por CLASIFICACIÓN
--     (traspaso…), (3) conciliadas, (4) las más ANTIGUAS (`created_at`, luego
--     `id`). Las demás se BORRAN. Conservar la más antigua conserva además la
--     referencia con la TARJETA (0025830577 ⇒ terminación 0577) que usa el
--     auto-cruce por tarjeta.
--  5. Si un clúster tiene MÁS filas ligadas que su cantidad real, sobreviven
--     las ligas más ANTIGUAS; las nuevas se borran y cada GASTO que pierde
--     una liga se recalcula con la regla EXACTA del API
--     (`ConciliacionService.estadoConciliacion` + `cubreGasto`,
--     tolerancia $1.00): conciliado = hay un cargo de OTRA moneda (1↔1), o
--     hay cargos y Σ|monto| ≥ monto − 1.00 (un gasto de $0 con cargos se da
--     por cubierto); sin cargos ⇒ false. Y, espejo de `recalcularGasto`, un
--     gasto USD que se queda SIN cargos pierde el `tc_gasto` DERIVADO del
--     cargo borrado (|tc − |cargo|/monto| < 0.001). Cobros de vuelo y sobres
--     de grupo NO tienen bandera (su «conciliado» es que exista la liga) y
--     un INGRESO solo deja bitácora `DESCONCILIAR` (espejo de `linkIngreso`).
--     `updated_by = null` ⇒ la bitácora lo pinta «Sistema».
--  6. RESPALDO antes de borrar: `public.movimiento_bancario_eliminado_20260929`
--     guarda la fila COMPLETA (`snapshot`), el clúster, la cantidad real, los
--     sobrevivientes y la bandera/T.C. previos del gasto que perdió la liga.
--     RLS habilitado y sin políticas (solo service key), como
--     `inventario_movimiento_eliminado`. Tras aplicar: `get_advisors`.
--
-- RESULTADO DEL DRY-RUN EN PROD (29-sep-2026, 927 movimientos; bloque de
-- abajo ⇒ DRYRUN_OK en P, C0, S1–S3, C1–C7; después se verificó que no quedó
-- NADA: 927 movimientos, sin tabla de respaldo, gastos conciliados y
-- bitácoras sin cambio):
--   GASTOS GNRAL  723 → 534 · borra 189 (2 conciliadas por clasificación
--                 «Traspaso entre cuentas» —las copias del 29-sep de los
--                 traspasos del 07-sep $14,573.23 y del 10-sep $78,924.10,
--                 que sobreviven en la copia del 22-sep—, 0 ligadas)
--   COMBUSTIBLE   169 → 145 · borra  24 (0 conciliadas)
--   Paywise        35 →  35 · borra   0
--   Total 213 filas en 154 clústeres · 0 gastos/cobros/ingresos pierden liga
--   ⇒ NINGÚN gasto cambia de bandera (`gastos_que_cambian: []`).
--   DUDOSO (no se toca): GASTOS 16-jul «OXXO Cisne» / «OXXO CISNE
--   TLAQUEPAQUE» $140.00, 2 filas (lote legado y 4e6f0e7f), ninguna
--   conciliada. Si el usuario confirma que es UN solo cargo, se borra a mano
--   la del 27-jul.
--   Por mes (filas · cargos MXN):
--     GASTOS sep  396 → 207 · $384,940.56 → $206,184.25
--     COMBUS sep   99 →  75 · $414,130.69 → $323,496.78
--     julio, agosto y Paywise: intactos.
--   Día por día, septiembre queda IGUAL al estado de cuenta del 29-sep
--   (83dda1f9: 207 líneas = 154 insertadas + 53 omitidas, que cuadran
--   exactas con lo que queda del 1 al 4, del 7 y del 17) y COMBUSTIBLE igual
--   a caa0a50a (75 líneas, 0 omitidas).
--   HUELLA (md5 de los 213 ids a borrar, orden texto):
--   53cdb3161bfbae3e34332ac077c9f746.
--
-- CANDADOS:
--   - `lock table movimiento_bancario in share row exclusive mode`: ninguna
--     importación ni liga corre mientras se decide y se borra (el plan y el
--     borrado ven la MISMA foto; las lecturas del panel siguen).
--   - `p_esperadas` + `p_huella` (OBLIGATORIOS): cuántas filas y CUÁLES (md5
--     de sus ids) autorizó borrar el usuario con el último dry-run. Si hoy
--     saldrían otras —aunque sean las mismas en número—, LIMPIEZA_ABORTADA y
--     no se escribe NADA (llegó otro estado de cuenta, alguien ligó una
--     copia… ⇒ repetir el dry-run).
--   - Autoverificación dentro de la función (paso 12): cada clúster queda
--     EXACTO en su cantidad final (seguro = cantidad real, dudoso = intacto),
--     cada gasto tocado queda con la bandera de la regla, y COTA POR ARCHIVO:
--     en el mes de cada estado de cuenta quedan al menos las líneas que leyó
--     (`conciliacion_import_job.total_movimientos`; hoy GASTOS sep 207 ≥ 207,
--     COMBUSTIBLE sep 75 ≥ 75 y Paywise sep 35 ≥ 35: justas). Si no,
--     LIMPIEZA_ABORTADA y se revierte todo.
--   - NINGUNA FK apunta a `movimiento_bancario` y ninguna columna guarda su
--     id; sus triggers (`trg_mov_bancario_gasto_suma`, updated_at) no corren
--     en DELETE.
--   - ENUMs: `movimiento_bancario.tipo`/`origen`, `cuenta_bancaria.moneda` y
--     `gasto.moneda` se comparan SIEMPRE `::text` (regla del workspace tras el
--     incidente del 15-sep-2026).
--   - IDEMPOTENTE: una segunda corrida responde LIMPIEZA_SIN_CAMBIOS; en una
--     BD vacía (db reset) también, sin crear el respaldo.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR — en UNA llamada de `execute_sql`:
-- la sección 1) de abajo TAL CUAL (las `create or replace function`, SIN la
-- sección 2) + este bloque. Hace los DELETE/UPDATE REALES y termina en
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (también la tabla
-- de respaldo), aunque la herramienta haga autocommit. Cualquier
-- 'DRYRUN_FALLA …', 'LIMPIEZA_ABORTADA …' u otro error ⇒ NO aplicar.
-- `v_esperadas` / `v_huella` = lo que se autoriza; si el plan de hoy es otro,
-- el paso P falla y dice los valores nuevos (van aquí Y en la sección 2).
--
--   do $dry$
--   declare
--     -- Lo que se AUTORIZA (la sección 2 usa exactamente estos dos valores).
--     v_esperadas constant integer := 213;
--     v_huella constant text := '53cdb3161bfbae3e34332ac077c9f746';
--     v_plan jsonb; v_res text; v_n integer; v_mov0 integer; v_bit0 bigint; v_ibit0 bigint;
--     v_gc0 integer; v_incons0 text; v_incons1 text; v_txt text;
--     v_k1 uuid[]; v_k2 uuid[]; v_k3 uuid[]; v_m1 numeric; v_m2 numeric; v_m3 numeric;
--     v_g1 uuid; v_g2a uuid; v_g2b uuid; v_g3a uuid; v_g3b uuid; v_usd numeric;
--     v_resumen jsonb;
--   begin
--     if to_regclass('public.movimiento_bancario_eliminado_20260929') is not null then
--       raise exception 'DRYRUN_FALLA: la limpieza ya se aplicó (existe el respaldo)'; end if;
--
--     -- P) El plan de HOY es exactamente el autorizado (número Y huella).
--     v_plan := pg_temp.vt_lmb_planear();
--     if (v_plan ->> 'borrar')::integer <> v_esperadas or v_plan ->> 'huella' <> v_huella then
--       raise exception 'DRYRUN_FALLA P: el plan cambió: hoy borraría % filas (huella %, % dudosos); actualiza v_esperadas/v_huella aquí y en la sección 2 y vuelve a autorizar',
--         v_plan ->> 'borrar', v_plan ->> 'huella', v_plan ->> 'dudosos'; end if;
--     raise notice 'okP · %', v_plan;
--
--     select count(*) into v_mov0 from public.movimiento_bancario;
--     select count(*) into v_bit0 from public.gasto_bitacora;
--     select count(*) into v_ibit0 from public.ingreso_bitacora;
--     select count(*) into v_gc0 from public.gasto where conciliado;
--     -- Gastos cuya bandera NO cuadra con la regla ANTES (hoy 1 preexistente:
--     -- 0e8ead24…, $136.99 ligado a un cargo de $121.91): la limpieza no debe
--     -- crear NI arreglar ninguno por su cuenta.
--     select coalesce(string_agg(id::text, ',' order by id), '') into v_incons0 from (
--       select g.id, g.conciliado,
--              case when count(m.id) filter (where c.moneda::text <> g.moneda::text) > 0 then true
--                   when count(m.id) = 0 then false
--                   when round(abs(g.monto), 2) <= 0 then true
--                   else round(coalesce(sum(abs(m.monto)), 0), 2) >= round(abs(g.monto), 2) - 1.00 end as regla
--         from public.gasto g
--         left join public.movimiento_bancario m on m.gasto_id = g.id
--         left join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
--        group by g.id) t where t.conciliado is distinct from t.regla;
--     create temp table _dry_antes on commit drop as select * from public.movimiento_bancario;
--     create temp table _dry_gasto on commit drop as
--       select id, conciliado, tc_gasto, monto, updated_by, updated_at from public.gasto;
--
--     -- C0) CANDADOS: otro número, otra huella o nulos ⇒ ABORTA sin escribir nada
--     begin
--       perform pg_temp.vt_limpiar_duplicados_movimiento_bancario(v_esperadas + 1, v_huella);
--       raise exception 'DRYRUN_FALLA C0: no abortó con un número distinto';
--     exception when others then
--       if sqlerrm not like 'LIMPIEZA_ABORTADA%' then raise exception 'DRYRUN_FALLA C0: %', sqlerrm; end if;
--     end;
--     begin
--       perform pg_temp.vt_limpiar_duplicados_movimiento_bancario(v_esperadas, md5('otra'));
--       raise exception 'DRYRUN_FALLA C0: no abortó con una huella distinta';
--     exception when others then
--       if sqlerrm not like 'LIMPIEZA_ABORTADA%' then raise exception 'DRYRUN_FALLA C0: %', sqlerrm; end if;
--     end;
--     begin
--       perform pg_temp.vt_limpiar_duplicados_movimiento_bancario(v_esperadas, null);
--       raise exception 'DRYRUN_FALLA C0: no abortó sin huella';
--     exception when others then
--       if sqlerrm not like 'LIMPIEZA_ABORTADA%' then raise exception 'DRYRUN_FALLA C0: %', sqlerrm; end if;
--     end;
--     if (select count(*) from public.movimiento_bancario) <> v_mov0
--        or to_regclass('public.movimiento_bancario_eliminado_20260929') is not null then
--       raise exception 'DRYRUN_FALLA C0: quedó algo escrito tras el aborto'; end if;
--     raise notice 'okC0 · número, huella o nulo distintos abortan sin escribir';
--
--     -- S) ESCENARIOS SINTÉTICOS de LIGAS (en prod hoy ninguna liga se pierde,
--     --    así que el recálculo de gastos se prueba con ligas FABRICADAS
--     --    dentro de una subtransacción que se revierte). Tres clústeres
--     --    SEGUROS reales de 3 filas (3 archivos, 1 cargo real, sin ligas) y
--     --    gastos reales sin cargos:
--     --    S1 un gasto cubierto por DOS copias del mismo cargo ⇒ queda con una
--     --       ⇒ Σ < monto − 1 ⇒ conciliado false.
--     --    S2 la copia más NUEVA ligada a otro gasto ⇒ esa liga se va (gana
--     --       la más antigua) ⇒ ese gasto a false; el de la antigua sigue true.
--     --    S3 gasto USD ligado 1↔1 a la copia 2 (T.C. derivado) ⇒ sin cargos
--     --       ⇒ false y `tc_gasto` null.
--     begin
--       select array_agg(m.id order by m.created_at, m.id), min(k.monto) into v_k1, v_m1
--         from (select k.cluster, k.monto from pg_temp._lmb_cluster k
--                 join public.cuenta_bancaria c on c.id = k.cuenta_bancaria_id
--                where c.moneda::text = 'MXN' and not k.dudoso and k.dia_completo
--                  and k.filas = 3 and k.importaciones = 3 and k.cantidad_real = 1 and k.monto > 5
--                  and not exists (select 1 from pg_temp._lmb_mov x where x.cluster = k.cluster and (x.ligado or x.clasificado))
--                order by k.fecha, k.monto, k.cluster offset 0 limit 1) k
--         join pg_temp._lmb_mov m on m.cluster = k.cluster;
--       select array_agg(m.id order by m.created_at, m.id), min(k.monto) into v_k2, v_m2
--         from (select k.cluster, k.monto from pg_temp._lmb_cluster k
--                 join public.cuenta_bancaria c on c.id = k.cuenta_bancaria_id
--                where c.moneda::text = 'MXN' and not k.dudoso and k.dia_completo
--                  and k.filas = 3 and k.importaciones = 3 and k.cantidad_real = 1 and k.monto > 5
--                  and not exists (select 1 from pg_temp._lmb_mov x where x.cluster = k.cluster and (x.ligado or x.clasificado))
--                order by k.fecha, k.monto, k.cluster offset 1 limit 1) k
--         join pg_temp._lmb_mov m on m.cluster = k.cluster;
--       select array_agg(m.id order by m.created_at, m.id), min(k.monto) into v_k3, v_m3
--         from (select k.cluster, k.monto from pg_temp._lmb_cluster k
--                 join public.cuenta_bancaria c on c.id = k.cuenta_bancaria_id
--                where c.moneda::text = 'MXN' and not k.dudoso and k.dia_completo
--                  and k.filas = 3 and k.importaciones = 3 and k.cantidad_real = 1 and k.monto > 5
--                  and not exists (select 1 from pg_temp._lmb_mov x where x.cluster = k.cluster and (x.ligado or x.clasificado))
--                order by k.fecha, k.monto, k.cluster offset 2 limit 1) k
--         join pg_temp._lmb_mov m on m.cluster = k.cluster;
--       if v_k3 is null or cardinality(v_k1) <> 3 or cardinality(v_k2) <> 3 or cardinality(v_k3) <> 3 then
--         raise exception 'DRYRUN_FALLA S: no hay 3 clústeres seguros de 3 filas para el ensayo'; end if;
--       select id into v_g1 from public.gasto g where g.moneda::text = 'MXN' and not g.conciliado
--          and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--          and not exists (select 1 from public.gasto_reparto r where r.gasto_id = g.id) order by g.id offset 0 limit 1;
--       select id into v_g2a from public.gasto g where g.moneda::text = 'MXN' and not g.conciliado
--          and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--          and not exists (select 1 from public.gasto_reparto r where r.gasto_id = g.id) order by g.id offset 1 limit 1;
--       select id into v_g2b from public.gasto g where g.moneda::text = 'MXN' and not g.conciliado
--          and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--          and not exists (select 1 from public.gasto_reparto r where r.gasto_id = g.id) order by g.id offset 2 limit 1;
--       select id into v_g3a from public.gasto g where g.moneda::text = 'MXN' and not g.conciliado
--          and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--          and not exists (select 1 from public.gasto_reparto r where r.gasto_id = g.id) order by g.id offset 3 limit 1;
--       select id into v_g3b from public.gasto g where g.moneda::text = 'USD' and not g.conciliado
--          and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--          and not exists (select 1 from public.gasto_reparto r where r.gasto_id = g.id) order by g.id limit 1;
--       if v_g3b is null then raise exception 'DRYRUN_FALLA S: no hay gasto USD libre para el ensayo'; end if;
--       -- S1: el gasto vale DOS copias y las dos lo cubren
--       update public.gasto set monto = 2 * v_m1 where id = v_g1;
--       update public.movimiento_bancario set gasto_id = v_g1, conciliado = true where id = v_k1[1];
--       update public.movimiento_bancario set gasto_id = v_g1, conciliado = true where id = v_k1[2];
--       update public.gasto set conciliado = true where id = v_g1;
--       -- S2: la copia antigua a un gasto y la NUEVA a otro
--       update public.gasto set monto = v_m2 where id in (v_g2a, v_g2b);
--       update public.movimiento_bancario set gasto_id = v_g2a, conciliado = true where id = v_k2[1];
--       update public.movimiento_bancario set gasto_id = v_g2b, conciliado = true where id = v_k2[3];
--       update public.gasto set conciliado = true where id in (v_g2a, v_g2b);
--       -- S3: la antigua a un gasto MXN; la copia 2 a un gasto USD con T.C. derivado
--       v_usd := round(v_m3 / 18, 2);
--       update public.gasto set monto = v_m3 where id = v_g3a;
--       update public.movimiento_bancario set gasto_id = v_g3a, conciliado = true where id = v_k3[1];
--       update public.gasto set conciliado = true where id = v_g3a;
--       update public.gasto set monto = v_usd, tc_gasto = round(v_m3 / v_usd, 6) where id = v_g3b;
--       update public.movimiento_bancario set gasto_id = v_g3b, conciliado = true where id = v_k3[2];
--       update public.gasto set conciliado = true where id = v_g3b;
--
--       -- Con ligas nuevas el plan se recalcula (misma cantidad; la huella la da el plan).
--       v_plan := pg_temp.vt_lmb_planear();
--       if (v_plan ->> 'borrar')::integer <> v_esperadas or (v_plan ->> 'ligadas')::integer <> 3 then
--         raise exception 'DRYRUN_FALLA S: plan sintético inesperado %', v_plan; end if;
--       v_res := pg_temp.vt_limpiar_duplicados_movimiento_bancario(v_esperadas, v_plan ->> 'huella');
--       if v_res not like 'LIMPIEZA_OK%' then raise exception 'DRYRUN_FALLA S: %', v_res; end if;
--       if not exists (select 1 from public.movimiento_bancario where id = v_k1[1] and gasto_id = v_g1)
--          or exists (select 1 from public.movimiento_bancario where id in (v_k1[2], v_k1[3]))
--          or (select conciliado from public.gasto where id = v_g1) then
--         raise exception 'DRYRUN_FALLA S1: el gasto cubierto por dos copias no quedó parcial'; end if;
--       if not exists (select 1 from public.movimiento_bancario where id = v_k2[1] and gasto_id = v_g2a)
--          or exists (select 1 from public.movimiento_bancario where id in (v_k2[2], v_k2[3]))
--          or not (select conciliado from public.gasto where id = v_g2a)
--          or (select conciliado from public.gasto where id = v_g2b) then
--         raise exception 'DRYRUN_FALLA S2: no ganó la liga más antigua'; end if;
--       if not exists (select 1 from public.movimiento_bancario where id = v_k3[1] and gasto_id = v_g3a)
--          or exists (select 1 from public.movimiento_bancario where id in (v_k3[2], v_k3[3]))
--          or not (select conciliado from public.gasto where id = v_g3a)
--          or (select conciliado or tc_gasto is not null from public.gasto where id = v_g3b) then
--         raise exception 'DRYRUN_FALLA S3: el gasto USD no perdió bandera y T.C.'; end if;
--       select count(*) into v_n from public.movimiento_bancario_eliminado_20260929 r
--        where (r.movimiento_id = v_k1[2] and r.gasto_id = v_g1 and r.gasto_conciliado_antes)
--           or (r.movimiento_id = v_k2[3] and r.gasto_id = v_g2b and r.gasto_conciliado_antes)
--           or (r.movimiento_id = v_k3[2] and r.gasto_id = v_g3b and r.gasto_conciliado_antes
--               and r.gasto_tc_antes = round(v_m3 / v_usd, 6));
--       if v_n <> 3 then raise exception 'DRYRUN_FALLA S: respaldo de ligas = %', v_n; end if;
--       select count(*) into v_n from public.gasto_bitacora b
--        where b.created_at = now() and b.accion = 'UPDATE' and b.actor_id is null
--          and b.gasto_id in (v_g1, v_g2b, v_g3b) and b.diff ? 'conciliado'
--          and (b.gasto_id <> v_g3b or b.diff ? 'tc_gasto');
--       if v_n <> 3 then raise exception 'DRYRUN_FALLA S: bitácora «Sistema» de los 3 gastos = %', v_n; end if;
--       raise exception 'SINTETICO_OK';
--     exception when others then
--       if sqlerrm <> 'SINTETICO_OK' then raise exception 'DRYRUN_FALLA S: %', sqlerrm; end if;
--     end;
--     if (select count(*) from public.movimiento_bancario) <> v_mov0
--        or (select count(*) from public.gasto where conciliado) <> v_gc0 then
--       raise exception 'DRYRUN_FALLA S: la subtransacción del ensayo no se revirtió'; end if;
--     raise notice 'okS · S1 parcial ⇒ false · S2 gana la liga antigua · S3 USD pierde T.C.';
--
--     -- C1) CORRIDA REAL
--     v_res := pg_temp.vt_limpiar_duplicados_movimiento_bancario(v_esperadas, v_huella);
--     if v_res not like 'LIMPIEZA_OK%' then raise exception 'DRYRUN_FALLA C1: %', v_res; end if;
--     raise notice 'okC1 · %', v_res;
--
--     -- C2) (a) CADA clúster (todos) queda en su cantidad final: seguro EXACTO en
--     --     su cantidad real, dudoso INTACTO
--     select count(*) into v_n from pg_temp._lmb_cluster k
--      where k.cantidad_final <> (select count(*) from public.movimiento_bancario mb
--                                   join pg_temp._lmb_mov m on m.id = mb.id where m.cluster = k.cluster)
--         or (k.dudoso and k.cantidad_final <> k.filas)
--         or (not k.dudoso and k.cantidad_final <> k.cantidad_real);
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C2(a): % clústeres fuera de su cantidad final', v_n; end if;
--     -- … y ningún DÍA queda con menos filas que la importación más completa de ese día
--     select count(*) into v_n from (
--       select a.cuenta_bancaria_id, a.fecha, max(a.n) as mx
--         from (select cuenta_bancaria_id, fecha, importacion, count(*) n from pg_temp._lmb_mov group by 1, 2, 3) a
--        group by 1, 2) d
--      where d.mx > (select count(*) from public.movimiento_bancario mb
--                     where mb.cuenta_bancaria_id = d.cuenta_bancaria_id and mb.fecha = d.fecha
--                       and mb.origen::text = 'IMPORTADO');
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C2(a): % días quedaron por debajo de su estado de cuenta', v_n; end if;
--     raise notice 'okC2 · clústeres en su cantidad final y ningún día por debajo de su archivo';
--
--     -- C3) (b) BANDERAS: el conjunto de gastos que no cuadran con la regla es EL MISMO de antes
--     select coalesce(string_agg(id::text, ',' order by id), '') into v_incons1 from (
--       select g.id, g.conciliado,
--              case when count(m.id) filter (where c.moneda::text <> g.moneda::text) > 0 then true
--                   when count(m.id) = 0 then false
--                   when round(abs(g.monto), 2) <= 0 then true
--                   else round(coalesce(sum(abs(m.monto)), 0), 2) >= round(abs(g.monto), 2) - 1.00 end as regla
--         from public.gasto g
--         left join public.movimiento_bancario m on m.gasto_id = g.id
--         left join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
--        group by g.id) t where t.conciliado is distinct from t.regla;
--     if v_incons1 <> v_incons0 then
--       raise exception 'DRYRUN_FALLA C3(b): gastos fuera de regla antes [%] después [%]', v_incons0, v_incons1; end if;
--     -- Solo cambian los gastos que el plan recalculó
--     select count(*) into v_n from public.gasto g join _dry_gasto d on d.id = g.id
--      where (g.conciliado, g.tc_gasto, g.monto) is distinct from (d.conciliado, d.tc_gasto, d.monto)
--        and g.id not in (select gasto_id from pg_temp._lmb_gasto
--                          where conciliado_antes is distinct from conciliado_despues or limpiar_tc);
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C3(b): % gastos cambiaron fuera del plan', v_n; end if;
--     raise notice 'okC3 · banderas de gasto intactas salvo el plan (fuera de regla: [%])', v_incons1;
--
--     -- C4) (c) TOTALES por cuenta, mes y tipo = Σ cantidad final × monto de cada clúster
--     select count(*) into v_n from (
--       select k.cuenta_bancaria_id, date_trunc('month', k.fecha) mes, k.tipo,
--              sum(k.cantidad_final) n, sum(k.cantidad_final * k.monto) s
--         from pg_temp._lmb_cluster k group by 1, 2, 3) e
--       full join (
--       select mb.cuenta_bancaria_id, date_trunc('month', mb.fecha) mes, mb.tipo::text tipo,
--              count(*) n, sum(mb.monto) s
--         from public.movimiento_bancario mb where mb.origen::text = 'IMPORTADO' group by 1, 2, 3) v
--       using (cuenta_bancaria_id, mes, tipo)
--      where e.n is distinct from v.n or e.s is distinct from v.s;
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C4(c): % (cuenta, mes, tipo) no cuadran', v_n; end if;
--     raise notice 'okC4 · totales por cuenta/mes/tipo = máximo por importación (dudosos intactos)';
--
--     -- C5) (d) Respaldo = exactamente lo borrado, byte a byte; lo que queda, intacto
--     select count(*) into v_n from public.movimiento_bancario_eliminado_20260929;
--     if v_n <> v_esperadas or (select count(*) from public.movimiento_bancario) <> v_mov0 - v_esperadas then
--       raise exception 'DRYRUN_FALLA C5: respaldo % / borradas %', v_n, v_mov0 - (select count(*) from public.movimiento_bancario); end if;
--     select count(*) into v_n from _dry_antes a
--      where not exists (select 1 from public.movimiento_bancario mb where mb.id = a.id)
--        and not exists (select 1 from public.movimiento_bancario_eliminado_20260929 r
--                         where r.movimiento_id = a.id and r.snapshot = to_jsonb(a));
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C5: % filas borradas sin respaldo idéntico', v_n; end if;
--     -- … y el snapshot RECONSTRUYE la fila (el ROLLBACK de abajo funciona)
--     select count(*) into v_n from public.movimiento_bancario_eliminado_20260929 r
--       join _dry_antes a on a.id = r.movimiento_id
--      where to_jsonb(jsonb_populate_record(null::public.movimiento_bancario, r.snapshot)) <> to_jsonb(a);
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C5: % snapshots no reconstruyen su fila', v_n; end if;
--     select count(*) into v_n from public.movimiento_bancario mb join _dry_antes a on a.id = mb.id
--      where to_jsonb(mb) <> to_jsonb(a);
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C5: % filas sobrevivientes cambiaron', v_n; end if;
--     if (select md5(string_agg(movimiento_id::text, ',' order by movimiento_id::text))
--           from public.movimiento_bancario_eliminado_20260929) <> v_huella then
--       raise exception 'DRYRUN_FALLA C5: lo borrado no es lo autorizado (huella)'; end if;
--     if (select count(*) from public.gasto_bitacora) - v_bit0
--          <> (select count(*) from pg_temp._lmb_gasto where conciliado_antes is distinct from conciliado_despues or limpiar_tc)
--        or (select count(*) from public.ingreso_bitacora) - v_ibit0
--          <> (select count(*) from public.movimiento_bancario_eliminado_20260929 where ingreso_id is not null) then
--       raise exception 'DRYRUN_FALLA C5: bitácoras de gasto/ingreso no cuadran con el plan'; end if;
--     raise notice 'okC5 · respaldo exacto y reconstruible, borrado = huella, sobrevivientes intactas, bitácoras = plan';
--
--     -- C7) COTA POR ARCHIVO (también la aplica la función): en el mes de cada
--     --     estado de cuenta quedan al menos las líneas que leyó.
--     select string_agg(format('%s %s: %s líneas / quedan %s', left(x.archivo, 8), x.mes, x.lineas, x.quedan), '; ' order by x.mes, x.archivo),
--            count(*) filter (where x.quedan < x.lineas)
--       into v_txt, v_n
--       from (select a.id::text as archivo, to_char(r.desde, 'YYYY-MM') as mes, j.total_movimientos as lineas,
--                    (select count(*) from public.movimiento_bancario mb
--                      where mb.cuenta_bancaria_id = r.cuenta_bancaria_id
--                        and mb.fecha >= date_trunc('month', r.desde)::date
--                        and mb.fecha < (date_trunc('month', r.hasta) + interval '1 month')::date) as quedan
--               from public.conciliacion_import_job j
--               join lateral (select ea.id from public.estado_cuenta_archivo ea
--                              where ea.cuenta_bancaria_id = j.cuenta_bancaria_id
--                                and ea.created_at between j.created_at and j.created_at + interval '2 minutes'
--                              order by ea.created_at limit 1) a on true
--               join pg_temp._lmb_rango r on r.importacion = a.id::text
--              where j.tipo = 'IMPORT' and coalesce(j.total_movimientos, 0) > 0) x;
--     if v_n > 0 then raise exception 'DRYRUN_FALLA C7: % archivos por debajo de sus líneas: %', v_n, v_txt; end if;
--     raise notice 'okC7 · %', v_txt;
--
--     -- Resumen para el reporte (antes de C6: C6 recrea las tablas del plan)
--     select jsonb_build_object(
--       'resultado', v_res,
--       'huella', v_huella,
--       'cota_archivos', v_txt,
--       'por_cuenta', (select jsonb_agg(x order by x->>'cuenta') from (
--          select jsonb_build_object('cuenta', cb.alias,
--            'antes', (select count(*) from _dry_antes a where a.cuenta_bancaria_id = cb.id),
--            'despues', (select count(*) from public.movimiento_bancario mb where mb.cuenta_bancaria_id = cb.id),
--            'borradas', count(r.movimiento_id), 'conciliadas', count(r.movimiento_id) filter (where r.conciliado),
--            'ligadas', count(r.movimiento_id) filter (where r.liga in ('GASTO', 'COBRO', 'SOBRE', 'INGRESO')),
--            'clasificadas', count(r.movimiento_id) filter (where r.liga = 'CLASIFICACION'),
--            'gastos_a_sin_conciliar', count(distinct r.gasto_id) filter (where r.gasto_conciliado_antes
--               and not g.conciliado)) x
--            from public.cuenta_bancaria cb
--            left join public.movimiento_bancario_eliminado_20260929 r on r.cuenta_bancaria_id = cb.id
--            left join public.gasto g on g.id = r.gasto_id
--           group by cb.id, cb.alias) q),
--       'por_mes', (select jsonb_agg(jsonb_build_object('cuenta', q.alias, 'mes', q.mes, 'antes', q.antes, 'despues', q.despues,
--                     'cargos_antes', q.ca, 'cargos_despues', q.cd) order by q.alias, q.mes) from (
--          select cb.alias, to_char(a.fecha, 'YYYY-MM') mes, count(*) antes,
--                 count(*) filter (where exists (select 1 from public.movimiento_bancario mb where mb.id = a.id)) despues,
--                 sum(a.monto) filter (where a.tipo::text = 'CARGO') ca,
--                 sum(a.monto) filter (where a.tipo::text = 'CARGO'
--                   and exists (select 1 from public.movimiento_bancario mb where mb.id = a.id)) cd
--            from _dry_antes a join public.cuenta_bancaria cb on cb.id = a.cuenta_bancaria_id
--           group by 1, 2) q),
--       'gastos_que_cambian', (select coalesce(jsonb_agg(jsonb_build_object('gasto', l.gasto_id, 'fecha', g.fecha_gasto,
--            'categoria', g.categoria::text, 'monto', l.monto, 'moneda', l.moneda, 'lugar', g.lugar,
--            'vuelo', v.folio, 'antes', l.conciliado_antes, 'despues', l.conciliado_despues)), '[]'::jsonb)
--            from pg_temp._lmb_gasto l join public.gasto g on g.id = l.gasto_id
--            left join public.vuelo v on v.id = g.vuelo_id
--           where l.conciliado_antes is distinct from l.conciliado_despues or l.limpiar_tc),
--       'dudosos', (select coalesce(jsonb_agg(jsonb_build_object('cuenta', cb.alias, 'fecha', k.fecha, 'tipo', k.tipo,
--            'monto', k.monto, 'filas', k.filas, 'max_por_archivo', k.cantidad_real,
--            'filas_detalle', (select jsonb_agg(jsonb_build_object('id', a.id, 'descripcion', a.descripcion,
--                                 'referencia', a.referencia, 'importacion', left(m.importacion, 17),
--                                 'conciliado', a.conciliado) order by a.created_at)
--                                from _dry_antes a join pg_temp._lmb_mov m on m.id = a.id where m.cluster = k.cluster))), '[]'::jsonb)
--            from pg_temp._lmb_cluster k join public.cuenta_bancaria cb on cb.id = k.cuenta_bancaria_id
--           where k.dudoso),
--       'ejemplos', (select jsonb_agg(e.j order by e.rn, e.alias) from (
--          select cb.alias, jsonb_build_object('cuenta', cb.alias, 'fecha', k.fecha, 'tipo', k.tipo, 'monto', k.monto,
--                   'leyendas', (select jsonb_agg(distinct a.descripcion) from _dry_antes a join pg_temp._lmb_mov m on m.id = a.id
--                                  where m.cluster = k.cluster),
--                   'filas', k.filas, 'real', k.cantidad_real,
--                   'por_archivo', (select jsonb_object_agg(left(i.importacion, 8), i.n) from (
--                      select importacion, count(*) n from pg_temp._lmb_mov m where m.cluster = k.cluster group by 1) i),
--                   'borradas_conciliadas', (select count(*) from public.movimiento_bancario_eliminado_20260929 r
--                                             where r.cluster = k.cluster and r.conciliado)) j,
--                 row_number() over (partition by cb.alias order by
--                   (select count(*) from public.movimiento_bancario_eliminado_20260929 r where r.cluster = k.cluster and r.conciliado) desc,
--                   (select count(distinct m.dn) from pg_temp._lmb_mov m where m.cluster = k.cluster) desc,
--                   k.filas desc, k.fecha, k.monto) rn
--            from pg_temp._lmb_cluster k join public.cuenta_bancaria cb on cb.id = k.cuenta_bancaria_id
--           where k.filas > k.cantidad_final) e where e.rn <= 5)
--     ) into v_resumen;
--
--     -- C6) IDEMPOTENTE: la segunda corrida no encuentra nada
--     v_res := pg_temp.vt_limpiar_duplicados_movimiento_bancario(v_esperadas, v_huella);
--     if v_res not like 'LIMPIEZA_SIN_CAMBIOS%' then raise exception 'DRYRUN_FALLA C6: %', v_res; end if;
--     raise notice 'okC6 · idempotente';
--
--     raise exception 'DRYRUN_OK · P plan autorizado · C0 candados · S ligas sintéticas · C1 corrida · C2 clústeres · C3 banderas · C4 totales · C5 respaldo · C7 cota por archivo · C6 idempotente · todo se revierte · %', v_resumen::text;
--   end $dry$;
--
-- TRAS APLICAR (secciones 1 y 2 juntas, vía MCP, prod bjesduasnzbzywofukbf):
--   - El `select` de la sección 2 responde 'LIMPIEZA_OK: 213 filas …; 1
--     clúster(es) dudoso(s) intactos …' (LIMPIEZA_SIN_CAMBIOS = ya estaba;
--     LIMPIEZA_ABORTADA = no se escribió nada: repetir el dry-run con los
--     valores nuevos y volver a autorizar).
--   - `get_advisors` (tabla nueva con RLS y sin políticas: INFO esperado).
--   - `select count(*) from movimiento_bancario where cuenta_bancaria_id =
--     '76a931e0-7c06-47c6-a574-6c7d4a698c14' and fecha >= '2026-09-01'` = 207
--     y en COMBUSTIBLE (0752514c…) = 75; julio de GASTOS sigue en 190 (el
--     OXXO dudoso se queda hasta que el usuario decida).
--   - Panel → Conciliación: GASTOS GNRAL de septiembre ya sin pares repetidos.
--
-- ROLLBACK (NO correr salvo decisión explícita del usuario: devuelve los
-- duplicados). Re-inserta las filas tal cual (C5 del dry-run prueba que cada
-- snapshot reconstruye su fila byte a byte) y regresa bandera/T.C. de los
-- gastos que el plan tocó. Primero las filas SIN gasto y luego las ligadas:
-- el trigger de suma vuelve a validar cada liga (el estado original ya
-- cumplía la regla, así que pasa):
--
--   insert into public.movimiento_bancario
--   select (jsonb_populate_record(null::public.movimiento_bancario, r.snapshot)).*
--     from public.movimiento_bancario_eliminado_20260929 r
--    where not exists (select 1 from public.movimiento_bancario mb where mb.id = r.movimiento_id)
--    order by (r.gasto_id is not null), r.eliminado_at;
--   update public.gasto g
--      set conciliado = r.gasto_conciliado_antes, tc_gasto = r.gasto_tc_antes, updated_by = null
--     from (select distinct gasto_id, gasto_conciliado_antes, gasto_tc_antes
--             from public.movimiento_bancario_eliminado_20260929 where gasto_id is not null) r
--    where g.id = r.gasto_id;
-- ---------------------------------------------------------------------------

-- 1) CUERPO (el dry-run lo pega TAL CUAL)

-- Leyenda para el dedupe: espejo de `descDedupe` / `normalizarTextoBanco`
-- (auto-cruce.util.ts): sin acentos, MAYÚSCULAS, [^A-Z0-9]+ ⇒ un espacio,
-- sin prefijos de agregador (repetidos) y un prefijo solo ⇒ ''.
create or replace function pg_temp.vt_lmb_leyenda(p text)
returns text
language sql
immutable
as $fn$
  select case
           when s.t in ('MERPAGO', 'MERCADOPAGO', 'PINPE', 'CLIP', 'SR PAGO', 'SRPAGO',
                        'TPV', 'SEL', 'EC', 'ES', 'PAY', 'SPEI') then ''
           else s.t
         end
    from (select regexp_replace(
                   btrim(regexp_replace(
                     upper(translate(coalesce(p, ''),
                       'áéíóúüñàèìòùâêîôûäëïöçÁÉÍÓÚÜÑÀÈÌÒÙÂÊÎÔÛÄËÏÖÇ',
                       'aeiouunaeiouaeiouaeiocAEIOUUNAEIOUAEIOUAEIOC')),
                     '[^A-Z0-9]+', ' ', 'g')),
                   '^((MERPAGO|MERCADOPAGO|PINPE|CLIP|SR PAGO|SRPAGO|TPV|SEL|EC|ES|PAY|SPEI) )+',
                   '') as t) s
$fn$;

-- Plazas que nombra una leyenda ya normalizada: espejo de
-- `ciudadesDe(expandirTokens(tokensTexto(…)))`. Los ÚNICOS sinónimos que
-- producen ciudades son ciudad ↔ código (CANCUN ↔ CUN, COZUMEL ↔ CZM…), así
-- que cada plaza se reduce a su código y «ASUR CANCUN» / «CUN» son la misma.
create or replace function pg_temp.vt_lmb_ciudades(p_dn text)
returns text[]
language sql
immutable
as $fn$
  select coalesce(array_agg(distinct s.c order by s.c), '{}'::text[])
    from (select case t
                   when 'CANCUN' then 'CUN'     when 'CUN' then 'CUN'
                   when 'COZUMEL' then 'CZM'    when 'CZM' then 'CZM'
                   when 'MERIDA' then 'MID'     when 'MID' then 'MID'
                   when 'CHETUMAL' then 'CTM'   when 'CTM' then 'CTM'
                   when 'CARMEN' then 'CME'     when 'CME' then 'CME'
                   when 'MINATITLAN' then 'MTT' when 'MTT' then 'MTT'
                 end as c
            from regexp_split_to_table(coalesce(p_dn, ''), ' ') as t) s
   where s.c is not null
$fn$;

-- Números sueltos (≥ 3 dígitos) de una leyenda ya normalizada: espejo de
-- `numerosDedupe` (folio, sucursal, operación).
create or replace function pg_temp.vt_lmb_numeros(p_dn text)
returns text[]
language sql
immutable
as $fn$
  select coalesce(array_agg(t order by t), '{}'::text[])
    from regexp_split_to_table(coalesce(p_dn, ''), ' ') as t
   where t ~ '^[0-9]{3,}$'
$fn$;

-- ¿Las leyendas nombran cosas DISTINTAS aunque se parezcan? Espejo de
-- `leyendasNombranDistinto`: dos plazas sin ninguna en común, o números de
-- los dos lados sin ningún par donde uno sea prefijo del otro («AUTOZONE
-- 7226» / «7227» sí; «355» / «35554» truncado no).
create or replace function pg_temp.vt_lmb_nombran_distinto(
  a_ciu text[], a_num text[], b_ciu text[], b_num text[])
returns boolean
language sql
immutable
as $fn$
  select (cardinality(a_ciu) > 0 and cardinality(b_ciu) > 0 and not (a_ciu && b_ciu))
      or (cardinality(a_num) > 0 and cardinality(b_num) > 0
          and not exists (select 1
                            from unnest(a_num) as x, unnest(b_num) as y
                           where starts_with(x, y) or starts_with(y, x)))
$fn$;

-- PLAN. Solo LEE public y arma las tablas temporales del plan; no borra
-- nada. El dry-run la llama para sacar el número y la HUELLA a autorizar, y
-- la limpieza la vuelve a correr bajo candado (misma foto que borra).
create or replace function pg_temp.vt_lmb_planear()
returns jsonb
language plpgsql
as $fn$
declare
  v_n integer;
  v_res jsonb;
begin
  -- 1) Universo: solo IMPORTADOS. Un movimiento MANUAL lo tecleó alguien a
  --    propósito: ni cuenta para la cantidad real ni se borra.
  drop table if exists pg_temp._lmb_mov;
  create temp table _lmb_mov on commit drop as
  select mb.id,
         mb.cuenta_bancaria_id,
         mb.fecha,
         mb.tipo::text as tipo,
         mb.monto,
         mb.created_at,
         mb.conciliado,
         (mb.gasto_id is not null or mb.cobro_id is not null
           or mb.cobro_grupo_id is not null or mb.ingreso_id is not null) as ligado,
         (mb.clasificacion_id is not null) as clasificado,
         coalesce(mb.estado_cuenta_id::text,
                  'LEGADO ' || (mb.created_at at time zone 'America/Cancun')::date::text) as importacion,
         pg_temp.vt_lmb_leyenda(mb.descripcion) as dn,
         null::text[] as ciu,
         null::text[] as num,
         mb.id::text as cluster
    from public.movimiento_bancario mb
   where mb.origen::text = 'IMPORTADO';
  update _lmb_mov set ciu = pg_temp.vt_lmb_ciudades(dn), num = pg_temp.vt_lmb_numeros(dn);
  create unique index on _lmb_mov (id);

  -- 2) Aristas: misma (cuenta, fecha, tipo, monto) y la MISMA leyenda según
  --    `nivelDescripcionDedupe` del API: iguales, o (prefijo con lado corto
  --    ≥ 8, o mismos 12 primeros con lado corto ≥ 12) SIN nombrar plazas o
  --    números distintos («AEROPUERTO DE CANCUN» ≠ «… DE COZUMEL»). La
  --    REFERENCIA no participa (es la señal que falló): más conservador que
  --    el nivel 4 del importador, nunca más agresivo.
  drop table if exists pg_temp._lmb_arista;
  create temp table _lmb_arista on commit drop as
  select a.id as a, b.id as b
    from _lmb_mov a
    join _lmb_mov b
      on b.cuenta_bancaria_id = a.cuenta_bancaria_id
     and b.fecha = a.fecha
     and b.tipo = a.tipo
     and b.monto = a.monto
     and b.id <> a.id
   where a.dn = b.dn
      or (((least(length(a.dn), length(b.dn)) >= 8
            and (starts_with(a.dn, b.dn) or starts_with(b.dn, a.dn)))
           or (least(length(a.dn), length(b.dn)) >= 12
               and left(a.dn, 12) = left(b.dn, 12)))
          and not pg_temp.vt_lmb_nombran_distinto(a.ciu, a.num, b.ciu, b.num));

  -- 3) Clúster = componente conexo (la etiqueta mínima se propaga hasta
  --    que nada cambia).
  loop
    update _lmb_mov m
       set cluster = s.minimo
      from (select e.a as id, min(o.cluster) as minimo
              from _lmb_arista e
              join _lmb_mov o on o.id = e.b
             group by e.a) s
     where m.id = s.id
       and s.minimo < m.cluster;
    get diagnostics v_n = row_count;
    exit when v_n = 0;
  end loop;

  -- 4) Rango de fechas que trajo cada importación (de sus filas).
  drop table if exists pg_temp._lmb_rango;
  create temp table _lmb_rango on commit drop as
  select cuenta_bancaria_id, importacion, min(fecha) as desde, max(fecha) as hasta,
         count(*)::integer as filas
    from _lmb_mov
   group by 1, 2;

  -- 5) Cantidad REAL por clúster = máximo de filas de UNA importación. Solo
  --    vale si ALGUNA importación vio el día COMPLETO: el día cae DENTRO de
  --    su rango (no en la orilla), o es el día 1 del mes y la importación
  --    arranca ahí (periodo del estado de cuenta). En un día de ORILLA para
  --    todos (el lote del 17-jul terminó el 16-jul por la tarde y el PDF del
  --    27-jul empezó a media jornada del 16-jul: cada uno trae cargos que el
  --    otro no) el máximo puede SUBESTIMAR: el clúster queda DUDOSO, no se
  --    toca y va al reporte para que lo decida una persona.
  drop table if exists pg_temp._lmb_cluster;
  create temp table _lmb_cluster on commit drop as
  select t.cluster, t.cuenta_bancaria_id, t.fecha, t.tipo, t.monto,
         sum(t.n)::integer as filas,
         max(t.n)::integer as cantidad_real,
         count(*)::integer as importaciones,
         exists (select 1
                   from _lmb_rango r
                  where r.cuenta_bancaria_id = t.cuenta_bancaria_id
                    and ((r.desde < t.fecha and t.fecha < r.hasta)
                         or (r.desde = t.fecha
                             and t.fecha = date_trunc('month', t.fecha)::date
                             and r.hasta > t.fecha))) as dia_completo
    from (select cluster, cuenta_bancaria_id, fecha, tipo, monto, importacion, count(*) as n
            from _lmb_mov
           group by 1, 2, 3, 4, 5, 6) t
   group by 1, 2, 3, 4, 5;
  alter table _lmb_cluster add column dudoso boolean, add column cantidad_final integer;
  update _lmb_cluster
     set dudoso = (filas > cantidad_real and not dia_completo),
         cantidad_final = case when filas > cantidad_real and dia_completo
                               then cantidad_real else filas end;

  -- 6) Plan: sobreviven `cantidad_real` filas por prioridad (ligadas,
  --    clasificadas, conciliadas, más antiguas); las demás se borran. Los
  --    clústeres DUDOSOS no entran.
  drop table if exists pg_temp._lmb_plan;
  create temp table _lmb_plan on commit drop as
  select m.*, k.filas, k.cantidad_real,
         row_number() over (partition by m.cluster
                            order by m.ligado desc, m.clasificado desc, m.conciliado desc,
                                     m.created_at, m.id) as pos
    from _lmb_mov m
    join _lmb_cluster k using (cluster)
   where k.filas > k.cantidad_real
     and not k.dudoso;
  alter table _lmb_plan add column borrar boolean;
  update _lmb_plan set borrar = pos > cantidad_real;

  select jsonb_build_object(
           'borrar', count(*) filter (where p.borrar),
           'conciliadas', count(*) filter (where p.borrar and p.conciliado),
           'ligadas', count(*) filter (where p.borrar and p.ligado),
           'clusters', count(distinct p.cluster),
           'huella', md5(coalesce(string_agg(p.id::text, ',' order by p.id::text)
                                    filter (where p.borrar), '')))
    into v_res
    from _lmb_plan p;
  select v_res || jsonb_build_object(
           'dudosos', count(*),
           'dudosos_filas_de_mas', coalesce(sum(k.filas - k.cantidad_real), 0))
    into v_res
    from _lmb_cluster k
   where k.dudoso;
  return v_res;
end
$fn$;

create or replace function pg_temp.vt_limpiar_duplicados_movimiento_bancario(
  p_esperadas integer, p_huella text)
returns text
language plpgsql
as $fn$
declare
  v_plan jsonb;
  v_n integer;
  v_txt text;
  v_borrar integer;
  v_conciliadas integer;
  v_ligadas integer;
  v_clusters integer;
  v_dudosos integer;
  v_borradas integer;
  v_respaldo integer;
  v_gastos integer;
  v_ingresos integer;
begin
  if p_esperadas is null or p_huella is null then
    raise exception 'LIMPIEZA_ABORTADA: faltan el número de filas y la huella autorizados (salen del dry-run). No se escribió nada.';
  end if;

  -- Nadie importa, liga ni desliga movimientos mientras se decide qué se
  -- borra: el plan y el borrado ven la MISMA foto (las lecturas siguen).
  lock table public.movimiento_bancario in share row exclusive mode;

  v_plan := pg_temp.vt_lmb_planear();
  v_borrar := (v_plan ->> 'borrar')::integer;
  v_conciliadas := (v_plan ->> 'conciliadas')::integer;
  v_ligadas := (v_plan ->> 'ligadas')::integer;
  v_clusters := (v_plan ->> 'clusters')::integer;
  v_dudosos := (v_plan ->> 'dudosos')::integer;

  -- Tabla de gastos del plan (vacía si nada pierde liga): el dry-run la lee.
  drop table if exists pg_temp._lmb_gasto;
  create temp table _lmb_gasto (
    gasto_id uuid primary key,
    conciliado_antes boolean not null,
    tc_antes numeric,
    monto numeric not null,
    moneda text not null,
    conciliado_despues boolean,
    limpiar_tc boolean not null default false
  ) on commit drop;

  if v_borrar = 0 then
    return format('LIMPIEZA_SIN_CAMBIOS: ningún clúster seguro tiene más filas que su estado de cuenta más completo; no se tocó nada (%s clúster(es) dudoso(s) quedan para revisión manual).',
                  v_dudosos);
  end if;
  -- La HUELLA (md5 de los ids a borrar) ata la limpieza a EXACTAMENTE lo que
  -- el usuario vio en el dry-run: si entre tanto se importó, ligó o borró
  -- algo que cambia QUÉ filas se van (aunque no cuántas), aborta.
  if v_borrar <> p_esperadas or (v_plan ->> 'huella') <> p_huella then
    raise exception 'LIMPIEZA_ABORTADA: hoy se borrarían % filas (% conciliadas, % ligadas, % clústeres; huella %) y se autorizaron % (huella %): repite el dry-run y vuelve a autorizar. No se escribió nada.',
      v_borrar, v_conciliadas, v_ligadas, v_clusters, v_plan ->> 'huella', p_esperadas, p_huella;
  end if;

  -- 7) Gastos que pierden una liga: se bloquean y se fotografían ANTES.
  perform 1
     from public.gasto g
    where g.id in (select mb.gasto_id
                     from public.movimiento_bancario mb
                     join _lmb_plan p on p.id = mb.id and p.borrar
                    where mb.gasto_id is not null)
      for update of g;
  insert into _lmb_gasto (gasto_id, conciliado_antes, tc_antes, monto, moneda)
  select g.id, g.conciliado, g.tc_gasto, g.monto, g.moneda::text
    from public.gasto g
   where g.id in (select mb.gasto_id
                    from public.movimiento_bancario mb
                    join _lmb_plan p on p.id = mb.id and p.borrar
                   where mb.gasto_id is not null);

  -- 8) RESPALDO (nace con la limpieza; sin FK a propósito, como
  --    inventario_movimiento_eliminado: la historia sobrevive al borrado).
  create table if not exists public.movimiento_bancario_eliminado_20260929 (
    movimiento_id uuid primary key,
    cuenta_bancaria_id uuid not null,
    estado_cuenta_id uuid,
    fecha date not null,
    tipo text not null,
    monto numeric not null,
    descripcion text,
    referencia text,
    conciliado boolean not null,
    liga text check (liga in ('GASTO', 'COBRO', 'SOBRE', 'INGRESO', 'CLASIFICACION')),
    gasto_id uuid,
    cobro_id uuid,
    cobro_grupo_id uuid,
    ingreso_id uuid,
    clasificacion_id uuid,
    gasto_conciliado_antes boolean,
    gasto_tc_antes numeric,
    cluster text not null,
    filas_cluster integer not null,
    cantidad_real integer not null,
    sobrevivientes uuid[] not null,
    motivo text not null,
    snapshot jsonb not null,
    eliminado_at timestamptz not null default now()
  );
  comment on table public.movimiento_bancario_eliminado_20260929 is
    'Respaldo de la limpieza del 29-sep-2026 (migración 20260929000001): movimientos bancarios DUPLICADOS por re-importar estados de cuenta que se traslapaban (la referencia que lee la IA cambiaba entre lecturas). snapshot = fila COMPLETA; sobrevivientes = las filas del mismo clúster que se quedaron. Sin FK a propósito.';
  comment on column public.movimiento_bancario_eliminado_20260929.gasto_conciliado_antes is
    'Bandera conciliado del gasto ligado ANTES de la limpieza (null si la fila no tenía gasto). Con gasto_tc_antes es lo que usa el ROLLBACK de la migración.';
  alter table public.movimiento_bancario_eliminado_20260929 enable row level security;

  insert into public.movimiento_bancario_eliminado_20260929
    (movimiento_id, cuenta_bancaria_id, estado_cuenta_id, fecha, tipo, monto, descripcion,
     referencia, conciliado, liga, gasto_id, cobro_id, cobro_grupo_id, ingreso_id,
     clasificacion_id, gasto_conciliado_antes, gasto_tc_antes, cluster, filas_cluster,
     cantidad_real, sobrevivientes, motivo, snapshot)
  select mb.id, mb.cuenta_bancaria_id, mb.estado_cuenta_id, mb.fecha, mb.tipo::text, mb.monto,
         mb.descripcion, mb.referencia, mb.conciliado,
         case when mb.gasto_id is not null then 'GASTO'
              when mb.cobro_id is not null then 'COBRO'
              when mb.cobro_grupo_id is not null then 'SOBRE'
              when mb.ingreso_id is not null then 'INGRESO'
              when mb.clasificacion_id is not null then 'CLASIFICACION' end,
         mb.gasto_id, mb.cobro_id, mb.cobro_grupo_id, mb.ingreso_id, mb.clasificacion_id,
         g.conciliado_antes, g.tc_antes,
         p.cluster, p.filas, p.cantidad_real,
         (select array_agg(s.id order by s.pos) from _lmb_plan s
           where s.cluster = p.cluster and not s.borrar),
         format('Duplicado por re-importación: %s filas del %s por $%s para %s movimiento(s) real(es) (máximo de un mismo estado de cuenta)%s.',
                p.filas, to_char(mb.fecha, 'DD-MM-YYYY'), to_char(mb.monto, 'FM999,999,990.00'),
                p.cantidad_real,
                case when p.ligado then '; su liga era más nueva que las que sobreviven' else '' end),
         to_jsonb(mb)
    from public.movimiento_bancario mb
    join _lmb_plan p on p.id = mb.id and p.borrar
    left join _lmb_gasto g on g.gasto_id = mb.gasto_id;
  get diagnostics v_respaldo = row_count;

  -- 9) Ingresos que pierden su abono: bitácora DESCONCILIAR (espejo de
  --    linkIngreso; el ingreso no tiene bandera propia). Cobros de vuelo y
  --    sobres de grupo tampoco: su «conciliado» ES que exista la liga.
  insert into public.ingreso_bitacora (ingreso_id, accion, actor_id, diff, nota)
  select mb.ingreso_id, 'DESCONCILIAR', null,
         jsonb_build_object('movimiento_id', mb.id),
         format('abono del %s · $%s — duplicado borrado por la limpieza del 29-sep-2026',
                mb.fecha, to_char(mb.monto, 'FM999,999,990.00'))
    from public.movimiento_bancario mb
    join _lmb_plan p on p.id = mb.id and p.borrar
   where mb.ingreso_id is not null;
  get diagnostics v_ingresos = row_count;

  -- 10) BORRADO.
  delete from public.movimiento_bancario mb
   using _lmb_plan p
   where p.id = mb.id and p.borrar;
  get diagnostics v_borradas = row_count;
  if v_borradas <> v_borrar or v_respaldo <> v_borrar then
    raise exception 'LIMPIEZA_ABORTADA: plan % / respaldo % / borradas %; se revierte todo.',
      v_borrar, v_respaldo, v_borradas;
  end if;

  -- 11) Bandera de cada gasto que perdió una liga (regla EXACTA del API:
  --     `estadoConciliacion` + `cubreGasto`, tolerancia $1.00; un cargo de
  --     OTRA moneda es 1 ↔ 1 y cubre; sin cargos ⇒ false).
  update _lmb_gasto a
     set conciliado_despues = e.cubierto,
         limpiar_tc = (e.n = 0 and a.moneda = 'USD' and a.tc_antes is not null and a.monto > 0
                       and exists (select 1 from public.movimiento_bancario_eliminado_20260929 r
                                    join _lmb_plan p on p.id = r.movimiento_id and p.borrar
                                   where r.gasto_id = a.gasto_id
                                     and abs(a.tc_antes - abs(r.monto) / a.monto) < 0.001))
    from (select l.gasto_id,
                 count(mb.id) as n,
                 case when count(mb.id) filter (where c.moneda::text <> l.moneda) > 0 then true
                      when count(mb.id) = 0 then false
                      when round(abs(l.monto), 2) <= 0 then true
                      else round(coalesce(sum(abs(mb.monto)), 0), 2) >= round(abs(l.monto), 2) - 1.00
                 end as cubierto
            from _lmb_gasto l
            left join public.movimiento_bancario mb on mb.gasto_id = l.gasto_id
            left join public.cuenta_bancaria c on c.id = mb.cuenta_bancaria_id
           group by l.gasto_id, l.moneda, l.monto) e
   where e.gasto_id = a.gasto_id;

  update public.gasto g
     set conciliado = a.conciliado_despues,
         tc_gasto = case when a.limpiar_tc then null else g.tc_gasto end,
         updated_by = null            -- bitácora: actor null ⇒ «Sistema»
    from _lmb_gasto a
   where g.id = a.gasto_id
     and (g.conciliado is distinct from a.conciliado_despues or a.limpiar_tc);
  get diagnostics v_gastos = row_count;

  -- 12) AUTOVERIFICACIÓN (fail-loud: cualquier desvío revierte TODO).
  --     a) Cada clúster queda en su cantidad final: el seguro EXACTO en su
  --        cantidad real y el dudoso INTACTO.
  select count(*) into v_n
    from _lmb_cluster k
   where k.cantidad_final <> (select count(*)
                                from public.movimiento_bancario mb
                                join _lmb_mov m on m.id = mb.id
                               where m.cluster = k.cluster);
  if v_n > 0 then
    raise exception 'LIMPIEZA_ABORTADA: % clústeres no quedaron en su cantidad final; se revierte todo.', v_n;
  end if;
  --     b) Cada gasto tocado queda con la bandera de la regla.
  select count(*) into v_n
    from _lmb_gasto a
    join public.gasto g on g.id = a.gasto_id
   where g.conciliado is distinct from a.conciliado_despues;
  if v_n > 0 then
    raise exception 'LIMPIEZA_ABORTADA: % gastos quedaron con una bandera distinta de la regla; se revierte todo.', v_n;
  end if;
  --     c) COTA POR ARCHIVO: cada estado de cuenta leyó `total_movimientos`
  --        líneas distintas (conciliacion_import_job), así que en su(s)
  --        mes(es) tienen que quedar AL MENOS esas filas. Atrapa lo que el
  --        máximo por importación no ve: líneas que un importador anterior
  --        omitió como duplicadas (la importación del 29-sep leyó 207 y
  --        solo insertó 154) o un archivo nuevo que se «pegó» a copias que
  --        esta limpieza borra.
  select count(*), string_agg(format('%s: %s líneas, quedan %s', left(x.archivo, 8), x.lineas, x.quedan), '; ')
    into v_n, v_txt
    from (select a.id::text as archivo, j.total_movimientos as lineas,
                 (select count(*)
                    from public.movimiento_bancario mb
                   where mb.cuenta_bancaria_id = r.cuenta_bancaria_id
                     and mb.fecha >= date_trunc('month', r.desde)::date
                     and mb.fecha < (date_trunc('month', r.hasta) + interval '1 month')::date) as quedan
            from public.conciliacion_import_job j
            join lateral (select ea.id
                            from public.estado_cuenta_archivo ea
                           where ea.cuenta_bancaria_id = j.cuenta_bancaria_id
                             and ea.created_at between j.created_at and j.created_at + interval '2 minutes'
                           order by ea.created_at
                           limit 1) a on true
            join _lmb_rango r on r.importacion = a.id::text
           where j.tipo = 'IMPORT'
             and coalesce(j.total_movimientos, 0) > 0) x
   where x.quedan < x.lineas;
  if v_n > 0 then
    raise exception 'LIMPIEZA_ABORTADA: % estado(s) de cuenta quedarían con menos filas que las líneas que leyeron (%); se revierte todo.', v_n, v_txt;
  end if;

  return format('LIMPIEZA_OK: %s filas duplicadas borradas en %s clústeres (%s conciliadas, %s ligadas); %s gasto(s) recalculados, %s ingreso(s) desconciliados; %s clúster(es) dudoso(s) intactos para revisión manual; respaldo en movimiento_bancario_eliminado_20260929.',
                v_borradas, v_clusters, v_conciliadas, v_ligadas, v_gastos, v_ingresos, v_dudosos);
end
$fn$;

-- 2) EJECUCIÓN (NO va en el dry-run). Número Y huella son los que el usuario
--    autorizó con el ÚLTIMO dry-run; si hoy saldría otro plan, aborta sin
--    escribir.
select pg_temp.vt_limpiar_duplicados_movimiento_bancario(213, '53cdb3161bfbae3e34332ac077c9f746');
