-- 4-sep-2026 · Cotización de GRUPO (varios aviones para un mismo cliente).
-- Cabecera COMERCIAL: cliente, fecha, ruta plantilla, extras del grupo con
-- cantidad × unitario, ajuste y preferencias del PDF. NUNCA guarda dinero ni
-- estado propio: cada peso vive en exactamente UN vuelo hijo (uno por avión)
-- y el total del grupo se LEE sumando los desgloses de los hijos. Así balance
-- por avión, reparto a socios, Libro Dinero y cobros siguen por vuelo sin
-- tocar ninguna fuente única (decisión 4-sep, documento "Cotización de Grupo").
-- OJO: no se crea índice único (grupo_id, grupo_posicion): el clon de
-- reassign-aircraft inserta el vuelo nuevo ANTES de cancelar el original.

create sequence if not exists public.vuelo_grupo_folio_seq;

create table if not exists public.vuelo_grupo (
  id uuid primary key default gen_random_uuid(),
  folio bigint not null unique default nextval('public.vuelo_grupo_folio_seq'),
  cliente_id uuid not null references public.cliente(id) on delete restrict,
  nombre varchar(120) not null,
  fecha_vuelo timestamptz not null,
  fecha_fin timestamptz,
  pasajeros_total integer not null check (pasajeros_total > 0),
  escalas_plantilla jsonb not null default '[]'::jsonb,
  tarifa_tipo public.tipo_tarifa not null default 'PUBLICO',
  metodo_cobro public.metodo_cobro,
  pase_abordar boolean not null default false,
  tc_usd_mxn numeric(10,4),
  extras_grupo jsonb not null default '[]'::jsonb,
  ajuste_grupo_usd numeric(12,2) not null default 0,
  vuelo_ancla_id uuid references public.vuelo(id) on delete set null,
  version integer not null default 1,
  notas text,
  notas_internas text,
  pdf_mostrar_anexo_aviones boolean not null default true,
  pdf_mostrar_subtotal_por_avion boolean not null default false,
  pdf_mostrar_precio_por_persona boolean not null default true,
  pdf_mostrar_tarifa boolean not null default false,
  cancelado_at timestamptz,
  cancelado_motivo text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.vuelo_grupo is
  'Cabecera comercial de una cotización de GRUPO (N aviones, un cliente). Sin dinero ni estado propio: se derivan de los vuelos hijos (vuelo.grupo_id).';
comment on column public.vuelo_grupo.extras_grupo is
  'Extras del grupo [{id, concepto, cantidad, unitario, moneda, aplica_iva, por_persona, reparto: POR_PAX|ANCLA|PROPORCIONAL}]. Se MATERIALIZAN en vuelo.extras de cada hijo; aquí no hay montos totales.';
comment on column public.vuelo_grupo.vuelo_ancla_id is
  'Hijo que recibe residuos de centavos y extras con reparto ANCLA.';

create index if not exists vuelo_grupo_cliente_fecha_idx
  on public.vuelo_grupo (cliente_id, fecha_vuelo);

alter table public.vuelo_grupo enable row level security;

drop trigger if exists trg_vuelo_grupo_updated_at on public.vuelo_grupo;
create trigger trg_vuelo_grupo_updated_at
  before update on public.vuelo_grupo
  for each row execute function public.tg_set_updated_at();

alter table public.vuelo
  add column if not exists grupo_id uuid references public.vuelo_grupo(id) on delete restrict,
  add column if not exists grupo_posicion smallint,
  add column if not exists grupo_pax smallint check (grupo_pax is null or grupo_pax > 0);

comment on column public.vuelo.grupo_id is
  'Vuelo HIJO de una cotización de grupo (uno por avión). Null = vuelo normal.';
comment on column public.vuelo.grupo_posicion is
  'Posición del avión dentro del grupo (1..N). Sin índice único a propósito (clon de reassign-aircraft).';
comment on column public.vuelo.grupo_pax is
  'Personas que ESTE avión transporta en el grupo (todas sus vueltas); distinto de vuelo.pasajeros (máximo por tramo).';

create index if not exists idx_vuelo_grupo
  on public.vuelo (grupo_id) where grupo_id is not null;

insert into public.alerta_config (clave, descripcion, canal, roles)
values ('grupo_desincronizado',
        'Cotización de grupo desincronizada: pasajeros por avión no cuadran, un avión operó distinto al cotizado sin recotizar o extras del grupo editados fuera del grupo',
        'ambos', array['ADMIN','COORDINADOR'])
on conflict (clave) do nothing;
