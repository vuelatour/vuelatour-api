-- Migration: 20260513000004_rutas_predefinidas_seed
-- Rutas simples CUN-X confirmadas o aproximadas. Pablo / Itzel deben validar las
-- millas nauticas reales (idealmente vs ForeFlight) y patchear las que sean aproximadas.
-- Idempotente: bail-out si ya hay rutas.

do $$
begin
  if exists (select 1 from public.ruta_predefinida) then
    raise notice 'rutas_predefinidas_seed: ya poblada, skipping';
    return;
  end if;

  insert into public.ruta_predefinida (origen_iata, destino_iata, millas_nauticas, es_redondo_auto, num_aterrizajes, fuente, notas)
  values
    -- Confirmado en doc §8: CUN-CZM 63.14 NM
    ('CUN', 'CZM', 63.14, true, 2, 'GOOGLE_EARTH', 'Confirmado por Itzel en doc funcional v1.2.'),
    -- Aproximaciones - PENDIENTE confirmar con ForeFlight (Pablo)
    ('CUN', 'HOL',  35.00, true, 2, 'APROXIMACION', 'PENDIENTE confirmar con ForeFlight. Holbox.'),
    ('CUN', 'MID', 145.00, true, 2, 'APROXIMACION', 'PENDIENTE confirmar con ForeFlight. Merida.'),
    ('CUN', 'TUL',  55.00, true, 2, 'APROXIMACION', 'PENDIENTE confirmar con ForeFlight. Tulum.'),
    ('CUN', 'CTM', 145.00, true, 2, 'APROXIMACION', 'PENDIENTE confirmar con ForeFlight. Chetumal.');

  raise notice 'rutas_predefinidas_seed: 5 rutas sembradas (1 confirmada, 4 aproximadas pendientes de validar)';
end $$;
