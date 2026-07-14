-- CHEQUE como método de cobro (pedido de Itzy, 14 jul 2026): pago bancario
-- facturable (IVA como transferencia); lo deposita/concilia la oficina — el
-- piloto NO cobra cheques (fuera de su whitelist).
alter type public.metodo_cobro add value if not exists 'CHEQUE';
