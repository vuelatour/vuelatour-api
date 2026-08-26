-- Observaciones humanas sobre lecturas de tacómetro (pedido 26-ago-2026):
-- el equipo anota desde "Tacómetros en vivo" el porqué de una lectura
-- (ajuste, brinco explicado, mantenimiento, etc.). La observación viaja al
-- histórico del avión y al Excel del balance (celda en ámbar + nota).
-- Independiente de revision_motivo (bitácora técnica del semáforo): esto es
-- la explicación DELIBERADA de una persona, no el estado de revisión.
alter table public.escala
  add column taco_salida_obs text,
  add column taco_llegada_obs text,
  add column taco_obs_updated_by uuid references public.usuario(id) on delete set null,
  add column taco_obs_updated_at timestamptz;

comment on column public.escala.taco_salida_obs is
  'Observación del equipo sobre la lectura de SALIDA (se muestra en histórico y balance).';
comment on column public.escala.taco_llegada_obs is
  'Observación del equipo sobre la lectura de LLEGADA (se muestra en histórico y balance).';
