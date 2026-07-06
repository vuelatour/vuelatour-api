-- Conciliación de INGRESOS: un ABONO del estado de cuenta se puede enlazar a
-- un cobro de vuelo (cobro_vuelo), igual que un CARGO se enlaza a un gasto.
-- Antes la mitad "ingreso" del flujo de dinero no se conciliaba nunca.
alter table public.movimiento_bancario
  add column cobro_id uuid references public.cobro_vuelo(id) on delete set null;

create index idx_mov_bancario_cobro on public.movimiento_bancario (cobro_id);

comment on column public.movimiento_bancario.cobro_id is
  'ABONO conciliado contra un cobro de vuelo. CARGO usa gasto_id.';
