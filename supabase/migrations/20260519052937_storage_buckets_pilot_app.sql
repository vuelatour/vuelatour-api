-- Volcada desde prod (ya aplicada como 20260519052937_storage_buckets_pilot_app):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.

-- Storage buckets for pilot mobile app captures
INSERT INTO storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
VALUES
  ('taco-fotos', 'taco-fotos', false, 5242880, ARRAY['image/jpeg','image/png','image/webp']),
  ('gasto-fotos', 'gasto-fotos', false, 5242880, ARRAY['image/jpeg','image/png','image/webp','application/pdf'])
ON CONFLICT (id) DO NOTHING;

-- RLS policies: authenticated users can read/write within their own folder (path prefix = auth.uid())
-- Reads
CREATE POLICY "taco_fotos_read_own"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'taco-fotos');

CREATE POLICY "taco_fotos_insert_auth"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'taco-fotos');

CREATE POLICY "taco_fotos_update_own"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'taco-fotos' AND owner = auth.uid());

CREATE POLICY "gasto_fotos_read_own"
ON storage.objects FOR SELECT TO authenticated
USING (bucket_id = 'gasto-fotos');

CREATE POLICY "gasto_fotos_insert_auth"
ON storage.objects FOR INSERT TO authenticated
WITH CHECK (bucket_id = 'gasto-fotos');

CREATE POLICY "gasto_fotos_update_own"
ON storage.objects FOR UPDATE TO authenticated
USING (bucket_id = 'gasto-fotos' AND owner = auth.uid());
