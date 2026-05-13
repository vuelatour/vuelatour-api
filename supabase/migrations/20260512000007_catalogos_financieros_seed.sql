-- Migration: 20260512000007_catalogos_financieros_seed
-- Datos iniciales: 7 cuentas bancarias del doc §2.5, 8 tarjetas corporativas del §2.6,
-- y un proveedor "GENERICO_LOCAL" catchall. Los 186 proveedores del Excel de Mary se
-- importarán vía FastAPI en una fase posterior. Clientes se crean al recibir vuelos.
-- Idempotente: bail-out si ya hay cuentas.

do $$
declare
  v_gastos uuid;
  v_combustible uuid;
  v_yg uuid;
  v_eje_scotia uuid;
  v_hsbc_pesos uuid;
  v_hsbc_usd uuid;
  v_scotia_usd uuid;
begin
  if exists (select 1 from public.cuenta_bancaria) then
    raise notice 'catalogos_financieros_seed: cuenta_bancaria ya poblada, skipping';
    return;
  end if;

  -- ============ CUENTAS BANCARIAS (§2.5) ============
  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('GASTOS GNRAL', 'Scotiabank', 'MXN', 'AEROCHARTER', 'Cuenta principal de operaciones')
  returning id into v_gastos;

  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('COMBUSTIBLE', 'Scotiabank', 'MXN', 'AEROCHARTER', 'Dedicada a combustible. A nombre de Aerocharter, tarjeta propia.')
  returning id into v_combustible;

  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('YG', 'Scotiabank', 'MXN', 'OTRA', 'A nombre de Yanina Giana (personal)')
  returning id into v_yg;

  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('EJE SCOTIA', 'Scotiabank', 'MXN', 'OTRA', 'Entidad EJE')
  returning id into v_eje_scotia;

  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('HSBC Pesos', 'HSBC', 'MXN', 'AEROCHARTER', 'Operaciones en pesos')
  returning id into v_hsbc_pesos;

  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('HSBC USD', 'HSBC', 'USD', 'AEROCHARTER', 'Operaciones en dolares')
  returning id into v_hsbc_usd;

  insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, notas)
  values ('SCOTIA USD', 'Scotiabank', 'USD', 'AEROCHARTER', 'Operaciones en dolares')
  returning id into v_scotia_usd;

  -- ============ TARJETAS CORPORATIVAS (§2.6) ============
  -- usuario_id se asignara cuando los titulares se logueen via Google y Diego los linkee.
  insert into public.tarjeta_corporativa (terminacion, nombre_titular, banco, cuenta_bancaria_id, notas)
  values
    ('6256', 'Pablo Canales',     'Scotiabank', null, 'Socio/Piloto/Compras'),
    ('2865', 'Alejandro Canales', 'Scotiabank', null, 'Director (Ale)'),
    ('8447', 'Yanina Giana',      'Scotiabank', v_yg, 'Administracion. Vinculada a cuenta YG.'),
    ('0577', 'Alexander Saab',    'Scotiabank', null, 'Piloto'),
    ('0593', 'Luis Caceres',      'Scotiabank', null, 'Piloto'),
    ('0585', 'Javier Malacara',   'Scotiabank', null, 'Piloto'),
    ('6163', 'Luis Cetz',         'Scotiabank', null, 'Mecanico'),
    ('6231', 'Oficina (Itzel y Mary)', 'Scotiabank', null, 'Compartida - administracion');

  -- ============ PROVEEDOR GENERICO ============
  insert into public.proveedor (nombre, tipo, notas)
  values ('Generico Local', 'GENERICO_LOCAL', 'Catchall para gastos sin proveedor identificado o gastos de campo (combustible avgas pequeno, comidas, etc.)');

  raise notice 'catalogos_financieros_seed: 7 cuentas + 8 tarjetas + 1 proveedor generico';
end $$;
