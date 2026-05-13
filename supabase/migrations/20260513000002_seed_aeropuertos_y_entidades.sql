-- Migration: 20260513000002_seed_aeropuertos_y_entidades
-- Aeropuertos mexicanos referenciados en el doc (CUN, CZM, HOL, MID, TUL, CTM)
-- con reglas TUAS especificas. Y las 2 entidades fiscales emisoras del §2.4.
-- RFCs y datos fiscales completos pendientes; los actualizara Mary cuando los confirme.
-- Idempotente: bail-out si ya hay aeropuertos.

do $$
begin
  if exists (select 1 from public.aeropuerto) then
    raise notice 'seed_aeropuertos: aeropuerto ya poblada, skipping';
    return;
  end if;

  -- ============ AEROPUERTOS ============
  -- CUN: Itzel confirmo: solo XA paga, XB y N exentas. Pase de abordar exenta.
  insert into public.aeropuerto (iata, icao, nombre, ciudad, pais, tuas_default_usd_pax, tuas_aplica_xa, tuas_aplica_xb, tuas_aplica_n, tuas_pase_abordar_exenta, notas)
  values ('CUN', 'MMUN', 'Aeropuerto Internacional de Cancun', 'Cancun', 'MX', 25.00, true, false, false, true, 'Base de operaciones. XB y N exentas de TUAS aqui.');

  -- CZM: TODOS pagan TUAS, pase de abordar NO exenta.
  insert into public.aeropuerto (iata, icao, nombre, ciudad, pais, tuas_default_usd_pax, tuas_aplica_xa, tuas_aplica_xb, tuas_aplica_n, tuas_pase_abordar_exenta, notas)
  values ('CZM', 'MMCZ', 'Aeropuerto Internacional de Cozumel', 'Cozumel', 'MX', 25.00, true, true, true, false, 'TUAS SIEMPRE cobra sin importar matricula. Pase de abordar NO invalida TUAS aqui.');

  -- HOL: Holbox (alias usado por Itzel). El IATA real podria ser HOX, pero el doc usa HOL.
  insert into public.aeropuerto (iata, nombre, ciudad, pais, tuas_default_usd_pax, notas)
  values ('HOL', 'Aeropuerto de Holbox', 'Isla Holbox', 'MX', 25.00, 'Codigo IATA usado por Itzel (puede no ser oficial - confirmar).');

  insert into public.aeropuerto (iata, icao, nombre, ciudad, pais, tuas_default_usd_pax)
  values ('MID', 'MMMD', 'Aeropuerto Internacional de Merida', 'Merida', 'MX', 25.00);

  insert into public.aeropuerto (iata, icao, nombre, ciudad, pais, tuas_default_usd_pax, notas)
  values ('TUL', 'MMTU', 'Aeropuerto Internacional Felipe Carrillo Puerto', 'Tulum', 'MX', 25.00, 'Aeropuerto nuevo de Tulum (TQO/TUM tambien aparecen como aliases).');

  insert into public.aeropuerto (iata, icao, nombre, ciudad, pais, tuas_default_usd_pax)
  values ('CTM', 'MMCM', 'Aeropuerto Internacional de Chetumal', 'Chetumal', 'MX', 25.00);

  -- ============ ENTIDADES FISCALES EMISORAS ============
  insert into public.entidad_fiscal_emisora (codigo, razon_social, rfc, regimen_fiscal_sat, pac_proveedor, notas)
  values ('AEROCHARTER', 'Aero Charter Cancun S.A. de C.V.', null, '601', 'SIIGO_NUBE', 'Principal - operativa. RFC, CP, direccion y datos del PAC pendientes de actualizar por Mary.');

  insert into public.entidad_fiscal_emisora (codigo, razon_social, rfc, regimen_fiscal_sat, pac_proveedor, notas)
  values ('AERODINAMICA', 'Aerodinamica de Monterrey', null, '601', 'SIIGO_NUBE', 'Secundaria - uso limitado. RFC, CP, direccion pendientes.');

  raise notice 'seed_aeropuertos_y_entidades: 6 aeropuertos + 2 entidades fiscales';
end $$;
