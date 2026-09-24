-- 24-sep-2026 · FOLIO (y UUID fiscal) de la factura del SERVICIO por vuelo.
--
-- Palabras del cliente:
--   «subí la factura de un vuelo, peroooo al momento de descargar el reporte
--    en Excel sí aparece la columna de factura (del vuelo) pero no aparece el
--    folio de la factura que subí en el registro»
--
-- QUÉ HAY HOY Y POR QUÉ NO ALCANZA:
--   · La columna «FACTURA VUELATOUR» del Libro Dinero y «factura vuelatour»
--     del balance (otros movimientos) solo leían la tabla `factura` = CFDI
--     timbrado por el PAC (`serie-folio`). En prod (24-sep-2026) esa tabla
--     tiene **0** filas: el timbrado sigue bloqueado por CSD / RFC.
--   · La factura que la oficina sube a mano (migración `20260923000001`:
--     `vuelo.factura_estatus` + `factura_archivo_*`) NO guarda folio en
--     ningún lado ⇒ el Excel no tenía de dónde sacarlo.
--
-- QUÉ HACE ESTA MIGRACIÓN (ADITIVA; sin triggers nuevos, sin tocar ninguna
-- columna existente, sin borrar nada, sin backfill):
--   1. `vuelo.factura_folio` — folio de la factura del servicio: el que
--      teclea la oficina (al subir el archivo o después, con el lápiz, o sin
--      archivo en los vuelos ya marcados «Facturado») o el que el API saca
--      del XML del CFDI (`SERIE-FOLIO`, o solo el Folio). Texto de 1 a 40
--      caracteres (CHECK): vacío se guarda como NULL, nunca como ''.
--   2. `vuelo.factura_uuid` — UUID fiscal (folio fiscal del SAT) si el
--      archivo subido es el XML timbrado (`tfd:TimbreFiscalDigital/@UUID`).
--      CHECK de formato 8-4-4-4-12 hexadecimal.
--
-- LO QUE **NO** CAMBIA (a propósito):
--   · `vuelo.facturado` y la tabla `factura` siguen siendo del CFDI del PAC;
--     en el Excel el CFDI vivo MANDA sobre este folio (fuente única
--     `flights/factura-cliente.util.ts#etiquetaFacturaVuelo`).
--   · Ninguna columna nueva entra a la lista `after update of …` de
--     `trg_vuelo_calendar_sync`: capturar el folio NO reescribe el evento de
--     Google del vuelo (el paso 4 del dry-run lo comprueba con UPDATEs
--     reales).
--   · text + CHECK (no enums): nada que comparar con `::text` en plpgsql y
--     sin el incidente del 15-sep-2026.
--
-- EL API YA ES DESPLEGABLE SIN ESTA MIGRACIÓN (sonda `columnaOpcional` de
-- `vuelo.factura_folio`, re-sondeo ≤ 10 min): leer responde `folio: null`,
-- el Excel sale como hoy (con la etiqueta del estatus), subir el archivo SIN
-- folio funciona igual, y mandar un folio responde 409
-- `FACTURA_FOLIO_NO_DISPONIBLE` con esta migración en `details` — nunca un
-- 500 ni un folio que se pierde en silencio. Al aplicarla se enciende sola.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES, begin … rollback).
--
-- `vuelo` es la tabla con MÁS triggers del sistema (`tg_set_updated_at`,
-- `trg_vuelo_calendar_sync`, fechas del viaje multi-día). Un `select` no
-- prueba nada de eso — el bug del 15-sep era invisible para cualquier
-- consulta de lectura. Los SEIS pasos son ASERCIONES: cada uno imprime
-- «ok N/6» o REVIENTA la transacción con «DRY-RUN FALLÓ».
--
-- **LOS `ALTER` VAN DENTRO DEL `begin`** (paso 1). Fuera de él, los pasos
-- 2-5 probarían un esquema que no es el que se está estrenando.
--
-- CÓMO CORRERLO: en UNA sola sesión con control de transacción propio (psql
-- o el editor SQL de Supabase). NO sirve una herramienta que envuelva cada
-- sentencia en su propia transacción ni una conexión solo-lectura: el
-- `rollback` final es lo que hace seguro el ensayo.
--
--   begin;
--     -- 0) CONTEXTO: un vuelo real y los conteos de partida.
--     create temporary table dry (k text primary key, v uuid) on commit drop;
--     create temporary table dry_n (k text primary key, v bigint) on commit drop;
--     create temporary table dry_t (k text primary key, v timestamptz) on commit drop;
--     insert into dry values
--       ('vuelo', (select id from public.vuelo
--                   where estado::text <> 'CANCELADO'
--                   order by created_at desc limit 1));
--     insert into dry_n
--       select 'cola', count(*) from public.calendar_sync_cola
--       union all select 'vuelos', count(*) from public.vuelo
--       union all select 'con_estatus', count(*) from public.vuelo
--                  where factura_estatus <> 'SIN_FACTURA';
--     insert into dry_t
--       select 'updated', updated_at from public.vuelo
--        where id = (select v from dry where k = 'vuelo');
--     do $dry$
--     begin
--       if (select v from dry where k = 'vuelo') is null then
--         raise exception 'DRY-RUN SIN CONTEXTO: no hay vuelo activo'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 0/6 · contexto listo (cola en % filas, % vuelos con estatus)',
--         (select v from dry_n where k = 'cola'),          -- 0 el 24-sep-2026
--         (select v from dry_n where k = 'con_estatus');   -- 1 el 24-sep-2026 (#297)
--     end $dry$;
--
--     -- 1) CUERPO REAL DE LA MIGRACIÓN (las secciones 1-3, tal cual).
--     alter table public.vuelo
--       add column if not exists factura_folio text,
--       add column if not exists factura_uuid text;
--     alter table public.vuelo drop constraint if exists vuelo_factura_folio_chk;
--     alter table public.vuelo add constraint vuelo_factura_folio_chk
--       check (factura_folio is null
--              or (char_length(factura_folio) between 1 and 40
--                  and factura_folio = btrim(factura_folio)));
--     alter table public.vuelo drop constraint if exists vuelo_factura_uuid_chk;
--     alter table public.vuelo add constraint vuelo_factura_uuid_chk
--       check (factura_uuid is null
--              or factura_uuid ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$');
--     do $dry$
--     begin
--       if (select count(*) from information_schema.columns
--            where table_schema = 'public' and table_name = 'vuelo'
--              and column_name in ('factura_folio', 'factura_uuid')) <> 2 then
--         raise exception 'DRY-RUN FALLÓ: faltan columnas' using errcode = 'assert_failure';
--       end if;
--       if exists (select 1 from public.vuelo where factura_folio is not null
--                                              or factura_uuid is not null) then
--         raise exception 'DRY-RUN FALLÓ: las columnas nuevas no nacieron vacías'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 1/6 · columnas y CHECKs creados, todas en NULL';
--     end $dry$;
--
--     -- 2) NEGATIVO: el CHECK rechaza folio vacío, con espacios de sobra, de
--     --    más de 40, y un UUID mal formado o en minúsculas.
--     do $dry$
--     declare
--       v_id uuid := (select v from dry where k = 'vuelo');
--       v_malo text;
--     begin
--       foreach v_malo in array array['', '  A-1', repeat('9', 41)] loop
--         begin
--           update public.vuelo set factura_folio = v_malo where id = v_id;
--           raise exception 'DRY-RUN FALLÓ: entró el folio «%»', v_malo
--             using errcode = 'assert_failure';
--         exception when check_violation then null;
--         end;
--       end loop;
--       foreach v_malo in array array['no-es-uuid',
--                                     'df1bfb5f-4d88-4f51-ac50-a7b72299128e'] loop
--         begin
--           update public.vuelo set factura_uuid = v_malo where id = v_id;
--           raise exception 'DRY-RUN FALLÓ: entró el UUID «%»', v_malo
--             using errcode = 'assert_failure';
--         exception when check_violation then null;
--         end;
--       end loop;
--       raise notice 'ok 2/6 · los CHECK rechazan folio vacío/sucio/largo y UUID mal formado';
--     end $dry$;
--
--     -- 3) POSITIVO (UPDATE REAL): folio + UUID entran, `updated_at` se mueve
--     --    (la app y el panel sincronizan por deltas) y se pueden BORRAR.
--     do $dry$
--     declare v_id uuid := (select v from dry where k = 'vuelo');
--     begin
--       update public.vuelo
--          set factura_folio = 'FECMID-90255',
--              factura_uuid = 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E'
--        where id = v_id;
--       if (select factura_folio from public.vuelo where id = v_id) <> 'FECMID-90255'
--          or (select updated_at from public.vuelo where id = v_id)
--             <= (select v from dry_t where k = 'updated') then
--         raise exception 'DRY-RUN FALLÓ: el folio no quedó o updated_at no se movió'
--           using errcode = 'assert_failure';
--       end if;
--       update public.vuelo set factura_folio = 'A-1234' where id = v_id;
--       update public.vuelo set factura_folio = null, factura_uuid = null where id = v_id;
--       if (select factura_folio from public.vuelo where id = v_id) is not null then
--         raise exception 'DRY-RUN FALLÓ: el folio no se pudo borrar'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 3/6 · folio y UUID entran, se corrigen y se borran; updated_at avanza';
--     end $dry$;
--
--     -- 4) EL ESPEJO A GOOGLE NO SE DESPIERTA: los updates de arriba deben
--     --    dejar `calendar_sync_cola` EXACTAMENTE igual (las columnas nuevas
--     --    no están en `after update of …` de `trg_vuelo_calendar_sync`).
--     do $dry$
--     declare v_cola bigint;
--     begin
--       if to_regclass('public.calendar_sync_cola') is null then
--         raise notice 'ok 4/6 · (saltado) la cola no existe en este entorno';
--         return;
--       end if;
--       select count(*) into v_cola from public.calendar_sync_cola;
--       if v_cola <> (select v from dry_n where k = 'cola') then
--         raise exception 'DRY-RUN FALLÓ: el folio encoló % → % en calendar_sync_cola',
--           (select v from dry_n where k = 'cola'), v_cola
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 4/6 · capturar el folio NO reescribe el evento de Google';
--     end $dry$;
--
--     -- 5) EL SEGUIMIENTO DE LA 20260923000001 SIGUE IGUAL: estatus + archivo
--     --    + folio en el MISMO update (lo que hace «Subir factura» con folio).
--     do $dry$
--     declare v_id uuid := (select v from dry where k = 'vuelo');
--     begin
--       update public.vuelo
--          set factura_estatus = 'FACTURADO',
--              factura_archivo_path = 'vuelos/' || v_id || '/dry-run.xml',
--              factura_archivo_nombre = 'Factura FECMID-90255.xml',
--              factura_archivo_subida_at = now(),
--              factura_folio = 'FECMID-90255',
--              factura_uuid = 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E'
--        where id = v_id;
--       if (select count(*) from public.vuelo
--            where id = v_id and factura_estatus = 'FACTURADO'
--              and factura_folio = 'FECMID-90255'
--              and factura_archivo_path is not null) <> 1 then
--         raise exception 'DRY-RUN FALLÓ: estatus + archivo + folio no quedaron juntos'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 5/6 · estatus, archivo y folio en una sola escritura';
--     end $dry$;
--
--     -- 6) Y SE REVIERTE TODO (la excepción aborta la transacción a propósito).
--     do $dry$
--     begin
--       raise exception 'DRYRUN_OK · cola %, vuelos %, con estatus % · todo se revierte',
--         (select v from dry_n where k = 'cola'),
--         (select v from dry_n where k = 'vuelos'),
--         (select v from dry_n where k = 'con_estatus')
--         using errcode = 'assert_failure';
--     end $dry$;
--   rollback;
--
--   -- Y COMPROBAR que el rollback dejó todo EXACTAMENTE como estaba:
--   select count(*) as cols from information_schema.columns
--    where table_schema = 'public' and table_name = 'vuelo'
--      and column_name in ('factura_folio', 'factura_uuid');            -- 0 (aún)
--   select count(*) as cola from public.calendar_sync_cola;              -- el de antes
--
-- Tras aplicar: `get_advisors` (columnas nuevas en una tabla con RLS ya
-- habilitado; no hay tabla ni política nueva) y, desde el panel, en el
-- detalle de un vuelo: capturar el folio con el lápiz (PATCH { folio }),
-- subir el XML de un CFDI y ver que el folio se llena solo, y descargar el
-- Libro Dinero del mes: la columna «FACTURA VUELATOUR» trae el folio.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1) FOLIO de la factura del servicio (tecleado o extraído del XML).
--    1 a 40 caracteres, sin espacios en los extremos; vacío = NULL.
-- ===========================================================================
alter table public.vuelo
  add column if not exists factura_folio text,
  add column if not exists factura_uuid text;

alter table public.vuelo
  drop constraint if exists vuelo_factura_folio_chk;
alter table public.vuelo
  add constraint vuelo_factura_folio_chk
  check (
    factura_folio is null
    or (char_length(factura_folio) between 1 and 40
        and factura_folio = btrim(factura_folio))
  );

-- ===========================================================================
-- 2) UUID FISCAL (folio fiscal del SAT) del XML timbrado, en MAYÚSCULAS.
-- ===========================================================================
alter table public.vuelo
  drop constraint if exists vuelo_factura_uuid_chk;
alter table public.vuelo
  add constraint vuelo_factura_uuid_chk
  check (
    factura_uuid is null
    or factura_uuid ~ '^[0-9A-F]{8}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{12}$'
  );

-- ===========================================================================
-- 3) La documentación de las columnas (lo que significa cada una).
-- ===========================================================================
comment on column public.vuelo.factura_folio is
  'Folio de la factura del SERVICIO al cliente (24-sep-2026): el que teclea la oficina o el que el API saca del XML del CFDI (SERIE-FOLIO, o solo el Folio). Lo imprime la columna «FACTURA VUELATOUR» del Libro Dinero y del balance cuando no hay CFDI timbrado por el sistema. NO es el candado de emisión (ese es vuelo.facturado).';

comment on column public.vuelo.factura_uuid is
  'UUID fiscal (folio fiscal del SAT, en mayúsculas) del XML timbrado subido como factura del servicio. NULL si se subió solo el PDF o si el XML no traía TimbreFiscalDigital.';
