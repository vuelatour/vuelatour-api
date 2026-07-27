-- Cancelación POR TRAMO (caso real vuelo #74, jul 2026): el avión llegó a MID
-- con fallas y se quedó en taller; el regreso MID→CUN nunca voló, pero la
-- escala seguía viva y la cadena de tacómetros (propagación/deducción) le
-- fabricó lecturas. Ahora un tramo se puede CANCELAR con motivo auditable:
--  - sus tacómetros provisionales (DEDUCIDO) se anulan (horas derivadas = 0);
--  - se excluye de completitud (complete/tacoStatus/taco-live/pre-cierre),
--    de la propagación y de las sugerencias;
--  - un tramo con lecturas/fotos REALES (PILOTO/OFICINA/IA) no se cancela:
--    el vuelo sí ocurrió — se corrige la ruta o se cancela el vuelo entero.
-- Restaurar = limpiar estos campos (las lecturas no se recuperan: se
-- recapturan o las ajusta oficina).
alter table public.escala
  add column if not exists cancelada_at timestamptz,
  add column if not exists cancelada_motivo text,
  add column if not exists cancelada_por uuid references public.usuario(id) on delete set null;

comment on column public.escala.cancelada_at is
  'Tramo cancelado (no voló): fecha de cancelación. NULL = tramo activo. Excluido de horas, completitud, propagación y calendario.';
comment on column public.escala.cancelada_motivo is
  'Motivo auditable de la cancelación del tramo (obligatorio al cancelar), p. ej. "Avión en taller en MID por falla".';
comment on column public.escala.cancelada_por is
  'Usuario (oficina) que canceló el tramo.';
