-- 4-sep-2026 · Cotización de GRUPO, Fase 2: «sobre» de cobro.
-- Un pago único del cliente se registra como cobro_grupo (el sobre) y se
-- PARTE en N cobro_vuelo (uno por avión hijo) con pesos exactos. cobrosEnUsd
-- sigue leyendo SOLO cobro_vuelo (el sobre nunca entra a la suma: es
-- agrupación + conciliación). El banco enlaza al sobre (1 abono ↔ 1 sobre),
-- por eso re-partir el sobre entre los hijos vivos siempre es seguro.
-- Invariante de servicio + check nocturno: cobro_grupo.monto == Σ cobro_vuelo.monto
-- where cobro_grupo_id = sobre.

create table if not exists public.cobro_grupo (
  id uuid primary key default gen_random_uuid(),
  grupo_id uuid not null references public.vuelo_grupo(id) on delete restrict,
  monto numeric(12,2) not null check (monto <> 0), -- BRUTO; negativo = reembolso (misma convención que cobro_vuelo)
  moneda public.moneda not null,
  metodo_cobro public.metodo_cobro not null,
  tc_usd_mxn numeric(10,4),
  comision_banco_pct numeric(5,2),
  comision_banco_monto numeric(12,2),
  cuenta_destino varchar(60),
  referencia varchar(100),
  foto_voucher_url text,
  fecha_cobro timestamptz not null default now(),
  modo_particion text not null check (modo_particion in ('PROPORCIONAL','LIQUIDACION','MANUAL')),
  registrado_por uuid references public.usuario(id) on delete set null,
  notas text,
  client_request_id uuid,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null,
  constraint cobro_grupo_reembolso_sin_comision check (monto > 0 or comision_banco_monto is null)
);

comment on table public.cobro_grupo is
  'Sobre de cobro de un grupo: el pago único del cliente, partido en N cobro_vuelo (cobro_vuelo.cobro_grupo_id). No entra a cobrosEnUsd; concilia 1↔1 con el banco.';
comment on column public.cobro_grupo.modo_particion is
  'Cómo se partió: LIQUIDACION (cada hijo su saldo exacto), PROPORCIONAL (repartirUsd por total del hijo, residuo al ancla) o MANUAL (montos dados).';

create index if not exists idx_cobro_grupo_grupo
  on public.cobro_grupo (grupo_id, fecha_cobro desc);
create unique index if not exists uq_cobro_grupo_client_request
  on public.cobro_grupo (client_request_id) where client_request_id is not null;

alter table public.cobro_grupo enable row level security;

drop trigger if exists trg_cobro_grupo_updated_at on public.cobro_grupo;
create trigger trg_cobro_grupo_updated_at
  before update on public.cobro_grupo
  for each row execute function public.tg_set_updated_at();

alter table public.cobro_vuelo
  add column if not exists cobro_grupo_id uuid references public.cobro_grupo(id) on delete restrict,
  add column if not exists grupo_factor numeric(9,6);

comment on column public.cobro_vuelo.cobro_grupo_id is
  'Parte de un sobre de grupo: se edita/borra SOLO desde el grupo (409 COBRO_DE_GRUPO en PATCH/DELETE por vuelo).';
comment on column public.cobro_vuelo.grupo_factor is
  'Peso con el que este hijo recibió su parte del sobre (informativo).';

create index if not exists idx_cobro_vuelo_grupo
  on public.cobro_vuelo (cobro_grupo_id) where cobro_grupo_id is not null;

alter table public.movimiento_bancario
  add column if not exists cobro_grupo_id uuid references public.cobro_grupo(id) on delete set null;

comment on column public.movimiento_bancario.cobro_grupo_id is
  'Abono conciliado contra un sobre de grupo (excluyente con cobro_id).';

create unique index if not exists uq_mov_bancario_cobro_grupo
  on public.movimiento_bancario (cobro_grupo_id) where cobro_grupo_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'movimiento_bancario_cobro_excluyente'
      and conrelid = 'public.movimiento_bancario'::regclass
  ) then
    alter table public.movimiento_bancario
      add constraint movimiento_bancario_cobro_excluyente
      check (cobro_id is null or cobro_grupo_id is null);
  end if;
end $$;
