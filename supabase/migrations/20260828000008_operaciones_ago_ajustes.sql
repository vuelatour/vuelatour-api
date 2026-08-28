-- 28-ago-2026 · Ajustes a 20260828000007 tras verificar Σ operación vs Excel por vuelo.
-- (1) El cruce del 26-ago emparejó vtrivera↔#114 y vtputterie↔#117 (misma fecha) al revés:
--     la factura ASUR de $2,071.41 (op 180.22 + TUA 1,891.19, EXACTAMENTE la nota del Excel
--     "Op cun 180.22 tua 1891.19") vive en #117 (Riviera Charter, COMPLETADO); #114 (Putterie,
--     CANCELADO) no tiene operación en el Excel. Se retira el 'Op CUN 180.22' creado en #114 y
--     la factura de #117 recibe su aeropuerto.
-- (2) "Serv deli cun" (44.99 / 44.99 / 64.84): el Excel lo lista en OTROS pero en el sistema ese
--     importe viene EMBEBIDO en la factura ASUR de operación (225.88 = 180.89 + 44.99, etc.);
--     los tres gastos OTRO creados duplicaban el importe → se retiran y la factura queda anotada.
delete from gasto where id = 'bcb4ef95-8614-49c5-9fa5-f617c16b1b84'
  and monto = 180.22 and notas like '[CARGA-EXCEL-AGO28] Op CUN (Excel vtrivera)%';
update gasto set lugar = 'CUN', updated_at = now()
 where id = 'b750afe2-faa5-41e5-a708-6cec7100cc32' and lugar is null;

delete from gasto where id in ('31c4cd8e-fbd7-45b0-97d0-16671ecb97b4',
                               '2cc58a5d-f045-4666-b5c8-229ae224e833',
                               '7e8fc984-3db7-4f93-8049-e6b8713b68c4')
  and notas like '[CARGA-EXCEL-AGO28] Otros (Excel %Serv deli%';

update gasto g set notas = coalesce(g.notas,'') || ' · [CARGA-EXCEL-AGO28] incluye servicio deli $44.99 (el Excel lo lista en OTROS)', updated_at = now()
  from vuelo v where v.id = g.vuelo_id and v.folio = 132 and g.categoria = 'OPERACIONES' and g.monto = 225.88 and g.notas not like '%incluye servicio deli%';
update gasto g set notas = coalesce(g.notas,'') || ' · [CARGA-EXCEL-AGO28] incluye servicio deli $44.99 (el Excel lo lista en OTROS)', updated_at = now()
  from vuelo v where v.id = g.vuelo_id and v.folio = 146 and g.categoria = 'OPERACIONES' and g.monto = 953.90 and g.notas not like '%incluye servicio deli%';
update gasto g set notas = coalesce(g.notas,'') || ' · [CARGA-EXCEL-AGO28] incluye servicio deli $64.84 (el Excel lo lista en OTROS)', updated_at = now()
  from vuelo v where v.id = g.vuelo_id and v.folio = 159 and g.categoria = 'OPERACIONES' and g.monto = 602.45 and g.notas not like '%incluye servicio deli%';
