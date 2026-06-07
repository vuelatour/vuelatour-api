-- Datos de seguro estructurados por aeronave (aseguradora, póliza, cobertura,
-- vigencia, prima). Histórico: se conservan las pólizas anteriores; la vigente
-- es la que tiene vigente_hasta >= hoy.

create table public.aeronave_seguro (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id) on delete cascade,
  aseguradora varchar(120) not null,
  num_poliza varchar(80) not null,
  cobertura text,
  suma_asegurada_usd numeric(14, 2),
  prima_usd numeric(12, 2),
  vigente_desde date not null,
  vigente_hasta date not null,
  archivo_url text,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  constraint aeronave_seguro_vigencia_chk check (vigente_hasta >= vigente_desde)
);

comment on table public.aeronave_seguro is
  'Pólizas de seguro por aeronave. Histórico; vigente = vigente_hasta >= hoy.';

create index idx_aeronave_seguro_aeronave
  on public.aeronave_seguro (aeronave_id, vigente_hasta desc);

create trigger trg_aeronave_seguro_set_updated_at
  before update on public.aeronave_seguro
  for each row execute function public.tg_set_updated_at();

-- RLS: lectura para usuarios activos; escrituras por service-role (igual que
-- el resto del esquema de flota).
alter table public.aeronave_seguro enable row level security;
create policy "aeronave_seguro_read_active_user" on public.aeronave_seguro for select using (
  exists (
    select 1 from public.usuario u
    where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO'
  )
);
