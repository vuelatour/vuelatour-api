-- =====================================================================
-- 20261016000005_afac_real.sql — AFAC POR VUELO: RESERVADO vs COSTO REAL
-- (16-oct-2026, API 0.0.89; invariante 90 del CLAUDE.md del API).
--
-- PEDIDO DEL CLIENTE (16-oct-2026): «lo del AFAC … debe aparecer en balance
-- general en la hoja de Otros movimientos para poder confirmar el monto …
-- 2 columnas juntas, una que sea lo reservado de afac o cotizado y otra de lo
-- que realmente costó y que en esa celda poder poner el monto y se registre
-- sin tenerte que ir a otro lado».
-- Decisiones del 16-oct-2026: filas UNA POR VUELO; el costo real es EGRESO
-- DE VUELATOUR (el avión sigue pagando lo reservado); se escribe SOLO el
-- monto del vuelo (no crea gasto); los gastos que son PAGO DE AFAC se marcan
-- y dejan de restarle al avión (supersede, solo para los marcados, la
-- decisión del 14-oct-2026 «el AFAC lo cargan al Avión»).
--
-- QUÉ HACE (aditiva, idempotente; ninguna sentencia destructiva — ni en el
-- texto: el MCP de VS Code rechaza sin diálogo las que la nombran):
--  1) gasto.es_pago_afac boolean NOT NULL DEFAULT false + índice parcial.
--     Todas las filas existentes quedan en false ⇒ ningún número cambia.
--  2) Trigger BEFORE INSERT / UPDATE OF es_pago_afac, categoria: la marca
--     SOLO vive en categoría PERMISO (`categoria::text`, ENUM). Un gasto que
--     deja de ser PERMISO pierde la marca en la MISMA escritura.
--  3) tg_gasto_bitacora: la lista de columnas auditadas gana 'es_pago_afac'
--     (el resto de la función, TAL CUAL la de prod al 16-oct-2026).
--  4) public.afac_vuelo (PK vuelo_id → vuelo, FK SIN cláusula de borrado:
--     el dinero no se va en cascada): costo_real_mxn numeric(14,2) NULL
--     (null = sin capturar; «quitar» es UPDATE a null, nunca un borrado),
--     notas, quién/cuándo capturó el valor vigente, created/updated. RLS sin
--     policies (la API usa la service key). Trigger de updated_at.
--  5) public.afac_vuelo_bitacora (sin FK a vuelo: jamás estorba) + trigger
--     AFTER INSERT OR UPDATE: ALTA / CAMBIO / QUITADO con antes/después.
--  6) Verificación que aborta si algo no quedó.
--
-- DEPENDE de gasto, vuelo, usuario, gasto_bitacora, tg_set_updated_at.
-- El API 0.0.89 sondea gasto.es_pago_afac (common/afac-real-disponible.util):
-- sin la columna se comporta como 0.0.88 en todo lo que toca la marca y el
-- costo real (las filas AFAC por vuelo salen sin costo real, no editables).
-- Con la migración y el API 0.0.88 no cambia nada (columna en false, tablas
-- vacías que nadie lee).
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar con un SELECT):
--  a) DRY-RUN por mcp__supabase__execute_sql: dryrun-mcp.sql. Debe terminar
--     en ERROR «DRYRUN_OK 20261016000005 …». Cualquier otro error ⇒ NO aplicar.
--  b) mcp__supabase__apply_migration name «20261016000005_afac_real» y query =
--     SOLO el texto entre «>>> CUERPO» y «<<< CUERPO».
--  c) Postcheck por SELECT (postcheck al pie) y get_advisors (esperado: el
--     INFO «RLS sin policies» de siempre, ahora también afac_vuelo y
--     afac_vuelo_bitacora).
-- PLAN B (si responde {"status":"declined"}): SQL Editor, en UNA corrida:
--   begin; <CUERPO>; insert into supabase_migrations.schema_migrations
--   (version, name, statements) values ('20261016000005', 'afac_real',
--   array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261016000005_afac_real.sql'])
--   on conflict (version) do nothing; commit;
-- =====================================================================

-- >>> CUERPO
-- 1) La marca «Pago de AFAC» del gasto -------------------------------------
alter table public.gasto
  add column if not exists es_pago_afac boolean not null default false;

comment on column public.gasto.es_pago_afac is
  'Pago de AFAC que paga VuelaTour (20261016000005, API 0.0.89, invariante 90). true SOLO en categoría PERMISO (trigger trg_gasto_pago_afac_solo_permiso). Un gasto marcado NO resta en ningún avión (hoja permisos, cascada, reparto, Libro Dinero por avión, tableros por avión) ni en «otros gastos» del general: es el comprobante bancario de los costos reales AFAC capturados por vuelo (afac_vuelo) y aparece en la sección AFAC de «otros movimientos» del Balance general.';

create index if not exists idx_gasto_es_pago_afac
  on public.gasto (fecha_gasto)
  where es_pago_afac;

-- 2) La marca solo vive en PERMISO -----------------------------------------
create or replace function public.tg_gasto_pago_afac_solo_permiso()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
begin
  -- `categoria` es ENUM (public.categoria_gasto): se compara como texto.
  if new.es_pago_afac is true and new.categoria::text <> 'PERMISO' then
    new.es_pago_afac := false;
  end if;
  return new;
end;
$function$;

create or replace trigger trg_gasto_pago_afac_solo_permiso
  before insert or update of es_pago_afac, categoria on public.gasto
  for each row execute function public.tg_gasto_pago_afac_solo_permiso();

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
    'folio_ticket','conciliado','tua_incluida','es_pago_afac'
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

-- 4) Costo real AFAC por vuelo ---------------------------------------------
create table if not exists public.afac_vuelo (
  vuelo_id uuid primary key references public.vuelo (id),
  costo_real_mxn numeric(14,2) null,
  notas text null,
  capturado_por uuid null references public.usuario (id),
  capturado_at timestamptz null,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  updated_by uuid null references public.usuario (id),
  constraint afac_vuelo_costo_no_negativo_chk
    check (costo_real_mxn is null or costo_real_mxn >= 0),
  constraint afac_vuelo_notas_largo_chk
    check (notas is null or char_length(notas) <= 500)
);

comment on table public.afac_vuelo is
  'Costo REAL del AFAC de un vuelo, en pesos (20261016000005, API 0.0.89, invariante 90): lo que VuelaTour pagó a AFAC por ese vuelo. Es EGRESO de VuelaTour en «otros movimientos» del Balance general (el avión sigue pagando lo reservado = columna PERMISO AFAC (PROVISIÓN)). costo_real_mxn null = sin capturar (quitar = UPDATE a null). No crea gasto: el pago al gestor se captura en Gastos y se marca es_pago_afac.';

alter table public.afac_vuelo enable row level security;

create or replace trigger trg_afac_vuelo_set_updated_at
  before update on public.afac_vuelo
  for each row execute function public.tg_set_updated_at();

-- 5) Bitácora del costo real ----------------------------------------------
create table if not exists public.afac_vuelo_bitacora (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null,
  accion text not null,
  costo_antes numeric(14,2) null,
  costo_despues numeric(14,2) null,
  notas_antes text null,
  notas_despues text null,
  actor_id uuid null,
  created_at timestamptz not null default now(),
  constraint afac_vuelo_bitacora_accion_chk
    check (accion in ('ALTA', 'CAMBIO', 'QUITADO'))
);

comment on table public.afac_vuelo_bitacora is
  'Bitácora forense de afac_vuelo (20261016000005): ALTA / CAMBIO / QUITADO con antes y después y quién. Sin FK a vuelo a propósito (nunca estorba). La escribe SOLO el trigger trg_afac_vuelo_bitacora.';

create index if not exists idx_afac_vuelo_bitacora_vuelo
  on public.afac_vuelo_bitacora (vuelo_id, created_at);

alter table public.afac_vuelo_bitacora enable row level security;

create or replace function public.tg_afac_vuelo_bitacora()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  v_accion text;
begin
  if tg_op = 'INSERT' then
    if new.costo_real_mxn is null and new.notas is null then
      return new;
    end if;
    insert into public.afac_vuelo_bitacora
      (vuelo_id, accion, costo_antes, costo_despues, notas_antes, notas_despues, actor_id)
    values
      (new.vuelo_id, 'ALTA', null, new.costo_real_mxn, null, new.notas,
       coalesce(new.updated_by, new.capturado_por));
    return new;
  end if;
  if old.costo_real_mxn is not distinct from new.costo_real_mxn
     and old.notas is not distinct from new.notas then
    return new;
  end if;
  v_accion := case
    when new.costo_real_mxn is null and old.costo_real_mxn is not null then 'QUITADO'
    when old.costo_real_mxn is null and new.costo_real_mxn is not null then 'ALTA'
    else 'CAMBIO'
  end;
  insert into public.afac_vuelo_bitacora
    (vuelo_id, accion, costo_antes, costo_despues, notas_antes, notas_despues, actor_id)
  values
    (new.vuelo_id, v_accion, old.costo_real_mxn, new.costo_real_mxn, old.notas, new.notas,
     new.updated_by);
  return new;
end;
$function$;

create or replace trigger trg_afac_vuelo_bitacora
  after insert or update on public.afac_vuelo
  for each row execute function public.tg_afac_vuelo_bitacora();

-- 6) Verificación ---------------------------------------------------------
do $verif$
begin
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'gasto'
                    and column_name = 'es_pago_afac' and is_nullable = 'NO') then
    raise exception 'VERIFICACION 20261016000005: falta gasto.es_pago_afac NOT NULL';
  end if;
  if to_regclass('public.afac_vuelo') is null
     or to_regclass('public.afac_vuelo_bitacora') is null then
    raise exception 'VERIFICACION 20261016000005: faltan las tablas afac_vuelo / afac_vuelo_bitacora';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.gasto'::regclass
                    and tgname = 'trg_gasto_pago_afac_solo_permiso') then
    raise exception 'VERIFICACION 20261016000005: falta trg_gasto_pago_afac_solo_permiso';
  end if;
  if not exists (select 1 from pg_trigger
                  where tgrelid = 'public.afac_vuelo'::regclass
                    and tgname = 'trg_afac_vuelo_bitacora') then
    raise exception 'VERIFICACION 20261016000005: falta trg_afac_vuelo_bitacora';
  end if;
  if position('es_pago_afac' in pg_get_functiondef('public.tg_gasto_bitacora()'::regprocedure)) = 0 then
    raise exception 'VERIFICACION 20261016000005: tg_gasto_bitacora no audita es_pago_afac';
  end if;
  if not (select relrowsecurity from pg_class where oid = 'public.afac_vuelo'::regclass)
     or not (select relrowsecurity from pg_class where oid = 'public.afac_vuelo_bitacora'::regclass) then
    raise exception 'VERIFICACION 20261016000005: RLS apagado en afac_vuelo / afac_vuelo_bitacora';
  end if;
end
$verif$;
-- <<< CUERPO

-- POSTCHECK (SELECT por MCP):
--   select column_name, is_nullable, column_default from information_schema.columns
--    where table_schema='public' and table_name='gasto' and column_name='es_pago_afac';
--   select count(*) filter (where es_pago_afac) as marcados, count(*) from public.gasto;   -- 0 marcados
--   select count(*) from public.afac_vuelo; select count(*) from public.afac_vuelo_bitacora; -- 0 y 0
--   select tgname from pg_trigger where tgrelid in ('public.gasto'::regclass,'public.afac_vuelo'::regclass) and not tgisinternal order by 1;
--   select relname, relrowsecurity from pg_class where relname in ('afac_vuelo','afac_vuelo_bitacora');
--   select position('es_pago_afac' in pg_get_functiondef('public.tg_gasto_bitacora()'::regprocedure)) > 0 as audita;
--
-- REVERSA (solo desde el SQL Editor, solo si nadie capturó costos reales ni
-- marcó gastos; el API 0.0.89 debe bajar a 0.0.88 ANTES y reiniciarse
-- después: la sonda memoriza el «sí»). Está en reversa-20261016000005.sql
-- (fuera de este archivo para que el MCP no lo rechace).
