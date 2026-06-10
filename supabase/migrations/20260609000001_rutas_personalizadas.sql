-- Rutas siempre personalizadas (por tramos).
--
-- Decisión operativa: desaparecen los conceptos de "redondo automático" y el tipo
-- SIMPLE en el catálogo. Quien gestiona rutas arma SIEMPRE el itinerario tramo por
-- tramo (incluido el regreso, si aplica). Las rutas SIMPLE existentes se desactivan
-- y se recrean a mano (decisión del usuario: catálogo limpio, sin conversión).
--
-- No hay cambio de esquema: las columnas tipo/es_redondo_auto se conservan por
-- compatibilidad con vuelos históricos que las referencian.

update public.ruta_predefinida
set activa = false
where tipo = 'SIMPLE' and activa = true;
