-- Migration: 20260513000003_rutas_predefinidas_schema
-- Rutas guardadas para no recalcular millas nauticas. Pedido explicito de Itzel (doc §3.1, §5.1).
-- Al cotizar una ruta nueva, queda guardada para reutilizar.

create table public.ruta_predefinida (
  id uuid primary key default gen_random_uuid(),
  origen_iata varchar(4) not null,
  destino_iata varchar(4) not null,
  millas_nauticas decimal(8,2) not null check (millas_nauticas > 0),
  es_redondo_auto boolean not null default true,
  num_aterrizajes int not null default 2 check (num_aterrizajes >= 1),
  fuente varchar(50),
  notas text,
  activa boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  unique (origen_iata, destino_iata)
);

comment on table public.ruta_predefinida is 'Catalogo de rutas con millas nauticas. Vuelos SIEMPRE regresan a CUN.';
comment on column public.ruta_predefinida.millas_nauticas is
  'Si es_redondo_auto=true, este valor es ONE-WAY y el motor de cotizacion lo multiplica por 2. Si false (multi-escala), este valor es la suma total del recorrido incluyendo regreso.';
comment on column public.ruta_predefinida.es_redondo_auto is
  'True para rutas simples CUN-X-CUN (motor multiplica NM por 2). False para multi-escala o cuando ya se incluyo el regreso.';
comment on column public.ruta_predefinida.num_aterrizajes is
  'Numero total de aterrizajes (no escalas). Sencillo redondo = 2 (X + CUN). Multi-escala = numero de aterrizajes en orden del itinerario.';
comment on column public.ruta_predefinida.fuente is
  'Origen del dato: GOOGLE_EARTH (Itzel manual), FOREFLIGHT (Pablo), MANUAL, IMPORTADO.';

create index idx_ruta_origen on public.ruta_predefinida (origen_iata);
create index idx_ruta_destino on public.ruta_predefinida (destino_iata);
create index idx_ruta_activa on public.ruta_predefinida (activa) where activa = true;

create trigger trg_ruta_set_updated_at
  before update on public.ruta_predefinida
  for each row execute function public.tg_set_updated_at();

alter table public.ruta_predefinida enable row level security;

create policy "ruta_read_active_user" on public.ruta_predefinida for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
