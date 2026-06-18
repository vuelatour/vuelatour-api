-- Fix: subir imágenes de aeronave fallaba con "The database schema is invalid
-- or incompatible". Las políticas de Storage de `aeronave-imagenes` eran las
-- únicas que hacían subconsulta a public.usuario dentro de la RLS; esa
-- subconsulta corre en el contexto del usuario del navegador y rompe la
-- evaluación de la política en Storage. Los buckets que sí funcionan
-- (taco-fotos, gasto-fotos, cobro-vouchers, planes-vuelo) usan un check simple
-- de bucket_id para el rol authenticated. Alineamos aeronave-imagenes a ese
-- patrón: escritura para usuarios autenticados, lectura pública (bucket público).

drop policy if exists aeronave_imagenes_insert_active_user on storage.objects;
drop policy if exists aeronave_imagenes_update_active_user on storage.objects;
drop policy if exists aeronave_imagenes_delete_active_user on storage.objects;

create policy aeronave_imagenes_insert_auth on storage.objects
  for insert to authenticated
  with check (bucket_id = 'aeronave-imagenes');

create policy aeronave_imagenes_update_auth on storage.objects
  for update to authenticated
  using (bucket_id = 'aeronave-imagenes');

create policy aeronave_imagenes_delete_auth on storage.objects
  for delete to authenticated
  using (bucket_id = 'aeronave-imagenes');

-- La lectura pública (aeronave_imagenes_read_public) se conserva sin cambios.
