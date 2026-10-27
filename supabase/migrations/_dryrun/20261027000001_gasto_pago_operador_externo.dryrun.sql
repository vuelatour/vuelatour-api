-- =====================================================================
-- DRY-RUN de 20261027000001_gasto_pago_operador_externo.sql — NO ES UNA
-- MIGRACIÓN. Vive en `supabase/migrations/_dryrun/` (subcarpeta que el CLI
-- de Supabase NO recorre) para que ni `supabase db push` ni
-- `apply_migration` lo tomen.
--
-- Cómo correrlo: UNA sentencia por mcp__supabase__execute_sql (o pegado en el
-- SQL Editor) en el proyecto bjesduasnzbzywofukbf. Termina SIEMPRE en
-- `raise exception` ⇒ todo se revierte. Resultado esperado: el error
-- «DRYRUN_OK 20261027000001 · …». Cualquier otro error ⇒ NO aplicar.
--
-- Orden (regla del CLAUDE.md del workspace): cuerpo (DDL) → filas de prueba
-- DESPUÉS del DDL → pruebas con UPDATE REALES → DRYRUN_OK. Sin DROP, DELETE
-- ni REVOKE (el MCP los rechaza). Aquí las «filas de prueba» son filas
-- REALES de gasto (un gasto de vuelo externo, uno de vuelo propio y uno sin
-- vuelo) que se MODIFICAN y se revierten con el `raise exception`; `gasto`
-- no tiene constraint triggers diferidos (verificado 27-oct-2026).
-- =====================================================================

do $dry$
declare
  v_g_ext uuid;
  v_vuelo_ext uuid;
  v_g_propio uuid;
  v_vuelo_propio uuid;
  v_g_sin uuid;
  v_marca boolean;
  v_diff jsonb;
begin
  -- A) Precondición: la columna todavía NO existe (si ya existe, la migración
  --    es idempotente pero este dry-run no tiene sentido).
  if exists (
    select 1 from information_schema.columns
    where table_schema = 'public' and table_name = 'gasto'
      and column_name = 'es_pago_operador_externo'
  ) then
    raise exception 'DRYRUN_FALLA A: gasto.es_pago_operador_externo ya existe (¿migración ya aplicada?)';
  end if;

  -- B) >>> CUERPO de 20261027000001_gasto_pago_operador_externo.sql, tal cual
  alter table public.gasto
    add column if not exists es_pago_operador_externo boolean not null default false;

  comment on column public.gasto.es_pago_operador_externo is
    'Este gasto ES el pago al operador externo que cubrió el vuelo (20261027000001, API 0.0.110, invariante 110). true SOLO con vuelo_id de un vuelo es_externo (trigger trg_gasto_pago_operador_externo_con_vuelo). Los lectores (balance por avión / EXTERNOS / general, reporte por vuelo, reparto) toman los gastos marcados como el costo REAL del operador y dejan vuelo.costo_externo_* (lo cotizado) solo como nota: el costo no se suma dos veces aunque difiera del cotizado (IVA, otro T.C., pago en partes).';

  create index if not exists idx_gasto_es_pago_operador_externo
    on public.gasto (vuelo_id)
    where es_pago_operador_externo;

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

  if not exists (
    select 1 from pg_trigger
    where tgname = 'trg_gasto_pago_operador_externo_con_vuelo'
      and tgrelid = 'public.gasto'::regclass
  ) then
    raise exception 'DRYRUN_FALLA B: falta trg_gasto_pago_operador_externo_con_vuelo';
  end if;
  if position('es_pago_operador_externo' in pg_get_functiondef('public.tg_gasto_bitacora'::regproc)) = 0 then
    raise exception 'DRYRUN_FALLA B2: tg_gasto_bitacora no audita es_pago_operador_externo';
  end if;
  -- <<< CUERPO

  -- C) Filas de prueba (REALES, después del DDL; todo se revierte).
  select g.id, g.vuelo_id into v_g_ext, v_vuelo_ext
  from public.gasto g join public.vuelo v on v.id = g.vuelo_id
  where v.es_externo = true and g.escala_id is null
  order by g.created_at desc limit 1;
  if v_g_ext is null then
    raise exception 'DRYRUN_FALLA C1: no hay gasto de un vuelo externo para probar';
  end if;
  select g.id, g.vuelo_id into v_g_propio, v_vuelo_propio
  from public.gasto g join public.vuelo v on v.id = g.vuelo_id
  where v.es_externo = false and g.escala_id is null
  order by g.created_at desc limit 1;
  if v_g_propio is null then
    raise exception 'DRYRUN_FALLA C2: no hay gasto de un vuelo propio para probar';
  end if;
  select g.id into v_g_sin
  from public.gasto g
  where g.vuelo_id is null and g.escala_id is null
  order by g.created_at desc limit 1;
  if v_g_sin is null then
    raise exception 'DRYRUN_FALLA C3: no hay gasto sin vuelo para probar';
  end if;

  -- D) Pruebas con UPDATE REALES.
  -- D1) Gasto de un vuelo EXTERNO: la marca prende y la bitácora la registra.
  update public.gasto set es_pago_operador_externo = true where id = v_g_ext;
  select es_pago_operador_externo into v_marca from public.gasto where id = v_g_ext;
  if v_marca is distinct from true then
    raise exception 'DRYRUN_FALLA D1: la marca no prendió en el gasto % del vuelo externo %', v_g_ext, v_vuelo_ext;
  end if;
  select diff into v_diff
  from public.gasto_bitacora
  where gasto_id = v_g_ext and accion = 'UPDATE'
  order by created_at desc limit 1;
  if v_diff is null or not (v_diff ? 'es_pago_operador_externo') then
    raise exception 'DRYRUN_FALLA D1b: la bitácora no registró es_pago_operador_externo (diff = %)', v_diff;
  end if;
  if (v_diff -> 'es_pago_operador_externo' ->> 'despues') is distinct from 'true' then
    raise exception 'DRYRUN_FALLA D1c: la bitácora registró % en vez de true', v_diff -> 'es_pago_operador_externo';
  end if;

  -- D2) El gasto marcado pasa a un vuelo PROPIO: la marca se apaga en la
  --     misma escritura.
  update public.gasto set vuelo_id = v_vuelo_propio where id = v_g_ext;
  select es_pago_operador_externo into v_marca from public.gasto where id = v_g_ext;
  if v_marca is distinct from false then
    raise exception 'DRYRUN_FALLA D2: la marca siguió prendida al mover el gasto a un vuelo propio';
  end if;

  -- D3) Gasto de un vuelo PROPIO: la marca NO prende.
  update public.gasto set es_pago_operador_externo = true where id = v_g_propio;
  select es_pago_operador_externo into v_marca from public.gasto where id = v_g_propio;
  if v_marca is distinct from false then
    raise exception 'DRYRUN_FALLA D3: la marca prendió en un gasto de vuelo propio';
  end if;

  -- D4) Gasto SIN vuelo: la marca NO prende.
  update public.gasto set es_pago_operador_externo = true where id = v_g_sin;
  select es_pago_operador_externo into v_marca from public.gasto where id = v_g_sin;
  if v_marca is distinct from false then
    raise exception 'DRYRUN_FALLA D4: la marca prendió en un gasto sin vuelo';
  end if;

  -- D5) Un UPDATE que NO toca la marca ni el vuelo no la altera (otro trigger
  --     no la pisa): notas del gasto externo tras volver a marcarlo.
  update public.gasto set vuelo_id = v_vuelo_ext, es_pago_operador_externo = true where id = v_g_ext;
  update public.gasto set notas = coalesce(notas, '') || ' · dryrun' where id = v_g_ext;
  select es_pago_operador_externo into v_marca from public.gasto where id = v_g_ext;
  if v_marca is distinct from true then
    raise exception 'DRYRUN_FALLA D5: una edición ajena a la marca la apagó';
  end if;

  raise exception 'DRYRUN_OK 20261027000001 · columna, trigger y bitácora verificados con UPDATE reales (externo %, propio %, sin vuelo %); todo revertido',
    v_g_ext, v_g_propio, v_g_sin;
end $dry$;
