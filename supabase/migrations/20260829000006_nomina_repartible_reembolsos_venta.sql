-- 29-ago-2026 · Tres piezas (el enum NOMINA/SERVICIOS nació en 20260829000005;
-- Postgres no permite usar un valor de enum en la migración que lo crea):
--
-- (1) NOMINA es repartible entre aviones (como INDIRECTO). El trigger se
--     redefine con la lista COMPLETA vigente + NOMINA (create or replace
--     pisa todo; omitir una categoría la des-repartibilizaría en silencio).
--     Espejo TS: CATEGORIAS_REPARTIBLES en src/common/gasto-reparto.util.ts.
create or replace function public.tg_gasto_reparto_valida()
returns trigger language plpgsql as $function$
declare
  v_vuelo uuid;
  v_categoria text;
begin
  select vuelo_id, categoria::text into v_vuelo, v_categoria
  from public.gasto where id = new.gasto_id;
  if v_vuelo is not null then
    raise exception 'gasto_reparto: el gasto % está ligado a un vuelo — su avión se controla por el vuelo', new.gasto_id;
  end if;
  if v_categoria not in ('OTRO', 'FIJO', 'INDIRECTO', 'GASOLINA', 'VISITA', 'NOMINA') then
    raise exception 'gasto_reparto: la categoría % no es repartible (solo OTRO/FIJO/INDIRECTO/GASOLINA/VISITA/NOMINA)', v_categoria;
  end if;
  return new;
end $function$;

-- (2) Reembolsos al cliente: fila de cobro con MONTO NEGATIVO (el signo viaja
--     dentro de la columna que todos los lectores ya leen; cobrosEnUsd resta).
--     El cero sigue prohibido.
alter table public.cobro_vuelo drop constraint cobro_vuelo_monto_check;
alter table public.cobro_vuelo add constraint cobro_vuelo_monto_check check (monto <> 0);
-- Un reembolso jamás lleva comisión bancaria propia.
alter table public.cobro_vuelo add constraint cobro_vuelo_reembolso_sin_comision
  check (monto > 0 or comision_banco_monto is null);

-- (3) Venta de refacciones: VuelaTour compra (costo FIFO, intacto) y "vende"
--     al avión a precio de venta. El precio del ítem es el default; cada
--     SALIDA guarda la venta pactada. NUNCA reutilizar costo_unitario_*.
alter table public.inventario_item
  add column if not exists precio_venta numeric(14,4) check (precio_venta is null or precio_venta >= 0),
  add column if not exists precio_venta_moneda varchar(3) check (precio_venta_moneda is null or precio_venta_moneda in ('MXN','USD'));
comment on column public.inventario_item.precio_venta is
  'Precio de venta unitario al avión (default de la SALIDA). El inventario se valúa a costo FIFO; esto solo fija el cargo al avión.';
alter table public.inventario_movimiento
  add column if not exists venta_unitaria numeric(14,4) check (venta_unitaria is null or venta_unitaria >= 0),
  add column if not exists venta_moneda varchar(3) check (venta_moneda is null or venta_moneda in ('MXN','USD'));
comment on column public.inventario_movimiento.venta_unitaria is
  'SALIDA: precio de venta unitario cobrado al avión (gasto BODEGA a venta; ganancia = venta − costo FIFO). Null = se cargó a costo.';
