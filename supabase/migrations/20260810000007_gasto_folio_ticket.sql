-- Folio / remisión del ticket o factura (ej. remisión ASA en combustibles):
-- la llave natural anti-duplicados — el mismo pago capturado dos veces trae
-- el mismo folio sin importar quién lo capture ni cuántos días después.
alter table gasto add column if not exists folio_ticket varchar(60);

-- Normalizado (solo alfanumérico, mayúsculas) generado por la BD: la
-- comparación no depende de espacios/guiones/mayúsculas del capturista.
alter table gasto add column if not exists folio_ticket_norm text
  generated always as (
    nullif(upper(regexp_replace(coalesce(folio_ticket, ''), '[^A-Za-z0-9]', '', 'g')), '')
  ) stored;

-- CANDADO DURO: folios normalizados de 4+ caracteres no se repiten (el API
-- responde 409 con mensaje claro). Los cortos ("123") son demasiado
-- genéricos para rechazar: solo llevan el flag blando duplicado_sospechado.
create unique index if not exists uq_gasto_folio_ticket_norm
  on gasto (folio_ticket_norm)
  where folio_ticket_norm is not null and length(folio_ticket_norm) >= 4;
