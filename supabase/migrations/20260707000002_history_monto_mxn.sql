-- El historial de cotización debe espejar los campos de precio del vuelo:
-- al agregar el TC pactado (7 jul) el insert del historial empezó a fallar
-- porque monto_total_mxn no existía aquí (v3/v4 del folio 1 no se registraron).
alter table public.cotizacion_version_history
  add column monto_total_mxn numeric(14,2);

-- Reconstruye la versión VIGENTE de los vuelos cuyo registro se perdió por el
-- fallo (la versión del vuelo va adelante del historial). Motivo explícito.
insert into public.cotizacion_version_history (
  vuelo_id, version, aeronave_id, ruta_id, origen_iata, destino_iata,
  millas_nauticas_one_way, es_redondo_auto, num_aterrizajes, pasajeros,
  pase_abordar, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd,
  subtotal_vuelo_usd, tuas_usd, iva_pct, iva_usd, monto_total_usd,
  tc_usd_mxn, monto_total_mxn, viaticos_pernocta_usd, extras_total_usd,
  ajuste_final_usd, metodo_cobro, calculo_snapshot, motivo, created_by
)
select
  v.id, v.cotizacion_version, v.aeronave_id, v.ruta_id, v.origen_iata,
  v.destino_iata, v.millas_nauticas_one_way, v.es_redondo_auto,
  v.num_aterrizajes, v.pasajeros, v.pase_abordar, v.tiempo_cobrable_hr,
  v.tarifa_tipo, v.tarifa_hora_usd, v.subtotal_vuelo_usd, v.tuas_usd,
  v.iva_pct, v.iva_usd, v.monto_total_usd, v.tc_usd_mxn, v.monto_total_mxn,
  v.viaticos_pernocta_usd, v.extras_total_usd, v.ajuste_final_usd,
  v.metodo_cobro, v.calculo_snapshot,
  '(reconstruida: el registro original falló por columna faltante)',
  v.updated_by
from public.vuelo v
where v.cotizacion_version is not null
  and v.tarifa_hora_usd is not null
  and not exists (
    select 1 from public.cotizacion_version_history h
    where h.vuelo_id = v.id and h.version = v.cotizacion_version
  )
  and exists (select 1 from public.cotizacion_version_history h where h.vuelo_id = v.id);
