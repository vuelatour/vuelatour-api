-- Tarea 1: tipo de vuelo solo REDONDO/MULTIESCALA + fechas de traslado.
--
-- 1) Migra cualquier vuelo SENCILLO a REDONDO (en la práctica 0 filas).
-- 2) Agrega fecha_traslado_final (regreso a base). fecha_vuelo pasa a ser,
--    semánticamente, la "fecha de traslado inicial" (salida) — se conserva el
--    nombre de columna para no romper calendar/dashboard/app piloto.
-- 3) Elimina SENCILLO del enum tipo_vuelo (solo vuelo.tipo depende de él).

UPDATE vuelo SET tipo = 'REDONDO' WHERE tipo = 'SENCILLO';

ALTER TABLE vuelo ADD COLUMN IF NOT EXISTS fecha_traslado_final timestamptz;

COMMENT ON COLUMN vuelo.fecha_vuelo IS 'Fecha de traslado inicial (salida). Etiqueta en UI: "Fecha de traslado inicial".';
COMMENT ON COLUMN vuelo.fecha_traslado_final IS 'Fecha de traslado final (regreso a base) en vuelos redondos.';

-- Recrear el enum sin SENCILLO. vuelo.tipo es la única columna que lo usa.
ALTER TABLE vuelo ALTER COLUMN tipo DROP DEFAULT;
ALTER TYPE tipo_vuelo RENAME TO tipo_vuelo_old;
CREATE TYPE tipo_vuelo AS ENUM ('REDONDO', 'MULTIESCALA');
ALTER TABLE vuelo
  ALTER COLUMN tipo TYPE tipo_vuelo USING tipo::text::tipo_vuelo;
ALTER TABLE vuelo ALTER COLUMN tipo SET DEFAULT 'REDONDO';
DROP TYPE tipo_vuelo_old;
