-- Registro histórico (opcional) de multas a aeronaves/pilotos (doc 5.7).

create table public.multa (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid references public.aeronave(id) on delete set null,
  piloto_id uuid references public.usuario(id) on delete set null,
  fecha date not null,
  monto numeric(12, 2),
  moneda varchar(4) not null default 'MXN',
  autoridad varchar(120),
  descripcion text not null,
  estado varchar(12) not null default 'PENDIENTE'
    check (estado in ('PENDIENTE', 'PAGADA', 'CANCELADA')),
  referencia varchar(120),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.multa is
  'Registro histórico opcional de multas (aeronave/piloto). Doc 5.7.';

create index idx_multa_aeronave on public.multa (aeronave_id, fecha desc);
create index idx_multa_estado on public.multa (estado);

create trigger trg_multa_set_updated_at
  before update on public.multa
  for each row execute function public.tg_set_updated_at();

alter table public.multa enable row level security;
create policy "multa_read_active_user" on public.multa for select using (
  exists (
    select 1 from public.usuario u
    where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO'
  )
);
