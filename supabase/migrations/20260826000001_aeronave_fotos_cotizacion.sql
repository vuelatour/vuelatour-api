-- (aplicada y luego revertida por 20260826000002 en el mismo cambio: las
-- fotos del PDF terminaron en la galería aeronave_imagen, no en columnas.)
alter table aeronave
  add column if not exists foto_exterior_path text,
  add column if not exists foto_interior_path text;
