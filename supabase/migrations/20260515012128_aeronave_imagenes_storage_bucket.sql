-- Volcada desde prod (ya aplicada como 20260515012128_aeronave_imagenes_storage_bucket):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.

-- Bucket publico para imagenes de aeronaves (uso interno + landing).
insert into storage.buckets (id, name, public, file_size_limit, allowed_mime_types)
values (
  'aeronave-imagenes',
  'aeronave-imagenes',
  true,
  10485760,
  array['image/jpeg', 'image/png', 'image/webp', 'image/avif']
)
on conflict (id) do nothing;

-- Lectura publica (el bucket es publico, pero RLS de storage.objects exige policy).
create policy "aeronave_imagenes_read_public"
  on storage.objects for select
  using (bucket_id = 'aeronave-imagenes');

-- Subida: solo usuarios autenticados activos.
create policy "aeronave_imagenes_insert_active_user"
  on storage.objects for insert
  with check (
    bucket_id = 'aeronave-imagenes'
    and exists (
      select 1 from public.usuario u
      where u.supabase_auth_id = auth.uid()
        and u.estado = 'ACTIVO'
    )
  );

-- Borrado: solo usuarios autenticados activos (el backend ademas borra via service_role).
create policy "aeronave_imagenes_delete_active_user"
  on storage.objects for delete
  using (
    bucket_id = 'aeronave-imagenes'
    and exists (
      select 1 from public.usuario u
      where u.supabase_auth_id = auth.uid()
        and u.estado = 'ACTIVO'
    )
  );

-- Update (renombrar / mover) - tambien solo activos.
create policy "aeronave_imagenes_update_active_user"
  on storage.objects for update
  using (
    bucket_id = 'aeronave-imagenes'
    and exists (
      select 1 from public.usuario u
      where u.supabase_auth_id = auth.uid()
        and u.estado = 'ACTIVO'
    )
  );
