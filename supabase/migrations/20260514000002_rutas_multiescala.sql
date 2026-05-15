-- Migration: 20260514000002_rutas_multiescala
-- Extiende el catalogo de rutas para soportar itinerarios multiescala con detalle
-- por tramo (origen, destino, NM). Las rutas existentes se marcan como SIMPLE.
-- Esto permite que el cotizador reuse rutas multiescala del catalogo en vez de
-- pedir al usuario que arme los tramos cada vez.

-- 1. Nuevo enum tipo_ruta
create type public.tipo_ruta as enum ('SIMPLE', 'MULTIESCALA');

-- 2. Columna tipo en ruta_predefinida. Todas las rutas existentes quedan SIMPLE.
alter table public.ruta_predefinida
  add column tipo public.tipo_ruta not null default 'SIMPLE';

comment on column public.ruta_predefinida.tipo is
  'SIMPLE = ruta directa origen->destino (campos origen_iata/destino_iata/millas_nauticas son la fuente). MULTIESCALA = itinerario con multiples tramos, ver ruta_predefinida_tramo.';

-- 3. Eliminar la constraint unique original — ya no aplica a multiescala.
alter table public.ruta_predefinida
  drop constraint if exists ruta_predefinida_origen_iata_destino_iata_key;

-- 3.1 Replantear el unique solo para rutas SIMPLE: dos rutas SIMPLE con
--     mismo origen+destino siguen siendo invalidas, pero permitimos varias
--     MULTIESCALA con mismos extremos (itinerarios distintos).
create unique index ruta_simple_unique
  on public.ruta_predefinida (origen_iata, destino_iata)
  where tipo = 'SIMPLE';

-- 4. Tabla de tramos para rutas multiescala.
create table public.ruta_predefinida_tramo (
  id uuid primary key default gen_random_uuid(),
  ruta_id uuid not null references public.ruta_predefinida(id) on delete cascade,
  orden int not null check (orden >= 1),
  origen_iata varchar(4) not null,
  destino_iata varchar(4) not null,
  millas_nauticas decimal(8,2) not null check (millas_nauticas > 0),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  unique (ruta_id, orden)
);

comment on table public.ruta_predefinida_tramo is
  'Tramos de una ruta_predefinida tipo MULTIESCALA. Ordenados por `orden`. Continuidad (destino[i]=origen[i+1]) se valida en el service.';

create index idx_ruta_tramo_ruta on public.ruta_predefinida_tramo (ruta_id, orden);

create trigger trg_ruta_tramo_set_updated_at
  before update on public.ruta_predefinida_tramo
  for each row execute function public.tg_set_updated_at();

-- 5. RLS: lectura por usuarios activos (mismo patron que ruta_predefinida).
alter table public.ruta_predefinida_tramo enable row level security;

create policy "ruta_tramo_read_active_user" on public.ruta_predefinida_tramo for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
