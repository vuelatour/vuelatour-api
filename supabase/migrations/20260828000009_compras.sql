-- 28-ago-2026 · COMPRAS de refacciones (pedido del cliente): la mercancía se
-- compra (factura 1, p. ej. Aircraft Spruce en USD) y después se pagan
-- impuestos/aduana y envío (factura 2, p. ej. UPS en MXN). Hoy son gastos
-- sueltos y el inventario no conoce el costo real. La COMPRA los une:
--   • compra        = orden (proveedor, fecha, moneda/TC, estado).
--   • compra_linea  = cada refacción (cantidad, costo unitario de factura,
--                     ítem del inventario y la ENTRADA que generó al recibir).
--   • gasto.compra_id + compra_rol = los PAGOS que la componen (MERCANCIA,
--     ENVIO, IMPUESTOS, OTRO). Cada pago sigue siendo un gasto con su factura
--     y su movimiento bancario (la conciliación no cambia); la compra es lo
--     que el equipo ve como "un solo gasto". El costo unitario puesto en
--     bodega = costo de factura + cargos prorrateados por valor (lo calcula
--     el API, fuente única: compras.service).
create table if not exists public.compra (
  id            uuid primary key default gen_random_uuid(),
  folio         serial,
  proveedor_id  uuid references public.proveedor(id) on delete set null,
  fecha         date not null default (now() at time zone 'America/Cancun')::date,
  referencia    varchar(120),
  -- Moneda de las LÍNEAS (la de la factura de mercancía): USD o MXN.
  moneda        varchar(3) not null default 'USD' check (moneda in ('USD','MXN')),
  -- TC de la compra (MXN por USD): convierte cargos en otra moneda y
  -- expresa el costo final en ambas monedas.
  tc_usd_mxn    numeric(10,4) check (tc_usd_mxn is null or tc_usd_mxn > 0),
  estado        varchar(12) not null default 'ABIERTA' check (estado in ('ABIERTA','RECIBIDA')),
  -- Cargos que vienen DENTRO de la factura de mercancía (Shipping, Tax…):
  -- no son líneas de refacción; se prorratean igual que los pagos-cargo.
  cargos_factura jsonb not null default '[]'::jsonb,
  recibida_at   timestamptz,
  notas         text,
  created_at    timestamptz not null default now(),
  updated_at    timestamptz not null default now(),
  created_by    uuid references public.usuario(id),
  updated_by    uuid references public.usuario(id)
);
comment on table public.compra is
  'Orden de compra de refacciones: une la factura de mercancía con sus cargos (envío, impuestos) y reparte el costo a cada refacción. Los pagos son gastos con compra_id.';

create table if not exists public.compra_linea (
  id                      uuid primary key default gen_random_uuid(),
  compra_id               uuid not null references public.compra(id) on delete cascade,
  orden                   int not null default 1,
  item_id                 uuid references public.inventario_item(id) on delete set null,
  nombre                  varchar(200) not null,
  numero_parte            varchar(50),
  categoria               varchar(50),
  cantidad                numeric(12,2) not null check (cantidad > 0),
  -- Costo unitario de FACTURA en la moneda de la compra.
  costo_unitario          numeric(14,4) not null check (costo_unitario >= 0),
  -- ENTRADA del cardex generada al recibir (null hasta recibir).
  inventario_movimiento_id uuid references public.inventario_movimiento(id) on delete set null,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now()
);
create index if not exists idx_compra_linea_compra on public.compra_linea (compra_id, orden);

alter table public.gasto
  add column if not exists compra_id  uuid references public.compra(id) on delete set null,
  add column if not exists compra_rol varchar(12)
    check (compra_rol is null or compra_rol in ('MERCANCIA','ENVIO','IMPUESTOS','OTRO'));
-- Ambos o ninguno: un gasto ligado a una compra siempre dice qué pagó.
alter table public.gasto drop constraint if exists gasto_compra_rol_chk;
alter table public.gasto add constraint gasto_compra_rol_chk
  check ((compra_id is null) = (compra_rol is null));
create index if not exists idx_gasto_compra on public.gasto (compra_id) where compra_id is not null;
comment on column public.gasto.compra_id is
  'Compra de refacciones de la que este gasto es un PAGO (mercancía, envío, impuestos u otro). El gasto conserva su factura y su cruce bancario.';

alter table public.compra enable row level security;
alter table public.compra_linea enable row level security;

-- updated_at automático (mismo patrón del resto de tablas).
create or replace function public.tg_compra_touch() returns trigger language plpgsql as $$
begin new.updated_at = now(); return new; end $$;
alter function public.tg_compra_touch() set search_path = public;
drop trigger if exists tg_compra_touch on public.compra;
create trigger tg_compra_touch before update on public.compra
  for each row execute function public.tg_compra_touch();
drop trigger if exists tg_compra_linea_touch on public.compra_linea;
create trigger tg_compra_linea_touch before update on public.compra_linea
  for each row execute function public.tg_compra_touch();
