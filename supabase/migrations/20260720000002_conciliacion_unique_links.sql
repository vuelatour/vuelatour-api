-- Unicidad de los enlaces de conciliación: un cobro (o un gasto) solo puede
-- cuadrar UNA línea del estado de cuenta. Los checks en linkCobro/link corren
-- antes del UPDATE y dos vínculos simultáneos podían pasar ambos (TOCTOU),
-- duplicando el mismo cobro/gasto en dos movimientos y sobreestimando la
-- conciliación. Índices parciales: los NULL (movimientos sin vincular) no
-- chocan entre sí. Verificado en prod: hoy no existen duplicados.

create unique index if not exists uq_mov_bancario_cobro
  on public.movimiento_bancario (cobro_id)
  where cobro_id is not null;

create unique index if not exists uq_mov_bancario_gasto
  on public.movimiento_bancario (gasto_id)
  where gasto_id is not null;
