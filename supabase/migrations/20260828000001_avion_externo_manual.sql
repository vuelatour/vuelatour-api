-- Venta broker de jet AJENO (28-ago, caso Hawker 400A CUN→Houston):
-- 1) El avión externo ahora tiene nombre propio en el vuelo (modelo y
--    matrícula) — antes se embutían en operador_externo y el PDF del
--    cliente no podía mostrar "HAWKER 400 A".
-- 2) Precio MANUAL por tramo: monto pactado del tramo cuando la cotización
--    es de un externo SIN avión de referencia (el motor suma estos montos
--    en lugar de tarifa × horas).
alter table vuelo add column if not exists avion_externo_modelo text null;
alter table vuelo add column if not exists avion_externo_matricula text null;
alter table escala add column if not exists monto_externo_usd numeric null;

comment on column vuelo.avion_externo_modelo is
  'Modelo del avión externo (ej. HAWKER 400 A). Solo vuelos es_externo; sale en el PDF del cliente.';
comment on column vuelo.avion_externo_matricula is
  'Matrícula del avión externo (ej. XA-REG). Solo vuelos es_externo.';
comment on column escala.monto_externo_usd is
  'Monto pactado del tramo (USD) en cotizaciones de avión externo sin referencia: el subtotal es la suma de estos montos.';
