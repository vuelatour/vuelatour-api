-- 2-sep-2026 · Método de pago PAYWISE para gastos (pedido del equipo).
-- Medio BANCARIO: sus cargos aparecen en el estado de cuenta → entra a la
-- conciliación automática y al criterio de "gastos sin banco", como
-- TARJETA_CORP y TRANSFERENCIA.
alter type medio_pago add value if not exists 'PAYWISE';
