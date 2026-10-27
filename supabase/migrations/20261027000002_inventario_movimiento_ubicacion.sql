-- =====================================================================
-- 20261027000002_inventario_movimiento_ubicacion.sql — STOCK POR UBICACIÓN:
-- cada movimiento de cardex dice EN QUÉ BODEGA ocurrió y nace el TRASPASO
-- entre ubicaciones (27-oct-2026, API 0.0.111; invariante 111 del CLAUDE.md
-- del API).
--
-- PEDIDO DE LA OFICINA (27-oct-2026, captura de la ficha del filtro
-- CH48108): «tenemos filtros en Córner y aparte filtros en Toledo … muchos
-- de los productos se encuentran en diferentes lugares … una tablita … de
-- estos 200 aceites que hay, 100 se encuentran en Toledo, cinco en Mérida y
-- 95 en la bodega de Córner. Y entonces así ya sabemos en dónde hay todo».
--
-- MODELO (sin backfill): la existencia por ubicación se DERIVA del cardex,
-- igual que la existencia total. Un movimiento SIN ubicación cuenta en la
-- ubicación PRINCIPAL del producto (`inventario_item.ubicacion_id`) al
-- momento de leer; sin principal, en «Sin ubicación». Un TRASPASO resta en
-- `ubicacion_id` (origen; null = la principal) y suma en
-- `ubicacion_destino_id`; no mueve la existencia total ni el dinero.
--
-- QUÉ HACE (aditiva, idempotente; ninguna sentencia destructiva — ni en el
-- texto: el MCP de VS Code rechaza sin diálogo las que la nombran; por eso
-- las FK van SIN cláusula de borrado, como en 20261016000005):
--  1) Valor TRASPASO en el enum tipo_movimiento_inventario (al final).
--  2) inventario_movimiento.ubicacion_id y ubicacion_destino_id (uuid null,
--     FK a inventario_ubicacion; borrar una ubicación con movimientos ⇒
--     23503, como con los productos) + índices parciales.
--  3) CHECK inventario_movimiento_traspaso_chk: el destino SOLO vive en un
--     TRASPASO (y el destino nunca es el mismo origen). Compara `tipo::text`:
--     el valor nuevo del enum no se puede citar como enum en la misma
--     transacción que lo crea (55P04).
--  4) Verificación que aborta si algo no quedó.
--
-- LO QUE NO CAMBIA: las 96 filas existentes quedan con ubicación null (⇒
-- la principal del producto al leer), ningún número de existencia, costo ni
-- utilidad se mueve, ningún trigger se toca.
--
-- El API 0.0.111 lee y escribe las columnas SIN sonda: la migración va ANTES
-- del deploy del API (columnas aditivas y nulas: el API 0.0.110 las ignora;
-- un TRASPASO solo lo escribe el API nuevo).
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf):
--  a) DRY-RUN por mcp__supabase__execute_sql:
--     _dryrun/20261027000002_inventario_movimiento_ubicacion.dryrun.sql.
--     Debe terminar en ERROR «DRYRUN_OK 20261027000002 …». Otro error ⇒ NO
--     aplicar.
--  b) mcp__supabase__apply_migration name
--     «20261027000002_inventario_movimiento_ubicacion» y query = SOLO el
--     texto entre «>>> CUERPO» y «<<< CUERPO».
--  c) Postcheck por SELECT (al pie) y get_advisors.
-- PLAN B (si responde {"status":"declined"}): SQL Editor, en UNA corrida:
--   begin; <CUERPO>; insert into supabase_migrations.schema_migrations
--   (version, name, statements) values ('20261027000002',
--   'inventario_movimiento_ubicacion', array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261027000002_inventario_movimiento_ubicacion.sql'])
--   on conflict (version) do nothing; commit;
-- =====================================================================

-- >>> CUERPO
-- 1) El tipo TRASPASO ----------------------------------------------------------
alter type public.tipo_movimiento_inventario add value if not exists 'TRASPASO';

-- 2) Ubicación del movimiento y destino del traspaso ----------------------------
alter table public.inventario_movimiento
  add column if not exists ubicacion_id uuid null references public.inventario_ubicacion(id),
  add column if not exists ubicacion_destino_id uuid null references public.inventario_ubicacion(id);

comment on column public.inventario_movimiento.ubicacion_id is
  'Bodega donde ocurrió el movimiento (20261027000002, API 0.0.111, invariante 111). null = la ubicación PRINCIPAL del producto (inventario_item.ubicacion_id) al momento de leer; sin principal, «Sin ubicación». En un TRASPASO es el ORIGEN. La existencia por ubicación se deriva del cardex (API, fuente única inventario-cardex.util).';
comment on column public.inventario_movimiento.ubicacion_destino_id is
  'Solo en tipo TRASPASO: bodega que RECIBE las piezas (CHECK inventario_movimiento_traspaso_chk). Un traspaso no cambia la existencia total ni el dinero: solo reparte el stock entre ubicaciones.';

create index if not exists idx_inventario_movimiento_ubicacion
  on public.inventario_movimiento (ubicacion_id)
  where ubicacion_id is not null;
create index if not exists idx_inventario_movimiento_ubicacion_destino
  on public.inventario_movimiento (ubicacion_destino_id)
  where ubicacion_destino_id is not null;

-- 3) El destino solo vive en un TRASPASO --------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventario_movimiento_traspaso_chk'
      and conrelid = 'public.inventario_movimiento'::regclass
  ) then
    alter table public.inventario_movimiento
      add constraint inventario_movimiento_traspaso_chk check (
        (tipo::text <> 'TRASPASO' and ubicacion_destino_id is null)
        or (
          tipo::text = 'TRASPASO'
          and ubicacion_destino_id is not null
          and (ubicacion_id is null or ubicacion_id <> ubicacion_destino_id)
        )
      );
  end if;
end $$;

-- 4) Verificación ----------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid
    where t.typname = 'tipo_movimiento_inventario' and e.enumlabel = 'TRASPASO'
  ) then
    raise exception 'MIGRACION_FALLA: el enum no tiene TRASPASO';
  end if;
  if (
    select count(*) from information_schema.columns
    where table_schema = 'public' and table_name = 'inventario_movimiento'
      and column_name in ('ubicacion_id', 'ubicacion_destino_id')
  ) <> 2 then
    raise exception 'MIGRACION_FALLA: faltan columnas de ubicación en inventario_movimiento';
  end if;
  if not exists (
    select 1 from pg_constraint
    where conname = 'inventario_movimiento_traspaso_chk'
      and conrelid = 'public.inventario_movimiento'::regclass
  ) then
    raise exception 'MIGRACION_FALLA: falta inventario_movimiento_traspaso_chk';
  end if;
end $$;
-- <<< CUERPO

-- POSTCHECK (SELECT; esperado: TRASPASO al final del enum, 2 columnas nulas,
-- el CHECK y 0 movimientos con ubicación recién aplicada):
--   select e.enumlabel from pg_enum e join pg_type t on t.oid = e.enumtypid
--   where t.typname = 'tipo_movimiento_inventario' order by e.enumsortorder;
--   select count(*) from public.inventario_movimiento
--   where ubicacion_id is not null or ubicacion_destino_id is not null;
