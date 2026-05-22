-- Tarea 7: notificaciones en tiempo real (persistencia de no-leídas).
--
-- Una fila por destinatario. Las notificaciones por rol insertan una fila por
-- cada usuario del rol, de modo que el badge de no-leídas funciona por usuario.

CREATE TABLE IF NOT EXISTS notificacion (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  tipo varchar(60) NOT NULL,
  titulo text NOT NULL,
  cuerpo text,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  link text,
  leida boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  read_at timestamptz
);

COMMENT ON TABLE notificacion IS
  'Notificaciones por usuario (Tarea 7). Se emiten por socket y se persisten para el badge de no-leídas.';
COMMENT ON COLUMN notificacion.tipo IS
  'Clave del evento: vuelo_asignado, taco_capturado, cobro_registrado, permiso_emitido, alerta_sistema, etc.';
COMMENT ON COLUMN notificacion.link IS
  'Ruta in-app sugerida al tocar la notificación (ej. /admin/flights/<id>).';

CREATE INDEX IF NOT EXISTS idx_notificacion_usuario_unread
  ON notificacion (usuario_id, leida)
  WHERE leida = false;

CREATE INDEX IF NOT EXISTS idx_notificacion_usuario_fecha
  ON notificacion (usuario_id, created_at DESC);
