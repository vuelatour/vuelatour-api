-- 28-ago-2026 · Correcciones de datos confirmadas por el cliente.
--
-- 1) Aceites 15w 50 (ítem d99df930…): la ENTRADA inicial de 30 cajas se
--    capturó como 1,658.33 USD/caja y el cliente confirmó que ese valor es en
--    PESOS. Se corrige la capa FIFO (moneda MXN + costo en pesos + TC de
--    referencia 17.51 = promedio del TC de venta de julio 2026, mes de la
--    compra) y los 3 gastos REFACCION/BODEGA que nacieron de sus salidas
--    (N4142R 4 cajas, XB-PEV 2, N990GG 24) pasan a MXN con el MISMO número:
--    39,799.92 "USD" → 39,799.92 MXN, etc. Todos los UPDATE van guardados por
--    el valor viejo: si ya se corrigió, no tocan nada.
update inventario_movimiento
   set moneda = 'MXN',
       costo_unitario_mxn = 1658.33,
       tc_usd_mxn = 17.51,
       costo_unitario_usd = round(1658.33 / 17.51, 4),
       notas = coalesce(notas, '') ||
               ' · Corrección 28-ago-2026: el costo era en PESOS (se había capturado como USD); TC de referencia 17.51',
       updated_at = now()
 where id = 'e3f20592-3282-4506-b154-8590ea8eeb84'
   and tipo = 'ENTRADA' and moneda = 'USD' and costo_unitario_usd = 1658.33;

update inventario_movimiento
   set costo_unitario_usd = round(1658.33 / 17.51, 4),
       costo_unitario_mxn = 1658.33,
       tc_usd_mxn = 17.51,
       updated_at = now()
 where id in ('d45dae06-7478-4f33-a412-00ae6a57e588',
              'a9378a18-54e1-4259-b65a-35de6dd533c0',
              '533fce35-6088-432b-b41f-a242aa471b42')
   and tipo = 'SALIDA' and costo_unitario_usd = 1658.33;

update gasto
   set moneda = 'MXN',
       tc_gasto = 17.51,
       notas = coalesce(notas, '') ||
               ' · Corrección 28-ago-2026: costo en PESOS (se había registrado como USD)',
       updated_at = now()
 where id in ('1e0e8aa7-82b3-4d06-90da-471048aab62f',   -- N4142R 4 × = 6,633.32
              'bb355265-1b7c-4a00-8a18-72bcbdbf17a1',   -- XB-PEV 2 × = 3,316.66
              '92fbc961-5e4c-4df7-be44-3ca67f37cae8')   -- N990GG 24 × = 39,799.92
   and moneda = 'USD' and medio_pago = 'BODEGA'
   and monto in (6633.32, 3316.66, 39799.92);

-- 2) Cuenta destino del cobro: pasa de texto libre a la lista de 5 cuentas
--    que definió el cliente (Paywise, HSBC Dólares, HSBC Pesos, Scotiabank
--    Dólares, Scotiabank Pesos). Los valores legados se normalizan por banco
--    + moneda del cobro (todos los existentes son consistentes).
update cobro_vuelo set cuenta_destino = 'HSBC Dólares', updated_at = now()
 where lower(cuenta_destino) in ('hsbc') and moneda = 'USD';
update cobro_vuelo set cuenta_destino = 'HSBC Pesos', updated_at = now()
 where lower(cuenta_destino) in ('hsbc') and moneda = 'MXN';
update cobro_vuelo set cuenta_destino = 'Scotiabank Dólares', updated_at = now()
 where lower(cuenta_destino) in ('scotia', 'scotiabank') and moneda = 'USD';
update cobro_vuelo set cuenta_destino = 'Scotiabank Pesos', updated_at = now()
 where lower(cuenta_destino) in ('scotia', 'scotiabank') and moneda = 'MXN';
update cobro_vuelo set cuenta_destino = 'Paywise', updated_at = now()
 where lower(cuenta_destino) = 'paywise' and cuenta_destino <> 'Paywise';

comment on column public.cobro_vuelo.cuenta_destino is
  'Cuenta que recibió el cobro (lista fija del cliente, 28-ago-2026): Paywise · HSBC Dólares · HSBC Pesos · Scotiabank Dólares · Scotiabank Pesos. Solo métodos bancarios.';
