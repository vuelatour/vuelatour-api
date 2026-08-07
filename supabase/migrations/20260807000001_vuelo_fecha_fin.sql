-- Viaje multi-día (1 viaje = 1 vuelo): vuelo.fecha_fin = fin derivado del
-- itinerario. Es el eje temporal para "¿el vuelo sigue activo hoy?" en
-- taco-live, crones zombi/estancados, calendario y listados. NO sustituye a
-- fecha_traslado_final (semántica comercial del redondo) ni a fecha_vuelo
-- (eje de dinero del cierre mensual — los reportes NO cambian de eje).
--
-- Derivación: max(fecha_salida_plan de escalas activas), con respaldo
-- fecha_traslado_final y fecha_vuelo; nunca menor a fecha_vuelo.
-- Se mantiene por TRIGGER (hay ~18 caminos de escritura de escalas en dos
-- servicios; un recalc en servicio se olvidaría en el siguiente camino).

alter table vuelo add column if not exists fecha_fin timestamptz;

comment on column vuelo.fecha_fin is
  'Fin derivado del itinerario (max fecha_salida_plan activa, respaldo fecha_traslado_final/fecha_vuelo). Mantenida por trigger; NO editar a mano.';

create or replace function recompute_vuelo_fecha_fin(p_vuelo_id uuid)
returns void
language sql
security definer
set search_path = public
as $$
  update vuelo v
  set fecha_fin = greatest(
    coalesce(
      (select max(e.fecha_salida_plan)
         from escala e
        where e.vuelo_id = p_vuelo_id
          and e.cancelada_at is null),
      v.fecha_traslado_final,
      v.fecha_vuelo
    ),
    v.fecha_vuelo
  )
  where v.id = p_vuelo_id;
$$;

-- Escala: cualquier alta/baja/cambio de fecha o cancelación recalcula el
-- vuelo dueño (y el anterior, si el tramo cambió de vuelo — caso fusión).
create or replace function trg_escala_recompute_fecha_fin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  if tg_op = 'DELETE' then
    perform recompute_vuelo_fecha_fin(old.vuelo_id);
    return old;
  end if;
  if tg_op = 'UPDATE' and new.vuelo_id is distinct from old.vuelo_id then
    perform recompute_vuelo_fecha_fin(old.vuelo_id);
  end if;
  perform recompute_vuelo_fecha_fin(new.vuelo_id);
  return new;
end;
$$;

drop trigger if exists escala_fecha_fin on escala;
create trigger escala_fecha_fin
  after insert or delete
     or update of fecha_salida_plan, cancelada_at, vuelo_id
  on escala
  for each row execute function trg_escala_recompute_fecha_fin();

-- Vuelo: cambios de fecha_vuelo / fecha_traslado_final recalculan inline
-- (BEFORE = sin recursión; el UPDATE del trigger de escala no toca estas
-- columnas, así que no se re-dispara).
create or replace function trg_vuelo_recompute_fecha_fin()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
begin
  new.fecha_fin := greatest(
    coalesce(
      (select max(e.fecha_salida_plan)
         from escala e
        where e.vuelo_id = new.id
          and e.cancelada_at is null),
      new.fecha_traslado_final,
      new.fecha_vuelo
    ),
    new.fecha_vuelo
  );
  return new;
end;
$$;

drop trigger if exists vuelo_fecha_fin on vuelo;
create trigger vuelo_fecha_fin
  before insert
     or update of fecha_vuelo, fecha_traslado_final
  on vuelo
  for each row execute function trg_vuelo_recompute_fecha_fin();

-- Backfill de todas las filas existentes.
update vuelo v
set fecha_fin = greatest(
  coalesce(
    (select max(e.fecha_salida_plan)
       from escala e
      where e.vuelo_id = v.id
        and e.cancelada_at is null),
    v.fecha_traslado_final,
    v.fecha_vuelo
  ),
  v.fecha_vuelo
);

create index if not exists idx_vuelo_fecha_fin on vuelo (fecha_fin);

-- Internas (triggers): nadie las invoca vía PostgREST /rpc; el API escribe
-- con service key. Sin esto, los advisors marcan SECURITY DEFINER expuesto.
revoke execute on function recompute_vuelo_fecha_fin(uuid) from public, anon, authenticated;
revoke execute on function trg_escala_recompute_fecha_fin() from public, anon, authenticated;
revoke execute on function trg_vuelo_recompute_fecha_fin() from public, anon, authenticated;
