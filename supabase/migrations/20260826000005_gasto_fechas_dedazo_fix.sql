-- Corrección de 6 fechas de gasto con dedazo (verificación 26-ago-2026):
-- dd/mm volteados o año equivocado, evidenciados contra la fecha del vuelo
-- ligado. El eje fecha_gasto gobierna reparto/Libro/conciliación: estas
-- fechas ponían el gasto en OTRO mes que su vuelo.
update public.gasto set fecha_gasto = '2026-07-14' where id = '26e5fd11-3a79-4326-8959-e3c7c4cc4704' and fecha_gasto = '2026-01-14'; -- TAXI $80, vuelo #45 (14-jul): mes 01↔07
update public.gasto set fecha_gasto = '2026-08-06' where id = '90af64cb-e7de-4812-8a71-880c40ad717f' and fecha_gasto = '2026-06-08'; -- COMIDA $305, vuelo #119 (06-ago): dd/mm
update public.gasto set fecha_gasto = '2026-08-07' where id = '2acde018-1493-4006-81a4-712722227cba' and fecha_gasto = '2026-07-08'; -- TAXI $600, vuelo #124 (07-ago): dd/mm
update public.gasto set fecha_gasto = '2026-08-10' where id = '8693d0f7-752a-45cd-bfff-adb1cc71e033' and fecha_gasto = '2026-10-08'; -- TAXI $504, vuelo #138 (11-ago): dd/mm
update public.gasto set fecha_gasto = '2026-08-12' where id = 'b4dc37da-5ecf-455c-bfe0-6e70f25f1b7d' and fecha_gasto = '2026-12-08'; -- OPERACIONES $1,272.07 USD, vuelo #141 (12-ago): dd/mm
update public.gasto set fecha_gasto = '2026-08-26' where id = '66d575d8-547b-4cae-91b4-232224051ee3' and fecha_gasto = '2025-08-26'; -- TAXI $400, vuelo #190 (25-ago-2026): año 2025→2026
