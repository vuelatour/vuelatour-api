-- Endurece el bucket documentos-flota (hallazgos de revisión):
-- 1) QUITA la lectura abierta a authenticated: los documentos son sensibles
--    (licencias/seguros) y solo la oficina debe verlos. El panel NO lee
--    directo del bucket — pide una URL firmada al API (service key, que
--    ignora RLS), así que esta policy era un vector: un piloto con su JWT
--    podía descargar del bucket. Sin ella, el único lector es el API gateado.
-- 2) AGREGA borrado del dueño: para limpiar el archivo viejo al reemplazar/
--    quitar (evita huérfanos).
drop policy if exists "documentos_flota_read_auth" on storage.objects;

create policy "documentos_flota_delete_own"
on storage.objects for delete to authenticated
using (bucket_id = 'documentos-flota' and owner = auth.uid());
