-- Caja chica ACUMULADA (pedido del cliente, 6 ago 2026): para usuarios que
-- gastan de su bolsa (admins/pilotos sin fondo entregado), el número que
-- importa es CUÁNTO SE LES DEBE — sube con cada gasto en efectivo y se pone
-- en cero cuando administración les repone (movimiento REPOSICION). El API
-- invierte el cálculo del saldo cuando la bandera está activa.

alter table public.caja_chica_fondo
  add column if not exists es_acumulada boolean not null default false;

comment on column public.caja_chica_fondo.es_acumulada is
  'true = caja al revés: el saldo mostrado es lo POR REPONER (gastos efectivo − reposiciones), sube al gastar y vuelve a 0 al reponer. false = fondo clásico.';
