-- Override POR DOCUMENTO del "crítico" del tipo: las reglas de la autoridad
-- cambian semana a semana y el equipo necesita ajustar un documento concreto
-- sin tocar el catálogo de tipos. null = hereda tipo_documento.es_critico.
alter table vencimiento add column if not exists critico boolean;

comment on column vencimiento.critico is
  'Override por documento de tipo_documento.es_critico (null = hereda). Un crítico VENCIDO pone el avión en rojo y alerta a administración; ya no bloquea asignar (política ago 2026).';
