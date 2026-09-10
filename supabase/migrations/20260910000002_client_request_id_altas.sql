-- 10-sep-2026 · Lote 2 Ola B (B2/B5) — idempotencia de las ALTAS que la app
-- encolará sin red. Mismo patrón que gasto/cobro_vuelo/mantenimiento
-- (20260829000002), vuelo/cotizacion_version_history (20260908000001) y
-- piloto_descanso/evento_flota (20260909000003): la app manda una llave única
-- por captura; un reintento del outbox (timeout tras commit, doble flush,
-- reconexión) colisiona en el índice parcial y el API devuelve la fila YA
-- creada (200, idempotente:true) en vez de duplicar — sin re-notificar.
--
-- ORDEN: puede aplicarse ANTES o DESPUÉS del deploy del API. El código
-- tolera la columna ausente con `columna-opcional.util` (sonda 1 vez: sin
-- columna no hay pre-check ni columna en el insert → altas sin idempotencia,
-- como hoy; se activa sola en ≤ 10 min tras aplicar).
--
-- Cada bloque lo mantiene el módulo dueño (escala = flights; inventario y
-- discrepancia = inventory/aircraft). Todo es `if not exists`: reaplicable.

-- BLOQUE: inventario
-- Una SALIDA de cardex genera el gasto REFACCION medio BODEGA (invariante 8):
-- un reintento sin llave duplicaba stock Y dinero del avión. El replay
-- devuelve el movimiento existente y su gasto ligado por
-- gasto.inventario_movimiento_id.
alter table public.inventario_movimiento
  add column if not exists client_request_id uuid;
create unique index if not exists uq_inv_movimiento_client_request
  on public.inventario_movimiento (client_request_id)
  where client_request_id is not null;
comment on column public.inventario_movimiento.client_request_id is
  'Llave de idempotencia generada por la app/panel por captura; única. Reintento con la misma llave = mismo movimiento (200, idempotente:true, con su gasto BODEGA ya generado; sin volver a mover stock).';

-- BLOQUE: discrepancia
-- Un squawk ALTA duplicado bloqueaba asignaciones dos veces y ensuciaba el
-- semáforo del avión. El replay devuelve el reporte existente sin avisar de
-- nuevo.
alter table public.aeronave_discrepancia
  add column if not exists client_request_id uuid;
create unique index if not exists uq_discrepancia_client_request
  on public.aeronave_discrepancia (client_request_id)
  where client_request_id is not null;
comment on column public.aeronave_discrepancia.client_request_id is
  'Llave de idempotencia generada por la app/panel por captura; única. Reintento con la misma llave = mismo reporte (200, idempotente:true, sin re-avisar).';

-- BLOQUE: vuelo_eliminado (B5, deltas al reconectar)
-- GET /calendar?updated_since= y GET /flights?updated_since= devuelven
-- `eliminados` = vuelo_id de vuelo_eliminado.eliminado_at >= since, para que
-- la app retire de su copia los vuelos que otro usuario borró.
create index if not exists idx_vuelo_eliminado_eliminado_at
  on public.vuelo_eliminado (eliminado_at desc);

-- BLOQUE: escala (B2, flights)
-- POST /flights/:id/legs y POST /flights/:id/operational-legs desde la app
-- sin red: un reintento sin llave duplicaba el tramo (el operativo calcula
-- orden = max+1 y no tenía ningún dedupe). El replay devuelve el tramo YA
-- creado con su `orden` (200, idempotente:true) sin re-avisar a la
-- tripulación (notificarTramoNuevo). El API acota la relectura al vuelo:
-- una llave reutilizada en OTRO vuelo responde 409 CLIENT_REQUEST_ID_EN_USO.
alter table public.escala
  add column if not exists client_request_id uuid;
create unique index if not exists uq_escala_client_request
  on public.escala (client_request_id)
  where client_request_id is not null;
comment on column public.escala.client_request_id is
  'Llave de idempotencia generada por la app por captura; única. Reintento con la misma llave = mismo tramo (200, idempotente:true, con su orden; sin re-avisar a la tripulación). Solo la app la manda; el panel inserta sin ella.';
