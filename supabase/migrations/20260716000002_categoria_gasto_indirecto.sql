-- Gastos INDIRECTOS (pedido 16 jul 2026): gastos de la operación que NO
-- pertenecen a un vuelo (como la hoja "gastos indirectos" del control del
-- equipo: servicios, mantenimientos, honorarios). Se capturan sin vuelo
-- (avión opcional) y por ahora NO entran al reparto ni a la bandeja de
-- pendientes — su tratamiento se decidirá con el equipo.
alter type public.categoria_gasto add value if not exists 'INDIRECTO';
