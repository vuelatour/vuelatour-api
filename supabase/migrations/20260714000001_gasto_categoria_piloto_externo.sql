-- Pago a piloto externo (freelance sin acceso al sistema, doc 3.7): su
-- honorario por vuelo se registra como gasto con categoría propia para que
-- reste en el reparto (DIRECTO) y se distinga en reportes.
alter type public.categoria_gasto add value if not exists 'PILOTO_EXTERNO';
