-- Defensa ESTRUCTURAL del invariante PERSONAL_DUENO (verificación 26-ago):
-- los candados de la API cubren create()/update(), pero existen escritores
-- directos a la tabla (generarPistas, enriquecimiento IA, futuros). Este
-- trigger garantiza que NINGÚN camino deje un gasto personal del dueño
-- ligado a vuelo, avión o escala — la exclusión de balances/reparto descansa
-- en ese invariante.
create or replace function public.tg_gasto_personal_dueno_valida()
returns trigger
language plpgsql
set search_path = public
as $$
begin
  if new.categoria = 'PERSONAL_DUENO'
     and (new.vuelo_id is not null
          or new.aeronave_id is not null
          or new.escala_id is not null) then
    raise exception
      'Un gasto personal del dueño no lleva vuelo, avión ni escala';
  end if;
  return new;
end;
$$;

drop trigger if exists trg_gasto_personal_dueno_valida on public.gasto;
create trigger trg_gasto_personal_dueno_valida
  before insert or update on public.gasto
  for each row execute function public.tg_gasto_personal_dueno_valida();
