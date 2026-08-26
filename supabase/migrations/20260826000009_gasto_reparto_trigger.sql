-- Defensa en profundidad (verificación 26-ago): la regla "solo gastos SIN
-- vuelo de categorías OTRO/FIJO/INDIRECTO se reparten" vivía solo en el API;
-- una fila manual sobre un GAS o un gasto con vuelo haría divergir el
-- reparto a socios del balance (lectores distintos). El trigger la vuelve
-- invariante de la base.
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
  if v_categoria not in ('OTRO', 'FIJO', 'INDIRECTO') then
    raise exception 'gasto_reparto: la categoría % no es repartible (solo OTRO/FIJO/INDIRECTO)', v_categoria;
  end if;
  return new;
end $$;

create trigger trg_gasto_reparto_valida
  before insert or update on public.gasto_reparto
  for each row execute function public.tg_gasto_reparto_valida();

-- created_by es inmutable (bitácora de quién creó la atribución).
create or replace function public.tg_gasto_reparto_creador()
returns trigger language plpgsql as $$
begin
  new.created_by := old.created_by;
  return new;
end $$;

create trigger trg_gasto_reparto_creador
  before update on public.gasto_reparto
  for each row execute function public.tg_gasto_reparto_creador();
