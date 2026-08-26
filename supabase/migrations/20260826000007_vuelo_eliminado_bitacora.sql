-- Borrado DEFINITIVO de vuelos cancelados (pedido 26-ago-2026, solo ADMIN):
-- el registro operativo desaparece de la base, pero queda una huella
-- forense mínima (quién, cuándo, qué era) — el dinero jamás se borra por
-- esta vía: cobros (RESTRICT) y facturas (NO ACTION) bloquean en BD, y el
-- API rechaza si hay gastos ligados (gasto.vuelo_id es SET NULL y los
-- dejaría huérfanos en silencio).
create table public.vuelo_eliminado (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null,
  folio int,
  cliente_nombre text,
  matricula varchar(10),
  fecha_vuelo timestamptz,
  estado varchar(20),
  tramos int not null default 0,
  motivo text not null,
  -- Copia cruda del vuelo y sus tramos al momento del borrado (forense).
  snapshot jsonb,
  eliminado_por uuid references public.usuario(id) on delete set null,
  eliminado_at timestamptz not null default now()
);

comment on table public.vuelo_eliminado is
  'Bitácora forense de vuelos borrados definitivamente (solo ADMIN, solo CANCELADO, sin cobros/gastos/factura). No es un soft-delete: el vuelo ya no existe.';

create index idx_vuelo_eliminado_folio on public.vuelo_eliminado (folio);

alter table public.vuelo_eliminado enable row level security;
