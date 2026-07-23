-- Comisión del vendedor — regla nueva (jul 2026): se SUMA al precio del
-- cliente (componente canónico pre-IVA del desglose v1.3) y estrena la
-- modalidad POR_HORA (tarifa USD/hr × horas cobradas, recalculada al revisar).
-- FIJA conserva el monto capturado en comision_vendedor_usd.
alter table public.vuelo
  add column if not exists comision_vendedor_modo text
    check (comision_vendedor_modo in ('FIJA','POR_HORA')),
  add column if not exists comision_vendedor_tarifa_hr numeric(10,2);

comment on column public.vuelo.comision_vendedor_modo is
  'Modalidad de la comisión del vendedor: FIJA (monto) o POR_HORA (tarifa × horas cobradas). NULL = sin comisión activa.';
comment on column public.vuelo.comision_vendedor_tarifa_hr is
  'Tarifa USD por hora cobrada de la comisión del vendedor (solo modo POR_HORA).';
