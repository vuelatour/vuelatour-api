-- Puente inventario → gastos (diseño funcional 5.6): la SALIDA de bodega genera
-- automáticamente un gasto categoría REFACCION cargado al avión, con el costo
-- FIFO. Así el costo de las piezas llega al reporte mensual por avión y al
-- reparto de utilidades sin captura manual.

-- Medio de pago propio para estos cargos: el dinero salió del banco cuando se
-- COMPRÓ la pieza (entrada), no cuando se consume. Con 'BODEGA' el cargo no se
-- confunde con un egreso bancario ni entra al cruce de conciliación.
alter type public.medio_pago add value if not exists 'BODEGA';

-- Liga 1 a 1 con el movimiento de cardex que lo originó (auditoría y reversa
-- en devoluciones).
alter table public.gasto
  add column if not exists inventario_movimiento_id uuid
    references public.inventario_movimiento(id) on delete set null;

create unique index if not exists uq_gasto_inventario_movimiento
  on public.gasto (inventario_movimiento_id)
  where inventario_movimiento_id is not null;

comment on column public.gasto.inventario_movimiento_id is
  'Movimiento de bodega (SALIDA) que originó este gasto automático de refacción.';
