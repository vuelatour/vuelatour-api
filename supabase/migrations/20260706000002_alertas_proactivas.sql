-- Nuevas reglas de alerta proactiva: el sistema vigila, el empleado supervisa.
-- servicio_horas: próximo servicio del programa cíclico y TBO de motor/hélice.
-- caja_negativa: fondo de caja chica sobregirado.
-- gastos_sin_avion: bandeja de pendientes no vacía (meta del diseño: vacía).
-- vuelo_estancado: vuelos con fecha pasada que no llegaron a COMPLETADO.
INSERT INTO alerta_config (clave, descripcion, canal, roles, dias_anticipacion, horas_anticipacion) VALUES
  ('servicio_horas', 'Servicio por horas / TBO de motor o hélice cerca de vencer', 'ambos', ARRAY['ADMIN','COORDINADOR'], '{}', 10),
  ('caja_negativa', 'Fondo de caja chica con saldo negativo', 'socket', ARRAY['ADMIN','FACTURACION'], '{}', NULL),
  ('gastos_sin_avion', 'Gastos sin avión asignado (bandeja de pendientes)', 'socket', ARRAY['ADMIN','ANALISTA'], '{}', NULL),
  ('vuelo_estancado', 'Vuelo con fecha pasada sin completar (horas/ingresos fuera del cierre)', 'socket', ARRAY['ADMIN','COORDINADOR'], '{}', NULL)
ON CONFLICT (clave) DO NOTHING;
