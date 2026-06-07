-- Servicios de mantenimiento con ciclo de 3 estados + país (MX/USA),
-- según el diseño funcional: "Servicios como entidad con estados:
-- programado → en taller → completado. País (MX/USA)."
--
-- Additivo y compatible: se conserva la columna legada `tipo`
-- (PROGRAMADO/REALIZADO), que el servicio mantiene en sync con `estado`.

alter table public.mantenimiento
  add column if not exists estado varchar(12) not null default 'PROGRAMADO'
    check (estado in ('PROGRAMADO', 'EN_TALLER', 'COMPLETADO')),
  add column if not exists pais varchar(3)
    check (pais is null or pais in ('MX', 'USA'));

-- Backfill del nuevo `estado` a partir del campo legado `tipo`.
update public.mantenimiento
  set estado = case when tipo = 'REALIZADO' then 'COMPLETADO' else 'PROGRAMADO' end;

comment on column public.mantenimiento.estado is
  'Ciclo de servicio: PROGRAMADO -> EN_TALLER -> COMPLETADO';
comment on column public.mantenimiento.pais is
  'País del servicio (MX/USA); USA requiere tratamiento fiscal especial';
