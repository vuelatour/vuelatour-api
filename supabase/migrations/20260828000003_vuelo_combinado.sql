-- Vuelos COMBINADOS (28-ago, estrategia de pernocta aprovechada): el avión
-- que llevó pax el día D duerme en el destino y cubre al día siguiente el
-- vuelo de otro cliente que salía de ahí — se cancelan los dos ferries
-- (regreso de V1 e ida de V2) y ambos precios quedan INTACTOS: el margen es
-- de la empresa. La liga es simétrica (cada vuelo apunta al otro) y da la
-- trazabilidad del cierre ("por qué este vuelo no tiene ida/regreso").
alter table vuelo
  add column if not exists combinado_con_id uuid references public.vuelo(id) on delete set null;

comment on column vuelo.combinado_con_id is
  'Vuelo con el que se combinó (estrategia de pernocta): los ferries de ambos se cancelaron y un solo avión cubre los dos. Liga simétrica.';

create index if not exists idx_vuelo_combinado_con on vuelo (combinado_con_id)
  where combinado_con_id is not null;

-- Alerta del detector de oportunidades de combinación (barrido diario).
INSERT INTO alerta_config (clave, descripcion, canal, roles, dias_anticipacion, horas_anticipacion) VALUES
  ('combinacion_oportunidad', 'Oportunidad de combinar dos vuelos (un avión pernocta y cubre el regreso del otro): ahorra los ferries', 'ambos', ARRAY['ADMIN','COORDINADOR'], '{}', NULL)
ON CONFLICT (clave) DO NOTHING;
