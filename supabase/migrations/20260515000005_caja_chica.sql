-- Migration: 20260515000005_caja_chica
-- Modulo 5.5 Caja chica y fondos.
-- fondo_caja       = el fondo de una persona (FIJO administrado por Mary, o
--                    REINTEGRO de gastos personales que la empresa devuelve).
-- movimiento_fondo = reposiciones / reintegros, con flujo de autorizacion (Ale).
-- El saldo de cada fondo lo calcula el API: monto_asignado +/- movimientos
-- autorizados +/- gastos (inferidos de gasto.usuario_captura_id + medio_pago).

create type public.tipo_fondo as enum ('FIJO', 'REINTEGRO');

create type public.tipo_movimiento_fondo as enum (
  'REPOSICION',
  'REINTEGRO',
  'AJUSTE'
);

create type public.estado_movimiento_fondo as enum (
  'SOLICITADO',
  'AUTORIZADO',
  'RECHAZADO'
);

create table public.fondo_caja (
  id uuid primary key default gen_random_uuid(),
  usuario_id uuid not null references public.usuario(id) on delete restrict,
  tipo public.tipo_fondo not null,
  medio_pago_asociado public.medio_pago not null,
  monto_asignado numeric(12,2) not null default 0 check (monto_asignado >= 0),
  moneda public.moneda not null default 'MXN',
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  unique (usuario_id, tipo),
  -- Solo medios de pago tipo caja chica enlazan a un fondo.
  check (medio_pago_asociado in ('EFECTIVO', 'PERSONAL_PABLO', 'PERSONAL_ALE'))
);

comment on table public.fondo_caja is 'Modulo 5.5. Fondo de caja chica de una persona. saldo se calcula en el API.';
comment on column public.fondo_caja.tipo is 'FIJO = fondo semanal que administra Mary. REINTEGRO = gasta su dinero y la empresa reintegra.';
comment on column public.fondo_caja.medio_pago_asociado is 'medio_pago de los gastos que consumen este fondo: EFECTIVO (FIJO) o PERSONAL_PABLO/PERSONAL_ALE (REINTEGRO).';
comment on column public.fondo_caja.monto_asignado is 'Monto objetivo del fondo FIJO. En REINTEGRO se deja en 0.';

create index idx_fondo_caja_usuario on public.fondo_caja (usuario_id);
create index idx_fondo_caja_activo on public.fondo_caja (activo) where activo = true;

create trigger trg_fondo_caja_set_updated_at
  before update on public.fondo_caja
  for each row execute function public.tg_set_updated_at();

create table public.movimiento_fondo (
  id uuid primary key default gen_random_uuid(),
  fondo_id uuid not null references public.fondo_caja(id) on delete restrict,
  tipo public.tipo_movimiento_fondo not null,
  monto numeric(12,2) not null check (monto > 0),
  fecha date not null default current_date,
  estado public.estado_movimiento_fondo not null default 'SOLICITADO',
  solicitado_por uuid not null references public.usuario(id) on delete restrict,
  autorizado_por uuid references public.usuario(id) on delete set null,
  autorizado_at timestamptz,
  referencia varchar(100),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  -- SOLICITADO <=> sin autorizar; AUTORIZADO/RECHAZADO <=> con autorizador.
  check ((estado = 'SOLICITADO') = (autorizado_por is null))
);

comment on table public.movimiento_fondo is 'Modulo 5.5. Reposicion (FIJO) o reintegro (REINTEGRO) de un fondo. Solo los AUTORIZADO afectan el saldo.';
comment on column public.movimiento_fondo.tipo is 'REPOSICION = recarga de fondo FIJO. REINTEGRO = pago de gastos personales. AJUSTE = correccion.';

create index idx_movimiento_fondo_fondo on public.movimiento_fondo (fondo_id, fecha desc);
create index idx_movimiento_fondo_estado on public.movimiento_fondo (estado);

create trigger trg_movimiento_fondo_set_updated_at
  before update on public.movimiento_fondo
  for each row execute function public.tg_set_updated_at();

alter table public.fondo_caja enable row level security;
alter table public.movimiento_fondo enable row level security;

create policy "fondo_caja_read_active_user" on public.fondo_caja for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "movimiento_fondo_read_active_user" on public.movimiento_fondo for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
