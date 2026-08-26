-- Gasto PERSONAL del dueño (26-ago-2026): compras que hace el personal de
-- VuelaTour para el dueño — NO son de la empresa ni de los aviones, pero se
-- les da seguimiento en el sistema (pantalla "Gastos personales").
-- Reglas (candados en la API): siempre SIN vuelo y SIN avión; fuera de
-- balances, reparto (el trigger de gasto_reparto ya solo permite
-- OTRO/FIJO/INDIRECTO), Libro Dinero, tablero de gastos y pre-cierre.
-- Conciliación y caja chica SÍ lo ven: el dinero salió de verdad.
alter type public.categoria_gasto add value if not exists 'PERSONAL_DUENO';
