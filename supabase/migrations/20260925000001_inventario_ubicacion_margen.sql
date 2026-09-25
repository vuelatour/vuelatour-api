-- 25-sep-2026 · INVENTARIO: catálogo de UBICACIONES de bodega + MARGEN de la
-- tienda VuelaTour (API 0.0.35).
--
-- Pedido del cliente (25-sep-2026, captura de /admin/inventory): «Producto |
-- Categoría | Stock | Utilidad (…el precio que le ponemos en el costo se le
-- saca el 25 % el cual va a ser nuestra utilidad por producto vendido o
-- cargado a un avión)» y «aprovechar poner una columna de ubicación, ya que
-- tenemos varias ubicaciones donde pueden estar guardadas las refacciones:
-- La Oficina vieja · La oficina nueva · El locker del aeropuerto · La bodega
-- del taller de Mérida · Nuestra bodega en el taller de Cozumel».
--
-- QUÉ CREA (aditivo, SIN backfill):
--   1. public.inventario_ubicacion — catálogo (nombre único sin distinguir
--      mayúsculas, orden, activo). RLS sin policies (patrón del repo: solo
--      la service key del API).
--   2. Semilla: los 5 del cliente, en SU orden y con estos nombres:
--      «Oficina vieja», «Oficina nueva», «Locker del aeropuerto», «Bodega del
--      taller de Mérida», «Bodega del taller de Cozumel».
--   3. inventario_item.ubicacion_id (FK on delete restrict) + índice parcial.
--      El TEXTO `inventario_item.ubicacion` se CONSERVA como legado y deja de
--      ser obligatorio (sin NOT NULL y sin el default 'Bodega Cancun'): con
--      id es el ESPEJO del nombre del catálogo; sin id es el texto de antes.
--      NO se adivina el mapeo de «Bodega Cancún»/«Corner»/«Bodega Córner»
--      (69 + 2 + 1 ítems en prod el 25-sep): la oficina los mueve desde el
--      panel con «Sin ubicación nueva» + «Mover a…».
--   4. Trigger `trg_inventario_item_ubicacion_espejo` (BEFORE insert/update
--      of ubicacion_id, ubicacion): con id, el texto SIEMPRE es el nombre del
--      catálogo (venga de donde venga el write: API, app vieja, SQL a mano).
--   5. Triggers del catálogo: renombrar PROPAGA el texto a sus productos;
--      desactivar con productos ACTIVOS ⇒ 23514 «UBICACION_EN_USO…» (espejo
--      del 409 del API). Borrar con productos ⇒ la FK `on delete restrict`
--      (23001 restrict_violation). Sin DELETE en el API: se desactiva.
--   6. configuracion_sistema.inventario_margen_venta_pct = 25 (patrón
--      numérico de paywise_comision_pct): % sobre el costo FIFO que paga el
--      avión cuando la salida no trae precio. Aplica a las salidas NUEVAS
--      (las 10 del 01-sep se re-precian aparte: 20260925000002).
--
-- LO QUE NO CAMBIA: ningún trigger existente, ninguna fila existente (los 72
-- ítems conservan su texto y quedan sin `ubicacion_id`), nada de dinero. Sin
-- columnas `moneda` (no hay comparaciones contra el ENUM). Funciones
-- SECURITY INVOKER con `search_path = ''` (no entran al advisor 0028/0029).
--
-- EL API 0.0.35 ES DESPLEGABLE SIN ESTA MIGRACIÓN (sonda `columnaOpcional`
-- de inventario_item.ubicacion_id, re-sondeo ≤ 10 min): sin ella todo lo de
-- ubicación responde como 0.0.34 (texto libre, «Bodega Cancún» por default),
-- y el catálogo / mover / filtro / `ubicacion_id` responden 503
-- MIGRACION_PENDIENTE. El MARGEN no depende de la migración (config ausente
-- ⇒ 25 %). El API 0.0.34 también convive con ella (siempre manda texto).
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL, semilla y
-- filas) aunque la herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' o
-- CUALQUIER otro error = NO aplicar. Tras el error DRYRUN_OK:
-- `select to_regclass('public.inventario_ubicacion')` ⇒ NULL, la columna
-- inventario_item.ubicacion_id no existe, `ubicacion` sigue NOT NULL con su
-- default y no existe la clave `inventario_margen_venta_pct`.
--
--   do $dry$
--   declare
--     v_admin uuid; v_item uuid; v_nuevo uuid; v_sin uuid;
--     v_vieja uuid; v_nueva uuid; v_mer uuid;
--     v_items integer; v_upd timestamptz;
--   begin
--     -- A) CONTEXTO
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' order by u.created_at limit 1;
--     select i.id, i.updated_at into v_item, v_upd from public.inventario_item i where i.activo order by i.nombre limit 1;
--     select count(*) into v_items from public.inventario_item;
--     if v_admin is null or v_item is null then raise exception 'DRYRUN_FALLA A: sin contexto'; end if;
--     if to_regclass('public.inventario_ubicacion') is not null then
--       raise exception 'DRYRUN_FALLA A: inventario_ubicacion YA existe (¿migración aplicada?)'; end if;
--     if exists (select 1 from public.configuracion_sistema where clave = 'inventario_margen_venta_pct') then
--       raise exception 'DRYRUN_FALLA A: la clave de margen YA existe'; end if;
--     raise notice 'okA · % ítems, ítem de prueba %', v_items, v_item;
--
--     -- B) CUERPO REAL: pegar AQUÍ, TAL CUAL, las secciones 1) a 6) de abajo (son sentencias SQL planas). NO una copia a mano.
--
--     -- C1) ESTRUCTURA, SEMILLA, CONFIG, SIN BACKFILL
--     if (select string_agg(nombre::text, '|' order by orden) from public.inventario_ubicacion)
--        is distinct from 'Oficina vieja|Oficina nueva|Locker del aeropuerto|Bodega del taller de Mérida|Bodega del taller de Cozumel' then
--       raise exception 'DRYRUN_FALLA C1: semilla'; end if;
--     if not (select relrowsecurity from pg_class where oid = 'public.inventario_ubicacion'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: RLS apagado'; end if;
--     if (select is_nullable from information_schema.columns
--          where table_schema = 'public' and table_name = 'inventario_item' and column_name = 'ubicacion') <> 'YES'
--        or (select column_default from information_schema.columns
--          where table_schema = 'public' and table_name = 'inventario_item' and column_name = 'ubicacion') is not null then
--       raise exception 'DRYRUN_FALLA C1: ubicacion sigue NOT NULL / con default'; end if;
--     if (select count(*) from pg_trigger where not tgisinternal and tgname in
--         ('trg_inventario_ubicacion_set_updated_at','trg_inventario_item_ubicacion_espejo',
--          'trg_inventario_ubicacion_candados','trg_inventario_ubicacion_renombre')) <> 4 then
--       raise exception 'DRYRUN_FALLA C1: faltan triggers'; end if;
--     if (select valor_numerico from public.configuracion_sistema where clave = 'inventario_margen_venta_pct') is distinct from 25 then
--       raise exception 'DRYRUN_FALLA C1: margen'; end if;
--     if (select count(*) from public.inventario_item where ubicacion_id is not null) <> 0
--        or (select count(*) from public.inventario_item where ubicacion is null) <> 0
--        or (select count(*) from public.inventario_item) <> v_items then
--       raise exception 'DRYRUN_FALLA C1: se tocaron ítems existentes (no hay backfill)'; end if;
--     select id into v_vieja from public.inventario_ubicacion where nombre = 'Oficina vieja';
--     select id into v_nueva from public.inventario_ubicacion where nombre = 'Oficina nueva';
--     select id into v_mer   from public.inventario_ubicacion where nombre = 'Bodega del taller de Mérida';
--     raise notice 'okC1 · tabla, RLS, 5 ubicaciones en orden, texto legado opcional, triggers, margen 25, sin backfill';
--
--     -- C2) UPDATE REAL de un ítem existente: espejo + updated_at; el texto no le gana al id; volver a legado
--     update public.inventario_item set ubicacion_id = v_nueva, updated_by = v_admin where id = v_item;
--     if (select ubicacion::text from public.inventario_item where id = v_item) <> 'Oficina nueva' then
--       raise exception 'DRYRUN_FALLA C2: espejo'; end if;
--     if (select updated_at from public.inventario_item where id = v_item) <= v_upd then
--       raise exception 'DRYRUN_FALLA C2: updated_at no se movió'; end if;
--     update public.inventario_item set ubicacion = 'Texto cualquiera' where id = v_item;
--     if (select ubicacion::text from public.inventario_item where id = v_item) <> 'Oficina nueva' then
--       raise exception 'DRYRUN_FALLA C2: el texto le ganó al catálogo'; end if;
--     update public.inventario_item set ubicacion_id = null, ubicacion = 'Bodega Cancún' where id = v_item;
--     if (select ubicacion::text from public.inventario_item where id = v_item) <> 'Bodega Cancún' then
--       raise exception 'DRYRUN_FALLA C2: regreso a legado'; end if;
--     update public.inventario_item set ubicacion_id = v_nueva where id = v_item;
--     raise notice 'okC2 · update real: espejo, updated_at, catálogo manda, legado';
--
--     -- C3) INSERT REAL: con id (espejo), sin nada (null: sin default), id inexistente (FK)
--     insert into public.inventario_item (nombre, categoria, ubicacion_id, created_by, updated_by)
--     values ('DRYRUN ítem con ubicación', 'Pruebas', v_mer, v_admin, v_admin) returning id into v_nuevo;
--     if (select ubicacion::text from public.inventario_item where id = v_nuevo) <> 'Bodega del taller de Mérida' then
--       raise exception 'DRYRUN_FALLA C3: espejo en insert'; end if;
--     insert into public.inventario_item (nombre, categoria) values ('DRYRUN ítem sin ubicación', 'Pruebas')
--     returning id into v_sin;
--     if (select ubicacion from public.inventario_item where id = v_sin) is not null then
--       raise exception 'DRYRUN_FALLA C3: sigue el default Bodega Cancun'; end if;
--     begin
--       insert into public.inventario_item (nombre, categoria, ubicacion_id) values ('DRYRUN fk', 'Pruebas', gen_random_uuid());
--       raise exception 'DRYRUN_FALLA C3: FK';
--     exception when foreign_key_violation then null; end;
--     raise notice 'okC3 · insert real con/sin ubicación y FK';
--
--     -- C4) CATÁLOGO: renombrar propaga; nombres únicos (sin distinguir mayúsculas) y limpios
--     update public.inventario_ubicacion set nombre = 'Oficina nueva (planta alta)' where id = v_nueva;
--     if (select ubicacion::text from public.inventario_item where id = v_item) <> 'Oficina nueva (planta alta)' then
--       raise exception 'DRYRUN_FALLA C4: el renombre no se propagó'; end if;
--     update public.inventario_ubicacion set nombre = 'Oficina nueva' where id = v_nueva;
--     if (select ubicacion::text from public.inventario_item where id = v_item) <> 'Oficina nueva' then
--       raise exception 'DRYRUN_FALLA C4: el renombre de regreso no se propagó'; end if;
--     begin insert into public.inventario_ubicacion (nombre, orden) values ('OFICINA NUEVA', 9);
--       raise exception 'DRYRUN_FALLA C4: duplicado'; exception when unique_violation then null; end;
--     begin insert into public.inventario_ubicacion (nombre, orden) values (' Locker', 9);
--       raise exception 'DRYRUN_FALLA C4: espacios'; exception when check_violation then null; end;
--     begin insert into public.inventario_ubicacion (nombre, orden) values ('X', 9);
--       raise exception 'DRYRUN_FALLA C4: nombre corto'; exception when check_violation then null; end;
--     begin update public.inventario_ubicacion set orden = -1 where id = v_vieja;
--       raise exception 'DRYRUN_FALLA C4: orden negativo'; exception when check_violation then null; end;
--     raise notice 'okC4 · renombre propaga; únicos/limpios';
--
--     -- C5) DESACTIVAR: con productos activos NO; sin productos sí; borrar con productos NO
--     begin
--       update public.inventario_ubicacion set activo = false where id = v_nueva;
--       raise exception 'DRYRUN_FALLA C5: desactivó con productos';
--     exception when check_violation then
--       if sqlerrm not like 'UBICACION_EN_USO%' then raise exception 'DRYRUN_FALLA C5: %', sqlerrm; end if;
--     end;
--     update public.inventario_ubicacion set activo = false where id = v_vieja;
--     update public.inventario_ubicacion set activo = true  where id = v_vieja;
--     -- `on delete restrict` responde 23001 (restrict_violation), NO 23503: se aceptan los dos.
--     begin delete from public.inventario_ubicacion where id = v_mer;
--       raise exception 'DRYRUN_FALLA C5: borró con productos';
--     exception when restrict_violation or foreign_key_violation then null; end;
--     raise notice 'okC5 · candados del catálogo';
--
--     -- C6) FLUJOS DE SIEMPRE (trigger de código único, updated_at, el INSERT del API 0.0.34 con texto)
--     update public.inventario_item set nombre = nombre, codigo = codigo where id = v_item;
--     update public.inventario_item set stock_minimo = stock_minimo where id = v_item;
--     insert into public.inventario_item (nombre, categoria, ubicacion, created_by, updated_by)
--     values ('DRYRUN ítem API viejo', 'Pruebas', 'Bodega Cancún', v_admin, v_admin) returning id into v_sin;
--     if (select ubicacion::text || '|' || coalesce(ubicacion_id::text, 'null') from public.inventario_item where id = v_sin)
--        <> 'Bodega Cancún|null' then
--       raise exception 'DRYRUN_FALLA C6: el alta con texto del API 0.0.34 cambió'; end if;
--     raise notice 'okC6 · updates de siempre y alta del API 0.0.34 pasan';
--
--     raise exception 'DRYRUN_OK · C1 estructura/semilla/margen/sin backfill · C2 update real espejo · C3 insert real con/sin ubicación/FK · C4 renombre propaga + únicos · C5 desactivar/borrar con productos bloqueado · C6 flujos de siempre · todo se revierte';
--   end $dry$;
--
-- TRAS APLICAR (vía MCP, proyecto prod bjesduasnzbzywofukbf):
--   - `get_advisors` (esperado: solo el INFO «RLS sin policies» de
--     inventario_ubicacion).
--   - `select count(*) from inventario_ubicacion` = 5;
--     `select count(*) from inventario_item where ubicacion_id is not null` = 0;
--     `select valor_numerico from configuracion_sistema where clave = 'inventario_margen_venta_pct'` = 25.
--   - Sondear `GET /v1/inventory/ubicaciones` (200 con 5 filas; si 503, la
--     sonda re-sondea en ≤ 10 min o reiniciar el API).
--
-- ROLLBACK (al pie, comentado).
-- ---------------------------------------------------------------------------

-- 1) CATÁLOGO DE UBICACIONES
create table if not exists public.inventario_ubicacion (
  id uuid primary key default gen_random_uuid(),
  nombre varchar(50) not null,
  orden integer not null default 0,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_at timestamptz not null default now(),
  updated_by uuid references public.usuario(id) on delete set null,
  constraint inventario_ubicacion_nombre_chk
    check (nombre::text = btrim(nombre::text) and char_length(nombre::text) between 2 and 50),
  constraint inventario_ubicacion_orden_chk check (orden >= 0)
);
create unique index if not exists uq_inventario_ubicacion_nombre
  on public.inventario_ubicacion (lower(nombre::text));
alter table public.inventario_ubicacion enable row level security;   -- sin policies: solo la service key (patrón del repo)
comment on table public.inventario_ubicacion is
  'Ubicaciones de bodega del inventario (25-sep-2026). Sin DELETE en el API: se desactiva (con productos activos, el trigger lo impide).';
drop trigger if exists trg_inventario_ubicacion_set_updated_at on public.inventario_ubicacion;
create trigger trg_inventario_ubicacion_set_updated_at
  before update on public.inventario_ubicacion
  for each row execute function public.tg_set_updated_at();

-- 2) SEMILLA: los 5 del cliente, en SU orden y con SUS nombres
insert into public.inventario_ubicacion (nombre, orden)
select v.nombre, v.orden
  from (values ('Oficina vieja', 1), ('Oficina nueva', 2), ('Locker del aeropuerto', 3),
               ('Bodega del taller de Mérida', 4), ('Bodega del taller de Cozumel', 5)) as v(nombre, orden)
 where not exists (select 1 from public.inventario_ubicacion u where lower(u.nombre::text) = lower(v.nombre));

-- 3) FK del ítem; el TEXTO viejo se conserva como legado y deja de ser obligatorio
alter table public.inventario_item
  add column if not exists ubicacion_id uuid references public.inventario_ubicacion(id) on delete restrict;
create index if not exists idx_inventario_item_ubicacion
  on public.inventario_item (ubicacion_id) where ubicacion_id is not null;
alter table public.inventario_item alter column ubicacion drop not null;
alter table public.inventario_item alter column ubicacion drop default;
comment on column public.inventario_item.ubicacion_id is
  'Ubicación del catálogo inventario_ubicacion (25-sep-2026). Con valor, `ubicacion` es su ESPEJO (trigger).';
comment on column public.inventario_item.ubicacion is
  'Texto de la ubicación. Con ubicacion_id = espejo del nombre del catálogo; sin él = texto LEGADO (anterior al catálogo, no se adivina su mapeo) o null.';

-- 4) ESPEJO: con ubicacion_id, el texto SIEMPRE es el nombre del catálogo (venga de donde venga el write)
create or replace function public.tg_inventario_item_ubicacion_espejo()
returns trigger language plpgsql set search_path = '' as $fn$
declare
  v_nombre text;
begin
  if new.ubicacion_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.ubicacion_id is not distinct from old.ubicacion_id
     and new.ubicacion is not distinct from old.ubicacion then
    return new;
  end if;
  select u.nombre::text into v_nombre from public.inventario_ubicacion u where u.id = new.ubicacion_id;
  new.ubicacion := v_nombre;   -- id inexistente ⇒ null y la FK revienta después (23503)
  return new;
end $fn$;
drop trigger if exists trg_inventario_item_ubicacion_espejo on public.inventario_item;
create trigger trg_inventario_item_ubicacion_espejo
  before insert or update of ubicacion_id, ubicacion on public.inventario_item
  for each row execute function public.tg_inventario_item_ubicacion_espejo();

-- 5) CATÁLOGO: renombrar propaga; desactivar con productos activos NO (espejo del 409 del API)
create or replace function public.tg_inventario_ubicacion_candados()
returns trigger language plpgsql set search_path = '' as $fn$
declare
  v_n integer;
begin
  if old.activo and not new.activo then
    select count(*) into v_n from public.inventario_item i where i.ubicacion_id = new.id and i.activo;
    if v_n > 0 then
      raise exception 'UBICACION_EN_USO: «%» tiene % producto(s) activo(s); muévelos primero a otra ubicación.', new.nombre, v_n
        using errcode = '23514';
    end if;
  end if;
  return new;
end $fn$;
drop trigger if exists trg_inventario_ubicacion_candados on public.inventario_ubicacion;
create trigger trg_inventario_ubicacion_candados
  before update of activo on public.inventario_ubicacion
  for each row execute function public.tg_inventario_ubicacion_candados();

create or replace function public.tg_inventario_ubicacion_renombre()
returns trigger language plpgsql set search_path = '' as $fn$
begin
  update public.inventario_item i
     set ubicacion = new.nombre
   where i.ubicacion_id = new.id
     and i.ubicacion is distinct from new.nombre;
  return null;
end $fn$;
drop trigger if exists trg_inventario_ubicacion_renombre on public.inventario_ubicacion;
create trigger trg_inventario_ubicacion_renombre
  after update of nombre on public.inventario_ubicacion
  for each row when (old.nombre is distinct from new.nombre)
  execute function public.tg_inventario_ubicacion_renombre();

-- 6) MARGEN DE LA TIENDA (patrón numérico de configuracion_sistema)
insert into public.configuracion_sistema (clave, activa, valor_numerico, descripcion)
values ('inventario_margen_venta_pct', true, 25,
  'Utilidad de la tienda VuelaTour: porcentaje que se suma al costo FIFO cuando una salida de bodega a un avión no trae precio de venta (25 = el avión paga costo + 25 %). 0 = las salidas sin precio se cargan a costo. Aplica a las salidas NUEVAS.')
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- ROLLBACK (NO correr salvo decisión explícita; el texto de los ítems movidos
-- se queda con el nombre del catálogo: era su espejo):
--
--   drop trigger if exists trg_inventario_item_ubicacion_espejo on public.inventario_item;
--   drop trigger if exists trg_inventario_ubicacion_renombre on public.inventario_ubicacion;
--   drop trigger if exists trg_inventario_ubicacion_candados on public.inventario_ubicacion;
--   drop trigger if exists trg_inventario_ubicacion_set_updated_at on public.inventario_ubicacion;
--   drop function if exists public.tg_inventario_item_ubicacion_espejo();
--   drop function if exists public.tg_inventario_ubicacion_candados();
--   drop function if exists public.tg_inventario_ubicacion_renombre();
--   update public.inventario_item set ubicacion = 'Bodega Cancún' where ubicacion is null;
--   alter table public.inventario_item
--     alter column ubicacion set default 'Bodega Cancun',
--     alter column ubicacion set not null,
--     drop column if exists ubicacion_id;
--   drop table if exists public.inventario_ubicacion;
--   delete from public.configuracion_sistema where clave = 'inventario_margen_venta_pct';
-- ---------------------------------------------------------------------------
