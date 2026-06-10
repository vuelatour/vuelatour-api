-- Reservas tentativas y cotización abierta.
--
-- 1) estado RESERVA: vuelo apartado SIN cotización (cliente dijo "espérame y te
--    confirmo" o faltan costos para cotizar). Bloquea el espacio en el calendario
--    para no vender el mismo horario dos veces. Flujo: RESERVA -> (cotizar) ->
--    COTIZADO -> CONFIRMADO -> ... | RESERVA -> CANCELADO.
-- 2) vuelo.cotizacion_abierta: "llévame a tal lado y de ahí vemos" — el itinerario
--    crece en el camino (el piloto registra tramos desde su app) y el precio se
--    cierra re-cotizando con los tramos reales antes de cobrar/facturar.

alter type public.estado_vuelo add value if not exists 'RESERVA' before 'SOLICITUD';

alter table public.vuelo
  add column if not exists cotizacion_abierta boolean not null default false;

comment on column public.vuelo.cotizacion_abierta is
  'Vuelo abierto: el itinerario/precio se cierra al final (re-cotización con tramos reales, permitida hasta antes de cobrar/facturar).';
