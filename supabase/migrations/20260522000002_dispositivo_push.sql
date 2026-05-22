-- Tarea 7-B: tokens de dispositivo para push (FCM/APNs vía Firebase).

CREATE TABLE IF NOT EXISTS dispositivo_push (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  usuario_id uuid NOT NULL REFERENCES usuario(id) ON DELETE CASCADE,
  token text NOT NULL UNIQUE,
  plataforma varchar(10) NOT NULL DEFAULT 'android',
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

COMMENT ON TABLE dispositivo_push IS
  'Tokens FCM/APNs por usuario (Tarea 7-B). Se usan para entregar notificaciones push con la app en background.';
COMMENT ON COLUMN dispositivo_push.plataforma IS 'android | ios | web';

CREATE INDEX IF NOT EXISTS idx_dispositivo_push_usuario
  ON dispositivo_push (usuario_id);
