-- Tarifa preferencial por cliente y aeronave (pedido del cliente, 13 jul 2026):
-- al cotizar, si el cliente tiene tarifa pactada para el avión, esa manda sobre
-- la tarifa default (público/broker). Puede ser MAYOR o menor que la default
-- (el descuento no permitía ajustar hacia arriba). El override manual del
-- cotizador sigue teniendo prioridad sobre todo.
create table if not exists tarifa_cliente_aeronave (
  id uuid primary key default gen_random_uuid(),
  cliente_id uuid not null references cliente(id) on delete cascade,
  aeronave_id uuid not null references aeronave(id) on delete cascade,
  tarifa_hora_usd numeric(12,2) not null check (tarifa_hora_usd > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid,
  unique (cliente_id, aeronave_id)
);
create index if not exists idx_tarifa_cliente_aeronave_cliente
  on tarifa_cliente_aeronave (cliente_id);
alter table tarifa_cliente_aeronave enable row level security;
