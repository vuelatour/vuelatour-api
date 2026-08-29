-- Costo del operador externo CON MONEDA (29-ago-2026).
--
-- Lo capturable pasa a ser {monto, moneda} (+ TC cuando la moneda es MXN);
-- vuelo.costo_externo_usd queda DERIVADO por el server (fuente única
-- src/common/costo-externo.util.ts) y sigue siendo LA columna que leen los
-- lectores (reporte por vuelo, reparto, balance por avión) — no se tocan.
-- Regla del TC: USD ⇒ usd = monto; MXN ⇒ usd = monto / tc (tc del DTO, o el
-- tc_usd_mxn de la cotización de respaldo; sin TC la captura se rechaza con
-- 400 — jamás se suma crudo ni se persiste a medias).
--
-- NOTA: escala.monto_externo_usd (monto pactado por tramo del externo sin
-- referencia) quedó DEPRECADA en código (modo eliminado, 0 filas la usaban);
-- la columna NO se toca aquí a propósito.

alter table vuelo add column if not exists costo_externo_monto numeric null;
alter table vuelo add column if not exists costo_externo_moneda text null
  check (costo_externo_moneda in ('USD', 'MXN'));
alter table vuelo add column if not exists costo_externo_tc numeric null;

comment on column vuelo.costo_externo_monto is
  'Costo pactado con el operador externo en SU moneda (capturable). costo_externo_usd se DERIVA de aquí (costo-externo.util).';
comment on column vuelo.costo_externo_moneda is
  'Moneda del costo_externo_monto: USD | MXN.';
comment on column vuelo.costo_externo_tc is
  'TC MXN por USD con el que se derivó costo_externo_usd cuando la moneda es MXN (el capturado o el tc_usd_mxn de la cotización).';
comment on column vuelo.costo_externo_usd is
  'DERIVADO por el server desde costo_externo_monto/moneda/tc (fuente única de los lectores: reporte, reparto, balance). No capturar directo.';

-- Backfill: los costos existentes se capturaron en USD (monto = usd).
update vuelo
set costo_externo_monto = costo_externo_usd,
    costo_externo_moneda = 'USD'
where costo_externo_usd is not null
  and costo_externo_monto is null;
