-- Bucket privado para COPIAS de documentos de la flota (permisos, licencias,
-- seguros — vencimiento.archivo_url guarda el PATH). Mismo patrón que
-- gasto-fotos: sube cualquier autenticado, se ve con URL firmada.
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'documentos-flota', 'documentos-flota', false, 10485760,
  array['image/jpeg','image/png','image/webp','application/pdf']
)
on conflict (id) do nothing;

create policy "documentos_flota_read_auth"
on storage.objects for select to authenticated
using (bucket_id = 'documentos-flota');

create policy "documentos_flota_insert_auth"
on storage.objects for insert to authenticated
with check (bucket_id = 'documentos-flota');

create policy "documentos_flota_update_own"
on storage.objects for update to authenticated
using (bucket_id = 'documentos-flota' and owner = auth.uid());
