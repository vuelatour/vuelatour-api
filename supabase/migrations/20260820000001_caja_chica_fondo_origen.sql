-- Cajas chicas VINCULADAS (pedido de tesorería, 20-ago-2026): la caja de
-- Mary fondea las cajas de sus compañeros — cada REPOSICIÓN a una caja
-- vinculada debe descontarse sola de la caja madre (hoy ese dinero salía
-- sin registro). Modelo: espejo automático — la reposición en la caja hija
-- genera un REINTEGRO en la caja origen, amarrados por espejo_de_id
-- (borrar la reposición borra el espejo por CASCADE; editarla lo
-- sincroniza el API; el espejo no se edita directo).

alter table public.caja_chica_fondo
  add column if not exists fondo_origen_id uuid
    references public.caja_chica_fondo(id) on delete set null;
comment on column public.caja_chica_fondo.fondo_origen_id is
  'Caja MADRE que fondea a esta: cada REPOSICIÓN aquí genera un REINTEGRO espejo allá. Se configura desde Usuarios.';

alter table public.caja_chica_movimiento
  add column if not exists espejo_de_id uuid
    references public.caja_chica_movimiento(id) on delete cascade;
comment on column public.caja_chica_movimiento.espejo_de_id is
  'Movimiento ORIGEN del que este es espejo (fondeo automático de caja vinculada). No se edita directo: sigue a su origen.';

create unique index if not exists caja_chica_mov_espejo_unico
  on public.caja_chica_movimiento(espejo_de_id)
  where espejo_de_id is not null;
