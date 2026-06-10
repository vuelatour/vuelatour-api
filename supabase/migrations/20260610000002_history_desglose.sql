-- El historial de versiones también versiona los componentes del desglose
-- (pernocta y extras), igual que vuelo. Sin estas columnas, appendVersionHistory
-- fallaba ("Could not find the 'extras_total_usd' column...") y la revisión
-- quedaba aplicada en vuelo pero sin su renglón de historial.

alter table public.cotizacion_version_history
  add column if not exists viaticos_pernocta_usd decimal(12,2) not null default 0,
  add column if not exists extras_total_usd decimal(12,2) not null default 0;

-- Backfill desde el snapshot guardado en cada versión.
update public.cotizacion_version_history
set
  viaticos_pernocta_usd = coalesce(
    (calculo_snapshot -> 'totales' ->> 'viaticos_pernocta_usd')::decimal, 0
  ),
  extras_total_usd = coalesce(
    (calculo_snapshot -> 'totales' ->> 'extras_total_usd')::decimal, 0
  )
where calculo_snapshot is not null;
