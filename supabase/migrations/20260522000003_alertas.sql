-- Tarea 8: alertas programadas (config + dedupe de emisiones).

CREATE TABLE IF NOT EXISTS alerta_config (
  clave varchar(40) PRIMARY KEY,
  descripcion text NOT NULL,
  activa boolean NOT NULL DEFAULT true,
  canal varchar(10) NOT NULL DEFAULT 'socket', -- socket | email | ambos
  roles text[] NOT NULL DEFAULT '{}',
  dias_anticipacion int[] NOT NULL DEFAULT '{}',
  horas_anticipacion int,
  updated_at timestamptz NOT NULL DEFAULT now(),
  updated_by uuid
);

COMMENT ON TABLE alerta_config IS
  'Tarea 8. Config por tipo de alerta: anticipación, canal y roles destinatarios.';

CREATE TABLE IF NOT EXISTS alerta_emitida (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  dedupe_key text NOT NULL UNIQUE,
  clave varchar(40) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE alerta_emitida IS
  'Tarea 8. Llave de deduplicación para no reenviar la misma alerta (por entidad + umbral).';

CREATE INDEX IF NOT EXISTS idx_alerta_emitida_clave ON alerta_emitida (clave, created_at DESC);

-- Las consultas van por service-role desde la API; RLS sin políticas cierra el
-- acceso directo por anon/authenticated sin afectar al backend.
ALTER TABLE alerta_config ENABLE ROW LEVEL SECURITY;
ALTER TABLE alerta_emitida ENABLE ROW LEVEL SECURITY;

INSERT INTO alerta_config (clave, descripcion, canal, roles, dias_anticipacion, horas_anticipacion) VALUES
  ('permiso_pista', 'Permiso de pista por vencer (vuelo próximo sigue pendiente)', 'ambos', ARRAY['ADMIN','COORDINADOR'], '{}', 48),
  ('vencimiento', 'Vencimiento de documentos/licencias/permisos', 'socket', ARRAY['ADMIN'], ARRAY[30,15,7], NULL),
  ('cobro_pendiente', 'Vuelo completado sin cobrar', 'socket', ARRAY['ADMIN','FACTURACION'], ARRAY[3], NULL),
  ('inventario_bajo', 'Inventario por debajo del stock mínimo', 'socket', ARRAY['ADMIN'], '{}', NULL)
ON CONFLICT (clave) DO NOTHING;
