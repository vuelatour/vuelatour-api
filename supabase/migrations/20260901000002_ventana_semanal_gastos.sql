-- 1-sep-2026 · REGLA FINAL del equipo (audio, junta con pilotos): la ventana
-- de gastos de campo pasa de "N días desde la captura" a BLOQUE SEMANAL
-- lunes→domingo (Cancún) con día de gracia (el lunes siguiente):
--   · capturar: solo gastos con fecha de la semana en curso; el lunes de
--     gracia todavía admite fechas de la semana pasada.
--   · corregir/borrar: hasta el lunes de gracia de la SEMANA DE CAPTURA
--     (lo capturado en lunes pertenece a la semana nueva).
-- Los días de gracia son configurables (default 1 = el lunes).
delete from configuracion_sistema where clave = 'dias_edicion_gastos_campo';
insert into configuracion_sistema (clave, activa, valor_numerico, descripcion)
values (
  'dias_gracia_gastos_semana', true, 1,
  'Días de gracia tras el domingo (Cancún) en que piloto/mecánico/visitante aún capturan gastos de la semana pasada y corrigen lo capturado en ella. 1 = hasta el lunes.'
)
on conflict (clave) do nothing;
