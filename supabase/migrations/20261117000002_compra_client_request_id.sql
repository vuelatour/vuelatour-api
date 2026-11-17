-- 20261117000002_compra_client_request_id.sql
--
-- COMPRAS IDEMPOTENTES: LLAVE `client_request_id` EN `compra` (17-nov-2026,
-- API 0.0.142, invariante 137).
--
-- Desde la app 1.1.4+92 una «compra de la tienda» se registra desde el
-- teléfono con `POST /v1/compras`. El alta no tenía llave: un reenvío tras
-- una respuesta perdida creaba DOS compras (dinero e inventario duplicados).
-- Mismo patrón que las demás altas que nacen en la app (migraciones
-- 20260829000002, 20260908000001, 20260909000003 y 20260910000002): la app
-- manda una llave única por alta (uuid v4) y, si la repite, el API responde
-- la compra YA creada (200, `idempotente: true`) sin escribir nada.
--
-- QUÉ HACE (ADITIVA: una columna y un índice; ninguna fila cambia):
--   1. `compra.client_request_id uuid`, sin valor por omisión: las compras
--      que ya existen y las que da de alta el panel quedan en null.
--   2. `uq_compra_client_request`: índice ÚNICO PARCIAL (solo llaves no
--      nulas). Es el candado entre dos envíos simultáneos: el segundo INSERT
--      choca (23505) y el API relee la compra por su llave.
--
-- Sin disparadores ni funciones. Todo es `if not exists`: reaplicable.
--
-- El API 0.0.142 funciona con y sin la columna (`columna-opcional.util`):
-- sin ella la llave se ignora (alta de siempre, sin idempotencia) y se
-- enciende sola en ≤ 10 min al aplicarla, sin reiniciar. Se puede aplicar
-- antes o después del deploy.
--
-- REVERSA: no hace falta (un API anterior no nombra la columna). Si aun así
-- se quisiera retirar, se quitan el índice y la columna desde el SQL Editor.
--
-- Se puede aplicar por MCP (no lleva sentencias destructivas); después,
-- `get_advisors`.
--
-- APLICADA en prod (bjesduasnzbzywofukbf) el 17-nov-2026 por MCP, con las
-- pruebas del dry-run (`_dryrun/20261117000002_…dryrun.sql`) corridas en la
-- misma transacción y revertidas. Advisors: nada nuevo.

-- >>> CUERPO
alter table public.compra
  add column if not exists client_request_id uuid;

create unique index if not exists uq_compra_client_request
  on public.compra (client_request_id)
  where client_request_id is not null;

comment on column public.compra.client_request_id is
  'Llave de idempotencia (uuid v4) que la app genera por alta de compra; única. Un reintento con la misma llave devuelve la compra YA creada (200, idempotente: true) sin duplicarla. El panel da de alta sin llave (null).';
-- <<< CUERPO
