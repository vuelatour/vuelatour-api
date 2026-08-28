-- 28-ago-2026 · Seguimiento de 20260828000005: las 3 SALIDAs del aceite 15w 50
-- quedaron con costo en pesos (costo_unitario_mxn 1,658.33 · TC 17.51) pero
-- moneda = 'USD'. El cardex solo muestra costo_unitario_mxn con moneda 'MXN';
-- con 'USD' pintaba usd × tc = 94.71 × 17.51 = 1,658.37 (el USD vive en
-- numeric(12,2)), distinto de la ENTRADA (1,658.33) y de los gastos de bodega.
-- Convención del API: salida consumida 100 % de capas en pesos ⇒ moneda 'MXN'.
-- Guardado por el valor viejo: si ya se corrigió, no toca nada.
update inventario_movimiento
   set moneda = 'MXN', updated_at = now()
 where id in ('d45dae06-7478-4f33-a412-00ae6a57e588',
              'a9378a18-54e1-4259-b65a-35de6dd533c0',
              '533fce35-6088-432b-b41f-a242aa471b42')
   and tipo = 'SALIDA' and moneda = 'USD'
   and costo_unitario_mxn = 1658.33 and tc_usd_mxn = 17.51;
