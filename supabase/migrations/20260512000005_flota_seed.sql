-- Migration: 20260512000005_flota_seed
-- Seeds the 7 active aircraft from the functional design v1.2 §2.7 along with
-- their motors, propellers, ownership shares and overhaul reserves. Also seeds
-- the corporate entity Aerocharter and the partner usuarios (without auth yet).
-- Idempotent: bails out if any aeronave already exists.

do $$
declare
  v_aerocharter uuid;
  v_hernan uuid;
  v_angel uuid;
  v_roque uuid;
  v_saab uuid;
  v_moreno uuid;
  v_macedo uuid;

  v_xb_pev uuid;
  v_xa_vgv uuid;
  v_xb_ijp uuid;
  v_n621tx uuid;
  v_n990gg uuid;
  v_n4142r uuid;
  v_xb_anu uuid;

  v_motor_xb_pev uuid;
  v_motor_xa_vgv uuid;
  v_motor_xb_ijp uuid;
  v_motor_n621tx uuid;
  v_motor_n990gg_l uuid;
  v_motor_n990gg_r uuid;
  v_motor_n4142r uuid;
  v_motor_xb_anu uuid;
begin
  if exists (select 1 from public.aeronave) then
    raise notice 'flota_seed: aeronave already populated, skipping';
    return;
  end if;

  -- Aerocharter (corporate entity holding shares)
  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Aero Charter Cancún S.A. de C.V.', 'aerocharter@vuelatour.local', 'ADMIN', 'ACTIVO', true)
  returning id into v_aerocharter;

  -- Pre-seeded partner usuarios. They will get supabase_auth_id when they first log in.
  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Hernán Garza', 'hernan.garza@vuelatour.local', 'SOCIO', 'INVITADO', false)
  returning id into v_hernan;

  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Ángel Álvarez', 'angel.alvarez@vuelatour.local', 'SOCIO', 'INVITADO', false)
  returning id into v_angel;

  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Mauricio Roque', 'mauricio.roque@vuelatour.local', 'SOCIO', 'INVITADO', false)
  returning id into v_roque;

  -- Saab is also a base pilot (rol PILOTO); his 2% share in N4142R is tracked via aeronave_socio.
  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Alexander Saab', 'alex.saab@vuelatour.local', 'PILOTO', 'INVITADO', false)
  returning id into v_saab;

  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Carlos Moreno', 'carlos.moreno@vuelatour.local', 'SOCIO', 'INVITADO', false)
  returning id into v_moreno;

  insert into public.usuario (nombre, email, rol, estado, es_empresa)
  values ('Macedo', 'macedo@vuelatour.local', 'SOCIO', 'INVITADO', false)
  returning id into v_macedo;

  -- ============ AERONAVES ============
  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('XB-PEV', 'Cessna 206', 'MX', 1, 120, 5, 750, 650, 55, '#3B82F6', 'CUN', true, '100% Aerocharter')
  returning id into v_xb_pev;

  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('XA-VGV', 'Cessna 206', 'MX', 1, 120, 5, 750, 650, 55, '#10B981', 'CUN', true, 'Temporal 100% Hernán hasta recuperar inversión. Régimen final 30/70 AC/Hernán.')
  returning id into v_xa_vgv;

  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('XB-IJP', 'Cessna 206', 'MX', 1, 120, 5, 750, 650, 55, '#F59E0B', 'CUN', true, 'Temporal 100% Hernán hasta recuperar inversión. Régimen final 30/70 AC/Hernán.')
  returning id into v_xb_ijp;

  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('N621TX', 'Kodiak 100', 'USA', 1, 150, 8, 1750, 1650, 400, '#8B5CF6', 'CUN', true, '20% AC + 80% Sociedad (Hernán 51.15%, Moreno 15.54%, Macedo 33.31% del 80%).')
  returning id into v_n621tx;

  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('N990GG', 'Seneca V', 'USA', 2, 150, 6, 1050, 950, 55, '#EF4444', 'CUN', true, '49/51 AC/Ángel. Bimotor — reserva overhaul $55/hr por motor (x2).')
  returning id into v_n990gg;

  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('N4142R', 'Por confirmar', 'USA', 1, 120, 5, null, null, null, '#EC4899', 'CUN', true, '29% AC, 69% Roque, 2% Saab. Modelo, velocidad y tarifas pendientes de confirmación.')
  returning id into v_n4142r;

  insert into public.aeronave (matricula, modelo, pais_registro, num_motores, velocidad_crucero_kts, asientos, tarifa_hora_pub_usd, tarifa_hora_broker_usd, reserva_overhaul_hr_usd, color_calendario, ubicacion_base, activa, notas)
  values ('XB-ANU', 'Por confirmar', 'MX', 1, 120, 5, null, null, null, '#0EA5E9', 'CUN', true, '30/70 AC/Roque. Modelo, velocidad y tarifas pendientes de confirmación.')
  returning id into v_xb_anu;

  -- ============ MOTORES (placeholder serials hasta que Pablo confirme) ============
  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_xb_pev, 'UNICO', 'PENDIENTE-XB-PEV-M1', 'PISTON', 'Continental', 'IO-520', 0, 0, 1700, 'Serial y horas pendientes de captura.')
  returning id into v_motor_xb_pev;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_xa_vgv, 'UNICO', 'PENDIENTE-XA-VGV-M1', 'PISTON', 'Continental', 'IO-520', 0, 0, 1700, 'Serial y horas pendientes de captura.')
  returning id into v_motor_xa_vgv;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_xb_ijp, 'UNICO', 'PENDIENTE-XB-IJP-M1', 'PISTON', 'Continental', 'IO-520', 0, 0, 1700, 'Serial y horas pendientes de captura.')
  returning id into v_motor_xb_ijp;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_n621tx, 'UNICO', 'PENDIENTE-N621TX-M1', 'TURBINA', 'Pratt & Whitney', 'PT6A-34', 0, 0, 4000, 'Serial y horas pendientes de captura. TBO típico PT6A 4000h.')
  returning id into v_motor_n621tx;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_n990gg, 'IZQUIERDO', 'PENDIENTE-N990GG-MI', 'PISTON', 'Continental', 'IO-360', 0, 0, 2000, 'Motor izquierdo. Serial y horas pendientes.')
  returning id into v_motor_n990gg_l;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_n990gg, 'DERECHO', 'PENDIENTE-N990GG-MD', 'PISTON', 'Continental', 'IO-360', 0, 0, 2000, 'Motor derecho. Serial y horas pendientes.')
  returning id into v_motor_n990gg_r;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_n4142r, 'UNICO', 'PENDIENTE-N4142R-M1', 'PISTON', null, null, 0, 0, 1700, 'Datos pendientes de confirmación.')
  returning id into v_motor_n4142r;

  insert into public.motor (aeronave_id, posicion, numero_serie, tipo, fabricante, modelo, horas_totales, turm, tbo_horas, notas)
  values (v_xb_anu, 'UNICO', 'PENDIENTE-XB-ANU-M1', 'PISTON', null, null, 0, 0, 1700, 'Datos pendientes de confirmación.')
  returning id into v_motor_xb_anu;

  -- ============ HELICES ============
  insert into public.helice (aeronave_id, posicion, numero_serie, horas_totales, notas)
  values
    (v_xb_pev, 'UNICA', 'PENDIENTE-XB-PEV-P1', 0, 'Serial pendiente'),
    (v_xa_vgv, 'UNICA', 'PENDIENTE-XA-VGV-P1', 0, 'Serial pendiente'),
    (v_xb_ijp, 'UNICA', 'PENDIENTE-XB-IJP-P1', 0, 'Serial pendiente'),
    (v_n621tx, 'UNICA', 'PENDIENTE-N621TX-P1', 0, 'Serial pendiente'),
    (v_n990gg, 'IZQUIERDA', 'PENDIENTE-N990GG-PI', 0, 'Hélice izquierda — serial pendiente'),
    (v_n990gg, 'DERECHA', 'PENDIENTE-N990GG-PD', 0, 'Hélice derecha — serial pendiente'),
    (v_n4142r, 'UNICA', 'PENDIENTE-N4142R-P1', 0, 'Serial pendiente'),
    (v_xb_anu, 'UNICA', 'PENDIENTE-XB-ANU-P1', 0, 'Serial pendiente');

  -- ============ AERONAVE_SOCIO ============
  -- VGV e IJP están en régimen temporal 100% Hernán. Al recuperar inversión, se cerrarán
  -- estos registros y se abrirán nuevos con 30/70 AC/Hernán.
  insert into public.aeronave_socio (aeronave_id, socio_id, porcentaje, vigente_desde, notas)
  values
    (v_xb_pev, v_aerocharter, 100.000, '2020-01-01', null),

    (v_xa_vgv, v_hernan, 100.000, '2020-01-01', 'Régimen temporal — pasa a 30/70 AC/Hernán cuando se recupere la inversión'),
    (v_xb_ijp, v_hernan, 100.000, '2020-01-01', 'Régimen temporal — pasa a 30/70 AC/Hernán cuando se recupere la inversión'),

    (v_n621tx, v_aerocharter, 20.000, '2020-01-01', null),
    (v_n621tx, v_hernan,      40.920, '2020-01-01', 'Hernán 51.15% del bloque Sociedad 80%'),
    (v_n621tx, v_moreno,      12.432, '2020-01-01', 'Moreno 15.54% del bloque Sociedad 80%'),
    (v_n621tx, v_macedo,      26.648, '2020-01-01', 'Macedo 33.31% del bloque Sociedad 80%'),

    (v_n990gg, v_aerocharter, 49.000, '2020-01-01', null),
    (v_n990gg, v_angel,       51.000, '2020-01-01', null),

    (v_n4142r, v_aerocharter, 29.000, '2020-01-01', null),
    (v_n4142r, v_roque,       69.000, '2020-01-01', null),
    (v_n4142r, v_saab,         2.000, '2020-01-01', null),

    (v_xb_anu, v_aerocharter, 30.000, '2020-01-01', null),
    (v_xb_anu, v_roque,       70.000, '2020-01-01', null);

  -- ============ RESERVA OVERHAUL (por motor) ============
  insert into public.reserva_overhaul (aeronave_id, motor_id, monto_por_hora_usd, notas)
  values
    (v_xb_pev,  v_motor_xb_pev,    55,  'Cessna 206 pistón'),
    (v_xa_vgv,  v_motor_xa_vgv,    55,  'Cessna 206 pistón'),
    (v_xb_ijp,  v_motor_xb_ijp,    55,  'Cessna 206 pistón'),
    (v_n621tx,  v_motor_n621tx,   400,  'Kodiak 100 turbina PT6A'),
    (v_n990gg,  v_motor_n990gg_l,  55,  'Seneca V — motor izquierdo'),
    (v_n990gg,  v_motor_n990gg_r,  55,  'Seneca V — motor derecho'),
    (v_n4142r,  v_motor_n4142r,    55,  'Tarifa placeholder hasta confirmar'),
    (v_xb_anu,  v_motor_xb_anu,    55,  'Tarifa placeholder hasta confirmar');

  raise notice 'flota_seed: complete (7 aircraft, 8 engines, 8 propellers, 14 ownership rows, 8 overhaul reserves)';
end $$;
