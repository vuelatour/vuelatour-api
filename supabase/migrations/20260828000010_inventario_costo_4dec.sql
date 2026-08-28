-- 28-ago-2026 · El costo unitario del cardex pasa a 4 decimales: las ENTRADAS
-- de una COMPRA llevan factura + cargos prorrateados (round4) y el FIFO de las
-- SALIDAs ya calculaba a 4. Con numeric(12,2) Postgres redondeaba al insertar,
-- Σ cantidad × costo del cardex ≠ total de la compra (500 remaches a 0.0733 →
-- 0.07) y el aviso "recalcular" se quedaba pegado por el redondeo. Ampliación
-- sin pérdida: los valores existentes se conservan; los checks (>= 0) siguen.
alter table public.inventario_movimiento
  alter column costo_unitario_usd type numeric(14,4),
  alter column costo_unitario_mxn type numeric(14,4);
comment on column public.inventario_movimiento.costo_unitario_usd is
  'Costo unitario en USD a 4 decimales (prorrateo de compras / FIFO interno). En SALIDA es el costo FIFO ponderado que calcula el API.';
comment on column public.inventario_movimiento.costo_unitario_mxn is
  'Costo unitario en pesos a 4 decimales (compra en MXN, o USD × TC). Es lo que ve el cliente en el cardex.';
