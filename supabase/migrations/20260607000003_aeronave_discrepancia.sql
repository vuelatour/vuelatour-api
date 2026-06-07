-- Bitácora de discrepancias / squawks por aeronave: fallas o anomalías
-- reportadas (típicamente por el piloto) y su resolución. Crítico en aviación.

create table public.aeronave_discrepancia (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  vuelo_id uuid references public.vuelo(id) on delete set null,
  descripcion text not null,
  severidad varchar(6) not null default 'MEDIA'
    check (severidad in ('BAJA', 'MEDIA', 'ALTA')),
  estado varchar(12) not null default 'ABIERTA'
    check (estado in ('ABIERTA', 'EN_PROGRESO', 'RESUELTA')),
  reportado_por uuid references public.usuario(id) on delete set null,
  fecha_reporte date not null default current_date,
  resolucion text,
  fecha_resolucion date,
  resuelto_por uuid references public.usuario(id) on delete set null,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.aeronave_discrepancia is
  'Bitácora de discrepancias/squawks por aeronave: falla reportada -> resolución.';

create index idx_aeronave_discrepancia_aeronave
  on public.aeronave_discrepancia (aeronave_id, estado, fecha_reporte desc);

create trigger trg_aeronave_discrepancia_set_updated_at
  before update on public.aeronave_discrepancia
  for each row execute function public.tg_set_updated_at();

alter table public.aeronave_discrepancia enable row level security;
create policy "aeronave_discrepancia_read_active_user" on public.aeronave_discrepancia for select using (
  exists (
    select 1 from public.usuario u
    where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO'
  )
);
