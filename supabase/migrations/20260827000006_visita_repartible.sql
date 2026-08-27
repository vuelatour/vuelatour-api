-- Parte 2 de VISITA (transacción separada del enum): repartible a mano.
create or replace function public.tg_gasto_reparto_valida()
returns trigger language plpgsql as $$
declare
  v_vuelo uuid;
  v_categoria text;
begin
  select vuelo_id, categoria::text into v_vuelo, v_categoria
  from public.gasto where id = new.gasto_id;
  if v_vuelo is not null then
    raise exception 'gasto_reparto: el gasto % está ligado a un vuelo — su avión se controla por el vuelo', new.gasto_id;
  end if;
  if v_categoria not in ('OTRO', 'FIJO', 'INDIRECTO', 'GASOLINA', 'VISITA') then
    raise exception 'gasto_reparto: la categoría % no es repartible (solo OTRO/FIJO/INDIRECTO/GASOLINA/VISITA)', v_categoria;
  end if;
  return new;
end $$;
