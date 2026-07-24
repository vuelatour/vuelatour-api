-- CLIENTE INTERNO (24 jul 2026): los pseudo-clientes "Vuelos de
-- reposicionamiento", "Demostracion" y "Servicio" son operación PROPIA de
-- VuelaTour — sus cotizaciones pueden ir en $0 total, 0 horas cotizadas (sin
-- hora mínima) y sin cobro esperado. La operación (tacos, gastos) se registra
-- normal y sus vuelos cuentan como COSTO del avión (filas "vtservicio" del
-- Excel del equipo). El motor de cotización, el pre-cierre y el balance por
-- avión leen esta bandera para no exigir tarifa ni regañar por cobranza.
--
-- NOTA: ya APLICADA en prod (bjesduasnzbzywofukbf) vía MCP — los 3 clientes ya
-- están marcados. Este archivo solo versiona el DDL (idempotente).
alter table cliente
  add column if not exists es_interno boolean not null default false;

comment on column cliente.es_interno is
  'Pseudo-cliente de operación PROPIA (reposicionamiento/demostración/servicio): cotización $0 válida sin hora mínima, sin cobro esperado; sus vuelos cuentan como costo del avión.';
