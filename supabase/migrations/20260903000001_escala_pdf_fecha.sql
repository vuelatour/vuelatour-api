-- 3-sep-2026 · Fecha SOLO para el PDF del cliente, por tramo.
-- Pedido del cliente: en el detalle de la cotización, junto al ojito de
-- "Oculto/Visible en el PDF", una fecha (sin hora) por tramo que se imprime
-- en el itinerario del PDF. Es PRESENTACIÓN PURA: no toca la ruta operativa
-- (escala.fecha_salida_plan), ni el precio, ni crea versión de cotización.
-- Un tramo oculto en el PDF no muestra su fecha. NULL = sin fecha en el PDF.
alter table public.escala
  add column if not exists pdf_fecha date;

comment on column public.escala.pdf_fecha is
  'Fecha (sin hora) que se imprime para este tramo en el PDF del cliente. Presentación pura: no afecta fecha_salida_plan ni el precio; se ignora si pdf_oculto. NULL = sin fecha.';
