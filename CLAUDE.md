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
   **PAGOS PARCIALES — 1 gasto ↔ N movimientos (14-sep-2026, caso real: UNA
   factura de ASUR cobrada en DOS cargos, operación y FBO por separado)**:
   un gasto admite VARIOS `movimiento_bancario` ligados SOLO si todos son de
   la MISMA moneda que el gasto (`cuenta_bancaria.moneda = gasto.moneda`) y
   la suma de |monto| no rebasa `gasto.monto + 1.00` (TOLERANCIA). Un gasto
   conciliado contra OTRA moneda (USD ↔ cuenta MXN, de donde se deriva su
   `tc_gasto`) sigue siendo **1 ↔ 1**. Fuente única de la regla:
   `src/modules/conciliacion/conciliacion-parcial.util.ts` (`faltanteDe`,
   `cubreGasto`, `puedeLigar`, puras) + su ESPEJO en BD, el trigger
   `tg_mov_bancario_gasto_suma` (migración `20260914000001`, `for update`
   sobre el gasto: cierra el TOCTOU que cerraba el índice único
   `uq_mov_bancario_gasto`, hoy retirado) que lanza 23514 con prefijo
   `GASTO_YA_CUBIERTO` y el service traduce a 409 `GASTO_YA_CUBIERTO`
   (`details {motivo, monto_gasto, suma_ligada, faltante, movimientos[]}`).
   **`gasto.conciliado` = CUBIERTO**, no "tiene liga": parcial ⇒ `false` y el
   gasto SIGUE en `gastos-sin-banco` y en el reporte, con los aditivos
   `monto_vinculado` / `faltante` / `parcial` (columna «Parcial» en el xlsx).
   `link` recalcula `conciliado` desde la suma SIEMPRE — al ligar y al
   desligar (desvincular uno de dos NO desconcilia a ciegas: el otro sigue
   contando). `autoMatch` NO cambió (monto exacto, `conciliado=false`) pero
   un 409 suyo ya no tumba la importación: deja el movimiento pendiente.
   `sugerir`/`candidatosCercanos` ofrecen los gastos con pago parcial
   comparando contra el **faltante**. CANDADO espejo en `expenses`: un gasto
   con CUALQUIER cargo ligado (aunque parcial) no se edita en
   `monto`/`moneda`/`medio_pago` ni se borra (409 `GASTO_CONCILIADO` +
   `details.movimientos_ligados`); notas, vuelo y categoría siguen libres.
   El candado compara el valor NUEVO contra el VIGENTE
   (`cambiaDineroDelGasto`), NO «¿viene el campo?»: el diálogo «Verificar»
   del panel manda SIEMPRE monto/moneda/medio (son campos del formulario) y
   con la comparación por `!== undefined` a secas reclasificar o ligar el
   vuelo de un gasto con cargos rebotaba 409 — justo lo que la regla deja
   libre. Sin la fila vigente a la mano se responde «sí cambia»
   (fail-closed).
   **La regla también rechaza el PRIMER cargo** cuando él solo rebasa el
   ticket (cargo de $1,850 contra un gasto de $277.79: paga varias facturas
   o el gasto está mal capturado) — comportamiento NUEVO (antes se podía
   ligar cualquier movimiento a cualquier gasto) con su propio texto
   («Ese cargo ($1,850.00) es MAYOR que el gasto…»); decir «ya está
   cubierto: $0.00 de $277.79» no significaba nada. `details` del 409 lleva
   además `moneda` y `monto_nuevo` (aditivos).

   **AUTO-CRUCE RESILIENTE, RE-CRUCE Y DESEMPATES (15-sep-2026, incidente
   del estado de cuenta que «no conciliaba nada»)**. Fuente única de la
   decisión: `src/modules/conciliacion/auto-cruce.util.ts` (PURO, con
   specs). Reglas:
   - **Ningún movimiento tumba el job.** Cada movimiento del bucle de
     importación va en su propio try/catch (`cruzarMovimiento`), `ligarAuto`
     y `ligarCobroAuto` atrapan CUALQUIER error (antes solo
     `ConflictException`) y el job termina **LISTO** con el desglose
     `{conciliados, traspasos, ambiguos, sin_candidato, rechazados,
     errores, por_criterio, detalle[]}`. El 15-sep un error de trigger en la
     PRIMERA liga mató el job al 37 % con 101 movimientos ya insertados.
   - **`POST /v1/conciliacion/auto-match`** (ADMIN+FACTURACION, body opcional
     `{cuenta_bancaria_id?, desde?, hasta?, limite?}`, default últimos 90
     días en hora Cancún y 500 movimientos) vuelve a correr EXACTAMENTE el
     mismo cruce sobre lo que sigue `conciliado=false`. Sin él, lo que quedó
     pendiente por un fallo se quedaba pendiente **para siempre**
     (re-importar responde «N duplicados» y no reintenta el cruce de nadie).
   - **El auto-cruce solo liga lo INEQUÍVOCO.** Orden: monto ±0.01 y ventana
     ±`MATCH_DAYS` → si hay ≥2 candidatos, **terminación de tarjeta**
     (últimos 4 dígitos de `referencia` SOLO si la referencia tiene ≥8
     dígitos y esos 4 son una terminación real de
     `tarjeta_corporativa`: la referencia de 6 dígitos '174465' no inventa
     tarjeta) → **descripción** del banco contra `lugar` / primera línea de
     `notas` / proveedor (sinónimos del giro + **veto por ciudad**; exige ≥2
     tokens comunes y margen sobre el segundo) → si nada desempata,
     **AMBIGUO** y se queda pendiente con su motivo. Después del monto se
     prueba el **FALTANTE** de un gasto con pagos parciales y, en cuenta MXN,
     la compra USD por TC implícito (15-25).
   - **Camino inverso**: `intentarCruzarGasto` (best-effort, nunca lanza) se
     dispara con `void` desde `expenses.service` al CREAR un gasto bancario y
     al editar `monto`/`moneda`/`fecha_gasto`/`medio_pago`. Un gasto
     capturado DESPUÉS de importar el estado de cuenta ya no necesita que
     alguien se acuerde de volver a la pestaña.
   - **Traspasos internos**: `patronTraspaso` («SEL TRASPASO ENTRE CUENTAS»…)
     los clasifica solos con la clasificación canónica «Traspaso entre
     cuentas» (se crea si no existe) y nota `Regla: <patrón>`; nunca pisa
     notas escritas por la oficina. Eran pendientes eternos que inflaban el
     «faltan N por conciliar».
   - **Dedupe por REFERENCIA** (`emparejarDuplicados`): la referencia manda
     cuando existe de los dos lados (re-subir el MISMO PDF con la descripción
     redactada distinta por la IA ya no duplica) y dos cargos idénticos con
     referencias DISTINTAS son dos movimientos reales. Sin referencia, la
     descripción como siempre. La consulta de previos lleva `.limit(20000)`
     (sin límite PostgREST cortaba en 1000 y duplicaba en silencio).
   - **`ventanaAbono` en hora Cancún** (`-05:00`), como `cobrosSinBanco`:
     invariante 4. Antes un cobro de las 20:00 del último día caía fuera.
   - **La IA propone, jamás liga**: `POST /conciliacion/movimientos/:id/
     sugerir` (ADMIN) manda contexto RICO (referencia, tipo, alias y moneda
     de la cuenta, terminación detectada; por candidato: medio, tarjeta,
     categoría, lugar, primera línea de notas, matrícula, folio de vuelo,
     capturista, `monto_vinculado`/`faltante`/`tc_implicito`) y acepta
     `evidencias[]` y `alternativas[]`; todo id se valida contra los
     candidatos reales. `POST /conciliacion/sugerir-lote` (ADMIN) hace lo
     mismo para los cargos pendientes de una ventana (tope 40, default 15) y
     devuelve PROPUESTAS — el humano confirma.
   - **REVISIÓN ADVERSARIA (15-sep-2026), candados que faltaban**:
     - **TC implícito USD↔MXN: solo con candidato ÚNICO.** Ahí el monto NO
       cuadra (la banda 15-25 acepta cualquier gasto USD dentro de un ±25 %
       del cargo), así que desempatar por tarjeta o por descripción sería
       ligar «por parecerse» — con ≥2 plausibles queda **AMBIGUO**. El
       comentario del código ya lo decía; el código no lo hacía.
     - **Sin moneda de la cuenta NO se cruza nada.** `cuenta_bancaria.moneda`
       es NOT NULL: un null solo puede venir de una lectura fallida, y sin
       moneda la consulta de candidatos no filtra divisa (un gasto de 125.82
       USD cuadraría con un cargo de 125.82 MXN). `cruzarMovimiento` y
       `autoMatchCargo` devuelven ERROR con su motivo y el movimiento queda
       pendiente.
     - **`list()` dice POR QUÉ sigue pendiente cada CARGO** (`motivo_pendiente`
       ∈ SIN_CANDIDATOS | AMBIGUO | **SE_PUEDE_CRUZAR** + `candidatos_n`,
       ADITIVOS): DOS consultas en lote para toda la página —jamás una por
       fila— con las MISMAS reglas (`elegirCandidato`). Si la lectura falla o
       se trunca (`MOTIVO_GASTOS_MAX`), **no se anota nada**: un «sin
       candidato» falso es peor que el badge mudo. Los ABONOS no se anotan
       (su universo son cobros/sobres y ahí no hay consulta en lote).
     - `AutoMatchDto.movimiento_ids[]` (≤ 500): re-cruce DIRIGIDO que manda
       sobre `desde`/`hasta` — el panel ya lo mandaba y el API lo rebotaba con
       400 (`forbidNonWhitelisted`).
     - `importar-status` devuelve el desglose **PLANO además de anidado**
       (`resultados`): el panel lo lee plano y el resumen del job salía en
       ceros.
     - `sugerir-lote` viaja con `gasto` (ficha del propuesto), `candidatos[]`,
       `motivo_sin_match`, `sin_propuesta` y `disponible`/`nota` — `false`
       SOLO si se preguntó y nadie contestó (con pyservices sin configurar el
       panel decía «la IA no encontró propuestas», que es mentira).
   - Migración `20260916000001_conciliacion_job_resultados.sql` (aditiva,
     **pendiente de aplicar**): `conciliacion_import_job.errores`,
     `errores_detalle`, `resultados`, `tipo`. Mientras no exista, el job se
     cierra igual (el API reintenta el UPDATE sin esas columnas) y el
     desglose viaja en la respuesta de `POST /conciliacion/importar`.

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
   **TALLER YA NO BLOQUEA (cliente, 11-sep-2026)**: «al cotizar debe poder
   elegirse un avión aunque esté en taller (son cotizaciones a futuro) […]
   la advertencia está bien pero con eso es suficiente, no debe limitarte;
   lo mismo para el vuelo». NINGÚN camino del API responde ya 409
   `AERONAVE_EN_TALLER` — ni assign, assign por tramo, reserva,
   reassign-aircraft, combinar, revertir-externo, ni quotes
   create/revise/quickAdjust, ni el grupo. En su lugar viaja un AVISO
   informativo en `avisos: string[]` (campo ADITIVO, siempre presente aunque
   vaya vacío; en el grupo, dentro de los `avisos` DE ESE AVIÓN como el
   squawk aceptado) con el texto ÚNICO de
   `src/common/aviso-taller.util.ts#avisoAeronaveEnTaller(matricula)`: panel
   y app lo pintan en ÁMBAR (ni modal, ni confirm, ni rojo) y el selector
   sigue MARCANDO «En taller» (`GET /aircraft.en_taller`) sin deshabilitar.
   Fuente única del lado servidor: `FlightsService.avisoTallerDe` — lo usa
   `validateAssignTargets`, que devuelve `{ squawksAceptados, avisos }`, y
   todo caller suma esos `avisos` a los de su respuesta. `avisoTallerDe`
   NUNCA lanza (best-effort completo): si falla la lectura de
   `mantenimiento` devuelve `[]` y sigue — un aviso es presentación y en
   `quotes.create` / `revertirExterno` se calcula DESPUÉS del write, donde
   un 500 dejaría el dato guardado y al operador creyendo que no. El REPLAY
   idempotente de la reserva también trae el aviso: cuando la primera
   respuesta se perdió (outbox de la app), esa es la única que verá la
   oficina. El squawk ALTA y
   los documentos críticos vencidos NO cambiaron. `revertirExterno` sigue
   SIN pasar por el candado del squawk (hueco conocido, pendiente de
   decisión) aunque ya devuelve el aviso de taller.

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
    PILOTO_DUPLICADO, HIJOS_CONGELADOS
    (+`solo_editables`), REVISION_A_MEDIAS (`details.creados` con vuelo_id:
    el reintento NO recrea). El avión EN TALLER ya NO rebota 409
    (11-sep-2026): avisa en los `avisos` de ese avión, y la PROPUESTA
    automática de flota (`proponerFlotaConTaller`) prefiere los aviones fuera
    de taller y solo incluye los que están en mantenimiento cuando los sanos
    no alcanzan asientos (para los pax sobrantes, con su aviso). Nada del grupo es transaccional salvo la
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
      (avión obligatorio = 400 claro, el CHECK de `vuelo` lo exige; squawk,
      copiloto, `assertApoyosAsignables`, IATAs, cliente por nombre SIN
      crear todavía, detector de duplicado, sello). El TALLER dejó de
      rechazar el 11-sep-2026 (ver invariante 9): la reserva se guarda y su
      aviso abre `avisos[]`. Tras los tramos el push
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

14. **Avión de la cotización: COTIZADO vs UTILIZADO — LA COTIZACIÓN ES
    INDEPENDIENTE DE LA OPERACIÓN (cliente, 12-sep-2026, cotización #298) y
    el cambio DELIBERADO de avión sí se persiste (11-sep-2026, #254).**
    - **REGLA RECTORA (cliente, 12-sep-2026)**: «al realizar un ajuste en el
      vuelo operativo (cambio de avión) terminó afectando a la cotización;
      esto no debe ser así: **se cotiza con un avión y se vuela con otro por
      distintos motivos, pero la cotización no debe verse afectada por
      cambios en el vuelo operativo**». Dos datos, dos fuentes: el avión
      **COTIZADO** = `calculo_snapshot.aeronave` del snapshot VIGENTE
      (expuesto como `aeronave_cotizada {id, matricula, modelo}` en
      `GET /quotes/:id` y en el snapshot del vuelo; el id lo lee la fuente
      única `idAeronaveCotizada`); el **OPERATIVO** = `vuelo.aeronave_id` /
      los tramos. (R1) el cotizador del panel rehidrata su selector desde el
      COTIZADO (`aeronave_cotizada?.id ?? calculo_snapshot?.aeronave?.id ??
      aeronave_id`), nunca desde el operativo — también en externos (ahí el
      snapshot es la referencia de TARIFA). (R2) ver el punto siguiente.
      (R3) `modelos_cotizados`/hoja/PDF del cliente: SOLO el modelo del
      snapshot vigente (externo: el modelo ajeno) **y también su FICHA** —
      `armarPayloadPdf` consulta `aeronave`/`aeronave_imagen` con el avión
      COTIZADO (`idAeronaveCotizada(calculo_snapshot)`, respaldo
      `vuelo.aeronave_id` solo sin snapshot; externo = sin ficha, su
      referencia de tarifa JAMÁS se enseña). Antes leía el operativo: la línea
      «Aeronave cotizada» salía bien pero las FOTOS, asientos, velocidad,
      motores, características y la matrícula del PDF eran los del avión que
      vuela hoy. (R4) la card «Operación» y
      el PDF INTERNO siguen mostrando cotizada vs utilizada. (R5) los textos
      del panel explican la separación (el diálogo de «tiene tripulación
      asignada» y la nota tenue «Opera en …»); el selector JAMÁS se mueve
      solo.
    - Fuente única `resolverAeronaveDeRevision`
      (`quotes/aeronave-revision.util.ts`), compartida por `revise()`,
      `quickAdjust()` y el quote-like de `preview-html` (si divergen, la hoja
      muestra un avión y se guarda otro). **(R2, 12-sep-2026)** el «cambió el
      avión» se mide contra el **COTIZADO**, no contra el operativo:
      `cambio_deliberado = dto != null && dto !== (aeronaveCotizada ??
      aeronaveVuelo)` (+ guarda: un DTO que re-envía el avión que YA opera el
      vuelo no es asignación nueva — sin ella un panel viejo rebotaría 409 por
      un squawk del avión que ya vuela). Con cambio DELIBERADO manda el DTO:
      se escribe `vuelo.aeronave_id` y los tramos VIVOS lo siguen con el
      **blanket SELECTIVO** de siempre (solo herencia `null` o el avión
      VIEJO —el OPERATIVO anterior—; una rotación deliberada a un tercer avión
      se respeta). SIN cambio deliberado el vuelo conserva el OPERATIVO
      (`tramo ?? vuelo ?? dto`) y el PRECIO se calcula con el avión del DTO
      (= el cotizado): ese es el caso #298 (snapshot Cessna 205, vuelo en
      N990GG, el panel guarda sin tocar el selector ⇒ precio con el Cessna,
      `vuelo.aeronave_id` sigue en N990GG, snapshot con el Cessna y NINGÚN
      aviso de cambio de avión). Antes esa misma revisión se leía como cambio
      deliberado y REASIGNABA el vuelo al avión de la cotización (regresión
      del caso #80: cotizado en XA-VGV, volado en N990GG).
      `quickAdjust` —que re-envía a propósito el avión del SNAPSHOT para no
      mover el precio— y `reviseParaGrupo` —el armado del grupo re-envía el
      avión del hijo como referencia de tarifa y el cambio operativo lo hace
      `flights.assign`, que sí valida el squawk y avisa (taller incluido, ya
      solo como aviso)— pasan `conservarAvionOperativo: true` y JAMÁS
      reasignan. Sin esa guarda en el grupo, un hijo COMPLETADO (cuyo
      `assign` se salta a propósito) se movía de avión al recotizar y
      arrastraba sus tramos CON TACOS: horas de motor, gastos y balance de
      dos aviones cambiaban en silencio (invariante 1). Antes el tramo 1
      mandaba siempre: el snapshot y el historial guardaban el avión nuevo,
      `vuelo.aeronave_id` se quedaba con el viejo, el formulario reabría con
      el viejo y cada versión repetía el mismo diff «Avión X→Y» mientras la
      hoja seguía diciendo el avión original.
    - **(R3) El cliente solo ve el modelo COTIZADO**: `modelosCotizados`
      (`common/modelos-cotizados.util.ts`) devuelve el modelo del SNAPSHOT y
      CIERRA. La rama vieja «≥ 2 aviones en los tramos ⇒ sus modelos» quedó
      como **RESPALDO solo cuando NO hay snapshot** (reserva sin cotizar):
      colaba un dato OPERATIVO en la cotización (reasignar un tramo cambiaba
      el avión impreso en la hoja sin que nadie tocara la cotización).
      `avionesDeTramos` sigue existiendo, pero ya solo alimenta ese respaldo.
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
      inyecta; jamás una réplica local): el taller SOLO AVISA desde el
      11-sep-2026 (texto único en `avisos[]`, ver invariante 9);
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
      (aditivo, siempre presente) con el aviso de TALLER del avión nuevo y
      qué tramos no se movieron. `quotes.create` también devuelve `avisos[]`
      (solo taller; usa `avisoTallerDe`, NO el candado del squawk: crear una
      cotización nunca fue una asignación). `quickAdjust` y `reviseParaGrupo`
      pasan `conservarAvionOperativo` ⇒ nunca hay cambio deliberado ⇒ ni
      pre-check, ni blanket, ni aviso de taller.

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

17. **Historial de gastos: la bitácora de un gasto MOVIDO vive bajo el vuelo
    DESTINO (14-sep-2026, caso real #260 → #268).** `tg_gasto_bitacora`
    escribe la fila UPDATE con `coalesce(new.vuelo_id, old.vuelo_id)`, así
    que el vuelo de ORIGEN se quedaba con una captura MUDA («Gasto
    capturado» sin descripción ni acción, porque el gasto ya no vivía ahí) y
    el destino no decía de dónde venía. `FlightsService.gastosHistorial`
    ahora suma a la bitácora del vuelo las filas UPDATE cuyo
    `diff->'vuelo_id'->>'antes'` es ESTE vuelo (índice de expresión
    `idx_gasto_bitacora_movido_desde`, migración `20260914000001`; NO parcial
    a propósito: con `where diff ? 'vuelo_id'` el planeador no puede usarlo),
    deduplica por `gasto_bitacora.id` (un UPDATE que DESLIGA el vuelo cae en
    las dos consultas) y expone el campo ADITIVO
    `movimiento: { tipo: 'salio' | 'llego', vuelo_id, folio } | null` —
    `accion` (INSERT/UPDATE/DELETE) NO cambia. `descripcion_gasto` se
    resuelve también para gastos que ya no viven en el vuelo (consulta por
    los ids faltantes; si se borró, el snapshot del DELETE como siempre) y
    los folios salen de UNA consulta `in`. Las dos lecturas extra son
    best-effort: si fallan, el historial sale como siempre (warn en el log),
    nunca 500.
    **`movimiento.vuelo_id` PUEDE SER null** y no es un caso raro: `llego`
    con null = al gasto se le ASIGNÓ este vuelo estando suelto (lo más común
    de todos: la oficina liga un gasto de la bandeja) y `salio` con null =
    se le QUITÓ el vuelo. Sin contraparte NO hay «otro vuelo»: el panel dice
    «Gasto asignado a este vuelo» / «Gasto desligado de este vuelo» y no
    pinta liga (antes el tipo lo declaraba `string`, el título mentía y el
    enlace iba a `/admin/flights/null`).

18. **Comprobante (2 opciones) y semáforo de facturación (4 estados) —
    14-sep-2026, pedidos del cliente.** Son DOS preguntas distintas y jamás
    se mezclan: `estatus_comprobante` = «¿trajo papel?»,
    `estatus_facturacion` = «¿ya se facturó?».
    - **Comprobante, SIN migración**: el enum de BD sigue con tres valores y
      NADIE reescribe filas. Regla de lectura única
      `src/common/comprobante.util.ts`: `hayComprobante(e) = e !==
      'SIN_COMPROBANTE'` y `etiquetaComprobante` devuelve SOLO «Con
      comprobante» / «Sin comprobante» (la palabra «Factura» salió de los
      textos: se confundía con el semáforo vecino). `FACTURA` es el valor
      que se GUARDA para «con comprobante» (es el que ya manda la app al
      adjuntar foto) y **`VALE` es LEGADO**: se lee igual, no se reescribe
      solo (el panel conserva el VALE de un gasto viejo si el guardado no
      toca el campo). Nada de negocio compara contra `'FACTURA'` a mano.
    - **Facturación**: `PENDIENTE` 🔴 · `SOLICITADA` 🟡 · `FACTURADA` 🟢 ·
      **`NO_FACTURABLE` ⚪ «No requiere factura»** (migración
      `20260914000002`: el CHECK se busca por su DEFINICIÓN en
      `pg_constraint`, el nombre no se adivina). Fuente única
      `src/common/facturacion-gasto.util.ts`: el filtro `NO_FACTURADA` es
      `in (PENDIENTE, SOLICITADA)` — **ya no `!= FACTURADA`**, o los
      `NO_FACTURABLE` caían en la bandeja de "falta por facturar" y no
      cuadraban con el checklist — y `cuentaComoSinFacturar` (pre-cierre)
      excluye FACTURADA, NO_FACTURABLE, `medio_pago = BODEGA` y
      `categoria = PERSONAL_DUENO`. El reporte de EFECTIVOS del Excel tiene
      TRES cubos (facturado / POR FACTURAR / no facturable): meter el ⚪ en
      cualquiera de los otros dos sería una cifra falsa. El trigger
      `gasto_sync_facturacion` marca FACTURADA también desde NO_FACTURABLE
      al AMARRAR una factura recibida (hay factura ⇒ está facturado); el
      desamarre sigue regresando a PENDIENTE solo desde FACTURADA.
    - **TOLERANCIA a la migración no aplicada**: un INSERT/UPDATE con
      `NO_FACTURABLE` contra una base sin `20260914000002` revienta el CHECK
      viejo (23514). `mensajeNoFacturableSinMigracion` lo convierte en **400
      legible** («Esta opción necesita la migración 20260914000002;
      mientras, usa Pendiente»), nunca 409 genérico ni 500 (un 500 dispara
      el reintento del outbox de la app).

19. **Pre-cierre «Tacómetros en revisión»: QUÉ tramos son (14-sep-2026).**
    El item `tacos_en_revision` es ADITIVO — `clave`, `titulo` y `count`
    (= TRAMOS amarillos, no vuelos) no cambian — y ahora trae `vuelos`
    (chips deduplicados `{id, folio, estado, fecha_vuelo}`, el shape que el
    renderer del panel ya pinta con liga a `/admin/flights/<id>`) y `tramos`
    (`{vuelo_id, folio, orden, origen_iata, destino_iata, fecha_salida_plan,
    motivo, piloto_nombre}`), más un `detalle` que dice cuántos tramos en
    cuántos vuelos. Helpers PUROS en
    `src/modules/profit-sharing/tacos-revision.util.ts`: `motivo` es la
    primera línea ACCIONABLE de `revision_motivo` (`soloPendientes` deja
    fuera el bloque `Registro: …`, que es procedencia, no alerta) y el
    piloto es el del TRAMO con herencia del vuelo, resuelto a nombre con
    `fetchNombres` en UNA consulta (lo que no resuelva sale `null`, jamás un
    nombre inventado). `tramos` va TOPADO a `MAX_TRAMOS_EN_REVISION = 200`
    mientras que `count` es siempre el total real: quien pinte «y N más…»
    cuenta contra `count`, nunca contra `tramos.length`. «Resolver» sigue
    llevando a `/admin/taco-live`.

20. **TIPO DE CAMBIO = 6 DECIMALES, y el total en pesos se LEE (17-sep-2026,
    caso del vuelo #314).** Fuente única `src/common/tc.util.ts`
    (`TC_DECIMALES = 6`, `round6`, `normalizarTc`, `totalMxnDeVuelo`).
    - **Precisión**: `vuelo.tc_usd_mxn`, `cobro_vuelo.tc_usd_mxn`,
      `cobro_grupo.tc_usd_mxn`, `vuelo_grupo.tc_usd_mxn`,
      `cotizacion_version_history.tc_usd_mxn` y `gasto.tc_gasto` son
      `numeric(12,6)` (migración `20260917000002_tc_seis_decimales.sql`, con
      backfill del TC de los vuelos cuyo total ya no cuadraba).
      `tipo_cambio_oficial.tc`, `compra.tc_usd_mxn` e
      `inventario_movimiento.tc_usd_mxn` se quedan en 4 a propósito
      (referencia y compras, no el precio que el cliente vio).
    - **Todo escritor de un TC pasa por `normalizarTc`** — motor
      (`quotes.service`: `tcQuote` y `camposDesdeBreakdown` usan la MISMA
      llamada, así lo que se guarda es exactamente lo que compuso los pesos),
      grupos (`ArmadoCtx.tc_usd_mxn`, sobre de cobro vía
      `particionCobroGrupo`), cobros/reembolsos/PATCH de cobro, cubrir con
      externo, alta de externo, gastos (alta y PATCH), importador de
      combustibles y el `tc_gasto` DERIVADO de la conciliación
      (`round6`, ya no `Math.round(x*10000)/10000`). Los DTOs NO rechazan
      decimales de más: se normalizan.
    - **El costo del operador EXTERNO en pesos** (`resolverCostoExterno`)
      convierte con ese MISMO TC normalizado: `costo_externo_tc` y el
      `costo_externo_usd` derivado tienen que reproducirse con el TC que
      quedó en `vuelo.tc_usd_mxn` (cotizar, revisar, cubrir con externo y
      alta de externo pasan los cuatro por `normalizarTc`).
    - **El total en pesos de un vuelo se LEE de `monto_total_mxn`, JAMÁS se
      recalcula** (`totalMxnDeVuelo`): ese número lo compuso el motor
      incluyendo los renglones NATIVOS en MXN (TUAS/extras pagados en pesos),
      que nunca pasaron por el TC — `usd × tc` los ignora y desvía el total.
      Ya lo usan el Libro Dinero (`dinero-report`), el balance por avión
      (total del cliente; las PARTICIONES por avión sí siguen con `× tc`), el
      reporte por vuelo, el CFDI (`invoices.service`) y los PDF de cotización.
    - **Síntoma que esto cierra**: la hoja imprimía «Total MXN (T.C. 16.9916)
      $100,000.00» y «Registrar cobro» decía «Total ≈ MXN $99,999.81», porque
      el operador tecleó 16.991632 y la BD guardaba 16.9916.

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
- **Espejo a GOOGLE CALENDAR (sistema → Google, UNIDIRECCIONAL; pedido del
  cliente del 12-sep-2026)** — `calendar/calendar-sync.service.ts` sube al
  calendario **PRIMARIO de `aerochartercancunflightplanner@gmail.com`** (NO
  `info@vuelatour.com`, dato viejo ya corregido en `.env.example`/`env.schema`;
  la service account `vuelatour-calendar-sync@vuelatour.iam.gserviceaccount.com`
  es OWNER y el calendario está en `America/Cancun`) TODO lo que muestra el
  calendario del sistema: vuelos (**UNA SOLA FILA por vuelo** desde el
  15-sep-2026), descansos de piloto, eventos NO-vuelo de la flota y —desde el
  12-sep-2026— **mantenimientos**. Se prende con las 3 variables de Railway
  (`GOOGLE_CALENDAR_SYNC_ENABLED`, `GOOGLE_CALENDAR_ID`,
  `GOOGLE_SERVICE_ACCOUNT_JSON`); sin ellas queda inactiva y
  `GET /v1/calendar/sync-estado` responde `enabled:false`. Desde el
  12-sep-2026 el espejo es **AUTOMÁTICO por cola en BD** (ver el bullet
  «AUTOMÁTICA POR COLA»): ya no depende de que un hook alcance a Google.
  - **UNA SOLA FILA POR VUELO — FORMATO DE LA OFICINA (pedido del cliente,
    15-sep-2026)**: el Google Calendar lo sigue usando UNA persona —**Luis, el
    mecánico**; los demás viven en la app—, así que el evento vuelve a verse
    como los que la oficina capturaba a mano. Un solo evento por vuelo para
    TODOS los tipos (SENCILLO/REDONDO/MULTIESCALA, propios y externos),
    guardado en `vuelo.google_calendar_id`.
    - **Título** `{piloto} {AVIÓN} {ruta} {hora}` — `Saab N621TX
      cun-pce-ctm-pce-cun 6:50`. SIN `T1`, SIN pasajeros, SIN `⚠ permiso
      pendiente` (el color lo dice y la descripción lo conserva). Piloto =
      `usuario.apodo` si existe, si no su PRIMER nombre; externo ⇒ `externo`;
      sin asignar ⇒ `sin piloto`. AVIÓN = la matrícula del primer tramo activo
      (con herencia del vuelo); en un vuelo EXTERNO, `avion_externo_matricula`
      y, si no la capturaron, `operador_externo` (revisión 17-sep-2026: ese
      campo a veces trae el nombre de la persona —«Carlos Muciño»— y la
      casilla es del AVIÓN; en la mayoría de los externos de hoy el operador
      ES la matrícula: «XA-TYV»). Ruta = IATA en MINÚSCULAS de los tramos
      ACTIVOS (origen del 1.º + destino de cada uno); sin escalas sale del
      vuelo (`REDONDO` ⇒ `cun-mid-cun`). Hora = salida del primer tramo activo
      en hora Cancún `H:MM` sin cero a la izquierda.
    - **Ventana**: `start` = salida del primer tramo activo
      (`fecha_salida_plan ?? fecha_vuelo`); `end` = el instante conocido MÁS
      TARDÍO (salidas de los tramos + `fecha_traslado_final`) **+ 1 h**, nunca
      menos de `start + 1 h` y nunca más de 30 días (una fecha con el año mal
      capturado pintaría una barra de meses). `escala` **no tiene**
      `fecha_llegada_plan`. Así un redondo es UNA fila 10:00–19:00 y un viaje
      con pernocta abarca sus días.
    - **Descripción**: `Folio / Estado / Cliente / Pasajeros / Aeronave |
      Operador externo / Piloto (nombre completo) / Permiso de pista:
      PENDIENTE` + **una línea por tramo** (`T1 cun-mid 10:00 · 2 pax`, `T2
      mid-cun 18:00 · ferry`) + `Monto`, `Notas` y el ancla legible
      `VuelaTour · vuelo <id>`. La línea del tramo AÑADE su matrícula y su
      piloto corto SOLO cuando difieren del encabezado (`T2 ptu-cun 15:00 ·
      2 pax · N990GG · Zamora`): el título solo puede decir UN avión y UN
      piloto, y en un vuelo MULTI-AVIÓN (invariante 10) o con rotación de
      piloto (caso #129) el formato viejo sí lo decía —un evento por tramo—.
      El permiso en la descripción sale si
      **CUALQUIER** tramo activo está pendiente; el **color** sigue mirando
      solo el PRIMER tramo activo (criterio de siempre) — puede haber fila de
      color normal con «PENDIENTE» en el texto: el texto manda.
    - `extendedProperties.private` = `vuelatour_vuelo_id` +
      **`vuelatour_tramo: 'vuelo'`** (valor único).
    - **LEGADO**: `vuelo.google_calendar_regreso_id` y
      `escala.google_calendar_id` ya NO se publican. Cada `syncFlightAhora`
      los borra de Google y los pone en `null` **ANTES** del upsert (un
      borrado que falla CONSERVA el id y devuelve `false`). Los eventos viejos
      que queden en Google (`vuelatour_tramo` = `ida` / `regreso` / `leg-N`)
      los barre el **paso inverso** como «duplicado: la fila apunta a otro
      evento» en cuanto su columna queda en null — por eso `verificarVivos`
      SIGUE leyendo esas dos columnas (mientras el borrado falle, el evento
      debe conservarse).
    - **El cambio de formato se aplica con un RESYNC**: `reconcileVentana` y
      `resyncTodo` pasan por `sincronizarVentana → syncFlight(directo)` →
      `syncFlightAhora`, sin atajos, así que reescriben todos los vuelos de la
      ventana. Orden de despliegue: migración `20260917000001` → API →
      `POST /v1/calendar/resync` (y el reconcile nocturno hace el paso
      inverso que limpia los eventos viejos).
    - Helpers **PUROS** en `calendar/google-evento.util.ts`
      (`tituloEventoVuelo`, `rutaMinusculas`, `horaCortaCancun`,
      `descripcionEventoVuelo`, `ventanaEventoVuelo`, `nombreCortoPiloto`),
      con los títulos REALES de la oficina congelados en su spec.
  - **`usuario.apodo` (migración `20260917000001`, PENDIENTE de aplicar)**: nombre corto con el que
    la oficina conoce al piloto («Saab» = Alexander E. Saab, «Zamora» =
    Abraham Zamora, «Pab» = Pablo Canales) — el primer nombre NO es como lo
    conocen. Texto libre ≤ 20 caracteres (validado en el DTO), `null` = usa el
    primer nombre. Viaja en `COLUMNS` de `users.service` y en `VUELO_SELECT`
    del espejo. El **fan-out** `trg_usuario_calendar_fanout` escucha ahora
    `update of nombre, apodo` (misma migración), así que cambiar el apodo
    re-encola los vuelos del piloto. **Tanto `users.service` como
    `calendar-sync.service` TOLERAN que la migración no esté aplicada**: se
    degradan UNA vez (avisan en el log) y siguen sin la columna, en
    vez de tumbar el alta de usuarios o el espejo entero. **Son DOS errores
    distintos y los dos cuentan** (revisión adversaria 17-sep-2026,
    `esColumnaInexistente`): en un SELECT Postgres responde `42703`, pero
    cuando la columna va en el CUERPO de un insert/update PostgREST ni
    consulta —la rechaza contra su schema cache con `PGRST204` y el mensaje
    «Could not find the 'apodo' column of 'usuario' in the schema cache», que
    NO dice «does not exist»—. Con solo 42703, el alta de usuarios respondía
    500 durante toda la ventana entre el deploy y la migración (el payload de
    `create` SIEMPRE lleva `apodo`).
  - **HUECOS H1–H5 CERRADOS TAMBIÉN EN CÓDIGO** (revisión adversaria
    12-sep-2026): con la cola activa los triggers ya los cubren, pero estos
    arreglos valen **aunque la migración no esté aplicada** y bajan la latencia
    cuando sí lo está:
    - `clon-vuelo.util.ts` excluye `google_calendar_regreso_id` de
      `CAMPOS_NO_CLONABLES`: el clon de `reassignAircraft` nacía apuntando al
      MISMO evento de regreso que el original, los dos espejos lo escribían y
      el `removeFlight` del original (cancelado) lo BORRABA.
    - `flights.deleteEscala` y `quotes.replaceEscalas` borran el evento del
      tramo (`calendarSync.removeEscalaEvent`) **ANTES** del `.delete()`:
      después ya no hay `google_calendar_id` que leer y el evento se quedaba
      vivo sin fila que lo apuntara. `replaceEscalas` (re-cotizar con menos
      tramos) era el huérfano más frecuente de la operación normal.
    - `deleteEscala` corre `refreshPermisosDeVuelo` **ANTES** de `syncFlight`
      (al revés, el permiso no llegaba a Google — entonces en el título con
      `⚠`, hoy en la línea `Permiso de pista: PENDIENTE` y en el color).
    - `airports.refreshPermisosDeVuelo` devuelve **`boolean`** («escribí algo»)
      y `alerts.refrescarPermisosProximos` espeja solo cuando escribió (H1:
      `estado_permiso` hasta +90 d, escrito a las 08:00 Cancún, 16 h después
      del reconcile y fuera de su ventana). `alerts.sincronizarEspejoIda`
      espeja tras mover `vuelo.aeronave_id` (H2: matrícula y color del evento).
    - `flights.updateEscala` espeja cuando cambia CUALQUIER campo pintado
      (H3: `orden`, `pasajeros`, `es_ferry` salen en la línea del tramo de la
      descripción), no solo la ruta o la fecha — es el `PATCH /flights/legs/:id` del editor
      único de la app, que manda el DTO completo también desde su outbox.
      Reenviar los MISMOS valores NO espeja (el DTO completo no es un cambio).
    - Sigue ABIERTO sin la cola (solo los triggers lo cubren): el **fan-out
      H4** de `aeronave.matricula`/`color_calendario`, `usuario.nombre` y
      `cliente.nombre` (una fila ⇒ N eventos) y H6 (`groups.confirm`).
  - **Best-effort SIEMPRE**: todo hook es `void` (nunca `await` bloqueante) y
    ningún fallo de Google llega al cliente. `syncFlight`/`syncMantenimiento`
    se tragan sus errores y devuelven `boolean` SOLO para los conteos.
    `EngineeringService.espejoGoogle` añade `.catch` porque una promesa
    rechazada tumbaría el proceso (unhandled rejection en Node).
  - **AUTOMÁTICA POR COLA — «que NUNCA falle» (pedido del cliente,
    12-sep-2026)**: la fuente de verdad de que un cambio llegue a Google es
    la **cola persistente `calendar_sync_cola`** (migración
    `20260912000002_calendar_sync_cola.sql`), alimentada por **TRIGGERS** en
    `vuelo`, `escala`, `piloto_descanso`, `evento_flota`, `mantenimiento` +
    fan-out de `aeronave (matricula, color_calendario)`, `usuario (nombre,
    apodo)` y `cliente (nombre)`. Un trigger no se puede olvidar: encola venga el
    cambio del panel, de la app ONLINE, de su **outbox al reconectar** (entra
    por los mismos endpoints), de un cron del API o de un UPDATE a mano en la
    BD — y en `DELETE` captura los ids de Google de **OLD** (`borrar_evento`),
    que es la única forma de matar un evento huérfano (cubre
    `replaceEscalas`, `deleteEscala`, los `ON DELETE CASCADE` y los borrados
    por SQL).
    - **El worker es el ÚNICO que habla con Google** cuando la cola está
      activa: `@Cron('*/20 * * * * *')` `drenarCola` (single-flight) toma
      hasta 50 items listos, los RECLAMA con `tomado_at` (sello propio) y los
      procesa SECUENCIAL: `vuelo → syncFlight`, `descanso → syncDescanso`,
      `evento → syncEvento`, `mantenimiento → syncMantenimiento`,
      `borrar_evento → deleteEvent`. Fila inexistente ⇒ **hecho** (el item se
      borra). Éxito ⇒ `delete` del item exigiendo el MISMO `tomado_at` (si un
      trigger lo re-encoló mientras se procesaba, el borrado no aplica y el
      cambio nuevo se vuelve a procesar: **nada se pierde por una carrera**).
      Fallo ⇒ `intentos+1`, `siguiente_intento_at = now() + min(30 s ·
      2^intentos, 1 h)` y `ultimo_error` (pasado por `sanitizarError`: sin
      `key=`, sin llaves PEM). **Un 403 de cuota / 429 PAUSA el drenado
      completo 5 min** (en memoria) sin quemar intentos de los demás.
    - **Los ~30 hooks NO se tocaron uno por uno**: con la cola activa,
      `syncFlight` / `syncMantenimiento` / `upsertDescansoEvent` /
      `upsertEventoFlotaEvent` solo hacen «**drenar pronto**» (debounce 2 s,
      single-flight) y devuelven el id que ya estaba — el trigger encoló el
      cambio antes de que el hook corriera. `{ directo: true }`
      (`OpcionesEspejo`) = lo pide el WORKER o el barrido: escribe a Google
      ahora. Sin cola activa, TODO se comporta como antes (hooks directos).
      `removeFlight` sigue directo a propósito (corre ANTES de borrar las
      filas); si falla, el trigger del DELETE encola `borrar_evento` con los
      ids de OLD y el worker lo reintenta.
    - **TOLERANTE A LA MIGRACIÓN NO APLICADA** (invariante 12/13,
      `calendar-sync-cola.util.ts#ColaSondaCalendar`): sonda
      `calendar_sync_cola_activa()` 1 vez, `true` memorizado, `false`/error
      re-sondeado cada ≤ 10 min. **Aplicar la migración ENCIENDE el modo
      automático sin redeploy**; el deploy del API y la migración van en
      cualquier orden. Ante cualquier duda la sonda dice `false` = el
      comportamiento de hoy (asumir una cola que no existe dejaría los
      cambios sin subir).
    - **La sync APAGADA no drena ni quema intentos**: la cola espera (prender
      las 3 variables sube todo lo acumulado). El único crecimiento posible
      es 1 fila por entidad (índices únicos parciales `(entidad, entidad_id)`
      y `(google_event_id) where entidad='borrar_evento'`: una ráfaga de 20
      ediciones del mismo vuelo se COLAPSA en un item).
    - **ANTI-LOOP (crítico)**: el trigger ignora los UPDATE cuyo único cambio
      son `google_calendar_id` / `google_calendar_regreso_id` / `updated_at`
      (compara `to_jsonb(OLD)` vs `to_jsonb(NEW)` con esas llaves fuera), y en
      `vuelo`/`escala` el trigger es `AFTER UPDATE OF <columnas que Google
      pinta>` — una captura de tacómetro no encola nada. Sin esto, el
      write-back del id se re-encolaría para siempre.
    - **EL ID DE GOOGLE YA NO MUEVE `updated_at`**: la misma migración
      redefine `public.tg_set_updated_at()` para conservar el sello cuando lo
      único que cambió son los ids de Google. Antes cada `saveEventId` movía
      `updated_at` sin cambio de negocio ⇒ deltas falsos en
      `?updated_since` y **409 `CONFLICTO_VERSION` espurios** contra el
      `if_updated_at` de la app offline (invariante 13). Los `save*EventId`
      mandan SOLO la columna del id, **y solo cuando el id CAMBIÓ** (revisión
      adversaria 12-sep-2026: los de ida/regreso lo escribían en CADA
      sincronización con el mismo valor, un UPDATE sin cambio de negocio que
      movía el sello y una escritura de más por pasada): no agregar más campos
      a esos updates ni quitar la guarda `id !== id guardado`. La excepción exige **DOS** condiciones
      (revisión adversaria 12-sep-2026) y no una: que **cambie de verdad** un
      `google_calendar_id`/`google_calendar_regreso_id` **y** que el resto de
      la fila sea idéntico. Esa función la comparten **37 triggers en 23
      tablas** (gasto, cobro_vuelo, inventario_movimiento, aeronave…): sin la
      primera condición, un UPDATE que no cambia NADA dejaría de sellar
      `updated_at` en TODAS ellas — un cambio de semántica que nadie pidió. En
      las tablas sin columnas `google_calendar_*` la excepción NUNCA aplica y
      el comportamiento es byte a byte el de hoy.
    - **EL BARRIDO Y EL WORKER NO ESCRIBEN A LA VEZ** (revisión adversaria
      12-sep-2026): los dos escriben DIRECTO a Google, así que si coincidieran
      en un vuelo SIN `google_calendar_id` los dos harían `events.insert` y
      Google se quedaría con un evento DUPLICADO cuyo id no vive en ninguna
      fila (fantasma imborrable: el barrido solo mira filas vivas).
      `sincronizarVentana` toma la bandera `barriendo` —en `finally`, o la cola
      no volvería a drenar nunca—, espera a que termine el drenado en curso
      (máx. ~15 s) y el worker se abstiene mientras dure. **Entre RÉPLICAS
      lo resuelve el candado en BD (D12, ver el bullet «RED DE SEGURIDAD»)**:
      el barrido toma `calendar_sync_lock(912001)` y el worker
      `calendar_sync_lock(912002)`. Railway corre **1 réplica hoy**. Riesgo
      residual con 2+ réplicas: son claves DISTINTAS, así que el barrido de
      una réplica y el worker de OTRA todavía podrían insertar el mismo evento
      (la exclusión barrido↔worker sigue siendo la bandera de memoria, que es
      intra-proceso). Se eligieron dos claves para que un barrido muerto —TTL
      de 2 h— no congele el drenado; si algún día se escala a 2 réplicas, la
      decisión a revisar es usar UNA sola clave para los dos.
    - **AVISO a ADMIN** (`alerta_sistema`, dedupe `calendar_sync_cola:<día
      Cancún>` en `alerta_emitida`, UNA vez al día): item con ≥ 12 intentos
      (≈ 1 h de backoff) o el más viejo esperando > 30 min → «La
      sincronización con Google Calendar lleva N cambios sin poder subir
      desde las HH:MM; último error: …». Cuando la cola vuelve a cero, log.
    - `GET /v1/calendar/sync-estado` añade (ADITIVO) `automatica: boolean` —
      flag AUTORITATIVO: `enabled && cola activa` — y `cola: {activa,
      pendientes, con_error, mas_antiguo_at, ultimo_error, ultimo_drenado_at,
      pausada_hasta} | null`. `POST /resync` sigue siendo el backfill manual
      (solo para el arranque) y el reconcile nocturno sigue siendo la RED DE
      SEGURIDAD que escribe directo (no encola). Los «últimos» ya NO viven
      solo en memoria: se persisten (D12, bullet siguiente).
  - **RED DE SEGURIDAD «que nunca falle» (D12, 12-sep-2026)** — el reconcile
    nocturno (`@Cron('15 5 * * *')`, 00:15 Cancún) dejó de ser un simple
    re-publicador:
    - **VENTANA `[hoy−30d, hoy+365d]`** (la misma del resync; antes
      `[−7d, +60d]`): un vuelo agendado para dentro de tres meses podía quedar
      mal DÍAS y nadie lo veía. Son ~395 días SECUENCIALES: la pasada puede
      tardar media hora larga (de ahí el TTL de 2 h del candado).
      **Las 4 lecturas del barrido van PAGINADAS** (`leerPaginado`, `order('id')`
      + `range` de 1000 en 1000; revisión adversaria 12-sep-2026): con la
      ventana vieja de 67 días nunca se pasaba de 1000 filas, con 395 días sí —
      y PostgREST corta en `max-rows` **sin error y sin avisar**, así que todo
      lo que cayera después de la fila 1000 dejaba de publicarse mientras el
      resumen decía «0 errores». Toda lectura nueva del barrido va paginada.
    - **CUOTA A MEDIA PASADA**: si Google responde 403/429, el barrido
      **ABANDONA** la pasada (`abortarSiCuota`, `PausaCuotaBarrido`) y NO corre
      el paso inverso. Antes solo el worker miraba `pausadaHastaMs` y el
      barrido seguía disparando miles de llamadas condenadas al mismo
      calendario que acababa de decir «basta» — y, peor, el paso inverso habría
      decidido borrados con una foto INCOMPLETA de Google. Lo que faltó se
      publica en la pasada siguiente (y la cola sigue con su backoff).
    - **PASO INVERSO Google → BD** (`limpiarHuerfanos`, corre DESPUÉS de
      publicar y con la bandera `barriendo` puesta): lista la ventana en Google
      (`timeMin`/`timeMax`, `singleEvents:true`, `showDeleted:false`,
      `pageToken`, `fields` recortado, tope de 40 páginas) y BORRA los eventos
      que llevan ancla `vuelatour_*` y (a) ya no tienen fila —vuelo/escala por
      `vuelo_id`, descanso, evento, mantenimiento— o (b) su fila apunta a OTRO
      id (**duplicado fantasma**). Reglas SAGRADAS: un evento **sin ancla NO
      se toca JAMÁS** (es de la oficina, C7); si no se pudo verificar (consulta
      con error, ancla que no es UUID) **no se borra**; tope de 500 borrados
      por pasada (más que eso es un error de premisa, se para y se avisa en el
      log). Lecturas de BD por LOTES (`in (...)` de **≤ 150 ids** —`LOTE_IDS_BD`,
      el mismo tope que `DELTA_MAX_IDS_TRAMO`: con 200 uuids la URL de PostgREST
      revienta (414) y el lote entero quedaba «no verificable»—: 1 consulta por
      tipo, 2 para el vuelo —fila + tramos—), nunca N+1. La de TRAMOS va
      **PAGINADA**: es la única que devuelve varias filas por entidad y una fila
      perdida en `max-rows` habría borrado el evento de ese tramo como
      «duplicado fantasma» — BORRAR UN EVENTO VIVO. Los ids permitidos de
      un vuelo son ida + regreso + **el de cada tramo**. Se cuenta en
      `ultimo_resumen.huerfanos_borrados`.
      **REGLA 6 — un evento RECIÉN CREADO no se borra** (`esRecienCreado`,
      `created` de Google, margen 15 min; revisión adversaria 12-sep-2026): sin
      la cola activa los ~30 hooks escriben DIRECTO a Google a cualquier hora
      (también durante la media hora del reconcile) y guardan el
      `google_calendar_id` un instante DESPUÉS del `insert`; listado en ese
      hueco, la fila apunta a `null` y el evento —vivo y legítimo— se leía como
      duplicado fantasma. Un huérfano de verdad nunca es nuevo.
      **POR QUÉ UN SOLO LISTADO Y NO 4 CON `privateExtendedProperty`**
      (desviación deliberada del plan): ese parámetro de Google exige
      `propertyName=value` con un valor CONCRETO — no existe «que TENGA la
      propiedad»; `vuelatour_vuelo_id=*` se toma literal y no empata con nada,
      así que el paso inverso no borraría NUNCA nada (red de seguridad falsa).
      Y los valores que conocemos son los de las filas VIVAS, justo los que NO
      hay que borrar.
    - **ESTADO PERSISTIDO** (`calendar_sync_estado`, clave → jsonb, misma
      migración): fila `sync` = `{ultimo_reconcile_at, ultimo_resync_at,
      ultimo_resumen}` y fila `worker` = `{ultimo_drenado_at, pausada_hasta}`.
      Antes vivían SOLO en memoria y un redeploy de Railway dejaba
      `sync-estado` en «nunca corrió» aunque el reconcile hubiera corrido de
      madrugada; la pausa por cuota también se perdía y el proceso nuevo volvía
      a golpear a Google. La memoria sigue siendo la CACHÉ: `hidratarEstado`
      relee al arrancar (primer `sync-estado` / primera pasada del worker) y
      **solo rellena lo que está en `null`** (lo de esta instancia manda). El
      worker solo escribe cuando hubo items o pausa (si no, sería una fila cada
      20 s). No se usó `configuracion_sistema`: es `clave/activa/descripcion`,
      sin columna de valor JSON. `leer` devuelve `{ok, valor}` y la hidratación
      **solo se da por hecha cuando la BD respondió las dos filas**: con un
      `ok:false` se reintenta, si no un blip de red al arrancar dejaba el panel
      en «nunca corrió» hasta la madrugada siguiente.
    - **CANDADO EN BD** (`calendar_sync_lock(p_clave, p_ttl_seg)` /
      `calendar_sync_unlock`, tabla `calendar_sync_candado`): 912001 = barrido
      (reconcile y `POST /resync`, TTL 2 h), 912002 = drenado (TTL 5 min).
      **NO es `pg_try_advisory_lock` de sesión a propósito**: el API habla por
      PostgREST/pooler y no controla la conexión, así que el unlock podría caer
      en otra y el candado se quedaría tomado PARA SIEMPRE — la red de
      seguridad nocturna muerta en silencio, justo lo contrario de lo pedido.
      Es un **arrendamiento con vencimiento** (fila + TTL, se cura solo si el
      proceso muere) más `pg_try_advisory_xact_lock` como serializador
      instantáneo (ese sí se libera al terminar la función). `ocupado` ⇒ el
      cron se SALTA la pasada y `POST /resync` responde **409** («ya hay una
      sincronización en curso»); `sin_candado` (migración pendiente o BD que no
      contesta) ⇒ **se corre igual, como hoy**: nunca se cancela la red de
      seguridad por no poder tomar un candado. Las dos llamadas viajan con
      **`p_dueno`** (`api:<pid>:<base36>`): en `calendar_sync_candado` se ve QUÉ
      proceso tiene tomado el barrido (lo primero que se pregunta cuando el
      resync responde 409) y el `unlock` va ACOTADO a ese dueño, así que una
      réplica atrasada no borra el arrendamiento que otra acaba de tomar cuando
      el TTL venció.
    - **DOS BARRIDOS TAMPOCO** (`barridoEnCurso`, revisión adversaria
      12-sep-2026): `barriendo` excluía al worker, pero no a otro BARRIDO. Dos
      `POST /resync` a la vez —o un resync encima del reconcile nocturno—
      publicaban los dos DIRECTO a Google y en un vuelo sin
      `google_calendar_id` los dos hacían `events.insert` ⇒ duplicado fantasma.
      El candado de BD **no cubría esto hoy** (sin la migración responde
      `sin_candado` y los dos seguían), así que la exclusión es una bandera de
      memoria que se toma y se suelta SIN `await` en medio: el 2.º resync
      responde **409** y el reconcile se salta con un log.
    - **TOLERANTE** como todo lo demás (`calendar-sync-estado.util.ts#
      EstadoCalendarBd`): sonda `calendar_sync_estado_activa()` 1 vez, `true`
      memorizado, `false`/error re-sondeado cada ≤ 10 min. Sin la migración no
      se consulta ninguna tabla nueva y el comportamiento es el de siempre.
  - **MANTENIMIENTOS**: evento de DÍA COMPLETO en `fecha_programada` (DATE =
    día Cancún), título `🔧 Servicio · <matrícula> · <descripción>`
    (`🔧 En taller · …` si `EN_TALLER`), colorId 5 (ámbar) / 11 (rojo Tomate),
    `extendedProperties.private.vuelatour_mantenimiento_id`, id en
    `mantenimiento.google_calendar_id`. **COMPLETADO o sin fecha ⇒ el evento se
    BORRA** (el calendario del sistema tampoco los pinta). TODO camino de
    escritura de `mantenimiento` llama al espejo: `createMantenimiento` (y su
    replay idempotente — es un upsert, no una notificación), `updateMantenimiento`
    y el servicio auto-programado de `alerts` (nace sin fecha ⇒ no agenda).
    Si algún día aparece una BAJA de `mantenimiento`, debe llamar a
    `removeMantenimientoEvent(google_calendar_id)`.
  - **Título de vuelos**: la oficina identifica el vuelo por el PILOTO, así que
    el summary empieza por su nombre corto (`nombreCortoPiloto`: apodo, si no
    el primer nombre; `sin piloto`; `externo`). El FORMATO vigente es el de
    UNA SOLA FILA del 15-sep-2026 —`{piloto} {AVIÓN} {ruta} {hora}`— descrito
    arriba; el viejo `T1 · N4142R · CUN-PTU · Luis · 3 pax` (un evento por
    tramo, `T2 Ferry · …`, `⚠ permiso pendiente`) YA NO EXISTE: el ferry y el
    permiso viven en la descripción y el color.
  - **Color (pedido del cliente, 12-sep-2026: «los mismos colores»)**: los
    colores de Google son LOS DEL SISTEMA traducidos al más cercano de los 11
    que Google acepta. **Fuente única de los hex**:
    `calendar/colores-calendario.util.ts` (`colorVueloSistema` = la ÚNICA
    implementación de la precedencia **cancelado > tentativo > sin asignar >
    permiso pendiente > externo > color del avión > sin avión #9CA3AF**, más
    `DESCANSO_COLOR`, `EVENTO_COLOR` y los del mantenimiento).
    `calendar.service` la usa para `GET /calendar` y `google-evento.util` la
    traduce con `colorIdGoogleDe` (distancia redmean, PURO):
    `colorIdGoogleDeVuelo` (mismos parámetros que `colorVueloSistema`),
    `colorIdGoogleDescanso`, `colorIdGoogleEvento(colorAvion)` y
    `colorIdGoogleMantenimiento(enTaller)`. `calendar-sync` ya NO tiene
    constantes de colorId propias (se fueron `EXTERNAL_COLOR_ID`,
    `DEFAULT_COLOR_ID` 9, `PERMISO_PENDIENTE_COLOR_ID` 6…): si el cliente
    cambia un color, se cambia en la util y panel + app + Google se mueven
    JUNTOS. El descanso YA lleva color (antes salía sin `colorId`) y el evento
    de flota usa el color del AVIÓN (antes Google los pintaba todos de azul:
    por eso `color_calendario` viaja en el select de `aeronave` del barrido y
    en el hook `espejoGoogle`).
    Del lado del SISTEMA los mismos hex, la precedencia y `sin_asignar` están
    congelados en `calendar.service.spec.ts` («colores y precedencia del
    sistema») y en `colores-calendario.util.spec.ts`: mover un color del
    sistema rompe las tres pruebas a propósito.
    Tabla viva (congelada en `google-evento.util.spec.ts`): tentativo #64748B →
    **8** Grafito · sin asignar #8B5CF6 → **1** Lavanda · permiso pendiente
    #F59E0B → **5** Banana · externo #F0DCDB → **4** Flamenco · sin avión
    #9CA3AF → **1** Lavanda · descanso #14B8A6 → **2** Salvia · evento sin
    avión #0EA5E9 → **7** Pavo real · mant. PROGRAMADO #F59E0B → **5** Banana ·
    mant. EN_TALLER #EF4444 → **11** Tomate (ÚNICA excepción al "más cercano":
    por redmean caería en 6 Mandarina, d≈3 714 vs 30 217, y el taller debe
    leerse ROJO) · N4142R #F97316 → 6 · N58BT #84CC16 → 5 · N621TX #EC4899 → 4
    · N990GG #3B82F6 → 7 · XA-VGV #06B6D4 → 7 · XB-ANU #EAB308 → 5 · XB-IJP
    #6366F1 → 1 · XB-PEV #10B981 → 2. El vuelo CANCELADO (#EF4444) no llega a
    Google (su evento se BORRA).
    **Colisiones conocidas** (11 colores para 18 cosas; libres hoy: 3 Uva,
    9 Arándano, 10 Albahaca): **1** = sin asignar + sin avión + XB-IJP; **2** =
    descanso + XB-PEV; **4** = externo + N621TX; **5** = permiso pendiente +
    mantenimiento PROGRAMADO + N58BT + XB-ANU; **6** = N4142R (+ el rojo del
    cancelado, que no viaja); **7** = evento de flota sin avión + N990GG +
    XA-VGV. **El color en Google NO es un dato confiable, el TEXTO sí** — el
    título (`sin piloto`, `externo`, `🔧`, `😴`, `📌`) y, en el vuelo, la
    línea `Permiso de pista: PENDIENTE` de la descripción. Re-pintar los
    `color_calendario` NO lo resuelve (no hay 8 ids libres); es decisión del
    cliente.
  - **El `motivo` de `sync-estado` no hace eco de la credencial** (revisión
    adversaria 12-sep-2026): `parsearServiceAccountJson` pasa el mensaje de
    `JSON.parse` por `motivoJsonSinValor`, que borra cualquier fragmento
    entrecomillado y conserva solo la POSICIÓN del error. V8 cita un trozo de
    la ENTRADA (`Unexpected token 'x', "x{\"priva"… is not valid JSON`) y esa
    entrada es el JSON de la service account —con su llave PRIVADA—; ese
    mensaje viaja en `motivo` a ADMIN/COORDINADOR/ANALISTA/FACTURACION/SOCIO y
    el panel lo pinta VERBATIM en su chip.
  - `extendedProperties.private.vuelatour_*` ya SE LEE (D12, 12-sep-2026):
    es lo que distingue «nuestro» de «manual de la oficina» en el PASO INVERSO
    del reconcile (bullet siguiente). Fuente única de los nombres:
    `calendar-huerfanos.util.ts` (`ANCLA_VUELO`, `ANCLA_DESCANSO`,
    `ANCLA_EVENTO`, `ANCLA_MANTENIMIENTO`) — los `build*Event` las usan por
    constante, no por literal. El **descanso** empezó a llevar
    `vuelatour_descanso_id` ese día (era el ÚNICO evento nuestro sin ancla):
    `upsertDescansoEvent` recibe `id` y TODO llamador se lo manda
    (`pilots.createDescanso`, `syncDescanso`, el barrido). El anclaje de
    IDEMPOTENCIA sigue siendo el id guardado en la fila
    (`vuelo`/`escala`/`piloto_descanso`/`evento_flota`/`mantenimiento`
    `.google_calendar_id`): si ese id se pierde, el siguiente barrido CREA un
    evento nuevo… y ahora el paso inverso BORRA el viejo la misma noche.
  - **Backfill**: `POST /v1/calendar/resync` (ADMIN) sincroniza los 4 tipos en
    `[hoy−30d, hoy+365d]` (body opcional `desde`/`hasta` ISO), SECUENCIAL, y
    devuelve `{enabled, calendar_id, vuelos, descansos, eventos,
    mantenimientos, errores, huerfanos_borrados, desde, hasta, nota}`; nunca
    lanza por un evento que falle (lo cuenta en `errores`). `huerfanos_borrados`
    ahí es SIEMPRE 0 (el paso inverso es solo del cron) y desde el 12-sep-2026
    puede responder **409** si ya hay un barrido en curso (la bandera
    `barridoEnCurso` de este proceso —vale sin la migración— o el candado de BD
    de otra réplica; mensaje único `MSG_BARRIDO_EN_CURSO`). Comparte
    el núcleo `sincronizarVentana` con el cron `reconcileVentana` (05:15 UTC),
    que desde D12 usa la **MISMA ventana** `[hoy−30d, hoy+365d]`: una sola
    implementación o el calendario queda distinto según quién corrió último.
  - **Idempotencia (regla dura, 12-sep-2026)**: con un `google_calendar_id`
    guardado, un evento SOLO se re-crea si Google dice que ya no existe
    (**404/410**, `eventoAusenteEnGoogle`). Ante cualquier otro fallo (403 de
    cuota, 429, 5xx, red) el error se PROPAGA y se cuenta: re-crear ahí
    duplicaba el evento en el calendario de la oficina y dejaba huérfano al
    anterior (el id nuevo pisaba al viejo y el viejo ya nunca se actualizaba
    ni se borraba). Simétrico al borrar: `deleteEvent` devuelve boolean y el
    id guardado **solo se limpia si el evento quedó fuera de Google** — si no,
    se conserva y el siguiente hook/reconcile reintenta. Un evento vivo en
    Google sin id en la BD es un FANTASMA que ya nadie puede borrar. Desde el
    15-sep-2026 el vuelo es UN solo evento (`syncLegs` ya no existe): lo que
    puede fallar aparte es el borrado de un id LEGADO —`limpiarEventosLegado`
    conserva el id, publica igual la fila única y devuelve `false` para que el
    resumen lo cuente.
  - **Los eventos que la oficina capturó A MANO en Google NO se tocan** (ni se
    borran ni se deduplican; decisión del cliente pendiente): el resync lo dice
    en su campo `nota`. Los vuelos CANCELADOS sí se BORRAN de Google (aunque el
    calendario del sistema los conserve en rojo) y por eso el barrido de la
    ventana **NO filtra por estado**: los cancelados entran para que
    `syncFlight` limpie su evento (no se cuentan en `vuelos`, que es lo
    publicado). Lo mismo vale para un TRAMO cancelado: se borra su evento y no
    se re-crea — incluida la IDA del modelo vuelo (revisión 12-sep-2026: la
    ida cancelada de un REDONDO, y el itinerario con TODOS sus tramos
    cancelados —ahí `activas` queda vacío y la rama por tramos no corre—,
    seguían publicando un evento a nivel vuelo con el color del avión mientras
    el calendario del sistema los pintaba en rojo). Nada bidireccional
    (Google → sistema) todavía.
  - `desde`/`hasta` del resync se NORMALIZAN (`instanteValido`): `@IsISO8601()`
    deja pasar cadenas que `new Date` no entiende (`2026-W01-1`, coma decimal)
    y con ellas la ruta respondía **500**; hoy es un 400 en es-MX, y la coma
    tampoco puede partir el filtro `.or()` de PostgREST.
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
- **APLICADA (verificada en prod el 17-sep-2026 vía MCP: `calendar_sync_cola`,
  `calendar_sync_estado`, `calendar_sync_candado`, `calendar_sync_lock(int,
  int, text)` y `trg_*_calendar_sync` existen)** —
  `20260912000002_calendar_sync_cola.sql`. Estuvo días marcada aquí como
  pendiente porque el MCP se cayó el 12-sep; el modo AUTOMÁTICO está activo.
  Trae TRES cosas (se amplió el mismo archivo
  el 12-sep porque nunca se aplicó): la **cola automática** + el
  `tg_set_updated_at` que ya no se mueve por el id de Google (§1-6), el
  **estado persistido** `calendar_sync_estado` (§7) y el **candado
  multi-réplica** `calendar_sync_candado` + `calendar_sync_lock`/`unlock`
  (§8; el `unlock` es `(int, text)` —acotado al dueño— y la migración dropea
  antes la firma vieja de 1 argumento por si alguien corrió una copia a mano),
  con DOS sondas independientes (`calendar_sync_cola_activa()` y
  `calendar_sync_estado_activa()`). El API ya está desplegable así: mientras la
  migración no exista, el espejo se comporta EXACTAMENTE como antes (hooks
  best-effort, «últimos» solo en memoria, exclusión solo por banderas) y las
  sondas lo encienden solo en ≤ 10 min al aplicarla (sin redeploy). Ya
  aplicada, la comprobación viva es `GET /v1/calendar/sync-estado` →
  `automatica: true` y que `ultimo_reconcile_at` sobreviva un redeploy.
  **Consecuencia que NO hay que olvidar**: con la cola activa los hooks del
  API ya NO escriben directo a Google — si una columna que el evento PINTA no
  está en la lista `after update of …` de `trg_vuelo_calendar_sync` /
  `trg_escala_calendar_sync`, editarla no encola nada y el calendario se
  queda viejo hasta el reconcile nocturno.
- **`moneda` es un ENUM (`public.moneda`)** en `gasto`, `cuenta_bancaria` y
  `cobro_vuelo`: en plpgsql se compara **SIEMPRE `::text`**, nunca contra una
  variable `text` a secas. El 15-sep-2026 `tg_mov_bancario_gasto_suma`
  (migración `20260914000001`) comparaba `c.moneda = v_moneda_gasto` y cada
  liga cargo↔gasto reventaba con «operator does not exist: public.moneda =
  text»: la importación del estado de cuenta se cayó al 37 % y el vínculo
  manual del panel también. Hotfix: `20260915000001_fix_trigger_moneda_enum`.
- **Toda migración con TRIGGER se prueba en seco con un UPDATE/INSERT REAL
  dentro de `begin … rollback`**, no solo con `select`s: el bug anterior era
  invisible para cualquier consulta de lectura.
- **APLICADA** (verificada en prod el 17-sep-2026: las 4 columnas existen):
  `20260916000001_conciliacion_job_resultados.sql` (aditiva, sin triggers),
  desglose del auto-cruce en `conciliacion_import_job`. El API funciona con o
  sin ella.
- **PENDIENTE DE APLICAR (17-sep-2026) — REQUIERE DRY-RUN**:
  `20260917000001_usuario_apodo.sql`. Aditiva en datos
  (`usuario.apodo text`), pero toca **DOS triggers** y por eso va en seco
  primero (`begin … update usuario set apodo = … ; update vuelo set
  operador_externo = … ; rollback`): (1) `trg_usuario_calendar_fanout` pasa a
  `after update of nombre, apodo` (y su función mira las dos columnas) para
  que cambiar el apodo re-encole los vuelos del piloto; (2)
  `trg_vuelo_calendar_sync` suma `avion_externo_matricula` a sus columnas
  (hoy es la casilla «avión» del título de un vuelo externo). Los dos bloques
  se saltan solos si `calendar_sync_cola` no existe. El API 0.0.14 corre CON
  o SIN la migración: ante `42703` (select) o `PGRST204` (cuerpo del
  insert/update) se degrada una vez, avisa en el log y sigue con el PRIMER
  nombre del piloto. Orden: migración → API → `POST /v1/calendar/resync`.
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
- **Google Calendar · huecos residuales de la red de seguridad (D12,
  12-sep-2026)**: (a) los eventos de DESCANSO creados ANTES de este lote no
  llevan `vuelatour_descanso_id`, así que si quedó alguno huérfano el paso
  inverso NO lo puede distinguir de un evento manual y lo deja vivo (se borra
  a mano; los nuevos ya nacen con ancla y el barrido re-ancla los de las filas
  vivas de la ventana); (b) un evento huérfano cuya fecha cayó FUERA de
  `[hoy−30d, hoy+365d]` no se lista y sobrevive; (c) con 2+ réplicas el barrido
  de una y el worker de otra usan claves de candado distintas (ver el bullet
  del espejo); (d) el paso inverso lista la ventana completa en vez de 4
  consultas por `privateExtendedProperty` porque Google no permite buscar «la
  propiedad existe» — si algún día se agrega un marcador de valor FIJO a todos
  los eventos, se podría acotar (solo serviría para los eventos nacidos después
  de ese cambio); (e) **el calendario NO se puede compartir entre entornos**: si
  otro API (staging, o una copia local con las mismas 3 variables) apuntara al
  MISMO `GOOGLE_CALENDAR_ID` con OTRA base, el paso inverso de cada uno vería
  los eventos del otro con ancla `vuelatour_*` y sin fila propia, y los
  BORRARÍA. Antes de D12 no pasaba nada (nadie borraba); ahora es regla de
  operación: un calendario por base; (f) un evento del sistema DUPLICADO a mano
  desde la UI de Google (que copia las `extendedProperties`) se borra como
  duplicado fantasma — deseable para deduplicar, pero indistinguible de una
  copia hecha a propósito por la oficina; (g) un evento con ancla creado en los
  últimos 15 min no se evalúa (regla 6): su limpieza espera a la noche
  siguiente.
- **Google Calendar (12-sep-2026)**: qué hacer con los ~305 eventos que la
  oficina capturó A MANO en `aerochartercancunflightplanner@gmail.com`
  (borrarlos, dejarlos conviviendo o deduplicar contra los del sistema) lo
  decide el CLIENTE: hoy no se tocan. Colores COMPARTIDOS en Google (solo hay
  11): sin asignar y el gris sin avión caen los dos en Lavanda, el permiso
  pendiente comparte Banana con el mantenimiento PROGRAMADO y con N58BT/XB-ANU,
  el descanso comparte Salvia con XB-PEV, el externo Flamenco con N621TX, y el
  evento de flota Pavo real con N990GG/XA-VGV — re-pintar los
  `color_calendario` no alcanza para 8 aviones + 6 significados; lo decide el
  CLIENTE (ver el bullet del espejo).
- Complementos de pago REP (A2), Calendar bidireccional (Fase C), clasificación
  IA de facturas recibidas, `factura_recibida.gasto_id` no actualiza
  `gasto.estatus_comprobante` al amarrar.
- **Vigilar (11-sep-2026, revisado el 12-sep)**: `reviseParaGrupo` pasa por
  la MISMA regla de avión que el cotizador (invariante 14) pero SIEMPRE con
  `conservarAvionOperativo: true`, así que no reasigna nada. El armado del
  grupo re-envía como referencia de tarifa el avión **OPERATIVO** del hijo
  (`groups.avionCtxDeHijo`: `h.aeronave_id ?? snapshot.aeronave.id`), NO el
  cotizado: es deliberado (en el grupo la flota se elige en el wizard, el
  cambio operativo lo hace `flights.assign` y `meta.grupo
  .precio_desactualizado` marca cuando el avión efectivo ≠ el cotizado). Si
  el cliente pide que el precio del hijo siga al avión COTIZADO (R1 del
  12-sep aplicada al grupo), el cambio va en `avionCtxDeHijo`, no en
  `reviseParaGrupo`.
