-- Migration: 20260515000002_vencimientos_schema
-- Modulo 5.7 Vencimientos y mantenimiento.
-- tipo_documento = lista maestra configurable de tipos de documento por ambito.
-- vencimiento  = cada documento/componente con fecha o horas limite, ligado a
--                una aeronave, un piloto o un motor.
-- El estado (VIGENTE/PROXIMO/VENCIDO/PERMANENTE) lo calcula el API al leer,
-- igual que motor.horas_restantes; no se persiste.

create type public.ambito_documento as enum ('AERONAVE', 'PILOTO', 'MOTOR');
create type public.forma_vencimiento as enum ('FECHA', 'HORAS', 'PERMANENTE');

create table public.tipo_documento (
  id uuid primary key default gen_random_uuid(),
  nombre varchar(100) not null,
  ambito public.ambito_documento not null,
  forma_default public.forma_vencimiento not null default 'FECHA',
  umbral_alerta_dias int not null default 30 check (umbral_alerta_dias >= 0),
  es_critico boolean not null default false,
  notas text,
  activo boolean not null default true,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  unique (ambito, nombre)
);

comment on table public.tipo_documento is 'Modulo 5.7. Lista maestra configurable de tipos de documento por ambito.';
comment on column public.tipo_documento.umbral_alerta_dias is 'Dias antes del vencimiento para marcar PROXIMO. Configurable por tipo.';
comment on column public.tipo_documento.es_critico is 'True = un vencimiento de este tipo, vencido, bloquea la asignacion de vuelos (doc 4.3).';

create index idx_tipo_documento_ambito on public.tipo_documento (ambito);
create index idx_tipo_documento_activo on public.tipo_documento (activo) where activo = true;

create trigger trg_tipo_documento_set_updated_at
  before update on public.tipo_documento
  for each row execute function public.tg_set_updated_at();

create table public.vencimiento (
  id uuid primary key default gen_random_uuid(),
  tipo_documento_id uuid not null references public.tipo_documento(id) on delete restrict,
  aeronave_id uuid references public.aeronave(id) on delete cascade,
  piloto_id uuid references public.usuario(id) on delete cascade,
  motor_id uuid references public.motor(id) on delete cascade,

  vence_por public.forma_vencimiento not null,
  fecha_vencimiento date,
  horas_limite decimal(10,2) check (horas_limite is null or horas_limite > 0),
  umbral_alerta_dias int check (umbral_alerta_dias is null or umbral_alerta_dias >= 0),

  referencia varchar(100),
  archivo_url text,
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,

  -- exactamente un objetivo: aeronave, piloto o motor
  check (num_nonnulls(aeronave_id, piloto_id, motor_id) = 1),
  -- coherencia entre vence_por y los campos de limite
  check (
    (vence_por = 'FECHA' and fecha_vencimiento is not null and horas_limite is null)
    or (vence_por = 'HORAS' and horas_limite is not null and fecha_vencimiento is null)
    or (vence_por = 'PERMANENTE' and fecha_vencimiento is null and horas_limite is null)
  )
);

comment on table public.vencimiento is 'Modulo 5.7. Documento o componente con fecha/horas limite. estado se calcula en el API.';
comment on column public.vencimiento.umbral_alerta_dias is 'Override del umbral del tipo_documento. NULL = usa el default del tipo.';
comment on column public.vencimiento.referencia is 'Numero de poliza / folio / referencia del documento.';

create index idx_vencimiento_aeronave on public.vencimiento (aeronave_id);
create index idx_vencimiento_piloto on public.vencimiento (piloto_id);
create index idx_vencimiento_motor on public.vencimiento (motor_id);
create index idx_vencimiento_tipo on public.vencimiento (tipo_documento_id);
create index idx_vencimiento_fecha on public.vencimiento (fecha_vencimiento) where fecha_vencimiento is not null;

create trigger trg_vencimiento_set_updated_at
  before update on public.vencimiento
  for each row execute function public.tg_set_updated_at();

alter table public.tipo_documento enable row level security;
alter table public.vencimiento enable row level security;

create policy "tipo_documento_read_active_user" on public.tipo_documento for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
create policy "vencimiento_read_active_user" on public.vencimiento for select using (
  exists (select 1 from public.usuario u where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO')
);
