-- ROL «DIRECCIÓN» — PASO 2 de 2 (6-nov-2026, API 0.0.126, invariante 122).
-- Aplicar DESPUÉS de 20261106000002 (el valor del enum ya confirmado).

-- 1) RLS de `usuario`: quien lee a todos era solo ADMIN; Dirección también.
--    Comparación por ::text (regla del repo: los enums se comparan en texto).
alter policy usuario_admin_select_all on public.usuario
  using (
    exists (
      select 1
      from public.usuario u
      where u.supabase_auth_id = auth.uid()
        and u.rol::text in ('ADMIN', 'DIRECCION')
        and u.estado = 'ACTIVO'
    )
  );

-- 2) Oficina que edita los documentos de la flota (políticas de Storage del
--    bucket documentos-flota): ADMIN y COORDINADOR + DIRECCION.
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
      and u.rol::text in ('DIRECCION', 'ADMIN', 'COORDINADOR')
      and u.estado = 'ACTIVO'
  );
$$;

-- 3) Las dos personas de Dirección (decisión del dueño). Idempotente: solo
--    si siguen como ADMIN.
update public.usuario
   set rol = 'DIRECCION', updated_at = now()
 where lower(email) in ('alejandro@vuelatour.com', 'pabloecanales@gmail.com')
   and rol::text = 'ADMIN';

comment on column public.usuario.rol is
  'rol_usuario. DIRECCION (6-nov-2026) = superusuario: pasa cualquier @Roles del API; ADMIN = Administración (la oficina), sin Estadísticas, Ingresos, Nómina, Gastos personales, Reparto ni Pagos a socios. Matriz: vuelatour-api/src/common/roles.util.ts (invariante 122).';
