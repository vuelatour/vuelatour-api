-- 1-oct-2026 · PAGOS DE UTILIDADES A SOCIOS (relación de pagos del reparto).
--
-- Pedido del cliente (captura de /admin/profit-sharing): «en el reparto de
-- utilidades, cada socio debe recibir los pagos de lo que generó el avión en
-- el mes, por ejemplo septiembre que acaba de cerrar debe venir ese monto y
-- debemos incluir un apartado donde siga algo como: Mauricio Roque, %, Monto
-- de utilidad, estatus de si ya se pagó o aún no, con cuánto se le pagó,
-- cuándo y quién se lo entregó, para llevar una relación de esos pagos y no
-- se nos escape ninguno». Diseño funcional 5.9: «Facturación de utilidades:
-- arreglo flexible (efectivo o factura asesoría profesional). Solo se reparte
-- lo cobrado».
--
-- QUÉ CREA (aditivo, sin backfill, sin enums, sin funciones nuevas):
--   public.reparto_pago — una fila por PAGO entregado a un socio de un avión
--   por la utilidad de un MES (periodo = día 1 del mes). La utilidad NO se
--   guarda aquí como fuente: se sigue CALCULANDO en vivo
--   (`ProfitSharingService.compute`); `utilidad_snapshot_usd` es solo la
--   FOTO de la utilidad del socio al registrar (para avisar si cambió).
--   `monto_usd` es lo que descuenta del pendiente (USD = monto; MXN =
--   round(monto / tc, 2), lo calcula el API — el CHECK solo amarra el caso
--   USD, el MXN no se reproduce en SQL a propósito: el redondeo de JS y el
--   de numeric pueden diferir en un empate de medio centavo).
--   `moneda` y `metodo` son TEXTO + CHECK, NO el enum public.moneda
--   (incidente del 15-sep-2026: «operator does not exist: public.moneda =
--   text»). tc_usd_mxn numeric(12,6) (invariante 20: 6 decimales).
--   SOFT DELETE (deleted_at/deleted_by/motivo_baja): TODO lector filtra
--   `deleted_at is null`. aeronave, socio y quien entregó ON DELETE RESTRICT
--   (la relación de pagos es dinero: no desaparece porque se borre un
--   usuario o un avión). client_request_id con índice ÚNICO parcial
--   (idempotencia de altas, patrón del repo; incluye las filas borradas: una
--   llave usada no se recicla — salvo la del alta que PERDIÓ una carrera
--   contra otra alta del mismo renglón: el API la da de baja, la libera y
--   responde 409 PAGO_EXCEDE_UTILIDAD para confirmar con la MISMA llave).
--   Bucket PRIVADO `reparto-comprobantes` (10 MB, foto o PDF; sin policies:
--   solo el API sube/firma con la service key). El API lo agrega a la lista
--   blanca de `POST /v1/storage/firmar` (ADMIN, FACTURACION, ANALISTA, SOCIO).
--
-- LO QUE NO CAMBIA: el cálculo del reparto (compute), el PDF/Excel, el
-- Libro Dinero y el balance. Un pago a socio NO es gasto ni toca ninguna
-- otra tabla.
--
-- EL API 0.0.49 ES DESPLEGABLE SIN ESTA MIGRACIÓN (sonda ÚNICA
-- `profit-sharing/reparto-pago.lector.ts`, tabla ausente 42P01/PGRST205,
-- re-sondeo ≤ 10 min): `GET /v1/profit-sharing/pagos` responde
-- `disponible:false` con listas vacías, el pre-cierre marca el aviso
-- `pagos_socios_pendientes` con `lectura_fallida` y las ESCRITURAS responden
-- 503 PAGOS_SOCIOS_NO_DISPONIBLE. Al aplicarla se enciende sola.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL, bucket y
-- filas) aunque la herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' o
-- CUALQUIER otro error (p. ej. 42883 «operator does not exist», un
-- not_null_violation inesperado) = NO aplicar. Tras el error DRYRUN_OK:
-- `select to_regclass('public.reparto_pago')` ⇒ NULL y `select count(*) from
-- storage.buckets where id = 'reparto-comprobantes'` ⇒ 0 (nada quedó).
--
--   do $dry$
--   declare
--     v_avion uuid; v_matricula text; v_socio uuid; v_socio_nombre text;
--     v_admin uuid; v_usd uuid; v_mxn uuid; v_key uuid;
--     v_n int; v_txt text; v_num numeric; v_upd timestamptz; v_ts timestamptz;
--     v_pub boolean;
--   begin
--     -- A) CONTEXTO: un socio VIGENTE en septiembre 2026 (de preferencia
--     --    N4142R, el de mayor %: Mauricio Roque 69 %) y un ADMIN activo.
--     if to_regclass('public.reparto_pago') is not null then
--       raise exception 'DRYRUN_FALLA A: reparto_pago YA existe (¿migración aplicada?)';
--     end if;
--     if exists (select 1 from storage.buckets where id = 'reparto-comprobantes') then
--       raise exception 'DRYRUN_FALLA A: el bucket reparto-comprobantes YA existe';
--     end if;
--     select a.id, a.matricula, s.socio_id into v_avion, v_matricula, v_socio
--       from public.aeronave_socio s
--       join public.aeronave a on a.id = s.aeronave_id
--      where s.vigente_desde <= date '2026-09-30'
--        and (s.vigente_hasta is null or s.vigente_hasta >= date '2026-09-01')
--      order by (a.matricula = 'N4142R') desc, s.porcentaje desc, s.id
--      limit 1;
--     select u.nombre into v_socio_nombre from public.usuario u where u.id = v_socio;
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--      order by u.created_at, u.id limit 1;
--     if v_avion is null or v_socio is null or v_admin is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto (avión/socio/admin)';
--     end if;
--     raise notice 'okA · % · socio % (%) · admin %', v_matricula, v_socio_nombre, v_socio, v_admin;
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN: pegar AQUÍ, TAL CUAL, la sección 1)
--     --    de abajo (sentencias SQL planas, válidas dentro de un bloque
--     --    plpgsql). NO una copia a mano.
--
--     -- C1) ESTRUCTURA: tabla, RLS sin policies, índices, trigger, FKs,
--     --     moneda TEXTO (no enum), TC con 6 decimales y bucket privado.
--     if to_regclass('public.reparto_pago') is null then
--       raise exception 'DRYRUN_FALLA C1: falta la tabla';
--     end if;
--     if not (select relrowsecurity from pg_class where oid = 'public.reparto_pago'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: RLS apagado';
--     end if;
--     if exists (select 1 from pg_policies where schemaname = 'public' and tablename = 'reparto_pago') then
--       raise exception 'DRYRUN_FALLA C1: la tabla trae policies (la API usa service key)';
--     end if;
--     if to_regclass('public.idx_reparto_pago_aeronave_socio_periodo') is null
--        or to_regclass('public.idx_reparto_pago_periodo') is null
--        or to_regclass('public.uq_reparto_pago_client_request') is null then
--       raise exception 'DRYRUN_FALLA C1: falta un índice';
--     end if;
--     if not (select indisunique from pg_index
--              where indexrelid = 'public.uq_reparto_pago_client_request'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: el índice de client_request_id no es único';
--     end if;
--     if not exists (select 1 from pg_trigger
--                     where tgrelid = 'public.reparto_pago'::regclass
--                       and tgname = 'trg_reparto_pago_set_updated_at') then
--       raise exception 'DRYRUN_FALLA C1: falta el trigger de updated_at';
--     end if;
--     select string_agg(conname || '=' || confdeltype::text, ',' order by conname) into v_txt
--       from pg_constraint
--      where conrelid = 'public.reparto_pago'::regclass and contype = 'f';
--     if v_txt is distinct from
--        'reparto_pago_aeronave_id_fkey=r,reparto_pago_created_by_fkey=n,reparto_pago_deleted_by_fkey=n,reparto_pago_entregado_por_fkey=r,reparto_pago_socio_id_fkey=r' then
--       raise exception 'DRYRUN_FALLA C1: FKs inesperadas: %', v_txt;
--     end if;
--     select data_type into v_txt from information_schema.columns
--      where table_schema = 'public' and table_name = 'reparto_pago' and column_name = 'moneda';
--     if v_txt is distinct from 'text' then
--       raise exception 'DRYRUN_FALLA C1: moneda debe ser text (es %)', v_txt;
--     end if;
--     select numeric_scale into v_n from information_schema.columns
--      where table_schema = 'public' and table_name = 'reparto_pago' and column_name = 'tc_usd_mxn';
--     if v_n is distinct from 6 then
--       raise exception 'DRYRUN_FALLA C1: tc_usd_mxn con % decimales (esperado 6)', v_n;
--     end if;
--     select public into v_pub from storage.buckets where id = 'reparto-comprobantes';
--     if v_pub is distinct from false then
--       raise exception 'DRYRUN_FALLA C1: el bucket no existe o es público (%)', v_pub;
--     end if;
--     raise notice 'okC1 · tabla, RLS, índices, trigger, FKs, moneda text, TC(12,6), bucket privado';
--
--     -- C2) ALTA USD REAL (lo que manda el API): N4142R 69 % de $2,023.10 =
--     --     $1,395.94 por transferencia, entregó el admin.
--     v_key := gen_random_uuid();
--     insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda,
--            tc_usd_mxn, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo,
--            referencia, entregado_por, client_request_id, created_by)
--     values (v_avion, v_socio, date '2026-09-01', 1395.94, 'USD', null, 1395.94, 1395.94,
--             date '2026-10-01', 'TRANSFERENCIA', 'SPEI 0012345', v_admin, v_key, v_admin)
--     returning id, created_at, updated_at into v_usd, v_ts, v_upd;
--     if v_ts is null or v_upd is null
--        or exists (select 1 from public.reparto_pago where id = v_usd
--                    and (deleted_at is not null or deleted_by is not null or motivo_baja is not null)) then
--       raise exception 'DRYRUN_FALLA C2: defaults de sellos/baja';
--     end if;
--     raise notice 'okC2 · alta USD real';
--
--     -- C3) ALTA MXN REAL con T.C. de 6 decimales: $10,000 MXN a 18.234567
--     --     = 548.41 USD (round(monto / tc, 2), lo calcula el API).
--     insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda,
--            tc_usd_mxn, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo,
--            entregado_por, recibido_por, factura_folio, created_by)
--     values (v_avion, v_socio, date '2026-09-01', 10000.00, 'MXN', 18.234567,
--             round(10000.00 / 18.234567, 2), 1395.94, date '2026-10-01', 'EFECTIVO',
--             v_admin, 'Contador del socio', 'A-123', v_admin)
--     returning id into v_mxn;
--     select tc_usd_mxn into v_num from public.reparto_pago where id = v_mxn;
--     if v_num <> 18.234567 then
--       raise exception 'DRYRUN_FALLA C3: el T.C. se truncó (%)', v_num;
--     end if;
--     select monto_usd into v_num from public.reparto_pago where id = v_mxn;
--     if v_num <> 548.41 then
--       raise exception 'DRYRUN_FALLA C3: monto_usd MXN = % (esperado 548.41)', v_num;
--     end if;
--     select sum(monto_usd) into v_num from public.reparto_pago
--      where aeronave_id = v_avion and socio_id = v_socio
--        and periodo = date '2026-09-01' and deleted_at is null;
--     if v_num <> 1944.35 then
--       raise exception 'DRYRUN_FALLA C3: pagado vivo = % (esperado 1944.35)', v_num;
--     end if;
--     raise notice 'okC3 · alta MXN real con TC de 6 decimales; pagado vivo 1,944.35';
--
--     -- C4) CHECKs / FKs / NOT NULL / ÚNICO (cada uno debe reventar)
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 100, 'MXN', 5.48, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: MXN sin TC'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, tc_usd_mxn, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 100, 'USD', 18.2, 100, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: USD con TC'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, tc_usd_mxn, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 100, 'MXN', 0, 5.48, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: TC 0'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-15', 100, 'USD', 100, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: periodo con día 15'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 0, 'USD', 0, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: monto 0'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, tc_usd_mxn, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 0.05, 'MXN', 18.2, 0, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: monto_usd 0'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 100, 'USD', 99, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: USD con monto_usd ≠ monto'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 100, 'USD', 100, 1, date '2026-10-01', 'DEPOSITO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: método inválido'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por)
--       values (v_avion, v_socio, date '2026-09-01', 100, 'EUR', 100, 1, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C4: moneda EUR'; exception when check_violation then null; end;
--     begin update public.reparto_pago set referencia = repeat('r', 121) where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: referencia de 121'; exception when check_violation then null; end;
--     begin update public.reparto_pago set recibido_por = repeat('r', 121) where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: recibido_por de 121'; exception when check_violation then null; end;
--     begin update public.reparto_pago set factura_folio = repeat('f', 61) where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: factura_folio de 61'; exception when check_violation then null; end;
--     begin update public.reparto_pago set notas = repeat('n', 501) where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: notas de 501'; exception when check_violation then null; end;
--     begin update public.reparto_pago set motivo_baja = 'sin baja' where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: motivo sin deleted_at'; exception when check_violation then null; end;
--     begin update public.reparto_pago set deleted_by = v_admin where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: deleted_by sin deleted_at'; exception when check_violation then null; end;
--     begin update public.reparto_pago set deleted_at = now(), motivo_baja = repeat('m', 301) where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: motivo de 301'; exception when check_violation then null; end;
--     begin update public.reparto_pago set aeronave_id = gen_random_uuid() where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: avión inexistente'; exception when foreign_key_violation then null; end;
--     begin update public.reparto_pago set socio_id = gen_random_uuid() where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: socio inexistente'; exception when foreign_key_violation then null; end;
--     begin update public.reparto_pago set entregado_por = null where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: entregado_por null'; exception when not_null_violation then null; end;
--     begin update public.reparto_pago set fecha_pago = null where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: fecha_pago null'; exception when not_null_violation then null; end;
--     begin update public.reparto_pago set utilidad_snapshot_usd = null where id = v_usd;
--       raise exception 'DRYRUN_FALLA C4: snapshot null'; exception when not_null_violation then null; end;
--     begin update public.reparto_pago set client_request_id = v_key where id = v_mxn;
--       raise exception 'DRYRUN_FALLA C4: client_request_id repetido'; exception when unique_violation then null; end;
--     raise notice 'okC4 · CHECKs/FKs/NOT NULL/único rechazan lo inválido';
--
--     -- C5) UPDATE REAL: updated_at se mueve; corregir monto; MXN → USD en
--     --     un solo UPDATE (tc a null); USD → MXN sin TC revienta.
--     update public.reparto_pago set updated_at = '2000-01-01' where id = v_usd;
--     select updated_at into v_upd from public.reparto_pago where id = v_usd;
--     if v_upd < '2001-01-01' then
--       raise exception 'DRYRUN_FALLA C5: tg_set_updated_at no corre en reparto_pago';
--     end if;
--     update public.reparto_pago set monto = 1000.00, monto_usd = 1000.00, notas = 'Primer pago parcial'
--      where id = v_usd;
--     update public.reparto_pago
--        set moneda = 'USD', tc_usd_mxn = null, monto = 548.41, monto_usd = 548.41
--      where id = v_mxn;
--     begin update public.reparto_pago set moneda = 'MXN' where id = v_mxn;
--       raise exception 'DRYRUN_FALLA C5: USD → MXN sin TC'; exception when check_violation then null; end;
--     update public.reparto_pago
--        set moneda = 'MXN', tc_usd_mxn = 18.234567, monto = 10000.00, monto_usd = 548.41
--      where id = v_mxn;
--     raise notice 'okC5 · updated_at, corregir monto, MXN ↔ USD';
--
--     -- C6) SOFT DELETE + LECTURAS DEL API: la fila se conserva, los
--     --     lectores (deleted_at is null) ya no la cuentan y su llave sigue
--     --     reservada.
--     update public.reparto_pago
--        set deleted_at = now(), deleted_by = v_admin, motivo_baja = 'Capturado dos veces'
--      where id = v_mxn and deleted_at is null;
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C6: el soft delete tocó % filas', v_n;
--     end if;
--     select count(*), sum(monto_usd) into v_n, v_num from public.reparto_pago
--      where aeronave_id = v_avion and socio_id = v_socio
--        and periodo = date '2026-09-01' and deleted_at is null;
--     if v_n <> 1 or v_num <> 1000.00 then
--       raise exception 'DRYRUN_FALLA C6: vivos % · pagado % (esperado 1 · 1000.00)', v_n, v_num;
--     end if;
--     select count(*) into v_n from public.reparto_pago where periodo = date '2026-09-01' and deleted_at is null;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C6: pagos vivos del mes = % (esperado 1)', v_n;
--     end if;
--     select count(*) into v_n from public.reparto_pago where aeronave_id = v_avion and socio_id = v_socio;
--     if v_n <> 2 then
--       raise exception 'DRYRUN_FALLA C6: el soft delete no conserva la fila (% filas)', v_n;
--     end if;
--     -- el pago MXN ya borrado conserva su llave: no se puede reusar.
--     update public.reparto_pago set client_request_id = gen_random_uuid() where id = v_mxn;
--     select client_request_id into v_key from public.reparto_pago where id = v_mxn;
--     begin
--       insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda, monto_usd, utilidad_snapshot_usd, fecha_pago, metodo, entregado_por, client_request_id)
--       values (v_avion, v_socio, date '2026-09-01', 1, 'USD', 1, 1, date '2026-10-01', 'EFECTIVO', v_admin, v_key);
--       raise exception 'DRYRUN_FALLA C6: la llave de un pago borrado se recicló';
--     exception when unique_violation then null; end;
--     raise notice 'okC6 · soft delete conserva la fila, lectores sin borradas, llave reservada';
--
--     raise exception 'DRYRUN_OK · % · socio % · C1 estructura · C2 alta USD · C3 alta MXN TC 6 dec · C4 checks/FK/único · C5 updates · C6 soft delete · todo se revierte', v_matricula, v_socio_nombre;
--   end $dry$;
--
-- TRAS APLICAR: `get_advisors` (esperado solo el INFO de «RLS sin policies»,
-- patrón del repo, y los de FK sin índice hacia usuario —socio_id,
-- entregado_por, created_by, deleted_by—, como en las demás tablas);
-- `select to_regclass('public.reparto_pago')` no nulo; `select public from
-- storage.buckets where id = 'reparto-comprobantes'` ⇒ false; sondear
-- `GET /v1/profit-sharing/pagos?mes=2026-09` (200 con `disponible: true`; la
-- sonda re-sondea en ≤ 10 min o reiniciar el API).
-- ORDEN DE DESPLIEGUE: tolerante en cualquier orden; RECOMENDADO API 0.0.49
-- → migración → panel (el panel tolera 404/503 con `disponible:false`).

-- ---------------------------------------------------------------------------
-- 1) PAGOS DE UTILIDADES A SOCIOS
-- ---------------------------------------------------------------------------
create table if not exists public.reparto_pago (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete restrict,
  socio_id uuid not null references public.usuario(id) on delete restrict,
  periodo date not null,
  monto numeric(12,2) not null,
  moneda text not null,
  tc_usd_mxn numeric(12,6),
  monto_usd numeric(12,2) not null,
  utilidad_snapshot_usd numeric(12,2) not null,
  fecha_pago date not null,
  metodo text not null,
  referencia text,
  entregado_por uuid not null references public.usuario(id) on delete restrict,
  recibido_por text,
  factura_folio text,
  comprobante_path text,
  notas text,
  client_request_id uuid,
  created_by uuid references public.usuario(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.usuario(id) on delete set null,
  motivo_baja text,
  constraint reparto_pago_periodo_chk check (extract(day from periodo) = 1),
  constraint reparto_pago_monto_chk check (monto > 0),
  constraint reparto_pago_moneda_chk check (moneda in ('USD', 'MXN')),
  constraint reparto_pago_tc_chk check (tc_usd_mxn is null or tc_usd_mxn > 0),
  constraint reparto_pago_tc_moneda_chk check ((moneda = 'MXN') = (tc_usd_mxn is not null)),
  constraint reparto_pago_monto_usd_chk check (monto_usd > 0),
  constraint reparto_pago_monto_usd_usd_chk check (moneda <> 'USD' or monto_usd = monto),
  constraint reparto_pago_metodo_chk check (
    metodo in ('EFECTIVO', 'TRANSFERENCIA', 'CHEQUE', 'OTRO')),
  constraint reparto_pago_referencia_chk check (
    referencia is null or char_length(referencia) <= 120),
  constraint reparto_pago_recibido_por_chk check (
    recibido_por is null or char_length(recibido_por) <= 120),
  constraint reparto_pago_factura_folio_chk check (
    factura_folio is null or char_length(factura_folio) <= 60),
  constraint reparto_pago_notas_chk check (
    notas is null or char_length(notas) <= 500),
  constraint reparto_pago_motivo_baja_chk check (
    motivo_baja is null or char_length(motivo_baja) <= 300),
  -- Quién y por qué solo existen si está dado de baja.
  constraint reparto_pago_baja_chk check (
    deleted_at is not null or (deleted_by is null and motivo_baja is null))
);

comment on table public.reparto_pago is
  'Pagos de utilidades a socios (1-oct-2026): una fila por pago entregado a un socio de un avión por la utilidad de un MES (periodo = día 1). La utilidad se calcula en vivo (profit-sharing compute); utilidad_snapshot_usd es la foto al registrar. Soft delete: todo lector filtra deleted_at is null. Sin enums: moneda/metodo son texto + CHECK.';
comment on column public.reparto_pago.periodo is
  'Mes que se paga: SIEMPRE el día 1 (CHECK). Septiembre 2026 = 2026-09-01.';
comment on column public.reparto_pago.monto_usd is
  'Lo que descuenta del pendiente del socio. USD = monto (CHECK); MXN = round(monto / tc_usd_mxn, 2), calculado por el API.';
comment on column public.reparto_pago.utilidad_snapshot_usd is
  'Utilidad del socio para ese avión y mes según el reparto al momento de registrar (o de corregir el monto). Solo para avisar si la utilidad cambió después.';
comment on column public.reparto_pago.entregado_por is
  'Usuario que entregó el dinero (default: quien registra). Debe ser usuario ACTIVO al registrar.';
comment on column public.reparto_pago.recibido_por is
  'Nombre de quien recibió el pago cuando no fue el socio.';
comment on column public.reparto_pago.factura_folio is
  'Folio de la factura cuando el socio cobra con factura (asesoría profesional).';
comment on column public.reparto_pago.comprobante_path is
  'Llave del comprobante en el bucket privado reparto-comprobantes (el anterior se conserva en el bucket al reemplazarlo).';
comment on column public.reparto_pago.client_request_id is
  'Llave de idempotencia del alta (índice único parcial; incluye las filas borradas: una llave usada no se recicla, salvo la del alta dada de baja por carrera de altas, que el API libera).';

create index if not exists idx_reparto_pago_aeronave_socio_periodo
  on public.reparto_pago (aeronave_id, socio_id, periodo)
  where deleted_at is null;

create index if not exists idx_reparto_pago_periodo
  on public.reparto_pago (periodo)
  where deleted_at is null;

create unique index if not exists uq_reparto_pago_client_request
  on public.reparto_pago (client_request_id)
  where client_request_id is not null;

alter table public.reparto_pago enable row level security;

drop trigger if exists trg_reparto_pago_set_updated_at on public.reparto_pago;
create trigger trg_reparto_pago_set_updated_at
  before update on public.reparto_pago
  for each row execute function public.tg_set_updated_at();

-- Bucket PRIVADO del comprobante (solo el API sube/firma con service key; sin policies).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values ('reparto-comprobantes', 'reparto-comprobantes', false, 10485760,
        array['image/jpeg','image/png','image/webp','image/heic','image/heif','application/pdf'])
on conflict (id) do nothing;

-- ---------------------------------------------------------------------------
-- ROLLBACK (pierde la relación de pagos: exportarla antes):
--   1) drop table if exists public.reparto_pago;
--   2) El BUCKET NO se borra con un DELETE directo: `storage.buckets` tiene el
--      trigger `protect_buckets_delete` (BEFORE DELETE … storage.protect_delete())
--      que lanza 42501 «Direct deletion from storage tables is not allowed.
--      Use the Storage API instead.» aunque esté vacío (verificado en prod el
--      1-oct-2026). Vaciarlo y borrarlo con la STORAGE API (service key):
--      dashboard → Storage → reparto-comprobantes → «Empty bucket» y luego
--      «Delete bucket», o supabase-js:
--        await sb.storage.emptyBucket('reparto-comprobantes');
--        await sb.storage.deleteBucket('reparto-comprobantes');
--      Solo si no hay otra salida, en SQL y con el bucket YA vacío (sin
--      objetos en storage.objects), en UNA transacción:
--        begin;
--        set local storage.allow_delete_query = 'true';
--        delete from storage.buckets where id = 'reparto-comprobantes';
--        commit;
-- El API 0.0.49 sigue funcionando sin la tabla (sonda ⇒ disponible:false /
-- 503 PAGOS_SOCIOS_NO_DISPONIBLE).
-- ---------------------------------------------------------------------------
