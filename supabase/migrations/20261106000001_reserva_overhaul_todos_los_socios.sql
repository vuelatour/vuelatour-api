-- 6-nov-2026 · LA RESERVA DE OVERHAUL SE DESCUENTA A TODOS LOS SOCIOS.
-- API 0.0.125, invariante 121 del CLAUDE.md del API (supersede la opción por
-- socio de la invariante 99 / migración 20261020000005).
--
-- PEDIDO DEL CLIENTE (6-nov-2026): «lo de overhaul ya se les va a apartar en
-- las utilidades a los socios, a todos los socios; antes estaba para poder
-- elegir si se les reservaba de las utilidades o solo se les informaba, pero
-- ya decidieron que a todos se les va a reservar».
--
-- QUÉ HACE: deja `aeronave_socio.descontar_reserva_overhaul` en true en TODAS
-- las filas y con default true. El API 0.0.125 ya no lee la bandera para
-- decidir (`descuentaReservaSocio` descuenta a todos): la migración solo deja
-- la base diciendo la verdad para quien la consulte (GET owners, SQL).
--
-- DEPENDENCIA: ninguna dura (el API 0.0.125 descuenta a todos con o sin ella;
-- el 0.0.124 leería true y también descontaría a todos: coherente).
--
-- ROLLBACK (solo si el cliente vuelve a querer la opción): poner
-- `DESCONTAR_RESERVA_A_TODOS = false` en el API y, si se quiere volver al
-- default anterior: alter table public.aeronave_socio alter column
-- descontar_reserva_overhaul set default false; (y regresar a false las filas
-- que correspondan). Sin palabras destructivas: por MCP se aplica el CUERPO.
--
-- PLAN B (si el MCP responde {"status":"declined"}): SQL Editor, en UNA
-- corrida: begin; <CUERPO>; insert into supabase_migrations.schema_migrations
--   (version, name, statements) values ('20261106000001',
--   'reserva_overhaul_todos_los_socios', array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261106000001_reserva_overhaul_todos_los_socios.sql'])
--   on conflict (version) do nothing; commit;
-- ---------------------------------------------------------------------------

-- >>> CUERPO
alter table public.aeronave_socio
  alter column descontar_reserva_overhaul set default true;

update public.aeronave_socio
   set descontar_reserva_overhaul = true
 where descontar_reserva_overhaul is distinct from true;

comment on column public.aeronave_socio.descontar_reserva_overhaul is
  'Reserva de overhaul del socio: desde el 6-nov-2026 (API 0.0.125, invariante 121) se descuenta a TODOS los socios; la columna queda en true y el API no la lee para decidir (invariante 99 superada).';
-- <<< CUERPO

-- POSTCHECK (MCP execute_sql):
-- select descontar_reserva_overhaul, count(*) from public.aeronave_socio group by 1;
--   ⇒ una sola fila: true, N.
-- select column_default from information_schema.columns
--  where table_schema = 'public' and table_name = 'aeronave_socio'
--    and column_name = 'descontar_reserva_overhaul';   ⇒ true
