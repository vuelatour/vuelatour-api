-- Corrección de datos (26-ago-2026, aprobada por el cliente): el 11-ago dos
-- vuelos se encontraron en MID con cambio de avión (#105 ida N990GG /
-- regreso N4142R; #138 N4142R local) y dos recibos de ASUR Mérida quedaron
-- CRUZADOS (cada uno en el avión del otro); un tercero de N990GG en CUN
-- quedó sin avión. La matrícula impresa en cada recibo manda:
--   $144.78 (recibo N990GG · MID)  → N990GG + vuelo #105 (su aterrizaje de la ida)
--   $148.38 (recibo N4142R · MID)  → N4142R + vuelo #138 (su salto local + pernocta)
--   $106.90 (recibo N990GG · CUN)  → N990GG (vuelo lo liga oficina)
-- Los WHERE fijan el estado ACTUAL exacto: si ya se corrigió, no tocan nada.

update gasto
   set aeronave_id = '8f37ec37-965a-42a8-bac4-9991d282f0a3', -- N990GG
       vuelo_id    = 'd10a052c-59ec-4a35-aebe-7696b2494f96'  -- #105
 where id = 'b0fcb84c-b1b3-4ea7-a3cd-3dcfa18b6572'
   and aeronave_id = '5a82eb4a-086c-4058-97bd-b2aacdc2e942'
   and vuelo_id = '2b5eccf3-7211-4990-8e19-598b14ae49fb';

update gasto
   set aeronave_id = '5a82eb4a-086c-4058-97bd-b2aacdc2e942', -- N4142R
       vuelo_id    = '2b5eccf3-7211-4990-8e19-598b14ae49fb'  -- #138
 where id = '53e6127a-f415-40ab-9ca0-bece53fb9038'
   and aeronave_id = '8f37ec37-965a-42a8-bac4-9991d282f0a3'
   and vuelo_id = 'd10a052c-59ec-4a35-aebe-7696b2494f96';

update gasto
   set aeronave_id = '8f37ec37-965a-42a8-bac4-9991d282f0a3'  -- N990GG
 where id = '7b4d759d-4f0a-4dad-942d-56783dc383b8'
   and aeronave_id is null
   and vuelo_id is null;
