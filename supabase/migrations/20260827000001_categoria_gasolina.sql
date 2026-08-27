-- Gasolina de VEHÍCULOS (27-ago-2026, aprobado por el cliente): los coches
-- de la empresa cargaban como categoría GAS y con la regla "el gas es del
-- avión" contaminaban balances (caso XB-ANU $450) o bloqueaban el pre-cierre
-- como "GAS sin avión". Categoría propia: gasto de la EMPRESA, sin vuelo ni
-- avión (candados en la API), visible en Otros gastos y repartible a mano.
alter type public.categoria_gasto add value if not exists 'GASOLINA';
