-- Unidad de medida/presentación del ítem de inventario (pedido del cliente):
-- describe en qué se cuenta el stock — pieza, caja, bote, galón, litro, bolsa…
alter table inventario_item add column if not exists unidad varchar(30);
comment on column inventario_item.unidad is 'Presentación/unidad en la que se cuenta el stock (pieza, caja, bote, galón, litro, bolsa...). Texto libre.';
