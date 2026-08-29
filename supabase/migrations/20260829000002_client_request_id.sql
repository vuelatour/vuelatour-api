-- 29-ago-2026 · Idempotencia de capturas (auditoría "guardado silencioso"):
-- la app manda una llave única por captura; un reintento (timeout tras
-- commit, doble flush del outbox, doble tap) colisiona aquí y el API
-- devuelve la fila existente en vez de duplicar dinero.
alter table public.gasto add column if not exists client_request_id uuid;
create unique index if not exists uq_gasto_client_request
  on public.gasto (client_request_id) where client_request_id is not null;
comment on column public.gasto.client_request_id is
  'Llave de idempotencia generada por el cliente (app/panel) por captura; única. Reintento con la misma llave = misma fila.';

alter table public.cobro_vuelo add column if not exists client_request_id uuid;
create unique index if not exists uq_cobro_vuelo_client_request
  on public.cobro_vuelo (client_request_id) where client_request_id is not null;
comment on column public.cobro_vuelo.client_request_id is
  'Llave de idempotencia por captura de cobro (ver gasto.client_request_id).';

alter table public.mantenimiento add column if not exists client_request_id uuid;
create unique index if not exists uq_mantenimiento_client_request
  on public.mantenimiento (client_request_id) where client_request_id is not null;
comment on column public.mantenimiento.client_request_id is
  'Llave de idempotencia por captura de mantenimiento (ver gasto.client_request_id).';
