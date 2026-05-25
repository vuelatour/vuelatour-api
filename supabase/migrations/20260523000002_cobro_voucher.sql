-- Tarea 11: voucher de cobro (foto) + bucket privado cobro-vouchers.
ALTER TABLE cobro_vuelo ADD COLUMN IF NOT EXISTS foto_voucher_url text;
COMMENT ON COLUMN cobro_vuelo.foto_voucher_url IS
  'Path en storage (bucket cobro-vouchers) del voucher; obligatorio para pagos con tarjeta.';

INSERT INTO storage.buckets (id, name, public)
VALUES ('cobro-vouchers', 'cobro-vouchers', false)
ON CONFLICT (id) DO NOTHING;

DROP POLICY IF EXISTS cobro_vouchers_insert_auth ON storage.objects;
DROP POLICY IF EXISTS cobro_vouchers_read_auth ON storage.objects;
DROP POLICY IF EXISTS cobro_vouchers_update_own ON storage.objects;

CREATE POLICY cobro_vouchers_insert_auth ON storage.objects
  FOR INSERT TO authenticated WITH CHECK (bucket_id = 'cobro-vouchers');
CREATE POLICY cobro_vouchers_read_auth ON storage.objects
  FOR SELECT TO authenticated USING (bucket_id = 'cobro-vouchers');
CREATE POLICY cobro_vouchers_update_own ON storage.objects
  FOR UPDATE TO authenticated USING (bucket_id = 'cobro-vouchers' AND owner = auth.uid());
