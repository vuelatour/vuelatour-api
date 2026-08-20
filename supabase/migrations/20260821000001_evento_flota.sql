-- Eventos NO-vuelo del calendario de flota (pedido 21-ago-2026): "lavar el
-- avión", visitas, trámites — cosas que la operación agenda y quiere ver
-- junto a los vuelos y descansos, sin inventar un vuelo falso. Se crean
-- desde la app (calendario → +) o el panel; salen en GET /v1/calendar como
-- tipo_evento 'evento'.

create table if not exists public.evento_flota (
  id uuid primary key default gen_random_uuid(),
  titulo varchar(120) not null,
  fecha timestamptz not null,
  fecha_fin timestamptz,
  aeronave_id uuid references public.aeronave(id) on delete set null,
  responsable_id uuid references public.usuario(id) on delete set null,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  constraint evento_flota_fin_coherente
    check (fecha_fin is null or fecha_fin >= fecha)
);

comment on table public.evento_flota is
  'Eventos de calendario que NO son vuelos (lavado, trámites, visitas). Avión y responsable opcionales.';

create index if not exists evento_flota_fecha_idx on public.evento_flota (fecha);

alter table public.evento_flota enable row level security;
