-- Visto bueno de administración para gastos PRELLENADOS con IA desde la app
-- (27 jul 2026): el admin en campo captura con foto+IA y alguien de
-- administración lo revisa después en el panel. No bloquea nada (el gasto ya
-- cuenta); es una bandera de revisión pendiente con auditoría de quién dio
-- el visto bueno.
alter table public.gasto
  add column if not exists requiere_visto_bueno boolean not null default false,
  add column if not exists visto_bueno_por uuid references public.usuario(id) on delete set null,
  add column if not exists visto_bueno_at timestamptz;

comment on column public.gasto.requiere_visto_bueno is
  'Capturado con prellenado de IA desde la app (flujo admin): pendiente del visto bueno de administración en el panel.';
comment on column public.gasto.visto_bueno_por is
  'Quién dio el visto bueno (administración).';

create index if not exists idx_gasto_visto_bueno
  on public.gasto (requiere_visto_bueno)
  where requiere_visto_bueno = true;
