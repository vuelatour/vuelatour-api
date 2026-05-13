-- Migration: 20260512000004_flota_schema
-- Fleet schema: aircraft, engines (transferable), propellers, ownership shares
-- and per-motor overhaul reserves. Motor is a first-class entity per the doc
-- (engine number_serie travels with the motor, even across aircraft).

create type public.pais_aeronave as enum ('MX', 'USA');
create type public.tipo_motor as enum ('PISTON', 'TURBINA');
create type public.posicion_motor as enum ('UNICO', 'IZQUIERDO', 'DERECHO');
create type public.posicion_helice as enum ('UNICA', 'IZQUIERDA', 'DERECHA');

create table public.aeronave (
  id uuid primary key default gen_random_uuid(),
  matricula varchar(10) not null unique,
  modelo varchar(50) not null,
  pais_registro public.pais_aeronave not null,
  num_motores int not null check (num_motores in (1, 2)),
  velocidad_crucero_kts decimal(5,1) not null check (velocidad_crucero_kts > 0),
  asientos int not null check (asientos > 0),
  tarifa_hora_pub_usd decimal(10,2),
  tarifa_hora_broker_usd decimal(10,2),
  reserva_overhaul_hr_usd decimal(10,2),
  color_calendario varchar(7),
  ubicacion_base varchar(4) not null default 'CUN',
  activa boolean not null default true,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.aeronave is 'Cada aeronave de la flota. Tarifas en USD/hora.';
comment on column public.aeronave.color_calendario is 'Hex color for calendar UI (#XXXXXX). Rosa para externos pero esos no son aeronaves propias.';
comment on column public.aeronave.reserva_overhaul_hr_usd is 'Default reserve per hour; per-motor reserves live in reserva_overhaul.';

create index idx_aeronave_activa on public.aeronave (activa) where activa = true;
create index idx_aeronave_pais on public.aeronave (pais_registro);

create trigger trg_aeronave_set_updated_at
  before update on public.aeronave
  for each row execute function public.tg_set_updated_at();

create table public.motor (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete restrict,
  posicion public.posicion_motor not null default 'UNICO',
  numero_serie varchar(50) not null unique,
  tipo public.tipo_motor not null,
  fabricante varchar(50),
  modelo varchar(50),
  horas_totales decimal(10,2) not null default 0 check (horas_totales >= 0),
  turm decimal(10,2) not null default 0 check (turm >= 0),
  tbo_horas decimal(10,2) not null check (tbo_horas > 0),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  unique (aeronave_id, posicion)
);

comment on table public.motor is 'Entidad independiente. horas_totales son lineales desde fabricación, nunca se resetean. TURM = horas al último overhaul mayor.';
comment on column public.motor.tbo_horas is 'Time Between Overhauls. Extensible con documento soporte.';

create index idx_motor_aeronave on public.motor (aeronave_id);
create index idx_motor_tipo on public.motor (tipo);

create trigger trg_motor_set_updated_at
  before update on public.motor
  for each row execute function public.tg_set_updated_at();

create table public.motor_traslado (
  id uuid primary key default gen_random_uuid(),
  motor_id uuid not null references public.motor(id) on delete cascade,
  aeronave_origen_id uuid not null references public.aeronave(id) on delete restrict,
  aeronave_destino_id uuid not null references public.aeronave(id) on delete restrict,
  posicion_origen public.posicion_motor not null,
  posicion_destino public.posicion_motor not null,
  horas_al_traslado decimal(10,2) not null check (horas_al_traslado >= 0),
  motivo text not null,
  trasladado_at timestamptz not null default now(),
  trasladado_por uuid references public.usuario(id) on delete set null,
  check (aeronave_origen_id <> aeronave_destino_id or posicion_origen <> posicion_destino)
);

comment on table public.motor_traslado is 'Bitacora de traslados de motores entre aeronaves.';

create index idx_motor_traslado_motor on public.motor_traslado (motor_id);

create table public.helice (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete restrict,
  posicion public.posicion_helice not null default 'UNICA',
  numero_serie varchar(50) not null unique,
  fabricante varchar(50),
  modelo varchar(50),
  horas_totales decimal(10,2) not null default 0 check (horas_totales >= 0),
  tbo_horas decimal(10,2) check (tbo_horas is null or tbo_horas > 0),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  unique (aeronave_id, posicion)
);

create index idx_helice_aeronave on public.helice (aeronave_id);

create trigger trg_helice_set_updated_at
  before update on public.helice
  for each row execute function public.tg_set_updated_at();

create table public.aeronave_socio (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  socio_id uuid not null references public.usuario(id) on delete restrict,
  porcentaje decimal(6,3) not null check (porcentaje > 0 and porcentaje <= 100),
  vigente_desde date not null,
  vigente_hasta date,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  check (vigente_hasta is null or vigente_hasta >= vigente_desde)
);

comment on table public.aeronave_socio is 'Ownership shares per aircraft. vigente_hasta NULL = currently active. Histórico se mantiene cerrando el período anterior.';

create index idx_aeronave_socio_aeronave on public.aeronave_socio (aeronave_id);
create index idx_aeronave_socio_socio on public.aeronave_socio (socio_id);
create index idx_aeronave_socio_vigentes on public.aeronave_socio (aeronave_id) where vigente_hasta is null;

create trigger trg_aeronave_socio_set_updated_at
  before update on public.aeronave_socio
  for each row execute function public.tg_set_updated_at();

create table public.reserva_overhaul (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  motor_id uuid references public.motor(id) on delete set null,
  monto_por_hora_usd decimal(10,2) not null check (monto_por_hora_usd > 0),
  horas_acumuladas decimal(12,2) not null default 0 check (horas_acumuladas >= 0),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (aeronave_id, motor_id)
);

comment on table public.reserva_overhaul is 'Reserva acumulada por motor. Cessna pistón ~$55/hr; Kodiak turbina $400/hr; Seneca bimotor $55/hr x 2 (una row por motor).';

create index idx_reserva_overhaul_aeronave on public.reserva_overhaul (aeronave_id);

create trigger trg_reserva_overhaul_set_updated_at
  before update on public.reserva_overhaul
  for each row execute function public.tg_set_updated_at();

-- ============ RLS ============
-- Read access requires an ACTIVE usuario row. Writes always go through service-role.
alter table public.aeronave enable row level security;
alter table public.motor enable row level security;
alter table public.motor_traslado enable row level security;
alter table public.helice enable row level security;
alter table public.aeronave_socio enable row level security;
alter table public.reserva_overhaul enable row level security;

create policy "aeronave_read_active_user" on public.aeronave for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "motor_read_active_user" on public.motor for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "motor_traslado_read_active_user" on public.motor_traslado for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "helice_read_active_user" on public.helice for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "aeronave_socio_read_active_user" on public.aeronave_socio for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "reserva_overhaul_read_active_user" on public.reserva_overhaul for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
