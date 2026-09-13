-- 12-sep-2026 · Sync sistema → Google Calendar de MANTENIMIENTOS (pedido del
-- cliente: «que se sincronicen vuelos, eventos, mantenimientos, etc.»).
-- Mismo contrato que vuelo/escala/piloto_descanso/evento_flota: el id del
-- evento de Google se guarda en la fila para upsert idempotente.
-- Aplicada vía MCP en prod (bjesduasnzbzywofukbf) el 12-sep-2026 ANTES del
-- deploy del API 0.0.10.
alter table public.mantenimiento
  add column if not exists google_calendar_id text;
comment on column public.mantenimiento.google_calendar_id is
  'Id del evento en el Google Calendar compartido (sync sistema → Google, calendar-sync.service). null = sin evento (sin fecha_programada, COMPLETADO o sync apagada).';
