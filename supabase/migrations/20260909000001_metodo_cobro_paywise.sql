-- 9-sep-2026 · PAYWISE como MÉTODO DE COBRO de primera clase (pedido del
-- cliente: «agregar la opción de Paywise para cobros»). Hasta hoy PAYWISE
-- solo existía en `medio_pago` (gastos, 2-sep-2026); los cobros por el link
-- de Paywise se registraban como HSBC_LINK/OTRO y no se podían auditar
-- contra el estado de cuenta de la pasarela.
--
-- Sola en su archivo A PROPÓSITO (igual que 20260902000001): un valor nuevo
-- de enum no puede usarse en la misma transacción que lo crea; la semilla y
-- las columnas de conciliación van en 20260909000002.
alter type public.metodo_cobro add value if not exists 'PAYWISE';
