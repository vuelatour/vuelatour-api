-- Clasificación de movimientos bancarios SIN vuelo (27 jul 2026): cargos y
-- abonos del banco que no corresponden a ningún gasto/cobro capturado
-- (comisiones del banco, impuestos, movimientos personales, etc.). Se
-- concilian eligiendo una clasificación del catálogo — creable desde el
-- mismo diálogo — y dejan de aparecer como Pendiente. Con notas libres.
create table if not exists public.conciliacion_clasificacion (
  id uuid primary key default gen_random_uuid(),
  nombre text not null,
  activo boolean not null default true,
  created_by uuid references public.usuario(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.conciliacion_clasificacion is
  'Catálogo de clasificaciones de conciliación para movimientos que no corresponden a ningún vuelo (comisión del banco, impuestos, personal, etc.).';

-- Único case-insensitive: "Comisión banco" y "comisión banco" son la misma.
create unique index if not exists uq_conciliacion_clasificacion_nombre
  on public.conciliacion_clasificacion (lower(nombre));

alter table public.conciliacion_clasificacion enable row level security;

alter table public.movimiento_bancario
  add column if not exists clasificacion_id uuid
    references public.conciliacion_clasificacion(id) on delete set null;

comment on column public.movimiento_bancario.clasificacion_id is
  'Conciliado por CLASIFICACIÓN (no corresponde a ningún gasto/cobro de vuelo). Excluyente con gasto_id/cobro_id: vincular un gasto/cobro la limpia.';

create index if not exists idx_mov_bancario_clasificacion
  on public.movimiento_bancario (clasificacion_id)
  where clasificacion_id is not null;
