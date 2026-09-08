-- 7-sep-2026 · gasto.capturado_en: DEFAULT now() de respaldo.
-- Los 4 inserts del API lo sellan en código; este default cubre cargas
-- manuales por SQL y cualquier insert futuro que omita la columna, para que
-- jamás quede NULL (saldría del filtro/orden por captura del panel).
-- Solo metadata: no reescribe filas ni cambia valores existentes.
alter table public.gasto alter column capturado_en set default now();
