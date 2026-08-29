-- 28-ago-2026 · Inventario: código de barras, EMPAQUES (cajas) y fotos/IA.
--
-- Pedido del cliente: leer el código de barras para buscar y llegar al
-- producto (entrada/salida ágil y alta), dar de alta por CAJAS (la caja de
-- AeroShell W15W-50 trae 6 botellas y su propio código; a veces se llevan
-- cajas completas y debe rebajar en unidades del aceite), alta masiva por
-- Excel y varias fotos del producto para que la IA llene la ficha.
--
-- Modelo:
--  · `inventario_item.codigo` (ya existía: SKU / código de barras, único) es
--    el código de barras de la UNIDAD (botella).
--  · `inventario_item_empaque`: presentaciones del mismo ítem (caja de 6,
--    tarima…) con su `factor` (unidades por empaque) y su propio código de
--    barras. Un movimiento capturado "por empaque" guarda `empaque_id` y
--    `cantidad_empaques` y su `cantidad` SIEMPRE va en unidades (el cardex,
--    el FIFO y el gasto de bodega no cambian).
--  · Un código de barras identifica UNA sola cosa en toda la bodega: no
--    puede repetirse entre ítems y empaques (trigger).
--  · `marca`, `descripcion` y `fotos_adicionales` (jsonb [{url, path}]) para
--    la ficha que llena la IA a partir de las fotos.

alter table public.inventario_item
  add column if not exists marca varchar(80),
  add column if not exists descripcion text,
  add column if not exists fotos_adicionales jsonb not null default '[]'::jsonb;

comment on column public.inventario_item.codigo is
  'Código de barras / SKU de la UNIDAD (EAN/UPC tal cual lo lee el escáner, sin espacios). Único en bodega (también contra códigos de empaques).';
comment on column public.inventario_item.marca is 'Marca / fabricante (ej. AeroShell).';
comment on column public.inventario_item.descripcion is
  'Descripción de la ficha (contenido, presentación, especificación). La llena la IA desde las fotos; editable.';
comment on column public.inventario_item.fotos_adicionales is
  'Fotos extra del producto [{url, path}] en el bucket inventario-fotos (la principal sigue en foto_url).';

create table if not exists public.inventario_item_empaque (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventario_item(id) on delete cascade,
  nombre varchar(60) not null,
  -- Unidades del ítem que contiene un empaque (caja de 6 → 6).
  factor numeric(12,4) not null check (factor > 0),
  -- Código de barras del EMPAQUE (ITF-14 / GTIN de la caja); opcional.
  codigo varchar(60),
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);
create index if not exists idx_inventario_item_empaque_item
  on public.inventario_item_empaque (item_id);
create unique index if not exists uq_inventario_item_empaque_codigo
  on public.inventario_item_empaque (codigo) where codigo is not null;
alter table public.inventario_item_empaque enable row level security;
comment on table public.inventario_item_empaque is
  'Presentaciones/empaques de un ítem de inventario (caja de 6, tarima…): factor = unidades por empaque; codigo = código de barras del empaque. Un movimiento por empaque rebaja factor × cantidad_empaques unidades.';

alter table public.inventario_movimiento
  add column if not exists empaque_id uuid references public.inventario_item_empaque(id) on delete set null,
  add column if not exists cantidad_empaques numeric(12,2) check (cantidad_empaques is null or cantidad_empaques > 0);
comment on column public.inventario_movimiento.empaque_id is
  'Empaque con el que se capturó el movimiento (caja); cantidad sigue en UNIDADES = cantidad_empaques × factor.';
comment on column public.inventario_movimiento.cantidad_empaques is
  'Nº de empaques capturados (informativo/trazabilidad); la cantidad en unidades es la fuente única del cardex.';

-- Un código de barras identifica una sola cosa: ítem O empaque, nunca ambos.
create or replace function public.inventario_codigo_unico()
returns trigger
language plpgsql
set search_path = public
as $$
declare
  v_codigo text := nullif(btrim(new.codigo), '');
begin
  if v_codigo is null then
    new.codigo := null;
    return new;
  end if;
  new.codigo := v_codigo;
  if tg_table_name = 'inventario_item' then
    if exists (select 1 from public.inventario_item_empaque e where e.codigo = v_codigo) then
      raise exception 'El código % ya pertenece a un empaque de otro producto', v_codigo
        using errcode = 'unique_violation';
    end if;
  elsif tg_table_name = 'inventario_item_empaque' then
    if exists (select 1 from public.inventario_item i where i.codigo = v_codigo) then
      raise exception 'El código % ya pertenece a un producto (unidad)', v_codigo
        using errcode = 'unique_violation';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_inventario_item_codigo_unico on public.inventario_item;
create trigger trg_inventario_item_codigo_unico
  before insert or update of codigo on public.inventario_item
  for each row execute function public.inventario_codigo_unico();

drop trigger if exists trg_inventario_item_empaque_codigo_unico on public.inventario_item_empaque;
create trigger trg_inventario_item_empaque_codigo_unico
  before insert or update of codigo on public.inventario_item_empaque
  for each row execute function public.inventario_codigo_unico();

-- Índice del FK (advisor de rendimiento tras el DDL): cardex filtrado por empaque.
create index if not exists idx_inventario_movimiento_empaque
  on public.inventario_movimiento (empaque_id) where empaque_id is not null;

-- Unicidad real del código de la UNIDAD (el índice previo idx_inventario_item_codigo
-- era solo de búsqueda; hoy ningún ítem trae código, así que no hay colisiones).
create unique index if not exists uq_inventario_item_codigo
  on public.inventario_item (codigo) where codigo is not null;
