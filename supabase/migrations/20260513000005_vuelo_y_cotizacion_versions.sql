-- Migration: 20260513000005_vuelo_y_cotizacion_versions
-- Tabla central del negocio: vuelo. Lifecycle desde SOLICITUD hasta COMPLETADO/CANCELADO.
-- cotizacion_version_history mantiene el historial completo de cada revision de la cotizacion
-- (pedido explicito en doc §4.2 "Historial de versiones v1, v2, v3..."). RLS por usuario activo.

create type public.tipo_vuelo as enum ('SENCILLO', 'REDONDO', 'MULTIESCALA');

create type public.estado_vuelo as enum (
  'SOLICITUD',
  'COTIZADO',
  'CONFIRMADO',
  'EN_VUELO',
  'COMPLETADO',
  'CANCELADO'
);

create type public.tipo_tarifa as enum ('PUBLICO', 'BROKER');

create type public.metodo_cobro as enum (
  'BILLPOCKET',
  'HSBC_LINK',
  'EFECTIVO',
  'TRANSFERENCIA',
  'DOLARES'
);

create sequence public.vuelo_folio_seq;

create table public.vuelo (
  id uuid primary key default gen_random_uuid(),
  folio bigint not null default nextval('public.vuelo_folio_seq') unique,

  cliente_id uuid not null references public.cliente(id) on delete restrict,
  aeronave_id uuid references public.aeronave(id) on delete restrict,
  piloto_id uuid references public.usuario(id) on delete set null,
  ruta_id uuid references public.ruta_predefinida(id) on delete set null,

  tipo public.tipo_vuelo not null default 'REDONDO',
  estado public.estado_vuelo not null default 'COTIZADO',
  es_externo boolean not null default false,
  operador_externo varchar(100),
  costo_externo_usd decimal(10,2),

  cotizacion_version int not null default 1,

  -- Snapshot de la cotizacion actual (denormalizado para query rapido)
  origen_iata varchar(4) not null,
  destino_iata varchar(4) not null,
  millas_nauticas_one_way decimal(8,2),
  es_redondo_auto boolean not null default true,
  num_aterrizajes int not null default 2,

  pasajeros int not null check (pasajeros > 0),
  pase_abordar boolean not null default false,

  tiempo_cobrable_hr decimal(10,4) not null,
  tarifa_tipo public.tipo_tarifa not null,
  tarifa_hora_usd decimal(10,2) not null,
  subtotal_vuelo_usd decimal(12,2) not null,
  tuas_usd decimal(10,2) not null default 0,
  iva_pct decimal(6,4) not null default 0,
  iva_usd decimal(12,2) not null default 0,
  monto_total_usd decimal(12,2) not null,
  tc_usd_mxn decimal(10,4),
  monto_total_mxn decimal(14,2),

  metodo_cobro public.metodo_cobro,
  pago_anticipado_req boolean generated always as (origen_iata <> 'CUN') stored,

  fecha_solicitud timestamptz not null default now(),
  fecha_vuelo timestamptz,
  fecha_confirmacion timestamptz,
  fecha_cancelacion timestamptz,
  motivo_cancelacion text,

  google_calendar_id varchar(100),

  facturado boolean not null default false,
  cobrado boolean not null default false,

  notas text,
  notas_internas text,
  calculo_snapshot jsonb,

  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  check (
    (es_externo = false and aeronave_id is not null) or
    (es_externo = true and operador_externo is not null)
  ),
  check (cotizacion_version >= 1)
);

comment on table public.vuelo is 'Unidad central del negocio. Lifecycle SOLICITUD -> COTIZADO -> CONFIRMADO -> EN_VUELO -> COMPLETADO|CANCELADO. Folio unico unificado.';
comment on column public.vuelo.folio is 'Folio unico unificado correlativo (doc §11.1). Generado automaticamente.';
comment on column public.vuelo.es_externo is 'True = avion subcontratado (rosa en calendario, ~1/10 vuelos).';
comment on column public.vuelo.cotizacion_version is 'Version actual. Cada revision incrementa el contador y crea fila en cotizacion_version_history.';
comment on column public.vuelo.calculo_snapshot is 'Output completo del motor de cotizacion (desglose tiempos, TUAS por aeropuerto, razones de calculo).';
comment on column public.vuelo.pago_anticipado_req is 'Computed: true si origen != CUN. Doc §2.8: pago debe estar cubierto ANTES de despegar de base si recoge fuera de Cancun.';

create index idx_vuelo_cliente on public.vuelo (cliente_id);
create index idx_vuelo_aeronave on public.vuelo (aeronave_id);
create index idx_vuelo_piloto on public.vuelo (piloto_id);
create index idx_vuelo_estado on public.vuelo (estado);
create index idx_vuelo_fecha_vuelo on public.vuelo (fecha_vuelo);
create index idx_vuelo_folio on public.vuelo (folio);
create index idx_vuelo_externos on public.vuelo (es_externo) where es_externo = true;
create index idx_vuelo_activos on public.vuelo (estado) where estado in ('SOLICITUD', 'COTIZADO', 'CONFIRMADO', 'EN_VUELO');

create trigger trg_vuelo_set_updated_at
  before update on public.vuelo
  for each row execute function public.tg_set_updated_at();

create table public.cotizacion_version_history (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null references public.vuelo(id) on delete cascade,
  version int not null check (version >= 1),

  aeronave_id uuid references public.aeronave(id) on delete set null,
  ruta_id uuid references public.ruta_predefinida(id) on delete set null,
  origen_iata varchar(4) not null,
  destino_iata varchar(4) not null,
  millas_nauticas_one_way decimal(8,2),
  es_redondo_auto boolean,
  num_aterrizajes int,
  pasajeros int not null,
  pase_abordar boolean,
  tiempo_cobrable_hr decimal(10,4) not null,
  tarifa_tipo public.tipo_tarifa not null,
  tarifa_hora_usd decimal(10,2) not null,
  subtotal_vuelo_usd decimal(12,2) not null,
  tuas_usd decimal(10,2),
  iva_pct decimal(6,4),
  iva_usd decimal(12,2),
  monto_total_usd decimal(12,2) not null,
  tc_usd_mxn decimal(10,4),
  metodo_cobro public.metodo_cobro,
  calculo_snapshot jsonb,
  motivo text,

  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,

  unique (vuelo_id, version)
);

comment on table public.cotizacion_version_history is 'Historial inmutable de versiones de cotizacion. Una fila por revision. La fila con version maxima refleja el estado actual del vuelo.';
comment on column public.cotizacion_version_history.motivo is 'Razon de la revision (ej. "Cliente cambio fecha", "Subio TC", "Aumentaron pasajeros").';

create index idx_cot_version_vuelo on public.cotizacion_version_history (vuelo_id, version desc);

-- RLS
alter table public.vuelo enable row level security;
alter table public.cotizacion_version_history enable row level security;

create policy "vuelo_read_active_user" on public.vuelo for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "cotizacion_version_history_read_active_user" on public.cotizacion_version_history for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
