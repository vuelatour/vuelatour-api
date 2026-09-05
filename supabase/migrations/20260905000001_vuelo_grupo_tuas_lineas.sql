-- 5-sep-2026 · Cotización de GRUPO: TUAS capturadas por aeropuerto.
-- Feedback del cliente (4-sep): el grupo necesita el mismo apartado de TUAS
-- que el cotizador de un avión (unitario + moneda por aeropuerto). La
-- cabecera sigue SIN dinero: aquí solo vive lo CAPTURADO; cada vuelo hijo
-- recibe estas líneas tal cual en su CalculateQuoteDto y resuelve su propia
-- exención por prefijo de matrícula (XA/XB/N) — el total sigue saliendo de
-- los desgloses persistidos de los hijos (consolidarDesgloses).

alter table public.vuelo_grupo
  add column if not exists tuas_lineas jsonb not null default '[]'::jsonb;

comment on column public.vuelo_grupo.tuas_lineas is
  'TUAS capturadas por aeropuerto [{iata, monto_pax, moneda: USD|MXN}], misma forma que CalculateQuoteDto.tuas_lineas. Se pasan a cada hijo; [] = catálogo. Sin montos totales (viven en los hijos).';
