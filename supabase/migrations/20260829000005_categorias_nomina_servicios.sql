-- 29-ago-2026 · Categorías nuevas pedidas por el cliente:
--   NOMINA    → sueldos/nómina; en reportes se clasifica con los gastos
--               indirectos y es repartible entre aviones (como INDIRECTO).
--   SERVICIOS → servicios al avión (lavado, mantenimiento externo, etc.);
--               se asigna al avión directo, sin vuelo.
alter type categoria_gasto add value if not exists 'NOMINA';
alter type categoria_gasto add value if not exists 'SERVICIOS';
