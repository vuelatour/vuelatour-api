-- Tacómetros en vivo: origen explícito de cada lectura para las leyendas del
-- tablero ("la operación no se detiene": piloto > IA > deducción matemática).
-- PILOTO   = capturado por el piloto en la app (aunque la IA lo haya prellenado)
-- IA       = leído por IA de la foto al sincronizar (sin confirmación del piloto)
-- DEDUCIDO = calculado por el sistema (promedio del tramo / último tacómetro)
-- OFICINA  = ajustado manualmente por oficina al revisar
alter table public.escala
  add column if not exists taco_salida_origen varchar(10)
    check (taco_salida_origen in ('PILOTO','IA','DEDUCIDO','OFICINA')),
  add column if not exists taco_llegada_origen varchar(10)
    check (taco_llegada_origen in ('PILOTO','IA','DEDUCIDO','OFICINA'));

-- Backfill best-effort: lecturas existentes se asumen del piloto.
update public.escala set taco_salida_origen = 'PILOTO'
  where taco_salida is not null and taco_salida_origen is null;
update public.escala set taco_llegada_origen = 'PILOTO'
  where taco_llegada is not null and taco_llegada_origen is null;
