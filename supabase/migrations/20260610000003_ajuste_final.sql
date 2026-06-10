-- Ajuste final de la cotización (acordado en reunión 10 jun):
-- negativo = descuento ("ciérramelo en 750"), positivo = redondeo hacia
-- arriba (números cerrados porque pagan en efectivo). Es una línea más del
-- desglose (fuera de la base de IVA) para que el balance cuadre exacto.

alter table public.vuelo
  add column if not exists ajuste_final_usd decimal(12,2) not null default 0;
alter table public.cotizacion_version_history
  add column if not exists ajuste_final_usd decimal(12,2) not null default 0;

comment on column public.vuelo.ajuste_final_usd is
  'Ajuste final del total: negativo = descuento, positivo = redondeo. Línea del desglose, fuera de IVA.';
