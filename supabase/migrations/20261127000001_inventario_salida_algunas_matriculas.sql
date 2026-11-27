-- 20261127000001_inventario_salida_algunas_matriculas.sql
--
-- SALIDA DE BODEGA PARA ALGUNAS MATRÍCULAS (27-nov-2026, API 0.0.152,
-- invariante 146).
--
-- Pedido de la oficina (Jimmy, WhatsApp 27-nov-2026, con la captura del
-- diálogo «Movimiento de cardex»): «necesito me den la opción de marcar
-- algunas matrículas, ya que necesito poner solo 4 matrículas y no todas».
-- Hasta hoy una salida se cargaba a UN avión o se repartía en partes iguales
-- entre TODA la flota activa (`para_flota`, migraciones 20260713000003 y
-- 20260922000003). Faltaba el caso de en medio: repartirla entre las
-- matrículas que la oficina elija.
--
-- QUÉ HACE (ADITIVA: una columna y un CHECK; ninguna fila cambia):
--   1. `inventario_movimiento.aeronave_ids uuid[]`: las matrículas ELEGIDAS
--      de una salida repartida. NULL = como siempre (un avión en
--      `aeronave_id`, o toda la flota activa del día si `para_flota`).
--   2. `inventario_movimiento_aeronave_ids_chk`: la lista solo existe en una
--      salida repartida (`para_flota`, que a su vez ya exige SALIDA y sin
--      `aeronave_id` por `inventario_movimiento_para_flota_chk`) y trae al
--      menos DOS matrículas (una sola es una salida normal a ese avión).
--
-- El reparto del dinero NO vive aquí: el API crea un gasto REFACCION/BODEGA
-- por matrícula elegida (Σ exacta, residuo en la primera), todos ligados al
-- movimiento por `gasto.inventario_movimiento_id` (1→N desde 20260922000003).
-- La columna guarda QUÉ matrículas se eligieron para que el cardex lo diga
-- aunque la salida haya salido a $0 (sin gastos) y para que la bitácora de
-- una baja (`to_jsonb` del movimiento) lo conserve.
--
-- Sin disparadores ni funciones. `if not exists` en la columna; el CHECK se
-- agrega una sola vez (reaplicar la migración choca con 42710, a propósito:
-- ya está aplicada).
--
-- ORDEN DE DEPLOY: esta migración ANTES del API 0.0.152 (el API nuevo lee la
-- columna en el cardex). Un API anterior no la nombra: no le afecta.
--
-- REVERSA: no hace falta para volver a un API anterior. Si se quisiera
-- retirar, se quitan el CHECK y la columna desde el SQL Editor.
--
-- Se puede aplicar por MCP (no lleva sentencias destructivas); después,
-- `get_advisors`.
--
-- APLICADA en prod (bjesduasnzbzywofukbf) el 27-nov-2026 por MCP, después de
-- correr el dry-run (`_dryrun/20261127000001_…dryrun.sql`: terminó en
-- DRYRUN_OK y no dejó nada). Registrada en
-- `supabase_migrations.schema_migrations`. Advisors: nada nuevo.

-- >>> CUERPO
alter table public.inventario_movimiento
  add column if not exists aeronave_ids uuid[];

alter table public.inventario_movimiento
  add constraint inventario_movimiento_aeronave_ids_chk
  check (
    aeronave_ids is null
    or (para_flota and cardinality(aeronave_ids) >= 2)
  );

comment on column public.inventario_movimiento.aeronave_ids is
  'Matrículas ELEGIDAS de una salida repartida (para_flota = true): el cargo se divide en partes iguales solo entre ellas, un gasto por avión. NULL = un solo avión (aeronave_id) o toda la flota activa del día de la captura. Mínimo 2.';
-- <<< CUERPO
