-- Monto NOMINAL del fondo de caja chica ("la caja de Luis es de $6,000").
-- Pedido de oficina 14-ago: ver el fondo total de cada quien y su última
-- reposición. Con el monto fijado, el panel muestra además "por reponer" =
-- monto_fondo − saldo (el número del cheque de reposición). Opcional:
-- null = sin fijar (cajas acumuladas normalmente no lo usan — ahí el saldo
-- YA es lo por reponer).

alter table public.caja_chica_fondo
  add column if not exists monto_fondo numeric(12,2)
    check (monto_fondo is null or monto_fondo > 0);

comment on column public.caja_chica_fondo.monto_fondo is
  'Monto nominal del fondo (a cuánto se repone). Null = sin fijar. Habilita "por reponer" = monto_fondo - saldo en el panel.';
