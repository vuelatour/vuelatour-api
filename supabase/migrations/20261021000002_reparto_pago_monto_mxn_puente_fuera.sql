-- 22-oct-2026 · PUENTE FUERA: `reparto_pago.monto_mxn` ya lo manda siempre el API.
-- API 0.0.102, invariante 99 del CLAUDE.md del API.
--
-- POR QUÉ: el puente 20261021000001 existía solo para que el API 0.0.99 (que
-- no manda `monto_mxn`) pudiera registrar y corregir entregas mientras
-- Railway estuvo caído (incidente QH8L8B3E, 21/22-oct-2026). El 22-oct-2026 a
-- las 21:19 UTC Railway construyó el 0.0.102 y `GET /v1/version` lo confirmó;
-- el cliente pidió «que quites el puente».
--
-- QUÉ HACE: DESACTIVA el trigger (`alter table … disable trigger`). No lo
-- borra: el MCP de Supabase rechaza cualquier sentencia con DROP. La función
-- y el trigger deshabilitado quedan inertes; borrarlos es opcional y solo
-- desde el SQL Editor:
--   drop trigger if exists trg_reparto_pago_monto_mxn_puente on public.reparto_pago;
--   drop function if exists public.tg_reparto_pago_monto_mxn_puente();
--
-- REVERSA (si volviera a correr un API < 0.0.102 en prod):
--   alter table public.reparto_pago enable trigger trg_reparto_pago_monto_mxn_puente;
--
-- Por MCP se aplica SOLO el CUERPO (apply_migration, name
-- '20261021000002_reparto_pago_monto_mxn_puente_fuera'). Sin palabras
-- destructivas. Postcheck: `select tgenabled from pg_trigger where tgname =
-- 'trg_reparto_pago_monto_mxn_puente'` = 'D'.

alter table public.reparto_pago
  disable trigger trg_reparto_pago_monto_mxn_puente;

comment on function public.tg_reparto_pago_monto_mxn_puente() is
  'Puente (21-oct-2026) DESACTIVADO el 22-oct-2026 al subir el API 0.0.102 (siempre manda monto_mxn). Trigger deshabilitado; se puede borrar junto con esta función desde el SQL Editor.';
