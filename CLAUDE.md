# CLAUDE.md — vuelatour-api

Reglas e invariantes de este repo. Romper cualquiera de estas corrompe números
del cierre mensual del cliente (fiabilidad = requisito #1 del proyecto).

## Invariantes de datos (NO romper)

1. **Horas de motor/hélice/overhaul son SIEMPRE DERIVADAS de las escalas.**
   `horas vivas = horas_totales + max(0, hobbs − aeronave_horas_ref)`; la
   reserva mostrada = base manual + `horasVoladas()` (suma de
   `taco_llegada − taco_salida`). NUNCA reintroducir incrementos al completar
   un vuelo (el viejo `advanceComponentHours` contaba doble y los ajustes de
   taco post-COMPLETADO no se reflejaban). Al escribir `horas_totales` desde
   `engines.service`, SIEMPRE re-anclar `aeronave_horas_ref` al hobbs actual.

2. **`cobrosEnUsd` (`src/common/cobros-usd.util.ts`) es LA única fuente de
   "cuánto se cobró en USD".** La usan: `refreshCobradoFlag`, el reporte por
   vuelo, `profit-sharing.compute`, el pre-cierre y `quotes.revise` (réplica
   local para evitar dependencia circular). Un cobro MXN sin TC toma
   `vuelo.tc_usd_mxn` de respaldo; si aún así no convierte, se EXPONE en
   `sin_tc_*` — jamás desaparece en silencio ni se suma crudo como USD.

3. **Desglose canónico del cotizador v1.3**: cada componente se redondea antes
   de sumar y `subtotal + tuas + pernocta + extras + ajuste + iva == total`
   exacto. No tocar ese orden de redondeo.

4. **Cortes de periodo SIEMPRE en hora Cancún**: filtros sobre columnas
   timestamptz usan `${fecha}T00:00:00-05:00` / `${fecha}T23:59:59-05:00`.
   Nunca `T23:59:59` a secas (se interpreta UTC y mueve vuelos de mes).

5. **Tacómetros — una foto por escala (solo LLEGADA)**:
   - **PRINCIPIO RECTOR (política del cliente, 25 jul 2026): el sistema NUNCA
     escribe valores ESTIMADOS (por promedio): las estimaciones son
     alertas/recomendaciones** — push `recordatorio_taco` al piloto del tramo
     vencido (`deduceTacosEnVivo`, cada 10 min, dedupe
     `taco_vencido_<escala_id>` en `alerta_emitida`), resumen nocturno
     `alerta_sistema` a ADMIN/COORDINADOR (`fillTacoGapsDelDia`) y
     `llegada_estimada`/`minutos_promedio` calculadas AL VUELO en taco-live
     (jamás persistidas) para que oficina las use al Ajustar. Solo se
     escriben COPIAS de lecturas reales: propagación de llegada real → salida
     siguiente, y salida del tramo 1 ← último taco real del avión (identidades
     físicas — el horómetro no se mueve con el avión apagado; sin ellas se
     rompe "una foto por escala"). Un vuelo sin llegadas REALES no se completa
     solo: lo cierra el piloto con su foto o la oficina en taco-live — el cron
     zombi lo deja EN_VUELO (`complete()` exige llegadas) y lo vigilan la
     alerta de "sigue EN VUELO" y el pre-cierre. (Antes el cron fabricaba
     lecturas con promedios y chocaban con las fotos de los pilotos.)
   - La salida se llena sola con copias, no estimados: tramo 1 ← último taco
     del avión (en `start()` y en `captureTaco`); tramos 2+ ← propagación de
     la llegada anterior (`propagarLlegadaASalidaSiguiente` y `fillTacoGaps`).
   - Los DEDUCIDO ya persistidos (históricos y las copias provisionales)
     conservan sus reglas: **un valor DEDUCIDO es una promesa provisional,
     jamás un candado contra la evidencia real — la evidencia SIEMPRE gana,
     el deducido CEDE.** Concretamente: la monotonía ("el taco nunca
     retrocede") NO aplica contra un DEDUCIDO (la foto del piloto lo corrige
     hacia abajo, salida Y llegada); si una llegada real contradice una
     salida DEDUCIDA (llegada ≤ salida), la salida CEDE (se pone en null +
     `revision_requerida` y la propagación u oficina la rellenan — el CHECK
     de BD tolera salida null). Una violación de CHECK (23514) en captura
     responde 409, nunca 500 (un 500 dispara el reintento del outbox de la
     app). Historia que motivó estas guardas y la política de jul 2026 — caso
     vuelo #73: la deducción en vivo fabricó un tramo fantasma de 0.4 h y el
     piloto no podía guardar su llegada real.
   - Una salida DEDUCIDA es PROVISIONAL: la llegada real del tramo anterior
     la CORRIGE al propagarse (guarda atómica por origen). Capturas reales
     (PILOTO/OFICINA/IA) no se pisan jamás (caso vuelo #71, jul 2026: el cron
     dedujo la salida del tramo 2 antes de existir la llegada del tramo 1).
   - EXCEPCIÓN (jul 2026, ampliada ago 2026): en el TRAMO 1 y en el PRIMER
     tramo de cada ROTACIÓN (tramo cuyo piloto difiere del anterior — cambio
     de piloto a media jornada, caso #129) el piloto sí puede fotografiar la
     salida; su captura PILOTO puede corregir hacia abajo una salida DEDUCIDO
     (la foto es evidencia; PILOTO/OFICINA no se bajan). El server nunca
     restringió la salida por orden — el gate es de la app. Si la llegada
     real del tramo anterior luego NO coincide con esa salida fotografiada,
     la propagación NO la pisa: marca el tramo en amarillo (misma aguja).
   - CORRECCIÓN A LA BAJA (17 ago 2026): una lectura PROPIA (origen
     PILOTO/IA) SÍ puede corregirse hacia abajo desde la app en vuelos de
     ≤7 días (el piloto se equivoca y la foto real es menor) — JAMÁS en
     silencio: amarillo ATÓMICO (en el mismo update del valor) y PEGAJOSO
     (chunk `CORRECCION_BAJA_PREFIX` que `applyConsistencyFlag` conserva
     entre recálculos; solo `confirmTaco` lo retira) + valor anterior en la
     bitácora. Lo de origen OFICINA no se mueve desde la app en NINGUNA
     dirección (y reenviar el MISMO valor no degrada el sello a PILOTO).
     TODO escritor directo de `revision_motivo` usa `motivoDirecto`
     (conserva chunks pegajosos + bitácora) o el siguiente recálculo pone
     verde sin revisión. Al bajar una llegada (piloto u oficina),
     `resincronizarAnclasDeCorreccion` re-ancla las salidas DEDUCIDAS de
     vuelos POSTERIORES del avión ancladas al valor viejo.
   - `taco_salida_origen`/`taco_llegada_origen` ∈ {PILOTO, IA, DEDUCIDO,
     OFICINA} se setean en TODOS los caminos de escritura. No perderlos.
   - El avión de un tramo se resuelve CON HERENCIA en todos los caminos de
     tacos: `escala.aeronave_id ?? vuelo.aeronave_id`. Comparar el id crudo
     (null vs id explícito del mismo avión) apaga propagación/anclas en
     silencio (caso #116: tramo ferry heredado se quedó sin salida).
   - `start()` NUNCA bloquea por tacómetro; `complete()` solo exige LLEGADAS
     (`faltanLlegadas`) — las salidas son del sistema.
   - La lectura IA de sync offline queda amarilla (`revision_requerida`) y no
     se propaga sin confirmación; `confirmTaco` notifica al piloto.

6. **Cotización vs operación**: si `vuelo.itinerario_operativo = true`,
   `quotes.replaceEscalas` hace early-return (la cotización JAMÁS pisa las
   escalas del piloto). `replaceEscalas` es UPSERT: no destruye tacos.

7. **Conciliación**: auto-match solo `medio_pago IN (TARJETA_CORP,
   TRANSFERENCIA, PAYWISE)` + moneda de la cuenta (PAYWISE es bancario desde
   el 2-sep-2026; caja chica sigue mirando SOLO EFECTIVO). `BODEGA` (cargo
   contable de inventario), `EFECTIVO` (caja chica) y `PERSONAL_*`
   (reintegros) nunca se cruzan con el banco. ABONOS se cruzan con
   `cobro_vuelo` vía `movimiento_bancario.cobro_id`.
   **PAYWISE como MÉTODO DE COBRO (9-sep-2026)**: fuente única de
   etiquetas/conjuntos `src/common/metodo-cobro.util.ts`
   (`METODOS_COBRO_ABONO_AUTO` = TRANSFERENCIA, HSBC_LINK, CHEQUE, PAYWISE;
   `+BILLPOCKET` manual). IVA como BillPocket (0 % por default), FormaPago
   SAT 04, facturable pre-cobro, FUERA de la whitelist del piloto. Comisión
   BANCARIA del cobro (bruto en `monto`, neto por diferencia): sin comisión
   capturada, `createCobro`/sobre provisionan `paywise_comision_pct`
   (config, 8.857) — un 0 explícito = sin comisión. `cuenta_bancaria.tipo`
   = BANCO | PASARELA; los abonos de PASARELA traen
   `movimiento_bancario.monto_bruto/comision_monto` (`monto` = NETO) y se
   cruzan con `cruzarPaywise` (`conciliacion/paywise-cruce.util.ts`, puro:
   ±5 días, NETO exacto → BRUTO exacto → REFERENCIA; referencia con monto
   distinto NUNCA se liga sola; empate = ambiguo). Al ligar un cobro de
   vuelo se escribe la comisión REAL del archivo (antes de `linkCobro`);
   los sobres no se reescriben. Auditoría: `GET /conciliacion/paywise/
   auditoria` (lectura), `POST …/auditoria/conciliar` (liga lo que cuadra),
   `GET …/auditoria.xlsx` (3 hojas). `GET /conciliacion/cobros-sin-banco`
   = espejo de gastos-sin-banco; el pre-cierre lo expone como aviso
   `cobros_bancarios_sin_conciliar` (no bloquea).

8. **Inventario→gastos**: una SALIDA de cardex genera gasto `REFACCION` medio
   `BODEGA` (costo FIFO; en **MXN** cuando TODAS las capas consumidas se
   compraron en pesos — moneda operativa del cliente —, si no USD;
   `tc_gasto` = TC ponderado de las capas) ligado por
   `inventario_movimiento_id`; la devolución lo revierte en la moneda nativa
   de la devolución (peso contra peso; TC solo si la moneda difiere).
   No duplicar ese costo en otro lado. Caso aceites 28-ago-2026: una entrada
   en pesos capturada como USD multiplicó ×17 el costo del avión.

9. **Candados de rol**: el PILOTO solo registra cobros con método ∈
   {EFECTIVO, DOLARES, BILLPOCKET, HSBC_LINK} (se valida el del vuelo Y el del
   DTO); piloto/mecánico solo editan/borran SU gasto y SOLO el mismo día
   Cancún (`assertOwnSameDay`). Squawk severidad ALTA sin resolver: **CAMBIO
   CONSCIENTE 2-sep-2026 — ya NO bloquea a secas asignar el avión: exige
   confirmación y avisa al mecánico.** Por default `validateAssignTargets`
   rechaza con 409 ESTRUCTURADO (code `SQUAWK_ALTA_SIN_RESOLVER` +
   `details.discrepancias`, para que el panel ofrezca el confirm); con
   `aceptar_discrepancia_alta: true` en el DTO (assign, assignEscala,
   reassign-aircraft, reserva, combinar — combinar lo reenvía a su pre-check
   Y a su assign interno, no es transaccional) la asignación procede A
   SABIENDAS y `notificarSquawkAceptado` avisa al MECANICO (espejo
   ADMIN/COORDINADOR, tipo `alerta_sistema`, dedupe directo
   `squawk_alta_aceptado:<vuelo>:<avión>:<díaCancún>` en `alerta_emitida`,
   marca DESPUÉS de entregar) y sella la bitácora en `notas_internas`.
   Taller sigue bloqueando sin excepción; `revertirExterno` sigue SIN pasar
   por este candado (hueco conocido, pendiente de decisión).

10. **Partición del ingreso y participación por avión — fuentes únicas.**
    `particionIngresoVuelo` (`src/common/ingreso-vuelo.util.ts`): venta del
    AVIÓN = tiempo + ajuste + su IVA; TUAS, extras, pernocta y la COMISIÓN
    DEL VENDEDOR (+ su IVA) son ingreso de VuelaTour (regla 28-ago-2026):
    los libros por avión (balance, reparto, Libro Dinero) ni la cobran ni la
    descuentan; vive en "Otros movimientos"/"otros ingresos" como ingreso +
    egreso apareado (provisión del pago al vendedor). En vuelos
    MULTI-AVIÓN (tramos en aviones distintos) la venta del avión y lo que
    deriva de ella se REPARTE con `participacionPorAeronave` +
    `repartirUsd` (`src/common/participacion-aeronave.util.ts`: PARTES
    IGUALES POR TRAMO VENDIDO — nunca horas, ni cotizadas ni tacos; los
    tramos operativos/ferry no reparten; centavos por residuo mayor). La
    parte de VuelaTour y los avisos del vuelo los reporta UNA vez
    `avionQueReporta`. Los gastos NO se reparten: van al avión del tramo
    (`avionDelGasto`: escala → gasto → vuelo, y `expenses.service` sella el
    avión del tramo al capturar). El pago al vendedor es `pagoVendedorUsd`
    (comisión + su IVA) en todos los lectores. Ningún lector recalcula estas
    particiones a mano.
    **Balance por avión (Excel, 2-sep-2026)**: la hoja "Gastos Indirectos"
    del libro INDIVIDUAL = `gastos_indirectos` + `otros_gastos` pintados
    JUNTOS por pyservices (fusión de presentación); el contrato del payload
    y la cascada de `utilidad_despues_usd` NO cambian (cada lista resta UNA
    vez; `otros_gastos` sigue viajando aparte porque alimenta "repartidos
    a aviones" del Balance general VuelaTour). Restar `otros_usd` además de
    `gastos_indirectos_usd` cuenta doble.
    **La categoría de EMPRESA manda sobre el vuelo (cliente, 11-sep-2026).
    APLICA A TODOS LOS LIBROS** — balance por avión, reparto a socios, Libro
    Dinero, pre-cierre, reporte por vuelo, tablero y ficha del avión: un
    gasto de `CATEGORIAS_GASTO_EMPRESA` NO es costo de ningún avión ni de
    ningún vuelo aunque traiga `vuelo_id`/`aeronave_id` sellados; la ÚNICA
    excepción son las PARTES de un reparto manual (`gasto_reparto`), que sí
    van al avión de cada parte. Concretamente:
    `CAT_EMPRESA` = {OTRO, NOMINA, GASOLINA, FIJO, VISITA} va SIEMPRE a la
    hoja "otros gastos" del Balance general VuelaTour
    (`gastosEmpresaYSueltos`, eje `fecha_gasto`) AUNQUE el gasto traiga
    vuelo o aeronave sellados — el vuelo queda solo como referencia en el
    detalle ("· vuelo #123"). Esas categorías **no restan** en la fila del
    vuelo (la columna OTROS quedó en SOLO FBO; antes OTRO con vuelo caía
    ahí — regla del 27-jul), ni en "Gastos Indirectos"/"otros gastos" del
    libro del avión, ni en la cascada de `utilidad_despues_usd`.
    En el **reparto a socios** (`profit-sharing.service`) 'OTRO' SALIÓ del
    set `DIRECTO` y toda categoría de empresa sin reparto cae en `EXCLUIDO`
    (repartida a mano va al grupo INDIRECTO = "otros gastos" del avión, y un
    FIJO repartido al grupo FIJO); el TUA EMBEBIDO solo se descuenta de lo
    que SÍ resta (grupo ≠ EXCLUIDO). El **pool de FIJO se sigue
    prorrateando entre la flota activa** (doc 4.8): ese prorrateo no nace
    del vuelo/avión sellado, así que la regla no lo toca.
    En el **Libro Dinero** (`dinero-report.service`) la hoja "otros gastos"
    dejó de ser «solo los gastos SIN vuelo»: lee `vuelo_id is null` **OR**
    categoría de empresa (un `.or` en UNA consulta, sin duplicar filas),
    cita el folio en el concepto, NO acredita a ningún avión en la hoja
    utilidades sin reparto manual, y su TUA embebido YA NO sale además como
    egreso "tuas pagadas" en "otros ingresos" (restaría dos veces en el
    mismo libro). En el **reporte por vuelo** se listan con la nota "gasto
    de VuelaTour — no resta al vuelo" y quedan fuera del remanente; en
    `dashboards.gastos` van a `gastos_empresa_usd` (fuera de
    `gastos_usd`/`costo_hora_usd` por avión); en `aircraft.metrics` fuera de
    `finanzas`; en `groups.gastosPorHijo` fuera del gasto del hijo.
    **Quién NO pide avión** (bandeja de pendientes, `sugerirAsignaciones`,
    alerta `gastos_sin_avion` y pre-cierre): fuente única
    `CATEGORIAS_GASTO_SIN_AVION` = empresa + INDIRECTO + PERSONAL_DUENO —
    sin `vuelo_id` en la condición. Antes cada lector traía la lista a mano
    con un `.or('categoria.neq.OTRO,vuelo_id.not.is.null')` que dejaba
    DENTRO al «OTRO CON vuelo»: pendiente eterno de un dinero que ya no es
    de ningún avión.
    **Hoja "pendientes de captura" — horas voladas vs cobradas
    (11-sep-2026)**: cobrar HORAS CERRADAS es normal (se cobran 4.0 y se
    vuelan 4.3), así que el viejo pendiente «recotizar con las horas reales»
    (umbral 0.01 hr) salía en casi todos los vuelos y tapaba lo que sí hay
    que atender. Ahora es una NOTA informativa y solo con diferencia >
    `UMBRAL_HORAS_INFORMATIVO` (0.5 h): «Vuelo #247 (…): voló 2.60 hr y se
    cobraron 2.00 (diferencia 0.60 hr) — solo informativo». Nadie tiene que
    recotizar.
    Sobreviven intactas: `PERSONAL_DUENO` fuera del dinero de la empresa,
    `GAS` en la hoja "combustible" del avión, y el REPARTO MANUAL que
    sigue GANANDO (parciales a las hojas de sus aviones + remanente a la
    empresa — por eso la consulta de parciales ya no exige `vuelo_id null`
    en esas categorías). La lista es `CATEGORIAS_GASTO_EMPRESA`
    (`categoria-gasto.util.ts`), **derivada** del destino "Otros gastos
    (Balance general VuelaTour)": una categoría nueva con ese destino entra
    sola y el spec congela la membresía de hoy (cambiar un destino mueve
    dinero ⇒ falla en pruebas, no en el cierre). Su corolario: un gasto de
    empresa entra UNA vez — "Otros movimientos" del general SALTA estas
    categorías al calcular el TUA pagado (si no, la parte TUA embebida de un
    OTRO/FIJO con vuelo restaría en la hoja "otros gastos" Y como egreso de
    esa pestaña). La lectura de `gastosEmpresaYSueltos` va PAGINADA
    (PostgREST corta en 1000 sin avisar). **Columna PAGO** (misma fecha): cada fila de
    hoja ledger viaja con la forma de pago legible
    (`src/common/medio-pago.util.ts#etiquetaMedioPago`, espejo de
    `MEDIO_PAGO_LABELS` del panel; `TARJETA_CORP` añade " ****1234"; sin
    medio capturado → null = celda vacía) para conciliar el combustible
    contra el estado de cuenta del banco.

11. **Cotización de GRUPO (4-sep-2026, `src/modules/groups/`)** — varios
    aviones para un mismo cliente y UN total. La cabecera `vuelo_grupo` NO
    tiene dinero ni estado: guarda cliente, fecha, plantilla de ruta, extras
    del grupo (`cantidad × unitario`, `por_persona`, reparto POR_PAX /
    PROPORCIONAL / ANCLA), ajuste, ancla y preferencias del PDF. Cada avión
    es un VUELO HIJO normal (`vuelo.grupo_id/grupo_posicion/grupo_pax`) que
    pasa por `QuotesService.calculate()` con SU avión; el total del grupo se
    LEE sumando los desgloses persistidos de los hijos vivos
    (`consolidarDesgloses`). Reparto de ajuste/extras y de cobros con
    `repartirUsd` (Σ exacta, residuo al ancla). Sin índice único
    (grupo_id, grupo_posicion) A PROPÓSITO: `reassignAircraft` clona antes
    de cancelar (`payloadClonVuelo` conserva la liga y mueve el ancla).
    `revise` ancla los extras `origen='GRUPO'` salvo `opts.desdeGrupo`, y
    con `desdeGrupo` conserva los extras propios del hijo
    (`mezclarExtrasDesdeGrupo`). 409 estructurados: CAPACIDAD_EXCEDIDA
    (también en quotes.create/revise de vuelos propios), PAX_NO_CUADRAN,
    PILOTO_DUPLICADO, AERONAVE_EN_TALLER, HIJOS_CONGELADOS
    (+`solo_editables`), REVISION_A_MEDIAS (`details.creados` con vuelo_id:
    el reintento NO recrea). Nada del grupo es transaccional salvo la
    compensación total de `create`. `precio_desactualizado` en
    `calculo_snapshot.meta.grupo` cuando el avión efectivo ≠ cotizado;
    alerta diaria `grupo_desincronizado`.
    **Sobre de cobro (Fase 2)**: `cobro_grupo` es el pago único del cliente
    y se PARTE en N `cobro_vuelo` (`cobro_grupo_id`, `grupo_factor`) por el
    MISMO `createCobro`/`createReembolso` (`particionCobroGrupo`: LIQUIDACION
    si cubre Σ saldos ±1 USD, si no PROPORCIONAL por precio; MANUAL con Σ
    exacta; comisión con los mismos pesos). `cobrosEnUsd` y TODO el dinero
    por vuelo leen SOLO `cobro_vuelo`: el sobre NUNCA entra a una suma. Las
    partes se editan/borran solo desde el grupo (409 COBRO_DE_GRUPO). El
    banco enlaza al SOBRE (`movimiento_bancario.cobro_grupo_id`, excluyente
    con `cobro_id`); "conciliado" se decide SIEMPRE con
    `cobroEstaConciliado` (`src/common/cobro-conciliado.util.ts`). Quitar o
    reemplazar un avión NO re-parte solo: avisa (decisión del cliente
    pendiente). PDF del cliente vía pyservices `/reportes/cotizacion-grupo`
    (nunca COMISION_VENDEDOR ni redondeo como línea).

12. **Cotizador: vista previa, idempotencia y candado de cobro (8-sep-2026).**
    - `POST /quotes/preview-html` NUNCA persiste: con `quote_id`+`sucio=false`
      el quote-like es la fila de `findById` TAL CUAL (payload byte-idéntico
      al PDF salvo fotos); si no, `calculate()` + `camposDesdeBreakdown`
      (fuente ÚNICA del mapeo fila←breakdown, compartida con create/revise) +
      escalas en memoria con la misma cascada de `replaceEscalas`. El PDF y la
      preview pasan por el MISMO `QuotesPdfService.armarPayloadPdf` — jamás
      una réplica de la hoja 1 en otro lado.
    - `client_request_id` en create/revise (índices únicos parciales
      `uq_vuelo_client_request` / `uq_cot_version_client_request`): la misma
      llave devuelve la cotización/versión YA creada (200, `idempotente:true`)
      sin motor ni escrituras; no se clona en `reassignAircraft`.
    - D3: `revise` (y `quickAdjust`) rebota 409 estructurado
      `COTIZACION_COBRADA` cuando el NETO de `cobro_vuelo` por `cobrosEnUsd`
      ≠ 0 o hay MXN sin TC — en CUALQUIER estado salvo CANCELADO. Un cobro
      reembolsado completo (neto 0) sí deja revisar. La CFDI bloquea en
      cualquier estado no cancelado.
    - D4/D5: `pdf_oculto`/`pdf_fecha` viajan por tramo en create/revise
      (omitidos = conservar la escala viva) y `PATCH :id/pdf-visibilidad`
      (+ la ruta por escala) mueve notas/toggles del PDF SIN versión,
      snapshot ni avisos: presentación pura.
    - **Alta sin internet desde la app (9-sep-2026, diseño offline v2)**:
      `POST /flights/reserva`, `POST /pilots/:id/descansos` y
      `POST /calendar/eventos` son IDEMPOTENTES por `client_request_id`
      (índices únicos parciales `uq_vuelo_client_request`,
      `uq_piloto_descanso_client_request`, `uq_evento_flota_client_request`;
      la columna solo entra al insert cuando la llave viaja). En
      `createReserva` TODO lo que puede rechazar va ANTES del insert
      (avión obligatorio = 400 claro, el CHECK de `vuelo` lo exige; taller =
      409 estructurado `AERONAVE_EN_TALLER` con el mismo `message`; squawk,
      copiloto, `assertApoyosAsignables`, IATAs, cliente por nombre SIN
      crear todavía, detector de duplicado, sello). Tras los tramos el push
      al piloto/copiloto sale INMEDIATAMENTE (antes de apoyos y permisos):
      un 500 posterior reintenta por la rama idempotente, que no re-avisa,
      y el piloto ya se enteró. La rama
      idempotente (pre-check por llave o 23505) NUNCA re-valida, re-crea ni
      re-notifica al piloto/copiloto/responsable (200, `idempotente:true`);
      solo aplica `apoyo_ids` si `vuelo_apoyo` está vacío
      (`apoyos_aplicados`). Un vuelo HUÉRFANO (RESERVA, 0 filas de escala,
      0 cobro/gasto/factura, > 5 min) se REPARA sobre el mismo id/folio
      (`reparado:true`, ahí sí avisa porque nunca avisó); más joven → 503
      `RESERVA_EN_PROCESO`; con dinero → 200 con aviso. JAMÁS delete
      (`compensarVueloSinEscalas` solo corre en el alta fresca). Errores
      deterministas de BD (23514/23502/22P02/23503) → 400 legible; el resto
      500 (transitorio para el outbox). `capturado_en` de reserva/evento
      NUNCA rechaza (`selloCapturaApp`, tolerante, va a
      `notas_internas`/`notas`; el descanso lo ignora) — `resolverCapturadoEn`
      de gastos sigue siendo estricto. El detector de posible duplicado
      (`posible-duplicado.util`: mismo cliente, solape del día Cancún con
      `[fecha_vuelo, fecha_fin]`, y misma aeronave O misma ruta del tramo 1;
      excluye `es_interno`, `es_broker` y `grupo_id`) solo bloquea (409
      `POSIBLE_DUPLICADO` + `details.vuelos[]`) con
      `rechazar_posible_duplicado` y sin `aceptar_posible_duplicado`; si no,
      texto en `avisos[]`. `cliente_nombre` busca entre TODOS los clientes
      por nombre normalizado (`nombre-cliente.util`), reactiva al inactivo y
      crea justo antes del insert (`cliente_creado`). `aviso_piloto`/
      `aviso_copiloto` traen `notificado` y `push_dispositivos`
      (`notifyUserDetallado`): 0 ⇒ la oficina confirma por WhatsApp.
      `client_request_id` viaja en `VUELO_COLS`, `GET /calendar` (vuelo,
      descanso, evento), `/me/descansos` y `/me/eventos` para que la app
      deduplique su pendiente local. En `piloto_descanso`/`evento_flota` la
      columna es OPCIONAL hasta aplicar la migración `20260909000003`
      (`columna-opcional.util`: sonda 1 vez, 42703 ⇒ se omite del select y
      del insert, respuesta con `client_request_id: null`, altas sin
      idempotencia; re-sondea cada ≤10 min y se activa sola sin reiniciar;
      `vuelo.client_request_id` ya existe en prod y no pasa por el gate).
      `GET /aircraft` expone
      `squawks_alta_abiertos` y `en_taller`; `GET /me/capturas` incluye los
      vuelos creados por el usuario (`tipo: 'vuelo'`). Verificar el deploy
      con `GET /v1/version` (package.json `version`), nunca con un 401.
      **Externo y piloto externo desde la reserva (9-sep-2026)**:
      `es_externo:true` exige `operador_externo` y PROHÍBE `aeronave_id`
      (400 en DTO y service); el vuelo nace RESERVA con `aeronave_id null`,
      tramos sin avión, `avion_externo_*` y el costo por
      `resolverCostoExterno` (MXN sin `costo_externo_tc` = 400 ANTES del
      insert); se SALTAN «Elige la aeronave», taller/squawk y
      `avisosOperacionAvion`, y el detector compara SOLO la ruta del tramo 1.
      `piloto_externo_nombre` (solo sin `piloto_id`) busca entre los pilotos
      externos por nombre normalizado (`nombre-cliente.util`), reactiva al
      inactivo y crea por `PilotsService.createExterno` justo antes del
      insert (409 de `createExterno` ⇒ relectura por nombre normalizado y, si
      no, por su MISMO candado — `es_piloto_externo` con cualquier rol, ilike
      exacto —: nunca un 409 sin salida); respuesta `piloto_id` +
      `piloto_externo_creado`; `aviso_piloto` del externo sale
      `notificado:false`/`push_dispositivos:0` (WhatsApp). Sin piloto:
      `aviso_piloto:null` y sin push. El replay idempotente NUNCA re-crea
      pilotos ni clientes.
      **Baja desde la app (10-sep-2026)**: `DELETE /flights/:id` acepta body
      OPCIONAL `DeleteFlightDto {motivo 5-500, client_request_id}` (el panel
      sigue sin body → `vuelo_eliminado.motivo` = 'eliminado desde panel';
      con motivo = 'eliminado desde la app: <motivo>'; con llave y sin
      motivo útil = 'eliminado desde la app' — la etiqueta forense NUNCA
      dice "panel" si vino de la app; la llave va SOLO al `snapshot.app`)
      y responde `{deleted, id, folio}`. Rechazos ESTRUCTURADOS con el
      `message` de siempre: 404 `VUELO_NO_EXISTE` (`vueloNoExiste()` es la
      ÚNICA forma de lanzar "Vuelo <id> not found" en flights.service —
      findById/purge/reassign/relacionConVuelo/resumen/plan de vuelo; la
      app lo toma como éxito idempotente), 409 `VUELO_COBRADO_O_FACTURADO`
      y 409 `VUELO_CON_ACTIVIDAD` + `details {cobros, gastos, tacos}`.
      `flights.controller.baja.spec.ts` prueba la cadena HTTP real
      (Express 5 sin body ⇒ `req.body` undefined ⇒ DTO vacío; campo extra
      ⇒ 400; `code`/`details` a través del filtro): no quitar el
      `transform:true` del ValidationPipe sin correrlo.
      `POST :id/cancel`: 409 `VUELO_YA_CANCELADO` (idempotente para la app)
      y `VUELO_COMPLETADO` (fallo visible). Ningún consumidor decide por
      `message`: siempre por `code`.

13. **Ediciones sin internet: control de versión, idempotencia de altas y
    deltas (10-sep-2026, Lote 2 · Ola B; doc funcional 6.1 «conflicto ⇒
    gana el servidor y se avisa»).** Todo es OPCIONAL y retrocompatible:
    sin los campos nuevos, cada ruta se comporta como siempre (panel y APK
    vieja intactos).
    - **`if_updated_at` → 409 `CONFLICTO_VERSION`** (helper único
      `src/common/version-cas.util.ts`: `assertVersion`, `aplicarCas`,
      `conflictoVersion`). Lo aceptan `PATCH /flights/:id`, `POST
      /flights/:id/assign`, `PATCH /flights/legs/:legId` y `POST
      /flights/:id/legs/:legId/assign` (los demás módulos adoptan el MISMO
      helper). Semántica: el cliente manda el `updated_at` que leyó; se
      compara COMO INSTANTES con tolerancia de 1 ms (Postgres guarda
      microsegundos; el cliente reserializa a ms) y el UPDATE de un solo
      paso lleva CAS en BD (ventana `updated_at ∈ [t−1 ms, t+1 ms]`, mismo
      patrón que `complete()`); 0 filas ⇒ relectura y 409 estructurado
      `{ message: 'Alguien modificó este <vuelo|tramo|…> después de tu
      captura; se conserva la versión del servidor.', error:
      'CONFLICTO_VERSION', details: { actual: <fila pública>,
      updated_at_enviado, updated_at_actual } }`. Los flujos MULTI-PASO
      (`assign`, `assignEscala`) validan UNA vez contra la fila leída antes
      del primer write y no re-validan por paso. `if_updated_at` NUNCA
      entra al patch (se destructura antes) ni cuenta como "campo
      enviado". Una tabla sin `updated_at` (trigger pendiente) ⇒
      `assertVersion` devuelve `'omitido'` = comportamiento actual.
    - **Altas idempotentes de tramos** (`POST :id/legs`, `POST
      :id/operational-legs`) por `client_request_id` (índice único parcial
      `uq_escala_client_request`, migración `20260910000002`, columna
      OPCIONAL vía `ColumnaOpcional` hasta aplicarla: sin columna la llave
      se ignora y el insert es idéntico al de siempre). La rama idempotente
      (pre-check por llave acotado al vuelo, o 23505) va ANTES de toda
      validación y NUNCA re-valida, re-inserta, reabre ni re-notifica
      (`notificarTramoNuevo`); responde la fila YA creada con `idempotente:
      true` (en el operativo, con su `orden` calculado); llave reutilizada
      en OTRO vuelo ⇒ 409 `CLIENT_REQUEST_ID_EN_USO` (jamás 500; helper
      único `src/common/client-request-id.util.ts`). REGLA de toda alta
      idempotente: la relectura del replay (pre-check y 23505) se ACOTA al
      padre de la ruta (vuelo del tramo/cobro, avión del squawk, producto
      del movimiento) — jamás se devuelve una fila ajena. El snapshot
      expone `escala.client_request_id` (null sin columna).
    - **Cobros de la app**: `createCobro` con `client_request_id` (y sin
      sobre) hace pre-check por llave ANTES de todo candado (rol, método,
      voucher, saldo — el cobro ya existe: un 409 tardío sería un «fallido»
      falso en la app), acotado al vuelo (replay ⇒ el cobro existente,
      `idempotente: true`, sin candados ni aviso; 23505 con llave de OTRO
      vuelo ⇒ 409 `CLIENT_REQUEST_ID_EN_USO`) y luego el candado de
      SOBRE-COBRO con la fuente única `cobrosEnUsd`: `cobrado + monto_usd >
      monto_total_usd + max(1 USD, 5 %)` ⇒ 409 `COBRO_EXCEDE_SALDO` + `details {
      saldo_usd, cobrado_usd, monto_usd, monto_total_usd }`. Exentos: vuelos
      sin precio (internos/$0) y cobros MXN que no convierten. SIN llave
      (panel) no hay candado: la oficina puede sobrecobrar a propósito.
    - **Codes en bajas/transiciones** (message intacto): `deleteEscala` 409
      `ESCALA_CON_TACO`; `cancelEscala` 409 `ESCALA_YA_CANCELADA`
      (idempotente) / `ESCALA_CON_TACO` / `ESCALA_UNICA`; `start()` 409
      `VUELO_YA_INICIADO` (idempotente) / `VUELO_NO_INICIABLE`; 404
      `ESCALA_NO_EXISTE` (`escalaNoExiste()`) y `VUELO_NO_EXISTE` también
      en `updatePermiso`.
    - **Deltas**: `GET /flights?updated_since=ISO` devuelve solo los vuelos
      con `updated_at >= since` O con algún tramo con `escala.updated_at >=
      since` (un taco/permiso/reagenda no mueve el `updated_at` del vuelo)
      y añade `updated_since` (forma canónica) + `eliminados: [vuelo_id]`
      desde `vuelo_eliminado.eliminado_at >= since` (índice
      `idx_vuelo_eliminado_eliminado_at`). `>=` a propósito: repetir es
      inocuo, omitir no. TOPE: si más de 150 vuelos tienen tramo tocado (o
      la lectura de tramos se trunca en max-rows = 1000) el `id.in.(…)`
      reventaría la URL de PostgREST: se responde la lista COMPLETA sin
      filtro de delta (superconjunto válido) con `updated_since` +
      `eliminados` y un warn. Sin el parámetro, respuesta idéntica a la
      actual.
      `GET /calendar?updated_since` sigue el mismo contrato (módulo
      calendar): filtra vuelos (vuelo o tramo), descansos, eventos y
      mantenimientos por su `updated_at` y añade `updated_since` +
      `eliminados`.
    - **Gastos, eventos, mantenimiento y squawks (misma ola)**:
      `if_updated_at` con `aplicarCas` en `PATCH /expenses/:id` (entidad
      «gasto»), `PATCH /calendar/eventos/:id` («evento»), `PATCH
      engineering/maintenance/:mid` («mantenimiento») y `PATCH
      /aircraft/squawks/:id` («reporte»). `gasto`, `aeronave_discrepancia`
      e `inventario_movimiento` ya tenían `tg_set_updated_at`;
      `mantenimiento`, `piloto_descanso` y `evento_flota` lo reciben en la
      migración `20260910000001` junto con la función sonda
      `updated_at_trigger_activo(p_tabla)`: mientras no exista
      (`src/common/updated-at-trigger.util.ts`, rpc 1 vez, warn 1 vez,
      re-sondea ≤ 10 min) el CAS de evento/mantenimiento se SALTA
      (comportamiento de hoy). `MANT_COLS`/`EventoMe`/squawks exponen
      `updated_at`; el patch de mantenimiento y evento lo sella a mano.
      Altas idempotentes por `client_request_id` (columna OPCIONAL vía
      `columnaOpcional`, migración `20260910000002`): `POST
      /aircraft/:id/squawks` (`uq_discrepancia_client_request`) y `POST
      /inventory/items/:id/movimientos` (`uq_inv_movimiento_client_request`;
      el replay devuelve el movimiento, su `gasto_generado` BODEGA ya
      ligado por `inventario_movimiento_id` y el stock actual, SIN volver
      a mover stock ni dinero; el pre-check va ANTES de toda validación
      porque el stock ya bajó con el primer intento). Ventana semanal
      JUSTA de gastos (B3): `UpdateGastoDto.capturado_en` y `DELETE
      /expenses/:id?capturado_en=` son el sello de la CORRECCIÓN/BAJA
      (`ventana-correccion.util`: `resolverCapturadoEn` estricto, acotado a
      ahora); `assertOwnEnVentana` evalúa la semana contra ese día Cancún y
      la línea «[Corrección|Baja capturada en la app el … · recibida el …]»
      va a `notas` (el trigger `tg_gasto_bitacora` la registra); la
      columna `capturado_en` y `client_request_id` del gasto NUNCA se
      reescriben en el PATCH. Codes (message intacto): `GASTO_AJENO`
      (403), `GASTO_CONCILIADO`, `GASTO_EN_REPOSICION`,
      `GASTO_FUERA_DE_VENTANA` (403) en `assertOwnEnVentana`;
      `GASTO_CONCILIADO`, `GASTO_DE_COMPRA` (+`details.compra_id/folio`),
      `GASTO_REPARTIDO` en `remove`.

14. **Avión de la cotización: COTIZADO vs UTILIZADO, y el cambio de avión SÍ
    se persiste (11-sep-2026, bug cotización #254).**
    - Fuente única `resolverAeronaveDeRevision`
      (`quotes/aeronave-revision.util.ts`), compartida por `revise()`,
      `quickAdjust()` y el quote-like de `preview-html` (si divergen, la hoja
      muestra un avión y se guarda otro): si el cotizador CAMBIÓ el avión
      (`dto.aeronave_id` ≠ `vuelo.aeronave_id`) el cambio es DELIBERADO y
      manda — se escribe `vuelo.aeronave_id` y los tramos VIVOS lo siguen con
      el **blanket SELECTIVO** de siempre (solo herencia `null` o el avión
      VIEJO; una rotación deliberada a un tercer avión se respeta). Si NO lo
      cambió, manda el OPERATIVO del primer tramo ACTIVO (caso #80: cotizado
      en XA-VGV, volado en N990GG). `quickAdjust` —que re-envía a propósito
      el avión del SNAPSHOT para no mover el precio— y `reviseParaGrupo`
      —el armado del grupo re-envía el avión del hijo como referencia de
      tarifa y el cambio operativo lo hace `flights.assign`, que sí valida
      taller/squawk y avisa— pasan `conservarAvionOperativo: true` y JAMÁS
      reasignan. Sin esa guarda en el grupo, un hijo COMPLETADO (cuyo
      `assign` se salta a propósito) se movía de avión al recotizar y
      arrastraba sus tramos CON TACOS: horas de motor, gastos y balance de
      dos aviones cambiaban en silencio (invariante 1). Antes el tramo 1
      mandaba siempre: el snapshot y el historial guardaban el avión nuevo,
      `vuelo.aeronave_id` se quedaba con el viejo, el formulario reabría con
      el viejo y cada versión repetía el mismo diff «Avión X→Y» mientras la
      hoja seguía diciendo el avión original.
    - **Dos datos SEPARADOS para control interno**: `aeronave_cotizada`
      (ficha del avión del SNAPSHOT vigente — el MODELO es lo único que ve el
      cliente, vía `modelos-cotizados.util`) y `aeronave_utilizada`
      (matrícula + modelo del avión asignado HOY al vuelo/tramos, con
      `aeronaves_utilizadas` para multi-avión; helper puro
      `avionesUtilizados`: tramos vivos con herencia, ferry y solo-operativa
      INCLUIDOS). Viajan en `quotes.findById` (detalle/quote-like) y en
      `flights.snapshot`; el PDF INTERNO los pinta juntos
      (`aeronave_cotizada_modelo`/`_matricula`, `aeronave_utilizada`
      {matricula, modelo} y `aeronave_cotizada_vs_utilizada_difiere`). El PDF
      del CLIENTE sigue mostrando SOLO el modelo cotizado. Externos: null (su
      ficha ajena vive en `avion_externo_*`).
    - **CAMBIAR DE AVIÓN AL REVISAR ES UNA ASIGNACIÓN (11-sep-2026).** Con
      `cambio_deliberado`, ANTES de escribir nada `revise` pasa por el MISMO
      `FlightsService.validateAssignTargets` de `assign` (QuotesService lo
      inyecta; jamás una réplica local): taller ⇒ 409 `AERONAVE_EN_TALLER`;
      squawk ALTA sin resolver ⇒ 409 `SQUAWK_ALTA_SIN_RESOLVER` +
      `details.discrepancias`, y `aceptar_discrepancia_alta` en el
      `ReviseQuoteDto` lo acepta y dispara `notificarSquawkAceptado`
      (MECANICO + espejo, dedupe diario) tras el write exitoso. Sin esto el
      cotizador era la puerta trasera del candado del panel (invariante 9).
      El **blanket NO toca lo que YA VOLÓ** (invariante 1): el UPDATE lleva
      `.is('taco_salida', null).is('taco_llegada', null)` y NO corre si el
      vuelo está EN_VUELO/COMPLETADO (ahí el cambio operativo se hace por
      `assign`/`reassign-aircraft`, que validan y avisan). El vuelo y el
      snapshot SÍ conservan el avión nuevo y `revise` devuelve `avisos[]`
      (aditivo, siempre presente) diciendo qué tramos no se movieron.
      `quickAdjust` y `reviseParaGrupo` pasan `conservarAvionOperativo` ⇒
      nunca hay cambio deliberado ⇒ ni pre-check ni blanket.

15. **Método de cobro: PREVISTO (vuelo) vs REAL (cobro) — 11-sep-2026.**
    `cobro_vuelo.metodo_cobro` es lo que REALMENTE se recibió y es la ÚNICA
    fuente del **recibo de pago** (`cobro-recibo.service`), de la
    conciliación y de cualquier lectura de "con qué pagó": JAMÁS se pinta
    `vuelo.metodo_cobro` como método de un cobro (cada parcialidad puede
    venir por un medio distinto). `vuelo.metodo_cobro` es lo PREVISTO al
    cotizar y **NINGÚN cobro lo reescribe** (corrección de la revisión
    adversaria del 11-sep, que revirtió el sellado al liquidar): esa columna
    es un INSUMO DEL PRECIO — define el IVA del desglose canónico v1.3 y la
    comisión BillPocket en `calculate()`, el cotizador del panel rehidrata su
    selector desde ella y el candado de rol del piloto (invariante 9) la
    valida. Sellarla con el método real movía el total de la SIGUIENTE
    revisión por dos caminos vivos (una cotización CANCELADA —`revise` sí las
    acepta— y un vuelo con todos sus cobros reembolsados, neto 0) y dejaba
    mintiendo a la etiqueta «Previsto en la cotización» del panel.
    «Cómo se cobró al final» se DERIVA (fuente única
    `metodo-cobro-final.util`: `vueloLiquidado`, `metodoCobroQueLiquido`,
    `metodoCobroFinal`) y viaja SOLO LECTURA en el snapshot del vuelo:
    `metodo_cobro_final` (método del último abono POSITIVO cuando el cobrado
    NETO por `cobrosEnUsd` ≥ total − 1 USD, misma tolerancia que
    `refreshCobradoFlag`; un vuelo en $0 nunca liquida) y
    `metodo_cobro_final_difiere` (true cuando no coincide con lo previsto).
    Si el cliente pide PERSISTIRLO, es una columna NUEVA
    (`vuelo.metodo_cobro_final` + migración), nunca la del previsto.

16. **Gasto de PILOTO sin vuelo (11-sep-2026, pedido de la app).** Un PILOTO
    puede capturar un gasto SIN `vuelo_id` solo si la categoría NO es del
    vuelo. Regla única `categoriaExigeVuelo`
    (`src/common/categoria-gasto.util.ts`, derivada del destino por default +
    la lista corta TUAS/PERMISO/PILOTO_EXTERNO): exigen vuelo las que
    dicen «Gastos directos del vuelo» (ATERRIZAJE, OPERACIONES, TUAS, FBO,
    COMIDA, HOTEL, TAXI, PILOTO_EXTERNO) más PERMISO; las de
    empresa/indirectos/refacción/servicios (REFACCION, INDIRECTO, SERVICIOS,
    NOMINA, GASOLINA, OTRO, VISITA, FIJO, PERSONAL_DUENO) van sin vuelo.
    **GAS salió de la lista el 11-sep-2026** (decisión del cliente): un
    piloto también carga combustible EN BASE, como el mecánico —que ya
    estaba fuera del candado por rol—, y la pantalla de combustible de la
    app ofrece "Sin vuelo"; ese GAS sigue exigiendo `aeronave_id` por su
    candado propio (sin avión sería invisible para balance y reparto). La
    app espeja esta lista. Sin
    vuelo y con categoría del vuelo: **400 ESTRUCTURADO `GASTO_REQUIERE_VUELO`**
    («Esta categoría es del vuelo: elige el vuelo…», `details` con categoría,
    etiqueta y destino) ANTES de tocar la BD. `escala_id` cuenta como vuelo
    (el tramo lo resuelve). OFICINA y MECÁNICO quedan FUERA del candado a
    propósito (la oficina liga después; el mecánico carga GAS en base). Con
    vuelo, las reglas de siempre no cambian.

## Convenciones NestJS

- **Orden de rutas**: las rutas literales (`taco-live`, `descansos`,
  `pre-cierre`, `resumen`) se declaran ANTES de las rutas `':id'` del mismo
  segmento, o Nest las captura como id.
- Crones: aviso de tacos vencidos (push al piloto, sin escrituras)
  `*/10 * * * *`; resumen nocturno de tacos `45 4 * * *` UTC (23:45 Cancún);
  vuelos zombi `55 4 * * *`; alertas diarias `0 8 * * *` con
  `timeZone: America/Cancun`; recordatorios de eventos NO-vuelo
  (`recordatorio_evento` al responsable): 90 min antes cada minuto
  (`runEventoRecordatorios`, dedupe `evento_90m:<evento>:<fecha al minuto>`
  — reagendar vuelve a avisar) y víspera `0 18 * * *` Cancún
  (`runEventosVispera`, dedupe `evento_vispera:<evento>:<día>`); multi-día
  solo avisa el inicio. Nuevas alertas vía `alerts.service` necesitan
  fila en `alerta_config` (migración) o `safe()` las salta; los avisos
  directos (`notifyUser`/`notifyRole`) no la necesitan aunque deduplicen en
  `alerta_emitida` (ej. `taco_vencido_<escala_id>`).
- Notificaciones: `notifications.notifyUser/notifyRole`; dedupe de alertas vía
  `alerta_emitida` (`markIfNew`). Los tipos que la app Flutter sabe pintar:
  `vuelo_asignado, taco_capturado, cobro_registrado, gasto_registrado,
  permiso_emitido, mantenimiento_programado, recordatorio_taco,
  alerta_sistema, evento_asignado, evento_actualizado, evento_cancelado,
  recordatorio_evento`. Links `/flights/<id>` redirigen al vuelo en la app;
  `/me/eventos?dia=YYYY-MM-DD` abre Mis vuelos en ese día.
  `notifyUserDetallado` devuelve además `push_dispositivos`/`plataformas`
  (fila persistida ≠ push entregado: sin dispositivo no llega nada y
  `push.sendToUser` lo deja en `warn`).
- **Eventos NO-vuelo (`evento_flota`, incidente 3-sep-2026)**: helpers puros
  en `calendar/evento-flota.util.ts` (cuerpo canónico "jue 3 sep, 09:45 ·
  título · matrícula · notas", `data`+`link`, rangos Cancún, ventanas de
  recordatorio). POST/PATCH `/calendar/eventos` devuelven `aviso`
  ({responsable_id, nombre, notificado, push_dispositivos, plataformas} |
  null) — `push_dispositivos === 0` ⇒ la oficina avisa por otro medio;
  GET `/calendar` expone `responsable_push_dispositivos` y con `piloto_id`
  filtra eventos por responsable (antes los omitía). El responsable los
  lee en `GET /me/eventos` (una fila por evento, solapamiento
  [fecha, coalesce(fecha_fin, fecha)] en cortes Cancún). Cambiar de
  responsable avisa al nuevo (`evento_asignado`) y al anterior
  (`evento_cancelado`); única exclusión de auto-aviso: actor = responsable.
- Espejo vuelo↔tramo 1: `aeronave_id/piloto_id/fecha` del vuelo se reflejan en
  la escala orden=1 (`mirrorVueloToIdaEscala`) y viceversa. Reagendar
  `fecha_vuelo` con el mismo piloto → push al piloto (doc 4.3). Cambiar la
  AERONAVE a nivel vuelo (2-sep-2026) aplica a todos los tramos vivos con
  blanket SELECTIVO (pisa herencia null o el avión viejo; una rotación
  deliberada a OTRO avión se respeta — mismo patrón que combinarVuelos).
- **Tripulación por tramo (29-ago-2026)** — fuente única
  `src/common/tripulacion.util.ts`: copiloto del tramo =
  `escala.copiloto_id ?? vuelo.copiloto_id` (misma herencia que el piloto;
  asignar copiloto a nivel VUELO limpia los overrides de tramo, igual que
  el piloto). Apoyos 0..N viven en `vuelo_apoyo` (`escala_id` null = todo
  el vuelo; con valor = solo ese tramo; efectivos = vuelo ∪ tramo).
  `vuelo.apoyo_id` es SOLO el espejo del primer apoyo de nivel vuelo: lo
  escribe únicamente `syncApoyoEspejo` (toda escritura en `vuelo_apoyo`
  termina ahí — `reemplazarApoyos`/`clonarApoyos` ya lo hacen). Acceso y
  candado de tacómetros salen de `miTripulacion` (apoyo NUNCA captura
  tacos; piloto/copiloto del vuelo o de un tramo sí). Lectores nuevos de
  "quién va" usan `tripulacionDeVuelo`/`cargarTripulacion`, jamás
  `apoyo_id` a mano.

## Migraciones y despliegue

- Migración = archivo en `supabase/migrations/` **y** aplicada vía MCP al
  proyecto prod `bjesduasnzbzywofukbf` (existen dos proyectos; verificar).
  Tras DDL correr `get_advisors`. RLS habilitado en todas las tablas (la API
  usa service key).
- Push a `main` = deploy automático en Railway. El usuario autorizó push
  directo de este repo sin preguntar.
- Build/typecheck requiere `NODE_OPTIONS=--max-old-space-size=4096` (el
  Dockerfile lo fija en la etapa de build: sin él Railway se queda sin
  memoria en silencio y producción sigue con la imagen anterior — 28-ago).

## Pendientes conocidos (no implementar sin decisión del cliente)

- Candado de cobro anticipado (origen ≠ CUN), regla TUAS por tramo, monto de
  pernocta al piloto, costo de PILOTO como categoría del reparto (doc 4.8) —
  esperan reunión con el cliente.
- **Multi-avión en el PRECIO**: el precio sigue cotizándose con el avión
  principal (una tarifa/velocidad; TUAS por su matrícula) — tarifa por
  tramo sigue pendiente. El REPARTO del ingreso entre aviones YA está
  decidido (28-ago-2026): ver invariante 10.
- Complementos de pago REP (A2), Calendar bidireccional (Fase C), clasificación
  IA de facturas recibidas, `factura_recibida.gasto_id` no actualiza
  `gasto.estatus_comprobante` al amarrar.
- **Vigilar (11-sep-2026)**: `reviseParaGrupo` pasa por la MISMA regla de
  avión que el cotizador (invariante 14) — hoy el grupo re-envía el avión ya
  persistido del hijo, así que no reasigna nada; si algún día el armado del
  grupo manda un avión distinto sin pasar por `reassignAircraft`, ese cambio
  SÍ moverá el vuelo y sus tramos.
