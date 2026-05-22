-- Tarea 2: permisos por pista + foto de plan de vuelo.
--
-- 1) aeropuerto.requiere_permiso: pistas que exigen tramitar permiso antes del
--    vuelo (catálogo editable desde el panel admin).
-- 2) vuelo.estado_permiso: no_aplica | pendiente | emitido. Default no_aplica;
--    el API lo pone en pendiente al crear si origen/destino requiere permiso.
-- 3) vuelo.foto_plan_vuelo_url: foto opcional del plan de vuelo de salida.
-- 4) Seed: HOL (Holbox), MHL (Mahahual), PTU (Pulticub) requieren permiso.
-- 5) Bucket privado planes-vuelo para las fotos.

ALTER TABLE aeropuerto
  ADD COLUMN IF NOT EXISTS requiere_permiso boolean NOT NULL DEFAULT false;

COMMENT ON COLUMN aeropuerto.requiere_permiso IS
  'Pista que exige tramitar permiso antes del vuelo. Edita en panel admin (Aeropuertos).';

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_type WHERE typname = 'estado_permiso') THEN
    CREATE TYPE estado_permiso AS ENUM ('no_aplica', 'pendiente', 'emitido');
  END IF;
END$$;

ALTER TABLE vuelo
  ADD COLUMN IF NOT EXISTS estado_permiso estado_permiso NOT NULL DEFAULT 'no_aplica';
ALTER TABLE vuelo
  ADD COLUMN IF NOT EXISTS foto_plan_vuelo_url text;

COMMENT ON COLUMN vuelo.estado_permiso IS
  'Permiso de pista: no_aplica | pendiente | emitido. pendiente = pinta el evento de Calendar en color de alerta.';
COMMENT ON COLUMN vuelo.foto_plan_vuelo_url IS
  'Foto opcional del plan de vuelo de salida (vuelos hacia/desde pistas con permiso).';

-- Seed de pistas con permiso requerido. HOL ya existe en el catálogo; MHL y
-- PTU son pistas pequeñas que se crean aquí si faltan.
UPDATE aeropuerto SET requiere_permiso = true
WHERE upper(iata) IN ('HOL', 'MHL', 'PTU');

INSERT INTO aeropuerto (iata, nombre, ciudad, pais, requiere_permiso, activo)
VALUES
  ('MHL', 'Mahahual', 'Mahahual', 'MX', true, true),
  ('PTU', 'Pulticub', 'Pulticub', 'MX', true, true)
ON CONFLICT (iata) DO UPDATE SET requiere_permiso = true;

-- Bucket privado para fotos de plan de vuelo.
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES ('planes-vuelo', 'planes-vuelo', false, 5242880,
        ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

CREATE POLICY "planes_vuelo_read_auth"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'planes-vuelo');

CREATE POLICY "planes_vuelo_insert_auth"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'planes-vuelo');

CREATE POLICY "planes_vuelo_update_own"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'planes-vuelo' AND owner = auth.uid());
