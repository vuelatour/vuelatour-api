-- Volcada desde prod (ya aplicada como 20260622232823_aeronave_programa_servicio):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.

-- Programa de servicio por horas de la aeronave: secuencia de intervalos que se
-- repite (ej. Cessna 50,100,200 → servicios a +50, +150, +350 y vuelve a
-- empezar; Seneca/Kodiak {100} = cada 100 h). `servicio_horas_base` es el
-- horómetro (Hobbs) donde arranca la secuencia (cero del programa).
alter table public.aeronave
  add column if not exists servicio_intervalos numeric[] not null default '{}',
  add column if not exists servicio_horas_base numeric not null default 0;

comment on column public.aeronave.servicio_intervalos is
  'Secuencia de intervalos de servicio en horas que se repite (ej. {50,100,200}). Vacío = sin programa.';
comment on column public.aeronave.servicio_horas_base is
  'Horómetro (Hobbs) donde arranca la secuencia de servicios (cero del programa).';

-- A las cuántas horas DEBÍA entrar el servicio (umbral programado), para
-- compararlo contra horas_aeronave (a las que entró realmente).
alter table public.mantenimiento
  add column if not exists horas_programadas numeric;

comment on column public.mantenimiento.horas_programadas is
  'Horas de aeronave a las que el servicio debía entrar (umbral del programa). El delta vs horas_aeronave indica si entró antes/después.';
