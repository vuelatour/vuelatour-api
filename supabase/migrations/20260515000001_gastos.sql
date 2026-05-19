-- Migration: 20260515000001_gastos
-- Modulo 5.3 Gastos operativos. Cada gasto individual capturado por cualquier
-- persona (piloto/oficina). aeronave_id NULL = bandeja de pendientes (sin avion
-- asignado todavia). duplicado_sospechado lo marca el API al detectar mismo
-- monto + proveedor + fecha cercana.

create type public.categoria_gasto as enum (
  'GAS',
  'ATERRIZAJE',
  'TUAS',
  'FBO',
  'COMIDA',
  'HOTEL',
  'TAXI',
  'REFACCION',
  'PERMISO',
  'FIJO',
  'OTRO'
);

create type public.medio_pago as enum (
  'EFECTIVO',
  'TARJETA_CORP',
  'PERSONAL_PABLO',
  'PERSONAL_ALE',
  'TRANSFERENCIA'
);

create type public.estatus_comprobante as enum (
  'FACTURA',
  'VALE',
  'SIN_COMPROBANTE'
);

create table public.gasto (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid references public.vuelo(id) on delete set null,
  aeronave_id uuid references public.aeronave(id) on delete set null,
  usuario_captura_id uuid not null references public.usuario(id) on delete restrict,

  categoria public.categoria_gasto not null,
  monto decimal(12,2) not null check (monto > 0),
  moneda public.moneda not null,
  tc_gasto decimal(10,4) check (tc_gasto is null or tc_gasto > 0),
  fecha_gasto date not null,

  proveedor_id uuid references public.proveedor(id) on delete set null,
  medio_pago public.medio_pago not null,
  tarjeta_terminacion varchar(4) check (tarjeta_terminacion ~ '^\d{4}$'),
  estatus_comprobante public.estatus_comprobante not null default 'SIN_COMPROBANTE',

  foto_url text,
  valor_ia_extraido jsonb,
  conciliado boolean not null default false,
  duplicado_sospechado boolean not null default false,

  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  -- tarjeta_terminacion solo tiene sentido con medio_pago TARJETA_CORP
  check (tarjeta_terminacion is null or medio_pago = 'TARJETA_CORP')
);

comment on table public.gasto is 'Modulo 5.3. Cada gasto individual. aeronave_id NULL = bandeja de pendientes.';
comment on column public.gasto.aeronave_id is 'NULL = pendiente de asignar a un avion (bandeja de pendientes, meta: siempre vacia).';
comment on column public.gasto.tc_gasto is 'TC DOF del dia. Siempre DOF para gastos.';
comment on column public.gasto.estatus_comprobante is 'VALE = gasto en efectivo sin factura; no entra en cierre mensual.';
comment on column public.gasto.valor_ia_extraido is 'JSON crudo de lo que la IA leyo del ticket (auditoria).';
comment on column public.gasto.duplicado_sospechado is 'Flag automatico: mismo monto + proveedor + fecha cercana que otro gasto.';

create index idx_gasto_aeronave on public.gasto (aeronave_id);
create index idx_gasto_vuelo on public.gasto (vuelo_id);
create index idx_gasto_fecha on public.gasto (fecha_gasto desc);
create index idx_gasto_categoria on public.gasto (categoria);
create index idx_gasto_medio_pago on public.gasto (medio_pago);
create index idx_gasto_pendientes on public.gasto (created_at desc) where aeronave_id is null;
create index idx_gasto_dup_lookup on public.gasto (proveedor_id, monto, fecha_gasto);

create trigger trg_gasto_set_updated_at
  before update on public.gasto
  for each row execute function public.tg_set_updated_at();

alter table public.gasto enable row level security;

create policy "gasto_read_active_user" on public.gasto for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
