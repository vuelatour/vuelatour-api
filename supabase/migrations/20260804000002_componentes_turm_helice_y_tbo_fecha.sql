-- Hélices y motores: overhaul por calendario y TURM en hélices (4 ago 2026).
--
-- 1) helice.turm: lectura del TACÓMETRO del avión en la última reparación
--    mayor (mismo significado que motor.turm) — sin él, "desde overhaul" de
--    una hélice no se puede calcular (caso N990GG: OVH 2020 solo en notas).
-- 2) tbo_fecha en motor y helice: fecha límite CALENDARIO del overhaul
--    ("TBO 2000 hrs o 6/12 años, lo que ocurra primero"). El API/panel
--    muestran días restantes y la alerta diaria avisa por horas O fecha.

alter table public.helice
  add column if not exists turm decimal(10,2) not null default 0
  check (turm >= 0);

alter table public.motor
  add column if not exists tbo_fecha date;

alter table public.helice
  add column if not exists tbo_fecha date;

comment on column public.helice.turm is
  'Tacómetro del avión en la última reparación mayor de la hélice (misma escala que los tacos de escala).';
comment on column public.motor.tbo_fecha is
  'Fecha límite calendario del overhaul (TBO por tiempo). NULL = solo por horas.';
comment on column public.helice.tbo_fecha is
  'Fecha límite calendario del overhaul (TBO por tiempo). NULL = solo por horas.';
