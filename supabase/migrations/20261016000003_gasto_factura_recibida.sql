-- =====================================================================
-- 20261016000003_gasto_factura_recibida.sql — VARIAS FACTURAS RECIBIDAS POR
-- GASTO (16-oct-2026, API 0.0.87; invariante 87 del CLAUDE.md del API).
--
-- PEDIDO: ASA entrega 5 CFDI por cada carga de combustible (producto,
-- almacenamiento, expendio, DUGAEAM, servicio administrativo). Hoy un gasto
-- tiene UNA factura (`gasto.factura_recibida_id`): «Subir factura» acepta 1
-- PDF + 1 XML y una segunda REEMPLAZA a la primera sin desligarla, y un PDF
-- sin XML no se deduplica (gasto 24b941d4… del 29-sep, ASA Cancún I, N4142R:
-- FCUN-1299718 quedó dos veces, c83b149a… huérfana y 7a301bfe… principal).
--
-- QUÉ HACE (aditiva, idempotente; ninguna sentencia destructiva — la única
-- aparición de esa palabra son las cláusulas de las FK, ya aceptadas por el
-- MCP el 15 y 16-oct):
--  1) factura_recibida.pdf_sha256 text NULL (sha-256 en hex minúsculas del
--     PDF tal cual se subió), CHECK de formato e índice parcial
--     idx_factura_recibida_pdf_sha256. Lo llena el API al subir (las filas
--     viejas quedan en null: el API calcula el de las facturas del MISMO
--     gasto al vuelo y lo guarda). Deduplica un PDF sin XML: mismo PDF ⇒
--     misma fila.
--  2) Tabla puente public.gasto_factura_recibida (gasto_id, factura_recibida_id,
--     created_at, created_by) con PK compuesta, índice por factura y RLS
--     habilitado SIN policies (como el resto; la API usa la service key). Es
--     la relación N:M CANÓNICA «qué facturas amparan qué gasto». Las dos FK
--     de negocio son en cascada: quitar un gasto o una factura se lleva sus
--     ligas.
--     `gasto.factura_recibida_id` SE QUEDA como la factura PRINCIPAL (la
--     primera): el trigger gasto_sync_facturacion (FACTURADA/PENDIENTE), el
--     folio de Conciliación/Excel, la relectura de folio, el candado de
--     inventario y la conciliación por partes NO cambian.
--     `factura_recibida.gasto_id` (espejo legado) no cambia de semántica.
--  3) Trigger tg_gasto_factura_principal_en_puente (AFTER INSERT OR UPDATE OF
--     factura_recibida_id en gasto, WHEN la principal no es null): inserta la
--     fila (gasto, principal) en la puente «on conflict do nothing». Así la
--     INVARIANTE «principal ⇒ fila en la puente» la garantiza la BD aunque
--     escriba un API viejo (0.0.85) o un UPDATE a mano. Solo INSERTA: quitar
--     ligas es trabajo del API (que primero cambia la principal y DESPUÉS
--     quita la fila, de modo que la invariante nunca se rompe).
--  4) BACKFILL (solo insert … on conflict do nothing): los pares
--     (g.id, g.factura_recibida_id) y (f.gasto_id, f.id), con created_at =
--     factura_recibida.created_at (orden de promoción = antigüedad de la
--     factura) y created_by = factura_recibida.created_by.
--     Prod 16-oct-2026 (SELECT): 119 facturas, 122 gastos con principal (118
--     facturas distintas), 119 espejos; unión = 123 pares. El par que solo
--     viene del espejo es c83b149a… → gasto 24b941d4… (el FCUN-1299718
--     duplicado de Mary): tras el backfill ese gasto muestra 2 facturas y la
--     oficina quita la repetida con «Quitar de este gasto».
--  5) Verificación que aborta si algo no quedó (objetos, RLS, invariante
--     principal ⇒ puente, espejo ⇒ puente).
--
-- `moneda` es ENUM en gasto: nada de este archivo compara monedas (la suma
-- de facturas vs monto es un aviso del API).
--
-- PERFIL DE LA FUNCIÓN: SECURITY INVOKER + search_path vacío (como
-- tg_set_updated_at): escribe solo la service key (RLS sin policies) y una
-- función de trigger no se invoca por RPC.
--
-- DEPENDE de 20260607000006 (factura_recibida), 20260709000001
-- (gasto.factura_recibida_id) y 20260923000001 (pdf_url). El API 0.0.87 es
-- desplegable ANTES o DESPUÉS: sondea `factura_recibida.pdf_sha256`
-- (common/gasto-facturas-disponible.util); sin ella se comporta como 0.0.85
-- (una factura por gasto) y varias a la vez responden 503
-- FACTURAS_GASTO_NO_DISPONIBLE. OJO: el «sí» de la sonda se memoriza — tras
-- un ROLLBACK hay que reiniciar el API.
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar el proyecto con un
-- SELECT antes):
--  a) DRY-RUN con mcp__supabase__execute_sql: el bloque «do $dry$ … $dry$;»
--     del archivo dryrun-mcp.sql del paquete. Debe terminar en ERROR
--     «DRYRUN_OK 20261016000003 …». Cualquier otro error ⇒ NO aplicar.
--  b) mcp__supabase__apply_migration con name «20261016000003_gasto_factura_recibida»
--     y query = SOLO el cuerpo entre «>>> CUERPO» y «<<< CUERPO».
--  c) SELECT de conteos (pares en la puente = unión del día; 0 gastos con
--     principal fuera de la puente) y get_advisors (esperado: solo el INFO
--     «RLS sin policies» de siempre, ahora también para la puente).
--
-- PLAN B (si a) o b) responden {"status":"declined"}), SQL Editor del proyecto:
--  B1) Pegar el DRY-RUN y ejecutar: debe terminar en «DRYRUN_OK …».
--  B2) En UNA corrida:
--        begin;
--        <el CUERPO entre «>>> CUERPO» y «<<< CUERPO», tal cual>
--        insert into supabase_migrations.schema_migrations (version, name, statements)
--        values ('20261016000003', 'gasto_factura_recibida',
--                array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261016000003_gasto_factura_recibida.sql'])
--        on conflict (version) do nothing;
--        commit;
--  B3) SELECT de conteos por MCP y get_advisors.
--
-- ROLLBACK (SOLO desde el SQL Editor; REINICIAR el API después): retirar, con
-- la sentencia de retiro de objetos que este archivo no escribe (el MCP la
-- rechaza incluso en comentarios), en este orden: el trigger
-- trg_gasto_factura_principal_en_puente de gasto, la función
-- tg_gasto_factura_principal_en_puente(), la tabla gasto_factura_recibida, el
-- índice idx_factura_recibida_pdf_sha256, el CHECK
-- factura_recibida_pdf_sha256_formato y la columna factura_recibida.pdf_sha256.
-- `gasto.factura_recibida_id` queda como estaba (la principal de cada gasto);
-- las facturas extra siguen en el buzón con su espejo `gasto_id` si lo tenían.
-- =====================================================================

-- >>> CUERPO
-- ===========================================================================
-- 1) factura_recibida.pdf_sha256 — huella del PDF (deduplica PDF sin XML)
-- ===========================================================================
alter table public.factura_recibida
  add column if not exists pdf_sha256 text null;

comment on column public.factura_recibida.pdf_sha256 is
  'SHA-256 (hex minúsculas, 64) del PDF guardado en pdf_url, tal cual se subió. Lo escribe el API 0.0.87+ al subir; las filas previas quedan null y el API calcula al vuelo las de las facturas del mismo gasto. Deduplica: mismo PDF ⇒ misma factura (sin XML no hay UUID). No es único a propósito (huella, no identidad fiscal). 20261016000003.';

do $chk$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.factura_recibida'::regclass
       and conname = 'factura_recibida_pdf_sha256_formato'
  ) then
    alter table public.factura_recibida
      add constraint factura_recibida_pdf_sha256_formato
      check (pdf_sha256 is null or pdf_sha256 ~ '^[0-9a-f]{64}$');
  end if;
end $chk$;

create index if not exists idx_factura_recibida_pdf_sha256
  on public.factura_recibida (pdf_sha256)
  where pdf_sha256 is not null;

-- ===========================================================================
-- 2) Tabla puente gasto ⟷ factura recibida (N:M CANÓNICA)
-- ===========================================================================
create table if not exists public.gasto_factura_recibida (
  gasto_id uuid not null
    references public.gasto(id) on delete cascade,
  factura_recibida_id uuid not null
    references public.factura_recibida(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid null
    references public.usuario(id) on delete set null,
  primary key (gasto_id, factura_recibida_id)
);

comment on table public.gasto_factura_recibida is
  'Qué facturas recibidas amparan qué gasto (N:M CANÓNICA, 20261016000003; ASA entrega 5 CFDI por carga). gasto.factura_recibida_id sigue siendo la PRINCIPAL (la primera) y SIEMPRE tiene su fila aquí (trigger trg_gasto_factura_principal_en_puente). Clasificación, no dinero: no entra a conciliación, balance, reparto ni pre-cierre.';

create index if not exists idx_gasto_factura_recibida_factura
  on public.gasto_factura_recibida (factura_recibida_id);

alter table public.gasto_factura_recibida enable row level security;

-- ===========================================================================
-- 3) Trigger: la principal SIEMPRE está en la puente
-- ===========================================================================
create or replace function public.tg_gasto_factura_principal_en_puente()
returns trigger
language plpgsql
set search_path = ''
as $fn_principal_puente$
begin
  if new.factura_recibida_id is not null then
    insert into public.gasto_factura_recibida (gasto_id, factura_recibida_id, created_by)
    values (new.id, new.factura_recibida_id, new.updated_by)
    on conflict (gasto_id, factura_recibida_id) do nothing;
  end if;
  return null;
end $fn_principal_puente$;

comment on function public.tg_gasto_factura_principal_en_puente() is
  'AFTER INSERT OR UPDATE OF factura_recibida_id en gasto (20261016000003): inserta (gasto, principal) en gasto_factura_recibida si no estaba. Solo inserta: quitar ligas lo hace el API (cambia la principal ANTES de quitar la fila).';

create or replace trigger trg_gasto_factura_principal_en_puente
  after insert or update of factura_recibida_id
  on public.gasto
  for each row
  when (new.factura_recibida_id is not null)
  execute function public.tg_gasto_factura_principal_en_puente();

-- ===========================================================================
-- 4) BACKFILL (solo insert … on conflict do nothing; re-aplicar no duplica)
-- ===========================================================================
do $backfill$
declare
  v_principal integer;
  v_espejo integer;
begin
  insert into public.gasto_factura_recibida (gasto_id, factura_recibida_id, created_at, created_by)
  select g.id, g.factura_recibida_id, f.created_at, f.created_by
    from public.gasto g
    join public.factura_recibida f on f.id = g.factura_recibida_id
   where g.factura_recibida_id is not null
  on conflict (gasto_id, factura_recibida_id) do nothing;
  get diagnostics v_principal = row_count;

  insert into public.gasto_factura_recibida (gasto_id, factura_recibida_id, created_at, created_by)
  select f.gasto_id, f.id, f.created_at, f.created_by
    from public.factura_recibida f
    join public.gasto g on g.id = f.gasto_id
   where f.gasto_id is not null
  on conflict (gasto_id, factura_recibida_id) do nothing;
  get diagnostics v_espejo = row_count;

  raise notice 'BACKFILL 20261016000003: % par(es) desde gasto.factura_recibida_id + % solo del espejo factura_recibida.gasto_id',
    v_principal, v_espejo;
end $backfill$;

-- ===========================================================================
-- 5) VERIFICACIÓN (aborta si algo no quedó; no escribe)
-- ===========================================================================
do $ver$
declare
  v_n integer;
  v_pares integer;
begin
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'factura_recibida'
     and column_name = 'pdf_sha256' and data_type = 'text' and is_nullable = 'YES';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000003: falta la columna factura_recibida.pdf_sha256 (text null)';
  end if;
  if to_regclass('public.idx_factura_recibida_pdf_sha256') is null then
    raise exception 'VERIFICACIÓN 20261016000003: falta el índice idx_factura_recibida_pdf_sha256';
  end if;
  perform 1 from pg_constraint
   where conrelid = 'public.factura_recibida'::regclass
     and conname = 'factura_recibida_pdf_sha256_formato' and contype = 'c';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000003: falta el CHECK factura_recibida_pdf_sha256_formato';
  end if;
  if to_regclass('public.gasto_factura_recibida') is null then
    raise exception 'VERIFICACIÓN 20261016000003: falta la tabla gasto_factura_recibida';
  end if;
  if to_regclass('public.idx_gasto_factura_recibida_factura') is null then
    raise exception 'VERIFICACIÓN 20261016000003: falta el índice idx_gasto_factura_recibida_factura';
  end if;
  perform 1 from pg_class
   where oid = 'public.gasto_factura_recibida'::regclass and relrowsecurity;
  if not found then
    raise exception 'VERIFICACIÓN 20261016000003: RLS no está habilitado en gasto_factura_recibida';
  end if;
  perform 1 from pg_constraint
   where conrelid = 'public.gasto_factura_recibida'::regclass and contype = 'p'
     and array_length(conkey, 1) = 2;
  if not found then
    raise exception 'VERIFICACIÓN 20261016000003: falta la PK (gasto_id, factura_recibida_id)';
  end if;
  -- FK en cascada (confdeltype «c») a gasto y a factura_recibida; set null
  -- («n») a usuario.
  select count(*) into v_n from pg_constraint c
   where c.conrelid = 'public.gasto_factura_recibida'::regclass and c.contype = 'f'
     and ((c.confrelid = 'public.gasto'::regclass and c.confdeltype = 'c')
       or (c.confrelid = 'public.factura_recibida'::regclass and c.confdeltype = 'c')
       or (c.confrelid = 'public.usuario'::regclass and c.confdeltype = 'n'));
  if v_n <> 3 then
    raise exception 'VERIFICACIÓN 20261016000003: las FK de la puente no son las esperadas (%/3)', v_n;
  end if;
  perform 1 from pg_trigger t
   where t.tgrelid = 'public.gasto'::regclass
     and t.tgname = 'trg_gasto_factura_principal_en_puente' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ilike '%after insert or update of factura_recibida_id%';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000003: falta el trigger trg_gasto_factura_principal_en_puente';
  end if;
  perform 1 from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public' and p.proname = 'tg_gasto_factura_principal_en_puente'
     and p.proconfig @> array['search_path=""'];
  if not found then
    raise exception 'VERIFICACIÓN 20261016000003: la función del trigger no tiene search_path vacío';
  end if;
  -- INVARIANTE: principal ⇒ fila en la puente.
  select count(*) into v_n
    from public.gasto g
   where g.factura_recibida_id is not null
     and not exists (select 1 from public.gasto_factura_recibida p
                      where p.gasto_id = g.id and p.factura_recibida_id = g.factura_recibida_id);
  if v_n > 0 then
    raise exception 'VERIFICACIÓN 20261016000003: % gasto(s) con principal fuera de la puente', v_n;
  end if;
  -- Espejo ⇒ fila en la puente (backfill completo).
  select count(*) into v_n
    from public.factura_recibida f
    join public.gasto g on g.id = f.gasto_id
   where not exists (select 1 from public.gasto_factura_recibida p
                      where p.gasto_id = f.gasto_id and p.factura_recibida_id = f.id);
  if v_n > 0 then
    raise exception 'VERIFICACIÓN 20261016000003: % factura(s) con espejo gasto_id fuera de la puente', v_n;
  end if;
  select count(*) into v_pares from public.gasto_factura_recibida;
  select count(*) into v_n
    from public.gasto g
   where g.factura_recibida_id is null
     and exists (select 1 from public.gasto_factura_recibida p where p.gasto_id = g.id);
  raise notice 'VERIFICACIÓN 20261016000003 OK: % par(es) en la puente; % gasto(s) con ligas y SIN principal (esperado 0)', v_pares, v_n;
end $ver$;

select pg_notify('pgrst', 'reload schema');
-- <<< CUERPO
