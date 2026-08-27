-- Presentación del PDF de cotización (27-ago, pedido del cliente): por
-- cotización se decide si el PDF muestra la tarifa por hora (APAGADO por
-- defecto — regla 26-ago de ocultar horas/tarifa se vuelve configurable) y
-- si muestra la tabla del itinerario (PRENDIDO por defecto).
alter table vuelo
  add column if not exists pdf_mostrar_tarifa boolean not null default false,
  add column if not exists pdf_mostrar_itinerario boolean not null default true;
