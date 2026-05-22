-- Tarea 6: soporte IA tacómetros + tiempos promedio por tramo.
--
-- 1) tramo_tiempo_promedio: tiempo histórico (minutos) por par origen-destino,
--    alimentado al completar vuelos. Se usa para sugerir lecturas y detectar
--    inconsistencias.
-- 2) escala.revision_requerida / revision_motivo: marca AMARILLA en el panel
--    cuando la lectura del tacómetro es inconsistente o estimada por IA/promedio.

CREATE TABLE IF NOT EXISTS tramo_tiempo_promedio (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  origen_iata varchar(4) NOT NULL,
  destino_iata varchar(4) NOT NULL,
  minutos_promedio numeric NOT NULL DEFAULT 0,
  muestras integer NOT NULL DEFAULT 0,
  updated_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (origen_iata, destino_iata)
);

COMMENT ON TABLE tramo_tiempo_promedio IS
  'Tiempo promedio histórico por tramo (origen→destino), en minutos. Recalculado al completar vuelos.';

ALTER TABLE escala
  ADD COLUMN IF NOT EXISTS revision_requerida boolean NOT NULL DEFAULT false;
ALTER TABLE escala
  ADD COLUMN IF NOT EXISTS revision_motivo text;

COMMENT ON COLUMN escala.revision_requerida IS
  'true = la lectura del tacómetro necesita revisión manual (inconsistencia o valor estimado). Se muestra en amarillo.';
COMMENT ON COLUMN escala.revision_motivo IS
  'Motivo de la revisión (ej. "Δtaco vs duración fuera de rango", "estimado por promedio histórico").';
