-- Migration: 20260513000006_escala_y_cobros
-- escala: segmento del vuelo con tacometro (campos de tacometro vacios por ahora,
--          se llenan en FASE 3 con captura mobile).
-- cobro_vuelo: registro de cobros por vuelo (BillPocket / HSBC link / efectivo / transferencia / USD).

create table public.escala (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null references public.vuelo(id) on delete cascade,
  orden int not null check (orden >= 1),
  origen_iata varchar(4) not null,
  destino_iata varchar(4) not null,

  -- Tacometro (poblado en FASE 3 - mobile capture)
  taco_salida decimal(10,2),
  taco_llegada decimal(10,2),
  foto_taco_salida_url text,
  foto_taco_llegada_url text,
  valor_ia_propuesto decimal(10,2),

  -- Timing real (poblado por piloto)
  hora_salida timestamptz,
  hora_llegada timestamptz,

  -- Captura mobile
  capturado_offline boolean not null default false,
  sincronizado_at timestamptz,
  capturado_por uuid references public.usuario(id) on delete set null,

  -- Correcciones (mismo dia o admin con auditoria)
  corregido_por uuid references public.usuario(id) on delete set null,
  nota_correccion text,
  corregido_at timestamptz,

  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  unique (vuelo_id, orden),
  check (taco_llegada is null or taco_salida is null or taco_llegada > taco_salida)
);

comment on table public.escala is 'Cada segmento del vuelo. Tacometro se captura mobile en FASE 3.';
comment on column public.escala.orden is 'Orden de la escala dentro del vuelo (1, 2, 3...).';

create index idx_escala_vuelo on public.escala (vuelo_id, orden);

create trigger trg_escala_set_updated_at
  before update on public.escala
  for each row execute function public.tg_set_updated_at();

create table public.cobro_vuelo (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null references public.vuelo(id) on delete restrict,
  monto decimal(12,2) not null check (monto > 0),
  moneda public.moneda not null,
  metodo_cobro public.metodo_cobro not null,
  tc_usd_mxn decimal(10,4),
  referencia varchar(100),
  fecha_cobro timestamptz not null default now(),
  registrado_por uuid references public.usuario(id) on delete set null,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.cobro_vuelo is 'Cobros registrados por vuelo. Multiples cobros pueden sumar al monto_total del vuelo (pago en cuotas, abonos).';
comment on column public.cobro_vuelo.metodo_cobro is 'BILLPOCKET (sin factura), HSBC_LINK (con factura), EFECTIVO (sin IVA), TRANSFERENCIA (con factura), DOLARES.';

create index idx_cobro_vuelo_vuelo on public.cobro_vuelo (vuelo_id, fecha_cobro desc);
create index idx_cobro_vuelo_fecha on public.cobro_vuelo (fecha_cobro);

create trigger trg_cobro_vuelo_set_updated_at
  before update on public.cobro_vuelo
  for each row execute function public.tg_set_updated_at();

alter table public.escala enable row level security;
alter table public.cobro_vuelo enable row level security;

create policy "escala_read_active_user" on public.escala for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "cobro_vuelo_read_active_user" on public.cobro_vuelo for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
