-- Foto del producto de inventario (pedido del cliente, 14 jul 2026): una foto
-- por ítem, visible en app y panel. Par url pública + storage_path (para poder
-- borrar el archivo al reemplazar), como aeronave_imagen.
alter table inventario_item add column if not exists foto_url text;
alter table inventario_item add column if not exists foto_storage_path text;

-- Bucket PÚBLICO (la foto de un aceite no es sensible; <img> directo sin URLs
-- firmadas). OJO: policies con check SIMPLE de bucket_id — una subconsulta a
-- public.usuario en RLS de Storage rompe la subida (lección de
-- 20260616000001_fix_aeronave_imagenes_storage_rls).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'inventario-fotos',
  'inventario-fotos',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp']
)
on conflict (id) do nothing;

drop policy if exists "inventario_fotos_read_public" on storage.objects;
create policy "inventario_fotos_read_public"
  on storage.objects for select
  using (bucket_id = 'inventario-fotos');

drop policy if exists "inventario_fotos_insert_auth" on storage.objects;
create policy "inventario_fotos_insert_auth"
  on storage.objects for insert to authenticated
  with check (bucket_id = 'inventario-fotos');
