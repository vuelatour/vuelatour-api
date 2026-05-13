-- Migration: 20260513000001_aeropuertos_y_entidades_fiscales
-- Aeropuertos con reglas TUAS por aeropuerto (doc §4.2, §9.6) y entidades
-- fiscales emisoras (doc §2.4, §5.4). Cierra FASE 1 de catálogos.

create table public.aeropuerto (
  id uuid primary key default gen_random_uuid(),
  iata varchar(4) not null unique,
  icao varchar(4),
  nombre varchar(100) not null,
  ciudad varchar(100),
  pais varchar(2) not null default 'MX',
  -- Reglas TUAS
  tuas_default_usd_pax decimal(6,2) not null default 25.00,
  tuas_aplica_xa boolean not null default true,
  tuas_aplica_xb boolean not null default true,
  tuas_aplica_n boolean not null default true,
  tuas_pase_abordar_exenta boolean not null default true,
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.aeropuerto is 'Catalogo IATA con reglas TUAS especificas por aeropuerto.';
comment on column public.aeropuerto.tuas_default_usd_pax is 'Default $25 USD/pax. Configurable por aeropuerto. Itzel puede sobreescribir en la cotizacion.';
comment on column public.aeropuerto.tuas_aplica_xa is 'TUAS aplica a aeronaves matricula XA. Default true (XA paga siempre).';
comment on column public.aeropuerto.tuas_aplica_xb is 'TUAS aplica a aeronaves matricula XB. False en CUN (exentas).';
comment on column public.aeropuerto.tuas_aplica_n is 'TUAS aplica a aeronaves matricula N (USA). False en CUN (exentas).';
comment on column public.aeropuerto.tuas_pase_abordar_exenta is 'True = pase de abordar invalida TUAS. False en Cozumel (TUAS aplica aunque haya pase).';

create index idx_aeropuerto_iata on public.aeropuerto (iata);
create index idx_aeropuerto_pais on public.aeropuerto (pais);
create index idx_aeropuerto_activo on public.aeropuerto (activo) where activo = true;

create trigger trg_aeropuerto_set_updated_at
  before update on public.aeropuerto
  for each row execute function public.tg_set_updated_at();

create table public.entidad_fiscal_emisora (
  id uuid primary key default gen_random_uuid(),
  codigo varchar(20) not null unique,
  razon_social varchar(200) not null,
  rfc varchar(13) unique,
  regimen_fiscal_sat varchar(10),
  codigo_postal varchar(5),
  direccion text,
  email_facturacion varchar(100),
  telefono varchar(20),
  pac_proveedor varchar(50),
  notas text,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.entidad_fiscal_emisora is 'Razones sociales que emiten CFDI. Doc §2.4: Aerocharter (principal) + Aerodinamica (secundaria).';
comment on column public.entidad_fiscal_emisora.codigo is 'Codigo interno corto: AEROCHARTER, AERODINAMICA. Espejo del enum razon_social_emisora.';
comment on column public.entidad_fiscal_emisora.regimen_fiscal_sat is 'Codigo SAT (601 = Personas Morales Regimen General, 612 = Personas Fisicas con AE, etc.).';
comment on column public.entidad_fiscal_emisora.pac_proveedor is 'PAC contratado para timbrar (SIIGO_NUBE, FACTURAMA, SW_SAPIEN).';

create index idx_entidad_fiscal_codigo on public.entidad_fiscal_emisora (codigo);
create index idx_entidad_fiscal_activa on public.entidad_fiscal_emisora (activa) where activa = true;

create trigger trg_entidad_fiscal_set_updated_at
  before update on public.entidad_fiscal_emisora
  for each row execute function public.tg_set_updated_at();

-- RLS
alter table public.aeropuerto enable row level security;
alter table public.entidad_fiscal_emisora enable row level security;

create policy "aeropuerto_read_active_user" on public.aeropuerto for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "entidad_fiscal_read_active_user" on public.entidad_fiscal_emisora for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
