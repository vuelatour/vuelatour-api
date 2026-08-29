-- 29-ago-2026 · Corrección de datos (auditoría "guardado silencioso"):
-- dos gastos capturados con AÑO equivocado quedaban fuera de TODOS los
-- cortes (mes, balance, reparto, pre-cierre) — parecían "no guardados".
-- Valores verificados en prod el 29-ago:
--   e1ae1347… (PILOTO_EXTERNO $10,282.00 MXN, "pago Boas vuelo 25 Agosto
--   2026") está en 2025-08-28 → va a 2026-08-25 (la fecha real del vuelo).
--   1c4561f0… (TAXI $400.00 MXN Tuxtla-Aeropuerto) está en 2020-08-28 →
--   va a 2026-08-28.
-- Guarded por el valor actual: si alguien ya corrigió la fecha a mano, el
-- UPDATE no toca nada (0 filas). La nota deja rastro del ajuste.
--
-- NO APLICAR EN AUTOMÁTICO: revisar contra prod antes de correr.

update public.gasto
set fecha_gasto = '2026-08-25',
    notas = case
      when notas is null or btrim(notas) = ''
        then '[29-ago] año corregido (auditoría)'
      else notas || E'\n[29-ago] año corregido (auditoría)'
    end,
    updated_at = now()
where id = 'e1ae1347-12cd-4179-a655-43d32325e2b7'
  and fecha_gasto = date '2025-08-28';

update public.gasto
set fecha_gasto = '2026-08-28',
    notas = case
      when notas is null or btrim(notas) = ''
        then '[29-ago] año corregido (auditoría)'
      else notas || E'\n[29-ago] año corregido (auditoría)'
    end,
    updated_at = now()
where id = '1c4561f0-3378-4eab-9ac0-31cded5777e1'
  and fecha_gasto = date '2020-08-28';
