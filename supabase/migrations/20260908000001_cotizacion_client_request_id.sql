-- 8-sep-2026 · Rediseño del cotizador (edición directa, F0): idempotencia de
-- "Guardar" en POST /quotes (crear) y POST /quotes/:id/revise (versión nueva).
-- Mismo patrón que gasto/cobro_vuelo/mantenimiento (29-ago) y cobro_grupo
-- (4-sep): el panel manda una llave única por intento; un reintento (doble
-- clic, timeout tras commit, reconexión) colisiona aquí y el API devuelve la
-- cotización/versión YA creada (200) en vez de duplicar vuelos o versiones.

alter table public.vuelo add column if not exists client_request_id uuid;
create unique index if not exists uq_vuelo_client_request
  on public.vuelo (client_request_id) where client_request_id is not null;
comment on column public.vuelo.client_request_id is
  'Llave de idempotencia generada por el panel al CREAR la cotización; única. Reintento con la misma llave = misma cotización (200). No se clona en reassignAircraft.';

alter table public.cotizacion_version_history
  add column if not exists client_request_id uuid;
create unique index if not exists uq_cot_version_client_request
  on public.cotizacion_version_history (client_request_id)
  where client_request_id is not null;
comment on column public.cotizacion_version_history.client_request_id is
  'Llave de idempotencia de la REVISIÓN que creó esta versión (POST /quotes/:id/revise). Reintento con la misma llave = se devuelve la cotización vigente sin crear otra versión.';
