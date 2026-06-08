-- Sincronización del tramo de REGRESO a Google Calendar (vuelos redondos):
-- guardamos el id del segundo evento (el de fecha_traslado_final) por separado.

alter table public.vuelo
  add column if not exists google_calendar_regreso_id text;

comment on column public.vuelo.google_calendar_regreso_id is
  'Event id en Google Calendar del tramo de REGRESO (vuelos redondos).';
