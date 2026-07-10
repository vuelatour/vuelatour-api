-- Comisión del vendedor (Itzy/Pablo/broker): sale del precio de venta, NO se
-- suma al cliente. El cliente paga monto_total_usd completo (cobros/factura
-- cuadran contra eso); el neto VuelaTour = total − comisión es lo que fluye
-- al reparto de utilidades y reportes.
alter table vuelo add column if not exists comision_vendedor_usd decimal(12,2) not null default 0;
alter table vuelo add column if not exists comision_vendedor_nombre varchar(120);
comment on column vuelo.comision_vendedor_usd is 'Comisión de quien vendió (USD): se descuenta del ingreso en reparto/reportes, no del total que paga el cliente.';
comment on column vuelo.comision_vendedor_nombre is 'Quién vendió y cobra la comisión (texto libre: Itzy, Pablo, broker...).';
