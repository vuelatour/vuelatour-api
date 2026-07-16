-- Comisión bancaria por cobro: el banco deposita MENOS de lo que pagó el
-- cliente (terminal/transferencia cobran comisión) y el reporte no cuadraba
-- contra el estado de cuenta. `monto` SIGUE siendo el bruto que pagó el
-- cliente (la bandera cobrado y cobrosEnUsd no cambian); la comisión explica
-- la diferencia contra el banco: neto depositado = monto − comision_banco_monto.
alter table cobro_vuelo
  add column if not exists comision_banco_pct numeric,
  add column if not exists comision_banco_monto numeric;

comment on column cobro_vuelo.comision_banco_pct is
  'Porcentaje que el banco retiene de este cobro (ej. 2.9). Null = sin comisión.';
comment on column cobro_vuelo.comision_banco_monto is
  'Comisión en la MONEDA del cobro (monto × pct/100, redondeada). El banco deposita monto − esta comisión.';
