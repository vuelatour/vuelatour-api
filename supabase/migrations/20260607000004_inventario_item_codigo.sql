-- Código / SKU / código de barras interno del ítem de inventario.
-- Es distinto de `numero_parte` (P/N del fabricante): este es el código
-- propio de bodega o de barras, para identificar/escanear el insumo.

alter table public.inventario_item
  add column if not exists codigo varchar(60);

comment on column public.inventario_item.codigo is
  'SKU / código de barras interno (distinto de numero_parte = P/N del fabricante).';

create index if not exists idx_inventario_item_codigo
  on public.inventario_item (codigo) where codigo is not null;
