-- 30-sep-2026 · REVERSOS: un CARGO que el banco DEVOLVIÓ y su ABONO de
-- devolución se concilian JUNTOS (se anulan: no son gasto ni ingreso).
--
-- Pregunta del cliente (captura de Conciliación · GASTOS GNRAL): «¿Cómo
-- puedo conciliar los cargos reembolsados?». Caso real en prod (cuenta
-- 76a931e0…): el 21-sep hay 8 CARGOS «ASUR CANCUN» de $825.13 (1 ya
-- conciliado con su gasto, 7 pendientes «sin candidato») y el 23-sep 7
-- ABONOS «CARGO INDEBIDO 21 SEP 355xx» de $825.13 (los 7 con la MISMA
-- referencia 00000000001303268115). Hasta hoy la única salida era
-- «Clasificar (no es de un vuelo)» a mano en cada uno de los 14.
--
-- QUÉ CREA (aditivo, sin backfill):
--   movimiento_bancario.reverso_de_id uuid → movimiento_bancario(id)
--     ON DELETE SET NULL. Va en el ABONO y apunta al CARGO que devuelve.
--   uq_mov_bancario_reverso_de: índice ÚNICO parcial (where not null): un
--     cargo se devuelve UNA sola vez (y es el índice de la búsqueda inversa
--     «¿quién devolvió este cargo?»).
--   tg_mov_bancario_reverso (BEFORE INSERT/UPDATE OF reverso_de_id, tipo,
--     monto, cuenta_bancaria_id, gasto_id, cobro_id, cobro_grupo_id,
--     ingreso_id): el candado de verdad —espejo en el API:
--     `reverso-cruce.util#motivoParInvalido`—. Lanza 23514 con prefijo
--     `REVERSO_INVALIDO:` y el API lo traduce a 409 REVERSO_INVALIDO.
--     (1) Lado ABONO (la fila trae reverso_de_id): la fila es ABONO, sin
--         gasto/cobro/sobre/ingreso; el destino es CARGO de la MISMA cuenta,
--         MISMO monto (±0.005), sin gasto/cobro/sobre/ingreso, sin
--         reverso propio y sin otra devolución. `for update` sobre el
--         cargo: dos emparejados (o un emparejado y una liga a gasto) del
--         mismo cargo se serializan.
--     (2) Lado CARGO (la fila es destino de una devolución): no se le
--         cambia tipo, monto, cuenta ni se liga a gasto/cobro/sobre/
--         ingreso mientras esté emparejado (se quita el par primero).
--   `tipo` es ENUM (tipo_movimiento_bancario) ⇒ en plpgsql SIEMPRE `::text`
--   (incidente del ENUM `moneda` del 15-sep-2026). Aquí no hay `moneda`.
--   SECURITY INVOKER + search_path '' (el API usa service key; ningún rol
--   con RLS escribe esta tabla). Depende de la columna `ingreso_id`
--   (migración 20260924000004, APLICADA el 24-sep).
--
-- LO QUE NO CAMBIA: ningún trigger existente (tg_mov_bancario_gasto_suma,
-- updated_at), los CHECK de la tabla, el dinero (los movimientos bancarios
-- no entran al Libro Dinero, al balance ni al reparto). Un INSERT normal del
-- importador (reverso_de_id null) no hace nada en el trigger.
--
-- EL API 0.0.44 ES DESPLEGABLE SIN ESTA MIGRACIÓN (sonda única
-- `common/reverso-disponible.util`, columna `reverso_de_id`, re-sondeo
-- ≤ 10 min): la conciliación, el re-cruce, la importación, la lista y el
-- reporte responden como el 0.0.43 y las rutas nuevas
-- (`…/reverso-candidatos`, `…/reverso`, `reversos/auto`) responden 503
-- REVERSOS_NO_DISPONIBLE. Al aplicarla se enciende sola, sin redeploy.
--
-- ⚠ PENDIENTE DE APLICAR (la aplica el orquestador). DRY-RUN corrido en PROD
-- el 30-sep-2026 (una sola sentencia autoabortada, sin los `raise notice`):
-- «DRYRUN_OK · par REAL (abono 35d5c5eb…, cargo 2baee742…) · cobro libre t ·
-- gasto libre t · pendientes 271 · C1…C6 · todo se revierte» — C3h/C3i/C3l
-- corrieron con un cobro y un gasto REALES libres. Después: columna 0,
-- función 0, índice 0, 0 filas DRYRUN, 271 pendientes en GASTOS GNRAL y 0
-- usos de «Reverso de un cargo» (nada quedó escrito).
-- RE-CORRIDO en la revisión adversaria (30-sep-2026) con el CAS COMPLETO
-- que ahora escribe el API en C2 (abono sin gasto/cobro/sobre/
-- clasificación/ingreso): mismo DRYRUN_OK con el par REAL (abono 35d5c5eb…,
-- cargo 2baee742…), y después columna 0, función 0, índice 0, 0 filas
-- DRYRUN, 271 pendientes, 0 usos. Nota: `monto` es numeric(14,2), así que
-- el 100.004 de C5 se guarda como 100.00 (la tolerancia ±0.005 del trigger
-- solo importa si algún día cambia la escala).
-- Además, la revisión NO cambió el trigger; cambió el API: freno de cargos
-- ya ligados a gasto en el emparejado automático, CAS completo, reintento
-- que completa un par a medias y devoluciones fuera del cruce contra
-- cobros (ver CLAUDE.md invariante 33).
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL incluido)
-- aunque la herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' u otro
-- error = NO aplicar. Después: `select count(*) from information_schema.columns
-- where table_name = 'movimiento_bancario' and column_name = 'reverso_de_id'`
-- ⇒ 0 (nada quedó escrito).
--
--   do $dry$
--   declare
--     v_cuenta uuid; v_monto numeric; v_fecha date;
--     v_abono1 uuid; v_abono2 uuid; v_cargo1 uuid; v_cargo2 uuid;
--     v_cuenta_otra uuid; v_cargo_gasto uuid; v_cg_cuenta uuid; v_cg_monto numeric;
--     v_clasif uuid; v_cobro uuid; v_gasto uuid; v_s1 uuid; v_s2 uuid;
--     v_n int; v_txt text; v_real boolean := true;
--     v_pend_antes int; v_pend_despues int;
--   begin
--     -- A) CONTEXTO: el par REAL de prod si existe (devolución «CARGO
--     --    INDEBIDO» pendiente con un cargo pendiente de la misma cuenta y
--     --    monto en los 60 días previos); si no, uno sintético.
--     if exists (select 1 from information_schema.columns
--                 where table_schema = 'public' and table_name = 'movimiento_bancario'
--                   and column_name = 'reverso_de_id') then
--       raise exception 'DRYRUN_FALLA A: reverso_de_id YA existe (¿migración aplicada?)';
--     end if;
--     select a.id, a.cuenta_bancaria_id, a.monto, a.fecha
--       into v_abono1, v_cuenta, v_monto, v_fecha
--       from public.movimiento_bancario a
--      where a.tipo::text = 'ABONO' and a.conciliado = false
--        and a.gasto_id is null and a.cobro_id is null and a.cobro_grupo_id is null
--        and a.ingreso_id is null and a.clasificacion_id is null
--        and a.descripcion ilike 'CARGO INDEBIDO%'
--        and (select count(*) from public.movimiento_bancario c
--              where c.tipo::text = 'CARGO' and c.conciliado = false
--                and c.gasto_id is null and c.cobro_id is null and c.cobro_grupo_id is null
--                and c.ingreso_id is null and c.clasificacion_id is null
--                and c.cuenta_bancaria_id = a.cuenta_bancaria_id
--                and abs(c.monto - a.monto) <= 0.005
--                and c.fecha between a.fecha - 60 and a.fecha) >= 2
--      order by a.fecha, a.created_at, a.id
--      limit 1;
--     if v_abono1 is null then
--       v_real := false;
--       select id into v_cuenta from public.cuenta_bancaria order by created_at limit 1;
--       v_monto := 825.13; v_fecha := date '2026-09-23';
--       insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion)
--       values (v_cuenta, date '2026-09-21', 'CARGO', v_monto, 'ASUR CANCUN'),
--              (v_cuenta, date '2026-09-21', 'CARGO', v_monto, 'ASUR CANCUN');
--       insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion)
--       values (v_cuenta, v_fecha, 'ABONO', v_monto, 'CARGO INDEBIDO 21 SEP 1')
--       returning id into v_abono1;
--     end if;
--     select c.id into v_cargo1 from public.movimiento_bancario c
--      where c.tipo::text = 'CARGO' and c.conciliado = false and c.gasto_id is null
--        and c.cobro_id is null and c.cobro_grupo_id is null and c.ingreso_id is null
--        and c.clasificacion_id is null and c.cuenta_bancaria_id = v_cuenta
--        and abs(c.monto - v_monto) <= 0.005 and c.fecha between v_fecha - 60 and v_fecha
--      order by c.fecha, c.created_at, c.id limit 1;
--     select c.id into v_cargo2 from public.movimiento_bancario c
--      where c.tipo::text = 'CARGO' and c.conciliado = false and c.gasto_id is null
--        and c.cobro_id is null and c.cobro_grupo_id is null and c.ingreso_id is null
--        and c.clasificacion_id is null and c.cuenta_bancaria_id = v_cuenta
--        and abs(c.monto - v_monto) <= 0.005 and c.fecha between v_fecha - 60 and v_fecha
--        and c.id <> v_cargo1
--      order by c.fecha, c.created_at, c.id limit 1;
--     select a.id into v_abono2 from public.movimiento_bancario a
--      where a.tipo::text = 'ABONO' and a.conciliado = false and a.id <> v_abono1
--        and a.cuenta_bancaria_id = v_cuenta and abs(a.monto - v_monto) <= 0.005
--        and a.gasto_id is null and a.cobro_id is null and a.cobro_grupo_id is null
--        and a.ingreso_id is null and a.clasificacion_id is null
--      order by a.fecha, a.created_at, a.id limit 1;
--     if v_abono2 is null then
--       insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion)
--       values (v_cuenta, v_fecha, 'ABONO', v_monto, 'CARGO INDEBIDO 21 SEP 2')
--       returning id into v_abono2;
--     end if;
--     select id into v_cuenta_otra from public.cuenta_bancaria where id <> v_cuenta order by created_at limit 1;
--     select m.id, m.cuenta_bancaria_id, m.monto into v_cargo_gasto, v_cg_cuenta, v_cg_monto
--       from public.movimiento_bancario m
--      where m.tipo::text = 'CARGO' and m.gasto_id is not null
--      order by (m.cuenta_bancaria_id = v_cuenta) desc, m.fecha desc limit 1;
--     select id into v_clasif from public.conciliacion_clasificacion
--      where lower(nombre) = lower('Reverso de un cargo') limit 1;
--     if v_clasif is null then
--       insert into public.conciliacion_clasificacion (nombre) values ('Reverso de un cargo')
--       returning id into v_clasif;
--     end if;
--     select c.id into v_cobro from public.cobro_vuelo c
--      where not exists (select 1 from public.movimiento_bancario m where m.cobro_id = c.id)
--      limit 1;
--     select g.id into v_gasto from public.gasto g
--      where g.moneda::text = (select cb.moneda::text from public.cuenta_bancaria cb where cb.id = v_cuenta)
--        and g.monto >= v_monto + 1.00
--        and not exists (select 1 from public.movimiento_bancario m where m.gasto_id = g.id)
--      limit 1;
--     if v_cargo1 is null or v_cargo2 is null or v_cuenta_otra is null or v_cargo_gasto is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto (cargo1 %, cargo2 %, otra cuenta %, cargo con gasto %)',
--         v_cargo1, v_cargo2, v_cuenta_otra, v_cargo_gasto;
--     end if;
--     select count(*) into v_pend_antes from public.movimiento_bancario
--      where conciliado = false and cuenta_bancaria_id = v_cuenta;
--     raise notice 'okA · par % (abono %, cargo %), abono2 %, cargo2 %, cargo con gasto %, cobro libre %, gasto libre %, pendientes %',
--       case when v_real then 'REAL' else 'sintético' end, v_abono1, v_cargo1, v_abono2, v_cargo2,
--       v_cargo_gasto, v_cobro, v_gasto, v_pend_antes;
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN: pegar AQUÍ, TAL CUAL, la sección 1)
--     --    de abajo (sentencias SQL planas, válidas dentro de un bloque
--     --    plpgsql). NO una copia a mano.
--
--     -- C1) ESTRUCTURA
--     if (select confdeltype::text from pg_constraint
--          where conname = 'movimiento_bancario_reverso_de_id_fkey') is distinct from 'n' then
--       raise exception 'DRYRUN_FALLA C1: la FK no es ON DELETE SET NULL';
--     end if;
--     if not exists (select 1 from pg_index i join pg_class c on c.oid = i.indexrelid
--                     where c.relname = 'uq_mov_bancario_reverso_de' and i.indisunique
--                       and pg_get_expr(i.indpred, i.indrelid) ilike '%reverso_de_id IS NOT NULL%') then
--       raise exception 'DRYRUN_FALLA C1: falta el índice ÚNICO parcial';
--     end if;
--     if not exists (select 1 from pg_trigger where tgrelid = 'public.movimiento_bancario'::regclass
--                     and tgname = 'trg_mov_bancario_reverso' and not tgisinternal) then
--       raise exception 'DRYRUN_FALLA C1: falta el trigger';
--     end if;
--     raise notice 'okC1 · FK set null, índice único parcial, trigger';
--
--     -- C2) CASO FELIZ con UPDATE REALES (lo que escribe el API: abono y luego cargo, con CAS)
--     update public.movimiento_bancario
--        set reverso_de_id = v_cargo1, clasificacion_id = v_clasif, conciliado = true,
--            gasto_id = null, cobro_id = null, cobro_grupo_id = null, ingreso_id = null,
--            notas = 'Devuelve el cargo del 21-09 · ASUR CANCUN'
--      where id = v_abono1 and conciliado = false and reverso_de_id is null
--        and gasto_id is null and cobro_id is null and cobro_grupo_id is null
--        and clasificacion_id is null and ingreso_id is null;
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA C2: el abono no se emparejó (%)', v_n; end if;
--     update public.movimiento_bancario
--        set clasificacion_id = v_clasif, conciliado = true, notas = 'Devuelto el 23-09 · CARGO INDEBIDO'
--      where id = v_cargo1 and conciliado = false and gasto_id is null and clasificacion_id is null;
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then raise exception 'DRYRUN_FALLA C2: el cargo no se concilió (%)', v_n; end if;
--     if not exists (select 1 from public.movimiento_bancario
--                     where id = v_abono1 and reverso_de_id = v_cargo1 and conciliado) then
--       raise exception 'DRYRUN_FALLA C2: el par no quedó escrito';
--     end if;
--     raise notice 'okC2 · abono % ↔ cargo % conciliados', v_abono1, v_cargo1;
--
--     -- C3) RECHAZOS DEL TRIGGER (cada uno debe reventar con REVERSO_INVALIDO)
--     begin update public.movimiento_bancario set reverso_de_id = v_cargo1 where id = v_abono2;
--       raise exception 'DRYRUN_FALLA C3a: doble devolución del mismo cargo';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%' then raise exception 'DRYRUN_FALLA C3a: %', sqlerrm; end if; end;
--     begin update public.movimiento_bancario set reverso_de_id = v_cargo1 where id = v_cargo2;
--       raise exception 'DRYRUN_FALLA C3b: un CARGO como devolución';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%ABONO%' then raise exception 'DRYRUN_FALLA C3b: %', sqlerrm; end if; end;
--     begin update public.movimiento_bancario set reverso_de_id = v_abono1 where id = v_abono2;
--       raise exception 'DRYRUN_FALLA C3c: devolver un ABONO';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%CARGO%' then raise exception 'DRYRUN_FALLA C3c: %', sqlerrm; end if; end;
--     begin update public.movimiento_bancario set reverso_de_id = v_abono2 where id = v_abono2;
--       raise exception 'DRYRUN_FALLA C3d: su propia devolución';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%' then raise exception 'DRYRUN_FALLA C3d: %', sqlerrm; end if; end;
--     begin insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, reverso_de_id)
--       values (v_cuenta_otra, v_fecha, 'ABONO', v_monto, 'DEVOLUCION', v_cargo2);
--       raise exception 'DRYRUN_FALLA C3e: otra cuenta';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%cuenta%' then raise exception 'DRYRUN_FALLA C3e: %', sqlerrm; end if; end;
--     begin insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, reverso_de_id)
--       values (v_cuenta, v_fecha, 'ABONO', v_monto + 0.01, 'DEVOLUCION', v_cargo2);
--       raise exception 'DRYRUN_FALLA C3f: otro monto';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%monto%' then raise exception 'DRYRUN_FALLA C3f: %', sqlerrm; end if; end;
--     begin insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, reverso_de_id)
--       values (v_cg_cuenta, v_fecha, 'ABONO', v_cg_monto, 'DEVOLUCION', v_cargo_gasto);
--       raise exception 'DRYRUN_FALLA C3g: cargo ligado a un gasto';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%gasto%' then raise exception 'DRYRUN_FALLA C3g: %', sqlerrm; end if; end;
--     if v_cobro is not null then
--       begin update public.movimiento_bancario set cobro_id = v_cobro where id = v_abono1;
--         raise exception 'DRYRUN_FALLA C3h: ligar un cobro a la devolución';
--       exception when check_violation then
--         if sqlerrm not like 'REVERSO_INVALIDO%' then raise exception 'DRYRUN_FALLA C3h: %', sqlerrm; end if; end;
--       begin update public.movimiento_bancario set cobro_id = v_cobro where id = v_cargo1;
--         raise exception 'DRYRUN_FALLA C3i: ligar un cobro al cargo devuelto';
--       exception when check_violation then
--         if sqlerrm not like 'REVERSO_INVALIDO%emparejado%' then raise exception 'DRYRUN_FALLA C3i: %', sqlerrm; end if; end;
--     else
--       raise notice 'skipC3h/i · no hay cobro libre';
--     end if;
--     begin update public.movimiento_bancario set monto = monto + 1 where id = v_cargo1;
--       raise exception 'DRYRUN_FALLA C3j: cambiar el monto del cargo devuelto';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%emparejado%' then raise exception 'DRYRUN_FALLA C3j: %', sqlerrm; end if; end;
--     begin update public.movimiento_bancario set tipo = 'ABONO' where id = v_cargo1;
--       raise exception 'DRYRUN_FALLA C3k: cambiar el tipo del cargo devuelto';
--     exception when check_violation then
--       if sqlerrm not like 'REVERSO_INVALIDO%emparejado%' then raise exception 'DRYRUN_FALLA C3k: %', sqlerrm; end if; end;
--     if v_gasto is not null then
--       begin update public.movimiento_bancario set gasto_id = v_gasto where id = v_cargo1;
--         raise exception 'DRYRUN_FALLA C3l: ligar un gasto al cargo devuelto';
--       exception when check_violation then
--         if sqlerrm not like 'REVERSO_INVALIDO%emparejado%' then raise exception 'DRYRUN_FALLA C3l: %', sqlerrm; end if; end;
--     else
--       raise notice 'skipC3l · no hay gasto libre de ese monto';
--     end if;
--     raise notice 'okC3 · doble, tipo, destino, propio, cuenta, monto, cargo con gasto, cobro/monto/tipo/gasto sobre el par';
--
--     -- C4) DESEMPAREJAR (lo que escribe el API) y RE-EMPAREJAR: los dos pendientes
--     update public.movimiento_bancario
--        set reverso_de_id = null, clasificacion_id = null, conciliado = false, notas = null
--      where id = v_abono1 and reverso_de_id = v_cargo1;
--     update public.movimiento_bancario set clasificacion_id = null, conciliado = false, notas = null
--      where id = v_cargo1 and gasto_id is null;
--     select count(*) into v_pend_despues from public.movimiento_bancario
--      where conciliado = false and cuenta_bancaria_id = v_cuenta;
--     if v_pend_despues <> v_pend_antes then
--       raise exception 'DRYRUN_FALLA C4: pendientes % ≠ %', v_pend_despues, v_pend_antes;
--     end if;
--     update public.movimiento_bancario set monto = monto where id = v_cargo1;  -- libre: ya no rebota
--     update public.movimiento_bancario
--        set reverso_de_id = v_cargo1, clasificacion_id = v_clasif, conciliado = true
--      where id = v_abono2;  -- el índice único quedó libre
--     raise notice 'okC4 · desemparejar deja los dos pendientes; el cargo acepta otra devolución';
--
--     -- C5) TOLERANCIA (±0.005) y ON DELETE SET NULL con un par sintético
--     insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion)
--     values (v_cuenta, v_fecha, 'CARGO', 100.00, 'DRYRUN CARGO') returning id into v_s1;
--     insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, reverso_de_id, conciliado)
--     values (v_cuenta, v_fecha, 'ABONO', 100.004, 'DRYRUN DEVOLUCION', v_s1, true) returning id into v_s2;
--     delete from public.movimiento_bancario where id = v_s1;
--     if (select reverso_de_id from public.movimiento_bancario where id = v_s2) is not null then
--       raise exception 'DRYRUN_FALLA C5: el borrado del cargo no soltó la devolución';
--     end if;
--     raise notice 'okC5 · tolerancia 0.004 aceptada; ON DELETE SET NULL';
--
--     -- C6) LECTORES: «Por conciliar» (abonos pendientes) ya no ve la devolución emparejada
--     if exists (select 1 from public.movimiento_bancario
--                 where id = v_abono2 and tipo::text = 'ABONO' and conciliado = false) then
--       raise exception 'DRYRUN_FALLA C6: el abono emparejado sigue en «Por conciliar»';
--     end if;
--     raise notice 'okC6 · Por conciliar excluye la devolución emparejada';
--
--     raise exception 'DRYRUN_OK · par % (abono %, cargo %) · cobro libre % · gasto libre % · pendientes % · C1 estructura · C2 caso feliz · C3 rechazos · C4 desemparejar · C5 tolerancia y set null · C6 lectores · todo se revierte',
--       case when v_real then 'REAL' else 'sintético' end, v_abono1, v_cargo1,
--       v_cobro is not null, v_gasto is not null, v_pend_antes;
--   end $dry$;
--
-- TRAS APLICAR: `get_advisors` (sin hallazgos nuevos esperados: función
-- INVOKER con search_path fijo y `revoke execute`); sondear
-- `GET /v1/conciliacion/movimientos/<abono>/reverso-candidatos` (200, no
-- 503; la sonda re-sondea en ≤ 10 min o reiniciar el API) y, si la oficina
-- quiere, «Emparejar devoluciones» en GASTOS GNRAL (esperado: 7 pares del
-- 21/23-sep).
-- ORDEN DE DESPLIEGUE: indiferente (API tolerante). RECOMENDADO migración →
-- API 0.0.44 → panel.
-- ROLLBACK: drop trigger if exists trg_mov_bancario_reverso on
-- public.movimiento_bancario; drop function if exists
-- public.tg_mov_bancario_reverso(); alter table public.movimiento_bancario
-- drop column if exists reverso_de_id; (los pares quedan como movimientos
-- conciliados con la clasificación «Reverso de un cargo», sin liga entre sí).

-- ---------------------------------------------------------------------------
-- 1) CARGO DEVUELTO ↔ DEVOLUCIÓN
-- ---------------------------------------------------------------------------
alter table public.movimiento_bancario
  add column if not exists reverso_de_id uuid
    references public.movimiento_bancario(id) on delete set null;

comment on column public.movimiento_bancario.reverso_de_id is
  'Solo en un ABONO: el CARGO que el banco devolvió con este abono (30-sep-2026). Los dos quedan conciliados con la clasificación «Reverso de un cargo»; se anulan (no son gasto ni ingreso). Candado: trigger tg_mov_bancario_reverso (misma cuenta, mismo monto ±0.005, cargo sin gasto/cobro/ingreso). ON DELETE SET NULL.';

create unique index if not exists uq_mov_bancario_reverso_de
  on public.movimiento_bancario (reverso_de_id)
  where reverso_de_id is not null;

comment on index public.uq_mov_bancario_reverso_de is
  'Un cargo se devuelve UNA sola vez (y búsqueda inversa «¿qué abono devolvió este cargo?»). 20260930000001.';

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
      if new.gasto_id is not null or new.cobro_id is not null
         or new.cobro_grupo_id is not null or new.ingreso_id is not null then
        raise exception 'REVERSO_INVALIDO: el abono ya está conciliado con un gasto, cobro o ingreso'
          using errcode = '23514';
      end if;
      -- `for update`: un emparejado y una liga (o dos emparejados) del
      -- mismo cargo se serializan y el segundo ve al primero.
      select m.id, m.tipo::text as tipo, m.cuenta_bancaria_id, m.monto,
             m.gasto_id, m.cobro_id, m.cobro_grupo_id, m.ingreso_id,
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
      if v_cargo.gasto_id is not null or v_cargo.cobro_id is not null
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
  'Candado del par cargo devuelto ↔ devolución (movimiento_bancario.reverso_de_id, 30-sep-2026). 23514 con prefijo REVERSO_INVALIDO ⇒ el API responde 409. Espejo: reverso-cruce.util#motivoParInvalido.';

drop trigger if exists trg_mov_bancario_reverso on public.movimiento_bancario;
create trigger trg_mov_bancario_reverso
  before insert or update of reverso_de_id, tipo, monto, cuenta_bancaria_id,
    gasto_id, cobro_id, cobro_grupo_id, ingreso_id
  on public.movimiento_bancario
  for each row execute function public.tg_mov_bancario_reverso();

revoke execute on function public.tg_mov_bancario_reverso() from public, anon, authenticated;
