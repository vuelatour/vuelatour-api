-- Rol VISITANTE (27-ago, aprobado): visitantes de trabajo (fondo en
-- efectivo + tarjeta corporativa) que SOLO registran gastos desde la app —
-- cero acceso a vuelos. Sus gastos usan la categoría dedicada VISITA
-- (patrón GASOLINA: sin vuelo/avión, visible en Otros gastos, repartible,
-- fuera de pendientes) y origen 'VISITANTE' como distintivo.
alter type public.rol_usuario add value if not exists 'VISITANTE';
alter type public.categoria_gasto add value if not exists 'VISITA';

-- origen del gasto: quién lo subió (CHECK existente solo admitía 4 valores)
alter table gasto drop constraint if exists gasto_origen_chk;
alter table gasto add constraint gasto_origen_chk
  check (origen is null or origen in ('PILOTO','MECANICO','OFICINA','SISTEMA','VISITANTE'));
