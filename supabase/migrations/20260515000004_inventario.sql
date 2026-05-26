-- Migration: 20260515000004_inventario
-- Modulo 5.6 Inventario y compras.
-- inventario_item       = catalogo de productos en bodega.
-- inventario_movimiento = cardex: cada ENTRADA, SALIDA, DEVOLUCION o AJUSTE.
-- stock_actual y costeo FIFO se calculan en el API a partir del cardex; no se
-- persisten (igual que motor.horas_restantes).

create type public.tipo_movimiento_inventario as enum (
  'ENTRADA',
  'SALIDA',
  'DEVOLUCION',
  'AJUSTE'
);

create table public.inventario_item (
  id uuid primary key default gen_random_uuid(),
  nombre varchar(200) not null,
  numero_parte varchar(50),
  categoria varchar(50) not null,
  stock_minimo numeric(12,2) check (stock_minimo is null or stock_minimo >= 0),
  ubicacion varchar(50) not null default 'Bodega Cancun',
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.inventario_item is 'Modulo 5.6. Catalogo de productos en bodega. stock_actual se calcula del cardex.';
comment on column public.inventario_item.categoria is 'Texto libre: aceites, filtros, llantas, etc.';
comment on column public.inventario_item.stock_minimo is 'Umbral para alerta por email a Pablo. NULL = sin alerta.';
comment on column public.inventario_item.ubicacion is 'Una bodega por ahora (Cancun); preparado para multiples.';

create index idx_inventario_item_categoria on public.inventario_item (categoria);
create index idx_inventario_item_activo on public.inventario_item (activo) where activo = true;
create index idx_inventario_item_numero_parte on public.inventario_item (numero_parte);

create trigger trg_inventario_item_set_updated_at
  before update on public.inventario_item
  for each row execute function public.tg_set_updated_at();

create table public.inventario_movimiento (
  id uuid primary key default gen_random_uuid(),
  item_id uuid not null references public.inventario_item(id) on delete restrict,
  tipo public.tipo_movimiento_inventario not null,
  cantidad numeric(12,2) not null check (cantidad > 0),
  costo_unitario_usd numeric(12,2) not null check (costo_unitario_usd >= 0),

  -- En SALIDA: a que avion se cargo la pieza (obligatorio).
  aeronave_id uuid references public.aeronave(id) on delete set null,
  -- En ENTRADA: de que proveedor vino.
  proveedor_id uuid references public.proveedor(id) on delete set null,

  fecha_movimiento date not null default current_date,
  fecha_orden date,
  fecha_cargo_banco date,

  referencia varchar(100),
  notas text,
  registrado_por uuid not null references public.usuario(id) on delete restrict,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  -- Una SALIDA siempre se carga a un avion (auditoria, doc 5.6).
  check (tipo <> 'SALIDA' or aeronave_id is not null)
);

comment on table public.inventario_movimiento is 'Modulo 5.6. Cardex append-only. Costeo FIFO de SALIDA lo calcula el API.';
comment on column public.inventario_movimiento.costo_unitario_usd is 'Costo en USD. En SALIDA es el costo FIFO ponderado calculado por el API.';
comment on column public.inventario_movimiento.aeronave_id is 'SALIDA: avion al que se carga la pieza (obligatorio).';
comment on column public.inventario_movimiento.fecha_orden is 'Fecha de la orden de compra (ENTRADA).';
comment on column public.inventario_movimiento.fecha_cargo_banco is 'Fecha del cargo en el estado de cuenta (ENTRADA).';

create index idx_inventario_mov_item on public.inventario_movimiento (item_id, fecha_movimiento, created_at);
create index idx_inventario_mov_tipo on public.inventario_movimiento (tipo);
create index idx_inventario_mov_aeronave on public.inventario_movimiento (aeronave_id);
create index idx_inventario_mov_proveedor on public.inventario_movimiento (proveedor_id);
create index idx_inventario_mov_fecha on public.inventario_movimiento (fecha_movimiento desc);

create trigger trg_inventario_movimiento_set_updated_at
  before update on public.inventario_movimiento
  for each row execute function public.tg_set_updated_at();

alter table public.inventario_item enable row level security;
alter table public.inventario_movimiento enable row level security;

create policy "inventario_item_read_active_user" on public.inventario_item for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "inventario_movimiento_read_active_user" on public.inventario_movimiento for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
