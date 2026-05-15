-- Migration: 20260514000001_escala_millas_nauticas
-- Permite persistir las escalas planificadas al cotizar un vuelo MULTIESCALA.
-- La tabla escala ya existia para tacometros (FASE 3 - captura mobile). Aqui solo
-- agregamos millas_nauticas como atributo del plan; cuando el piloto vuele, llenara
-- los tacometros sin tocar este campo.

alter table public.escala
  add column millas_nauticas decimal(8,2);

comment on column public.escala.millas_nauticas is 'Millas nauticas planificadas del segmento (cotizado). Independiente de los tacometros que captura el piloto.';
