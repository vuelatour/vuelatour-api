-- Migration: 20260514000003_aeronave_imagenes
-- Galeria de imagenes por aeronave. Las imagenes viven en Supabase Storage
-- (bucket aeronave-imagenes, publico para uso en landing). Esta tabla guarda
-- los metadatos y referencia el storage_path para poder borrar el archivo
-- cuando se elimina la fila.

create table public.aeronave_imagen (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  storage_path text not null,
  url text not null,
  alt_text varchar(200),
  orden int not null default 0,
  es_principal boolean not null default false,
  size_bytes int,
  content_type varchar(80),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.aeronave_imagen is
  'Galeria de imagenes de la aeronave. Los archivos viven en el bucket aeronave-imagenes; storage_path permite borrar el archivo cuando se elimina la fila.';

create index idx_aeronave_imagen_aeronave on public.aeronave_imagen (aeronave_id, orden);

-- Solo una imagen principal por aeronave.
create unique index aeronave_imagen_principal_unique
  on public.aeronave_imagen (aeronave_id)
  where es_principal = true;

create trigger trg_aeronave_imagen_set_updated_at
  before update on public.aeronave_imagen
  for each row execute function public.tg_set_updated_at();

alter table public.aeronave_imagen enable row level security;

create policy "aeronave_imagen_read_public" on public.aeronave_imagen
  for select using (true);
