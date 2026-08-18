-- Borrado SUAVE de vencimientos (documentos de aeronave/piloto/motor).
-- Caso real (18-ago-2026): al mecánico le "desaparecieron" documentos
-- (Bianual y Batería ELT de XA-VGV) y el borrado duro no dejó rastro de
-- quién ni cuándo — ni forma de recuperar el trabajo. Ahora eliminar marca
-- deleted_at/deleted_by (el archivo del bucket se CONSERVA) y ADMIN puede
-- restaurar; todos los lectores filtran deleted_at is null.

alter table public.vencimiento
  add column if not exists deleted_at timestamptz,
  add column if not exists deleted_by uuid references public.usuario(id) on delete set null;

comment on column public.vencimiento.deleted_at is
  'Borrado suave: fecha de eliminación. Los lectores filtran is null; ADMIN/COORDINADOR pueden restaurar.';
comment on column public.vencimiento.deleted_by is
  'Quién eliminó el documento (bitácora pedida por el mecánico, 18-ago-2026).';
