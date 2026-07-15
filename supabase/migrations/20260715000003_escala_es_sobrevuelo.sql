-- Sobrevuelo POR TRAMO en la ruta operativa: marca los tramos en que el avión
-- sobrevuela una zona (reconocimiento/foto/recorrido) en lugar de un traslado
-- punto a punto. Es metadato OPERATIVO (lo ve el piloto, como el ferry); el
-- cobro del sobrevuelo se sigue capturando en horas en el cotizador.
alter table escala
  add column if not exists es_sobrevuelo boolean not null default false;

comment on column escala.es_sobrevuelo is
  'Tramo de sobrevuelo (reconocimiento/recorrido sobre una zona), no un traslado normal. Metadato operativo por tramo.';
