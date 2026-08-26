-- Reparto MANUAL de gastos generales entre aviones (pedido 26-ago-2026):
-- un gasto sin vuelo (Seguro IMSS $2,000) se asigna/divide entre los
-- aviones que elija la oficina con montos editables (3×$200 + 1×$1,400).
-- La fila `gasto` JAMÁS se parte (conciliación bancaria, candado de
-- duplicados y semáforo de facturación operan sobre el pago completo):
-- este hijo es la ATRIBUCIÓN. Los lectores de dinero usan el reparto
-- cuando existe (gana sobre gasto.aeronave_id) y el remanente
-- (monto − Σ repartos) queda como gasto de la EMPRESA VuelaTour — no se
-- carga a ningún avión, a propósito.
create table public.gasto_reparto (
  id uuid primary key default gen_random_uuid(),
  gasto_id uuid not null references public.gasto(id) on delete cascade,
  aeronave_id uuid not null references public.aeronave(id) on delete restrict,
  monto numeric(12,2) not null check (monto > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  unique (gasto_id, aeronave_id)
);

comment on table public.gasto_reparto is
  'Atribución manual de un gasto general a N aviones (monto en la MONEDA del gasto). Σ montos <= gasto.monto (lo valida el API); el remanente es gasto de la empresa VuelaTour.';

create index idx_gasto_reparto_gasto on public.gasto_reparto (gasto_id);
create index idx_gasto_reparto_aeronave on public.gasto_reparto (aeronave_id);

create trigger trg_gasto_reparto_set_updated_at
  before update on public.gasto_reparto
  for each row execute function public.tg_set_updated_at();

alter table public.gasto_reparto enable row level security;
