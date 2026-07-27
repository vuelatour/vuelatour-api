-- Importación de estados de cuenta como JOB en el servidor (27 jul 2026):
-- el panel lanzaba la importación y esperaba el request completo — sin
-- porcentaje y atada a la pestaña del navegador. Ahora la importación corre
-- en el backend con progreso consultable; cerrar el navegador no la corta.
create table if not exists public.conciliacion_import_job (
  id uuid primary key default gen_random_uuid(),
  cuenta_bancaria_id uuid not null references public.cuenta_bancaria(id) on delete cascade,
  estado text not null default 'PROCESANDO'
    check (estado in ('PROCESANDO', 'LISTO', 'ERROR')),
  progreso int not null default 0 check (progreso between 0 and 100),
  -- Paso legible para el usuario ("Conciliando 12 de 48…").
  paso text,
  total_movimientos int not null default 0,
  importados int,
  conciliados_auto int,
  duplicados_omitidos int,
  error text,
  created_by uuid references public.usuario(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now()
);

comment on table public.conciliacion_import_job is
  'Jobs de importación de estados de cuenta (corren en el API con progreso). El panel hace polling del avance.';

create index if not exists idx_conciliacion_import_job_cuenta
  on public.conciliacion_import_job (cuenta_bancaria_id, created_at desc);

alter table public.conciliacion_import_job enable row level security;
