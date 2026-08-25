-- Fotos del PDF de cotización desde la GALERÍA (aeronave_imagen): se
-- etiqueta una imagen como EXTERIOR y otra como INTERIOR (26-ago-2026).
alter table aeronave
  drop column if exists foto_exterior_path,
  drop column if exists foto_interior_path;
alter table aeronave_imagen
  add column if not exists etiqueta text
    check (etiqueta in ('EXTERIOR','INTERIOR'));
comment on column aeronave_imagen.etiqueta is 'Uso en el PDF de cotización: EXTERIOR o INTERIOR (una por aeronave)';
create unique index if not exists aeronave_imagen_etiqueta_unica
  on aeronave_imagen (aeronave_id, etiqueta) where etiqueta is not null;
