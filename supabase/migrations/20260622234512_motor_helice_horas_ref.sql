-- Volcada desde prod (ya aplicada como 20260622234512_motor_helice_horas_ref):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.

-- Referencia para acumular horas de vida automáticamente: el horómetro (Hobbs)
-- del avión cuando se registró `horas_totales`. Horas actuales del componente =
-- horas_totales + (Hobbs actual del avión − aeronave_horas_ref).
alter table public.motor
  add column if not exists aeronave_horas_ref numeric;
alter table public.helice
  add column if not exists aeronave_horas_ref numeric;

comment on column public.motor.aeronave_horas_ref is
  'Hobbs del avión cuando se fijó horas_totales; permite acumular horas de vida con lo volado.';
comment on column public.helice.aeronave_horas_ref is
  'Hobbs del avión cuando se fijó horas_totales; permite acumular horas de vida con lo volado.';
