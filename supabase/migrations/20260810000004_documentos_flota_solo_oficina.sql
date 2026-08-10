-- Cierra la ESCRITURA del bucket documentos-flota a oficina (ADMIN/COORDINADOR
-- activos). Antes cualquier usuario autenticado (piloto/mecánico con el JWT de
-- la app) podía subir archivos; la lectura ya era exclusiva del API (service
-- key). update/delete dejan de ser por dueño: cualquier oficina puede
-- reemplazar/limpiar archivos de otro (el reemplazo entre usuarios dejaba
-- huérfanos al fallar el delete_own silenciosamente).

-- usuario tiene RLS: la policy necesita un helper SECURITY DEFINER para leerla.
create or replace function public.es_oficina_documentos()
returns boolean
language sql
stable
security definer
set search_path to ''
as $$
  select exists (
    select 1
    from public.usuario u
    where u.supabase_auth_id = (select auth.uid())
      and u.rol in ('ADMIN', 'COORDINADOR')
      and u.estado = 'ACTIVO'
  );
$$;

comment on function public.es_oficina_documentos() is
  'true si el usuario autenticado es ADMIN/COORDINADOR activo. Para policies de storage (documentos sensibles de flota).';

drop policy if exists documentos_flota_insert_auth on storage.objects;
drop policy if exists documentos_flota_update_own on storage.objects;
drop policy if exists documentos_flota_delete_own on storage.objects;

create policy documentos_flota_insert_oficina on storage.objects
  for insert to authenticated
  with check (bucket_id = 'documentos-flota' and public.es_oficina_documentos());

create policy documentos_flota_update_oficina on storage.objects
  for update to authenticated
  using (bucket_id = 'documentos-flota' and public.es_oficina_documentos())
  with check (bucket_id = 'documentos-flota' and public.es_oficina_documentos());

create policy documentos_flota_delete_oficina on storage.objects
  for delete to authenticated
  using (bucket_id = 'documentos-flota' and public.es_oficina_documentos());
