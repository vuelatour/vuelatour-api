-- Asignación por tramo en vuelos redondos (ida/regreso independientes).
--
-- Contexto: un vuelo REDONDO es UN solo registro `vuelo` con fecha_vuelo (ida) y
-- fecha_traslado_final (regreso). La asignación (aeronave/piloto/permiso) vivía en el
-- vuelo, así que ida y regreso compartían avión y piloto. Ahora la asignación se mueve
-- al nivel de tramo (`escala`): cada tramo puede tener aeronave/piloto/permiso propios.
-- La cotización y el cobro siguen siendo del vuelo.
--
-- Compat: `vuelo.aeronave_id/piloto_id/estado_permiso` se conservan como ESPEJO del
-- tramo de ida (orden=1), sincronizado por la app (no trigger), para no romper los
-- lectores existentes (filtros de lista, acceso de piloto, color de calendario, etc).

-- 1) Columnas nuevas en escala. Reutiliza el enum estado_permiso (creado en
--    20260521000002). aeronave/usuario FK targets ya existen.
ALTER TABLE public.escala
  ADD COLUMN IF NOT EXISTS aeronave_id uuid REFERENCES public.aeronave(id) ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS piloto_id   uuid REFERENCES public.usuario(id)  ON DELETE SET NULL,
  ADD COLUMN IF NOT EXISTS estado_permiso public.estado_permiso NOT NULL DEFAULT 'no_aplica',
  ADD COLUMN IF NOT EXISTS fecha_salida_plan timestamptz,
  ADD COLUMN IF NOT EXISTS foto_plan_vuelo_url text,
  ADD COLUMN IF NOT EXISTS google_calendar_id text;

COMMENT ON COLUMN public.escala.aeronave_id IS 'Aeronave asignada a este tramo (independiente por ida/regreso).';
COMMENT ON COLUMN public.escala.piloto_id IS 'Piloto asignado a este tramo. El tramo orden=1 (ida) se espeja en vuelo.piloto_id.';
COMMENT ON COLUMN public.escala.estado_permiso IS 'Permiso de pista por tramo: no_aplica | pendiente | emitido.';
COMMENT ON COLUMN public.escala.fecha_salida_plan IS 'Fecha/hora planeada de salida del tramo (ida=fecha_vuelo, regreso=fecha_traslado_final).';
COMMENT ON COLUMN public.escala.foto_plan_vuelo_url IS 'Foto opcional del plan de vuelo de este tramo.';
COMMENT ON COLUMN public.escala.google_calendar_id IS 'Event id en Google Calendar de este tramo (reservado para migración futura a eventos per-escala).';

CREATE INDEX IF NOT EXISTS idx_escala_piloto ON public.escala (piloto_id) WHERE piloto_id IS NOT NULL;
CREATE INDEX IF NOT EXISTS idx_escala_aeronave ON public.escala (aeronave_id) WHERE aeronave_id IS NOT NULL;

-- 2) Backfill: REDONDO sin escalas -> crea ida (orden 1) + regreso (orden 2).
--    Idempotente: el guard NOT EXISTS salta MULTIESCALA y cualquier REDONDO que ya
--    tenga escalas (preserva tacómetros de vuelos completados).
WITH redondos AS (
  SELECT v.* FROM public.vuelo v
  WHERE v.tipo = 'REDONDO'
    AND NOT EXISTS (SELECT 1 FROM public.escala e WHERE e.vuelo_id = v.id)
)
INSERT INTO public.escala
  (vuelo_id, orden, origen_iata, destino_iata,
   aeronave_id, piloto_id, estado_permiso, fecha_salida_plan,
   foto_plan_vuelo_url, created_by, updated_by)
-- IDA (orden 1): copia asignación del vuelo y su estado de permiso.
SELECT r.id, 1, r.origen_iata, r.destino_iata,
       r.aeronave_id, r.piloto_id,
       CASE WHEN COALESCE(po.requiere_permiso, false) OR COALESCE(pd.requiere_permiso, false)
            THEN r.estado_permiso ELSE 'no_aplica'::public.estado_permiso END,
       r.fecha_vuelo, r.foto_plan_vuelo_url, r.created_by, r.updated_by
FROM redondos r
LEFT JOIN public.aeropuerto po ON po.iata = r.origen_iata
LEFT JOIN public.aeropuerto pd ON pd.iata = r.destino_iata
UNION ALL
-- REGRESO (orden 2): IATAs invertidos, SIN asignar (queda pendiente de asignar).
SELECT r.id, 2, r.destino_iata, r.origen_iata,
       NULL, NULL,
       CASE WHEN COALESCE(po.requiere_permiso, false) OR COALESCE(pd.requiere_permiso, false)
            THEN 'pendiente'::public.estado_permiso ELSE 'no_aplica'::public.estado_permiso END,
       r.fecha_traslado_final, NULL, r.created_by, r.updated_by
FROM redondos r
LEFT JOIN public.aeropuerto po ON po.iata = r.origen_iata
LEFT JOIN public.aeropuerto pd ON pd.iata = r.destino_iata;

-- 3) MULTIESCALA: marca permiso por tramo cuando algún aeropuerto del tramo lo exige
--    (gana asignación/permiso por tramo gratis; las escalas ya existen).
UPDATE public.escala e SET estado_permiso = 'pendiente'
FROM public.vuelo v
WHERE e.vuelo_id = v.id AND v.tipo = 'MULTIESCALA'
  AND e.estado_permiso = 'no_aplica'
  AND EXISTS (SELECT 1 FROM public.aeropuerto a
              WHERE a.requiere_permiso = true
                AND a.iata IN (e.origen_iata, e.destino_iata));
