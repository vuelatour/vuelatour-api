-- Separación cotización comercial vs operación de vuelo.
--
-- Un tramo (escala) puede ser:
--   - COMERCIAL (solo_operativa = false): cotizado, facturado, visible para el
--     cliente (PDF, vista de cotización). Es lo que se le cobra.
--   - OPERATIVO INTERNO (solo_operativa = true): ferry de regreso, parada
--     técnica, movimiento interno, pernocta operativa. Lo administra
--     operaciones; visible para piloto/calendario/tacómetro, pero EXCLUIDO del
--     precio y de la vista del cliente.
--
-- Todo lo existente queda como comercial (default false): ningún vuelo actual
-- cambia de comportamiento.

alter table public.escala
  add column if not exists solo_operativa boolean not null default false;

comment on column public.escala.solo_operativa is
  'true = tramo operativo interno (no cotizado, no facturado, no visible al cliente); false = tramo comercial.';
