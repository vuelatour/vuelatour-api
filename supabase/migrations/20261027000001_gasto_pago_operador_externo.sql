-- =====================================================================
-- 20261027000001_gasto_pago_operador_externo.sql — EL PAGO AL OPERADOR
-- EXTERNO SE MARCA EN EL GASTO (27-oct-2026, API 0.0.110; invariante 110
-- del CLAUDE.md del API).
--
-- CASO REAL (#453, oscar02-251026, Simon Herrera, 25-oct-2026): la oficina
-- cotizó «lo que cobra el operador» en $840 USD; al pagarle, Simon cobró
-- 840 + IVA al T.C. del día = $18,182.00 MXN, capturado como gasto
-- OPERACIONES del vuelo. La regla de la invariante 88 (el gasto que COINCIDE
-- ±1 % con el costo cotizado ES el pago) no lo reconoció (17 % arriba) y el
-- Balance general sumó los dos en OPERACIONES: $18,182.00 + «Costo operador
-- externo (Simon Herrera) — $15,530.59» = $33,712.59. Pedido de la oficina:
-- «que lo que yo ponga en la cotización sea informativo … y que tome nada
-- más de referencia el gasto que puso Ale».
--
-- QUÉ HACE (aditiva, idempotente; ninguna sentencia destructiva — ni en el
-- texto: el MCP de VS Code rechaza sin diálogo las que la nombran):
--  1) gasto.es_pago_operador_externo boolean NOT NULL DEFAULT false + índice
--     parcial por vuelo. Todas las filas existentes quedan en false ⇒ ningún
--     número cambia al aplicarla.
--  2) Trigger BEFORE INSERT / UPDATE OF es_pago_operador_externo, vuelo_id:
--     la marca SOLO vive en un gasto CON vuelo y ese vuelo cubierto por
--     externo (vuelo.es_externo). Un gasto que pierde el vuelo o pasa a un
--     vuelo propio pierde la marca en la MISMA escritura.
--  3) tg_gasto_bitacora: la lista de columnas auditadas gana
--     'es_pago_operador_externo' (el resto de la función, TAL CUAL la de
--     prod al 27-oct-2026).
--  4) Verificación que aborta si algo no quedó.
--
-- DEPENDE de gasto, vuelo, gasto_bitacora.
-- El API 0.0.110 lee y escribe la columna SIN sonda: la migración va ANTES
-- del deploy del API (columna aditiva con default: el API 0.0.109 la ignora).
-- Con la migración y el API 0.0.109 no cambia nada (todo en false).
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar con un SELECT):
--  a) DRY-RUN por mcp__supabase__execute_sql:
--     _dryrun/20261027000001_gasto_pago_operador_externo.dryrun.sql. Debe
--     terminar en ERROR «DRYRUN_OK 20261027000001 …». Otro error ⇒ NO aplicar.
--  b) mcp__supabase__apply_migration name «20261027000001_gasto_pago_operador_externo»
--     y query = SOLO el texto entre «>>> CUERPO» y «<<< CUERPO».
--  c) Postcheck por SELECT (al pie) y get_advisors (sin avisos nuevos).
-- PLAN B (si responde {"status":"declined"}): SQL Editor, en UNA corrida:
--   begin; <CUERPO>; insert into supabase_migrations.schema_migrations
--   (version, name, statements) values ('20261027000001',
--   'gasto_pago_operador_externo', array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261027000001_gasto_pago_operador_externo.sql'])
--   on conflict (version) do nothing; commit;
-- =====================================================================

-- >>> CUERPO
-- 1) La marca «es el pago al operador externo» del gasto -------------------
alter table public.gasto
  add column if not exists es_pago_operador_externo boolean not null default false;

comment on column public.gasto.es_pago_operador_externo is
  'Este gasto ES el pago al operador externo que cubrió el vuelo (20261027000001, API 0.0.110, invariante 110). true SOLO con vuelo_id de un vuelo es_externo (trigger trg_gasto_pago_operador_externo_con_vuelo). Los lectores (balance por avión / EXTERNOS / general, reporte por vuelo, reparto) toman los gastos marcados como el costo REAL del operador y dejan vuelo.costo_externo_* (lo cotizado) solo como nota: el costo no se suma dos veces aunque difiera del cotizado (IVA, otro T.C., pago en partes).';

create index if not exists idx_gasto_es_pago_operador_externo
  on public.gasto (vuelo_id)
  where es_pago_operador_externo;

-- 2) La marca solo vive con un vuelo cubierto por externo -------------------
create or replace function public.tg_gasto_pago_operador_externo_con_vuelo()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  v_externo boolean;
begin
  if new.es_pago_operador_externo is true then
    if new.vuelo_id is null then
      new.es_pago_operador_externo := false;
    else
      select v.es_externo into v_externo
      from public.vuelo v
      where v.id = new.vuelo_id;
      if v_externo is distinct from true then
        new.es_pago_operador_externo := false;
      end if;
    end if;
  end if;
  return new;
end;
$function$;

create or replace trigger trg_gasto_pago_operador_externo_con_vuelo
  before insert or update of es_pago_operador_externo, vuelo_id on public.gasto
  for each row execute function public.tg_gasto_pago_operador_externo_con_vuelo();

-- 3) La bitácora del gasto registra la marca --------------------------------
create or replace function public.tg_gasto_bitacora()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  cols text[] := array[
    'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
    'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
    'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
    'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
    'folio_ticket','conciliado','tua_incluida','es_pago_afac','por_pagar',
    'cuenta_bancaria_id','es_pago_operador_externo'
  ];
  v_diff jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
  c text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    foreach c in array cols loop
      if v_new->c is not null and v_new->c <> 'null'::jsonb then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
      end if;
    end loop;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, new.vuelo_id, 'INSERT', new.created_by, v_diff);
    return new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    foreach c in array cols loop
      if v_old->c is distinct from v_new->c then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      return new;
    end if;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
    return new;
  else
    -- Baja del gasto: tg_op vale el mismo texto de siempre.
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
    values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
    return old;
  end if;
end
$function$;

-- 4) Verificación ----------------------------------------------------------
do $$
begin
  if not exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gasto'
      and column_name = 'es_pago_operador_externo'
  ) then
    raise exception 'MIGRACION_FALLA: falta gasto.es_pago_operador_externo';
  end if;
  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_gasto_pago_operador_externo_con_vuelo'
      and tgrelid = 'public.gasto'::regclass
  ) then
    raise exception 'MIGRACION_FALLA: falta trg_gasto_pago_operador_externo_con_vuelo';
  end if;
  if position('es_pago_operador_externo' in pg_get_functiondef('public.tg_gasto_bitacora'::regproc)) = 0 then
    raise exception 'MIGRACION_FALLA: tg_gasto_bitacora no audita es_pago_operador_externo';
  end if;
end $$;
-- <<< CUERPO

-- POSTCHECK (SELECT; esperado: columna boolean NOT NULL default false, el
-- trigger y 0 filas marcadas recién aplicada):
--   select column_name, data_type, is_nullable, column_default
--   from information_schema.columns
--   where table_name = 'gasto' and column_name = 'es_pago_operador_externo';
--   select count(*) from public.gasto where es_pago_operador_externo;
