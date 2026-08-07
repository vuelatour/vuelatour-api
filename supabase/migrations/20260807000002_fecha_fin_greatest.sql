-- Corrección de la fórmula de fecha_fin (hallazgo de revisión adversarial):
-- con COALESCE, en cuanto CUALQUIER escala activa tiene fecha_salida_plan
-- (y el tramo 1 SIEMPRE la tiene, es espejo de fecha_vuelo),
-- fecha_traslado_final quedaba enmascarada — un redondo cuyo regreso solo
-- vive en fecha_traslado_final (tramo 2 sin fecha propia) obtenía
-- fecha_fin = fecha_vuelo y desaparecía del calendario del mes del regreso.
-- GREATEST ignora nulls: participan las tres fuentes y gana la mayor.

create or replace function recompute_vuelo_fecha_fin(p_vuelo_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update vuelo v
  set fecha_fin = greatest(
    (select max(e.fecha_salida_plan)
       from escala e
      where e.vuelo_id = p_vuelo_id
        and e.cancelada_at is null),
    v.fecha_traslado_final,
    v.fecha_vuelo
  )
  where v.id = p_vuelo_id;
$$;

create or replace function trg_vuelo_recompute_fecha_fin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.fecha_fin := greatest(
    (select max(e.fecha_salida_plan)
       from escala e
      where e.vuelo_id = new.id
        and e.cancelada_at is null),
    new.fecha_traslado_final,
    new.fecha_vuelo
  );
  return new;
end;
$$;

revoke execute on function recompute_vuelo_fecha_fin(uuid) from public, anon, authenticated;
revoke execute on function trg_vuelo_recompute_fecha_fin() from public, anon, authenticated;

-- Re-backfill con la fórmula corregida.
update vuelo v
set fecha_fin = greatest(
  (select max(e.fecha_salida_plan)
     from escala e
    where e.vuelo_id = v.id
      and e.cancelada_at is null),
  v.fecha_traslado_final,
  v.fecha_vuelo
);
