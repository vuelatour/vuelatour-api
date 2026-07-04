-- Vuelos creados desde "Nueva cotización · paso 1: operación": las escalas son
-- el itinerario OPERATIVO real (lo vuela el piloto) y el cotizador NUNCA debe
-- reemplazarlas con la ruta comercial (que solo sirve para el precio).
alter table public.vuelo
  add column if not exists itinerario_operativo boolean not null default false;

comment on column public.vuelo.itinerario_operativo is
  'true = las escalas son el itinerario operativo capturado al crear; el cotizador no las gestiona.';
