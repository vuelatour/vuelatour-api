-- Categoría unificada "Operaciones" para gastos de aeropuerto: agrupa lo que
-- antes eran Aterrizaje + FBO (y servicios de plataforma), porque suelen venir
-- en un mismo recibo. El desglose por concepto (aterrizaje/FBO/servicio) se
-- captura en las notas del gasto.
alter type public.categoria_gasto add value if not exists 'OPERACIONES';
