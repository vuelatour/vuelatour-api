-- Método de pago "OTRO" (manual) + cuenta destino de los cobros bancarios.
-- Pedido del equipo (18-ago-2026):
--  1) poder cotizar/cobrar con un método que no está en el catálogo,
--     escribiendo a mano cuál es;
--  2) en las transferencias, anotar A QUÉ CUENTA llegó el dinero.
-- OTRO queda FUERA de la whitelist del piloto (solo oficina), fuera del
-- auto-match de conciliación y SIN IVA por defecto (el override manual de
-- IVA del cotizador es la válvula cuando sí factura).

alter type public.metodo_cobro add value if not exists 'OTRO';

-- Nombre manual del método cuando metodo_cobro = OTRO (ej. "PayPal",
-- "Depósito en ventanilla"). Obligatorio a nivel API al cotizar con OTRO.
alter table public.vuelo
  add column if not exists metodo_cobro_detalle text;
comment on column public.vuelo.metodo_cobro_detalle is
  'Nombre manual del método de pago cuando metodo_cobro = OTRO (lo escribe la oficina en el cotizador).';

-- Cuenta a la que llegó un cobro bancario (transferencia/HSBC link/cheque):
-- texto libre — alias de cuenta_bancaria o lo que la oficina quiera anotar.
alter table public.cobro_vuelo
  add column if not exists cuenta_destino varchar(120);
comment on column public.cobro_vuelo.cuenta_destino is
  'A qué cuenta llegó el cobro (texto libre; típicamente el alias de cuenta_bancaria). Informativo para tesorería/conciliación.';
