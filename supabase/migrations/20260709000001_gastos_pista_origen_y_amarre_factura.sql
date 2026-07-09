-- Gastos de pista (VIP SAESA): origen de captura, liga a escala/aterrizaje,
-- amarre 1 factura recibida -> N gastos, y tarifario de aeródromos.

-- 1) Origen de captura: distintivo pedido por el cliente (quién sube el gasto).
alter table gasto add column if not exists origen varchar(12);

update gasto g
set origen = case u.rol::text
  when 'PILOTO' then 'PILOTO'
  when 'MECANICO' then 'MECANICO'
  else 'OFICINA'
end
from usuario u
where u.id = g.usuario_captura_id and g.origen is null;

alter table gasto drop constraint if exists gasto_origen_chk;
alter table gasto add constraint gasto_origen_chk
  check (origen is null or origen in ('PILOTO','MECANICO','OFICINA','SISTEMA'));

-- 2) Granularidad por aterrizaje: el gasto de pista se liga a la escala.
alter table gasto add column if not exists escala_id uuid references escala(id) on delete set null;
create index if not exists idx_gasto_escala on gasto(escala_id) where escala_id is not null;

-- 3) Amarre 1 factura recibida -> N gastos (una factura de VIP SAESA ampara
--    varios aterrizajes/servicios). factura_recibida.gasto_id queda como legacy.
alter table gasto add column if not exists factura_recibida_id uuid references factura_recibida(id) on delete set null;
create index if not exists idx_gasto_factura_recibida on gasto(factura_recibida_id) where factura_recibida_id is not null;

-- 4) Tarifario de aeródromos (cuotas de aterrizaje por modelo de avión).
--    codigo_iata null = aplica a cualquier aeródromo; modelo null = cualquier avión.
--    variable = true (p.ej. PCE): el monto es estimado y se ajusta al confirmar.
create table if not exists tarifa_aerodromo (
  id uuid primary key default gen_random_uuid(),
  codigo_iata varchar(8),
  modelo varchar(80),
  monto numeric(12,2) not null check (monto >= 0),
  moneda varchar(3) not null default 'MXN',
  variable boolean not null default false,
  activo boolean not null default true,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid,
  updated_by uuid
);
create unique index if not exists uq_tarifa_aerodromo
  on tarifa_aerodromo (coalesce(codigo_iata,'*'), coalesce(modelo,'*'));
alter table tarifa_aerodromo enable row level security;

-- Seed con el tarifario que dictó el cliente (post-it 8 jul 2026, VIP SAESA):
insert into tarifa_aerodromo (codigo_iata, modelo, monto, moneda, variable, notas)
values
  (null, 'Kodiak', 2801.40, 'MXN', false, 'Tarifa VIP SAESA por aterrizaje (cliente, jul 2026)'),
  (null, 'Cessna', 1118.12, 'MXN', false, 'Tarifa VIP SAESA por aterrizaje (cliente, jul 2026)'),
  (null, 'Seneca', 2231.37, 'MXN', false, 'Tarifa VIP SAESA por aterrizaje (cliente, jul 2026)'),
  ('PCE', null, 0, 'MXN', true, 'Playa del Carmen: tarifa variable, ajustar al confirmar')
on conflict do nothing;
