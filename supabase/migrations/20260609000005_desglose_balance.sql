-- Desglose para el balance (Jimmy): cada concepto cobrado al cliente debe ser
-- consultable por separado (tiempo de vuelo, TUAS, extras, pernocta, IVA) — un
-- total global no sirve para el balance. Se promueven a columnas los dos
-- componentes que solo vivían dentro del snapshot JSON.

alter table public.vuelo
  add column if not exists viaticos_pernocta_usd decimal(12,2) not null default 0,
  add column if not exists extras_total_usd decimal(12,2) not null default 0;

comment on column public.vuelo.viaticos_pernocta_usd is
  'Viáticos por pernocta cobrados al cliente (fuera de base de IVA). Componente del total.';
comment on column public.vuelo.extras_total_usd is
  'Suma de conceptos extra (handler, comisariato, etc.). Componente del total; detalle en vuelo.extras.';

-- Backfill desde el snapshot de cálculo para cotizaciones existentes.
update public.vuelo
set
  viaticos_pernocta_usd = coalesce(
    (calculo_snapshot -> 'totales' ->> 'viaticos_pernocta_usd')::decimal, 0
  ),
  extras_total_usd = coalesce(
    (calculo_snapshot -> 'totales' ->> 'extras_total_usd')::decimal, 0
  )
where calculo_snapshot is not null;
