-- Días de descanso de pilotos (pedido del cliente): se marcan en el calendario
-- y bloquean la asignación (aviso, no candado — consistente con el límite de
-- 90 hrs que es informativo).
create table public.piloto_descanso (
  id uuid primary key default gen_random_uuid(),
  piloto_id uuid not null references public.usuario(id) on delete cascade,
  fecha_inicio date not null,
  fecha_fin date not null,
  motivo varchar(200),
  created_by uuid references public.usuario(id),
  updated_by uuid references public.usuario(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  check (fecha_fin >= fecha_inicio)
);

create index idx_piloto_descanso_piloto on public.piloto_descanso (piloto_id, fecha_inicio);
create index idx_piloto_descanso_rango on public.piloto_descanso (fecha_inicio, fecha_fin);

comment on table public.piloto_descanso is
  'Rangos de descanso del piloto: se pintan en el calendario y marcan conflicto al asignar vuelos.';

-- Evento espejo en el Google Calendar compartido (sync best-effort).
alter table public.piloto_descanso
  add column if not exists google_calendar_id text;
