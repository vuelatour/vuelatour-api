-- SALIDA "para todas las matrículas" (aceites/consumibles de flota): el costo
-- FIFO se prorratea en partes iguales entre los aviones ACTIVOS — un gasto
-- REFACCION medio BODEGA por avión, ligados todos al mismo movimiento.
alter table inventario_movimiento add column if not exists para_flota boolean not null default false;
comment on column inventario_movimiento.para_flota is 'SALIDA repartida entre toda la flota activa (sin aeronave_id): el gasto se prorratea por avión.';
