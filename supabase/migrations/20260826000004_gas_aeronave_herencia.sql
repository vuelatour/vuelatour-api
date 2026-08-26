-- Combustible por avión (26-ago-2026): el gas se controla por aeronave_id +
-- fecha_gasto (mismo eje que el reparto). Backfill de herencia vuelo→avión
-- para cargas GAS que quedaron con vuelo pero sin aeronave — invisibles para
-- el reparto (filtra aeronave_id crudo). El API ahora sella la herencia al
-- crear/actualizar y exige avión en toda carga GAS nueva.
update public.gasto g
set aeronave_id = v.aeronave_id
from public.vuelo v
where g.vuelo_id = v.id
  and g.aeronave_id is null
  and g.categoria = 'GAS'
  and v.aeronave_id is not null;
