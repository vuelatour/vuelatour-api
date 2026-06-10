-- Conceptos extra de la cotización (handler, comisariato, extensión de
-- servicios, etc.). Líneas {concepto, monto_usd, aplica_iva} que se suman al
-- total: las gravadas entran a la base de IVA, las no gravadas se suman después
-- (como los viáticos de pernocta). Editables desde el detalle de la cotización
-- (ajuste rápido) sin rearmar todo.

alter table public.vuelo
  add column if not exists extras jsonb not null default '[]'::jsonb;

comment on column public.vuelo.extras is
  'Conceptos extra de la cotización: array de {concepto, monto_usd, aplica_iva}. Se suman al total.';
