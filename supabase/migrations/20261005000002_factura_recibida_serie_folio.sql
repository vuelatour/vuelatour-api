-- 5-oct-2026 · SERIE/FOLIO DE LAS FACTURAS RECIBIDAS (API 0.0.57,
-- invariante 44 del CLAUDE.md del API).
--
-- Pedido del cliente con la captura del Excel de conciliación: «al momento
-- de la conciliación me apoyan a poner el número de la factura con la que
-- se enlaza el movimiento. Aquí en notas estaría perfecto». El número de
-- factura de un gasto sale de (1) la factura recibida ligada —que hasta hoy
-- solo guardaba `uuid_fiscal`—, (2) `gasto.folio_ticket`, (3) la lectura IA
-- o (4) el UUID (fuente única `common/folio-comprobante.util` del API).
--
-- QUÉ HACE:
--   1. `factura_recibida.serie text null`, `.folio text null` (atributos
--      `Serie`/`Folio` del `cfdi:Comprobante`, opcionales en el SAT) y
--      `.folio_releido_at timestamptz null` (cuándo se leyó el XML para
--      rellenarlos; null = pendiente). UN solo ALTER (atómico): la sonda del
--      API (`serieFolioRecibidaDisponible`) mira `serie`.
--   2. COMMENTs.
--   3. Verificación (`do $ver$`) que ABORTA si alguna columna no quedó con
--      su tipo.
--
-- Sin triggers nuevos, sin funciones, sin índices, sin backfill: las 62
-- facturas de prod (5-oct: 59 con `xml_url`, 3 solo PDF) quedan con
-- `folio_releido_at` null y el cron del API `recibidas-releer-folio` (cada
-- 10 min, lote de 50) relee su XML y las rellena en ≤ 2 corridas. Las 3
-- solo-PDF quedan sin folio (nada que leer). Los UPDATE del cron disparan
-- el trigger EXISTENTE `trg_factura_recibida_set_updated_at` (mueve
-- `updated_at`: es un cambio real de la fila).
--
-- DEPENDENCIA: ninguna. El API 0.0.57 corre CON o SIN esta migración (sonda
-- `common/serie-folio-recibida-disponible.util` = `columnaOpcional(
-- factura_recibida.serie)`, re-sondeo ≤ 10 min): sin ella el buzón de
-- recibidas responde como el 0.0.56, el cron no hace nada y el Excel toma
-- el número del ticket, la IA o el UUID. Orden recomendado: pyservices →
-- migración → API → panel.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (ANTES de aplicar). UNA sola sentencia `do $dry$` (se ejecuta
-- quitando el prefijo «-- » de las líneas entre `-- do $dry$` y
-- `-- end $dry$;`): el `raise exception` final REVIERTE todo (ALTER
-- incluido). Escrituras REALES sobre `factura_recibida` como las hace el
-- API (regla del CLAUDE.md: toda migración se prueba con INSERT/UPDATE
-- reales, nunca solo con selects). Cualquier 'DRYRUN_FALLA …' u otro
-- error = NO aplicar.
--
-- do $dry$
-- declare
--   v_total int;
--   v_xml int;
--   v_pend int;
--   v_n int;
--   v_id1 uuid;
--   v_id2 uuid;
--   v_id3 uuid;
--   v_id4 uuid;
--   v_tipo text;
--   r record;
-- begin
--   -- A) CONTEXTO: ninguna de las 3 columnas existe; foto del buzón.
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'factura_recibida'
--                 and column_name in ('serie', 'folio', 'folio_releido_at')) then
--     raise exception 'DRYRUN_FALLA A: factura_recibida ya tiene serie/folio/folio_releido_at (¿migración aplicada?)';
--   end if;
--   select count(*), count(*) filter (where xml_url is not null)
--     into v_total, v_xml
--     from public.factura_recibida;
--   raise notice 'okA · % recibidas, % con XML', v_total, v_xml;
--
--   -- B) CUERPO REAL (secciones 1–2 pegadas TAL CUAL)
--   alter table public.factura_recibida
--     add column if not exists serie text null,
--     add column if not exists folio text null,
--     add column if not exists folio_releido_at timestamptz null;
--   comment on column public.factura_recibida.serie is
--     'Atributo Serie del cfdi:Comprobante (opcional en el SAT; recortado, vacío = null). Lo lee pyservices parse_cfdi (20261005000002).';
--   comment on column public.factura_recibida.folio is
--     'Atributo Folio del cfdi:Comprobante (opcional en el SAT; recortado, vacío = null). Número de factura del proveedor: el API lo rotula «serie-folio» en conciliación (20261005000002).';
--   comment on column public.factura_recibida.folio_releido_at is
--     'Cuándo se leyó el XML para rellenar serie/folio (alta con XML o cron recibidas-releer-folio). null = pendiente de releer (20261005000002).';
--   -- (la sección 3 `do $ver$` no se puede anidar: C1 la repite)
--
--   -- C1) ESTRUCTURA: tipos, nulabilidad y sin default.
--   for r in select column_name, data_type, is_nullable, column_default
--              from information_schema.columns
--             where table_schema = 'public' and table_name = 'factura_recibida'
--               and column_name in ('serie', 'folio', 'folio_releido_at') loop
--     v_tipo := case r.column_name when 'folio_releido_at'
--                 then 'timestamp with time zone' else 'text' end;
--     if r.data_type <> v_tipo or r.is_nullable <> 'YES' or r.column_default is not null then
--       raise exception 'DRYRUN_FALLA C1: % quedó % / nullable % / default %',
--         r.column_name, r.data_type, r.is_nullable, r.column_default;
--     end if;
--   end loop;
--   select count(*) into v_n from information_schema.columns
--    where table_schema = 'public' and table_name = 'factura_recibida'
--      and column_name in ('serie', 'folio', 'folio_releido_at');
--   if v_n <> 3 then
--     raise exception 'DRYRUN_FALLA C1: % de 3 columnas', v_n;
--   end if;
--   -- Las filas existentes: TODAS pendientes (el cron las relee).
--   select count(*) into v_pend from public.factura_recibida
--    where xml_url is not null and folio_releido_at is null;
--   if v_pend <> v_xml then
--     raise exception 'DRYRUN_FALLA C1: % pendientes de releer, se esperaban %', v_pend, v_xml;
--   end if;
--   raise notice 'okC1 · 3 columnas · % por releer', v_pend;
--
--   -- C2) INSERT REAL como el API 0.0.57 (`crearRecibida` con XML):
--   --     serie/folio leídos y folio_releido_at sellado.
--   insert into public.factura_recibida
--     (uuid_fiscal, emisor_rfc, emisor_nombre, total, moneda, xml_url,
--      serie, folio, folio_releido_at)
--   values ('DRYRUN-20261005000002-1', 'AAA010101AAA', 'DRY RUN SA', 1234.56,
--           'MXN', 'recibidas/DRYRUN-1.xml', 'A', '0411', now())
--   returning id into v_id1;
--   if (select serie || '-' || folio from public.factura_recibida where id = v_id1) <> 'A-0411' then
--     raise exception 'DRYRUN_FALLA C2: el alta no guardó serie/folio';
--   end if;
--
--   -- C3) INSERT REAL como el API 0.0.56 (sin los campos nuevos) y como el
--   --     0.0.57 con un pyservices viejo: nace PENDIENTE para el cron.
--   insert into public.factura_recibida (uuid_fiscal, xml_url, estado)
--   values ('DRYRUN-20261005000002-2', 'recibidas/DRYRUN-2.xml', 'CLASIFICADA')
--   returning id into v_id2;
--   -- Solo PDF (sin XML): el cron NO la toma.
--   insert into public.factura_recibida (uuid_fiscal, xml_url, notas)
--   values (null, null, 'Factura en PDF (sin XML)')
--   returning id into v_id3;
--   select count(*) into v_n from public.factura_recibida
--    where xml_url is not null and folio_releido_at is null;
--   if v_n <> v_xml + 1 then
--     raise exception 'DRYRUN_FALLA C3: el lote del cron ve % (esperado %)', v_n, v_xml + 1;
--   end if;
--   raise notice 'okC2–C3 · alta 0.0.57 sellada, alta 0.0.56 pendiente, solo-PDF fuera del cron';
--
--   -- C4) UPDATE REAL del cron con su CAS (`folio_releido_at is null`):
--   --     la primera escribe, la segunda (carrera) no toca nada.
--   update public.factura_recibida
--      set serie = 'FEACZM', folio = '72128', folio_releido_at = now()
--    where id = v_id2 and folio_releido_at is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA C4: el cron escribió % filas (esperado 1)', v_n;
--   end if;
--   update public.factura_recibida
--      set serie = 'X', folio = 'PISADO', folio_releido_at = now()
--    where id = v_id2 and folio_releido_at is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 0 then
--     raise exception 'DRYRUN_FALLA C4: el CAS dejó pisar una fila sellada';
--   end if;
--   if (select folio from public.factura_recibida where id = v_id2) <> '72128' then
--     raise exception 'DRYRUN_FALLA C4: folio pisado';
--   end if;
--
--   -- C5) UPDATE REAL del cron con XML ilegible sobre una fila PENDIENTE
--   --     con notas, COMO LO HACE EL CRON: notas releídas justo antes y
--   --     el texto calculado en el API (literal), con CAS sobre
--   --     `folio_releido_at is null` Y sobre las notas releídas. Antes, la
--   --     oficina edita las notas (PATCH de recibidas): un sello con las
--   --     notas VIEJAS no escribe nada (0 filas) y el de las vigentes sí.
--   insert into public.factura_recibida (uuid_fiscal, xml_url, notas)
--   values ('DRYRUN-20261005000002-3', 'recibidas/DRYRUN-3.xml', 'Proveedor X')
--   returning id into v_id4;
--   update public.factura_recibida set notas = 'Proveedor X · pagar el viernes'
--    where id = v_id4;
--   update public.factura_recibida
--      set folio_releido_at = now(),
--          notas = E'Proveedor X\nFolio no legible del XML'
--    where id = v_id4 and folio_releido_at is null and notas = 'Proveedor X';
--   get diagnostics v_n = row_count;
--   if v_n <> 0 then
--     raise exception 'DRYRUN_FALLA C5: el CAS de notas dejó pisar la edición de la oficina';
--   end if;
--   update public.factura_recibida
--      set folio_releido_at = now(),
--          notas = E'Proveedor X · pagar el viernes\nFolio no legible del XML'
--    where id = v_id4 and folio_releido_at is null
--      and notas = 'Proveedor X · pagar el viernes';
--   get diagnostics v_n = row_count;
--   if v_n <> 1 or (select notas from public.factura_recibida where id = v_id4)
--        <> E'Proveedor X · pagar el viernes\nFolio no legible del XML'
--      or (select folio from public.factura_recibida where id = v_id4) is not null then
--     raise exception 'DRYRUN_FALLA C5: ilegible mal sellada (% filas)', v_n;
--   end if;
--   -- Sin notas: CAS `notas is null` (la fila C3 solo-PDF no entra: no
--   -- tiene XML; se usa una pendiente nueva).
--   insert into public.factura_recibida (uuid_fiscal, xml_url)
--   values ('DRYRUN-20261005000002-4', 'recibidas/DRYRUN-4.xml')
--   returning id into v_id1;
--   update public.factura_recibida
--      set folio_releido_at = now(), notas = 'Folio no legible del XML'
--    where id = v_id1 and folio_releido_at is null and notas is null;
--   get diagnostics v_n = row_count;
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA C5: ilegible sin notas no se selló (% filas)', v_n;
--   end if;
--   -- Edición del panel (PATCH de recibida, sin los campos nuevos) intacta.
--   update public.factura_recibida set notas = 'editada', estado = 'CLASIFICADA' where id = v_id3;
--   raise notice 'okC4–C5 · CAS del cron, ilegible anotada, PATCH del panel';
--
--   -- C6) RE-APLICAR es no-op (IF NOT EXISTS).
--   set constraints all immediate;
--   alter table public.factura_recibida
--     add column if not exists serie text null,
--     add column if not exists folio text null,
--     add column if not exists folio_releido_at timestamptz null;
--   select count(*) into v_n from information_schema.columns
--    where table_schema = 'public' and table_name = 'factura_recibida'
--      and column_name in ('serie', 'folio', 'folio_releido_at');
--   if v_n <> 3 then
--     raise exception 'DRYRUN_FALLA C6: % columnas tras re-aplicar', v_n;
--   end if;
--
--   raise exception 'DRYRUN_OK 20261005000002 · A–C6 (% recibidas, % por releer; alta sellada, alta vieja pendiente, CAS del cron, ilegible anotada, idempotente)', v_total, v_xml;
-- end $dry$;
--
-- Tras el DRYRUN_OK:
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'factura_recibida'
--      and column_name in ('serie', 'folio', 'folio_releido_at');  ⇒ 0
--   select count(*) from public.factura_recibida
--    where uuid_fiscal like 'DRYRUN-20261005000002-%';            ⇒ 0
-- Aplicar (MCP `apply_migration`) ⇒ `get_advisors` ⇒
--   select count(*) filter (where folio_releido_at is null and xml_url is not null)
--     from public.factura_recibida;          (59 el 5-oct; baja a 0 en ≤ 2
--   corridas del cron tras desplegar el API 0.0.57 y pyservices con serie/folio)
-- ---------------------------------------------------------------------------

-- 1) Columnas (idempotente; UN solo ALTER: atómico).
alter table public.factura_recibida
  add column if not exists serie text null,
  add column if not exists folio text null,
  add column if not exists folio_releido_at timestamptz null;

-- 2) Documentación.
comment on column public.factura_recibida.serie is
  'Atributo Serie del cfdi:Comprobante (opcional en el SAT; recortado, vacío = null). Lo lee pyservices parse_cfdi (20261005000002).';
comment on column public.factura_recibida.folio is
  'Atributo Folio del cfdi:Comprobante (opcional en el SAT; recortado, vacío = null). Número de factura del proveedor: el API lo rotula «serie-folio» en conciliación (20261005000002).';
comment on column public.factura_recibida.folio_releido_at is
  'Cuándo se leyó el XML para rellenar serie/folio (alta con XML o cron recibidas-releer-folio). null = pendiente de releer (20261005000002).';

-- 3) Verificación: aborta la migración (y la revierte) si algo no quedó.
do $ver$
declare
  v_ok int;
begin
  select count(*) into v_ok
    from information_schema.columns
   where table_schema = 'public'
     and table_name = 'factura_recibida'
     and is_nullable = 'YES'
     and ((column_name in ('serie', 'folio') and data_type = 'text')
       or (column_name = 'folio_releido_at' and data_type = 'timestamp with time zone'));
  if v_ok <> 3 then
    raise exception 'VERIFICACION_FALLA 20261005000002: % de 3 columnas con su tipo', v_ok;
  end if;
  raise notice 'VERIFICACION_OK 20261005000002 · serie, folio, folio_releido_at';
end
$ver$;

-- ---------------------------------------------------------------------------
-- ROLLBACK (manual, UNA transacción). Seguro con el API 0.0.57 vivo SOLO si
-- después se REINICIA el API: la sonda memoriza el «sí» para siempre y, sin
-- reinicio, el buzón de recibidas y la conciliación responderían 500 por la
-- columna. Se PIERDEN las series/folios leídos (el cron los vuelve a leer
-- si se re-aplica).
--
-- begin;
--   alter table public.factura_recibida
--     drop column if exists folio_releido_at,
--     drop column if exists folio,
--     drop column if exists serie;
-- commit;
-- ---------------------------------------------------------------------------
