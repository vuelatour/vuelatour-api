-- Compras de inventario en MXN (regla del cliente: manejan pesos; USD queda
-- para compras tipo Aircraft Spruce). La moneda CANÓNICA interna sigue siendo
-- USD (costo_unitario_usd alimenta FIFO, valorizado y el gasto de bodega que
-- entra al reparto); cuando la captura es MXN se guarda el precio original y
-- el tipo de cambio de la compra, y el API convierte al registrar.
alter table inventario_movimiento
  add column if not exists moneda varchar(3) not null default 'USD';
alter table inventario_movimiento
  add column if not exists costo_unitario_mxn numeric(12,2) check (costo_unitario_mxn is null or costo_unitario_mxn >= 0);
alter table inventario_movimiento
  add column if not exists tc_usd_mxn numeric(10,4) check (tc_usd_mxn is null or tc_usd_mxn > 0);
alter table inventario_movimiento drop constraint if exists inventario_movimiento_moneda_chk;
alter table inventario_movimiento add constraint inventario_movimiento_moneda_chk
  check (moneda in ('MXN', 'USD'));
comment on column inventario_movimiento.moneda is 'Moneda en la que se CAPTURÓ el costo. La contabilidad interna (FIFO/valorizado/gasto bodega) sigue en USD vía costo_unitario_usd.';
comment on column inventario_movimiento.costo_unitario_mxn is 'Precio unitario original en pesos (solo capturas MXN).';
comment on column inventario_movimiento.tc_usd_mxn is 'Tipo de cambio de la compra (MXN por USD) usado para convertir a costo_unitario_usd.';
