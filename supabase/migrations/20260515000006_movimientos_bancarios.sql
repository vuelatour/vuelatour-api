-- Migration: 20260515000006_movimientos_bancarios
-- Modulo 5.8 Tesoreria. movimiento_bancario = cada linea de un estado de cuenta.
-- Se cargan manualmente o (a futuro) las importa el microservicio Python desde
-- Excel/CSV/PDF. La conciliacion enlaza un movimiento con un gasto capturado.

create type public.tipo_movimiento_bancario as enum ('CARGO', 'ABONO');

create type public.origen_movimiento_bancario as enum ('MANUAL', 'IMPORTADO');

create table public.movimiento_bancario (
  id uuid primary key default gen_random_uuid(),
  cuenta_bancaria_id uuid not null references public.cuenta_bancaria(id) on delete restrict,
  fecha date not null,
  tipo public.tipo_movimiento_bancario not null,
  monto numeric(14,2) not null check (monto > 0),
  descripcion text,
  referencia varchar(120),
  saldo_posterior numeric(14,2),

  conciliado boolean not null default false,
  gasto_id uuid references public.gasto(id) on delete set null,
  origen public.origen_movimiento_bancario not null default 'MANUAL',

  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  -- Un movimiento ligado a un gasto siempre esta conciliado.
  check (gasto_id is null or conciliado = true)
);

comment on table public.movimiento_bancario is 'Modulo 5.8. Linea de estado de cuenta. La conciliacion la enlaza con un gasto.';
comment on column public.movimiento_bancario.tipo is 'CARGO = salida de dinero; ABONO = entrada.';
comment on column public.movimiento_bancario.saldo_posterior is 'Saldo de la cuenta despues del movimiento, segun el estado de cuenta.';
comment on column public.movimiento_bancario.origen is 'MANUAL = capturado a mano; IMPORTADO = lo subio el microservicio Python.';

create index idx_mov_bancario_cuenta on public.movimiento_bancario (cuenta_bancaria_id, fecha desc);
create index idx_mov_bancario_gasto on public.movimiento_bancario (gasto_id);
create index idx_mov_bancario_fecha on public.movimiento_bancario (fecha desc);
create index idx_mov_bancario_pendientes on public.movimiento_bancario (cuenta_bancaria_id) where conciliado = false;

create trigger trg_movimiento_bancario_set_updated_at
  before update on public.movimiento_bancario
  for each row execute function public.tg_set_updated_at();

alter table public.movimiento_bancario enable row level security;

create policy "movimiento_bancario_read_active_user" on public.movimiento_bancario for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
