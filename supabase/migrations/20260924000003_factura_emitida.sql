-- 24-sep-2026 · FACTURAS EMITIDAS (registro manual) + SOLICITUD DE FACTURA
-- por vuelo + RESPONSABLES DE FACTURACIÓN.
--
-- Pedido 1 (Ale): «necesita las facturas emitidas … que haya una de facturas
-- emitidas para las que hace Mari manualmente … por orden del número de la
-- factura … saber que ya están emitidas, que no hay unas duplicadas … Mari
-- las estaría adjuntando en PDF».
-- Pedido 2 (Itzi): «que haya algo que yo marque así como de necesito
-- factura … y a Mari le salga una alertita … el pendiente de factura».
--
-- QUÉ CREA (aditivo, sin backfill, sin funciones nuevas):
--   1. public.factura_emitida — una fila por factura emitida a mano. Número
--      = razón social emisora + serie + folio (único entre las NO borradas,
--      sin importar mayúsculas; una CANCELADA conserva su número). Hay DOS
--      razones sociales (Aero Charter Cancún y Aerodinámica de Monterrey) y
--      cada una lleva su numeración: sin la emisora en la llave, la A-15 de
--      una bloquearía la A-15 legítima de la otra. `emisora_id` NULL = «sin
--      emisora identificada» (el API trata ese caso como comodín al buscar
--      duplicados). UUID fiscal único entre las no borradas (global).
--      `folio_num` GENERADA = dígitos del folio (ordena por número:
--      'A-00123' ⇒ 123). `es_parcial` = anticipo/finiquito (varias facturas
--      vigentes para un vuelo es correcto y no se alerta). Los ARCHIVOS nunca
--      se borran del bucket: quitar/reemplazar deja rastro en
--      `archivos_historial` (el #297 perdió su PDF con un «Quitar»). Soft
--      delete (deleted_at + motivo_baja): TODO lector filtra `deleted_at is
--      null`.
--   2. public.factura_emitida_vuelo — puente N:M (una factura cubre varios
--      vuelos; un vuelo puede tener anticipo + finiquito o una re-emisión).
--      factura ON DELETE CASCADE; vuelo ON DELETE RESTRICT (un vuelo con
--      factura ligada no se borra por accidente: el API quita primero las
--      ligas de facturas CANCELADAS/borradas y rechaza con 409 si hay una
--      VIGENTE).
--   3. vuelo.factura_solicitada_at / _por / factura_solicitud_nota /
--      factura_paga_contra_factura — la SOLICITUD. «Por facturar» es
--      DERIVADO (nunca se guarda): solicitada AND vuelo no CANCELADO AND sin
--      factura_emitida VIGENTE ligada.
--   4. configuracion_sistema.valor_json (jsonb, arreglo) + fila
--      'responsables_facturacion' (uuids de usuario) sembrada con Mary Cruz si
--      existe y está activa; si no, '[]'.
--
-- LO QUE NO CAMBIA: la tabla `factura` y `vuelo.facturado` (CFDI del PAC); la
-- lista de columnas de `trg_vuelo_calendar_sync` (pedir factura NO reescribe
-- el evento de Google). Textos + CHECK en vez de enums nuevos (sin el
-- incidente del ENUM del 15-sep). `moneda` sí es public.moneda (ENUM): aquí
-- no hay plpgsql que la compare.
--
-- EL API 0.0.32 ES DESPLEGABLE SIN ESTA MIGRACIÓN: sonda `columnaOpcional`
-- de `vuelo.factura_solicitada_at` (re-sondeo ≤ 10 min). Sin ella: las rutas
-- /v1/facturas-emitidas/* y la solicitud responden 503
-- FACTURAS_EMITIDAS_NO_DISPONIBLE; snapshot/listas mandan `factura_servicio:
-- null`; Excel, etiquetas y vuelos siguen como hoy.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL incluido)
-- aunque la herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' = NO
-- aplicar. Tras el error DRYRUN_OK, comprobar `select
-- to_regclass('public.factura_emitida')` ⇒ NULL (nada quedó escrito).
--
--   do $dry$
--   declare
--     v_vuelo   uuid;  -- vuelo SIN cobros ni factura PAC (para probar RESTRICT)
--     v_vuelo2  uuid;  -- otro vuelo (UPDATE real de la solicitud)
--     v_admin   uuid;
--     v_em1 uuid; v_em2 uuid;   -- dos razones sociales emisoras (C3b)
--     v_f1 uuid; v_f2 uuid; v_f3 uuid;
--     v_con text; v_num numeric; v_upd timestamptz; v_n int;
--   begin
--     -- A) CONTEXTO
--     select v.id into v_vuelo from public.vuelo v
--      where v.estado::text <> 'CANCELADO'
--        and not exists (select 1 from public.cobro_vuelo c where c.vuelo_id = v.id)
--        and not exists (select 1 from public.factura f where f.vuelo_id = v.id)
--        and not exists (select 1 from public.gasto g where g.vuelo_id = v.id)
--      order by v.created_at desc limit 1;
--     select v.id into v_vuelo2 from public.vuelo v
--      where v.id <> v_vuelo and v.estado::text <> 'CANCELADO'
--      order by v.created_at desc limit 1;
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' limit 1;
--     if v_vuelo is null or v_vuelo2 is null or v_admin is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto (vuelo/vuelo2/admin)';
--     end if;
--     if to_regclass('public.factura_emitida') is not null then
--       raise exception 'DRYRUN_FALLA A: factura_emitida YA existe (¿migración aplicada?)';
--     end if;
--     select e.id into v_em1 from public.entidad_fiscal_emisora e order by e.created_at, e.id limit 1;
--     select e.id into v_em2 from public.entidad_fiscal_emisora e
--      where e.id <> v_em1 order by e.created_at, e.id limit 1;
--     raise notice 'okA · contexto (vuelo %, vuelo2 %, emisoras % / %)', v_vuelo, v_vuelo2, v_em1, v_em2;
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN: pegar AQUÍ, TAL CUAL, las secciones
--     --    1) a 5) de abajo (son sentencias SQL planas, válidas dentro de un
--     --    bloque plpgsql). NO una copia a mano.
--
--     -- C1) ESTRUCTURA
--     if to_regclass('public.factura_emitida') is null
--        or to_regclass('public.factura_emitida_vuelo') is null then
--       raise exception 'DRYRUN_FALLA C1: faltan tablas';
--     end if;
--     if not (select relrowsecurity from pg_class where oid = 'public.factura_emitida'::regclass)
--        or not (select relrowsecurity from pg_class where oid = 'public.factura_emitida_vuelo'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: RLS apagado';
--     end if;
--     if (select count(*) from information_schema.columns
--          where table_schema = 'public' and table_name = 'vuelo'
--            and column_name in ('factura_solicitada_at','factura_solicitada_por',
--                                'factura_solicitud_nota','factura_paga_contra_factura')) <> 4 then
--       raise exception 'DRYRUN_FALLA C1: faltan columnas de solicitud en vuelo';
--     end if;
--     if not exists (select 1 from public.configuracion_sistema
--                     where clave = 'responsables_facturacion'
--                       and jsonb_typeof(valor_json) = 'array') then
--       raise exception 'DRYRUN_FALLA C1: falta la fila responsables_facturacion';
--     end if;
--     raise notice 'okC1 · tablas, RLS, columnas y fila de config';
--
--     -- C2) INSERT VÁLIDO + folio_num
--     insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, subtotal, iva, metodo_pago, forma_pago, created_by)
--     values ('DRY', 'A-00123', current_date, 'USD', 116.00, 100.00, 16.00, 'PPD', '99', v_admin)
--     returning id, folio_num into v_f1, v_num;
--     if v_num is distinct from 123 then
--       raise exception 'DRYRUN_FALLA C2: folio_num de A-00123 = % (esperado 123)', v_num;
--     end if;
--     if (select estatus from public.factura_emitida where id = v_f1) <> 'VIGENTE' then
--       raise exception 'DRYRUN_FALLA C2: estatus default no es VIGENTE';
--     end if;
--     if (select es_parcial or jsonb_array_length(archivos_historial) <> 0
--           from public.factura_emitida where id = v_f1) then
--       raise exception 'DRYRUN_FALLA C2: defaults de es_parcial/archivos_historial';
--     end if;
--     raise notice 'okC2 · insert válido, folio_num 123, defaults';
--
--     -- C3) DUPLICADO serie+folio (sin importar mayúsculas) ⇒ unique_violation
--     begin
--       insert into public.factura_emitida (serie, folio, fecha_emision, total)
--       values ('dry', 'a-00123', current_date, 1);
--       raise exception 'DRYRUN_FALLA C3: entró el duplicado dry/a-00123';
--     exception when unique_violation then null;
--     end;
--     -- mismo folio con OTRA serie ⇒ entra; sin serie dos veces ⇒ el segundo NO
--     insert into public.factura_emitida (serie, folio, fecha_emision, total)
--     values ('DRY2', 'A-00123', current_date, 1) returning id into v_f2;
--     insert into public.factura_emitida (serie, folio, fecha_emision, total)
--     values (null, 'Z-9', current_date, 1);
--     begin
--       insert into public.factura_emitida (serie, folio, fecha_emision, total)
--       values (null, 'z-9', current_date, 1);
--       raise exception 'DRYRUN_FALLA C3: entró el duplicado sin serie z-9';
--     exception when unique_violation then null;
--     end;
--     raise notice 'okC3 · duplicados rechazados; otra serie y sin serie OK';
--
--     -- C3b) La numeración es POR RAZÓN SOCIAL: misma serie+folio con OTRA
--     --      emisora entra; con la MISMA emisora no.
--     if v_em2 is not null then
--       insert into public.factura_emitida (serie, folio, fecha_emision, total, emisora_id)
--       values ('DRY3', '1', current_date, 1, v_em1);
--       insert into public.factura_emitida (serie, folio, fecha_emision, total, emisora_id)
--       values ('DRY3', '1', current_date, 1, v_em2);
--       begin
--         insert into public.factura_emitida (serie, folio, fecha_emision, total, emisora_id)
--         values ('dry3', '1', current_date, 1, v_em1);
--         raise exception 'DRYRUN_FALLA C3b: entró el duplicado de la MISMA emisora';
--       exception when unique_violation then null;
--       end;
--       raise notice 'okC3b · número único por emisora + serie + folio';
--     else
--       raise notice 'skipC3b · hay menos de 2 emisoras: no se probó el alcance por emisora';
--     end if;
--
--     -- C4) SOFT DELETE libera el número
--     update public.factura_emitida
--        set deleted_at = now(), deleted_by = v_admin, motivo_baja = 'dry-run'
--      where id = v_f1;
--     insert into public.factura_emitida (serie, folio, fecha_emision, total)
--     values ('DRY', 'A-00123', current_date, 5) returning id into v_f3;
--     raise notice 'okC4 · tras soft delete la misma serie+folio vuelve a entrar';
--
--     -- C5) UUID: único entre no borradas; formato en MAYÚSCULAS
--     update public.factura_emitida set uuid = 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF' where id = v_f2;
--     begin
--       update public.factura_emitida set uuid = 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C5: entró el UUID duplicado';
--     exception when unique_violation then null;
--     end;
--     begin
--       update public.factura_emitida set uuid = 'd08b6837-a3b5-45af-96e1-36f07fba8fa0' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C5: entró un UUID en minúsculas';
--     exception when check_violation then null;
--     end;
--     begin
--       update public.factura_emitida set uuid = 'no-es-uuid' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C5: entró un UUID inválido';
--     exception when check_violation then null;
--     end;
--     raise notice 'okC5 · UUID duplicado/minúsculas/inválido rechazados';
--
--     -- C6) CHECKs (cada uno debe reventar con check_violation)
--     begin update public.factura_emitida set total = 0 where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: total 0'; exception when check_violation then null; end;
--     begin update public.factura_emitida set metodo_pago = 'XXX' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: metodo_pago'; exception when check_violation then null; end;
--     begin update public.factura_emitida set forma_pago = '3' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: forma_pago'; exception when check_violation then null; end;
--     begin update public.factura_emitida set estatus = 'OTRA' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: estatus'; exception when check_violation then null; end;
--     begin update public.factura_emitida set estatus = 'CANCELADA' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: CANCELADA sin cancelada_at'; exception when check_violation then null; end;
--     begin update public.factura_emitida set serie = ' X' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: serie con espacio'; exception when check_violation then null; end;
--     begin update public.factura_emitida set folio = '' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: folio vacío'; exception when check_violation then null; end;
--     begin update public.factura_emitida set receptor_rfc = 'abc' where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: RFC inválido'; exception when check_violation then null; end;
--     begin update public.factura_emitida set deleted_at = now() where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: baja sin motivo'; exception when check_violation then null; end;
--     begin update public.factura_emitida set archivos_historial = '{}'::jsonb where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: archivos_historial objeto'; exception when check_violation then null; end;
--     begin update public.factura_emitida set emisora_id = gen_random_uuid() where id = v_f3;
--       raise exception 'DRYRUN_FALLA C6: emisora inexistente'; exception when foreign_key_violation then null; end;
--     raise notice 'okC6 · CHECKs/FK rechazan lo inválido';
--
--     -- C7) UPDATE REAL: cancelar/reactivar y trigger updated_at
--     update public.factura_emitida set updated_at = '2000-01-01' where id = v_f3;
--     select updated_at into v_upd from public.factura_emitida where id = v_f3;
--     if v_upd < '2001-01-01' then
--       raise exception 'DRYRUN_FALLA C7: tg_set_updated_at no corre en factura_emitida';
--     end if;
--     update public.factura_emitida
--        set estatus = 'CANCELADA', cancelada_at = now(), cancelada_por = v_admin,
--            motivo_cancelacion = 'dry-run'
--      where id = v_f3;
--     update public.factura_emitida
--        set estatus = 'VIGENTE', cancelada_at = null, cancelada_por = null,
--            motivo_cancelacion = null
--      where id = v_f3;
--     raise notice 'okC7 · cancelar/reactivar y updated_at';
--
--     -- C8) PUENTE con vuelo REAL; RESTRICT del lado del vuelo; CASCADE del lado de la factura
--     insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by)
--     values (v_f3, v_vuelo, v_admin), (v_f2, v_vuelo, v_admin);
--     begin
--       insert into public.factura_emitida_vuelo (factura_id, vuelo_id) values (v_f3, v_vuelo);
--       raise exception 'DRYRUN_FALLA C8: liga duplicada';
--     exception when unique_violation then null;
--     end;
--     begin
--       insert into public.factura_emitida_vuelo (factura_id, vuelo_id) values (v_f3, gen_random_uuid());
--       raise exception 'DRYRUN_FALLA C8: liga a vuelo inexistente';
--     exception when foreign_key_violation then null;
--     end;
--     begin
--       delete from public.vuelo where id = v_vuelo;
--       raise exception 'DRYRUN_FALLA C8: se borró un vuelo con factura ligada';
--     exception when foreign_key_violation then
--       get stacked diagnostics v_con = constraint_name;
--       if v_con <> 'factura_emitida_vuelo_vuelo_id_fkey' then
--         raise exception 'DRYRUN_FALLA C8: el RESTRICT lo dio % (esperado factura_emitida_vuelo_vuelo_id_fkey)', v_con;
--       end if;
--     when others then
--       if sqlerrm like 'DRYRUN_FALLA%' then raise; end if;
--       raise exception 'DRYRUN_FALLA C8: otro error al intentar borrar el vuelo: %', sqlerrm;
--     end;
--     delete from public.factura_emitida where id = v_f2;   -- borrado duro ⇒ cascada
--     select count(*) into v_n from public.factura_emitida_vuelo where factura_id = v_f2;
--     if v_n <> 0 then raise exception 'DRYRUN_FALLA C8: la liga no cayó en cascada'; end if;
--     raise notice 'okC8 · puente, RESTRICT del vuelo y CASCADE de la factura';
--
--     -- C9) UPDATE REAL de VUELO con las columnas de solicitud (triggers de vuelo)
--     --     La cola DEDUPLICA (on conflict … do update): contar no sirve. Se
--     --     borra la fila del vuelo2 (se revierte con todo lo demás) y se
--     --     verifica que pedir/retirar factura NO la vuelva a crear.
--     delete from public.calendar_sync_cola where entidad = 'vuelo' and entidad_id = v_vuelo2;
--     update public.vuelo
--        set factura_solicitada_at = now(), factura_solicitada_por = v_admin,
--            factura_solicitud_nota = 'dry-run', factura_paga_contra_factura = true
--      where id = v_vuelo2;
--     select updated_at into v_upd from public.vuelo where id = v_vuelo2;
--     if v_upd < now() then
--       raise exception 'DRYRUN_FALLA C9: tg_set_updated_at no corrió en vuelo (%)', v_upd;
--     end if;
--     if exists (select 1 from public.calendar_sync_cola
--                 where entidad = 'vuelo' and entidad_id = v_vuelo2) then
--       raise exception 'DRYRUN_FALLA C9: pedir factura encoló Google Calendar';
--     end if;
--     begin update public.vuelo set factura_solicitud_nota = '' where id = v_vuelo2;
--       raise exception 'DRYRUN_FALLA C9: nota vacía'; exception when check_violation then null; end;
--     begin update public.vuelo set factura_solicitud_nota = ' x ' where id = v_vuelo2;
--       raise exception 'DRYRUN_FALLA C9: nota con espacios'; exception when check_violation then null; end;
--     begin update public.vuelo set factura_solicitada_at = null where id = v_vuelo2;
--       raise exception 'DRYRUN_FALLA C9: quién/nota sin fecha de solicitud'; exception when check_violation then null; end;
--     update public.vuelo
--        set factura_solicitada_at = null, factura_solicitada_por = null,
--            factura_solicitud_nota = null, factura_paga_contra_factura = false
--      where id = v_vuelo2;   -- «Retirar»
--     raise notice 'okC9 · solicitud en vuelo: UPDATE real, updated_at, sin encolar, CHECKs';
--
--     -- C10) CONFIG: valor_json solo arreglo
--     update public.configuracion_sistema set valor_json = '[]'::jsonb where clave = 'responsables_facturacion';
--     begin
--       update public.configuracion_sistema set valor_json = '{}'::jsonb where clave = 'responsables_facturacion';
--       raise exception 'DRYRUN_FALLA C10: valor_json objeto';
--     exception when check_violation then null;
--     end;
--     raise notice 'okC10 · valor_json arreglo';
--
--     raise exception 'DRYRUN_OK · C1 estructura · C2 folio_num 123 + defaults · C3 duplicados · C3b número por emisora · C4 soft delete libera · C5 uuid · C6 checks/FK · C7 cancelar/reactivar/updated_at · C8 puente RESTRICT/CASCADE · C9 solicitud en vuelo sin encolar · C10 config · todo se revierte';
--   end $dry$;
--
-- TRAS APLICAR: `get_advisors` (esperado solo el INFO de «RLS sin policies»,
-- patrón del repo); `select clave, valor_json from configuracion_sistema
-- where clave = 'responsables_facturacion'` (debe traer el uuid de Mary Cruz);
-- sondear GET /v1/facturas-emitidas/por-facturar/conteo (200, no 503).
-- ORDEN DE DESPLIEGUE: tolerante en cualquier orden, pero RECOMENDADO
-- migración → API → pyservices → panel. Con el panel nuevo y SIN migración,
-- el detalle del vuelo ya no ofrece la subida vieja de factura y la burbuja
-- nueva está oculta: la ventana sin «subir factura» debe ser de minutos. La
-- sonda del API re-sondea cada ≤10 min: tras aplicar, esperar o reiniciar.
-- ROLLBACK: drop table public.factura_emitida_vuelo; drop table
-- public.factura_emitida; alter table public.vuelo drop column
-- factura_solicitada_at, drop column factura_solicitada_por, drop column
-- factura_solicitud_nota, drop column factura_paga_contra_factura; delete from
-- configuracion_sistema where clave = 'responsables_facturacion'; alter table
-- configuracion_sistema drop column valor_json. (Pierde lo registrado.)

-- ---------------------------------------------------------------------------
-- 1) REGISTRO DE FACTURAS EMITIDAS
-- ---------------------------------------------------------------------------
create table if not exists public.factura_emitida (
  id uuid primary key default gen_random_uuid(),
  serie text,
  folio text not null,
  folio_num numeric generated always as (
    nullif(regexp_replace(folio, '[^0-9]', '', 'g'), '')::numeric
  ) stored,
  uuid text,
  fecha_emision date not null,
  estatus text not null default 'VIGENTE',
  emisor_rfc text,
  emisor_nombre text,
  -- RESTRICT (no set null): la emisora es parte del número único; las
  -- emisoras nunca se borran (se desactivan).
  emisora_id uuid references public.entidad_fiscal_emisora(id) on delete restrict,
  receptor_rfc text,
  receptor_nombre text,
  cliente_id uuid references public.cliente(id) on delete set null,
  moneda public.moneda not null default 'MXN',
  subtotal numeric(14,2),
  iva numeric(14,2),
  total numeric(14,2) not null,
  metodo_pago text,
  forma_pago text,
  notas text,
  -- Anticipo / finiquito: el vuelo lleva varias facturas VIGENTES a propósito.
  es_parcial boolean not null default false,
  -- Archivos que se QUITARON o REEMPLAZARON (el objeto sigue en el bucket):
  -- [{tipo:'pdf'|'xml', path, nombre, subido_at, quitado_at, quitado_por, accion:'QUITADO'|'REEMPLAZADO'}]
  archivos_historial jsonb not null default '[]'::jsonb,
  pdf_path text,
  pdf_nombre text,
  pdf_subido_at timestamptz,
  pdf_subido_por uuid references public.usuario(id) on delete set null,
  xml_path text,
  xml_nombre text,
  xml_subido_at timestamptz,
  xml_subido_por uuid references public.usuario(id) on delete set null,
  cancelada_at timestamptz,
  cancelada_por uuid references public.usuario(id) on delete set null,
  motivo_cancelacion text,
  deleted_at timestamptz,
  deleted_by uuid references public.usuario(id) on delete set null,
  motivo_baja text,
  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuario(id) on delete set null,
  constraint factura_emitida_serie_chk check (
    serie is null or (char_length(serie) between 1 and 25 and serie = btrim(serie))),
  constraint factura_emitida_folio_chk check (
    char_length(folio) between 1 and 40 and folio = btrim(folio)),
  constraint factura_emitida_uuid_chk check (
    uuid is null or uuid ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'),
  constraint factura_emitida_estatus_chk check (estatus in ('VIGENTE', 'CANCELADA')),
  constraint factura_emitida_cancelada_chk check (
    (estatus = 'CANCELADA') = (cancelada_at is not null)
    and (estatus <> 'CANCELADA'
         or (motivo_cancelacion is not null and char_length(btrim(motivo_cancelacion)) between 3 and 500))),
  constraint factura_emitida_baja_chk check (
    deleted_at is null
    or (motivo_baja is not null and char_length(btrim(motivo_baja)) between 3 and 500)),
  constraint factura_emitida_metodo_pago_chk check (metodo_pago is null or metodo_pago in ('PUE', 'PPD')),
  constraint factura_emitida_forma_pago_chk check (forma_pago is null or forma_pago ~ '^[0-9]{2}$'),
  constraint factura_emitida_montos_chk check (
    total > 0 and (subtotal is null or subtotal >= 0) and (iva is null or iva >= 0)),
  constraint factura_emitida_rfc_chk check (
    (emisor_rfc is null or emisor_rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$')
    and (receptor_rfc is null or receptor_rfc ~ '^[A-ZÑ&]{3,4}[0-9]{6}[A-Z0-9]{3}$')),
  constraint factura_emitida_textos_chk check (
    (emisor_nombre is null or char_length(emisor_nombre) <= 300)
    and (receptor_nombre is null or char_length(receptor_nombre) <= 300)
    and (notas is null or char_length(notas) <= 1000)
    and (pdf_nombre is null or char_length(pdf_nombre) <= 200)
    and (xml_nombre is null or char_length(xml_nombre) <= 200)),
  constraint factura_emitida_historial_chk check (jsonb_typeof(archivos_historial) = 'array')
);

comment on table public.factura_emitida is
  'Facturas emitidas A MANO por la oficina (no las del PAC: esas viven en `factura`). Número = emisora + serie + folio, único entre no borradas (emisora NULL: el API la trata como comodín al buscar duplicados). Archivos nunca se borran del bucket (archivos_historial). Soft delete: todo lector filtra deleted_at is null.';
comment on column public.factura_emitida.folio_num is
  'GENERADA: dígitos del folio (A-00123 ⇒ 123) para ordenar por número y detectar huecos.';
comment on column public.factura_emitida.estatus is
  'VIGENTE | CANCELADA (texto + CHECK, no enum). Una CANCELADA conserva su número.';

create unique index if not exists uq_factura_emitida_serie_folio
  on public.factura_emitida (coalesce(emisora_id::text, ''), upper(coalesce(serie, '')), upper(folio))
  where deleted_at is null;
create unique index if not exists uq_factura_emitida_uuid
  on public.factura_emitida (upper(uuid))
  where deleted_at is null and uuid is not null;
create index if not exists idx_factura_emitida_numero
  on public.factura_emitida (coalesce(emisora_id::text, ''), upper(coalesce(serie, '')), folio_num)
  where deleted_at is null;
create index if not exists idx_factura_emitida_fecha
  on public.factura_emitida (fecha_emision)
  where deleted_at is null;
create index if not exists idx_factura_emitida_cliente
  on public.factura_emitida (cliente_id) where cliente_id is not null;
create index if not exists idx_factura_emitida_emisora
  on public.factura_emitida (emisora_id) where emisora_id is not null;

alter table public.factura_emitida enable row level security;

drop trigger if exists trg_factura_emitida_updated_at on public.factura_emitida;
create trigger trg_factura_emitida_updated_at
  before update on public.factura_emitida
  for each row execute function public.tg_set_updated_at();

-- ---------------------------------------------------------------------------
-- 2) PUENTE factura ⇄ vuelo (N:M)
-- ---------------------------------------------------------------------------
create table if not exists public.factura_emitida_vuelo (
  factura_id uuid not null references public.factura_emitida(id) on delete cascade,
  vuelo_id uuid not null references public.vuelo(id) on delete restrict,
  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  primary key (factura_id, vuelo_id)
);
comment on table public.factura_emitida_vuelo is
  'Qué vuelos cubre cada factura emitida. vuelo ON DELETE RESTRICT: el API quita antes las ligas de facturas canceladas/borradas y rechaza (409) si hay una VIGENTE.';
create index if not exists idx_factura_emitida_vuelo_vuelo
  on public.factura_emitida_vuelo (vuelo_id);
alter table public.factura_emitida_vuelo enable row level security;

-- ---------------------------------------------------------------------------
-- 3) SOLICITUD DE FACTURA en el vuelo («Necesito factura»)
-- ---------------------------------------------------------------------------
alter table public.vuelo
  add column if not exists factura_solicitada_at timestamptz,
  add column if not exists factura_solicitada_por uuid references public.usuario(id) on delete set null,
  add column if not exists factura_solicitud_nota text,
  add column if not exists factura_paga_contra_factura boolean not null default false;

alter table public.vuelo drop constraint if exists vuelo_factura_solicitud_nota_chk;
alter table public.vuelo add constraint vuelo_factura_solicitud_nota_chk
  check (factura_solicitud_nota is null
         or (char_length(factura_solicitud_nota) between 1 and 500
             and factura_solicitud_nota = btrim(factura_solicitud_nota)));
alter table public.vuelo drop constraint if exists vuelo_factura_solicitud_chk;
alter table public.vuelo add constraint vuelo_factura_solicitud_chk
  check (factura_solicitada_at is not null
         or (factura_solicitada_por is null
             and factura_solicitud_nota is null
             and factura_paga_contra_factura = false));

comment on column public.vuelo.factura_solicitada_at is
  'Alguien de la oficina pidió factura de este vuelo. «Por facturar» se DERIVA: solicitada AND no CANCELADO AND sin factura_emitida VIGENTE ligada.';
comment on column public.vuelo.factura_paga_contra_factura is
  'El cliente paga hasta recibir la factura (prioridad en «Por facturar»).';

create index if not exists idx_vuelo_factura_solicitada
  on public.vuelo (factura_solicitada_at)
  where factura_solicitada_at is not null;

-- ---------------------------------------------------------------------------
-- 4) CONFIGURACIÓN: listas (valor_json) + responsables de facturación
-- ---------------------------------------------------------------------------
alter table public.configuracion_sistema
  add column if not exists valor_json jsonb;
alter table public.configuracion_sistema drop constraint if exists configuracion_sistema_valor_json_chk;
alter table public.configuracion_sistema add constraint configuracion_sistema_valor_json_chk
  check (valor_json is null or jsonb_typeof(valor_json) = 'array');

-- 5) Fila 'responsables_facturacion' sembrada con Mary Cruz (Mari factura).
insert into public.configuracion_sistema (clave, activa, descripcion, valor_json)
values (
  'responsables_facturacion',
  true,
  'Usuarios de oficina que reciben el aviso «Factura pedida» cuando alguien marca «Necesito factura» en un vuelo. Vacío ⇒ usuarios con rol FACTURACION; si no hay ⇒ todos los ADMIN activos.',
  coalesce(
    (select jsonb_agg(u.id order by u.nombre)
       from public.usuario u
      where u.nombre = 'Mary Cruz'
        and u.estado::text = 'ACTIVO'
        and u.rol::text in ('ADMIN', 'FACTURACION')),
    '[]'::jsonb)
)
on conflict (clave) do nothing;
