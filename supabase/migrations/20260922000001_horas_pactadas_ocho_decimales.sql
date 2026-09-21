-- ============================================================================
-- HORAS PACTADAS CON 8 DECIMALES + BACKFILL DE LAS HORAS TRUNCADAS (22-sep-2026)
-- ============================================================================
--
-- PEDIDO DEL CLIENTE (capturas del cotizador, 22-sep-2026): la MISMA
-- cotización —XB-PEV, CUN→PTU→CUN, tarifa personalizada $600/hr, «Cobrable
-- pactado» 2.333333333 hr (= 2 h 20 min)— muestra dos totales distintos:
--   · #322 «Cobrable pactado 2.333333333» → subtotal $1,399.98 · total $1,623.98
--   · #302 «Tiempo cobrable 2.3333 hr · pactado a mano» → $1,400.00 · $1,624.00
--   «no me lo redondea en la primer captura de la cotización 322. aquí sí en
--    la segunda captura de la cotización 302. revisa ese error y corrígelo»
--
-- CAUSA RAÍZ (misma familia que el T.C. de 4 decimales, 17-sep): el motor
-- multiplica con la precisión COMPLETA que tecleó la oficina
-- (2.333333333 × 600 = 1,400.00) pero PERSISTE las horas redondeadas —
-- `round4` en `calculo_snapshot.tiempos.cobrable_hr` y `numeric(10,4)` en
-- `vuelo.tiempo_cobrable_hr`—. El panel REHIDRATA el pactado desde ese
-- snapshot al reabrir la cotización: 2.3333 × 600 = 1,399.98, y al guardar el
-- descuadre queda PERSISTIDO. Historial real:
--   #322 v1 = 1,400.00 / 1,624.00 (18-sep 17:07) → v2 = 1,399.98 / 1,623.98
--        (17:16) con las MISMAS horas 2.3333 y la MISMA tarifa.
--   #302 v1 = 1,400.00 → v2 = 1,399.98 → v3 = 1,400.00 (alguien volvió a
--        teclear los decimales a mano).
--
-- QUÉ HACE ESTA MIGRACIÓN
--   1. `numeric(10,4)` → `numeric(14,8)` en `vuelo.tiempo_cobrable_hr` y
--      `cotizacion_version_history.tiempo_cobrable_hr`, para que la BD pueda
--      guardar EXACTAMENTE el número con el que el motor multiplicó la
--      tarifa (invariante 22: lo que se persiste es lo que se usó para
--      multiplicar). 8 decimales bastan para que un h:mm reproduzca el
--      centavo a cualquier tarifa: 2.33333333 × 9,750 = $22,750.00 exacto,
--      donde 2.3333 daba $22,749.68.
--   2. BACKFILL de los vuelos con horas PACTADAS a mano cuyas horas guardadas
--      ya no reproducen su propio subtotal. Se recupera la hora original del
--      subtotal persistido (`subtotal ÷ tarifa`) y SOLO se escribe si la
--      diferencia con lo guardado es puro truncamiento (≤ 0.00005 hr, media
--      unidad del 4.º decimal) Y esa hora reproduce el subtotal AL CENTAVO.
--      Se actualizan la columna Y el snapshot. Lo que no cumpla se deja
--      intacto y se lista en un `raise notice`.
--
-- LO QUE **NO** HACE (a propósito):
--   · NO corrige dinero ya persistido. #322 quedó guardado en $1,399.98 /
--     $1,623.98 y así se queda: ese vuelo se re-guarda desde el panel (sin
--     cobros, sin CFDI) y el motor nuevo lo devuelve a $1,400.00. Un total
--     que el cliente vio no se mueve desde una migración.
--   · NO toca `cotizacion_version_history`: cada fila es el acta de lo que se
--     persistió ESE día; reescribirla borraría la evidencia del defecto. Solo
--     se amplía su columna para las versiones NUEVAS.
--   · NO toca los vuelos cuyas horas salen de la REGLA (millas ÷ velocidad):
--     su dinero es correcto y el motor las recalcula completas en el próximo
--     guardado (pasan a 8 decimales solas). Se listan abajo como referencia.
--
-- TRIGGERS (verificado en prod bjesduasnzbzywofukbf el 22-sep-2026):
--   · `cotizacion_version_history` no tiene triggers.
--   · `trg_vuelo_calendar_sync` es `AFTER … UPDATE OF <lista>` y ni
--     `tiempo_cobrable_hr` ni `calculo_snapshot` están en la lista: el
--     backfill NO encola nada a Google Calendar.
--   · `vuelo_fecha_fin` es `UPDATE OF fecha_vuelo, fecha_traslado_final`: no
--     se dispara.
--   · `trg_vuelo_set_updated_at` es BEFORE UPDATE de TODA la fila: se APAGA
--     durante el backfill (mismo patrón que `20260917000002`) para que
--     `updated_at` no se mueva — lo usa el CAS de las ediciones offline y
--     moverlo provocaría 409 CONFLICTO_VERSION falsos en la app. El
--     DISABLE/ENABLE exige ser dueño de la tabla: el runner (postgres) lo es.
--   · No hay CHECK ni índices ni vistas sobre estas columnas (verificado con
--     pg_constraint y pg_depend). `ALTER COLUMN TYPE` conserva y revalida los
--     CHECK si algún día los hubiera. Ambas columnas son NOT NULL sin default
--     y así se quedan.
--
-- Tamaño (22-sep-2026): vuelo 288 filas, cotizacion_version_history 305. La
-- reescritura de tabla del ALTER es instantánea a esta escala.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (córrelo ANTES; no escribe nada, termina en rollback)
-- ---------------------------------------------------------------------------
-- begin;
--
-- -- (a) ANTES: cuántos vuelos con horas PACTADAS a mano y cuántos con el
-- --     subtotal descuadrado respecto a sus horas guardadas.
-- select count(*) as pactados,
--        count(*) filter (
--          where round(tiempo_cobrable_hr * tarifa_hora_usd, 2) <> subtotal_vuelo_usd
--        ) as descuadrados
--   from public.vuelo
--  where (calculo_snapshot -> 'tiempos' ->> 'cobrable_proviene_de_override') = 'true'
--    and tarifa_hora_usd > 0;
--
-- -- (b) DESPUÉS (simulado): qué hora quedaría en cada uno y si cuadra.
-- with base as (
--   select folio, estado, cobrado, facturado,
--          tiempo_cobrable_hr as h4,
--          tarifa_hora_usd    as tarifa,
--          subtotal_vuelo_usd as subtotal,
--          round(subtotal_vuelo_usd / tarifa_hora_usd, 8) as h8
--     from public.vuelo
--    where (calculo_snapshot -> 'tiempos' ->> 'cobrable_proviene_de_override') = 'true'
--      and tarifa_hora_usd > 0
--      and round(tiempo_cobrable_hr * tarifa_hora_usd, 2) <> subtotal_vuelo_usd
-- )
-- select folio, estado, cobrado, facturado, h4, h8, tarifa, subtotal,
--        round(h4 * tarifa, 2) as con_h4,
--        round(h8 * tarifa, 2) as con_h8,
--        abs(h8 - h4)          as delta_hr,
--        case when abs(h8 - h4) <= 0.00005 and round(h8 * tarifa, 2) = subtotal
--             then 'SE CORRIGE' else 'SE DEJA IGUAL' end as veredicto
--   from base
--  order by folio;
--
-- -- (c) Ensayo REAL del UPDATE (una fila) + reversa, como exige el repo para
-- --     todo lo que escribe. OJO (revisión adversaria 22-sep): el ALTER va
-- --     DENTRO de este mismo `begin` — sin él la columna sigue siendo
-- --     `numeric(10,4)`, el UPDATE de prueba se guardaría como 2.3333 y el
-- --     ensayo "demostraría" justo lo contrario de lo que se quiere probar.
-- --     Todo termina en rollback, ALTER incluido.
-- alter table public.vuelo
--   alter column tiempo_cobrable_hr type numeric(14, 8);
-- alter table public.cotizacion_version_history
--   alter column tiempo_cobrable_hr type numeric(14, 8);
--
-- -- Foto ANTES (para comparar `updated_at`, que el CAS de la app lee).
-- create temp table _antes on commit drop as
--   select id, folio, tiempo_cobrable_hr as h_antes, updated_at as u_antes,
--          calculo_snapshot -> 'tiempos' ->> 'cobrable_hr' as snap_antes
--     from public.vuelo where folio = 302;
--
-- alter table public.vuelo disable trigger trg_vuelo_set_updated_at;
-- update public.vuelo v
--    set tiempo_cobrable_hr = 2.33333333,
--        calculo_snapshot = jsonb_set(
--          v.calculo_snapshot, '{tiempos,cobrable_hr}',
--          to_jsonb(2.33333333::numeric(14, 8))
--        )
--   from _antes a
--  where v.id = a.id;
-- alter table public.vuelo enable trigger trg_vuelo_set_updated_at;
--
-- -- Las tres cosas que se están probando, en una sola fila de resultado:
-- select a.folio, a.h_antes, v.tiempo_cobrable_hr as h_despues,
--        v.calculo_snapshot -> 'tiempos' ->> 'cobrable_hr' as snap_despues,
--        v.tiempo_cobrable_hr = 2.33333333                as columna_admite_8,
--        (v.calculo_snapshot -> 'tiempos' ->> 'cobrable_hr')::numeric
--          = v.tiempo_cobrable_hr                          as snapshot_coincide,
--        v.updated_at = a.u_antes                          as updated_at_intacto
--   from public.vuelo v join _antes a on a.id = v.id;
-- -- Se esperan las tres columnas en `t`. Cualquier `f` PARA la aplicación.
--
-- rollback;
-- ---------------------------------------------------------------------------
-- Estado medido en prod el 22-sep-2026 (consultas read-only, sin escribir):
--   84 vuelos con horas PACTADAS a mano y tarifa > 0 · 12 descuadrados · 0
--   omitidos: los 12 cumplen las dos guardas (delta ≤ 0.00005 hr y la hora
--   recuperada reproduce el subtotal al centavo) y ninguno lleva comisión de
--   vendedor POR_HORA (que rompería la relación subtotal = horas × tarifa).
--   Folios y hora que queda (todos «dinero correcto, horas truncadas»):
--     #188 1.1538 → 1.15384615 (650/hr, 750.00)
--     #222 1.1538 → 1.15384615 (650/hr, 750.00)
--     #242 0.7895 → 0.78947368 (950/hr, 750.00)
--     #254 2.3333 → 2.33333333 (600/hr, 1,400.00)
--     #255 2.3333 → 2.33333333 (600/hr, 1,400.00)
--     #261 0.7895 → 0.78947368 (950/hr, 750.00, CANCELADO)
--     #267 0.7895 → 0.78947368 (950/hr, 750.00)
--     #280 2.5385 → 2.53846154 (650/hr, 1,650.00)
--     #301 2.3333 → 2.33333333 (600/hr, 1,400.00)
--     #302 2.3333 → 2.33333333 (600/hr, 1,400.00)
--     #309 3.2970 → 3.29696970 (1,650/hr, 5,440.00)
--     #313 3.2095 → 3.20949231 (650/hr, 2,086.17, hijo de grupo)
--   #322 NO entra (su subtotal ya está dañado: 2.3333 × 600 = 1,399.98 SÍ
--   cuadra con lo guardado) — se corrige re-guardándolo desde el panel.
--   Fuera de alcance, para referencia: 12 vuelos más tienen las horas de la
--   REGLA truncadas (#6 #13 #22 #26 #27 #30 #62 #166 #192 #240 #312) con el
--   dinero correcto —se re-derivan solas al guardar—, y #105 descuadra por la
--   TARIFA (2.4 × 989.583333 = 2,375.00 persistido con tarifa 989.58, que es
--   numeric(10,2)): ese caso necesita su propia decisión y NO se toca aquí.
-- ============================================================================
-- (Este archivo se aplica como UNA transacción, igual que el resto de las
-- migraciones del repo: sin `begin/commit` explícitos — los pone el runner.)

-- ---------------------------------------------------------------------------
-- 1) Precisión: numeric(10,4) → numeric(14,8)
-- ---------------------------------------------------------------------------
alter table public.vuelo
  alter column tiempo_cobrable_hr type numeric(14, 8);

alter table public.cotizacion_version_history
  alter column tiempo_cobrable_hr type numeric(14, 8);

comment on column public.vuelo.tiempo_cobrable_hr is
  'Horas COBRABLES de la cotización, 8 decimales (22-sep-2026). Es EXACTAMENTE el número con el que el motor multiplicó tarifa_hora_usd para componer subtotal_vuelo_usd: guardarlas con 4 decimales hacía que reabrir y guardar la cotización bajara el total ($1,400.00 → $1,399.98 en #322, pactado 2:20 = 2.33333333 hr). Fuente única src/common/horas.util.ts (round8/normalizarHoras).';

comment on column public.cotizacion_version_history.tiempo_cobrable_hr is
  'Horas cobrables de ESA versión de la cotización, 8 decimales (22-sep-2026). Mismo contrato que vuelo.tiempo_cobrable_hr; las filas anteriores conservan sus 4 decimales a propósito (son el acta de lo que se persistió ese día).';

-- ---------------------------------------------------------------------------
-- 2) BACKFILL: recuperar las horas pactadas que la BD truncó
-- ---------------------------------------------------------------------------
-- El DINERO NO se toca nunca (es el número que el cliente vio): se corrigen
-- las HORAS para que vuelvan a producirlo.
alter table public.vuelo disable trigger trg_vuelo_set_updated_at;

do $$
declare
  r            record;
  v_h8         numeric(14, 8);
  n_corregidos int  := 0;
  n_omitidos   int  := 0;
  omitidos     text := '';
begin
  for r in
    select v.id,
           v.folio,
           v.tiempo_cobrable_hr::numeric as h4,
           v.tarifa_hora_usd::numeric    as tarifa,
           v.subtotal_vuelo_usd::numeric as subtotal
      from public.vuelo v
     where v.calculo_snapshot is not null
       and (v.calculo_snapshot -> 'tiempos' ->> 'cobrable_proviene_de_override') = 'true'
       and v.tarifa_hora_usd > 0
       and round(v.tiempo_cobrable_hr * v.tarifa_hora_usd, 2) <> v.subtotal_vuelo_usd
     order by v.folio
  loop
    v_h8 := round(r.subtotal / r.tarifa, 8);

    -- GUARDA 1: la diferencia tiene que ser PURO TRUNCAMIENTO (media unidad
    -- del 4.º decimal). Más que eso significa otra causa (tarifa cambiada,
    -- comisión POR_HORA, precio pactado…) y ahí no se adivina.
    if abs(v_h8 - r.h4) > 0.00005 then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(delta %s hr)', r.folio, abs(v_h8 - r.h4));
      continue;
    end if;

    -- GUARDA 2: la hora recuperada tiene que reproducir el subtotal AL
    -- CENTAVO. Si no, el subtotal no era horas × tarifa y no se toca.
    if round(v_h8 * r.tarifa, 2) <> r.subtotal then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(no reproduce: %s vs %s)', r.folio,
                                     round(v_h8 * r.tarifa, 2), r.subtotal);
      continue;
    end if;

    -- La columna Y el snapshot, juntos: el panel rehidrata el snapshot y
    -- `horasPactadasPersistidas` lee ambos — dejar uno truncado revive el bug.
    update public.vuelo
       set tiempo_cobrable_hr = v_h8,
           calculo_snapshot = jsonb_set(
             calculo_snapshot, '{tiempos,cobrable_hr}', to_jsonb(v_h8)
           )
     where id = r.id;
    n_corregidos := n_corregidos + 1;
  end loop;

  raise notice 'Horas pactadas 8 decimales · backfill: % vuelos corregidos.', n_corregidos;
  if n_omitidos > 0 then
    raise notice 'Horas pactadas 8 decimales · % vuelos SIN tocar (revisar a mano):%', n_omitidos, omitidos;
  else
    raise notice 'Horas pactadas 8 decimales · ningún vuelo quedó sin cuadrar.';
  end if;
end $$;

alter table public.vuelo enable trigger trg_vuelo_set_updated_at;
