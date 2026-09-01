-- 1-sep-2026 · Permiso temporal por usuario: hasta este instante el usuario
-- de campo edita/captura SUS gastos sin el candado semanal ni el de
-- reposición de caja chica (dueño y conciliado-con-banco SIGUEN).
-- Caso que lo originó: Luis Cáceres, un día para corregir lo mal subido.
-- Se otorga poniendo la fecha (SQL u oficina) y expira solo.
alter table usuario add column if not exists gastos_sin_limite_hasta timestamptz null;
comment on column usuario.gastos_sin_limite_hasta is
  'Permiso temporal: hasta este instante el usuario de campo edita/captura sus gastos SIN el candado semanal ni el de reposición (dueño y conciliado siguen). null = regla normal.';
