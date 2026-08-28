-- 28-ago-2026 · Gasto VISITA (Onda Cafe Cancún, $450 MXN) capturado desde la
-- app el 28-ago-2026 13:08 con fecha_gasto 2025-08-26: la IA leyó el año del
-- ticket como 2025 y el gasto quedó un año atrás (invisible en el panel, que
-- lista los 200 más recientes por fecha). Se corrige al 26-ago-2026 (la fecha
-- de la visita) y se deja rastro en las notas. Guardado por el valor viejo.
update gasto
   set fecha_gasto = '2026-08-26',
       notas = coalesce(notas, '') || ' · [28-ago-2026] fecha corregida: la IA leyó 26/08/2025, la visita fue en 2026',
       updated_at = now()
 where id = '14f2821d-59d5-415e-913f-ddf632dd5ac7'
   and fecha_gasto = '2025-08-26' and categoria = 'VISITA' and monto = 450.00;
