-- Ocultar TRAMOS individuales del PDF de cotización (27-ago, pedido del
-- cliente): cada tramo decide si aparece en título/itinerario/mapa del PDF.
-- No afecta el precio (el tramo se sigue cobrando) ni la operación.
alter table escala
  add column if not exists pdf_oculto boolean not null default false;
