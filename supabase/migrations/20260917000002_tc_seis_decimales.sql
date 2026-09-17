-- ============================================================================
-- TIPO DE CAMBIO CON 6 DECIMALES + BACKFILL DEL TC REDONDEADO (17-sep-2026)
-- ============================================================================
--
-- PEDIDO DEL CLIENTE (capturas del vuelo #314): la hoja de la cotización
-- imprime «Total MXN (T.C. 16.9916) $100,000.00 MXN» y el diálogo «Registrar
-- cobro» muestra «TC de la cotización 16.9916 · Total ≈ MXN $99,999.81».
--   «ese cambio cuando hace la conversión a pesos, no sé por qué cuando son
--    muchos decimales como que siempre cambia a como está en la cotización»
--
-- CAUSA RAÍZ: el operador captura el T.C. con los decimales que necesita para
-- que el total en pesos cuadre (100000 / 5885.25 = 16.991631749…); el motor
-- compone y persiste `monto_total_mxn = 100,000.00` con ESE TC completo, pero
-- las columnas de TC son `numeric(10,4)` y Postgres las GUARDA redondeadas a
-- 16.9916. Desde entonces cualquier lector que recalcule `usd × tc` obtiene
-- 99,999.81, y un cobro de 100,000 MXN con ese TC convierte a 5,885.26 USD
-- (un centavo de deuda fantasma).
--
-- QUÉ HACE ESTA MIGRACIÓN
--   1. `numeric(10,4)` → `numeric(12,6)` en los seis TC del DINERO DEL VUELO:
--      vuelo.tc_usd_mxn, cobro_vuelo.tc_usd_mxn, cobro_grupo.tc_usd_mxn,
--      vuelo_grupo.tc_usd_mxn, cotizacion_version_history.tc_usd_mxn y
--      gasto.tc_gasto. (Se quedan como están, a propósito y fuera del pedido:
--      tipo_cambio_oficial.tc = referencia diaria, compra.tc_usd_mxn e
--      inventario_movimiento.tc_usd_mxn = compras/inventario.)
--   2. BACKFILL de los vuelos cuyo TC guardado ya no reproduce el total en
--      pesos que el cliente vio: se recupera el TC ORIGINAL a partir del
--      total persistido, con la MISMA composición del motor v1.3
--      (componentes USD × TC + renglones nativos en pesos TAL CUAL), y solo
--      se escribe si ese TC de 6 decimales reproduce EXACTAMENTE
--      monto_total_mxn y cae en la banda 10–30. Lo que no cuadre se deja
--      intacto y se lista en un `raise notice`.
--
-- NO hay triggers nuevos, NO se tocan CHECK existentes (`ALTER COLUMN TYPE`
-- los conserva y los revalida) y NO hay índices ni vistas sobre estas
-- columnas (verificado en prod bjesduasnzbzywofukbf el 17-sep-2026).
-- `trg_vuelo_calendar_sync` es `AFTER UPDATE OF <columnas>` y tc_usd_mxn NO
-- está en su lista: el backfill NO encola nada a Google Calendar. Sí se
-- apaga `trg_vuelo_set_updated_at` durante el backfill para que `updated_at`
-- no se mueva (lo usa el CAS de las ediciones offline: moverlo provocaría
-- 409 CONFLICTO_VERSION falsos en la app); el DISABLE/ENABLE exige ser dueño
-- de la tabla — el runner de migraciones (postgres) lo es.
--
-- Tamaño (17-sep-2026): vuelo 282, cobro_vuelo 184, cobro_grupo 0,
-- vuelo_grupo 3, cotizacion_version_history 295, gasto 750. La reescritura de
-- tabla que implica el ALTER es instantánea a esta escala.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (córrelo ANTES; no escribe nada, termina en rollback)
-- ---------------------------------------------------------------------------
-- begin;
--
-- -- (a) ANTES: cuántos vuelos con TC y total MXN, y cuántos INCONSISTENTES
-- --     (el total persistido ya no es round2(usd × tc)).
-- with base as (
--   select id, folio,
--          monto_total_usd::numeric      as u,
--          monto_total_mxn::numeric      as m,
--          tc_usd_mxn::numeric           as t,
--          coalesce((calculo_snapshot->'totales'->>'mxn_nativos')::numeric, 0) as nat,
--          coalesce((calculo_snapshot->'totales'->>'usd_de_mxn')::numeric, 0)  as ude
--     from public.vuelo
--    where monto_total_mxn is not null and monto_total_usd > 0 and tc_usd_mxn > 0
-- )
-- select count(*) as con_tc_y_total,
--        count(*) filter (where abs(m - round(u * t, 2)) >= 0.01) as inconsistentes
--   from base;
--
-- -- (b) DESPUÉS (simulado): qué TC quedaría en cada uno y si recompone exacto.
-- with base as (
--   select id, folio,
--          monto_total_usd::numeric as u,
--          monto_total_mxn::numeric as m,
--          tc_usd_mxn::numeric      as t,
--          coalesce((calculo_snapshot->'totales'->>'mxn_nativos')::numeric, 0) as nat,
--          coalesce((calculo_snapshot->'totales'->>'usd_de_mxn')::numeric, 0)  as ude
--     from public.vuelo
--    where monto_total_mxn is not null and monto_total_usd > 0 and tc_usd_mxn > 0
--      and abs(monto_total_mxn - round(monto_total_usd * tc_usd_mxn, 2)) >= 0.01
-- ), calc as (
--   select *, case when (u - ude) > 0 then round((m - nat) / (u - ude), 6) end as t6
--     from base
-- )
-- select folio, u as usd, m as total_mxn, t as tc_actual, t6 as tc_nuevo, nat, ude,
--        case when t6 is not null then round((u - ude) * t6, 2) + nat end as recompuesto,
--        case when t6 is not null and t6 between 10 and 30
--              and round((u - ude) * t6, 2) + nat = m then 'SE CORRIGE'
--             else 'SE DEJA IGUAL' end as veredicto
--   from calc
--  order by folio;
--
-- rollback;
-- ---------------------------------------------------------------------------
-- Estado medido en prod el 17-sep-2026 (consulta read-only, sin escribir):
--   146 vuelos con TC y total MXN · 46 INCONSISTENTES · 0 omitidos.
--   De los 46: 39 cambian de TC (el que el operador tecleó y la BD recortó) y
--   7 ya tenían el TC bueno — su desfase venía de los renglones NATIVOS en
--   pesos (TUAS/extras), no del redondeo, y el UPDATE los deja intactos.
--   Ninguno queda fuera de la banda 10–30 ni deja de recomponer al centavo.
--   Ejemplos: #314 (5885.25 · 100,000.00 · 16.9916 → 16.991632),
--   #140 (2314 · 40,000.00 · 17.2861 → 17.286085),
--   #179 (3596 · 60,952.00 · 16.9499 → 16.949944),
--   #81  (2629.29 · 46,012.50 · 17.5 con 2,700 MXN nativos → se deja en 17.5).
-- ============================================================================
-- (Este archivo se aplica como UNA transacción, igual que el resto de las
-- migraciones del repo: sin `begin/commit` explícitos — los pone el runner.)

-- ---------------------------------------------------------------------------
-- 1) Precisión: numeric(10,4) → numeric(12,6)
-- ---------------------------------------------------------------------------
alter table public.vuelo
  alter column tc_usd_mxn type numeric(12, 6);

alter table public.cobro_vuelo
  alter column tc_usd_mxn type numeric(12, 6);

alter table public.cobro_grupo
  alter column tc_usd_mxn type numeric(12, 6);

alter table public.vuelo_grupo
  alter column tc_usd_mxn type numeric(12, 6);

alter table public.cotizacion_version_history
  alter column tc_usd_mxn type numeric(12, 6);

alter table public.gasto
  alter column tc_gasto type numeric(12, 6);

comment on column public.vuelo.tc_usd_mxn is
  'Tipo de cambio MXN por USD de la COTIZACIÓN, 6 decimales (17-sep-2026). Es EXACTAMENTE el TC con el que el motor compuso monto_total_mxn: guardarlo con 4 decimales hacía que los lectores recalcularan un total distinto al que el cliente vio (caso #314). El total en pesos se LEE de monto_total_mxn (tc.util.ts::totalMxnDeVuelo), no se recalcula.';

comment on column public.cobro_vuelo.tc_usd_mxn is
  'TC del cobro, 6 decimales (17-sep-2026). Fuente de cobrosEnUsd: con 4 decimales, 100,000 MXN del vuelo #314 convertían a 5,885.26 USD en vez de 5,885.25.';

comment on column public.cobro_grupo.tc_usd_mxn is
  'TC del sobre de cobro del grupo, 6 decimales (17-sep-2026). Mismo contrato que cobro_vuelo.tc_usd_mxn; las partes heredan este valor.';

comment on column public.vuelo_grupo.tc_usd_mxn is
  'TC de la cotización del grupo, 6 decimales (17-sep-2026). Viaja tal cual al motor de cada hijo.';

comment on column public.cotizacion_version_history.tc_usd_mxn is
  'TC de la versión de la cotización, 6 decimales (17-sep-2026). Réplica exacta del TC con el que se compuso el total MXN de esa versión.';

comment on column public.gasto.tc_gasto is
  'TC del gasto, 6 decimales (17-sep-2026). Incluye el TC DERIVADO de la conciliación (cargo MXN ÷ gasto USD): con 4 decimales, 722.90 USD × 17.2244 no reproducía los 12,451.49 del estado de cuenta.';

-- ---------------------------------------------------------------------------
-- 2) BACKFILL: recuperar el TC original de los vuelos cuyo total ya no cuadra
-- ---------------------------------------------------------------------------
-- El total en pesos NO se toca nunca (es el número que el cliente vio y que
-- firmó): se corrige el TC para que vuelva a producirlo.
alter table public.vuelo disable trigger trg_vuelo_set_updated_at;

do $$
declare
  r            record;
  v_tc6        numeric(12, 6);
  v_recomp     numeric;
  n_corregidos int := 0;
  n_omitidos   int := 0;
  omitidos     text := '';
begin
  for r in
    select v.id,
           v.folio,
           v.monto_total_usd::numeric as u,
           v.monto_total_mxn::numeric as m,
           v.tc_usd_mxn::numeric      as t,
           coalesce((v.calculo_snapshot -> 'totales' ->> 'mxn_nativos')::numeric, 0) as nat,
           coalesce((v.calculo_snapshot -> 'totales' ->> 'usd_de_mxn')::numeric, 0)  as ude
      from public.vuelo v
     where v.monto_total_mxn is not null
       and v.monto_total_usd > 0
       and v.tc_usd_mxn > 0
       and abs(v.monto_total_mxn - round(v.monto_total_usd * v.tc_usd_mxn, 2)) >= 0.01
     order by v.folio
  loop
    -- Denominador = parte GENUINAMENTE en dólares del total (el resto son
    -- renglones nativos en pesos que nunca pasaron por el TC).
    if (r.u - r.ude) <= 0 then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(sin parte USD)', r.folio);
      continue;
    end if;

    v_tc6 := round((r.m - r.nat) / (r.u - r.ude), 6);
    v_recomp := round((r.u - r.ude) * v_tc6, 2) + r.nat;

    -- Solo se escribe si el TC recuperado es plausible Y reproduce el total
    -- persistido AL CENTAVO. Cualquier otra cosa se deja intacta.
    if v_tc6 < 10 or v_tc6 > 30 then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(TC %s fuera de banda)', r.folio, v_tc6);
      continue;
    end if;

    if v_recomp <> r.m then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(no recompone: %s vs %s)', r.folio, v_recomp, r.m);
      continue;
    end if;

    if v_tc6 is distinct from r.t then
      update public.vuelo set tc_usd_mxn = v_tc6 where id = r.id;
      n_corregidos := n_corregidos + 1;
    end if;
  end loop;

  raise notice 'TC 6 decimales · backfill: % vuelos con TC corregido.', n_corregidos;
  if n_omitidos > 0 then
    raise notice 'TC 6 decimales · % vuelos SIN tocar (revisar a mano):%', n_omitidos, omitidos;
  else
    raise notice 'TC 6 decimales · ningún vuelo quedó sin cuadrar.';
  end if;
end $$;

alter table public.vuelo enable trigger trg_vuelo_set_updated_at;
