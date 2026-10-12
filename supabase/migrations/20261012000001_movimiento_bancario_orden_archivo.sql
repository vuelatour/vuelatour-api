-- 20261012000001 · movimiento_bancario.orden_archivo (API 0.0.69, invariante 55)
--
-- Pedido del cliente (12-oct-2026): «cuando se exporta el estado de cuenta
-- me lo acomoda diferente al estado de cuenta que subimos, y para comparar
-- necesitamos tenga el mismo orden». Cada línea importada guarda su POSICIÓN
-- dentro del archivo del banco (`orden_archivo`, 1 = la primera línea) y el
-- reporte Excel de conciliación la respeta cuando todas sus líneas salieron
-- del mismo archivo (`ordenarComoEstadoDeCuenta`).
--
-- ADITIVA: sin triggers, sin funciones, sin backfill. Las líneas ya
-- importadas se insertaron en lote (mismo `created_at`): su orden original
-- no se puede reconstruir, quedan en null y el reporte las sigue ordenando
-- por fecha. Las importaciones posteriores al deploy del API 0.0.69 ya
-- vienen con la posición (la sonda `ordenArchivoDisponible` se enciende
-- sola en ≤ 10 min al aplicarla, sin redeploy).
--
-- DRY-RUN (sin triggers no hay nada que ejercer en seco más que la columna):
--   begin;
--   alter table public.movimiento_bancario add column if not exists orden_archivo integer
--     check (orden_archivo is null or orden_archivo >= 1);
--   -- un UPDATE real que respete y uno que rompa el CHECK
--   update public.movimiento_bancario set orden_archivo = 1 where id = (select id from public.movimiento_bancario limit 1);
--   savepoint sp; do $$ begin
--     update public.movimiento_bancario set orden_archivo = 0 where id = (select id from public.movimiento_bancario limit 1);
--     raise exception 'DRYRUN_FALLA: el CHECK dejó pasar 0';
--   exception when check_violation then raise notice 'ok CHECK'; end $$; rollback to sp;
--   rollback;

alter table public.movimiento_bancario
  add column if not exists orden_archivo integer
    check (orden_archivo is null or orden_archivo >= 1);

comment on column public.movimiento_bancario.orden_archivo is
  'Posición de la línea dentro del estado de cuenta importado (1 = primera línea del archivo). Null = capturada a mano o importada antes del API 0.0.69. El reporte Excel de conciliación respeta este orden cuando todas sus líneas salieron del mismo archivo (12-oct-2026).';

create index if not exists idx_mov_bancario_estado_cuenta_orden
  on public.movimiento_bancario (estado_cuenta_id, orden_archivo);

-- Rollback (reiniciar el API después: la sonda memoriza el «sí»):
--   drop index if exists public.idx_mov_bancario_estado_cuenta_orden;
--   alter table public.movimiento_bancario drop column if exists orden_archivo;
