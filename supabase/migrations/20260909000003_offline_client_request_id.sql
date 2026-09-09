-- 9-sep-2026 · Alta de vuelo/descanso/evento SIN internet desde la app
-- (diseño v2, sección 1.4): idempotencia de POST /pilots/:id/descansos y
-- POST /calendar/eventos. Mismo patrón que gasto/cobro_vuelo/mantenimiento
-- (29-ago) y vuelo/cotizacion_version_history (8-sep): la app manda una
-- llave única por captura; un reintento del outbox (timeout tras commit,
-- doble flush, reconexión) colisiona aquí y el API devuelve la fila YA
-- creada en vez de duplicar el descanso/evento (y de re-avisar al piloto).
--
-- ORDEN OBLIGATORIO: se aplica vía MCP (prod bjesduasnzbzywofukbf) ANTES del
-- push del API. El código solo incluye la columna en el insert cuando la
-- llave viaja, así que el API viejo con la columna nueva es inocuo; el API
-- nuevo SIN la columna respondería 42703 (500) a las capturas de la app.
-- Nombres reales de las tablas: public.piloto_descanso y public.evento_flota.

alter table public.piloto_descanso
  add column if not exists client_request_id uuid;
create unique index if not exists uq_piloto_descanso_client_request
  on public.piloto_descanso (client_request_id)
  where client_request_id is not null;
comment on column public.piloto_descanso.client_request_id is
  'Llave de idempotencia generada por la app/panel por captura; única. Reintento con la misma llave = mismo descanso (200, idempotente:true, sin re-avisar al piloto).';

alter table public.evento_flota
  add column if not exists client_request_id uuid;
create unique index if not exists uq_evento_flota_client_request
  on public.evento_flota (client_request_id)
  where client_request_id is not null;
comment on column public.evento_flota.client_request_id is
  'Llave de idempotencia generada por la app/panel por captura; única. Reintento con la misma llave = mismo evento (200, idempotente:true, sin re-avisar al responsable).';
