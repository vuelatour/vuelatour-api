-- Migration: 20260720000001_aeronave_permiso_afac
-- Provisión "PERMISO AFAC" del balance por avión: aportación en USD por HORA
-- COBRADA por operar con matrícula extranjera (ej. N990GG = 100 USD/hr).
-- NULL = no aplica (matrícula MX o sin provisión). La usa el reporte
-- "Balance por avión" (columna X del Excel del equipo): X = tarifa × TC × hrs.

alter table public.aeronave
  add column if not exists permiso_afac_usd_hr numeric(10,2);

comment on column public.aeronave.permiso_afac_usd_hr is
  'Aportación AFAC (USD por hora cobrada) por volar con matrícula extranjera. NULL = no aplica. Solo la consume el reporte Balance por avión.';
