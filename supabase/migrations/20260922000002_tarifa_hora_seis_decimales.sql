-- ============================================================================
-- TARIFA POR HORA CON 6 DECIMALES + BACKFILL DE LA TARIFA TRUNCADA (22-sep-2026)
-- ============================================================================
--
-- TERCER (y último) FACTOR DE LA MISMA FAMILIA. El invariante es uno solo:
-- **lo que se PERSISTE es EXACTAMENTE lo que se usó para MULTIPLICAR**.
--   · `20260917000002_tc_seis_decimales`          → T.C.  (vuelo #314)
--   · `20260922000001_horas_pactadas_ocho_decimales` → horas (#322 / #302)
--   · ESTA                                        → tarifa (#105)
--
-- EL DEFECTO (cotización #105, caso REAL de producción, COMPLETADO y cobrado
-- con dos cobros, sin CFDI): la oficina cerró el **SERVICIO AÉREO** de un
-- vuelo de 2.4 hr en $2,375.00 exactos tecleando la tarifa personalizada
-- **989.583333** (= 2,375 ÷ 2.4). El motor multiplicó con esa precisión
-- completa —2.4 × 989.583333 = 2,375.00— pero PERSISTIÓ la tarifa redondeada:
-- `round2` en `calculo_snapshot.tarifa.usd_por_hora` y `numeric(10,2)` en
-- `vuelo.tarifa_hora_usd` ⇒ **989.58**. Desde ahí, el panel y `quickAdjust`
-- REHIDRATAN la tarifa de esa columna/snapshot y recalculan:
--   2.4 × 989.58 = 2,374.99  ≠  2,375.00 persistido.
-- Reabrir la cotización #105 y guardarla SIN TOCAR NADA le bajaba un centavo.
-- Es, letra por letra, el mismo defecto de #322 por el otro factor.
--
-- OJO AL VERIFICAR (medido en prod el 22-sep-2026): los $2,375.00 son el
-- `subtotal_vuelo_usd`, NO el total del cliente. #105 lleva un descuento de
-- $200.00 (`ajuste_final_usd = -200.00`, `meta.descuento_usd = 200`) y $0 de
-- IVA, así que **`monto_total_usd` es $2,175.00**. Quien abra #105 tras el
-- backfill verá $2,175.00 en la barra de total y $2,375.00 en la línea de
-- «Servicio aéreo»: las dos cifras son las correctas. Con la tarifa truncada
-- el par caía a $2,374.99 / $2,174.99.
--
-- QUÉ HACE ESTA MIGRACIÓN
--   1. `numeric(10,2)` → `numeric(14,6)` en `vuelo.tarifa_hora_usd` y
--      `cotizacion_version_history.tarifa_hora_usd`, para que la BD pueda
--      guardar EXACTAMENTE el número con el que el motor multiplicó las
--      horas. 6 decimales bastan de sobra: el error máximo es 5e-7 USD/hr ×
--      48 hr (el tope del DTO) = 2.4e-5 USD, muy por debajo del centavo. Son
--      los mismos 6 del T.C., el otro precio unitario del sistema.
--   2. BACKFILL de los vuelos cuya TARIFA guardada ya no reproduce su propio
--      subtotal. Se recupera la tarifa original del subtotal persistido
--      (`subtotal ÷ horas`) y SOLO se escribe cuando las HORAS no pueden ser
--      la causa y la tarifa recuperada es puro truncamiento que reproduce el
--      subtotal AL CENTAVO. Se actualizan la columna Y el snapshot.
--
-- LO QUE **NO** HACE (a propósito):
--   · NO corrige dinero: el subtotal, el IVA y el total de #105 se quedan
--     como están (son los números que el cliente vio y ya se cobraron). Lo
--     que se corrige es el FACTOR, para que volver a multiplicar dé lo mismo.
--   · NO toca los CATÁLOGOS de tarifa —`aeronave.tarifa_hora_pub_usd`,
--     `aeronave.tarifa_hora_broker_usd`, `tarifa_cliente_aeronave
--     .tarifa_hora_usd`—: son precios de lista en pesos y centavos y se
--     quedan en `numeric(_,2)`. Su corolario, que usa el código: la ÚNICA
--     tarifa que puede traer más de 2 decimales es la personalizada de una
--     cotización.
--   · NO reescribe `cotizacion_version_history`: cada fila es el acta de lo
--     que se persistió ESE día y reescribirla borraría la evidencia del
--     defecto (mismo criterio que la migración de las horas). Solo se amplía
--     su columna para las versiones NUEVAS. Hoy 40 de sus 307 filas no
--     cuadran `horas × tarifa` contra su subtotal, casi todas por las horas
--     de la regla truncadas a 4 decimales.
--
-- ═════════════════════════════════════════════════════════════════════════
-- LA GUARDA QUE IMPORTA: distinguir «tarifa truncada» de «horas truncadas»
-- ═════════════════════════════════════════════════════════════════════════
-- Los 12 vuelos que hoy descuadran `round(horas × tarifa, 2) <> subtotal`
-- tienen DOS causas distintas y solo UNA es esta:
--
--   (a) ONCE son HORAS DE LA REGLA truncadas a 4 decimales por la precisión
--       vieja (millas ÷ velocidad + calzos), con tarifas REDONDAS de
--       catálogo: 650, 575, 900, 555, 600, 1600, 670, 850, 700, 1650, 950.
--       Su DINERO ES CORRECTO y el motor vuelve a derivar las horas completas
--       en el próximo guardado (pasan a 8 decimales solas). No se tocan.
--   (b) UNO —#105— es la TARIFA truncada. Es el único de este lote.
--
-- **EL FALSO POSITIVO**: #26 (h = 3.4273, t = 555.00, s = 1,902.14) también
-- «cuadraría» tratándolo como tarifa: t6 = 1,902.14 ÷ 3.4273 = 554.996645,
-- que está a 0.003355 de 555.00 (DENTRO de la tolerancia de 0.005) y
-- reproduce el subtotal al centavo. Corregirlo dejaría en la BD una tarifa
-- INVENTADA de $554.996645/hr para un vuelo cuya tarifa pactada es $555.00
-- clavados. La causa real de #26 son sus horas: 344 nm ÷ 110 kts + 0.30 =
-- 3.42727273 hr, y `round4` las dejó en 3.4273.
--
-- Lo que los separa es **la forma de las horas**:
--   · #26  h = 3.4273        → `round(h, 2) <> h` : las horas traen decimales
--                              más allá del centésimo ⇒ PUEDEN ser un
--                              `round4` truncado ⇒ no se adivina, se deja.
--   · #105 h = 2.40000000    → `round(h, 2)  = h` : las horas son exactas a 2
--                              decimales. Y el snapshot lo confirma:
--                              vuelo_hr 2.1 (= 315 nm ÷ 150 kts, exacto) +
--                              calzos 0.3 + sobrevuelo 0 = 2.4 clavado, sin
--                              un solo decimal perdido. Si las horas son
--                              exactas, el único factor que pudo truncarse
--                              es la tarifa.
--
-- **POR QUÉ NO SE USA `calculo_snapshot.tarifa.proviene_de_override`**: ese
-- flag solo dice «el panel mandó una tarifa en el DTO», y viaja en `true`
-- en 10 de los 12 candidatos, #26 incluido (tarifa $555.00 redonda). Usarlo
-- como criterio —y menos aún en un OR con la guarda de las horas— habría
-- «corregido» los 11 vuelos del grupo (a) inventándoles tarifas como
-- 554.996645 o 1,600.022693. Los campos REALES del snapshot son solo cuatro
-- (`tipo`, `usd_por_hora`, `proviene_de_override`, `preferencial_cliente`):
-- no hay ningún «origen» que distinga una tarifa tecleada con decimales.
--
-- TRIGGERS (verificado en prod bjesduasnzbzywofukbf el 22-sep-2026):
--   · `cotizacion_version_history` no tiene triggers (0 no internos).
--   · `trg_vuelo_calendar_sync` es `AFTER … UPDATE OF <lista>` y ni
--     `tarifa_hora_usd` ni `calculo_snapshot` están en la lista: el backfill
--     NO encola nada a Google Calendar.
--   · `vuelo_fecha_fin` es `UPDATE OF fecha_vuelo, fecha_traslado_final`: no
--     se dispara.
--   · `trg_vuelo_set_updated_at` es BEFORE UPDATE de TODA la fila: se APAGA
--     durante el backfill (mismo patrón que `20260917000002` y
--     `20260922000001`) para que `updated_at` no se mueva — lo lee el CAS de
--     las ediciones offline y moverlo provocaría 409 CONFLICTO_VERSION falsos
--     en la app. El DISABLE/ENABLE exige ser dueño de la tabla: el runner
--     (postgres) lo es.
--   · No hay CHECK, ni índices, ni vistas sobre estas dos columnas
--     (verificado con pg_constraint, pg_index y pg_depend: 0 filas).
--     Ambas son **NOT NULL y SIN default** (verificado en
--     information_schema el 22-sep-2026: `column_default` es null en las
--     dos) y así se quedan: `alter column … type` conserva nulabilidad y
--     default, y aquí no hay default que conservar. Todo escritor manda la
--     columna siempre (`camposDesdeBreakdown` es la fuente única fila←
--     breakdown), así que la ausencia de default no es un hueco — pero nadie
--     debe asumir que un insert sin la columna «cae en 0»: revienta con
--     23502. El valor máximo de hoy es 1,777.00 en las dos tablas, muy
--     dentro de los 8 dígitos enteros que numeric(14,6) conserva respecto de
--     numeric(10,2) (mismos 8: el ALTER no puede desbordar).
--
-- Tamaño (22-sep-2026): vuelo 289 filas (223 con tarifa > 0),
-- cotizacion_version_history 307. La reescritura de tabla del ALTER es
-- instantánea a esta escala.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (córrelo ANTES; no escribe nada, termina en rollback)
-- ---------------------------------------------------------------------------
-- begin;
--
-- -- (a) ANTES: cuántos vuelos con tarifa y cuántos descuadrados.
-- --     Esperado hoy: 223 con tarifa · 12 descuadrados.
-- select count(*) filter (where tarifa_hora_usd > 0) as con_tarifa,
--        count(*) filter (
--          where tarifa_hora_usd > 0 and tiempo_cobrable_hr > 0
--            and round(tiempo_cobrable_hr * tarifa_hora_usd, 2) <> subtotal_vuelo_usd
--        ) as descuadrados
--   from public.vuelo;
--
-- -- (b) DESPUÉS (simulado): el veredicto de CADA candidato, con la guarda que
-- --     separa a #105 de #26. Esperado: 1 «SE CORRIGE» (#105) y 11
-- --     «HORAS DE LA REGLA» (#6 #13 #22 #26 #27 #30 #62 #166 #192 #240 #312).
-- with cand as (
--   select folio, estado, cobrado, facturado,
--          tiempo_cobrable_hr as h, tarifa_hora_usd as t, subtotal_vuelo_usd as s,
--          round(subtotal_vuelo_usd / tiempo_cobrable_hr, 6) as t6
--     from public.vuelo
--    where tarifa_hora_usd > 0
--      and tiempo_cobrable_hr > 0
--      and round(tiempo_cobrable_hr * tarifa_hora_usd, 2) <> subtotal_vuelo_usd
-- )
-- select folio, estado, cobrado, facturado, h, t, t6, s,
--        round(h * t,  2) as con_t,
--        round(h * t6, 2) as con_t6,
--        abs(t6 - t)      as delta_tarifa,
--        case
--          when round(h, 2) <> h            then 'HORAS DE LA REGLA (se corrige al re-guardar)'
--          when abs(t6 - t) > 0.005         then 'SE DEJA IGUAL (delta fuera de tolerancia)'
--          when round(h * t6, 2) <> s       then 'SE DEJA IGUAL (no reproduce el subtotal)'
--          else                                  'SE CORRIGE'
--        end as veredicto
--   from cand order by folio;
--
-- -- (c) ENSAYO REAL DE LA MIGRACIÓN COMPLETA + reversa, como exige el repo
-- --     para todo lo que escribe. Se corre **el cuerpo de este archivo TAL
-- --     CUAL**, no una versión resumida: el backfill es un bloque `plpgsql`
-- --     y un error de tipo dentro de un `do $$` es INVISIBLE para cualquier
-- --     `select` (fue exactamente la forma del incidente del ENUM `moneda`
-- --     del 15-sep, que tumbó la conciliación al 37 %). Un ensayo que
-- --     reescribe una fila a mano prueba la COLUMNA, no el BACKFILL.
-- --     Los ALTER van DENTRO de este mismo `begin` — sin ellos la columna
-- --     sigue en `numeric(10,2)`, el UPDATE del bloque se guardaría otra vez
-- --     como 989.58 y el ensayo "demostraría" justo lo contrario de lo que
-- --     se quiere probar. Todo termina en rollback, ALTER incluido.
--
-- -- Foto ANTES de TODA la tabla (no solo de #105): así se prueba que los
-- -- otros 11 candidatos y los 277 vuelos restantes no se movieron, que el
-- -- DINERO no cambió en NINGUNA fila y que `updated_at` —que lee el CAS de
-- -- las ediciones offline— quedó intacto en TODAS.
-- create temp table _antes on commit drop as
--   select id, folio, tarifa_hora_usd as t_antes, updated_at as u_antes,
--          subtotal_vuelo_usd as s_antes, monto_total_usd as tot_antes,
--          iva_usd as iva_antes, monto_total_mxn as mxn_antes,
--          calculo_snapshot -> 'tarifa' ->> 'usd_por_hora' as snap_antes
--     from public.vuelo;
--
-- --  ▼▼▼  PEGA AQUÍ, TAL CUAL, LAS SECCIONES «1) Precisión» Y «2) BACKFILL»
-- --       DE ESTE MISMO ARCHIVO (los dos `alter … type`, el
-- --       `disable trigger`, el bloque `do $$ … $$` completo y el
-- --       `enable trigger`). Copiar, no reescribir: si el ensayo y lo que se
-- --       aplica divergen, el ensayo no prueba nada.
-- --       LEE LOS `NOTICE`: tienen que decir «1 vuelos corregidos» y
-- --       «11 vuelos son HORAS DE LA REGLA …» (#6 #13 #22 #26 #27 #30 #62
-- --       #166 #192 #240 #312) y «ningún vuelo quedó sin explicación».
-- --  ▲▲▲
--
-- -- Las CINCO cosas que se están probando, sobre TODA la tabla:
-- select
--   count(*) filter (where v.tarifa_hora_usd is distinct from a.t_antes)   as filas_cambiadas,
--   bool_and(v.tarifa_hora_usd = 989.583333)
--     filter (where a.folio = 105)                                        as columna_admite_6,
--   bool_and((v.calculo_snapshot -> 'tarifa' ->> 'usd_por_hora')::numeric
--            = v.tarifa_hora_usd)
--     filter (where a.folio = 105)                                        as snapshot_coincide,
--   bool_and(round(v.tiempo_cobrable_hr * v.tarifa_hora_usd, 2)
--            = v.subtotal_vuelo_usd)
--     filter (where a.folio = 105)                                        as reproduce_subtotal,
--   count(*) filter (where v.subtotal_vuelo_usd is distinct from a.s_antes
--                       or v.monto_total_usd   is distinct from a.tot_antes
--                       or v.iva_usd           is distinct from a.iva_antes
--                       or v.monto_total_mxn   is distinct from a.mxn_antes) = 0
--                                                                         as dinero_intacto,
--   count(*) filter (where v.updated_at is distinct from a.u_antes) = 0    as updated_at_intacto
--   from public.vuelo v join _antes a on a.id = v.id;
-- -- Esperado: filas_cambiadas = 1 y las CINCO banderas en `t`.
-- -- Cualquier `f` —o filas_cambiadas <> 1— PARA la aplicación.
--
-- -- Y la lista nominal: quién cambió y quién no.
-- select a.folio, a.t_antes, v.tarifa_hora_usd as t_despues,
--        a.snap_antes, v.calculo_snapshot -> 'tarifa' ->> 'usd_por_hora' as snap_despues
--   from public.vuelo v join _antes a on a.id = v.id
--  where a.folio in (6, 13, 22, 26, 27, 30, 62, 105, 166, 192, 240, 312)
--  order by a.folio;
-- -- Esperado: SOLO #105 pasa de 989.58 a 989.583333 (columna y snapshot
-- -- JUNTOS); los otros 11 salen con t_antes = t_despues. En particular #26
-- -- (3.4273 hr @ $555.00) tiene que quedarse en 555.00: «cuadraría» con
-- -- 554.996645 y lo salva la guarda `round(horas, 2) = horas`.
--
-- rollback;
-- ---------------------------------------------------------------------------
-- Estado medido en prod el 22-sep-2026 (consultas read-only, sin escribir):
--   223 vuelos con tarifa > 0 · 12 descuadrados · 1 corregido · 11 intactos.
--   SE CORRIGE:
--     #105  989.58 → 989.583333   (2.40 hr, subtotal 2,375.00, descuento
--                                  -200.00, IVA 0 ⇒ total 2,175.00;
--                                  COMPLETADO, cobrado, sin CFDI)
--     Sus 2.4 hr salen de la REGLA (el snapshot no trae
--     `cobrable_proviene_de_override`): vuelo_hr 2.1 + calzos 0.3 = 2.4
--     CLAVADO, así que `round4` no les quitó nada y la guarda 1 lo deja
--     pasar con razón — el único factor que pudo truncarse es la tarifa.
--   SE DEJAN IGUAL — «horas de la regla, se corrigen al re-guardar»:
--     #6 (650) #13 (575) #22 (900) #26 (555) #27 (600) #30 (1,600) #62 (670)
--     #166 (850) #192 (700) #240 (1,650) #312 (950)
--   Ninguno de los 12 lleva comisión de vendedor POR_HORA, que rompería la
--   relación subtotal = horas × tarifa. (Los 6 vuelos con comisión POR_HORA
--   de la base cuadran todos: el motor ya redondea ESA tarifa a 2 decimales
--   ANTES de multiplicar, así que ahí no existe el defecto — ver el spec
--   `quotes.service.tarifa.spec.ts`, que lo congela.)
-- ============================================================================
-- (Este archivo se aplica como UNA transacción, igual que el resto de las
-- migraciones del repo: sin `begin/commit` explícitos — los pone el runner.)

-- ---------------------------------------------------------------------------
-- 1) Precisión: numeric(10,2) → numeric(14,6)
-- ---------------------------------------------------------------------------
alter table public.vuelo
  alter column tarifa_hora_usd type numeric(14, 6);

alter table public.cotizacion_version_history
  alter column tarifa_hora_usd type numeric(14, 6);

comment on column public.vuelo.tarifa_hora_usd is
  'Tarifa por hora de la cotización, 6 decimales (22-sep-2026). Es EXACTAMENTE el número con el que el motor multiplicó tiempo_cobrable_hr para componer subtotal_vuelo_usd: guardarla con 2 decimales hacía que reabrir y guardar la cotización bajara el total ($2,375.00 → $2,374.99 en #105, tarifa tecleada 989.583333 para cerrar 2.4 hr en $2,375.00). Fuente única src/common/tarifa.util.ts (round6/normalizarTarifa). Los CATÁLOGOS (aeronave.tarifa_hora_*, tarifa_cliente_aeronave) siguen en 2 decimales a propósito.';

comment on column public.cotizacion_version_history.tarifa_hora_usd is
  'Tarifa por hora de ESA versión de la cotización, 6 decimales (22-sep-2026). Mismo contrato que vuelo.tarifa_hora_usd; las filas anteriores conservan sus 2 decimales a propósito (son el acta de lo que se persistió ese día).';

-- ---------------------------------------------------------------------------
-- 2) BACKFILL: recuperar la tarifa que la BD truncó
-- ---------------------------------------------------------------------------
-- El DINERO NO se toca nunca (es el número que el cliente vio y pagó): se
-- corrige el FACTOR para que volver a multiplicarlo dé lo mismo.
alter table public.vuelo disable trigger trg_vuelo_set_updated_at;

do $$
declare
  r             record;
  v_t6          numeric(14, 6);
  n_corregidos  int  := 0;
  n_regla       int  := 0;
  n_omitidos    int  := 0;
  regla         text := '';
  omitidos      text := '';
begin
  for r in
    select v.id,
           v.folio,
           v.tiempo_cobrable_hr::numeric as horas,
           v.tarifa_hora_usd::numeric    as tarifa,
           v.subtotal_vuelo_usd::numeric as subtotal,
           (v.calculo_snapshot -> 'tarifa') is not null as tiene_snap_tarifa
      from public.vuelo v
     where v.tarifa_hora_usd > 0
       and v.tiempo_cobrable_hr > 0
       and round(v.tiempo_cobrable_hr * v.tarifa_hora_usd, 2) <> v.subtotal_vuelo_usd
     order by v.folio
  loop
    -- GUARDA 1 — LAS HORAS NO PUEDEN SER LA CAUSA. Unas horas con decimales
    -- más allá del centésimo pueden ser el `round4` truncado de la regla
    -- (millas ÷ velocidad), y entonces el factor que hay que recuperar es
    -- ESE, no la tarifa. Sin esta guarda, #26 (3.4273 hr @ $555.00) pasaría
    -- las dos siguientes y se quedaría con una tarifa inventada de
    -- $554.996645/hr. Esos vuelos se arreglan solos: el motor vuelve a
    -- derivar sus horas completas en el próximo guardado.
    if round(r.horas, 2) <> r.horas then
      n_regla := n_regla + 1;
      regla := regla || format(' #%s(%s hr × $%s)', r.folio, r.horas, r.tarifa);
      continue;
    end if;

    v_t6 := round(r.subtotal / r.horas, 6);

    -- GUARDA 2: la diferencia tiene que ser PURO TRUNCAMIENTO (media unidad
    -- del 2.º decimal). Más que eso significa otra causa (tarifa cambiada a
    -- mano después, precio pactado, comisión POR_HORA…) y ahí no se adivina.
    if abs(v_t6 - r.tarifa) > 0.005 then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(delta %s USD/hr)', r.folio, abs(v_t6 - r.tarifa));
      continue;
    end if;

    -- GUARDA 3: la tarifa recuperada tiene que reproducir el subtotal AL
    -- CENTAVO. Si no, el subtotal no era horas × tarifa y no se toca.
    if round(r.horas * v_t6, 2) <> r.subtotal then
      n_omitidos := n_omitidos + 1;
      omitidos := omitidos || format(' #%s(no reproduce: %s vs %s)', r.folio,
                                     round(r.horas * v_t6, 2), r.subtotal);
      continue;
    end if;

    -- La columna Y el snapshot, juntos: el panel rehidrata el snapshot y
    -- `tarifaPersistida` lee ambos — dejar uno truncado revive el bug.
    update public.vuelo
       set tarifa_hora_usd = v_t6,
           calculo_snapshot = case
             when r.tiene_snap_tarifa
               then jsonb_set(calculo_snapshot, '{tarifa,usd_por_hora}', to_jsonb(v_t6))
             else calculo_snapshot
           end
     where id = r.id;
    n_corregidos := n_corregidos + 1;
  end loop;

  raise notice 'Tarifa 6 decimales · backfill: % vuelos corregidos.', n_corregidos;
  if n_regla > 0 then
    raise notice 'Tarifa 6 decimales · % vuelos son HORAS DE LA REGLA truncadas (dinero correcto, se corrigen solos al re-guardar la cotización):%', n_regla, regla;
  end if;
  if n_omitidos > 0 then
    raise notice 'Tarifa 6 decimales · % vuelos SIN tocar (revisar a mano):%', n_omitidos, omitidos;
  else
    raise notice 'Tarifa 6 decimales · ningún vuelo quedó sin explicación.';
  end if;
end $$;

alter table public.vuelo enable trigger trg_vuelo_set_updated_at;
