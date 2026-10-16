-- =====================================================================
-- 20261016000001_cobro_factura_emitida.sql — FACTURAS POR COBRO: QUÉ FACTURA
-- AMPARA CADA COBRO (16-oct-2026, pedido del cliente con la captura del vuelo
-- #332; API 0.0.82; invariante 84 del CLAUDE.md del API).
--
-- PEDIDO: «necesitamos poder cargar en un vuelo varias facturas y poder
-- vincularlas, porque a veces unos pagos son con una factura y otro con otra».
-- Hoy la relación es factura ⟷ VUELO (factura_emitida_vuelo, N:M) y basta UNA
-- vigente para que el vuelo quede «facturado»: #332 tiene A-0420 (68,208 MXN =
-- exactamente uno de sus 4 cobros) y los otros 3 cobros (4,377.45 MXN) no tienen
-- factura sin que nadie lo sepa.
--
-- QUÉ HACE (aditiva, idempotente, sin ninguna sentencia destructiva de las que
-- el MCP de Supabase declina; ninguna de esas palabras aparece en el archivo):
--  1) cobro_vuelo.factura_emitida_id uuid NULL, FK a factura_emitida con
--     «on delete set null» (único «delete» del archivo; cláusula de FK, ya
--     aceptada por el MCP el 15-oct), COMMENT e índice parcial
--     idx_cobro_vuelo_factura_emitida. Es CLASIFICACIÓN: no toca cobrosEnUsd,
--     reparto, balance, candado de conciliación ni vuelo.cobrado.
--  2) Trigger A tg_cobro_vuelo_factura_coherente (BEFORE INSERT OR UPDATE OF
--     factura_emitida_id): al ligar, la factura existe, no está dada de baja,
--     es VIGENTE y está ligada (puente) al MISMO vuelo del cobro — sin
--     excepción de grupo —; nunca un reembolso (monto <= 0) ni una parte de
--     sobre (cobro_grupo_id). 23514, hint = CODIGO, detail jsonb, en este
--     orden: REEMBOLSO_SIN_FACTURA, COBRO_DE_GRUPO, FACTURA_NO_VIGENTE,
--     FACTURA_NO_LIGADA_AL_VUELO (espejo del API validarFacturaParaCobro).
--     NO escucha vuelo_id (reassignAircraft).
--  3) Trigger B tg_factura_emitida_suelta_cobros (AFTER UPDATE OF estatus,
--     deleted_at): al CANCELAR o dar de BAJA la factura, sus cobros quedan con
--     factura_emitida_id = null. Reactivar NO re-liga.
--  4) BACKFILL determinista (solo UPDATE, pasa por el trigger A): por factura
--     VIGENTE, cobros positivos sin sobre de sus vuelos ligados en su moneda
--     (::text), tolerancia 1.00: Σ = total ⇒ todos (B_SUMA); si no, un solo
--     vuelo y EXACTAMENTE UN cobro = total ⇒ ese (A_EXACTO); si no, nada.
--     Prod 16-oct-2026 (SELECT de la regla): 44 cobros en 37 facturas
--     (B_SUMA 35/42, A_EXACTO 2/2: A-0420 → 68,208 de #332, FA-A-0434 →
--     38,589 de #364); 7 sin liga (A-0415, A-0430, A-0440, FA-A-0412,
--     FA-A-0413, FA-A-0433, FA-A-0449) y 2 sin cobros en su moneda
--     (FA-A-0393, FA-A-0438). Las cifras son del 16-oct: el día del apply se
--     comparan contra el MISMO SELECT (postchecks.sql), no contra el 44.
--  5) Verificación que aborta si algo no quedó (objetos + coherencia de lo
--     ligado).
--
-- IDEMPOTENCIA SIN BORRAR OBJETOS: «add column if not exists», «create index if not
-- exists», «create or replace function» y «create or replace trigger»
-- (PostgreSQL 17.6 en prod). Re-aplicar no re-liga nada (el backfill solo
-- toca cobros con factura_emitida_id null que cuadren con la regla).
--
-- PERFIL DE LAS FUNCIONES (decisión 16-oct, gana la regla del MCP sobre el
-- contrato): SECURITY INVOKER + search_path vacío, como tg_set_updated_at y
-- tg_mov_bancario_reverso. Escribe solo la service key (RLS sin policies en
-- las tres tablas) y una función de trigger no se invoca por RPC; así no hace
-- falta retirar EXECUTE a anon/authenticated (esa sentencia el MCP la declina).
--
-- `moneda` es ENUM en cobro_vuelo y factura_emitida: en plpgsql y en el
-- backfill se compara SIEMPRE `::text` (incidente 15-sep-2026). El trigger A
-- no compara monedas.
--
-- DEPENDE de 20260924000003 (factura_emitida + puente), 20261012000002 y
-- 20261014000003 (puente de abonos; el trigger E solo escucha dinero, por eso
-- cambiar factura_emitida_id de un cobro conciliado pasa). El API 0.0.82 es
-- desplegable ANTES o DESPUÉS (sonda common/cobro-factura-disponible.util:
-- sin la columna, ligar ⇒ 503 COBRO_FACTURA_NO_DISPONIBLE y las lecturas no
-- llevan la llave). OJO: el «sí» de la sonda se memoriza — tras un ROLLBACK
-- hay que reiniciar el API.
--
-- CÓMO APLICAR (proyecto bjesduasnzbzywofukbf; confirmar el proyecto con un
-- SELECT antes):
--  a) DRY-RUN con mcp__supabase__execute_sql: el bloque «do $dry$ … $dry$;»
--     del archivo dryrun-mcp.sql del paquete (copia comentada al pie de este
--     archivo). Debe terminar en ERROR «DRYRUN_OK 20261016000001 …» (todo se
--     revierte, DDL incluido). Cualquier otro error ⇒ NO aplicar.
--  b) mcp__supabase__apply_migration con name «20261016000001_cobro_factura_emitida»
--     y query = SOLO el cuerpo entre «>>> CUERPO» y «<<< CUERPO».
--  c) postchecks.sql por execute_sql (SELECTs + «POSTCHECK_OK»), luego
--     get_advisors (esperado: solo el INFO «RLS sin policies» de siempre).
--
-- PLAN B (si a) o b) responden {"status":"declined"}), SQL Editor del proyecto:
--  B1) Pegar el DRY-RUN y ejecutar: debe terminar en «DRYRUN_OK …».
--  B2) En UNA corrida:
--        begin;
--        <el CUERPO entre «>>> CUERPO» y «<<< CUERPO», tal cual>
--        insert into supabase_migrations.schema_migrations (version, name, statements)
--        values ('20261016000001', 'cobro_factura_emitida',
--                array['-- aplicada desde el SQL Editor: ver supabase/migrations/20261016000001_cobro_factura_emitida.sql'])
--        on conflict (version) do nothing;
--        commit;
--  B3) postchecks.sql por MCP y get_advisors.
--
-- ROLLBACK (SOLO desde el SQL Editor; reiniciar el API después):
--   1) update public.cobro_vuelo set factura_emitida_id = null
--       where factura_emitida_id is not null;   -- (antes exportar id, factura_emitida_id)
--   2) retirar, con la sentencia de borrado de objetos que este archivo no
--      escribe (el MCP la rechaza incluso en comentarios), en este orden: el
--      trigger trg_cobro_vuelo_factura_coherente de cobro_vuelo, el trigger
--      trg_factura_emitida_suelta_cobros de factura_emitida, las funciones
--      tg_cobro_vuelo_factura_coherente() y tg_factura_emitida_suelta_cobros(),
--      el índice idx_cobro_vuelo_factura_emitida y la columna
--      cobro_vuelo.factura_emitida_id (la FK y el COMMENT se van con ella).
-- =====================================================================

-- >>> CUERPO
-- ===========================================================================
-- 1) COLUMNA cobro_vuelo.factura_emitida_id — CLASIFICACIÓN, no dinero
-- ===========================================================================
alter table public.cobro_vuelo
  add column if not exists factura_emitida_id uuid null
  references public.factura_emitida(id) on delete set null;

comment on column public.cobro_vuelo.factura_emitida_id is
  'Factura emitida (registro manual, 20260924000003) que AMPARA este cobro. CLASIFICACIÓN, no dinero: no entra a cobrosEnUsd, reparto ni balance. Solo una factura VIGENTE, no dada de baja y ligada (factura_emitida_vuelo) al MISMO vuelo del cobro (trigger A, sin excepción de grupo); nunca en reembolsos (monto <= 0) ni en partes de sobre (cobro_grupo_id). Al cancelar o dar de baja la factura se suelta (null, trigger B) y reactivar NO re-liga. 20261016000001.';

create index if not exists idx_cobro_vuelo_factura_emitida
  on public.cobro_vuelo (factura_emitida_id)
  where factura_emitida_id is not null;

-- ===========================================================================
-- 2) TRIGGER A — coherencia al ligar un cobro con su factura (cobro_vuelo)
--    BEFORE INSERT OR UPDATE OF factura_emitida_id. NO escucha vuelo_id
--    (reassignAircraft mueve cobros y ligas al clon en dos UPDATE: el orden
--    entre ambos no debe importar). Errores 23514 con message «CODIGO: …»,
--    hint = CODIGO y detail = jsonb::text, en ESTE orden (espejo del API
--    validarFacturaParaCobro): REEMBOLSO_SIN_FACTURA, COBRO_DE_GRUPO,
--    FACTURA_NO_VIGENTE, FACTURA_NO_LIGADA_AL_VUELO.
--    Perfil: SECURITY INVOKER + search_path vacío (como tg_set_updated_at):
--    la escribe solo la service key (RLS sin policies) y una función de
--    trigger no se invoca por RPC; así no hace falta retirar EXECUTE (el MCP
--    rechaza esa sentencia).
-- ===========================================================================
create or replace function public.tg_cobro_vuelo_factura_coherente()
returns trigger
language plpgsql
set search_path = ''
as $fn_cobro_factura$
declare
  v_f record;
  v_folio bigint;
begin
  if new.factura_emitida_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE' and new.factura_emitida_id is not distinct from old.factura_emitida_id then
    return new;
  end if;

  if new.monto <= 0 then
    raise exception using
      errcode = '23514',
      hint = 'REEMBOLSO_SIN_FACTURA',
      message = 'REEMBOLSO_SIN_FACTURA: un reembolso no se liga a una factura',
      detail = jsonb_build_object('cobro_id', new.id)::text;
  end if;

  if new.cobro_grupo_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_DE_GRUPO',
      message = 'COBRO_DE_GRUPO: la parte de un sobre de grupo no lleva factura por vuelo',
      detail = jsonb_build_object('cobro_id', new.id, 'cobro_grupo_id', new.cobro_grupo_id)::text;
  end if;

  -- FOR SHARE: una cancelación/baja concurrente (UPDATE de la factura) espera
  -- o ya se ve; nunca queda un cobro ligado a una factura que dejó de ser vigente.
  select f.id, f.serie, f.folio, f.estatus, f.deleted_at
    into v_f
    from public.factura_emitida f
   where f.id = new.factura_emitida_id
     for share;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'FACTURA_NO_VIGENTE',
      message = format('FACTURA_NO_VIGENTE: la factura %s no existe', new.factura_emitida_id),
      detail = jsonb_build_object('factura_id', new.factura_emitida_id, 'estatus', null, 'borrada', null)::text;
  end if;
  if v_f.deleted_at is not null or v_f.estatus <> 'VIGENTE' then
    raise exception using
      errcode = '23514',
      hint = 'FACTURA_NO_VIGENTE',
      message = format('FACTURA_NO_VIGENTE: la factura %s ya no está vigente (%s)',
                       concat_ws('-', v_f.serie, v_f.folio),
                       case when v_f.deleted_at is not null then 'dada de baja' else lower(v_f.estatus) end),
      detail = jsonb_build_object('factura_id', v_f.id, 'estatus', v_f.estatus,
                                  'borrada', v_f.deleted_at is not null)::text;
  end if;

  if not exists (select 1
                   from public.factura_emitida_vuelo fv
                  where fv.factura_id = new.factura_emitida_id
                    and fv.vuelo_id = new.vuelo_id) then
    select v.folio into v_folio from public.vuelo v where v.id = new.vuelo_id;
    raise exception using
      errcode = '23514',
      hint = 'FACTURA_NO_LIGADA_AL_VUELO',
      message = format('FACTURA_NO_LIGADA_AL_VUELO: la factura %s no está ligada al vuelo #%s; agrégale el vuelo en Facturas emitidas → Editar → Vuelos',
                       concat_ws('-', v_f.serie, v_f.folio), coalesce(v_folio::text, '?')),
      detail = jsonb_build_object('factura_id', v_f.id, 'vuelo_id', new.vuelo_id, 'folio', v_folio)::text;
  end if;

  return new;
end $fn_cobro_factura$;

comment on function public.tg_cobro_vuelo_factura_coherente() is
  'Trigger A (BEFORE INSERT OR UPDATE OF factura_emitida_id en cobro_vuelo, 20261016000001): un cobro solo se liga a una factura VIGENTE, no dada de baja y ligada al MISMO vuelo (factura_emitida_vuelo); nunca un reembolso ni una parte de sobre. 23514 con hint = CODIGO (REEMBOLSO_SIN_FACTURA, COBRO_DE_GRUPO, FACTURA_NO_VIGENTE, FACTURA_NO_LIGADA_AL_VUELO) y detail jsonb. No escucha vuelo_id.';

create or replace trigger trg_cobro_vuelo_factura_coherente
  before insert or update of factura_emitida_id
  on public.cobro_vuelo
  for each row execute function public.tg_cobro_vuelo_factura_coherente();

-- ===========================================================================
-- 3) TRIGGER B — al CANCELAR o dar de BAJA una factura, sus cobros se sueltan
--    (factura_emitida_id = null). Reactivar NO re-liga (el API avisa
--    COBROS_DESLIGADOS con n y folios). El UPDATE de solo factura_emitida_id
--    NO dispara el trigger E (OF monto, moneda, comision_banco_monto,
--    cobro_grupo_id, ingreso_anticipo_id) ni el de anticipo; sí
--    trg_cobro_vuelo_set_updated_at (correcto) y el trigger A, que con null
--    regresa de inmediato.
-- ===========================================================================
create or replace function public.tg_factura_emitida_suelta_cobros()
returns trigger
language plpgsql
set search_path = ''
as $fn_factura_suelta$
begin
  if (new.estatus = 'CANCELADA' and old.estatus = 'VIGENTE')
     or (new.deleted_at is not null and old.deleted_at is null) then
    update public.cobro_vuelo c
       set factura_emitida_id = null
     where c.factura_emitida_id = new.id;
  end if;
  return null;
end $fn_factura_suelta$;

comment on function public.tg_factura_emitida_suelta_cobros() is
  'Trigger B (AFTER UPDATE OF estatus, deleted_at en factura_emitida, 20261016000001): al pasar de VIGENTE a CANCELADA o al recibir deleted_at, los cobros que amparaba quedan con factura_emitida_id = null. Reactivar no re-liga.';

create or replace trigger trg_factura_emitida_suelta_cobros
  after update of estatus, deleted_at
  on public.factura_emitida
  for each row execute function public.tg_factura_emitida_suelta_cobros();

-- ===========================================================================
-- 4) BACKFILL determinista (solo UPDATE; pasa por el trigger A fila por fila)
--    Regla PURA por factura VIGENTE no dada de baja, sobre los cobros
--    POSITIVOS, sin sobre (cobro_grupo_id null), aún sin factura, en la
--    MISMA moneda (::text) de los vuelos LIGADOS a esa factura; tolerancia
--    1.00 en la moneda de la factura; `monto` es BRUTO (sin restar comisión):
--      B_SUMA   Σ de esos cobros (de TODOS sus vuelos) = total ± 1.00 ⇒ todos.
--      A_EXACTO si no, la factura cubre UN solo vuelo y hay EXACTAMENTE UN
--               cobro con |monto − total| ≤ 1.00 ⇒ ese.
--      si no, nada (globales, parciales sin marca, sumas que no cuadran).
--    Si un cobro cuadrara con dos facturas (0 casos en prod el 16-oct: ningún
--    vuelo tiene 2 vigentes) gana B_SUMA y, a igualdad, la factura más
--    antigua (created_at, id). Reversible: update … set factura_emitida_id = null.
-- ===========================================================================
do $backfill$
declare
  v_n integer;
begin
  with vig as (
    select f.id, f.total, f.moneda::text as moneda, f.created_at
      from public.factura_emitida f
     where f.deleted_at is null
       and f.estatus = 'VIGENTE'
  ),
  nvu as (
    select fv.factura_id, count(*)::integer as n_vuelos
      from public.factura_emitida_vuelo fv
      join vig on vig.id = fv.factura_id
     group by fv.factura_id
  ),
  cand as (
    select vig.id as factura_id, c.id as cobro_id, c.monto
      from vig
      join public.factura_emitida_vuelo fv on fv.factura_id = vig.id
      join public.cobro_vuelo c on c.vuelo_id = fv.vuelo_id
     where c.monto > 0
       and c.cobro_grupo_id is null
       and c.factura_emitida_id is null
       and c.moneda::text = vig.moneda
  ),
  agg as (
    select cand.factura_id,
           sum(cand.monto) as suma,
           count(*) filter (where abs(cand.monto - vig.total) <= 1.00)::integer as n_exactos
      from cand
      join vig on vig.id = cand.factura_id
     group by cand.factura_id
  ),
  ligas as (
    select cand.cobro_id, cand.factura_id, 1 as prioridad
      from cand
      join agg on agg.factura_id = cand.factura_id
      join vig on vig.id = cand.factura_id
     where abs(agg.suma - vig.total) <= 1.00
    union all
    select cand.cobro_id, cand.factura_id, 2 as prioridad
      from cand
      join agg on agg.factura_id = cand.factura_id
      join nvu on nvu.factura_id = cand.factura_id
      join vig on vig.id = cand.factura_id
     where abs(agg.suma - vig.total) > 1.00
       and nvu.n_vuelos = 1
       and agg.n_exactos = 1
       and abs(cand.monto - vig.total) <= 1.00
  ),
  elegida as (
    select distinct on (l.cobro_id) l.cobro_id, l.factura_id
      from ligas l
      join vig on vig.id = l.factura_id
     order by l.cobro_id, l.prioridad, vig.created_at, l.factura_id
  )
  update public.cobro_vuelo c
     set factura_emitida_id = e.factura_id
    from elegida e
   where c.id = e.cobro_id
     and c.factura_emitida_id is null;
  get diagnostics v_n = row_count;
  raise notice 'BACKFILL 20261016000001: % cobro(s) ligados a su factura', v_n;
end $backfill$;

-- ===========================================================================
-- 5) VERIFICACIÓN (aborta si algo no quedó; no escribe)
-- ===========================================================================
do $ver$
declare
  v_n integer;
  v_facturas integer;
begin
  perform 1 from information_schema.columns
   where table_schema = 'public' and table_name = 'cobro_vuelo'
     and column_name = 'factura_emitida_id' and udt_name = 'uuid' and is_nullable = 'YES';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000001: falta la columna cobro_vuelo.factura_emitida_id (uuid null)';
  end if;
  perform 1 from pg_constraint c
   where c.conrelid = 'public.cobro_vuelo'::regclass
     and c.conname = 'cobro_vuelo_factura_emitida_id_fkey'
     and c.contype = 'f' and c.confrelid = 'public.factura_emitida'::regclass
     and c.confdeltype = 'n';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000001: falta la FK cobro_vuelo_factura_emitida_id_fkey (acción set null)';
  end if;
  if to_regclass('public.idx_cobro_vuelo_factura_emitida') is null then
    raise exception 'VERIFICACIÓN 20261016000001: falta el índice idx_cobro_vuelo_factura_emitida';
  end if;
  perform 1 from pg_trigger t
   where t.tgrelid = 'public.cobro_vuelo'::regclass
     and t.tgname = 'trg_cobro_vuelo_factura_coherente' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ilike '%before insert or update of factura_emitida_id%';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000001: falta el trigger A trg_cobro_vuelo_factura_coherente';
  end if;
  perform 1 from pg_trigger t
   where t.tgrelid = 'public.factura_emitida'::regclass
     and t.tgname = 'trg_factura_emitida_suelta_cobros' and not t.tgisinternal
     and pg_get_triggerdef(t.oid) ilike '%after update of estatus, deleted_at%';
  if not found then
    raise exception 'VERIFICACIÓN 20261016000001: falta el trigger B trg_factura_emitida_suelta_cobros';
  end if;
  select count(*) into v_n
    from pg_proc p
    join pg_namespace n on n.oid = p.pronamespace
   where n.nspname = 'public'
     and p.proname in ('tg_cobro_vuelo_factura_coherente', 'tg_factura_emitida_suelta_cobros')
     and p.proconfig @> array['search_path=""'];
  if v_n <> 2 then
    raise exception 'VERIFICACIÓN 20261016000001: las funciones de trigger no tienen search_path vacío (%/2)', v_n;
  end if;
  -- Coherencia de lo ligado (backfill incluido): factura VIGENTE, no dada de
  -- baja, ligada al mismo vuelo; cobro positivo y sin sobre.
  select count(*) into v_n
    from public.cobro_vuelo c
    left join public.factura_emitida f on f.id = c.factura_emitida_id
   where c.factura_emitida_id is not null
     and (f.id is null or f.deleted_at is not null or f.estatus <> 'VIGENTE'
          or c.monto <= 0 or c.cobro_grupo_id is not null
          or not exists (select 1 from public.factura_emitida_vuelo fv
                          where fv.factura_id = c.factura_emitida_id and fv.vuelo_id = c.vuelo_id));
  if v_n > 0 then
    raise exception 'VERIFICACIÓN 20261016000001: % cobro(s) ligados a una factura incoherente', v_n;
  end if;
  select count(*), count(distinct c.factura_emitida_id) into v_n, v_facturas
    from public.cobro_vuelo c where c.factura_emitida_id is not null;
  raise notice 'VERIFICACIÓN 20261016000001 OK: % cobro(s) amparados por % factura(s)', v_n, v_facturas;
end $ver$;

select pg_notify('pgrst', 'reload schema');
-- <<< CUERPO

-- =====================================================================
-- DRY-RUN (copia comentada de dryrun-mcp.sql del paquete; para correrlo quitar
-- el prefijo «-- » de todas las líneas y ejecutarlo como UNA sentencia).
-- =====================================================================
-- -- DRY-RUN de 20261016000001_cobro_factura_emitida.sql (16-oct-2026).
-- -- UNA sola sentencia: pegar TODO el bloque en mcp__supabase__execute_sql
-- -- (proyecto bjesduasnzbzywofukbf). Escrituras REALES dentro de un solo
-- -- «do … end» que termina SIEMPRE en raise ⇒ todo se revierte (DDL incluido).
-- -- Resultado esperado: ERROR «DRYRUN_OK 20261016000001 …». Cualquier otro
-- -- error ⇒ NO aplicar. Sin sentencias destructivas (el MCP las declina); la
-- -- única aparición de esa palabra es la cláusula «on delete set null» de la FK
-- -- (ya pasó por el MCP el 15-oct).
-- -- Orden obligatorio (regla del 12-oct): DDL + triggers ⇒ filas de prueba
-- -- DESPUÉS ⇒ backfill (cuerpo real) ⇒ verificación (cuerpo real) ⇒ C1–C9.
-- do $dry$
-- declare
--   v_actor uuid;
--   v_cliente uuid;
--   v_cta uuid;
--   v_esp_b integer := 0;      -- cobros que la regla B_SUMA ligaría en prod HOY
--   v_esp_a integer := 0;      -- cobros que la regla A_EXACTO ligaría en prod HOY
--   v_esp_fact integer := 0;   -- facturas con alguna liga esperada
--   v_grupo uuid;
--   v_cg uuid;
--   v_v1 uuid; v_v2 uuid; v_v3 uuid; v_v4 uuid; v_v5 uuid;
--   v_c1_977 uuid; v_c1_1700a uuid; v_c1_68208 uuid; v_c1_1700b uuid;
--   v_c2_55000 uuid; v_c2_10123 uuid;
--   v_c3_1700a uuid; v_c3_1700b uuid;
--   v_ca uuid;                 -- V4, 5000, CONCILIADO (abono ligado)
--   v_cb uuid;                 -- V4, 300, libre
--   v_creemb uuid;             -- V4, −100 (reembolso)
--   v_csobre uuid;             -- V4, parte de sobre
--   v_cins uuid;               -- insertado ya con factura (rama INSERT)
--   v_f1 uuid; v_f2 uuid; v_f3 uuid; v_f4 uuid; v_f5 uuid; v_f6 uuid; v_f7 uuid;
--   v_mov uuid;
--   v_j jsonb;
--   v_n integer;
--   v_n2 integer;
--   v_total integer;
--   v_id uuid;
--   v_txt text;
--   v_hint text;
--   v_det text;
--   v_upd timestamptz;
-- begin
--   -- ========================================================================
--   -- A) CONTEXTO
--   -- ========================================================================
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'cobro_vuelo'
--                 and column_name = 'factura_emitida_id') then
--     raise exception 'DRYRUN_FALLA A: cobro_vuelo.factura_emitida_id ya existe (¿ya está aplicada?)';
--   end if;
--   if exists (select 1 from public.factura_emitida f where f.serie = 'DRYRUN') then
--     raise exception 'DRYRUN_FALLA A: ya hay facturas con serie DRYRUN';
--   end if;
--   select u.id into v_actor
--     from public.usuario u
--    where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--    order by u.created_at limit 1;
--   if v_actor is null then raise exception 'DRYRUN_FALLA A: no hay un ADMIN ACTIVO'; end if;
--   select c.id into v_cliente from public.cliente c order by c.created_at limit 1;
--   if v_cliente is null then raise exception 'DRYRUN_FALLA A: no hay clientes'; end if;
--   select cb.id into v_cta
--     from public.cuenta_bancaria cb
--    where coalesce(cb.tipo, 'BANCO') = 'BANCO' and cb.moneda::text = 'MXN'
--    order by coalesce(cb.activa, true) desc, cb.created_at limit 1;
--   if v_cta is null then raise exception 'DRYRUN_FALLA A: no hay una cuenta BANCO en MXN'; end if;
--
--   -- Lo que la regla del backfill ligaría HOY en prod (misma regla que la
--   -- sección 4, sin el filtro «aún sin factura» porque la columna no existe).
--   with vig as (
--     select f.id, f.total, f.moneda::text as moneda
--       from public.factura_emitida f
--      where f.deleted_at is null and f.estatus = 'VIGENTE'
--   ),
--   nvu as (
--     select fv.factura_id, count(*)::integer as n_vuelos
--       from public.factura_emitida_vuelo fv join vig on vig.id = fv.factura_id
--      group by fv.factura_id
--   ),
--   cand as (
--     select vig.id as factura_id, c.id as cobro_id, c.monto
--       from vig
--       join public.factura_emitida_vuelo fv on fv.factura_id = vig.id
--       join public.cobro_vuelo c on c.vuelo_id = fv.vuelo_id
--      where c.monto > 0 and c.cobro_grupo_id is null and c.moneda::text = vig.moneda
--   ),
--   agg as (
--     select cand.factura_id, count(*)::integer as n_cobros, sum(cand.monto) as suma,
--            count(*) filter (where abs(cand.monto - vig.total) <= 1.00)::integer as n_exactos
--       from cand join vig on vig.id = cand.factura_id
--      group by cand.factura_id
--   ),
--   regla as (
--     select vig.id, agg.n_cobros,
--            case when agg.n_cobros > 0 and abs(agg.suma - vig.total) <= 1.00 then 'B_SUMA'
--                 when coalesce(nvu.n_vuelos, 0) = 1 and agg.n_exactos = 1 then 'A_EXACTO'
--                 else 'NINGUNA' end as regla
--       from vig
--       left join agg on agg.factura_id = vig.id
--       left join nvu on nvu.factura_id = vig.id
--   )
--   select coalesce(sum(case when regla = 'B_SUMA' then n_cobros else 0 end), 0)::integer,
--          count(*) filter (where regla = 'A_EXACTO')::integer,
--          count(*) filter (where regla in ('B_SUMA', 'A_EXACTO'))::integer
--     into v_esp_b, v_esp_a, v_esp_fact
--     from regla;
--   raise notice 'A) regla en prod HOY: B_SUMA % cobro(s) · A_EXACTO % cobro(s) · % factura(s) con liga (16-oct-2026: 42 · 2 · 37)',
--     v_esp_b, v_esp_a, v_esp_fact;
--
--   -- ========================================================================
--   -- B) CUERPO REAL, secciones 1–3 (DDL + trigger A + trigger B), TAL CUAL
--   -- ========================================================================
-- -- ===========================================================================
-- -- 1) COLUMNA cobro_vuelo.factura_emitida_id — CLASIFICACIÓN, no dinero
-- -- ===========================================================================
-- alter table public.cobro_vuelo
--   add column if not exists factura_emitida_id uuid null
--   references public.factura_emitida(id) on delete set null;
--
-- comment on column public.cobro_vuelo.factura_emitida_id is
--   'Factura emitida (registro manual, 20260924000003) que AMPARA este cobro. CLASIFICACIÓN, no dinero: no entra a cobrosEnUsd, reparto ni balance. Solo una factura VIGENTE, no dada de baja y ligada (factura_emitida_vuelo) al MISMO vuelo del cobro (trigger A, sin excepción de grupo); nunca en reembolsos (monto <= 0) ni en partes de sobre (cobro_grupo_id). Al cancelar o dar de baja la factura se suelta (null, trigger B) y reactivar NO re-liga. 20261016000001.';
--
-- create index if not exists idx_cobro_vuelo_factura_emitida
--   on public.cobro_vuelo (factura_emitida_id)
--   where factura_emitida_id is not null;
--
-- -- ===========================================================================
-- -- 2) TRIGGER A — coherencia al ligar un cobro con su factura (cobro_vuelo)
-- --    BEFORE INSERT OR UPDATE OF factura_emitida_id. NO escucha vuelo_id
-- --    (reassignAircraft mueve cobros y ligas al clon en dos UPDATE: el orden
-- --    entre ambos no debe importar). Errores 23514 con message «CODIGO: …»,
-- --    hint = CODIGO y detail = jsonb::text, en ESTE orden (espejo del API
-- --    validarFacturaParaCobro): REEMBOLSO_SIN_FACTURA, COBRO_DE_GRUPO,
-- --    FACTURA_NO_VIGENTE, FACTURA_NO_LIGADA_AL_VUELO.
-- --    Perfil: SECURITY INVOKER + search_path vacío (como tg_set_updated_at):
-- --    la escribe solo la service key (RLS sin policies) y una función de
-- --    trigger no se invoca por RPC; así no hace falta retirar EXECUTE (el MCP
-- --    rechaza esa sentencia).
-- -- ===========================================================================
-- create or replace function public.tg_cobro_vuelo_factura_coherente()
-- returns trigger
-- language plpgsql
-- set search_path = ''
-- as $fn_cobro_factura$
-- declare
--   v_f record;
--   v_folio bigint;
-- begin
--   if new.factura_emitida_id is null then
--     return new;
--   end if;
--   if tg_op = 'UPDATE' and new.factura_emitida_id is not distinct from old.factura_emitida_id then
--     return new;
--   end if;
--
--   if new.monto <= 0 then
--     raise exception using
--       errcode = '23514',
--       hint = 'REEMBOLSO_SIN_FACTURA',
--       message = 'REEMBOLSO_SIN_FACTURA: un reembolso no se liga a una factura',
--       detail = jsonb_build_object('cobro_id', new.id)::text;
--   end if;
--
--   if new.cobro_grupo_id is not null then
--     raise exception using
--       errcode = '23514',
--       hint = 'COBRO_DE_GRUPO',
--       message = 'COBRO_DE_GRUPO: la parte de un sobre de grupo no lleva factura por vuelo',
--       detail = jsonb_build_object('cobro_id', new.id, 'cobro_grupo_id', new.cobro_grupo_id)::text;
--   end if;
--
--   -- FOR SHARE: una cancelación/baja concurrente (UPDATE de la factura) espera
--   -- o ya se ve; nunca queda un cobro ligado a una factura que dejó de ser vigente.
--   select f.id, f.serie, f.folio, f.estatus, f.deleted_at
--     into v_f
--     from public.factura_emitida f
--    where f.id = new.factura_emitida_id
--      for share;
--   if not found then
--     raise exception using
--       errcode = '23514',
--       hint = 'FACTURA_NO_VIGENTE',
--       message = format('FACTURA_NO_VIGENTE: la factura %s no existe', new.factura_emitida_id),
--       detail = jsonb_build_object('factura_id', new.factura_emitida_id, 'estatus', null, 'borrada', null)::text;
--   end if;
--   if v_f.deleted_at is not null or v_f.estatus <> 'VIGENTE' then
--     raise exception using
--       errcode = '23514',
--       hint = 'FACTURA_NO_VIGENTE',
--       message = format('FACTURA_NO_VIGENTE: la factura %s ya no está vigente (%s)',
--                        concat_ws('-', v_f.serie, v_f.folio),
--                        case when v_f.deleted_at is not null then 'dada de baja' else lower(v_f.estatus) end),
--       detail = jsonb_build_object('factura_id', v_f.id, 'estatus', v_f.estatus,
--                                   'borrada', v_f.deleted_at is not null)::text;
--   end if;
--
--   if not exists (select 1
--                    from public.factura_emitida_vuelo fv
--                   where fv.factura_id = new.factura_emitida_id
--                     and fv.vuelo_id = new.vuelo_id) then
--     select v.folio into v_folio from public.vuelo v where v.id = new.vuelo_id;
--     raise exception using
--       errcode = '23514',
--       hint = 'FACTURA_NO_LIGADA_AL_VUELO',
--       message = format('FACTURA_NO_LIGADA_AL_VUELO: la factura %s no está ligada al vuelo #%s; agrégale el vuelo en Facturas emitidas → Editar → Vuelos',
--                        concat_ws('-', v_f.serie, v_f.folio), coalesce(v_folio::text, '?')),
--       detail = jsonb_build_object('factura_id', v_f.id, 'vuelo_id', new.vuelo_id, 'folio', v_folio)::text;
--   end if;
--
--   return new;
-- end $fn_cobro_factura$;
--
-- comment on function public.tg_cobro_vuelo_factura_coherente() is
--   'Trigger A (BEFORE INSERT OR UPDATE OF factura_emitida_id en cobro_vuelo, 20261016000001): un cobro solo se liga a una factura VIGENTE, no dada de baja y ligada al MISMO vuelo (factura_emitida_vuelo); nunca un reembolso ni una parte de sobre. 23514 con hint = CODIGO (REEMBOLSO_SIN_FACTURA, COBRO_DE_GRUPO, FACTURA_NO_VIGENTE, FACTURA_NO_LIGADA_AL_VUELO) y detail jsonb. No escucha vuelo_id.';
--
-- create or replace trigger trg_cobro_vuelo_factura_coherente
--   before insert or update of factura_emitida_id
--   on public.cobro_vuelo
--   for each row execute function public.tg_cobro_vuelo_factura_coherente();
--
-- -- ===========================================================================
-- -- 3) TRIGGER B — al CANCELAR o dar de BAJA una factura, sus cobros se sueltan
-- --    (factura_emitida_id = null). Reactivar NO re-liga (el API avisa
-- --    COBROS_DESLIGADOS con n y folios). El UPDATE de solo factura_emitida_id
-- --    NO dispara el trigger E (OF monto, moneda, comision_banco_monto,
-- --    cobro_grupo_id, ingreso_anticipo_id) ni el de anticipo; sí
-- --    trg_cobro_vuelo_set_updated_at (correcto) y el trigger A, que con null
-- --    regresa de inmediato.
-- -- ===========================================================================
-- create or replace function public.tg_factura_emitida_suelta_cobros()
-- returns trigger
-- language plpgsql
-- set search_path = ''
-- as $fn_factura_suelta$
-- begin
--   if (new.estatus = 'CANCELADA' and old.estatus = 'VIGENTE')
--      or (new.deleted_at is not null and old.deleted_at is null) then
--     update public.cobro_vuelo c
--        set factura_emitida_id = null
--      where c.factura_emitida_id = new.id;
--   end if;
--   return null;
-- end $fn_factura_suelta$;
--
-- comment on function public.tg_factura_emitida_suelta_cobros() is
--   'Trigger B (AFTER UPDATE OF estatus, deleted_at en factura_emitida, 20261016000001): al pasar de VIGENTE a CANCELADA o al recibir deleted_at, los cobros que amparaba quedan con factura_emitida_id = null. Reactivar no re-liga.';
--
-- create or replace trigger trg_factura_emitida_suelta_cobros
--   after update of estatus, deleted_at
--   on public.factura_emitida
--   for each row execute function public.tg_factura_emitida_suelta_cobros();
--
--   -- Re-aplicación (idempotencia) de la sección 1 ANTES de cualquier fila.
--   alter table public.cobro_vuelo
--     add column if not exists factura_emitida_id uuid null
--     references public.factura_emitida(id) on delete set null;
--   create index if not exists idx_cobro_vuelo_factura_emitida
--     on public.cobro_vuelo (factura_emitida_id)
--     where factura_emitida_id is not null;
--   select count(*) into v_n from pg_constraint c
--    where c.conrelid = 'public.cobro_vuelo'::regclass and c.contype = 'f'
--      and c.confrelid = 'public.factura_emitida'::regclass;
--   if v_n <> 1 then
--     raise exception 'DRYRUN_FALLA B: la re-aplicación dejó % FK a factura_emitida (debe ser 1)', v_n;
--   end if;
--   raise notice 'okB DDL + triggers aplicados e idempotentes';
--
--   -- ========================================================================
--   -- C) FILAS DE PRUEBA (DESPUÉS del DDL; se revierten al final)
--   --    Vuelos externos (sin avión), de grupo V4/V5; serie DRYRUN.
--   -- ========================================================================
--   insert into public.vuelo_grupo (cliente_id, nombre, fecha_vuelo, pasajeros_total)
--   values (v_cliente, 'DRYRUN-20261016000001', now(), 1) returning id into v_grupo;
--
--   insert into public.vuelo (cliente_id, origen_iata, destino_iata, pasajeros, tiempo_cobrable_hr, tarifa_tipo,
--                             tarifa_hora_usd, subtotal_vuelo_usd, monto_total_usd, es_externo, operador_externo,
--                             estado, fecha_vuelo, notas)
--   values (v_cliente, 'CUN', 'MID', 1, 1, 'PUBLICO', 1, 1, 1, true, 'DRYRUN-20261016000001', 'COMPLETADO', now(), 'DRYRUN V1 (#332 sintético)')
--   returning id into v_v1;
--   insert into public.vuelo (cliente_id, origen_iata, destino_iata, pasajeros, tiempo_cobrable_hr, tarifa_tipo,
--                             tarifa_hora_usd, subtotal_vuelo_usd, monto_total_usd, es_externo, operador_externo,
--                             estado, fecha_vuelo, notas)
--   values (v_cliente, 'CUN', 'MID', 1, 1, 'PUBLICO', 1, 1, 1, true, 'DRYRUN-20261016000001', 'COMPLETADO', now(), 'DRYRUN V2 (#427 sintético)')
--   returning id into v_v2;
--   insert into public.vuelo (cliente_id, origen_iata, destino_iata, pasajeros, tiempo_cobrable_hr, tarifa_tipo,
--                             tarifa_hora_usd, subtotal_vuelo_usd, monto_total_usd, es_externo, operador_externo,
--                             estado, fecha_vuelo, notas)
--   values (v_cliente, 'CUN', 'MID', 1, 1, 'PUBLICO', 1, 1, 1, true, 'DRYRUN-20261016000001', 'COMPLETADO', now(), 'DRYRUN V3 (ambiguo)')
--   returning id into v_v3;
--   insert into public.vuelo (cliente_id, origen_iata, destino_iata, pasajeros, tiempo_cobrable_hr, tarifa_tipo,
--                             tarifa_hora_usd, subtotal_vuelo_usd, monto_total_usd, es_externo, operador_externo,
--                             estado, fecha_vuelo, notas, grupo_id)
--   values (v_cliente, 'CUN', 'MID', 1, 1, 'PUBLICO', 1, 1, 1, true, 'DRYRUN-20261016000001', 'COMPLETADO', now(), 'DRYRUN V4 (grupo)', v_grupo)
--   returning id into v_v4;
--   insert into public.vuelo (cliente_id, origen_iata, destino_iata, pasajeros, tiempo_cobrable_hr, tarifa_tipo,
--                             tarifa_hora_usd, subtotal_vuelo_usd, monto_total_usd, es_externo, operador_externo,
--                             estado, fecha_vuelo, notas, grupo_id)
--   values (v_cliente, 'CUN', 'MID', 1, 1, 'PUBLICO', 1, 1, 1, true, 'DRYRUN-20261016000001', 'COMPLETADO', now(), 'DRYRUN V5 (hermano / clon)', v_grupo)
--   returning id into v_v5;
--
--   -- V1 = #332 sintético: 977.45 + 1,700 + 68,208 + 1,700; factura F1 = 68,208.
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v1, 977.45, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c977', v_actor) returning id into v_c1_977;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v1, 1700, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c1700a', v_actor) returning id into v_c1_1700a;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v1, 68208, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c68208', v_actor) returning id into v_c1_68208;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v1, 1700, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c1700b', v_actor) returning id into v_c1_1700b;
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by)
--   values ('DRYRUN', '0001', current_date, 'MXN', 68208, v_actor) returning id into v_f1;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f1, v_v1, v_actor);
--
--   -- V2 = #427 sintético: 55,000 + 10,123; factura F2 = 65,123 (Σ).
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v2, 55000, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c55000', v_actor) returning id into v_c2_55000;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v2, 10123, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c10123', v_actor) returning id into v_c2_10123;
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by)
--   values ('DRYRUN', '0002', current_date, 'MXN', 65123, v_actor) returning id into v_f2;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f2, v_v2, v_actor);
--
--   -- V3 = ambiguo: dos cobros de 1,700 y factura F3 = 1,700 ⇒ 0 ligas.
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v3, 1700, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c3-1700a', v_actor) returning id into v_c3_1700a;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v3, 1700, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN c3-1700b', v_actor) returning id into v_c3_1700b;
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by)
--   values ('DRYRUN', '0003', current_date, 'MXN', 1700, v_actor) returning id into v_f3;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f3, v_v3, v_actor);
--
--   -- V4 (grupo): CA 5,000 conciliado, CB 300 libre (updated_at de ayer para
--   -- ver que sube), reembolso −100 y una parte de sobre; F4 = 9,999 (no
--   -- cuadra con nada), F6 CANCELADA y F7 dada de baja, las tres ligadas a V4.
--   -- V5 (hermano): F5 = 123 ligada SOLO a V5.
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v4, 5000, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN CA conciliado', v_actor) returning id into v_ca;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por, updated_at)
--   values (v_v4, 300, 'MXN', 'EFECTIVO', now(), 'DRYRUN CB libre', v_actor, now() - interval '1 day') returning id into v_cb;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_v4, -100, 'MXN', 'TRANSFERENCIA', now(), 'DRYRUN reembolso', v_actor) returning id into v_creemb;
--   insert into public.cobro_grupo (grupo_id, monto, moneda, metodo_cobro, modo_particion, registrado_por)
--   values (v_grupo, 100, 'MXN', 'EFECTIVO', 'MANUAL', v_actor) returning id into v_cg;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por, cobro_grupo_id, grupo_factor)
--   values (v_v4, 100, 'MXN', 'EFECTIVO', now(), 'DRYRUN parte de sobre', v_actor, v_cg, 1) returning id into v_csobre;
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by)
--   values ('DRYRUN', '0004', current_date, 'MXN', 9999, v_actor) returning id into v_f4;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f4, v_v4, v_actor);
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by)
--   values ('DRYRUN', '0005', current_date, 'MXN', 123, v_actor) returning id into v_f5;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f5, v_v5, v_actor);
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by,
--                                       estatus, cancelada_at, cancelada_por, motivo_cancelacion)
--   values ('DRYRUN', '0006', current_date, 'MXN', 300, v_actor,
--           'CANCELADA', now(), v_actor, 'DRYRUN cancelada') returning id into v_f6;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f6, v_v4, v_actor);
--   insert into public.factura_emitida (serie, folio, fecha_emision, moneda, total, created_by,
--                                       deleted_at, deleted_by, motivo_baja)
--   values ('DRYRUN', '0007', current_date, 'MXN', 300, v_actor,
--           now(), v_actor, 'DRYRUN dada de baja') returning id into v_f7;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f7, v_v4, v_actor);
--
--   -- CA conciliado: un abono de 5,000 ligado por la RPC G (puente real).
--   insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, origen, created_by)
--   values (v_cta, current_date, 'ABONO', 5000, 'DRYRUN-20261016000001 abono CA', 'DRYRUN', 'MANUAL', v_actor)
--   returning id into v_mov;
--   v_j := public.conciliacion_ligar_abono_cobros(v_mov, array[v_ca], v_actor);
--   if not exists (select 1 from public.movimiento_bancario_cobro p where p.movimiento_id = v_mov and p.cobro_id = v_ca) then
--     raise exception 'DRYRUN_FALLA C: la RPC no ligó el abono a CA (%)', v_j::text;
--   end if;
--   raise notice 'okC filas de prueba: 5 vuelos, 12 cobros, 7 facturas, 1 abono conciliado';
--
--   -- ========================================================================
--   -- D) CUERPO REAL, sección 4 (backfill), TAL CUAL
--   -- ========================================================================
-- -- ===========================================================================
-- -- 4) BACKFILL determinista (solo UPDATE; pasa por el trigger A fila por fila)
-- --    Regla PURA por factura VIGENTE no dada de baja, sobre los cobros
-- --    POSITIVOS, sin sobre (cobro_grupo_id null), aún sin factura, en la
-- --    MISMA moneda (::text) de los vuelos LIGADOS a esa factura; tolerancia
-- --    1.00 en la moneda de la factura; `monto` es BRUTO (sin restar comisión):
-- --      B_SUMA   Σ de esos cobros (de TODOS sus vuelos) = total ± 1.00 ⇒ todos.
-- --      A_EXACTO si no, la factura cubre UN solo vuelo y hay EXACTAMENTE UN
-- --               cobro con |monto − total| ≤ 1.00 ⇒ ese.
-- --      si no, nada (globales, parciales sin marca, sumas que no cuadran).
-- --    Si un cobro cuadrara con dos facturas (0 casos en prod el 16-oct: ningún
-- --    vuelo tiene 2 vigentes) gana B_SUMA y, a igualdad, la factura más
-- --    antigua (created_at, id). Reversible: update … set factura_emitida_id = null.
-- -- ===========================================================================
-- do $backfill$
-- declare
--   v_n integer;
-- begin
--   with vig as (
--     select f.id, f.total, f.moneda::text as moneda, f.created_at
--       from public.factura_emitida f
--      where f.deleted_at is null
--        and f.estatus = 'VIGENTE'
--   ),
--   nvu as (
--     select fv.factura_id, count(*)::integer as n_vuelos
--       from public.factura_emitida_vuelo fv
--       join vig on vig.id = fv.factura_id
--      group by fv.factura_id
--   ),
--   cand as (
--     select vig.id as factura_id, c.id as cobro_id, c.monto
--       from vig
--       join public.factura_emitida_vuelo fv on fv.factura_id = vig.id
--       join public.cobro_vuelo c on c.vuelo_id = fv.vuelo_id
--      where c.monto > 0
--        and c.cobro_grupo_id is null
--        and c.factura_emitida_id is null
--        and c.moneda::text = vig.moneda
--   ),
--   agg as (
--     select cand.factura_id,
--            sum(cand.monto) as suma,
--            count(*) filter (where abs(cand.monto - vig.total) <= 1.00)::integer as n_exactos
--       from cand
--       join vig on vig.id = cand.factura_id
--      group by cand.factura_id
--   ),
--   ligas as (
--     select cand.cobro_id, cand.factura_id, 1 as prioridad
--       from cand
--       join agg on agg.factura_id = cand.factura_id
--       join vig on vig.id = cand.factura_id
--      where abs(agg.suma - vig.total) <= 1.00
--     union all
--     select cand.cobro_id, cand.factura_id, 2 as prioridad
--       from cand
--       join agg on agg.factura_id = cand.factura_id
--       join nvu on nvu.factura_id = cand.factura_id
--       join vig on vig.id = cand.factura_id
--      where abs(agg.suma - vig.total) > 1.00
--        and nvu.n_vuelos = 1
--        and agg.n_exactos = 1
--        and abs(cand.monto - vig.total) <= 1.00
--   ),
--   elegida as (
--     select distinct on (l.cobro_id) l.cobro_id, l.factura_id
--       from ligas l
--       join vig on vig.id = l.factura_id
--      order by l.cobro_id, l.prioridad, vig.created_at, l.factura_id
--   )
--   update public.cobro_vuelo c
--      set factura_emitida_id = e.factura_id
--     from elegida e
--    where c.id = e.cobro_id
--      and c.factura_emitida_id is null;
--   get diagnostics v_n = row_count;
--   raise notice 'BACKFILL 20261016000001: % cobro(s) ligados a su factura', v_n;
-- end $backfill$;
-- -- ===========================================================================
-- -- 5) VERIFICACIÓN (aborta si algo no quedó; no escribe)
-- -- ===========================================================================
-- do $ver$
-- declare
--   v_n integer;
--   v_facturas integer;
-- begin
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'cobro_vuelo'
--      and column_name = 'factura_emitida_id' and udt_name = 'uuid' and is_nullable = 'YES';
--   if not found then
--     raise exception 'VERIFICACIÓN 20261016000001: falta la columna cobro_vuelo.factura_emitida_id (uuid null)';
--   end if;
--   perform 1 from pg_constraint c
--    where c.conrelid = 'public.cobro_vuelo'::regclass
--      and c.conname = 'cobro_vuelo_factura_emitida_id_fkey'
--      and c.contype = 'f' and c.confrelid = 'public.factura_emitida'::regclass
--      and c.confdeltype = 'n';
--   if not found then
--     raise exception 'VERIFICACIÓN 20261016000001: falta la FK cobro_vuelo_factura_emitida_id_fkey (acción set null)';
--   end if;
--   if to_regclass('public.idx_cobro_vuelo_factura_emitida') is null then
--     raise exception 'VERIFICACIÓN 20261016000001: falta el índice idx_cobro_vuelo_factura_emitida';
--   end if;
--   perform 1 from pg_trigger t
--    where t.tgrelid = 'public.cobro_vuelo'::regclass
--      and t.tgname = 'trg_cobro_vuelo_factura_coherente' and not t.tgisinternal
--      and pg_get_triggerdef(t.oid) ilike '%before insert or update of factura_emitida_id%';
--   if not found then
--     raise exception 'VERIFICACIÓN 20261016000001: falta el trigger A trg_cobro_vuelo_factura_coherente';
--   end if;
--   perform 1 from pg_trigger t
--    where t.tgrelid = 'public.factura_emitida'::regclass
--      and t.tgname = 'trg_factura_emitida_suelta_cobros' and not t.tgisinternal
--      and pg_get_triggerdef(t.oid) ilike '%after update of estatus, deleted_at%';
--   if not found then
--     raise exception 'VERIFICACIÓN 20261016000001: falta el trigger B trg_factura_emitida_suelta_cobros';
--   end if;
--   select count(*) into v_n
--     from pg_proc p
--     join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('tg_cobro_vuelo_factura_coherente', 'tg_factura_emitida_suelta_cobros')
--      and p.proconfig @> array['search_path=""'];
--   if v_n <> 2 then
--     raise exception 'VERIFICACIÓN 20261016000001: las funciones de trigger no tienen search_path vacío (%/2)', v_n;
--   end if;
--   -- Coherencia de lo ligado (backfill incluido): factura VIGENTE, no dada de
--   -- baja, ligada al mismo vuelo; cobro positivo y sin sobre.
--   select count(*) into v_n
--     from public.cobro_vuelo c
--     left join public.factura_emitida f on f.id = c.factura_emitida_id
--    where c.factura_emitida_id is not null
--      and (f.id is null or f.deleted_at is not null or f.estatus <> 'VIGENTE'
--           or c.monto <= 0 or c.cobro_grupo_id is not null
--           or not exists (select 1 from public.factura_emitida_vuelo fv
--                           where fv.factura_id = c.factura_emitida_id and fv.vuelo_id = c.vuelo_id));
--   if v_n > 0 then
--     raise exception 'VERIFICACIÓN 20261016000001: % cobro(s) ligados a una factura incoherente', v_n;
--   end if;
--   select count(*), count(distinct c.factura_emitida_id) into v_n, v_facturas
--     from public.cobro_vuelo c where c.factura_emitida_id is not null;
--   raise notice 'VERIFICACIÓN 20261016000001 OK: % cobro(s) amparados por % factura(s)', v_n, v_facturas;
-- end $ver$;
--
--   -- ========================================================================
--   -- F) PRUEBAS C1–C9 (escrituras reales; todo se revierte al final)
--   -- ========================================================================
--
--   -- C1) Columna, FK (acción set null), índice parcial, triggers y funciones.
--   perform 1 from information_schema.columns
--    where table_schema = 'public' and table_name = 'cobro_vuelo'
--      and column_name = 'factura_emitida_id' and udt_name = 'uuid' and is_nullable = 'YES';
--   if not found then raise exception 'DRYRUN_FALLA C1: columna'; end if;
--   perform 1 from pg_constraint c
--    where c.conrelid = 'public.cobro_vuelo'::regclass
--      and c.conname = 'cobro_vuelo_factura_emitida_id_fkey' and c.contype = 'f'
--      and c.confrelid = 'public.factura_emitida'::regclass and c.confdeltype = 'n';
--   if not found then raise exception 'DRYRUN_FALLA C1: FK con acción set null'; end if;
--   perform 1 from pg_indexes i
--    where i.schemaname = 'public' and i.tablename = 'cobro_vuelo'
--      and i.indexname = 'idx_cobro_vuelo_factura_emitida'
--      and i.indexdef ilike '%where (factura_emitida_id is not null)%';
--   if not found then raise exception 'DRYRUN_FALLA C1: índice parcial'; end if;
--   select count(*) into v_n from pg_trigger t
--    where not t.tgisinternal
--      and ((t.tgrelid = 'public.cobro_vuelo'::regclass and t.tgname = 'trg_cobro_vuelo_factura_coherente')
--        or (t.tgrelid = 'public.factura_emitida'::regclass and t.tgname = 'trg_factura_emitida_suelta_cobros'));
--   if v_n <> 2 then raise exception 'DRYRUN_FALLA C1: triggers (%/2)', v_n; end if;
--   select count(*) into v_n from pg_proc p join pg_namespace n on n.oid = p.pronamespace
--    where n.nspname = 'public'
--      and p.proname in ('tg_cobro_vuelo_factura_coherente', 'tg_factura_emitida_suelta_cobros')
--      and p.proconfig @> array['search_path=""'] and not p.prosecdef;
--   if v_n <> 2 then raise exception 'DRYRUN_FALLA C1: funciones con search_path vacío e invoker (%/2)', v_n; end if;
--   raise notice 'okC1 columna, FK set null, índice parcial, 2 triggers, 2 funciones';
--
--   -- C8) Backfill: escenarios sintéticos y paridad con la regla en prod.
--   select count(*) into v_n from public.cobro_vuelo c where c.vuelo_id = v_v1 and c.factura_emitida_id = v_f1;
--   select factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_c1_68208;
--   if v_n <> 1 or v_id is distinct from v_f1 then
--     raise exception 'DRYRUN_FALLA C8: #332 sintético: F1 debió amparar SOLO el cobro de 68,208 (ligó %)', v_n;
--   end if;
--   select count(*) into v_n from public.cobro_vuelo c where c.vuelo_id = v_v2 and c.factura_emitida_id = v_f2;
--   if v_n <> 2 then raise exception 'DRYRUN_FALLA C8: Σ 55,000 + 10,123 debió ligar los 2 (ligó %)', v_n; end if;
--   select count(*) into v_n from public.cobro_vuelo c where c.vuelo_id = v_v3 and c.factura_emitida_id is not null;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C8: ambiguo (dos de 1,700 contra 1,700) debió ligar 0 (ligó %)', v_n; end if;
--   select count(*) into v_n from public.cobro_vuelo c where c.vuelo_id in (v_v4, v_v5) and c.factura_emitida_id is not null;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C8: V4/V5 no debían recibir liga (F4 = 9,999; ligó %)', v_n; end if;
--   select count(*) into v_total from public.cobro_vuelo c where c.factura_emitida_id is not null;
--   if v_total - 3 <> v_esp_b + v_esp_a then
--     raise exception 'DRYRUN_FALLA C8: prod ligó % cobro(s) y la regla esperaba % (B_SUMA % + A_EXACTO %)',
--       v_total - 3, v_esp_b + v_esp_a, v_esp_b, v_esp_a;
--   end if;
--   select count(distinct c.factura_emitida_id) into v_n from public.cobro_vuelo c
--    where c.factura_emitida_id is not null
--      and c.factura_emitida_id not in (v_f1, v_f2);
--   if v_n <> v_esp_fact then
--     raise exception 'DRYRUN_FALLA C8: prod quedó con % factura(s) con liga y la regla esperaba %', v_n, v_esp_fact;
--   end if;
--   -- Casos de la captura (si siguen vigentes hoy): A-0420 → el cobro de 68,208
--   -- de #332 y nada más; FA-A-0434 → el de 38,589 de #364 y nada más.
--   select f.id into v_id from public.factura_emitida f
--    where f.serie = 'A' and f.folio = '0420' and f.deleted_at is null and f.estatus = 'VIGENTE';
--   if v_id is not null then
--     select count(*), count(*) filter (where c.monto = 68208 and v.folio = 332) into v_n, v_n2
--       from public.cobro_vuelo c join public.vuelo v on v.id = c.vuelo_id
--      where c.factura_emitida_id = v_id;
--     if v_n <> 1 or v_n2 <> 1 then
--       raise exception 'DRYRUN_FALLA C8: A-0420 debió amparar solo el cobro de 68,208 de #332 (ligó %)', v_n;
--     end if;
--   end if;
--   select f.id into v_id from public.factura_emitida f
--    where f.serie = 'FA-A' and f.folio = '0434' and f.deleted_at is null and f.estatus = 'VIGENTE';
--   if v_id is not null then
--     select count(*), count(*) filter (where c.monto = 38589 and v.folio = 364) into v_n, v_n2
--       from public.cobro_vuelo c join public.vuelo v on v.id = c.vuelo_id
--      where c.factura_emitida_id = v_id;
--     if v_n <> 1 or v_n2 <> 1 then
--       raise exception 'DRYRUN_FALLA C8: FA-A-0434 debió amparar solo el cobro de 38,589 de #364 (ligó %)', v_n;
--     end if;
--   end if;
--   raise notice 'okC8 backfill: prueba 1 + 2 + 0 · prod % cobro(s) en % factura(s) (= regla)', v_total - 3, v_esp_fact;
--
--   -- C2) Ligar CB (libre) a F4 (vigente, ligada a V4) ⇒ pasa y updated_at sube.
--   select c.updated_at into v_upd from public.cobro_vuelo c where c.id = v_cb;
--   update public.cobro_vuelo set factura_emitida_id = v_f4 where id = v_cb;
--   select c.factura_emitida_id, c.updated_at into v_id, v_upd from public.cobro_vuelo c where c.id = v_cb;
--   if v_id is distinct from v_f4 then raise exception 'DRYRUN_FALLA C2: no quedó ligado'; end if;
--   if v_upd < now() then raise exception 'DRYRUN_FALLA C2: updated_at no subió (%)', v_upd; end if;
--   raise notice 'okC2 liga a vigente ligada al vuelo; updated_at = now()';
--
--   -- C3) F5 está ligada SOLO a V5 (hermano de grupo de V4) ⇒ rebota igual
--   --     (sin excepción de grupo); tras ligar V4 a F5 ⇒ pasa.
--   begin
--     update public.cobro_vuelo set factura_emitida_id = v_f5 where id = v_cb;
--     raise exception 'DRYRUN_FALLA C3: debió rebotar (factura del hermano de grupo)';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_det = pg_exception_detail;
--     if v_hint is distinct from 'FACTURA_NO_LIGADA_AL_VUELO'
--        or (v_det::jsonb ->> 'vuelo_id') is distinct from v_v4::text
--        or (v_det::jsonb ->> 'factura_id') is distinct from v_f5::text then
--       raise exception 'DRYRUN_FALLA C3: % · % · %', v_hint, v_txt, v_det;
--     end if;
--   end;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_cb;
--   if v_id is distinct from v_f4 then raise exception 'DRYRUN_FALLA C3: el rebote cambió la liga'; end if;
--   insert into public.factura_emitida_vuelo (factura_id, vuelo_id, created_by) values (v_f5, v_v4, v_actor);
--   update public.cobro_vuelo set factura_emitida_id = v_f5 where id = v_cb;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_cb;
--   if v_id is distinct from v_f5 then raise exception 'DRYRUN_FALLA C3: tras ligar el vuelo debió pasar'; end if;
--   raise notice 'okC3 otro vuelo / hermano de grupo ⇒ FACTURA_NO_LIGADA_AL_VUELO; con la liga ⇒ pasa';
--
--   -- C4) CANCELADA, dada de baja e inexistente ⇒ FACTURA_NO_VIGENTE.
--   begin
--     update public.cobro_vuelo set factura_emitida_id = v_f6 where id = v_cb;
--     raise exception 'DRYRUN_FALLA C4: debió rebotar (cancelada)';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_det = pg_exception_detail;
--     if v_hint is distinct from 'FACTURA_NO_VIGENTE'
--        or (v_det::jsonb ->> 'estatus') is distinct from 'CANCELADA'
--        or (v_det::jsonb ->> 'borrada') is distinct from 'false' then
--       raise exception 'DRYRUN_FALLA C4 cancelada: % · % · %', v_hint, v_txt, v_det;
--     end if;
--   end;
--   begin
--     update public.cobro_vuelo set factura_emitida_id = v_f7 where id = v_cb;
--     raise exception 'DRYRUN_FALLA C4: debió rebotar (dada de baja)';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_det = pg_exception_detail;
--     if v_hint is distinct from 'FACTURA_NO_VIGENTE' or (v_det::jsonb ->> 'borrada') is distinct from 'true' then
--       raise exception 'DRYRUN_FALLA C4 baja: % · % · %', v_hint, v_txt, v_det;
--     end if;
--   end;
--   begin
--     update public.cobro_vuelo set factura_emitida_id = gen_random_uuid() where id = v_cb;
--     raise exception 'DRYRUN_FALLA C4: debió rebotar (inexistente)';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--     if v_hint is distinct from 'FACTURA_NO_VIGENTE' then
--       raise exception 'DRYRUN_FALLA C4 inexistente: % · %', v_hint, v_txt;
--     end if;
--   end;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_cb;
--   if v_id is distinct from v_f5 then raise exception 'DRYRUN_FALLA C4: los rebotes cambiaron la liga'; end if;
--   raise notice 'okC4 cancelada / dada de baja / inexistente ⇒ FACTURA_NO_VIGENTE';
--
--   -- C5) Reembolso ⇒ REEMBOLSO_SIN_FACTURA; parte de sobre ⇒ COBRO_DE_GRUPO.
--   begin
--     update public.cobro_vuelo set factura_emitida_id = v_f4 where id = v_creemb;
--     raise exception 'DRYRUN_FALLA C5: debió rebotar (reembolso)';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_det = pg_exception_detail;
--     if v_hint is distinct from 'REEMBOLSO_SIN_FACTURA' or (v_det::jsonb ->> 'cobro_id') is distinct from v_creemb::text then
--       raise exception 'DRYRUN_FALLA C5 reembolso: % · % · %', v_hint, v_txt, v_det;
--     end if;
--   end;
--   begin
--     update public.cobro_vuelo set factura_emitida_id = v_f4 where id = v_csobre;
--     raise exception 'DRYRUN_FALLA C5: debió rebotar (parte de sobre)';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint, v_det = pg_exception_detail;
--     if v_hint is distinct from 'COBRO_DE_GRUPO' or (v_det::jsonb ->> 'cobro_grupo_id') is distinct from v_cg::text then
--       raise exception 'DRYRUN_FALLA C5 sobre: % · % · %', v_hint, v_txt, v_det;
--     end if;
--   end;
--   -- Rama INSERT del trigger A: nace con factura (pasa) / con factura de otro vuelo (rebota).
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por, factura_emitida_id)
--   values (v_v4, 50, 'MXN', 'EFECTIVO', now(), 'DRYRUN nace con factura', v_actor, v_f4) returning id into v_cins;
--   begin
--     insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por, factura_emitida_id)
--     values (v_v1, 50, 'MXN', 'EFECTIVO', now(), 'DRYRUN nace mal', v_actor, v_f4);
--     raise exception 'DRYRUN_FALLA C5: el INSERT con factura de otro vuelo debió rebotar';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--     if v_hint is distinct from 'FACTURA_NO_LIGADA_AL_VUELO' then
--       raise exception 'DRYRUN_FALLA C5 insert: % · %', v_hint, v_txt;
--     end if;
--   end;
--   raise notice 'okC5 reembolso ⇒ REEMBOLSO_SIN_FACTURA · sobre ⇒ COBRO_DE_GRUPO · INSERT con factura pasa/rebota';
--
--   -- C6) CA tiene un abono ligado: cambiar SOLO factura_emitida_id pasa (E no
--   --     se dispara); cambiar monto sigue rebotando COBRO_CONCILIADO.
--   update public.cobro_vuelo set factura_emitida_id = v_f4 where id = v_ca;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_ca;
--   if v_id is distinct from v_f4 then raise exception 'DRYRUN_FALLA C6: el conciliado no aceptó la factura'; end if;
--   begin
--     update public.cobro_vuelo set monto = 5001 where id = v_ca;
--     raise exception 'DRYRUN_FALLA C6: cambiar el monto del conciliado debió rebotar';
--   exception when check_violation then
--     get stacked diagnostics v_txt = message_text, v_hint = pg_exception_hint;
--     if v_hint is distinct from 'COBRO_CONCILIADO' then
--       raise exception 'DRYRUN_FALLA C6 monto: % · %', v_hint, v_txt;
--     end if;
--   end;
--   select c.factura_emitida_id, c.monto into v_id, v_n from public.cobro_vuelo c where c.id = v_ca;
--   if v_id is distinct from v_f4 or v_n <> 5000 then raise exception 'DRYRUN_FALLA C6: el rebote alteró CA'; end if;
--   raise notice 'okC6 conciliado: factura sí, dinero no (COBRO_CONCILIADO)';
--
--   -- C9) Mover CB al clon V5 (F5 ligada a V4 y V5) con factura ligada ⇒ pasa:
--   --     el trigger A no escucha vuelo_id.
--   update public.cobro_vuelo set vuelo_id = v_v5 where id = v_cb;
--   select c.factura_emitida_id, c.vuelo_id into v_id, v_mov from public.cobro_vuelo c where c.id = v_cb;
--   if v_id is distinct from v_f5 or v_mov is distinct from v_v5 then
--     raise exception 'DRYRUN_FALLA C9: mover el cobro de vuelo cambió la liga';
--   end if;
--   raise notice 'okC9 cambiar vuelo_id con factura ligada pasa';
--
--   -- C7) Cancelar F4 ⇒ CA y el cobro nacido con factura quedan null; reactivar
--   --     NO re-liga (pero volver a ligar a mano sí pasa); dar de baja F5 ⇒ CB null.
--   --     F1 (68,208 del #332 sintético) no se toca.
--   update public.factura_emitida
--      set estatus = 'CANCELADA', cancelada_at = now(), cancelada_por = v_actor,
--          motivo_cancelacion = 'DRYRUN cancelación'
--    where id = v_f4;
--   select count(*) into v_n from public.cobro_vuelo c where c.factura_emitida_id = v_f4;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C7: cancelar dejó % cobro(s) ligados', v_n; end if;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_ca;
--   if v_id is not null then raise exception 'DRYRUN_FALLA C7: CA sigue ligado tras cancelar'; end if;
--   update public.factura_emitida
--      set estatus = 'VIGENTE', cancelada_at = null, cancelada_por = null, motivo_cancelacion = null
--    where id = v_f4;
--   select count(*) into v_n from public.cobro_vuelo c where c.factura_emitida_id = v_f4;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C7: reactivar re-ligó % cobro(s)', v_n; end if;
--   update public.cobro_vuelo set factura_emitida_id = v_f4 where id = v_ca;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_ca;
--   if v_id is distinct from v_f4 then raise exception 'DRYRUN_FALLA C7: tras reactivar no se pudo re-ligar a mano'; end if;
--   update public.factura_emitida
--      set deleted_at = now(), deleted_by = v_actor, motivo_baja = 'DRYRUN baja'
--    where id = v_f5;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_cb;
--   if v_id is not null then raise exception 'DRYRUN_FALLA C7: dar de baja no soltó a CB'; end if;
--   select count(*) into v_n from public.cobro_vuelo c where c.factura_emitida_id = v_f1;
--   if v_n <> 1 then raise exception 'DRYRUN_FALLA C7: el trigger B tocó cobros de otra factura (F1 = %)', v_n; end if;
--   -- Un UPDATE de la factura que no cambia estatus ni deleted_at no suelta nada.
--   update public.factura_emitida set notas = 'DRYRUN sin cambio de estatus' where id = v_f4;
--   select c.factura_emitida_id into v_id from public.cobro_vuelo c where c.id = v_ca;
--   if v_id is distinct from v_f4 then raise exception 'DRYRUN_FALLA C7: un UPDATE ajeno soltó a CA'; end if;
--   raise notice 'okC7 cancelar / dar de baja sueltan; reactivar no re-liga; otros UPDATE no tocan';
--
--   -- Coherencia global tras todas las pruebas (misma consulta de la sección 5).
--   select count(*) into v_n
--     from public.cobro_vuelo c
--     left join public.factura_emitida f on f.id = c.factura_emitida_id
--    where c.factura_emitida_id is not null
--      and (f.id is null or f.deleted_at is not null or f.estatus <> 'VIGENTE'
--           or c.monto <= 0 or c.cobro_grupo_id is not null
--           or not exists (select 1 from public.factura_emitida_vuelo fv
--                           where fv.factura_id = c.factura_emitida_id and fv.vuelo_id = c.vuelo_id));
--   if v_n > 0 then raise exception 'DRYRUN_FALLA FIN: % cobro(s) incoherentes', v_n; end if;
--
--   raise exception 'DRYRUN_OK 20261016000001 · prod: % cobro(s) ligados en % factura(s) (regla: B_SUMA % + A_EXACTO %; 16-oct-2026 = 44 en 37) · prueba 1+2+0 · C1–C9 ok · TODO REVERTIDO',
--     v_total - 3, v_esp_fact, v_esp_b, v_esp_a;
-- end
-- $dry$;
