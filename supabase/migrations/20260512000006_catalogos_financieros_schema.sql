-- Migration: 20260512000006_catalogos_financieros_schema
-- Catálogos transaccionales: cliente, proveedor, cuenta_bancaria, tarjeta_corporativa.
-- Necesarios antes de cotizaciones, facturas, gastos y conciliación.

create type public.canal_cliente as enum (
  'WHATSAPP',
  'EMAIL',
  'LANDING',
  'LLAMADA',
  'REFERIDO'
);

create type public.tipo_proveedor as enum (
  'NACIONAL',
  'EXTRANJERO',
  'GENERICO_LOCAL'
);

create type public.moneda as enum ('MXN', 'USD');

create type public.razon_social_emisora as enum (
  'AEROCHARTER',
  'AERODINAMICA',
  'OTRA'
);

-- ============ CLIENTE ============
create table public.cliente (
  id uuid primary key default gen_random_uuid(),
  nombre varchar(200) not null,
  telefono varchar(20),
  email varchar(100),
  razon_social_default varchar(200),
  rfc varchar(13),
  canal_origen public.canal_cliente,
  es_broker boolean not null default false,
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.cliente is 'Quien solicita el vuelo. Persona o empresa.';
comment on column public.cliente.razon_social_default is 'RFC + razón social para facturar por default. Soporta "factúrame como la última vez".';
comment on column public.cliente.es_broker is 'True = agencia/broker (aplica tarifa broker). False = tarifa pública.';

create index idx_cliente_nombre_lower on public.cliente (lower(nombre));
create index idx_cliente_telefono on public.cliente (telefono);
create index idx_cliente_email_lower on public.cliente (lower(email));
create index idx_cliente_rfc on public.cliente (rfc);
create index idx_cliente_activo on public.cliente (activo) where activo = true;

create trigger trg_cliente_set_updated_at
  before update on public.cliente
  for each row execute function public.tg_set_updated_at();

-- ============ PROVEEDOR ============
create table public.proveedor (
  id uuid primary key default gen_random_uuid(),
  nombre varchar(200) not null,
  rfc varchar(13),
  tipo public.tipo_proveedor not null default 'NACIONAL',
  pais varchar(2),
  email varchar(100),
  telefono varchar(20),
  direccion text,
  contacto varchar(100),
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.proveedor is '186 precargados del Excel de Mary (importacion via FastAPI) + proveedor "GENERICO_LOCAL" catchall.';
comment on column public.proveedor.tipo is 'NACIONAL=facturas mexicanas; EXTRANJERO=USA u otros (ej. Aircraft Spruce); GENERICO_LOCAL=catchall.';
comment on column public.proveedor.pais is 'ISO 3166-1 alpha-2 (MX, US, CA, ...).';

create index idx_proveedor_nombre_lower on public.proveedor (lower(nombre));
create index idx_proveedor_rfc on public.proveedor (rfc);
create index idx_proveedor_tipo on public.proveedor (tipo);
create index idx_proveedor_activo on public.proveedor (activo) where activo = true;

create trigger trg_proveedor_set_updated_at
  before update on public.proveedor
  for each row execute function public.tg_set_updated_at();

-- ============ CUENTA BANCARIA ============
create table public.cuenta_bancaria (
  id uuid primary key default gen_random_uuid(),
  alias varchar(50) not null unique,
  banco varchar(50) not null,
  numero_cuenta varchar(30),
  clabe varchar(18),
  moneda public.moneda not null,
  razon_social public.razon_social_emisora not null,
  notas text,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.cuenta_bancaria is '7 cuentas iniciales + admin para agregar mas.';

create index idx_cuenta_bancaria_activa on public.cuenta_bancaria (activa) where activa = true;
create index idx_cuenta_bancaria_moneda on public.cuenta_bancaria (moneda);

create trigger trg_cuenta_bancaria_set_updated_at
  before update on public.cuenta_bancaria
  for each row execute function public.tg_set_updated_at();

-- ============ TARJETA CORPORATIVA ============
create table public.tarjeta_corporativa (
  id uuid primary key default gen_random_uuid(),
  terminacion varchar(4) not null unique check (terminacion ~ '^\d{4}$'),
  nombre_titular varchar(100) not null,
  usuario_id uuid references public.usuario(id) on delete set null,
  banco varchar(50),
  cuenta_bancaria_id uuid references public.cuenta_bancaria(id) on delete set null,
  notas text,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.tarjeta_corporativa is '8 tarjetas iniciales (6256 Pablo, 2865 Ale, 8447 Yanina, 0577 Saab, 0593 Caceres, 0585 Malacara, 6163 Cetz, 6231 Oficina). nombre_titular es texto libre; usuario_id es opcional para tarjetas compartidas (Oficina) o titulares no sembrados aun.';

create index idx_tarjeta_usuario on public.tarjeta_corporativa (usuario_id);
create index idx_tarjeta_activa on public.tarjeta_corporativa (activa) where activa = true;

create trigger trg_tarjeta_corporativa_set_updated_at
  before update on public.tarjeta_corporativa
  for each row execute function public.tg_set_updated_at();

-- ============ RLS ============
alter table public.cliente enable row level security;
alter table public.proveedor enable row level security;
alter table public.cuenta_bancaria enable row level security;
alter table public.tarjeta_corporativa enable row level security;

create policy "cliente_read_active_user" on public.cliente for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "proveedor_read_active_user" on public.proveedor for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "cuenta_bancaria_read_active_user" on public.cuenta_bancaria for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "tarjeta_read_active_user" on public.tarjeta_corporativa for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
