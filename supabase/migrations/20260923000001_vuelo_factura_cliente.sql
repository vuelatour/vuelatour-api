-- 22-sep-2026 · FACTURA DEL SERVICIO **POR VUELO** (estatus manual + archivo)
-- y PDF de la factura RECIBIDA del gasto.
--
-- Palabras del cliente (captura del detalle de un vuelo, apartado COBRO):
--   «quisiera agregar por cada vuelo las opciones para identificar vuelos
--    facturado, sin factura, factura elaborada y enviada, y que pueda yo
--    también subir la factura del servicio a un lado»
--   «en los registros de gastos, además de la opción facturada (a un lado)
--    agregar la opción para subir la factura correspondiente de dicho gasto»
--
-- QUÉ HAY HOY Y POR QUÉ NO ALCANZA:
--   · `vuelo.facturado` (boolean) es el CFDI TIMBRADO POR EL SISTEMA: lo
--     pone `invoices.service.emitir` con un compare-and-set y lo libera la
--     cancelación ante el SAT. Es un candado de emisión, NO un seguimiento
--     administrativo: no sabe decir «ya la elaboré y se la mandé al cliente»,
--     que es justo el estado intermedio que la oficina lleva a mano hoy.
--   · La tabla `factura` guarda el CFDI del PAC (XML/PDF que genera el
--     timbrado). La factura que la oficina ELABORA POR FUERA —o la que le
--     manda el operador externo— no tiene dónde vivir: hoy se queda en el
--     correo de quien la mandó.
--   · En prod (22-sep-2026): 294 vuelos, **0** con `facturado = true` y
--     **0** filas en `factura` (el timbrado con PAC sigue bloqueado por CSD /
--     RFC de clientes). O sea: el backfill de esta migración toca 0 filas
--     HOY, y el seguimiento manual es, por ahora, el ÚNICO que existe.
--   · `factura_recibida` (buzón de CFDI de proveedores) guarda `xml_url`
--     pero NO tiene dónde poner el PDF: el proveedor casi siempre manda los
--     dos y el PDF es el que la oficina enseña. Sin columna, subirlo sería
--     perderlo.
--
-- QUÉ HACE ESTA MIGRACIÓN (ADITIVA; sin triggers nuevos, sin tocar ninguna
-- columna existente, sin borrar nada):
--   1. `vuelo.factura_estatus` — seguimiento MANUAL de la factura del
--      servicio, con CHECK de los tres valores que dijo el cliente
--      (`SIN_FACTURA` · `ELABORADA_ENVIADA` · `FACTURADO`), default
--      `SIN_FACTURA`.
--   2. `vuelo.factura_archivo_path` / `_nombre` / `_subida_at` /
--      `_subida_por` — el archivo de esa factura (PDF o XML) en el bucket
--      PRIVADO `facturas`, bajo `vuelos/<vuelo_id>/<uuid>.<ext>`, con el
--      nombre original y quién/cuándo lo subió. El path NUNCA se sirve
--      directo: el API lo firma 10 min (mismo patrón que `documentos-flota`
--      y que `invoices/file-urls`).
--   3. Backfill `factura_estatus = 'FACTURADO'` donde `facturado = true`
--      (0 filas hoy; existe para el día que el timbrado se encienda antes
--      de que esta migración se aplique en otro entorno).
--   4. Índice PARCIAL por estatus: la consulta que sirve es «enséñame lo que
--      NO está en el default» (elaboradas/enviadas y facturadas). Excluir
--      `SIN_FACTURA` deja el índice pequeño y evita indexar el 100 % de la
--      tabla para un filtro que casi siempre pide lo contrario.
--   5. `factura_recibida.pdf_url` — el PDF del CFDI del proveedor, junto al
--      `xml_url` que ya existía (mismo bucket privado `facturas`, prefijo
--      `recibidas/`).
--
-- LO QUE **NO** CAMBIA (a propósito):
--   · `vuelo.facturado` y la tabla `factura` siguen siendo del CFDI del PAC.
--     Al TIMBRAR, el API pone además `factura_estatus = 'FACTURADO'`; al
--     CANCELAR el CFDI el estatus **no baja solo** (la factura se elaboró y
--     se envió: que alguien decida a mano si vuelve a «sin factura»).
--   · `gasto.estatus_facturacion` y el trigger `gasto_sync_facturacion` no se
--     tocan: el gasto se marca FACTURADA al amarrarle una factura recibida,
--     como desde el 14-ago-2026.
--
-- ATENCIÓN · ENUMs: `factura_estatus` es **varchar con CHECK**, NO un enum
-- nuevo, justamente para no repetir el incidente del 15-sep-2026 («operator
-- does not exist: public.moneda = text»): un varchar se compara con texto en
-- plpgsql sin `::text` y sin sorpresas. `vuelo.estado`/`tipo` sí son enums y
-- aquí no se tocan.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES, begin … rollback).
--
-- `vuelo` es la tabla con MÁS triggers del sistema: `tg_set_updated_at`,
-- `trg_vuelo_calendar_sync` (encola el espejo a Google) y los de fechas del
-- viaje multi-día. Un `select` no prueba nada de eso — el bug del 15-sep era
-- invisible para cualquier consulta de lectura. Lo que hay que demostrar con
-- UPDATEs REALES es: (a) que el CHECK acepta los tres valores y rechaza
-- cualquier otro, (b) que mover el estatus **NO encola nada en
-- `calendar_sync_cola`** (si lo encolara, cada cambio administrativo
-- reescribiría el evento de Google del vuelo), (c) que `updated_at` SÍ se
-- mueve (la app sincroniza por deltas y el panel revalida), (d) que el
-- archivo se guarda y se limpia con los cuatro campos coherentes, y (e) que
-- `factura_recibida.pdf_url` acepta el PDF y el amarre al gasto sigue
-- marcando FACTURADA.
-- Los SIETE pasos son ASERCIONES: cada uno imprime «ok N/7» o REVIENTA la
-- transacción con «DRY-RUN FALLÓ». Nada que verificar a ojo.
--
-- **LOS `ALTER` VAN DENTRO DEL `begin`** (paso 1). Fuera de él, los pasos
-- 2-7 probarían un esquema que no es el que se está estrenando.
--
-- CÓMO CORRERLO: en UNA sola sesión con control de transacción propio (psql
-- o el editor SQL de Supabase). NO sirve una herramienta que envuelva cada
-- sentencia en su propia transacción ni una conexión solo-lectura: el
-- `rollback` final es lo que hace seguro el ensayo.
--
--   begin;
--     -- 0) CONTEXTO: un vuelo real, un ADMIN real y los conteos de partida.
--     create temporary table dry (k text primary key, v uuid) on commit drop;
--     create temporary table dry_n (k text primary key, v bigint) on commit drop;
--     create temporary table dry_t (k text primary key, v timestamptz) on commit drop;
--     insert into dry values
--       ('vuelo',   (select id from public.vuelo
--                     where estado::text <> 'CANCELADO'
--                     order by created_at desc limit 1)),
--       ('usuario', (select id from public.usuario
--                     where rol::text = 'ADMIN' and estado::text = 'ACTIVO'
--                     order by created_at limit 1)),
--       ('gasto',   (select id from public.gasto
--                     where factura_recibida_id is null
--                     order by created_at desc limit 1));
--     insert into dry_n
--       select 'cola', count(*) from public.calendar_sync_cola
--       union all select 'vuelos', count(*) from public.vuelo
--       union all select 'recibidas', count(*) from public.factura_recibida
--       union all select 'facturados', count(*) from public.vuelo where facturado = true;
--     insert into dry_t
--       select 'updated', updated_at from public.vuelo
--        where id = (select v from dry where k = 'vuelo');
--     do $dry$
--     begin
--       if (select v from dry where k = 'vuelo') is null
--          or (select v from dry where k = 'usuario') is null
--          or (select v from dry where k = 'gasto') is null then
--         raise exception 'DRY-RUN SIN CONTEXTO: falta vuelo, ADMIN o gasto libre'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 0/7 · contexto listo (cola en % filas)',
--         (select v from dry_n where k = 'cola');           -- 0 el 22-sep-2026
--     end $dry$;
--
--     -- 1) CUERPO REAL DE LA MIGRACIÓN (las secciones 1-5, tal cual).
--     alter table public.vuelo
--       add column if not exists factura_estatus varchar(24) not null default 'SIN_FACTURA';
--     alter table public.vuelo drop constraint if exists vuelo_factura_estatus_chk;
--     alter table public.vuelo add constraint vuelo_factura_estatus_chk
--       check (factura_estatus in ('SIN_FACTURA', 'ELABORADA_ENVIADA', 'FACTURADO'));
--     alter table public.vuelo
--       add column if not exists factura_archivo_path text,
--       add column if not exists factura_archivo_nombre text,
--       add column if not exists factura_archivo_subida_at timestamptz,
--       add column if not exists factura_archivo_subida_por uuid
--         references public.usuario(id) on delete set null;
--     update public.vuelo set factura_estatus = 'FACTURADO'
--      where facturado = true and factura_estatus <> 'FACTURADO';
--     create index if not exists idx_vuelo_factura_estatus
--       on public.vuelo (factura_estatus, fecha_vuelo desc)
--       where factura_estatus <> 'SIN_FACTURA';
--     alter table public.factura_recibida
--       add column if not exists pdf_url text;
--     do $dry$
--     begin
--       if (select count(*) from public.vuelo where factura_estatus <> 'SIN_FACTURA')
--          <> (select v from dry_n where k = 'facturados') then
--         raise exception 'DRY-RUN FALLÓ: el backfill no coincide con los vuelos facturado=true'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 1/7 · columnas, CHECK, índice y backfill (% filas con CFDI)',
--         (select v from dry_n where k = 'facturados');     -- 0 el 22-sep-2026
--     end $dry$;
--
--     -- 2) NEGATIVO: el CHECK rechaza cualquier valor inventado.
--     savepoint s2;
--     do $dry$
--     begin
--       update public.vuelo set factura_estatus = 'EN_PROCESO'
--        where id = (select v from dry where k = 'vuelo');
--       raise exception 'DRY-RUN FALLÓ: entró un estatus fuera del CHECK'
--         using errcode = 'assert_failure';
--     exception when check_violation then
--       raise notice 'ok 2/7 · el CHECK rechaza lo que no son los tres estados: %', sqlerrm;
--     end $dry$;
--     rollback to savepoint s2;
--
--     -- 3) POSITIVO (UPDATE REAL): los tres estados entran y `updated_at` se
--     --    mueve (la app sincroniza por deltas; si no se moviera, el cambio
--     --    sería invisible para los dispositivos).
--     do $dry$
--     declare v_id uuid := (select v from dry where k = 'vuelo');
--     begin
--       update public.vuelo set factura_estatus = 'ELABORADA_ENVIADA' where id = v_id;
--       update public.vuelo set factura_estatus = 'FACTURADO' where id = v_id;
--       update public.vuelo set factura_estatus = 'SIN_FACTURA' where id = v_id;
--       if (select updated_at from public.vuelo where id = v_id)
--          <= (select v from dry_t where k = 'updated') then
--         raise exception 'DRY-RUN FALLÓ: updated_at no se movió (¿falta tg_set_updated_at?)'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 3/7 · los tres estados entran y updated_at avanza';
--     end $dry$;
--
--     -- 4) EL ESPEJO A GOOGLE NO SE DESPIERTA. `trg_vuelo_calendar_sync` es
--     --    `after update of <lista>` y `factura_estatus` NO está en la lista
--     --    (fecha_vuelo, estado, aeronave_id, piloto_id, …): tres updates
--     --    seguidos deben dejar la cola EXACTAMENTE igual. Si algún día se
--     --    agrega a la lista, este paso lo caza.
--     do $dry$
--     declare v_cola bigint;
--     begin
--       if to_regclass('public.calendar_sync_cola') is null then
--         raise notice 'ok 4/7 · (saltado) la cola no existe en este entorno';
--         return;
--       end if;
--       select count(*) into v_cola from public.calendar_sync_cola;
--       if v_cola <> (select v from dry_n where k = 'cola') then
--         raise exception 'DRY-RUN FALLÓ: el estatus de factura encoló % → % en calendar_sync_cola',
--           (select v from dry_n where k = 'cola'), v_cola
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 4/7 · el estatus de factura NO reescribe el evento de Google';
--     end $dry$;
--
--     -- 5) EL ARCHIVO (UPDATE REAL): los cuatro campos entran juntos y se
--     --    limpian juntos, y el FK del autor apunta a un usuario real.
--     do $dry$
--     declare
--       v_id  uuid := (select v from dry where k = 'vuelo');
--       v_usr uuid := (select v from dry where k = 'usuario');
--       v_n   int;
--     begin
--       update public.vuelo
--          set factura_archivo_path = 'vuelos/' || v_id || '/dry-run.pdf',
--              factura_archivo_nombre = 'Factura VT-DRYRUN.pdf',
--              factura_archivo_subida_at = now(),
--              factura_archivo_subida_por = v_usr,
--              factura_estatus = 'ELABORADA_ENVIADA'
--        where id = v_id;
--       select count(*) into v_n from public.vuelo v
--         join public.usuario u on u.id = v.factura_archivo_subida_por
--        where v.id = v_id and v.factura_archivo_path is not null
--          and v.factura_archivo_nombre is not null
--          and v.factura_archivo_subida_at is not null;
--       if v_n <> 1 then
--         raise exception 'DRY-RUN FALLÓ: el bloque de archivo quedó incompleto'
--           using errcode = 'assert_failure';
--       end if;
--       update public.vuelo
--          set factura_archivo_path = null, factura_archivo_nombre = null,
--              factura_archivo_subida_at = null, factura_archivo_subida_por = null
--        where id = v_id;
--       if exists (select 1 from public.vuelo
--                   where id = v_id and factura_archivo_path is not null) then
--         raise exception 'DRY-RUN FALLÓ: quitar el archivo no limpió el path'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 5/7 · archivo puesto y quitado con sus cuatro campos';
--     end $dry$;
--
--     -- 6) LA FACTURA RECIBIDA CON PDF (INSERT REAL) y su amarre al gasto:
--     --    el trigger `gasto_sync_facturacion` debe marcar FACTURADA. Esto
--     --    es lo que hará «Subir factura» desde la fila del gasto.
--     do $dry$
--     declare
--       v_usr uuid := (select v from dry where k = 'usuario');
--       v_g   uuid := (select v from dry where k = 'gasto');
--       v_f   uuid;
--       v_est text;
--     begin
--       insert into public.factura_recibida (
--         uuid_fiscal, emisor_rfc, emisor_nombre, total, moneda,
--         xml_url, pdf_url, estado, gasto_id, notas, created_by, updated_by)
--       values (
--         null, 'AAA010101AAA', 'PROVEEDOR DRY-RUN', 1234.56, 'MXN',
--         null, 'recibidas/dry-run.pdf', 'CLASIFICADA', v_g,
--         'DRY-RUN 22-sep (se revierte)', v_usr, v_usr)
--       returning id into v_f;
--       update public.gasto set factura_recibida_id = v_f where id = v_g;
--       select estatus_facturacion::text into v_est from public.gasto where id = v_g;
--       if v_est <> 'FACTURADA' then
--         raise exception 'DRY-RUN FALLÓ: el gasto quedó en % al amarrarle la factura', v_est
--           using errcode = 'assert_failure';
--       end if;
--       if (select pdf_url from public.factura_recibida where id = v_f)
--          <> 'recibidas/dry-run.pdf' then
--         raise exception 'DRY-RUN FALLÓ: pdf_url no se guardó'
--           using errcode = 'assert_failure';
--       end if;
--       raise notice 'ok 6/7 · factura recibida SOLO con PDF (sin UUID) amarrada al gasto ⇒ FACTURADA';
--     end $dry$;
--
--     -- 7) Y SE REVIERTE TODO (la excepción aborta la transacción a propósito).
--     do $dry$
--     begin
--       raise exception 'DRYRUN_OK · cola %, vuelos %, recibidas % · todo se revierte',
--         (select v from dry_n where k = 'cola'),
--         (select v from dry_n where k = 'vuelos'),
--         (select v from dry_n where k = 'recibidas')
--         using errcode = 'assert_failure';
--     end $dry$;
--   rollback;
--
--   -- Y COMPROBAR que el rollback dejó todo EXACTAMENTE como estaba
--   -- (valores verificados en prod el 22-sep-2026):
--   select count(*) as vuelos from public.vuelo;                          -- 294
--   select count(*) as facturados from public.vuelo where facturado;      -- 0
--   select count(*) as cola from public.calendar_sync_cola;               -- 0
--   select count(*) as recibidas from public.factura_recibida;            -- 0
--   select count(*) as cols from information_schema.columns
--    where table_schema = 'public' and table_name = 'vuelo'
--      and column_name like 'factura\_%';                                 -- 0 (aún)
--
-- Tras aplicar: `get_advisors` (columnas nuevas en una tabla con RLS ya
-- habilitado; no hay tabla ni política nueva) y, desde el panel, en el
-- detalle de un vuelo: cambiar el estatus a «Factura elaborada y enviada»,
-- subir un PDF, verlo con «Ver» y quitarlo.
-- ---------------------------------------------------------------------------

-- ===========================================================================
-- 1) Estatus MANUAL de la factura del servicio (tres estados del cliente).
--    varchar + CHECK a propósito (no un enum): se compara con texto en
--    plpgsql sin `::text` y sin el incidente del 15-sep-2026.
-- ===========================================================================
alter table public.vuelo
  add column if not exists factura_estatus varchar(24) not null default 'SIN_FACTURA';

alter table public.vuelo
  drop constraint if exists vuelo_factura_estatus_chk;
alter table public.vuelo
  add constraint vuelo_factura_estatus_chk
  check (factura_estatus in ('SIN_FACTURA', 'ELABORADA_ENVIADA', 'FACTURADO'));

-- ===========================================================================
-- 2) El ARCHIVO de esa factura (PDF o XML) en el bucket privado `facturas`.
--    Se guarda el PATH (nunca una URL pública: el bucket es privado y el API
--    firma 10 min al momento de VER), el nombre ORIGINAL con el que la
--    oficina lo reconoce, y quién/cuándo lo subió.
-- ===========================================================================
alter table public.vuelo
  add column if not exists factura_archivo_path text,
  add column if not exists factura_archivo_nombre text,
  add column if not exists factura_archivo_subida_at timestamptz,
  add column if not exists factura_archivo_subida_por uuid
    references public.usuario(id) on delete set null;

-- ===========================================================================
-- 3) Backfill: un CFDI timbrado por el sistema YA es «Facturado».
--    0 filas en prod el 22-sep-2026 (el timbrado con PAC sigue bloqueado);
--    existe para cualquier entorno donde sí haya facturas emitidas.
-- ===========================================================================
update public.vuelo
   set factura_estatus = 'FACTURADO'
 where facturado = true
   and factura_estatus <> 'FACTURADO';

-- ===========================================================================
-- 4) Índice PARCIAL: la consulta útil es «lo que NO está en el default»
--    (elaboradas/enviadas y facturadas). Indexar también `SIN_FACTURA`
--    cubriría el 100 % de la tabla para nada.
-- ===========================================================================
create index if not exists idx_vuelo_factura_estatus
  on public.vuelo (factura_estatus, fecha_vuelo desc)
  where factura_estatus <> 'SIN_FACTURA';

-- ===========================================================================
-- 5) PDF del CFDI RECIBIDO del proveedor, junto al XML que ya existía.
--    Mismo bucket privado `facturas`, prefijo `recibidas/`. Sin esta columna
--    «subir la factura del gasto» perdería el papel que la oficina enseña.
-- ===========================================================================
alter table public.factura_recibida
  add column if not exists pdf_url text;

-- ===========================================================================
-- 6) La documentación de las columnas (lo que significa cada una).
-- ===========================================================================
comment on column public.vuelo.factura_estatus is
  'Seguimiento MANUAL de la factura del SERVICIO al cliente (22-sep-2026): SIN_FACTURA | ELABORADA_ENVIADA | FACTURADO. Es administrativo y lo mueve la oficina; NO es el candado de emisión de CFDI (ese es vuelo.facturado). Al timbrar, el API lo pone en FACTURADO; al cancelar el CFDI NO baja solo.';

comment on column public.vuelo.factura_archivo_path is
  'PATH dentro del bucket PRIVADO `facturas` del archivo de la factura del servicio (vuelos/<vuelo_id>/<uuid>.pdf|.xml). Nunca una URL: el API la firma 10 min al pedirla.';

comment on column public.vuelo.factura_archivo_nombre is
  'Nombre ORIGINAL del archivo subido (el que la oficina reconoce en su correo).';

comment on column public.vuelo.factura_archivo_subida_at is
  'Cuándo se subió el archivo de la factura del servicio (hora UTC; la UI la pinta en hora Cancún).';

comment on column public.vuelo.factura_archivo_subida_por is
  'Quién subió el archivo de la factura del servicio (se conserva el archivo si el usuario se borra: on delete set null).';

comment on column public.factura_recibida.pdf_url is
  'PATH del PDF del CFDI recibido dentro del bucket privado `facturas` (prefijo recibidas/). Complementa xml_url: el proveedor manda los dos y el PDF es el que se enseña. Una factura recibida SOLO con PDF (sin XML) lleva uuid_fiscal null — es válida y sirve para amarrar el gasto.';
