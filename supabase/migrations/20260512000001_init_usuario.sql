-- Migration: 20260512000001_init_usuario
-- Creates the application-level `usuario` table linked to auth.users
-- and the trigger that provisions a row on auth signup.

create type public.rol_usuario as enum (
  'ADMIN',
  'COORDINADOR',
  'ANALISTA',
  'FACTURACION',
  'PILOTO',
  'SOCIO'
);

create type public.estado_usuario as enum (
  'ACTIVO',
  'INACTIVO',
  'INVITADO'
);

create table public.usuario (
  id uuid primary key default gen_random_uuid(),
  supabase_auth_id uuid not null unique references auth.users(id) on delete cascade,
  nombre varchar(100) not null,
  email varchar(255) not null unique,
  rol public.rol_usuario not null default 'PILOTO',
  estado public.estado_usuario not null default 'INVITADO',
  tiene_fondo_caja boolean not null default false,
  tarjeta_terminacion varchar(4),
  es_piloto_externo boolean not null default false,
  telefono varchar(20),
  avatar_url text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.usuario is 'Application-level user. Linked to auth.users via supabase_auth_id. Role determines RBAC across all modules.';
comment on column public.usuario.rol is 'ADMIN | COORDINADOR | ANALISTA | FACTURACION | PILOTO | SOCIO';
comment on column public.usuario.estado is 'ACTIVO required to authenticate via the API';
comment on column public.usuario.es_piloto_externo is 'Pilotos externos no tienen acceso a la app; sus tacómetros los sube Itzel';

create index idx_usuario_supabase_auth_id on public.usuario (supabase_auth_id);
create index idx_usuario_rol on public.usuario (rol);
create index idx_usuario_activos on public.usuario (estado) where estado = 'ACTIVO';

create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

create trigger trg_usuario_set_updated_at
  before update on public.usuario
  for each row execute function public.tg_set_updated_at();

create or replace function public.tg_handle_new_auth_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  insert into public.usuario (supabase_auth_id, nombre, email, rol, estado)
  values (
    new.id,
    coalesce(new.raw_user_meta_data->>'full_name', new.raw_user_meta_data->>'name', new.email),
    new.email,
    'PILOTO',
    'INVITADO'
  )
  on conflict (supabase_auth_id) do nothing;
  return new;
end;
$$;

drop trigger if exists trg_on_auth_user_created on auth.users;
create trigger trg_on_auth_user_created
  after insert on auth.users
  for each row execute function public.tg_handle_new_auth_user();

alter table public.usuario enable row level security;

create policy "usuario_self_select" on public.usuario
  for select
  using (supabase_auth_id = auth.uid());

create policy "usuario_admin_select_all" on public.usuario
  for select
  using (
    exists (
      select 1 from public.usuario u
      where u.supabase_auth_id = auth.uid()
        and u.rol = 'ADMIN'
        and u.estado = 'ACTIVO'
    )
  );
