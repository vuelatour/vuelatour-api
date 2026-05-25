-- Tarea 14: mantenimientos de aeronave (ingeniería aeronáutica).
CREATE TABLE IF NOT EXISTS mantenimiento (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  aeronave_id uuid NOT NULL REFERENCES aeronave(id) ON DELETE CASCADE,
  tipo varchar(12) NOT NULL DEFAULT 'PROGRAMADO', -- PROGRAMADO | REALIZADO
  descripcion text NOT NULL,
  fecha_programada date,
  fecha_realizada date,
  horas_aeronave numeric,
  costo_usd numeric,
  proveedor text,
  notas text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE mantenimiento IS 'Tarea 14. Mantenimientos programados/realizados por aeronave.';
CREATE INDEX IF NOT EXISTS idx_mantenimiento_aeronave ON mantenimiento (aeronave_id, fecha_programada);
ALTER TABLE mantenimiento ENABLE ROW LEVEL SECURITY;

-- Alerta de mantenimiento programado próximo (se integra con Tarea 8).
INSERT INTO alerta_config (clave, descripcion, canal, roles, dias_anticipacion, horas_anticipacion) VALUES
  ('mantenimiento_programado', 'Mantenimiento programado próximo', 'socket', ARRAY['ADMIN','COORDINADOR'], ARRAY[15,7,1], NULL)
ON CONFLICT (clave) DO NOTHING;
