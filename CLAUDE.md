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
   - **T.U.R.M. = TSO, COMO EN LA BITÁCORA (22-sep-2026): antes el
     formulario lo leía al revés.** T.U.R.M. = *Tiempo desde la Última
     Reparación Mayor* = horas voladas DESDE el overhaul. El API lo leía
     como «horas del componente EN su último overhaul» y guardaba
     `tso_base = horas_totales − turm_componente`; la oficina capturó la
     hélice del XB-ANU con T.T. 2708 y T.U.R.M. 364 (TBO 2000) y quedó
     `tso_base = 2344`: la ficha pintaba «TSO 2,344.00 · Restantes −344.00 ·
     Vida usada 100 %» y el avión salía con «TBO agotado» en el semáforo de
     aptitud. Hoy el T.U.R.M. que se teclea es **el TSO de HOY** y se guarda
     en el marco del ANCLA: `tso_base = turm_componente − max(0, hobbs −
     aeronave_horas_ref)` (fuente única `common/turm-componente.util.ts`,
     con spec de los casos reales), en `create` y en `update` de
     `engines.service` y `propellers.service`; `null` = sin overhaul
     (`tso_base = null`) y **T.U.R.M. > horas de vida VIVAS es un 400**,
     porque nadie vuela más desde la reparación que en toda la vida del
     componente. **La resta del delta NO es opcional** (revisión adversaria
     22-sep-2026): `tso_base` está anclado y el TSO que la ficha pinta —y
     que el panel PRELLENA en el formulario— es el VIVO (`tso_base +
     delta`). En el XB-ANU el delta es 0 y no se nota, pero las dos hélices
     del **N4142R** están ancladas en 4448.9 con el taco en 5546.9 (delta
     **1,098 h**): guardar el T.U.R.M. tal cual habría inflado su TSO en
     esas horas —teclear 2,400 y que la ficha responda 3,498—, que es el
     mismo desconcierto del reporte, al revés. `tso_base` NEGATIVO es
     legítimo (overhaul reciente sobre un ancla vieja): el cálculo vivo lo
     compensa y recorta a 0, como ya documentaba el código anterior. Al
     re-anclar (cambio real de `horas_totales`) el delta vuelve a 0 y el
     T.U.R.M. entra tal cual. `componenteEstado`
     devuelve `turm_componente` = **TSO vivo** (idéntico a
     `horas_desde_overhaul`; antes devolvía su complemento). La columna
     LEGADA `turm` (taco del avión en el overhaul) no cambió. **Los datos
     ya guardados NO se migran**: la fila del XB-ANU la corrige el usuario
     desde el panel tras el deploy.

2. **`cobrosEnUsd` (`src/common/cobros-usd.util.ts`) es LA única fuente de
   "cuánto se cobró en USD".** La usan: `refreshCobradoFlag`, el reporte por
   vuelo, `profit-sharing.compute`, el pre-cierre y `quotes.revise` (réplica
   local para evitar dependencia circular). Un cobro MXN sin TC toma
   `vuelo.tc_usd_mxn` de respaldo; si aún así no convierte, se EXPONE en
   `sin_tc_*` — jamás desaparece en silencio ni se suma crudo como USD.

3. **Desglose canónico del cotizador v1.3**: cada componente se redondea antes
   de sumar y `subtotal + tuas + pernocta + extras + ajuste + iva == total`
   exacto. No tocar ese orden de redondeo.
   - **TRAMOS COSTEADOS: fuente única `quotes/tramos-costeados.util.ts` (PURO,
     con spec) — el panel NO calcula (22-sep-2026).** La pantalla de la
     cotización pasa a verse como la hoja INTERNA, con la tabla del Excel de
     la oficina (`RUTA · FECHA · DISTANCIA MILLAS · TIEMPO VUELO · COSTO POR
HORA VUELO · TOTAL POR TRAMO`) y la pinta mientras se teclea. Ese
     `total_usd` por tramo **no existe en el dinero persistido**: el snapshot
     guardaba `tiempo_hr` pero no su importe, y el único que lo calculaba era
     el armador del PDF interno (`round2(tiempo_hr × tarifa)`, inline). Ahora
     el costeo vive en el helper y lo comparten `quotes-pdf-interno.util` y
     `QuotesService.calculate` — si el panel replicara `round2(tiempo_hr ×
tarifa)`, `tramos_ajuste_usd` o el MOTIVO del ajuste, habría dos fuentes
     del mismo número y pantalla y PDF podrían decir cifras distintas del
     MISMO vuelo. Reglas: el ÚNICO número nuevo es `total_usd` (y ni eso si el
     snapshot ya lo trae: entonces se LEE); `tiempo_hr` ya incluye el calzo;
     la diferencia contra la línea canónica TIEMPO_VUELO viaja EXPLÍCITA como
     `tramos_ajuste_usd` + `tramos_ajuste_motivo` («Horas pactadas 1.75 h» ·
     «Sobrevuelo 0.5 h» · «Hora mínima 1.0 h» · «Redondeo»), **jamás repartida
     entre tramos ni escondida**, de modo que `Σ tramos + ajuste == servicio
aéreo`. El `breakdown` de `POST /v1/quotes/calculate` los expone como
     campos **ADITIVOS**: `tramos[i].total_usd`, `tramos[i].tarifa_usd_hr`,
     `tramos[i].tiempo_hhmm` y, en la raíz y DESPUÉS de `meta`,
     `tramos_total_usd`, `tramos_tiempo_total_hr`, `tramos_tiempo_total_hhmm`,
     `tramos_ajuste_usd`, `tramos_ajuste_motivo` (los 5 en `null` cuando no
     hay tabla por tramo — un 0 ahí convertiría todo el servicio aéreo en un
     "ajuste" inexistente). Ese `null` es una **guarda defensiva, no un estado
     que se vea hoy**: `resolveRoute` o entrega tramos (itinerario explícito o
     plantilla MULTIESCALA del catálogo) o **rebota 400** —los caminos legados
     "ad-hoc" y "redondo automático ×2" se retiraron—, y en prod las 231
     cotizaciones con snapshot traen `tramos` como arreglo y **ninguna** en
     null. El spec prueba las dos mitades (que esos caminos rebotan y que el
     mapeo es `?? null`, nunca `?? 0`). Van al final para que el `calculo_snapshot` viejo
     sea un PREFIJO exacto del nuevo: **`lineas`, `totales`, el orden y los
     redondeos no se mueven un byte** (`quotes.service.tramos-costeados.spec`
     congela el breakdown viejo como subconjunto del nuevo). **Se PERSISTEN a
     propósito** (`calculo_snapshot = breakdown`): así la hoja interna de una
     cotización guardada LEE el importe con el que se cotizó en vez de
     re-multiplicar, y el PDF interno —que ya prefería `tramos[].total_usd`
     cuando existe— imprime exactamente eso. La paridad con lo que hoy imprime
     el PDF se congela en `tramos-costeados.util.spec.ts` con payloads REALES
     de prod (#329 con horas pactadas y ajuste de $165.00, #311 que cuadra
     exacto, #294 de 8 tramos). **Paridad verificada contra el binario
     ANTERIOR al refactor** (revisión adversaria 22-sep-2026): se corrió el
     armador del PDF interno viejo y el nuevo sobre las **294** cotizaciones
     de prod con sus escalas, cobros, clientes y catálogo de aeropuertos
     reales y el payload salió **idéntico byte a byte en las 294** — 231 con
     tabla por tramo y 63 con la fila consolidada de respaldo, incluidos los
     84 de "Horas pactadas", 31 de "Hora mínima", 4 de "Sobrevuelo", 20 de
     "Redondeo" y 157 con ajuste 0. Y la pantalla no puede decir otra cosa que
     el PDF: recalculando el pie con el helper sobre los 231 snapshots
     guardados, los 5 campos y el importe de CADA tramo coinciden con lo que
     imprime el PDF, y `Σ tramos + ajuste == línea TIEMPO_VUELO` se cumple en
     los 231.
   - **TIEMPO VUELO (HRS) en horas DECIMALES (24-sep-2026, API 0.0.33, solo
     presentación).** Pedido del cliente con la captura de una CUN→PTU→CUN:
     «la parte de tiempo de vuelo, lo podemos manejar solo en decimales por
     favor? … se nos hacen raros los tiempos» — cada tramo valía 1.19166… h
     (125 nm / 120 kt + 0.15) ⇒ «01:12», el total 2.38333 h ⇒ «02:23», y
     01:12 + 01:12 ≠ 02:23. Fuente única en el MISMO util:
     `horasADecimal` (2 decimales FIJOS, medio hacia arriba en aritmética
     ENTERA de micro-horas: 1.005 → «1.01», `toFixed` daría «1.00») y
     `repartirHorasDecimales(tiempos)` → `{tramos, total}`: total =
     `horasADecimal(Σ tiempo_hr)` y cada tramo por **RESIDUO MAYOR** (piso +
     las centésimas que faltan a los residuos más grandes, empate por orden),
     así **Σ tramos mostrados == total mostrado** y cada tramo queda a ≤ 0.01
     de su propio redondeo; un tramo sin `tiempo_hr` en el snapshot va
     `null` («—») y no suma. Campos ADITIVOS nuevos, por los MISMOS caminos
     que `tiempo_hhmm`: `tramos[i].tiempo_horas` (string | null, al FINAL
     del tramo, después de `total_usd`) y `tramos_tiempo_total_horas` (al
     FINAL del breakdown, después de `tramos_ajuste_motivo`: el breakdown del
     22-sep sigue siendo PREFIJO exacto) en `/quotes/calculate` (y por tanto
     en el `calculo_snapshot`), en `TramoCosteado` / `consolidarTramosCosteados`
     y en el payload del PDF interno (incluida la fila consolidada de
     respaldo). Se reparte sobre TODAS las filas de la tabla (las ocultas del
     PDF del cliente también: el documento interno las imprime todas).
     `tiempo_hhmm` / `tramos_tiempo_total_hhmm` se CONSERVAN por
     compatibilidad pero ya nadie los pinta. Espejos: el panel
     (`lib/admin/quote-sheet-interna.ts#repartirHorasDecimales`, para
     snapshots guardados antes del 0.0.33) y pyservices
     (`_repartir_horas_decimales`, para un payload viejo), con la MISMA tabla
     de casos (`CASOS_HORAS_DECIMALES`) en los tres repos. Specs:
     `tramos-costeados.util.spec.ts` (casos + 2,000 tablas al azar + la
     captura con su dinero intacto: $889.01 × 2 + $12.38 = $1,790.40),
     `quotes.service.tramos-costeados.spec.ts` (llaves al final y el motor
     real con 125 nm a 120 kt) y `quotes-pdf-interno.util.spec.ts` (3 × 0.4167
     ⇒ «0.42», «0.42», «0.41» = «1.25»).

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
   **Desde el 22-sep-2026 tampoco pisa pax/ferry/pernocta/notas del piloto en
   el modo NORMAL** (las omite del UPDATE cuando la oficina no las cambió
   respecto a lo cotizado) y el precio se calcula con los tramos del
   `calculo_snapshot`, no con la escala viva: ver invariante 24.

7. **Conciliación**: auto-match solo `medio_pago IN (TARJETA_CORP,
TRANSFERENCIA, PAYWISE)` + moneda de la cuenta (PAYWISE es bancario desde
   el 2-sep-2026; caja chica sigue mirando SOLO EFECTIVO). `BODEGA` (cargo
   contable de inventario), `EFECTIVO` (caja chica) y `PERSONAL_*`
   (reintegros) nunca se cruzan con el banco. ABONOS se cruzan con
   `cobro_vuelo` vía `movimiento_bancario.cobro_id`.
   **PAYWISE como MÉTODO DE COBRO (9-sep-2026)**: fuente única de
   etiquetas/conjuntos `src/common/metodo-cobro.util.ts`
   (`METODOS_COBRO_ABONO_AUTO` = TRANSFERENCIA, HSBC_LINK, CHEQUE, PAYWISE;
   `+BILLPOCKET` manual).
   **ETIQUETAS (22-sep-2026, palabras del cliente: «en vuelos, apartado
   COBRO, colocar las opciones link de pago, transferencia, efectivo»)**:
   `HSBC_LINK` = «Link de pago (HSBC)» y `PAYWISE` = «Link de pago
   (Paywise)» (antes «HSBC link» / «Paywise») y `DOLARES` = «Dólares
   directo» (así lo pinta el panel desde siempre; con «Dólares» a secas el
   recibo impreso no coincidía con la pantalla — revisión adversaria del
   22-sep); TRANSFERENCIA, EFECTIVO, CHEQUE, BILLPOCKET y OTRO no cambian.
   **Los VALORES del enum
   NO se tocan** (romperían cobros históricos, conciliación y la whitelist
   del piloto). La tabla vive en `METODO_COBRO_LABELS` con spec
   (`metodo-cobro.util.spec.ts`) y la COPIAN el panel
   (`lib/admin/metodos-pago.ts`) y la app; la imprimen el recibo de pago
   (`cobro-recibo.service`) y el PDF interno de la cotización. IVA como BillPocket (0 % por default), FormaPago
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

   **JAMÁS UN USD SUMADO COMO MXN EN EL VALORIZADO (22-sep-2026).** Fuente
   única `inventario-cardex.util.ts#statsFromLayers`: `valor_mxn` suma SOLO
   las capas con pesos REALES (compra en MXN, o USD con TC — `pesosExactos`),
   la parte comprada en dólares SIN tipo de cambio va en `valor_usd_sin_tc`
   (en DÓLARES) y `pesos_exactos` dice si `valor_mxn` ya es todo el
   valorizado (criterio de `costoSinTc`: un costo de $0 vale 0 en cualquier
   moneda y NO cuenta como «sin TC»). Los dos campos no se suman entre sí
   NUNCA. `valor_usd` (el USD interno del reparto, TODAS las capas) no
   cambió. En la **hoja «inventario» del Balance general**
   (`resumenTiendita` → `BalanceHojaInventarioPayload`) cada fila lleva
   `valor_costo_mxn` (pesos reales; 0 es 0, no «se desconoce»),
   `valor_costo_usd` (dólares sin TC; null si 0) y `sin_tc`, con totales
   `total_valor_mxn` / `total_valor_usd` separados y `filas_sin_tc` para la
   nota al pie; el Excel los pinta en DOS columnas (pyservices). Todo eso es
   ADITIVO en los dos sentidos: un pyservices viejo ignora los campos y
   pinta la hoja de siempre, y un pyservices nuevo con un API viejo también.
   Reporte del cliente: la hoja decía «Aceite 15w 50 · 30 · $3,300.00 MXN»
   cuando la única entrada era 30 × 110 **USD** sin TC; en producción 67 de
   las 68 ENTRADAs (66 productos, carga VTF-INV-001 del 29-ago) son USD sin
   TC, o sea casi toda la columna y su total. Espejo del mismo criterio:
   `agregadosDeItem` ya excluía compras/vendido/utilidad sin TC
   (`con_movimientos_sin_tc` — mira TODO el cardex, incluidas capas ya
   consumidas: NO es lo mismo que `sin_tc`, que mira las capas vivas), el
   Excel «Inventario valorizado» tiene su columna «Valor USD (sin T.C.)» y
   `listItems` su `valor_total_usd_sin_tc`. Lo único que sigue mezclando es
   `costo_fifo_mxn_actual` (costo unitario de la capa más vieja, no una
   suma): se lee con `pesos_exactos` al lado.

   **SALIDA «para todas las matrículas» (`para_flota`) ⇒ `aeronave_id` NULL**
   y el cargo se prorratea entre los aviones ACTIVOS (un gasto por avión,
   Σ EXACTA al centavo con el residuo en el primero). **La liga
   `gasto.inventario_movimiento_id` es 1→N desde el 22-sep-2026**: el índice
   ÚNICO `uq_gasto_inventario_movimiento` (`20260703000001`, cuando el puente
   era 1 salida → 1 gasto) pasa a ser normal en `20260922000003` — era el
   SEGUNDO candado del bug y, sin él, relajar el CHECK solo cambiaba el 23514
   por un **23505** («duplicate key … uq_gasto_inventario_movimiento») en el
   segundo renglón del lote, con compensación (el movimiento se borra) y otro
   toast rojo. Verificado en prod el 22-sep con un INSERT REAL revertido. Que
   una salida no genere su gasto dos veces lo garantiza el API (UNA llamada
   por alta) + la idempotencia por `client_request_id`, no el índice. Mientras
   la migración no esté aplicada, ese 23505 también responde **503
   `MIGRACION_PENDIENTE`** (nunca el 500 traducido «Ya existe un registro con
   esos mismos datos», que manda a buscar un duplicado inexistente) y el
   movimiento se revierte: no queda NADA escrito. El CHECK de la tabla
   lo permite **desde `20260922000003`**: el original sin nombre de
   `20260515000004` («toda SALIDA lleva avión») nunca se relajó al agregar la
   columna el 13-jul-2026, así que CADA salida de flota moría con 23514 →
   500 → el toast genérico «Alguno de los valores capturados no es válido»
   (reporte del cliente, 22-sep-2026: «solo pasa cuando se intenta repartir
   en todas las matrículas»; en prod: 0 filas con `para_flota = true`). Hoy
   son DOS checks con nombre, espejo EXACTO de las dos validaciones del
   service: `inventario_movimiento_salida_destino_chk` (SALIDA con avión **o**
   con flota) y `inventario_movimiento_para_flota_chk` (`para_flota` solo en
   SALIDA y SIN avión). Mientras la migración no esté aplicada, el API 0.0.22
   responde **503 `MIGRACION_PENDIENTE`** a esa captura (con la instrucción
   de capturar por avión) y **400 `MOVIMIENTO_INVALIDO`** + `details.constraint`
   a cualquier otro 23514 del insert: nunca un 500 (un 500 dispara el
   reintento del outbox de la app). Un 23514 que cite UNO DE LOS DOS CHECKS
   NUEVOS es 400 aunque sea salida de flota: si ese check existe, la
   migración YA está aplicada y lo que falla es el dato — un 503 mandaría a
   aplicar algo que ya está.

   **BAJA de un movimiento de cardex (21-sep-2026, pedido del cliente: «que
   al momento de eliminarlos pida justificacion y sepamos quien lo hizo»).**
   El cardex dejó de ser append-only, pero SOLO por esta puerta:
   - `DELETE /v1/inventory/items/:id/movimientos/:movId` es **SOLO ADMIN** y
     exige `motivo` (10-500, trim). El texto va a
     `inventario_movimiento_eliminado` (tabla nueva, migración
     `20260921000001`): fila COMPLETA del movimiento, filas completas de los
     gastos que se fueron con él, motivo, quién y cuándo. Sin FK a propósito
     (patrón `vuelo_eliminado` / `gasto_bitacora`).
   - El borrado lo hace **la función de BD** `inventario_eliminar_movimiento`
     (auditoría + gastos BODEGA + movimiento en UNA transacción). El API
     **jamás** borra por pasos sueltos: sin la función responde **503
     `MIGRACION_PENDIENTE`**. Un movimiento sin su gasto —o al revés— infla o
     desinfla el costo del avión en silencio.
   - Candados con `code` estable (409): `MOVIMIENTO_DE_COMPRA` (se corrige
     desde Compras), `GASTO_BLOQUEADO` (gasto conciliado, con cargo bancario
     ligado, facturado, **con `compra_id`, con una `factura_recibida` que lo
     apunte** —esas tres FK son `on delete set null`: borrar el gasto las
     dejaría apuntando a nada EN SILENCIO— o que ya no es REFACCION/BODEGA),
     `TIPO_NO_SOPORTADO` (DEVOLUCION/AJUSTE: se corrigen con un movimiento
     contrario) y los dos NUMÉRICOS de
     `src/modules/inventory/eliminar-movimiento.util.ts#evaluarEliminacion`
     (helper PURO con spec sobre el caso real del 29-ago):
     `STOCK_NEGATIVO` y `CAMBIA_COSTO_FIFO`. **Solo se elimina si en NINGÚN
     punto de la cronología la existencia queda negativa Y el costo FIFO de
     TODAS las demás salidas queda idéntico (tolerancia 0.005)** — el costo
     de una salida ya viajó al gasto de un avión y no se mueve nunca. El
     mensaje dice SIEMPRE qué eliminar primero (se borra de lo más nuevo a
     lo más viejo).
     **El costo se compara EN LAS DOS MONEDAS** (revisión adversaria
     21-sep-2026): `walkCardex` expone `costoUsdFifo` (ADITIVO) además de
     `costoMxnFifo`, y `evaluarEliminacion` exige que las dos queden iguales.
     Motivo: para una capa comprada en USD SIN TC —**66 de los 75
     movimientos de producción**, la carga VTF-INV-001 completada con el
     PATCH de costo— el costo en pesos NO es expresable y sale `null`; solo
     con los pesos, «null vs null» se leía como «no cambió» y la baja pasaba
     aunque el costo real de la salida saltara de $46.06 a $9,541.25 USD.
     Por lo mismo el mensaje cita la moneda que SÍ se puede leer (pesos si
     los hay, si no USD): jamás «$0.00 MXN» sobre capas sin TC.
     La vista previa repite EXACTAMENTE los candados de dinero de la función
     de BD: si divergen, el diálogo diría «se puede» y el DELETE contestaría 409.
   - `GET …/movimientos/:movId/eliminacion` (ADMIN) es la vista previa (solo
     lee, funciona aunque falte la migración) y
     `GET …/items/:id/movimientos-eliminados` (OFICINA) el historial (`[]`
     si falta la migración).
   - `createMovimiento` responde **409 `MOVIMIENTO_ELIMINADO`** si llega un
     `client_request_id` que está en la bitácora: el reintento del outbox de
     la app no resucita lo que la oficina eliminó con justificación.

   **UTILIDAD DE LA TIENDA VuelaTour (25-sep-2026, API 0.0.35; pedido del
   cliente: «de los productos que compramos, el precio que le ponemos en el
   costo se le saca el 25 % el cual va a ser nuestra utilidad por producto
   vendido o cargado a un avión»).** Decisión tomada: **margen SOBRE EL COSTO
   FIFO, configurable** (`configuracion_sistema.inventario_margen_venta_pct`,
   25 por default, `PATCH /v1/config/inventario_margen_venta_pct` 0–100 o
   **400 `VALOR_FUERA_DE_RANGO`**). Toda SALIDA a un avión (también «para toda
   la flota», prorrateada con el residuo en el primero) **sin precio** se
   cobra a `costo FIFO × (1 + margen)`, en la MISMA moneda del costo (MXN si
   todas las capas consumidas son pesos; si no USD). Precedencia intacta:
   precio capturado > 0 → `precio_venta` del ítem → costo + margen → a costo;
   **el 0 explícito sigue siendo «a costo»** (sin utilidad). Utilidad =
   venta − costo FIFO.
   - **Fuente ÚNICA** en `inventario-cardex.util.ts`: `margenVentaValido`
     (config rota ⇒ 25), `ventaUnitariaConMargen` (round 4),
     `precioVentaDeSalida` (la precedencia, con `origen` PRECIO_CAPTURADO |
     PRECIO_PRODUCTO | MARGEN | A_COSTO), **`montoGastoDeSalida` (se MOVIÓ
     aquí desde el pie de `inventory.service.ts`, mismo cuerpo)** y
     **`ventaDeSalida`**: la utilidad de UNA salida en UNA sola moneda — pesos
     si `ventaYGananciaDe` los puede expresar (criterio de siempre, ninguna
     salida que ya daba utilidad en pesos cambia), si no **dólares** cuando la
     venta es USD (venta USD − `costoUsdFifo`: dinero real de los dos lados,
     sin T.C.); venta en PESOS sobre capas USD sin T.C. ⇒ `utilidadIncompleta`
     (se cuenta en `ventas_sin_utilidad` y se avisa, jamás se suma nada).
     `gananciaMxn` y `gananciaUsd` NUNCA los dos. `agregadosDeItem` /
     `resumenDiarioDe` / `bloquesCardexDe` la usan y ganan `ventas_cant`,
     `ventas_usd`, `costo_ventas_usd`, `utilidad_usd`, `ventas_sin_utilidad`
     (ADITIVOS; los valores MXN no cambian). Hasta hoy la columna del panel
     decía «—» en TODO el inventario porque la carga VTF-INV-001 es USD sin
     T.C.
   - `createMovimiento`: `InventoryService` recibe `ConfiguracionService`
     `@Optional()` (4.º parámetro; sin él ⇒ 25). La respuesta gana
     `venta_origen` y `margen_pct` (solo MARGEN); el replay idempotente NO
     recalcula (`null`). Las notas del gasto dicen `(precio de venta)` |
     `(costo FIFO + 25 %)` | `(costo FIFO)`. El panel VIEJO manda
     `venta_unitaria: 0` con el precio vacío ⇒ esas salidas van a costo hasta
     desplegar el panel nuevo (que omite el campo); la app Flutter ya lo
     omite.
   - Lecturas: `GET items` por ítem `utilidad_mxn` (alias de `ganancia_mxn`,
     que se conserva), `utilidad_usd`, `ventas_usd`, `costo_ventas_usd`,
     `ventas_cant`, `ventas_sin_utilidad`; raíz `utilidad_total_mxn` /
     `utilidad_total_usd` (dos sumas, por página) y `margen_venta_pct`.
     `GET items/:id` ⇒ `ganancia_usd` en las SALIDAS. `GET items/:id/resumen`
     ⇒ `ventas[]` con `venta_total`, `costo_fifo_usd`, `ganancia_usd`,
     `moneda_utilidad`, `utilidad_incompleta`; `resumen_diario[]` y
     `totales` con lo USD; raíz `margen_venta_pct`. **`GET tienda/resumen?
     desde&hasta`** (OFICINA) = la utilidad de la tienda por moneda (null =
     nada en esa moneda), unidades cargadas/vendidas, productos con ventas —
     lo arma `agregadosPorItem` (el MISMO recorrido que `resumenTiendita`).
     La hoja «inventario» del Balance general gana `vendido_usd` /
     `utilidad_usd` / `ventas_sin_utilidad` por fila y `total_vendido_usd` /
     `total_utilidad_usd` (null si ninguna fila) / `filas_utilidad_incompleta`
     / `margen_venta_pct` (ADITIVO en los dos sentidos con pyservices). El
     Excel `items/export` gana «Utilidad (MXN)» y «Utilidad (USD)», totales
     cada uno en su columna.
   - **Re-precio de las 10 salidas del 01-sep** (migración de DATOS
     `20260925000002`, autorizada por la oficina): a costo + 25 % con la
     regla del API (redondeo POR SALIDA ⇒ N4142R +295.46, XA-VGV +239.89,
     total +535.35 USD — 1 ¢ por avión arriba del 25 % del subtotal que se
     autorizó). `repreciar-salidas-tienda.spec.ts` LEE los casos del SQL y
     los ata a `ventaUnitariaConMargen`/`montoGastoDeSalida`/`ventaDeSalida`
     con el cardex REAL de prod. Las 3 salidas de jul/ago (antes de la
     tienda) no se tocan.
   - Fuera de alcance (anotado): la DEVOLUCIÓN revierte contra
     `gasto.monto` con el COSTO de la devolución ⇒ con margen el avión
     conserva el 25 % de lo devuelto (igual que con precio de venta desde el
     29-ago; se corrige en Gastos). El bloque 2 de la hoja «inventario» y el
     cardex formato libro siguen en pesos. La utilidad NO entra al Libro
     Dinero ni al reparto como ingreso de VuelaTour (no se pidió).

   **UBICACIONES DE BODEGA (25-sep-2026, migración `20260925000001`).**
   Catálogo `inventario_ubicacion` (nombre único sin distinguir mayúsculas,
   `orden`, `activo`; sembrado con «Oficina vieja», «Oficina nueva», «Locker
   del aeropuerto», «Bodega del taller de Mérida», «Bodega del taller de
   Cozumel») + `inventario_item.ubicacion_id` (FK `on delete restrict`). El
   TEXTO `ubicacion` se CONSERVA: con id es el ESPEJO del nombre (trigger
   `trg_inventario_item_ubicacion_espejo`, venga de donde venga el write;
   renombrar la ubicación lo propaga), sin id es el texto LEGADO de antes
   (69 «Bodega Cancún», 3 «Corner/Bodega Córner»), que **NO se mapea
   adivinando**: el panel lo pinta «(anterior)» y la oficina lo mueve con
   «Sin ubicación nueva» + «Mover a…». Helpers puros en
   `inventory/inventario-ubicacion.util.ts` (con spec).
   - Respuesta de un ítem (lista, detalle, código, POST/PATCH): `ubicacion`
     (texto a mostrar — la app Flutter lo sigue leyendo) + `ubicacion_id`,
     `ubicacion_nombre`, `ubicacion_legado`. Escritura: `ubicacion_id` gana
     (existe ⇒ si no 404 `UBICACION_NO_EXISTE`; activa ⇒ si no 400
     `UBICACION_INACTIVA`, salvo la que el ítem YA tiene); `ubicacion_id:
     null` = «Sin ubicación» (id y texto null); **solo texto (clientes
     viejos: app, alta masiva)** ⇒ se liga si coincide sin acentos ni
     mayúsculas con una activa (o la actual), si no queda legado sin id. Alta
     sin nada ⇒ sin ubicación (ya no «Bodega Cancún»; la alta masiva dejó de
     rellenarla).
   - Rutas: `GET ubicaciones?incluir_inactivas` (OFICINA, con `productos`
     activos), `POST ubicaciones`, `PATCH ubicaciones/:id` (ADMIN/MECANICO;
     409 `UBICACION_DUPLICADA`; desactivar con productos activos ⇒ 409
     `UBICACION_EN_USO` —la BD lo repite con 23514 y el API lo traduce a 409,
     nunca 500—; sin DELETE), `POST items/mover-ubicacion` (UN update; 200
     `{movidos, sin_cambio, no_encontrados, inactivos, ubicacion}`) y el
     filtro `GET items?ubicacion=<id>|sin`. El Excel pinta «Bodega Cancún
     (anterior)».
   - **Tolerancia**: sonda única `columnaOpcional(inventario_item.
     ubicacion_id)`. Sin la migración todo lo de ubicación se comporta como
     0.0.34 (sin llaves nuevas; alta con «Bodega Cancún») y lo nuevo responde
     **503 `MIGRACION_PENDIENTE`**. La utilidad y el margen NO dependen de la
     migración.

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
    `MEDIO_PAGO_LABELS` del panel; `TARJETA_CORP` añade " \*\*\*\*1234"; sin
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
    - **LA PANTALLA SE PARECE A LA HOJA INTERNA (22-sep-2026, pedido del
      cliente: «que no se vea como el PDF de la cotización que se entrega al
      cliente, más bien que se parezca a la cotización INTERNA»)**. Dos
      endpoints de SOLO LECTURA, los dos ADITIVOS:
      - `GET /v1/quotes/:id/interno` devuelve EXACTAMENTE el payload que arma
        `QuotesPdfInternoService.payload()` para el PDF interno, sin generar
        PDF: la pantalla pinta lo que se imprime, no una réplica. Roles
        `ROLES_PDF_INTERNO` = ADMIN/COORDINADOR/FACTURACION/ANALISTA, **sin
        SOCIO** — el MISMO criterio que `POST :id/pdf-interno`. Es una
        **constante exportada de verdad** (`quotes.controller.ts`, corrección
        de la revisión adversaria 22-sep-2026: el invariante la citaba pero en
        el código había DOS listas escritas a mano, y abrir un rol en una y
        olvidar la otra deja la pantalla enseñando lo que el PDF niega); los
        dos `@Roles` la esparcen y `quotes.controller.spec` congela que las
        dos rutas sigan apuntando a ella. Ojo: `POST /quotes/calculate` sí
        admite a SOCIO, así que la pantalla interna NO puede colgar solo de
        él.
      - `GET /v1/quotes/:id` añade `cotizado_por` (nombre de
        `vuelo.created_by`). `created_by` NO entra a `VUELO_COLS` —esa
        constante la comparten `list()`, `findById` y tres selects más—: el
        detalle usa `VUELO_COLS_DETALLE` = `VUELO_COLS` + `created_by` +
        el embed `creador:usuario!created_by(nombre)`, resuelto en la MISMA
        consulta (cero round-trips extra). El `as const` del template NO es
        cosmético: sin él supabase-js pierde el tipo de TODA la fila. Nunca un
        uuid ni un nombre inventado: usuario borrado, nombre en blanco o
        relación sin resolver ⇒ `null` (`nombreDeRelacionUsuario`, en la
        fuente única `registrado-por.util`), y la relación cruda `creador` no
        sale en la respuesta.
      - La tabla de tramos de esa pantalla se alimenta de los campos
        ADITIVOS del `breakdown` (invariante 3): el panel NO calcula el total
        por tramo ni el ajuste.
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
      `assign`/`reassign-aircraft`, que validan y avisan). Con el vuelo SIN
      volar, el vuelo y el snapshot conservan el avión nuevo y `revise`
      devuelve `avisos[]` (aditivo, siempre presente) con el aviso de TALLER
      del avión nuevo. `quotes.create` también devuelve `avisos[]`
      (solo taller; usa `avisoTallerDe`, NO el candado del squawk: crear una
      cotización nunca fue una asignación). `quickAdjust` y `reviseParaGrupo`
      pasan `conservarAvionOperativo` ⇒ nunca hay cambio deliberado ⇒ ni
      pre-check, ni blanket, ni aviso de taller.
    - **VUELO QUE YA VOLÓ = CAMBIO DE AVIÓN SOLO COMERCIAL (24-sep-2026, cotización #338).** Fuente única `estadoVueloVolado(estado, tramos)` (`quotes/aeronave-revision.util.ts`): `ya_volo` = EN_VUELO, COMPLETADO o algún tramo VIVO con `taco_salida`/`taco_llegada` (un 0 cuenta; un tramo cancelado no); `termino` = COMPLETADO o el ÚLTIMO tramo vivo (por `orden`) con taco. Con `ya_volo`, `resolverAeronaveDeRevision({ yaVolo })` NUNCA marca cambio deliberado: precio y snapshot con el avión del DTO («se cobra como Cessna»), `vuelo.aeronave_id` = el del PRIMER TRAMO VIVO (respaldo la cabecera, JAMÁS el del DTO; una cabecera desalineada se re-alinea sin push), ningún tramo se toca, sin pre-check de squawk/taller ni push de «cambio de avión», y `cambio_solo_comercial` agrega a `avisos[]` el texto único `avisoAvionSoloComercial` («El vuelo ya voló en N4142R: el cambio de avión solo cambia con qué se cobra (Cessna 206); la operación no se modifica.»). `quoteLikeParaPreview` usa la MISMA regla. EN_VUELO a medio camino (tramo 1 volado, regreso pendiente) también es SOLO COMERCIAL: el cambio operativo se hace con `assign`/`reassign-aircraft`. Antes: #338 (cotizado y volado en N4142R, 2 tramos con tacos, COMPLETADO, `itinerario_operativo` true) se recotizó «se cobra como cessna, pidieron cessna» y la revisión lo leyó como asignación ⇒ cabecera XA-VGV con los tramos en N4142R (lista, app y «aeronave utilizada» decían XA-VGV) y piloto+copiloto recibieron «Ahora vuela en XA-VGV» y «el REGRESO ahora sale 24/09/26, 10:00» de un vuelo ya aterrizado. `quickAdjust` y `reviseParaGrupo` (`conservarAvionOperativo`) no cambian: nunca reasignan ni dicen «solo comercial».
      - **Fechas del VUELO** (`resolverFechasDeRevision`): `fecha_vuelo`/`fecha_traslado_final` NO son solo de la cotización. `fecha_vuelo` ancla el mes del dinero y el calendario; las dos alimentan `fecha_fin` (trigger GREATEST), la cola de Google Calendar, el día del regreso del balance por avión y, vía `replaceEscalas`, la `fecha_salida_plan` de los tramos extremos (y `flights.update` no edita un COMPLETADO). La salida no se escribe con `ya_volo` y el regreso no con `termino`. Un viaje de varios días EN_VUELO sí reagenda —y avisa— su regreso pendiente. Si el DTO traía otra fecha, `avisos[]` lo dice (`avisoFechaConservada`) y a `replaceEscalas` baja la fecha persistida. Con `reviseParaGrupo` sobre un hijo volado la fecha del grupo tampoco se escribe (groups no propaga el aviso).
      - **Fecha de un TRAMO que ya voló** (revisión adversaria 24-sep-2026, `tramoConservaFechaPlan`): un tramo con taco y con `fecha_salida_plan` la conserva aunque el cotizador traiga una EXPLÍCITA en `escalas[i].fecha_salida_plan` (vuelos con `itinerario_operativo = false`). Si difiere, `avisos[]` trae `avisoFechaTramoVoladoConservada` («El tramo 2 (PTU → CUN) ya voló: su fecha de salida no se cambia desde la cotización (movería el calendario); se conserva la del vuelo: …»). La vista previa hace lo mismo. Un tramo volado SIN fecha (legado) se completa como siempre.
      - **Avisos a tripulación de `revise`**: reagenda solo de lo que SÍ se escribió (`salida_cambio`/`regreso_cambio`); «cambio de avión» nunca con `ya_volo`; pernocta y el aviso de itinerario de `replaceEscalas` (`silenciarTripulacion`) nunca con `termino` ni en CANCELADO.
      - **`aeronave_utilizada`** (`quotes.findById`, `flights.snapshot` y, a través del quote-like, el PDF interno) = ficha del PRIMER TRAMO VIVO con herencia (`avionesUtilizados(...)[0]`), respaldo la cabecera — nunca la cabecera a secas. Campo ADITIVO `aeronave_cotizada_vs_utilizada_difiere` (por ID; externo o sin alguno ⇒ false).
      - **Red de seguridad**: `alerts.sincronizarEspejoIda` (cron 08:00 Cancún) re-alinea cada día cabecera ← primer tramo vivo, sin push. Ningún camino de escritura de `vuelo.aeronave_id` corre en COMPLETADO (`assign`, `assignEscala`, `reassignAircraft` y externo lo bloquean; `combinarVuelos` solo acepta vuelos sin volar). OJO: el blanket de `assign` en EN_VUELO todavía mueve tramos con taco (pendiente de decisión, invariante 1).
      - Specs: `aeronave-revision.util.spec.ts`, `quotes.service.aeronave.spec.ts`, `quotes.service.caso338.spec.ts` (DATOS REALES de prod: precio exacto de la v2 $1,440.00 · IVA $286.40 · $2,076.40, cero notificaciones, control CONFIRMADO que sí reasigna y avisa, EN_VUELO a medio camino, grupo, vista previa y fecha por tramo), `flights.service.aeronave-utilizada.spec.ts` y el caso #338 de `quotes-pdf-interno.util.spec.ts`.

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

21. **PROGRAMA DE SERVICIO POR HORAS: la orden se crea AL CRUZAR EL UMBRAL,
    no al día siguiente (20-sep-2026, caso XA-VGV).** Porfirio: «no se
    generó, mejor dicho solo marca una leyenda. entonces es enunciativa y
    posterior la agrego». La generación automática SÍ funcionaba; el defecto
    era la LATENCIA: `checkServicioPorHoras` solo corría en `runDaily`
    (08:00 Cancún). El 19-sep a las 08:00 faltaban 11.2 h; a las 08:40-08:42
    la oficina capturó los tacos del vuelo #295 (2,238.8 → 2,240.2), la
    tarjeta —que calcula EN VIVO— dijo «faltan 9.8 h» y a las 08:49 no había
    orden. Con varios vuelos al día, 24 h de latencia se comen el margen de
    10 h entero.
    - **Cuerpo ÚNICO por avión**: `AlertsService.revisarProgramaDeServicio`.
      Lo comparten el barrido de flota y el hook — mismo dedupe, mismo texto
      de `notas`, mismo `dispatch` (dedupe mensual
      `servicio:<avión>:<hito>:<mes>`) y mismo espejo a Google. Cualquier
      cambio va AHÍ: dos cuerpos = dos órdenes o ninguna.
    - **Tres disparadores, un solo insert posible**: (a) `runDaily` 08:00;
      (b) `runServicioHoras` cada 10 min (`@Cron('*/10 * * * *')`, RED DE
      SEGURIDAD: corre solo `safe('servicio_horas', …)` y se salta si hay
      barrido en curso); (c) `AlertsService.revisarServicioDeAvion(id)`,
      PÚBLICO y best-effort (NUNCA lanza), que llama `flights.service` tras
      cada escritura de tacómetro. Candados: `barridoEnCurso` (global, ya
      existía) + `servicioEnCursoPorAvion` (Set EN MEMORIA por avión,
      check-and-add síncrono al entrar al cuerpo). Railway = 1 réplica, así
      que el mutex en memoria basta.
    - **UNA CAPTURA NUNCA SE DESCARTA** (revisión adversaria 20-sep-2026):
      cuando el hook encuentra el avión con su revisión EN VUELO, ya no
      devuelve en silencio — anota el avión en `servicioPendientePorAvion` y
      la corrida en curso vuelve a mirarlo al terminar (bucle acotado a
      `MAX_PASADAS_SERVICIO = 3`). Sin eso la corrida en curso pudo leer el
      Hobbs ANTES de esa escritura y la lectura que cruzaba el umbral no la
      veía NADIE: la orden se quedaba esperando al cron de 10 min. Es la forma
      EXACTA del caso XA-VGV (tres tramos capturados entre 08:40 y 08:42) y la
      del outbox de la app, que sube sus capturas en ráfaga. El spec
      «la lectura que cruza el umbral NO se pierde» lo reproduce con una
      puerta sobre la lectura de escalas y falla sin el bucle.
    - **Chokepoint del hook**: `FlightsService.avisarProgramaDeServicio`
      (privado, fire-and-forget, resuelve el avión del tramo CON HERENCIA
      `escala.aeronave_id ?? vuelo.aeronave_id`). Lo llaman las TRES
      escrituras que pueden SUBIR el Hobbs: `captureTaco` (piloto, oficina y
      outbox de la app), `confirmTaco` (ajuste de oficina) y `restoreEscala`
      (un tramo cancelado vuelve con sus lecturas). NO lo llaman, a
      propósito: `fillTacoGaps` y la propagación llegada→salida (solo COPIAN
      lecturas existentes: el máximo no cambia), `clearTaco` y las
      correcciones a la baja (bajan), y mover un tramo ya volado a otro avión
      (`assignEscala`/`reassignAircraft`/`combinarVuelos`: no es escritura de
      taco) — eso y cualquier camino nuevo lo recoge el cron de 10 min.
      `flights.service.servicio-horas.spec.ts` congela que esos tres métodos
      sigan llamando al hook.
    - **DI**: `FlightsModule` importa `forwardRef(() => AlertsModule)` y
      `FlightsService` inyecta `@Optional() @Inject(forwardRef(() =>
AlertsService))` (mismo patrón que `expenses`↔`conciliacion`). Sin el
      módulo (specs, arranque parcial) la captura del taco ni se entera.
    - **El Hobbs del check = el Hobbs de la tarjeta**: `hobbsDeAvion` usa
      `AircraftService.currentHobbs` (memoizado por corrida). Antes el check
      armaba el Hobbs con un `select … from escala` de TODA la flota SIN
      paginar: PostgREST corta en 1000 filas en silencio y, pasado ese tope,
      el máximo podía salir viejo y el servicio no dispararse NUNCA (misma
      familia que el anti-cap-1000 de `aptitudBulk`). `currentHobbs` va
      paginado (`fetchTodas`), hereda el avión del vuelo y deja fuera vuelos
      y tramos cancelados. **`anclarRefsComponentes` usa la MISMA fuente**
      (revisión adversaria 20-sep-2026): armaba su máximo con OTRO `select …
from escala` de toda la flota sin paginar, y ahí el número no se
      muestra — se ESCRIBE en `aeronave_horas_ref`, el ancla de las horas
      vivas (invariante 1), y un ancla baja infla las horas del componente
      para siempre. De paso, sin componentes por anclar (lo normal) ya no lee
      ninguna escala. NINGUNA regla de `alerts` calcula el Hobbs por su
      cuenta.
    - **Fuente única del dedupe**: `src/common/servicio-hito.util.ts` (PURO,
      con specs). `mantenimientoCubreHito` = mismo hito por
      `horas_programadas` ±0.05 en CUALQUIER estado, **o** servicio de la
      misma etapa ya COMPLETADO dentro del ciclo (`horas_aeronave ∈ (hito −
intervalo, hito + 0.05]`), **o** entrada MANUAL abierta de la misma
      etapa sin horas. `NOTA_SERVICIO_AUTOMATICO` ('Creado automáticamente')
      lo ESCRIBE el insert y lo LEE `orden.automatica`: una sola constante.
    - **`proximo_servicio.orden` (ADITIVO)** en `aircraft.metrics` Y en
      `aircraft.tacometroHistorial`: `{id, estado: PROGRAMADO|EN_TALLER,
fecha_programada: string|null, automatica: boolean} | null` = la orden
      ABIERTA que cubre el hito, con el MISMO helper
      (`ordenAbiertaDelHito`). `null` = el hito aún no tiene orden viva (una
      COMPLETADA cubre el dedupe pero NO es orden pendiente). El panel ya no
      pinta solo «faltan N h». Los dos sitios leen `mantenimiento` con
      `MANT_HITO_COLS`; en `metrics` esa MISMA lectura es la que decide
      `airworthiness.en_taller` (antes era una consulta aparte).
    - **`proximo_servicio.aviso_automatico` (ADITIVO, revisión adversaria
      20-sep-2026)**: `{activo: boolean, umbral_hr: number} | null`, leído de
      `alerta_config.servicio_horas` (`AircraftService.avisoAutomaticoServicio`,
      best-effort). El panel PROMETE «la orden se genera sola en unos
      minutos», y esa promesa solo vale si la regla está ENCENDIDA y si el
      margen es el mismo de los dos lados; el panel lo tenía en una constante
      de 10 h. Con `activo:false` la tarjeta dice la verdad («La orden NO se
      crea sola · hay que capturarla») en vez de repetir la queja de Porfirio.
      `null` = no se pudo leer ⇒ el panel NO afirma nada (se comporta como
      hoy); sin fila en `alerta_config`, `safe()` salta la regla ⇒ apagada.
    - **`servicio` en `GET /v1/aircraft` (ADITIVO, 22-sep-2026 — el pizarrón
      «Tacómetros» de la oficina)**: `{ultimo, siguiente, aviso_automatico}`
      por fila del LISTADO (`null` sin programa; `GET /aircraft/:id` y
      `metrics` NO cambian). Se arma en `AircraftService.list()` con el
      helper PURO `src/modules/aircraft/servicio-flota.util.ts`
      (`ultimoServicioDe` + `armarServicioFila`), que **no calcula nada**:
      el hito entra INYECTADO desde `proximoServicioDetallado` y la orden
      desde `ordenAbiertaDelHito` — las mismas fuentes que la ficha del
      avión, para que lista y ficha no puedan decir números distintos.
      `ultimo` = mantenimiento COMPLETADO **del avión** (fuera `motor_id` /
      `helice_id`: el overhaul es del componente) con `horas_aeronave` más
      alta; sin ninguno cae a `servicio_horas_base` con `origen:'BASE'`.
      `faltan_hr` viaja SIN recortar (un negativo es «vencido», no 0). **El
      listado NUNCA llama a `metrics` ni a `etapasDeServicio(id)` por avión**:
      UNA lectura de `aeronave_servicio_etapa`, UNA de `mantenimiento`
      (`MANT_SERVICIO_COLS`, ambas con `fetchTodas`) y UNA de
      `alerta_config` para toda la página — `aircraft.service.servicio-flota.spec.ts`
      cuenta las consultas y truena si aparece un N+1.
      **El Hobbs del listado es el MISMO universo que el de la ficha**
      (revisión adversaria 22-sep-2026): la lectura de `escala` que arma
      `ultimo_taco` lleva `.is('cancelada_at', null)` y
      `.neq('vuelo.estado','CANCELADO')` con `vuelo:vuelo_id!inner` — las
      mismas tres condiciones de `escalasDelAvion`/`currentHobbs`. Sin ellas
      un vuelo CANCELADO con tacos capturados (los hay en prod: el folio 180
      conserva 2212.6 / 2213) subía el máximo SOLO en la lista, y ese número
      no es decorativo: decide el hito, `faltan_hr`, la orden y el TBO del
      semáforo (`aptitudBulk` lo recibe) — lista y ficha dirían números
      distintos del mismo avión. El `!inner` es obligatorio: sin él PostgREST
      no filtra la fila padre por una columna del embebido y el `.neq` queda
      de adorno.

22. **LO QUE SE PERSISTE ES LO QUE SE USÓ PARA MULTIPLICAR — horas pactadas
    con 8 decimales (22-sep-2026, cotizaciones #322 y #302).** Fuente única
    `src/common/horas.util.ts` (`HORAS_DECIMALES = 8`, `round8`,
    `normalizarHoras`, `esEcoDeHorasPactadas`, `horasPactadasPersistidas`).
    Hermano del invariante 20: mismo defecto, el otro factor del producto.
    - **Síntoma**: la MISMA cotización (XB-PEV, CUN→PTU→CUN, $600/hr,
      «Cobrable pactado» 2.333333333 = 2 h 20 min) daba $1,400.00 / $1,624.00
      recién capturada y $1,399.98 / $1,623.98 al reabrirla y guardarla.
      «no me lo redondea en la primer captura de la cotización 322».
    - **Causa**: el motor multiplicaba con la precisión COMPLETA pero
      persistía `round4` (snapshot) sobre `numeric(10,4)`; el panel REHIDRATA
      el pactado desde el snapshot ⇒ 2.3333 × 600 = 1,399.98, y guardar
      dejaba el descuadre persistido (#322 v1 1,400.00 → v2 1,399.98 con las
      MISMAS horas).
    - **Precisión**: `vuelo.tiempo_cobrable_hr` y
      `cotizacion_version_history.tiempo_cobrable_hr` son `numeric(14,8)`
      (migración `20260922000001_horas_pactadas_ocho_decimales.sql`, con
      backfill de los 12 vuelos cuyas horas ya no reproducían su subtotal:
      `h8 = round(subtotal ÷ tarifa, 8)` solo si la diferencia es
      truncamiento puro (≤ 0.00005 hr) **y** reproduce el subtotal al
      centavo; corrige la columna Y el snapshot). El backfill NO corrige
      dinero ya persistido: #322 se re-guarda desde el panel.
    - **El motor normaliza ANTES de multiplicar**: `cobrableOverride` pasa por
      `normalizarHoras` y la regla por `round8` (0 legítimo del cliente
      interno), y el snapshot guarda ESE número —`tiempos.cobrable_hr` y
      `tiempos.sobrevuelo_hr` ya no son `round4`—. `vuelo_hr`, `calzos_hr` y
      `cobrable_hr_regla` siguen en `round4`: son informativos y nadie los
      rehidrata como dinero. El sobrevuelo SÍ se rehidrata (panel y
      `quickAdjust`) y entra en la suma, por eso va con los 8.
    - **Rehidratar = leer el más preciso**: `horasPactadasPersistidas`
      (snapshot vs columna) en `quickAdjust` y en los hijos de un GRUPO
      (`avionCtxDeHijo`), y `anclarRevisionAlPersistido` ancla el **eco
      truncado**: un cliente que devuelve las horas con 4 decimales
      (panel viejo, borrador en caché) no baja el subtotal — solo se ancla si
      la diferencia es < media unidad del 4.º decimal Y el entrante trae
      MENOS decimales; una edición real del pactado se respeta (2.3333 →
      2.3334 sobre 2.33333333 está FUERA de la tolerancia). **Punto ciego
      asumido** (revisión adversaria 22-sep): un eco y un REDONDEO
      DELIBERADO a 4 decimales son el mismo número — teclear «3.297» sobre
      3.2969697 persistido (#309) se ancla y esa edición de 5 centavos se
      descarta sin avisar. Se prefiere así: reabrir y guardar no mueve un
      total. Para permitirlo haría falta un campo ADITIVO del DTO, jamás
      bajar la tolerancia.
    - **Por qué 8**: 2.33333333 × 9,750 = $22,750.00 exacto, donde 2.3333
      daba $22,749.68 (32 centavos perdidos en un solo vuelo).
    - **Los lectores que PINTAN horas ya formatean** y se dejaron como están:
      el desglose canónico sigue imprimiendo `round4` («2.3333 hr»), el PDF
      interno `_horas` (`:.2f`), el balance `round2`, el panel `fmtDecimal`.
      El PDF del CLIENTE usa `:g` en pyservices (6 cifras significativas): con
      el pactado completo la línea pasa a decir «Servicio aéreo (2.33333 h ×
      $600.00/hr)» — el importe es el correcto y el texto sigue espejando al
      panel, pero si el cliente prefiere «2.33 h» se cambia en pyservices.
    - **Las horas del PDF del CLIENTE salen del SNAPSHOT, no de la columna**
      (revisión adversaria 22-sep): `quotes-pdf.service.armarPayloadPdf` usa
      `horasPactadasPersistidas(snapshot.tiempos.cobrable_hr,
quote.tiempo_cobrable_hr)`. Leyendo la columna —`numeric(10,4)` hasta
      aplicar la migración, y truncada PARA SIEMPRE en lo que se guarde entre
      el deploy y la migración— la hoja WYSIWYG del panel decía «2.33333 h»
      (espeja el snapshot con `numeroG`) y el PDF real «2.3333 h» para la
      MISMA cotización. El PDF INTERNO ya prefería el snapshot; ahora los dos
      leen lo mismo. Respaldo a la columna sin snapshot (cotización legada) y
      en cliente interno (cobrable 0: la línea ni se imprime).
    - **El REPORTE POR VUELO redondea a 4 al salir** (`flight-report.service`):
      `reporte_vuelo_xlsx.py` escribe esa celda SIN formato de número y
      mostraría «2.33333333» en Excel. Ese reporte nunca multiplica las horas
      (el dinero viaja calculado), así que ahí son presentación. El factor
      exacto vive en la columna y en el snapshot.

23. **TARIFA POR HORA CON 6 DECIMALES — el TERCER factor (22-sep-2026,
    cotización #105).** Fuente única `src/common/tarifa.util.ts`
    (`TARIFA_DECIMALES = 6`, `round6`, `normalizarTarifa`, `esEcoDeTarifa`,
    `tarifaPersistida`). Cierra la familia de los invariantes 20 (T.C.) y 22
    (horas): **los tres factores del precio se persisten EXACTAMENTE como se
    multiplicaron**. La mecánica del redondeo es una sola
    (`src/common/redondeo.util.ts`: `redondearA`,
    `decimalesSignificativos`) y `tc.util`/`horas.util` delegan en ella sin
    cambiar un solo export.
    - **Síntoma**: la oficina cerró el SERVICIO AÉREO de #105 (2.4 hr) en
      **$2,375.00 exactos** tecleando la tarifa personalizada **989.583333**
      (= 2,375 ÷ 2.4). Reabrir la cotización y guardarla sin tocar nada lo
      bajaba a **$2,374.99**. **Al verificarlo**: #105 lleva un descuento de
      $200.00 y $0 de IVA, así que su `monto_total_usd` es **$2,175.00** —
      el par correcto es 2,375.00 (subtotal) / 2,175.00 (total), y con la
      tarifa truncada era 2,374.99 / 2,174.99. Sus 2.4 hr salen de la REGLA
      (2.1 + 0.3 de calzos, sin `cobrable_proviene_de_override`) y son
      exactas: por eso la guarda del backfill lo acepta.
    - **Causa**: el motor multiplicaba con la precisión COMPLETA del DTO
      (`tarifa_hora_override_usd`) pero persistía `round2` —
      `calculo_snapshot.tarifa.usd_por_hora` y `vuelo.tarifa_hora_usd`
      `numeric(10,2)` ⇒ 989.58—, y el panel / `quickAdjust` / los hijos de
      grupo REHIDRATAN la tarifa desde ahí: 2.4 × 989.58 = 2,374.99.
    - **Precisión**: `vuelo.tarifa_hora_usd` y
      `cotizacion_version_history.tarifa_hora_usd` son `numeric(14,6)`
      (migración `20260922000002_tarifa_hora_seis_decimales.sql`). Los
      **CATÁLOGOS se quedan en 2 decimales a propósito**
      (`aeronave.tarifa_hora_pub_usd`, `aeronave.tarifa_hora_broker_usd`,
      `tarifa_cliente_aeronave.tarifa_hora_usd`): son precios de lista. Su
      corolario, del que depende el anclaje: **la ÚNICA tarifa que puede
      traer más de 2 decimales es la personalizada de una cotización**.
    - **El motor normaliza ANTES de multiplicar**: la tarifa efectiva
      —override manual, preferencial del cliente o catálogo— pasa por
      `round6` y ESE número se persiste y se snapshotea. `round6` y no
      `normalizarTarifa` porque la tarifa 0 del cliente INTERNO es legítima
      («no se cobra», no «sin dato») y tiene que seguir llegando intacta al
      candado de «aeronave sin tarifa configurada».
    - **Rehidratar = leer la más precisa**: `tarifaPersistida` (snapshot vs
      columna) en `quickAdjust`, en los hijos de un GRUPO
      (`groups.avionCtxDeHijo`), en el PDF del cliente
      (`quotes-pdf.service`) y en el PDF interno (`quotes-pdf-interno.util`).
      Mientras la migración no esté aplicada, el snapshot (jsonb) ya lleva
      los 6 decimales y la columna no: por eso el total **no se mueve ni
      antes ni después de aplicarla**.
    - **`anclarRevisionAlPersistido` ancla el ECO TRUNCADO** (revise,
      quickAdjust y la vista previa pasan por ahí): un cliente que devuelve
      989.58 sobre 989.583333 persistido no baja el subtotal. La banda es
      **medio centavo por hora** (`TARIFA_TOLERANCIA_ECO = 0.005`, media
      unidad de la precisión vieja) **y** el entrante debe traer MENOS
      decimales. Una edición real —990, 989.59, o añadir precisión— se
      respeta siempre. **SIN gate por `proviene_de_override`**: esa bandera
      solo dice «el panel mandó una tarifa» y viaja en `true` hasta con
      tarifas redondas (#26, $555.00); el gate real es que lo persistido
      tenga MÁS decimales, cosa que una tarifa de catálogo nunca puede tener.
      **Punto ciego asumido**, el mismo de las horas: un eco y un redondeo
      DELIBERADO a 2 decimales son el mismo número.
    - **La COMISIÓN del vendedor POR_HORA NO tiene este defecto** (verificado
      en prod: 6 vuelos con `comision_vendedor_modo = 'POR_HORA'`, 0
      descuadrados): el motor redondea `comision_vendedor_tarifa_hr` a 2
      decimales **antes** de multiplicar, así que lo que persiste es lo que
      multiplicó. `quotes.service.tarifa.spec.ts` congela ese orden — si
      alguien lo invierte, reaparece el bug de #105 en la comisión.
    - **El COSTO DEL OPERADOR EXTERNO no es esta tarifa**
      (`resolverCostoExterno`: `costo_externo_monto/moneda/tc`); en un vuelo
      externo la tarifa del snapshot es solo la REFERENCIA con la que se
      cotiza al cliente y pasa por la misma regla.
    - **Los lectores que PINTAN la tarifa siguen en 2 decimales** y se
      dejaron como están: el desglose imprime «$989.58/hr», y pyservices usa
      `_money` en el PDF del cliente, el interno, el del grupo y el reporte
      por vuelo. **El reporte por vuelo NO recorta la tarifa a la salida**
      (al revés que las horas): verificado en `reporte_vuelo_xlsx.py`, esa
      celda pasa por `money_cell` (formato `"$"#,##0.00`) mientras que la de
HORAS se escribe sin formato. En el balance por avión y el Libro Dinero
la tarifa ya salía por `r2()`.
    - **El backfill distingue «tarifa truncada» de «horas truncadas»** y esa
      guarda es la parte delicada: de los 12 vuelos que hoy descuadran
      `round(horas × tarifa, 2) <> subtotal`, **once son horas de la REGLA
      truncadas a 4 decimales** (tarifas redondas: 650, 575, 900, 555, 600,
      1600, 670, 850, 700, 1650, 950 — su dinero es correcto y el motor
      re-deriva las horas al guardar) y **solo #105 es tarifa truncada**. El
      falso positivo a vigilar es **#26** (3.4273 hr @ $555.00): también
      «cuadraría» con una tarifa inventada de 554.996645 dentro de la
      tolerancia. Lo que los separa es `round(horas, 2) = horas` — horas
      exactas al centésimo ⇒ no pueden ser un `round4` truncado ⇒ el único
      factor que pudo perderse es la tarifa. `tarifa.util.spec.ts` congela
      los 12 casos reales.

24. **TRAMOS de la cotización: LA COTIZACIÓN ES INDEPENDIENTE DE LA OPERACIÓN
    (22-sep-2026, cotización #326).** Extiende al ITINERARIO la regla rectora
    del cliente del 12-sep (invariante 14, que ya la aplicaba al AVIÓN): «la
    cotización no debe verse afectada por cambios en el vuelo operativo».
    Fuente única `src/modules/quotes/tramos-cotizados.util.ts` (PURO, con
    spec).
    - **Síntoma (palabras del cliente)**: «antes de poner el tipo de cambio
      esta en 3596 y despues de ponerlo, se cambia en automatico no se por
      que». La #326 se cotizó `T1 CUN→PTU FERRY` + `T2 PTU→CUN 2 pax` ⇒ TUAS
      $0 ⇒ **$3,596.00**; el PILOTO editó los DOS tramos desde la app (4 pax,
      sin ferry — cambio OPERATIVO legítimo) y reabrir + teclear el T.C.
      repreciaba con la operación (TUA CUN $25 × 4 + IVA) ⇒ **$3,712.00**.
      9 de las 64 cotizaciones con `itinerario_operativo = false` divergían
      así, y **8 versiones ya guardadas** se llevaron el pax del piloto al
      precio con un motivo que solo decía «[TC —→16.97] Corrección».
    - **QUÉ PRECIA vs QUÉ ES DE LA OPERACIÓN.** Precian y salen del
      COTIZADO (`calculo_snapshot`): origen, destino, millas, `pasajeros`,
      `es_ferry`, pernocta, `tipo_parada`. Viven en la operación y salen de
      la escala VIVA del MISMO `orden` (solo si conserva la ruta cotizada):
      `fecha_salida_plan`, `pdf_oculto`, `pdf_fecha`, notas del tramo y el
      manifiesto capturado por el piloto.
    - **LA RUTA PRECIA _Y_ ES DE LA OPERACIÓN — los dos datos conviven**
      (revisión adversaria 22-sep-2026, casos REALES #322 `CET→PTU` y #297
      `PPS→CZM`, los dos con TACÓMETRO capturado, y #320 `CZM→CET` con
      pernocta). `origen_iata`/`destino_iata` se editan desde el vuelo
      (`PATCH /flights/legs/:legId`, `UpdateEscalaDto extends
PartialType(CreateEscalaDto)`), así que son operación tanto como el
      pax. Mientras el formulario mandaba la ruta VIVA, escribirla era un
      no-op; **hidratado del snapshot, guardar un ajuste de T.C.
      reescribiría el aeropuerto de salida de un tramo QUE YA VOLÓ**
      (bitácora, evento de Google, permisos de pista y manifiesto). Por eso
      «deliberado» se mide contra lo COTIZADO, **nunca contra la escala
      viva**: si el DTO trae la MISMA ruta que el snapshot, la oficina no la
      tocó ⇒ `replaceEscalas` omite `origen_iata`, `destino_iata`,
      `millas_nauticas`, `es_sobrevuelo` y la `fecha_salida_plan` heredada
      del vuelo, conserva también pax/ferry/pernocta de ese tramo y manda
      `avisoRutaDeLaOperacion` en ámbar. La oficina que SÍ edita la ruta en
      el cotizador la escribe como siempre (tramo redefinido), y
      «Actualizar la cotización con la operación» (`tramos_base:
'OPERACION'`) adopta la del vuelo. Mismo freno que el blanket de
      avión, que tampoco toca lo que ya voló (invariante 1).
    - **Cascada de «qué se cotizó»** (`tramosCotizados`):
      `calculo_snapshot.ruta.escalas` → `calculo_snapshot.tramos` → `null`.
      Las 227 filas de prod traen las dos; `null` = cotización sin snapshot
      (reserva que se cotiza por primera vez) y ahí manda la operación, como
      siempre.
    - **La ESCRITURA no pisa lo del piloto** — la otra mitad, y NO es
      opcional: `replaceEscalas` recibe los tramos cotizados ANTES de la
      revisión y **OMITE del UPDATE** (`columnasQueConservaLaOperacion`) las
      columnas cuyo valor entrante es IDÉNTICO al cotizado, con el tramo ya
      existente y su ruta intacta. Mismo patrón que `pdf_oculto`/`pdf_fecha`
      y `es_sobrevuelo`. Se ESCRIBE cuando el tramo es NUEVO, su ruta CAMBIÓ,
      el valor DIFIERE del cotizado (edición deliberada de la oficina),
      `tramos_base = 'OPERACION'`, el escritor es el GRUPO (`desdeGrupo`
      manda su plantilla) o no hay snapshot (`create`). Sin esto, hidratar
      del snapshot habría BORRADO los 4 pax del piloto al primer «Guardar».
      `pernocta_costo_usd` viaja pegado a `requiere_pernocta`;
      `pasajeros_nombres` se decide APARTE (el manifiesto sí se edita desde
      el cotizador).
    - **Campo ADITIVO `tramos_base`** (`ReviseQuoteDto`, `PreviewQuoteDto`;
      `'COTIZADO' | 'OPERACION'`, `'EDITADO'` = alias de COTIZADO). **Deploy
      API antes que panel** (`forbidNonWhitelisted` ⇒ 400 si el campo llega
      a un API viejo). **NO se agrega a `CalculateQuoteDto`**: `/calculate`
      no persiste nada.
    - **ANCLA para un panel VIEJO** (sin `tramos_base`): `anclarTramoAlCotizado`
      —dentro de `anclarRevisionAlPersistido`, junto a los ecos de tarifa y
      horas— devuelve el tramo a lo cotizado cuando pax/ferry/pernocta son un
      ECO de la escala VIVA (misma ruta y mismas millas, valor igual al vivo
      y distinto al cotizado). Una edición REAL (un valor que no coincide con
      la operación) jamás se ancla. **Nunca silencioso**: el ancla se declara
      en `avisos[]`. No aplica con `desdeGrupo`, con `tramos_base` presente,
      con `itinerario_operativo = true` ni sin snapshot.
    - **`quickAdjust` precia SIEMPRE con lo COTIZADO** (antes solo en modo
      operativo, caso #141): registrar un cobro o tocar un extra ya no
      arrastra el pax del piloto al precio, y manda `tramos_base:'COTIZADO'`
      a su `revise` interno. Respaldo a las escalas vivas solo sin snapshot.
    - **Un tramo CANCELADO por la operación ya no revive a ciegas**: con la
      ruta intacta, `replaceEscalas` omite `cancelada_at/_motivo/_por` y
      manda un aviso ámbar en vez del push «tramos restaurados». Un tramo
      SOBRANTE con tacómetro sigue conservándose y ahora además AVISA.
    - **Capacidad**: el 409 `CAPACIDAD_EXCEDIDA` sigue mirando lo COTIZADO
      (es el precio) y el pax de la OPERACIÓN pasa a `avisos[]` ámbar
      (`avisosCapacidadOperacion`, best-effort) — «taller = aviso, no
      candado» (11-sep): una cotización no queda imposible de guardar por un
      dato operativo (caso #319: 5 y 6 pax capturados por el piloto).
    - **`vuelo.pasajeros` pasa a ser el pax PACTADO** (`representativePax`
      deriva del breakdown, que ya es el cotizado). El pax real por tramo se
      sigue leyendo de la escala viva (bitácora, manifiestos, permisos).
    - **Lo que NO cambia**: `create` escribe todo; el early-return por
      `itinerario_operativo`; `escalasVisiblesPdf` (ya leía el snapshot y
      solo toma ojito/fecha de la escala viva); `PATCH pdf-visibilidad`; la
      app del piloto, la bitácora, los manifiestos y los reportes
      operativos, que siguen leyendo la escala VIVA. **Sin migración**: todo
      se resuelve con `calculo_snapshot` y con omitir columnas en un UPDATE.

25. **FACTURA DEL SERVICIO POR VUELO: seguimiento ADMINISTRATIVO, no el CFDI
    (22-sep-2026, pedido del cliente).** «Por cada vuelo las opciones para
    identificar vuelos facturado, sin factura, factura elaborada y enviada, y
    que pueda yo también subir la factura del servicio a un lado». Son DOS
    cosas distintas y jamás se mezclan (mismo espíritu que el invariante 18):
    - `vuelo.facturado` (boolean) + tabla `factura` = **CFDI del PAC**. Es el
      candado de emisión (`invoices.service.emitir` lo pone con
      compare-and-set; la cancelación ante el SAT lo libera). **No cambian.**
    - `vuelo.factura_estatus` = **seguimiento MANUAL** de la oficina:
      `SIN_FACTURA` · `ELABORADA_ENVIADA` · `FACTURADO` (varchar + CHECK, NO
      un enum: en plpgsql se compara con texto sin `::text` y sin repetir el
      incidente del 15-sep). Migración `20260923000001`.
    - **Fuente única `src/modules/flights/factura-cliente.util.ts`** (PURA,
      con spec; el panel copia la tabla). Derivación MONÓTONA —y por eso
      segura con panel/BD viejos—: CFDI timbrado MANDA (`facturado = true`
      ⇒ FACTURADO aunque la columna no exista); si no, vale la columna; sin
      columna, `SIN_FACTURA`. **Cancelar el CFDI NO baja el estatus solo**:
      la factura se elaboró y se envió — que la oficina lo decida a mano.
    - **Bloque ADITIVO `factura_cliente: { estatus, archivo }`** en
      `GET /flights/:id/snapshot` y en cada fila de `GET /flights` (en LOTE:
      una consulta por página más la de nombres, nunca N+1). El archivo
      (PDF/XML, ≤ 10 MB) vive en el bucket PRIVADO `facturas` bajo
      `vuelos/<vuelo_id>/<uuid>.<ext>`; se guarda el PATH y el API firma
      10 min al VER (`GET :id/factura-cliente/archivo-url`) — nunca una URL
      persistida. Al reemplazar: primero sube el nuevo, luego guarda el path
      y AL FINAL borra el viejo (ningún fallo deja al vuelo apuntando a un
      archivo que no existe); si el UPDATE falla, el archivo huérfano se
      retira.
    - **Candado**: con `facturado = true`, `PATCH :id/factura-cliente` a algo
      distinto de FACTURADO responde 409 `VUELO_CON_CFDI`.
    - **Sin la migración aplicada**: leer responde lo de hoy; escribir
      responde 409 `FACTURA_CLIENTE_NO_DISPONIBLE` con la migración que falta
      (nunca 500 ni un guardado que se pierde en silencio).
    - **La factura del GASTO es otra cosa** (buzón de proveedores):
      `POST /v1/invoices/recibidas/de-gasto` crea la factura recibida
      (XML y/o PDF) y la amarra al gasto en UNA llamada. Tres reglas suyas:
      el amarre es **ADITIVO** (solo ese gasto — `amarrarGastos` REEMPLAZA la
      lista y desde la fila desamarraría en silencio los demás gastos de una
      factura de VIP SAESA), el **XML es opcional** (solo PDF ⇒
      `uuid_fiscal` null, que la columna única admite repetido en nulos) y un
      **UUID ya registrado se reutiliza** (`ya_existia: true`) en vez del 409
      sin salida. Quien marca el gasto FACTURADA sigue siendo el trigger
      `gasto_sync_facturacion`; `estatus_comprobante` no se toca.
    - **FOLIO de la factura del servicio (24-sep-2026, API 0.0.29,
      migración `20260924000001` APLICADA el 24-sep-2026).** «Al descargar el
      reporte en Excel sí aparece la columna de factura pero no el folio de
      la factura que subí»: la columna solo leía la tabla `factura` (CFDI
      del PAC, **0 filas en prod**) y la factura subida no guardaba folio.
      Hoy `vuelo.factura_folio` (1–40, sin espacios en los extremos; vacío
      = NULL) y `vuelo.factura_uuid` (UUID fiscal en MAYÚSCULAS). El bloque
      `factura_cliente` gana `folio` y `uuid` (aditivos). `POST
      …/archivo` acepta el campo de texto `folio` (en multipart es un campo
      más del formulario; **el DTO lo declara**, o `forbidNonWhitelisted`
      tumbaría la subida) y, si el archivo es el XML del CFDI, saca
      `SERIE-FOLIO` (o solo el Folio) y el UUID con un parser TOLERANTE sin
      dependencias (`extraerDatosCfdi`: BOM, UTF-16, CFDI 3.2 en minúscula,
      entidades); el folio TECLEADO gana. Un PDF sin folio **conserva** el
      folio que ya había; el UUID solo cambia con un XML nuevo. `PATCH
      …/factura-cliente` acepta `{ estatus?, folio? }` (al menos uno; `folio:
      null|""` lo borra) — captura sin archivo, también para los vuelos ya
      marcados «Facturado» (caso #297). Sin la migración: leer da `folio:
      null`, subir sin folio funciona igual, y MANDAR un folio responde 409
      `FACTURA_FOLIO_NO_DISPONIBLE` **antes** de escribir o subir nada.
    - **La columna «FACTURA VUELATOUR» de los Excel tiene FUENTE ÚNICA**:
      `flights/factura-cliente-etiquetas.ts#etiquetasFacturaDeVuelos` (en
      lote, 2 consultas por cada 200 vuelos, tolerante a las dos
      migraciones) sobre la cascada PURA `etiquetaFacturaVuelo`: CFDI vivo
      (`serie-folio` no cancelado) → `vuelo.factura_folio` → etiqueta del
      estatus («Facturado» / «Factura elaborada y enviada») → vacío. La usan
      el Libro Dinero (hoja 1 y «otros ingresos») y «otros movimientos» del
      Balance. **Nadie vuelve a armar su propio `facturaPorVuelo`** con la
      tabla `factura` a secas.
    - **Diagnóstico de la subida (24-sep-2026)**: en prod el #297 quedó
      FACTURADO (Mary Cruz, 23-sep 14:38 Cancún) SIN archivo y
      `facturas/vuelos/` está VACÍO. **Los logs de Supabase (edge_logs +
      storage_logs) prueban que la subida SÍ funcionó**: 14:28:29 Cancún
      `POST storage facturas/vuelos/dc204a2f…/33c47a79….pdf` 200 (PDF de
      51,220 bytes) + `PATCH vuelo`; «Ver» a las 14:32 y 14:37; **14:37:46
      `quitarArchivo` (`PATCH vuelo` + `DELETE storage` del mismo objeto,
      `ObjectRemoved:Delete`)**; 14:38 dos cambios de estatus. No se perdió
      al subir: se QUITÓ a mano, y como `quitarArchivo` borra el objeto del
      bucket, no hay cómo recuperarlo. Del lado API se reprodujo además el
      flujo real (multipart `file` + `folio`, PDF de 2.5 MB) por toda la
      cadena y pasa; lo que SÍ estaba mal: `FileInterceptor`
      de Nest convierte el MulterError en HttpException ANTES del filtro y
      el operador recibía **«File too large» / «Unexpected field» en
      inglés** (la rama MulterError del filtro era código muerto). Hoy
      `all-exceptions.filter#traducirErrorDeSubidaNest` responde 413
      `ARCHIVO_MUY_GRANDE` «El archivo pesa aprox. X MB…» (Content-Length),
      400 `CAMPO_ARCHIVO_INVALIDO` y 400 `SUBIDA_ILEGIBLE`; multer corta en
      `LIMITE_MULTER_FACTURA_BYTES` (10 MB + 1 MB de margen) para que el
      servicio diga el peso EXACTO (413 `ARCHIVO_MUY_GRANDE`, `details:
      { bytes, limite_bytes }`). OJO panel: en Vercel el cuerpo de una
      server action o route handler tiene tope DURO de **4.5 MB**
      (`FUNCTION_PAYLOAD_TOO_LARGE`), por debajo de los 10 MB del contrato
      — por eso el panel sube DIRECTO al API desde el navegador (no fue la
      causa del #297, era un PDF de 50 KB).

26. **CAJA CHICA: el saldo tiene FUENTE ÚNICA y el Excel de la reposición
    la LEE (24-sep-2026, API 0.0.29).** Todo saldo, «por reponer» y saldo
    corrido sale de `common/caja-chica-saldo.util.ts` (`saldoCaja`,
    `porReponerCaja`, `historialConSaldo`). El libro de un fondo lo arma
    SOLO `CajaChicaService.cargarLibro` (movimientos + gastos `EFECTIVO`
    del dueño en la moneda del fondo).
    - **Qué repone una reposición** = `tramoDeReposicion(historial, id)`:
      las entradas del libro entre la reposición ANTERIOR (exclusiva) y
      ésta, en el orden de `compararEntradasCaja` (un gasto fechado el día
      de la reposición entra en ella aunque se capture después — la misma
      regla del candado `GASTO_EN_REPOSICION`). Saldo/por reponer antes y
      después se LEEN de las filas del historial; `diferencia = repuesto −
      por reponer antes` (> 0 de más, < 0 quedó pendiente). Con `id = null`
      es lo PENDIENTE hoy. Spec con libro sintético:
      `common/caja-chica-tramo.util.spec.ts`.
    - `GET /v1/caja-chica/movimientos/:id/reposicion.xlsx` (GESTION; 404 si
      no existe; 409 `MOVIMIENTO_NO_ES_REPOSICION` si es reintegro/ajuste) y
      `GET /v1/caja-chica/fondos/:id/por-reponer.xlsx` (mismo formato, lo
      pendiente hoy). Payload PURO en `caja-chica/caja-chica-reposicion-xlsx.ts`
      → pyservices `POST /reportes/caja-chica-reposicion.xlsx` (hoja propia:
      el export genérico ancla el ancho de la columna A al encabezado de la
      tabla y cortaba «Por reponer antes de esta reposición» a 12
      caracteres). Si ese pyservices todavía no tiene el endpoint (404 ⇒
      `generateCajaChicaReposicionXlsx` devuelve null) se cae SOLO al export
      genérico `/pdf/tabla-xlsx` con el mismo contenido (`tablaXlsxDeCaja`):
      el orden de deploy no importa. Contenido: encabezado (responsable,
      caja, moneda, fondo, caja madre, fecha, monto, autorizó, registró,
      notas, periodo, reposición anterior) + tabla en el orden del libro con
      saldo y por reponer POR FILA del historial + fila TOTAL + totales (Σ,
      reintegros/ajustes, por reponer antes, repuesto, diferencia, saldo
      antes/después; con reposición anterior, además **«Saldo del libro al
      abrir el periodo» y «Por reponer que venía de antes»** = fila de la
      reposición anterior — sin ellas el Excel no cuadraba a la vista: Mary
      «Σ pendientes $2,738.99» vs «POR REPONER HOY $29,812.92», Alexander
      «Σ $3,658» vs repuesto $3,656 «cuadra»; el cuadre exacto es por saldo:
      abrir − Σ gastos + reintegros/ajustes = saldo antes); los gastos capturados DESPUÉS de registrar la
      reposición van resaltados en naranja con un aviso. Las columnas se
      copian a mano entre `COLUMNAS_EXCEL_CAJA` y `caja_chica_xlsx.COLUMNAS`
      (paridad manual). Los
      datos de presentación (comprobante, facturación, matrícula, quién
      capturó) se leen APARTE por id — `cargarLibro` no carga embeds que el
      detalle y la app no usan. Nombre: «Reposicion caja <responsable>
      <YYYY-MM-DD>.xlsx» / «Por reponer caja <responsable> <hoy>.xlsx»
      (ASCII + `filename*`).

27. **FACTURAS EMITIDAS (registro manual), «NECESITO FACTURA» y COMPROBANTE
    DEL COBRO (24-sep-2026, API 0.0.32, migración `20260924000003` APLICADA
    el 24-sep-2026 tras DRYRUN_OK).** Pedidos de Ale («las facturas que hace Mari manualmente
    … por orden del número … que no haya duplicadas») y de Itzi («algo que
    marque como necesito factura y a Mari le salga una alertita»; «adjuntar
    el comprobante del cobro»). Contrato de diseño v2 compartido con panel
    y pyservices (tipos JSON en `facturas-emitidas.types.ts`, idénticos a
    `vuelatour-next/src/types/facturas-emitidas.ts`). Tres cosas, ninguna
    toca dinero:
    - **Registro `factura_emitida` + puente `factura_emitida_vuelo` (N:M)**
      — NO es la facturación automática del PAC (`factura`,
      `/admin/facturas`, intacta). Módulo `modules/facturas-emitidas/`
      (`v1/facturas-emitidas`, `@Roles(ADMIN, FACTURACION)` de CLASE; ver el
      PDF también COORDINADOR). Lógica PURA en `facturas-emitidas.util.ts`
      (con spec): número único = **emisora + serie + folio** (hay DOS razones
      sociales con numeración propia; emisora NULL = comodín al buscar
      duplicados); duplicado = `claveCompacta` («A»+«00123» = «A-123» sin
      serie = «a 123») + `mismaEmisora`; `buscarYaRegistrada` es LA regla del
      409 (`FACTURA_DUPLICADA`/`UUID_DUPLICADO` con la existente) y del banner
      «ya registrada» de `leer-archivo` — nunca discrepan. Orden por número
      (`serieEfectiva` → `folio_num` → folio), huecos por (emisora, serie)
      contando canceladas y aritméticos (un folio con un dígito de más no
      enumera millones), alertas `DUPLICADO_VUELO` (≥ 2 vigentes y al menos
      una NO `es_parcial`), `SIN_PDF`, `SIN_VUELO`, `VUELO_CANCELADO`.
      **Los archivos NUNCA se borran del bucket** (el #297 perdió su PDF con
      un «Quitar»): quitar/reemplazar solo desreferencia y deja la entrada en
      `archivos_historial`; el ÚNICO `storage.remove` es lo recién subido de
      una operación que FALLÓ. Cancelar ≠ eliminar (soft delete con motivo;
      TODO lector filtra `deleted_at is null`). Ligar una VIGENTE sube
      `vuelo.factura_estatus` SIN_FACTURA ⇒ FACTURADO con CAS (nunca baja;
      no es columna del trigger de Google). El PDF lo lee pyservices
      (`/facturacion/leer-pdf-emitida`, sin IA; si falla ⇒ aviso
      `PDF_NO_LEIDO`, nunca 500); el XML el parser TS
      (`extraerCfdiCompleto`, DOCTYPE ⇒ 422). La columna «FACTURA VUELATOUR»
      de los Excel suma el paso «emitidas VIGENTES» a su cascada única
      (`etiquetaFacturaVuelo`): CFDI PAC → «A-123, A-130» → folio legado →
      estatus. Las rutas viejas `flights/:id/factura-cliente/*` siguen vivas
      (compatibilidad); el panel ya no sube por ahí.
    - **Solicitud en `vuelo`** (`factura_solicitada_at/_por`,
      `factura_solicitud_nota`, `factura_paga_contra_factura`): `POST|DELETE
      v1/flights/:id/solicitud-factura` (`FacturaSolicitudService`,
      idempotente; `todo_el_grupo` = UNA notificación). **«Por facturar» es
      DERIVADO, nunca se guarda** (`factura-solicitud.util#esPorFacturar`):
      solicitada AND no CANCELADO AND `facturado` (PAC) ≠ true AND 0 emitidas
      VIGENTES ligadas. Aviso `factura_solicitada` a
      `ConfiguracionService.destinatariosFacturacion` (config
      `responsables_facturacion` en `valor_json` → rol FACTURACION → ADMIN;
      el nivel se elige ANTES de excluir a quien pide) y `factura_emitida` a
      quien pidió (avisos directos, sin fila en `alerta_config`; la app
      Flutter no conoce esos tipos: ícono genérico y el tap abre el vuelo
      por `data.vuelo_id` — verificado sin tocar la app). Bloques ADITIVOS `factura_servicio` (snapshot) y
      `factura_servicio_resumen` (listas de vuelos y cotizaciones; se OMITEN
      para PILOTO/MECANICO/VISITANTE). La clave de config se EXCLUYE de
      `GET /v1/config` y `PATCH /config/:clave` la rechaza (400).
    - **Comprobante del cobro**: `POST v1/flights/cobros/:cobroId/comprobante`
      (foto o PDF ≤ 10 MB, bucket `cobro-vouchers`, `oficina/<vuelo>/<cobro>/`)
      — evidencia, no dinero: no se bloquea por conciliación ni por el candado
      de cotización, no llama `refreshCobradoFlag`, CAS sobre
      `foto_voucher_url` (409 `COMPROBANTE_CAMBIO`) y el archivo ANTERIOR se
      conserva. Parte de sobre de grupo ⇒ 409 `COBRO_DE_GRUPO` (pendiente:
      el grupo tampoco sube vouchers).
    - **Candados**: borrar/purgar un vuelo con factura emitida VIGENTE ⇒ 409
      `VUELO_CON_FACTURA_EMITIDA`; las ligas de canceladas/borradas van a la
      bitácora forense, se quitan justo antes del DELETE y se REPONEN si
      falla. `reassignAircraft` mueve las ligas al clon (si falla, el
      registro marca `VUELO_CANCELADO`). **Toda consulta `.in(...)` del
      bloque va en lotes de ≤ 200 ids** (incluido `cobroStatus`, que ahora
      parte solo). Dinero en textos: `common/dinero-texto.util` (nunca 1
      decimal; `semaforo-cobro.util` usa la misma regla).
    - **Sin la migración** (sonda única `common/factura-emitida-disponible.util`,
      re-sondeo ≤ 10 min): rutas nuevas y responsables ⇒ 503
      `FACTURAS_EMITIDAS_NO_DISPONIBLE`; snapshot/listas ⇒ `null`; Excel,
      etiquetas y vuelos idénticos a hoy. El comprobante NO depende de ella.

28. **FLECHAS ENTRE COTIZACIONES — `GET /v1/quotes/:id/vecinos` (24-sep-2026,
    API 0.0.32, sin migración).** Pedido de Itzi: «ya le piqué al vuelo del
    20 de septiembre … si hay una flechita arriba me brinca el siguiente
    vuelito, ya sea de ese mismo día o hasta el siguiente día». Solo lectura.
    - **Orden CRONOLÓGICO por `fecha_vuelo`, empate por `folio`** (único):
      «siguiente» = el vuelo que sigue en el tiempo (mismo día más tarde o
      días después), NO el folio siguiente. Respuesta `{anterior, siguiente:
      {id, folio, fecha_vuelo, estado, cliente_nombre} | null, sin_fecha}`.
    - **MISMOS filtros y roles que `GET /quotes`** (`VecinosQuotesQuery =
      OmitType(ListQuotesQuery, ['limit','offset'])`; ADMIN, COORDINADOR,
      FACTURACION, ANALISTA, SOCIO; sin filtrado por fila). Fuente ÚNICA para
      las dos rutas: `condicionesBusqueda(q)` (async: resuelve UNA vez las
      búsquedas de cliente y aeropuerto y devuelve la cadena del `.or`) +
      `aplicarFiltrosLista(qb, filtros, condQ)` (síncrona). Si divergen, la
      flecha brinca a una cotización que la lista no enseña. `list` no cambió
      de comportamiento (el spec compara el `.or` de las dos).
    - **Barato**: ancla (`id, folio, fecha_vuelo`) + CUATRO consultas en
      paralelo con `limit(1)` sobre `idx_vuelo_fecha_vuelo` (mismo instante con
      folio mayor/menor · primer instante posterior · último anterior), así no
      se combinan dos `.or()` de PostgREST. Jamás se carga la lista.
    - El ANCLA es la cotización actual aunque ya no cumpla el filtro; sin
      `fecha_vuelo` ⇒ `sin_fecha: true` y ninguna consulta más; una sin fecha
      nunca es vecina; las CANCELADAS entran como en la lista; 404 como
      `findById`; un error de PostgREST SUBE (el panel degrada con aviso, nunca
      pinta «no hay siguiente» por una lectura fallida).
    - Detalle de tipos: el `limit(1)` va en la BASE, antes de los filtros —
      en el otro orden el genérico de `aplicarFiltrosLista` revienta el
      chequeo de tipos de supabase-js (TS2589)— y `primerVecino` resuelve cada
      consulta a `QuoteVecino | null` fuera del `Promise.all`.
    - Specs: `quotes.service.vecinos.spec.ts` (BD en memoria que INTERPRETA
      `eq/gt/lt/ilike/in/or/order/limit`: mismo día más tarde, día siguiente,
      empate, extremos, recorrido completo ida y vuelta, filtros, `q` resuelta
      una vez, ancla fuera del filtro, sin fecha, 404, error que sube, y la
      paridad del `.or` con `list`) y `quotes.controller.vecinos.spec.ts`
      (HTTP real con `RolesGuard`: ruta antes de `:id`, roles = los de la
      lista, `limit` ⇒ 400).
    - **Hueco conocido, AJENO a esto**: con `enableImplicitConversion` el
      `@ToBooleanQuery()` recibe el valor YA convertido (`'false'` ⇒ `true`),
      así que `?es_externo=false` filtra como `true` — en la lista y en las
      flechas por igual (el panel no manda ese filtro). Afecta también a
      `conciliado`, `pendientes`, `duplicados`, `activo` y `forzar` de otros
      DTOs; no se tocó aquí.

29. **INGRESOS Y ANTICIPOS + CONCILIACIÓN DE INGRESOS (24-sep-2026, API
    0.0.34, migración `20260924000004` — APLICADA el 24-sep-2026 tras
    DRYRUN_OK, más el revoke de RPC de sus triggers).** Pedido del cliente: «faltarían las categorías de "ingresos"
    de igual manera de como están ya ahorita las de "gastos" … Otros
    Ingresos, Anticipos y depósitos, Ingresos en cuentas de banco»; del
    usuario: «conciliar como los gastos pero ahora los ingresos subiendo un
    estado de cuenta y con IA marcar los que sí empatan con los cobros de
    los vuelos». Contrato v2 compartido con panel y pyservices (tipos JSON
    en `ingresos/ingresos.types.ts` = `vuelatour-next/src/types/ingresos.ts`).
    - **Tabla `ingreso`** para TODO lo que NO es un cobro de vuelo
      (`cobro_vuelo` NO se reutiliza). Categorías = texto + CHECK (sin el
      incidente del ENUM), FUENTE ÚNICA `common/categoria-ingreso.util.ts`
      (el panel la copia con los MISMOS nombres de export): OTRO_INGRESO,
      INGRESO_BANCARIO, REEMBOLSO_DEVOLUCION y VENTA_ACTIVO **suman a
      resultados** (derivado del destino «Otros ingresos (Balance general
      VuelaTour y Libro Dinero)», membresía congelada en spec — a propósito
      NO se dice «Otros ingresos VuelaTour», que es el bloque de TUAs/extras
      del reparto); ANTICIPO_CLIENTE y APORTACION_PRESTAMO quedan **fuera**.
      `monto` = BRUTO, neto = monto − `comision_monto`; `fecha` = DATE (día
      Cancún); folio `ING-n`; soft delete (`deleted_at` + `motivo_baja`, TODO
      lector filtra); archivos que NUNCA se borran del bucket privado
      `ingresos` (`archivos_historial`); bitácora `ingreso_bitacora` por
      trigger (+ APLICAR/DESAPLICAR/CONCILIAR/DESCONCILIAR best-effort).
    - **Anti doble conteo** (un ingreso de resultado JAMÁS es el pago de un
      vuelo): `vuelo_id` solo en REEMBOLSO_DEVOLUCION (CHECK
      `ingreso_vuelo_chk` + 400 `VUELO_SOLO_EN_REEMBOLSO`); «registrar como
      otro ingreso» un abono que cuadra (neto o bruto ±1.00, ±30 días) con un
      cobro de vuelo LIBRE ⇒ 409 `ABONO_TIENE_COBRO_CANDIDATO` salvo
      `aceptar_sin_cobro` (caso real #235: 19,380 = 20,400 − 1,020); línea del
      banco repetida ⇒ 409 `ABONO_POSIBLE_DUPLICADO` salvo confirmación; y
      `POST /ingresos/abonos/:movId/cobro-de-vuelo` («Es el pago de un
      vuelo»: `createCobro` + `linkCobro`, con compensación que BORRA el
      cobro si la liga falla; comisión 0 EXPLÍCITA si el abono no la trae,
      o un PAYWISE provisionaría 8.857 %). USD de resultado exige TC (el
      oficial de su fecha o 400 `TC_REQUERIDO`; CHECK
      `ingreso_tc_resultado_chk`); toda regla del alta se re-valida sobre el
      estado FUSIONADO en el PATCH.
      **Revisión adversaria (24-sep-2026), tres candados más del mismo
      dinero**: (1) `cobro-de-vuelo` rebota 409 `ABONO_TIENE_COBRO_CANDIDATO`
      si ESE vuelo ya tiene un cobro LIBRE que cuadra con el abono (sin
      ventana de fechas; `aceptar_sin_cobro` en el cuerpo lo confirma) —
      crear otro contaba el mismo pago dos veces en `cobrosEnUsd` y
      `COBRO_EXCEDE_SALDO` solo lo veía si el doble rebasaba el total;
      (2) el AUTO-cruce (banco y pasarela, y por tanto
      `intentarCruzarIngreso`) NO liga un abono a un INGRESO si un cobro o
      sobre LIBRE (métodos manuales, ±30 días) cuadra exacto
      (`cobrosExactosLibresDeAbono` ⇒ AMBIGUO; «Por conciliar» lo pinta
      igual): el cruce de pasarela solo mira cobros PAYWISE y un «otro
      ingreso» de 19,380 tecleado a mano se llevaba el abono de #235;
      (3) `linkIngreso` escribe con CAS (`ingreso_id is null` al ligar, la
      liga leída al desvincular): dos ligas simultáneas del mismo abono ya no
      se pisan (el CHECK excluyente no lo impide: es la misma columna).
    - **Anticipo aplicado = cobro NORMAL** por `FlightsService.createCobro`
      (6.º parámetro INTERNO `{ingreso_anticipo_id}`; sin él el insert es
      byte-idéntico) ⇒ cuenta en el vuelo por `cobrosEnUsd` (bandera
      `cobrado`, semáforo, «Pagado», COTIZACION_COBRADA, reparto, libros)
      exactamente como cualquier cobro; el anticipo NUNCA suma a resultados.
      Trigger `tg_cobro_vuelo_anticipo` (`for update`, moneda `::text`):
      Σ aplicado ≤ anticipo, misma moneda, solo positivos sin sobre y la liga
      es **INMUTABLE** (soltarla devolvería saldo con el cobro vivo). Comisión
      por aplicación = proporcional con el RESIDUO en la que agota
      (`comisionDeAplicacion`, Σ == comisión del anticipo) y 0 EXPLÍCITO sin
      comisión. Idempotencia PRIMERO en alta, alta desde abono y aplicación
      (el reintento con saldo ya agotado responde 200 `idempotente`, sin 2.ª
      bitácora). `updateCobro` rechaza cambiar monto/moneda/comisión/método
      de un cobro de anticipo (409 `COBRO_DE_ANTICIPO`, comparando contra el
      VIGENTE; T.C., referencia, fecha y notas sí) y, si el dinero reenviado
      es el MISMO, lo CONGELA (no recalcula la comisión desde el % de 4
      decimales: 98,765.43 con 8,747.21 volvía 8,747.26 y rompía Σ
      comisiones == comisión del anticipo); `deleteCobro`
      («desaplicar») sigue permitido aunque el anticipo esté conciliado — el
      candado usa `movimientoDeCobro` A PROPÓSITO — y deja DESAPLICAR.
    - **Conciliado de un cobro**: fuente única extendida
      `cobro-conciliado.util#conciliacionDeCobro` (DIRECTO | SOBRE |
      ANTICIPO; aditivo, lo de antes byte-idéntico). `adjuntarSobres` expone
      `anticipo` y `conciliado_via` (solo con la migración). Un cobro de
      anticipo NUNCA es candidato de un abono (auto-cruce, candidatos
      manuales, IA, Paywise) y `linkCobro` lo rechaza (409
      `COBRO_DE_ANTICIPO`): su dinero se concilia UNA vez, como anticipo.
      **«Cobros sin banco» / pre-cierre**: el cobro de un anticipo sale
      MIENTRAS su anticipo no esté ligado a su abono (marcado `anticipo`);
      la regla de «sin conciliar» de Ingresos es EXACTAMENTE esa (métodos
      `METODOS_COBRO_ABONO_AUTO`; BillPocket sin liga = «no se concilia uno a
      uno»), con spec de paridad contra `cobrosSinBanco`.
    - **Conciliación de ingresos**: `movimiento_bancario.ingreso_id` (1 ↔ 1,
      solo ABONO conciliado, EXCLUYENTE con gasto/cobro/sobre/clasificación
      por CHECK); `linkIngreso` (`PATCH conciliacion/movimientos/:id/ingreso`,
      regla 6.3 con sus 409) y `link`/`linkCobro`/`clasificar` rechazan un
      abono ligado a un ingreso (409 `MOVIMIENTO_YA_LIGADO`, `liga:
      'INGRESO'`). Decisión ÚNICA del auto-cruce de abonos en
      `conciliacion/abono-cruce.util.ts` (PURA): cobros, sobres e ingresos de
      la MISMA cuenta en un universo, monto igual a centavos como siempre y,
      con ≥ 2, el NOMBRE del ordenante SPEI desempata solo si deja UNO
      (`empataNombre`); pasarela sin cobro Paywise prueba los ingresos de esa
      cuenta. Camino inverso `intentarCruzarIngreso` (nunca lanza).
      `GET conciliacion/abonos-pendientes` (patrón traspaso/reverso, motivo
      del auto, `exactos_manual`, duplicado, cliente y categoría sugeridos;
      lecturas en lote paginadas — si fallan o llegan al tope,
      `motivos_calculados=false` y nada inventado) y `POST
      conciliacion/sugerir-abonos` (IA: propone y JAMÁS liga; REGLA sin IA
      para traspasos, reversos, duplicados y lo que el auto ya cruza; lotes
      de ≤ 10 abonos, ≤ 3 llamadas EN PARALELO, 130 s; `ia_uso` categoría
      `CONCILIACION_ABONOS_SUGERIR` también en el 502 truncado; ids
      validados contra los candidatos del abono, dedupe entre abonos,
      REGISTRAR_INGRESO con cobro exacto ⇒ LIGAR ≤ 0.7 o REVISAR;
      `monto_exacto` lo calcula el API). Clasificación canónica «Reverso de
      un cargo» (sembrada por la migración; se SUGIERE, nunca se aplica sola).
    - **Libros**: fila ÚNICA `common/ingreso-resultado.util#filaLibroDeIngreso`
      (TC PROPIO del ingreso, comisión como egreso, remanente = ingreso −
      comisión; USD sin TC ⇒ null + nota). Libro Dinero: filas ING al FINAL
      de «Otros ingresos» y su comisión se RESTA en
      `utilidades_otros_ingresos_mxn` (sube exactamente Σ remanente). Balance
      general: filas al final de las sueltas de «Otros movimientos». Reparto,
      pre-cierre, balance por avión, dashboards y reporte por vuelo NO
      cambian (decisión del cliente). **Sin ingresos, payload BYTE-IDÉNTICO**
      (specs con golden capturado del código sin modificar).
    - **Sonda ÚNICA** `common/ingreso-disponible.util` (columna
      `movimiento_bancario.ingreso_id`, re-sondeo ≤ 10 min): TODO lo que
      nombre `ingreso_id`, `ingreso_anticipo_id` o la tabla `ingreso` fuera
      del módulo va detrás de ella; sin la migración, conciliación, cobros,
      pre-cierre y reportes responden como hoy (spec «sin migración» que
      falla ante cualquier consulta que nombre lo nuevo) y
      `/v1/ingresos/*` + las rutas nuevas de conciliación ⇒ 503
      `INGRESOS_NO_DISPONIBLE`.
    - **Roles**: clase `ROLES_INGRESOS` = ADMIN, COORDINADOR, FACTURACION
      (los de «Gastos»); DESAPLICAR y `cobro-de-vuelo` = `ROLES_CONCILIAR`
      (ADMIN, FACTURACION) por `@Roles` de MÉTODO; alta CON
      `movimiento_bancario_id` ⇒ 403 `CONCILIAR_SOLO_ADMIN_FACTURACION` a
      COORDINADOR. Anti-cap: `in (…)` ≤ 200 ids y periodos paginados con
      tope 5,000 (400 `PERIODO_MUY_GRANDE`). Ningún booleano en query.
    - Specs: `categoria-ingreso.util`, `ingreso-disponible.util`,
      `ingreso-resultado.util`, `cobro-conciliado.util` (aditivos),
      `abono-cruce.util`, `ingresos.util`, `ingresos-xlsx`,
      `ingresos.service`, `ingresos.controller` (HTTP real),
      `conciliacion.service.ingresos`, `flights.service.anticipo`,
      `dinero-report.service.ingresos` y `aircraft-balance.service.ingresos`.

## Convenciones NestJS

- **Orden de rutas**: las rutas literales (`taco-live`, `descansos`,
  `pre-cierre`, `resumen`) se declaran ANTES de las rutas `':id'` del mismo
  segmento, o Nest las captura como id.
- Crones: aviso de tacos vencidos (push al piloto, sin escrituras)
  `*/10 * * * *`; resumen nocturno de tacos `45 4 * * *` UTC (23:45 Cancún);
  vuelos zombi `55 4 * * *`; alertas diarias `0 8 * * *` con
  `timeZone: America/Cancun`; programa de servicio por horas
  `*/10 * * * *` Cancún (`runServicioHoras`, red de seguridad del hook de
  tacómetro — invariante 21); recordatorios de eventos NO-vuelo
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
      tablas** (gasto, cobro*vuelo, inventario_movimiento, aeronave…): sin la
      primera condición, un UPDATE que no cambia NADA dejaría de sellar
      `updated_at` en TODAS ellas — un cambio de semántica que nadie pidió. En
      las tablas sin columnas `google_calendar*\*` la excepción NUNCA aplica y
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
      - `range` de 1000 en 1000; revisión adversaria 12-sep-2026): con la
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
    (`🔧 En taller · …` si `EN_TALLER`), **colorId 5 (Banana) en los DOS
    estados desde el 22-sep-2026** (antes 11 Tomate para el taller: ver el
    bullet del semáforo), `extendedProperties.private.vuelatour_mantenimiento_id`, id en
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
  - **SEMÁFORO DE 6 COLORES (pedidos del cliente del 22-sep-2026 y del
    24-sep-2026; sustituye a la paleta de 10 del 12-sep y a la de 5 del
    22-sep)**. 22-sep: «para que en los calendarios no se vean tantos colores
    […] los colores que tiene cada avión configurados los seguiremos
    respetando principalmente en los reportes del balance individual y
    general en los excel […] en realidad los colores son para el reporte de
    excel nada más». 24-sep: «Ale quiere cambiar el color del descanso y
    agregar el de cobrado (este me imagino se cambiaría en automático cuando
    ya esté cobrado)». Aplica a las TRES superficies (panel, app y Google).
    - **Los seis, y nada más** (`SEMAFORO` en
      `calendar/colores-calendario.util.ts`, fuente única), en el ORDEN de la
      lista del cliente: gris `#64748B` **Tentativo** · amarillo `#F59E0B`
      **Pendiente (permiso)** · verde `#22C55E` **Confirmado** · azul
      `#3B82F6` **Pagado** · rojo `#EF4444` **Cancelado** · morado `#8B5CF6`
      **Descanso 💤**. **El azul CAMBIÓ DE DUEÑO el 24-sep-2026**: era del
      descanso y hoy es del PAGADO. Cualquier texto que diga «azul =
      descanso» está viejo. `LEYENDA_SEMAFORO` (6 renglones
      `{color, etiqueta, ayuda?}`), `AYUDA_PENDIENTE` (tooltip de «Pendiente
      (permiso)»: «Permiso de pista pendiente. También se pinta así el vuelo
      confirmado que todavía no tiene avión o piloto asignado.») y
      `NOTA_COLOR_AVION` exportan el texto EXACTO. El panel
      (`lib/admin/calendario-semaforo.ts`) y la app
      (`core/theme/semaforo_calendario.dart`) los COPIAN byte por byte
      (verificado el 24-sep, emoji incluido) y los dos arrancan su tooltip
      con `AYUDA_PENDIENTE`.
    - **`aeronave.color_calendario` YA NO PINTA NINGÚN CALENDARIO.** La
      columna sigue viva y se sigue editando en la ficha del avión (etiqueta
      «Color en los reportes de Excel»). Su ÚNICO consumidor son los Excel
      de pyservices (`balance_avion_xlsx.py`, balance general).
      `colorAvion` sigue en `ParamsColorVuelo` para no romper llamadores,
      pero se IGNORA (`@deprecated`).
    - **Precedencia ÚNICA** (`colorVueloSistema`; vuelo o tramo, propio o
      EXTERNO; el externo no tiene color propio): **cancelado (rojo) >
      tentativo (gris) > pendiente (amarillo) > PAGADO (azul) > confirmado
      (verde)**. Tentativo = `ESTADOS_TENTATIVOS` (RESERVA, SOLICITUD,
      COTIZADO). Pendiente = `vueloPendiente` = permiso PENDIENTE **o**
      `vueloSinAsignar` (confirmado propio sin avión o piloto); cualquier
      bandera nueva de «pendiente» se suma AHÍ. Pagado = `vueloPagado`. El
      verde es el DEFAULT por descarte. Consecuencias: un pagado con permiso
      pendiente o sin asignar se ve AMARILLO (el pendiente operativo no se
      esconde detrás del dinero); una RESERVA o COTIZADO pagada se ve GRIS;
      un cancelado con anticipo retenido se ve ROJO.
    - **PAGADO = `vuelo.cobrado`** (fuente única: la mantienen
      `FlightsService.refreshCobradoFlag` y su gemelo
      `quotes.refreshCobradoTrasRecotizar` con `cobrosEnUsd`:
      `monto_total > 0 && cobrado ≥ total − 1`). `vueloPagado` NO
      recalcula: exige `cobrado === true` y, si llega `montoTotalUsd`, que
      el total sea > 0. Es un cinturón para que un vuelo en $0 o de cliente
      interno NUNCA salga azul; en prod, el 24-sep ninguno de los 185
      cobrados tenía total ≤ 0. Es dato del VUELO: todos sus tramos lo
      comparten. Nadie lo marca a mano: se pinta al registrar el cobro que
      liquida el vuelo y regresa a verde al borrar o reembolsar, porque
      create, update, delete, reembolso y grupo pasan todos por
      `refreshCobradoFlag`. `GET /v1/calendar` lee `cobrado` en la MISMA
      consulta de vuelos (sin N+1) y manda el ADITIVO `pagado: boolean` en
      cada evento de VUELO. Es el DATO, como `sin_asignar`/`tentativo`:
      puede ser true aunque gane otro color, y ningún cliente decide un
      color con él.
    - **Mantenimiento = AMARILLO siempre** (`colorMantenimientoSistema`),
      PROGRAMADO y EN_TALLER por igual; el taller se lee en el título
      («🔧 En taller · …»). **Evento NO-vuelo = VERDE**
      (`colorEventoFlotaSistema`): es una cita en firme y lo distingue el
      📌.
    - **Google, 6 colorId DISTINTOS** (`colorIdGoogleDe` redmean PURO y
      `colorIdGoogleSemaforo`, que aplica primero las excepciones fijas de
      `COLOR_ID_FIJO`): gris #64748B → **8** Grafito · amarillo #F59E0B →
      **5** Banana · verde #22C55E → **2** Salvia · azul #3B82F6 (pagado) →
      **7** Pavo real (redmean d≈9 983) · rojo #EF4444 → **11** Tomate
      (FIJO: redmean daría 6 Mandarina, un naranja; hoy no viaja porque el
      evento de un cancelado se BORRA) · morado #8B5CF6 (descanso) → **3**
      Uva (FIJO: redmean daría 1 Lavanda, d≈12 469, un azul lila que junto
      al 7 del pagado se lee «otro azul»; Uva es el único morado de verdad
      de Google). Libres: 1 Lavanda, 4 Flamenco, 6 Mandarina, 9 Arándano y
      10 Albahaca. El mantenimiento va en 5 y el evento de flota en 2.
      `calendar-sync` no tiene colorId propios: si el cliente cambia un
      color, se cambia en la util y panel, app y Google se mueven JUNTOS.
    - **TRIGGER: toda columna que decida el título, la descripción o el
      COLOR del evento va en `after update of …` de
      `trg_vuelo_calendar_sync`.** `cobrado` entró con
      `20260924000002_calendar_sync_cobrado.sql` (lista de `20260917000001`
      + `cobrado`, verificada contra prod con `pg_get_triggerdef`). Sin
      ella, liquidar un vuelo solo escribe `cobrado` + `updated_by`, no se
      encola nada y Google se queda verde hasta el reconcile de las 00:15.
      `calendar_sync_encolar()` no cambió: compara `to_jsonb(OLD/NEW)`.
    - **Congelado en specs**: `colores-calendario.util.spec.ts` (6 hex,
      leyenda, `AYUDA_PENDIENTE`, tabla de precedencia con pagado,
      `vueloPagado`, `colorAvion` ignorado), `calendar.service.spec.ts`
      («semáforo de 6 colores» + `pagado` + `cobrado` en el select),
      `google-evento.util.spec.ts` (tabla de 6 colorId) y
      `calendar-sync.service.spec.ts` (7 para el pagado, 3 para el descanso,
      `cobrado` en `VUELO_SELECT`). Además, el panel
      (`calendario-semaforo.test.ts`, `leyenda-semaforo.test.tsx`,
      `sin-hex-sueltos.test.ts`) y la app (`semaforo_calendario_test.dart`)
      guardan una COPIA de la paleta, la leyenda y `AYUDA_PENDIENTE`: si
      cambias uno de los tres repos, cámbialos juntos.
    - **DESPLIEGUE (24-sep-2026)**: API y migración (entre ellos el orden da
      igual), después panel, después APK 1.1.3+72; luego
      `POST /v1/calendar/resync` (ADMIN, ventana `[hoy−30d, hoy+365d]`) para
      RE-PINTAR lo ya publicado, o esperar al reconcile de las 00:15. La
      cola no se entera sola de un color que cambió en el código. Fotos de
      prod del 24-sep:
      - Google, por vuelo: 122 vuelos; **68 pasan de 2 a 7**, 24 siguen en
        verde, 16 amarillos, 6 grises y 8 cancelados sin evento. **13
        descansos pasan de 7 a 3**.
      - Sistema (`listEvents` real), por evento: 130 eventos de 121 vuelos =
        69 azules, 24 verdes, 18 amarillos, 10 grises y 9 rojos; 19 días de
        descanso en morado.
      Mientras no corra el resync, en Google un descanso viejo y un vuelo
      recién liquidado comparten el 7.
    - **Residuo conocido (sin migración, a propósito)**: el fan-out
      `trg_aeronave_calendar_fanout` sigue escuchando
      `aeronave (matricula, color_calendario)`, así que cambiar el color de
      un avión re-encola sus vuelos y republica eventos IDÉNTICOS. Es ruido
      inofensivo.
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
- **`registrado_por_nombre` — quién registró el cobro (22-sep-2026, pedido
  del cliente: «ver ahí en la lista de cobros de un vuelo quién registró el
  cobro»)**. Fuente única `src/common/registrado-por.util.ts`
  (`idsRegistradoPor`, `fetchNombresUsuarios`, `conNombreRegistrado`,
  `adjuntarNombreRegistrado`). Campo **ADITIVO** que resuelve el uuid
  `cobro_vuelo.registrado_por` / `cobro_grupo.registrado_por` a
  `usuario.nombre`. Reglas:
  - **JAMÁS un embed dentro de `COBRO_COLS`**: esa fila es el `CobroLike` de
    `cobrosEnUsd` (invariante 2), del recibo PDF y del CFDI — un embed le
    cambia la forma a los tres. El nombre se pega DESPUÉS, en el armador.
  - **EN LOTE, una consulta por respuesta** (ids DISTINTOS, `in (...)`), nunca
    una por cobro. Se aplica en los DOS chokepoints de lectura:
    `FlightsService.adjuntarSobres` (cubre `listCobros` ⇒ snapshot del vuelo,
    `GET /flights/:id/payments`, la card de cobros del cotizador —que lee ese
    mismo snapshot— y el PDF interno) y `GroupsService.armarSobreSalida`
    (`sobresDeGrupo`/`sobrePorId` ⇒ `GET /grupos/:id` y `/grupos/:id/cobros`).
    En `adjuntarSobres` viaja en el MISMO `Promise.all` que sobres y
    movimientos: cero latencia extra.
  - **Nunca un nombre inventado ni un uuid**: usuario borrado, `nombre`
    vacío, id que no resuelve o **lectura fallida** ⇒ `null`.
    `fetchNombresUsuarios` **no lanza nunca** (error de PostgREST _y_
    rechazo del cliente): va dentro de un `Promise.all` que arma el dinero de
    la card, y un nombre no puede tumbar el snapshot de un vuelo.
  - `GET /v1/quotes/:id` NO devuelve cobros (solo los cuenta en el 409
    `COTIZACION_COBRADA`): no hay nada que enriquecer ahí.
  - Las respuestas de ESCRITURA (`POST /flights/:id/cobros`, `.../reembolso`,
    `PATCH /flights/cobros/:id`) devuelven la fila cruda, **sin** el campo: el
    panel hace `router.refresh()` y relee la lista. Si algún día la app lo
    necesita optimista, se resuelve UNA vez y se pasa a las partes — nunca
    una consulta por parte de sobre.

## Migraciones y despliegue

- Migración = archivo en `supabase/migrations/` **y** aplicada vía MCP al
  proyecto prod `bjesduasnzbzywofukbf` (existen dos proyectos; verificar).
  Tras DDL correr `get_advisors`. RLS habilitado en todas las tablas (la API
  usa service key).
- **APLICADA (25-sep-2026, API 0.0.35; DRYRUN_OK C1–C6 con escrituras reales; `get_advisors` solo el INFO de RLS sin policies; ningún ítem ligado todavía)** —
  `20260925000001_inventario_ubicacion_margen.sql` (invariante 8,
  «UBICACIONES» y «UTILIDAD DE LA TIENDA»): tabla `inventario_ubicacion` (RLS
  sin policies) sembrada con las 5 del cliente, `inventario_item.ubicacion_id`
  (FK restrict + índice parcial), `inventario_item.ubicacion` pierde NOT NULL
  y su default (se conserva como legado, SIN backfill), 4 triggers nuevos
  (`trg_inventario_ubicacion_set_updated_at`,
  `trg_inventario_item_ubicacion_espejo`, `trg_inventario_ubicacion_candados`,
  `trg_inventario_ubicacion_renombre`; funciones SECURITY INVOKER con
  `search_path = ''`, sin `moneda`) y la fila
  `configuracion_sistema.inventario_margen_venta_pct = 25`. **Antes de
  aplicar**: el DRY-RUN de su cabecera (UNA sentencia `do $dry$ … $dry$` con
  las secciones 1–6 pegadas en B; UPDATE/INSERT REALES de `inventario_item`
  —espejo, legado, FK, alta del API 0.0.34 con texto— y del catálogo
  —renombre que propaga, únicos, desactivar/borrar con productos— que termina
  en `DRYRUN_OK`). OJO: borrar una ubicación con productos responde
  **23001 `restrict_violation`** (FK `on delete restrict`), no 23503: el
  dry-run acepta los dos. Probado en PGlite (Postgres 17) con un esquema
  espejo: `DRYRUN_OK` y aplicación idempotente (dos veces ⇒ 5 filas). Tras
  aplicar: `get_advisors` (esperado solo el INFO de RLS sin policies), 5
  ubicaciones, 0 ítems con `ubicacion_id`, margen 25 y sondear
  `GET /v1/inventory/ubicaciones` (200; la sonda re-sondea en ≤ 10 min o
  reiniciar el API). El API 0.0.35 es desplegable ANTES (503 claro en lo
  nuevo; todo lo demás como 0.0.34) y el 0.0.34 convive con ella.
- **APLICADA (25-sep-2026, con el API 0.0.35 ya en prod; migración de DATOS; DRYRUN_OK C0–C7; resultado: 10 salidas y 10 gastos, N4142R 1,477.27 · XA-VGV 1,199.41 · total 2,676.68 USD, utilidad 535.35; bitácora +10 actor Sistema)** — `20260925000002_repreciar_salidas_tienda.sql`:
  re-precia las 10 SALIDAS del 01-sep a costo FIFO + 25 % (`venta_unitaria`
  y el gasto BODEGA de cada una: N4142R 1,181.81 → 1,477.27, XA-VGV 959.52 →
  1,199.41 USD; total +535.35). Función en `pg_temp` con la tabla de casos
  (la lee el spec jest), GUARDAS por id exacto (venta = costo, monto viejo,
  mismo avión, sin conciliar / cargo bancario / factura / FACTURADA /
  compra / reparto / ingreso ligados, un solo gasto por salida) ⇒
  `REPRECIO_ABORTADO` sin escribir nada si alguna cambió; idempotente
  (`REPRECIO_YA_APLICADO`). **Antes de aplicar**: el DRY-RUN de su cabecera
  en UNA llamada de `execute_sql` (sección 1 tal cual —SIN la 2— + el `do
  $dry$`): C0 un gasto conciliado aborta sin escribir, C1/C2 10/10 e
  idempotente, C3 importes al centavo, C4 por avión, C5 jul/ago intactas,
  C6 bitácora +10 (`actor_id` null ⇒ «Sistema»), C7 conteos ⇒ `DRYRUN_OK`.
  Probado en PGlite con los 13 movimientos/gastos reales y los 4 triggers
  reales de `gasto`. **Confirmar con la oficina la diferencia de 1 ¢ por
  avión** (+295.46/+239.89 vs +295.45/+239.88 autorizados). Efecto: el
  Balance de SEPTIEMBRE de N4142R y XA-VGV. Tras aplicar:
  `GET /v1/inventory/tienda/resumen` ⇒ `utilidad_usd: 535.35`.
- **APLICADA (24-sep-2026, API 0.0.34; DRYRUN_OK C1–C10 con escrituras reales; `get_advisors`: INFO de RLS sin policies + WARN de RPC de los 2 triggers SECURITY DEFINER, cerrado con `revoke execute` —sección 8, probado como service_role—)** —
  `20260924000004_ingresos.sql` (invariante 29): tablas `ingreso` e
  `ingreso_bitacora` (RLS sin policies, patrón del repo), columnas
  `cobro_vuelo.ingreso_anticipo_id` y `movimiento_bancario.ingreso_id`, 3
  CHECK nuevos en tablas existentes (`cobro_vuelo_anticipo_chk`,
  `movimiento_bancario_ingreso_abono_chk`,
  `movimiento_bancario_ingreso_excluyente_chk` — validan sin backfill: en
  prod ninguna de las 697 filas tiene más de una liga), TRES triggers nuevos
  (`trg_ingreso_bitacora`, `trg_ingreso_candados`, **`trg_cobro_vuelo_anticipo`
  sobre la tabla caliente `cobro_vuelo`**, con early return para los cobros
  normales), bucket privado `ingresos` y la clasificación «Reverso de un
  cargo». NO toca ningún trigger existente. **Antes de aplicar**: correr el
  DRY-RUN de su cabecera (UNA sentencia `do $dry$ … $dry$` con el cuerpo
  pegado en B; INSERT/UPDATE/DELETE REALES de `ingreso`, `cobro_vuelo` y
  `movimiento_bancario` —incluida la comparación `::text` del trigger con un
  cobro USD contra un anticipo MXN, la liga inmutable y el trigger de suma de
  gastos de siempre (C9)— que termina en `raise exception 'DRYRUN_OK …'`).
  Cualquier `DRYRUN_FALLA` u otro error ⇒ NO aplicar. Tras aplicar:
  `get_advisors` (esperado solo el INFO de RLS sin policies), conteos
  intactos (0 filas con `ingreso_id`/`ingreso_anticipo_id`) y sondear
  `GET /v1/ingresos/resumen` (200, no 503; la sonda re-sondea en ≤ 10 min o
  reiniciar el API). El API 0.0.34 es desplegable ANTES de aplicarla (503
  claro en lo nuevo; todo lo demás byte-idéntico). Rollback: al pie del
  archivo (pierde lo registrado).
- **APLICADA (24-sep-2026, API 0.0.32; dry-run DRYRUN_OK con escrituras reales, `get_advisors` solo el INFO de RLS sin policies, `responsables_facturacion` = [Mary Cruz])** —
  `20260924000003_factura_emitida.sql` (invariante 27): tablas
  `factura_emitida` + `factura_emitida_vuelo` (RLS sin policies, patrón del
  repo), 4 columnas de SOLICITUD en `vuelo` (con CHECKs; **fuera** de la
  lista de `trg_vuelo_calendar_sync`: pedir factura NO reescribe Google),
  `configuracion_sistema.valor_json` + fila `responsables_facturacion`
  sembrada con Mary Cruz. Aditiva, sin funciones ni triggers nuevos (solo el
  `tg_set_updated_at` de la tabla nueva). **Antes de aplicar**: correr el
  DRY-RUN de su cabecera (UNA sentencia `do $dry$ … $dry$` con el cuerpo
  pegado en B; INSERT/UPDATE REALES —incluido el UPDATE de `vuelo` con las
  columnas nuevas y la verificación de que NO encola en
  `calendar_sync_cola`— que termina en `raise exception 'DRYRUN_OK …'`, así
  que todo se revierte). Cualquier `DRYRUN_FALLA` ⇒ NO aplicar. Después:
  `get_advisors`, `select clave, valor_json from configuracion_sistema where
  clave = 'responsables_facturacion'` (uuid de Mary Cruz) y sondear
  `GET /v1/facturas-emitidas/por-facturar/conteo` (200, no 503; la sonda
  re-sondea en ≤ 10 min o reiniciar el API). El API 0.0.32 es desplegable
  ANTES de aplicarla (503 claro en lo nuevo, todo lo demás igual).
- **APLICADA (24-sep-2026 vía MCP, tras el dry-run A/B/C en prod: `okA` y
  `DRYRUN_OK · C1 trigger con cobrado · C2 lista intacta · C3 cobrado encola ·
  C4 notas_internas no encola · C5 sin cambio no encola`; después, re-pintado
  de Google: 124 vuelos + 13 descansos + 2 eventos + 2 mantenimientos, cola
  drenada sin errores)** — `20260924000002_calendar_sync_cobrado.sql`
  (semáforo de 6): recrea `trg_vuelo_calendar_sync` con la lista de
  `20260917000001` + `cobrado`, para que el cobro que liquida el vuelo
  re-pinte su evento de Google en azul. No crea tablas ni escribe filas.
- **APLICADA (24-sep-2026 vía MCP, tras el dry-run de 6 pasos en prod:
  `DRYRUN_OK · cola 0, vuelos 301, con estatus 1`)** — `20260924000001_vuelo_factura_folio.sql`: FOLIO y UUID
  fiscal de la factura del servicio (`vuelo.factura_folio` text 1–40 con
  CHECK sin espacios en los extremos, `vuelo.factura_uuid` text con CHECK
  de formato en mayúsculas). **Aditiva, sin triggers, sin backfill.**
  Correr ANTES el dry-run de 6 pasos de su cabecera (UPDATEs reales en
  `begin … rollback`; comprueba CHECKs, `updated_at` y que NO encola nada
  en `calendar_sync_cola`) y después `get_advisors`. El API 0.0.29 ya es
  desplegable sin ella (sonda `columnaOpcional` de `vuelo.factura_folio`:
  se enciende sola en ≤ 10 min al aplicarla).
- **APLICADA (23-sep-2026 vía MCP, tras correr el dry-run de 7 pasos de la
  cabecera en prod: `DRYRUN_OK · cola 0, vuelos 294, recibidas 0`; después
  columnas, CHECK, índice y `pdf_url` verificados, backfill 0 filas,
  `get_advisors` sin hallazgos nuevos)** — `20260923000001_vuelo_factura_cliente.sql`: factura del
  SERVICIO por vuelo (`vuelo.factura_estatus` con CHECK de tres valores +
  `factura_archivo_path/_nombre/_subida_at/_subida_por`), backfill
  `FACTURADO` donde `facturado = true` (**0 filas en prod**: hay 294 vuelos,
  ninguno timbrado) e índice parcial; y `factura_recibida.pdf_url` para el
  PDF de la factura del gasto. **Aditiva, sin triggers nuevos.** El API ya
  está desplegable así: mientras no exista, LEER sigue respondiendo lo de
  hoy (`factura_cliente` derivado de `vuelo.facturado` — fuente única
  `flights/factura-cliente.util.ts`) y ESCRIBIR responde 409
  `FACTURA_CLIENTE_NO_DISPONIBLE` / `PDF_FACTURA_NO_DISPONIBLE` con la
  migración que falta; las sondas (`columnaOpcional`) lo encienden solo en
  ≤ 10 min al aplicarla, sin redeploy. El DRY-RUN prueba con UPDATEs REALES
  que el CHECK acepta los tres estados, que `updated_at` se mueve y —clave—
  que cambiar el estatus **NO encola nada en `calendar_sync_cola`**
  (`factura_estatus` no está en la lista `after update of …` de
  `trg_vuelo_calendar_sync`: si algún día se agrega, cada cambio
  administrativo reescribiría el evento de Google del vuelo).
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
- **APLICADA (verificada en prod el 22-sep-2026 vía MCP: `usuario.apodo`
  existe)** — `20260917000001_usuario_apodo.sql`. La descripción de abajo se
  conserva como registro de lo que hizo. Aditiva en datos
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
- **APLICADA (21-sep-2026, verificada en prod el 22-sep vía MCP: existen la
  tabla y la función; primer uso real el 21-sep: baja de la ENTRADA de prueba
  «Aceite 15w 50»)** — `20260921000001_inventario_movimiento_eliminado.sql`
  (baja de movimientos de cardex con justificación). La descripción de abajo
  se conserva como registro de lo que hizo. Aditiva en datos —tabla nueva
  `inventario_movimiento_eliminado` + función
  `inventario_eliminar_movimiento(uuid, uuid, text, uuid)`— pero la función
  **BORRA filas y dispara `trg_gasto_bitacora`**, así que va en seco primero:
  el guion completo (savepoints por candado + camino feliz + conteos
  antes/después + la fila de auditoría, todo dentro de `begin … rollback`)
  está en la CABECERA del archivo. `tipo` es ENUM
  (`tipo_movimiento_inventario`) y `categoria`/`medio_pago`/`moneda` del
  gasto también: **todo se compara `::text`**. El API 0.0.18 corre CON o SIN
  la migración: la vista previa y el historial funcionan igual (el historial
  devuelve `[]`) y la baja responde **503 `MIGRACION_PENDIENTE`** hasta que
  la función exista — nunca un borrado a medias. Tras aplicar: `get_advisors`
  (la tabla queda con RLS y sin políticas, solo service key).
- **APLICADA (verificada en prod el 22-sep-2026 vía MCP)**:
  `20260922000001_horas_pactadas_ocho_decimales.sql`. `tiempo_cobrable_hr` es
  `numeric(14,8)` en `vuelo` y en `cotizacion_version_history`, y el backfill
  corrió con el resultado EXACTO que predecía su cabecera: los 12 vuelos
  corregidos (columna y snapshot juntos — #188 y #222 en 1.15384615, #302 y
  #254/#255/#301 en 2.33333333, #309 en 3.29696970, #313 en 3.20949231…) y
  **#322 intacto en 2.3333** (su subtotal ya estaba dañado y el WHERE no lo
  selecciona). Pendiente de negocio, no de BD: **re-guardar #322 desde el
  panel** para que el motor lo devuelva a $1,400.00 / $1,624.00. La
  descripción de abajo se conserva como registro de lo que hizo.
- (histórico) `20260922000001_horas_pactadas_ocho_decimales.sql` (invariante 22:
  `tiempo_cobrable_hr` a `numeric(14,8)` en `vuelo` y
  `cotizacion_version_history` + backfill de 12 vuelos). NO crea triggers,
  pero ESCRIBE en `vuelo`, así que el guion en seco va en la CABECERA del
  archivo: conteos antes/después (84 pactados · 12 descuadrados, verificados
  en prod el 22-sep), la lista esperada («SE CORRIGE» en los 12) y un UPDATE
  REAL de una fila con su rollback que devuelve `columna_admite_8`,
  `snapshot_coincide` y `updated_at_intacto` — las tres en `t`. **El `ALTER`
  va DENTRO de ese `begin`** (corrección de la revisión adversaria 22-sep):
  sin él la columna sigue en `numeric(10,4)`, el UPDATE de prueba se guarda
  como 2.3333 y el ensayo "demuestra" lo contrario de lo que se quiere
  probar. El backfill apaga `trg_vuelo_set_updated_at`
  (el CAS de las ediciones offline lo lee) y no encola nada a Google Calendar
  (`trg_vuelo_calendar_sync` no vigila esta columna ni el snapshot). El API
  0.0.19 corre CON o SIN la migración: sin ella el motor ya multiplica y
  snapshotea con 8 decimales (el snapshot es `jsonb`, no tiene precisión) y
  solo la COLUMNA sigue recortando a 4 — `horasPactadasPersistidas` lee el más
  preciso de los dos, así que el total tampoco se mueve. Tras aplicar:
  `get_advisors` y re-guardar #322 desde el panel.
- **APLICADA (22-sep-2026, verificada en prod vía MCP: `tarifa_hora_usd` es
  `numeric(14,6)`)** — `20260922000002_tarifa_hora_seis_decimales.sql`. La
  descripción de abajo se conserva como registro de lo que hizo. (Invariante 23:
  `tarifa_hora_usd` a `numeric(14,6)` en `vuelo` y
  `cotizacion_version_history` + backfill de **1 vuelo**, #105). NO crea
  triggers ni toca los catálogos de tarifa, pero ESCRIBE en `vuelo`, así que
  el guion en seco va en la CABECERA del archivo: conteos antes/después (223
  con tarifa · 12 descuadrados, verificados en prod el 22-sep), el veredicto
  esperado de los 12 (1 «SE CORRIGE» + 11 «HORAS DE LA REGLA») y un ensayo
  que corre **el CUERPO REAL de la migración** —las secciones 1) y 2) tal
  cual, `do $$` incluido— dentro de `begin … rollback` con foto de TODA la
  tabla antes y después: `filas_cambiadas` = 1 más `columna_admite_6`,
  `snapshot_coincide`, `reproduce_subtotal`, `dinero_intacto` y
  `updated_at_intacto`, las cinco en `t`, y la lista nominal de los 12
  (solo #105 se mueve). Se corre el bloque REAL y no un UPDATE a mano
  (corrección de la revisión adversaria 22-sep): el backfill es `plpgsql` y
  un error de tipo dentro de un `do $$` es INVISIBLE para cualquier `select`
  —la forma exacta del incidente del ENUM `moneda` del 15-sep—, así que un
  ensayo que reescribe una fila a mano prueba la COLUMNA, no el BACKFILL.
  **Los `ALTER` van DENTRO de ese `begin`** (sin ellos la columna sigue en
  `numeric(10,2)`, el UPDATE de prueba se guardaría otra vez como 989.58 y
  el ensayo demostraría lo contrario de lo que se quiere probar). El backfill apaga
  `trg_vuelo_set_updated_at` (lo lee el CAS de las ediciones offline) y no
  encola nada a Google Calendar (`trg_vuelo_calendar_sync` no vigila esta
  columna ni el snapshot); `cotizacion_version_history` no tiene triggers y
  sus filas NO se reescriben (son el acta de cada día). El API 0.0.20 corre
  CON o SIN la migración: sin ella el motor ya multiplica y snapshotea con 6
  decimales (el snapshot es `jsonb`, no tiene precisión) y solo la COLUMNA
  sigue recortando a 2 — `tarifaPersistida` lee la más precisa de las dos,
  así que el total tampoco se mueve. Tras aplicar: `get_advisors`.
- **APLICADA (22-sep-2026 vía MCP, tras correr el dry-run de la cabecera en
  prod: `DRYRUN_OK · movimientos 81 → 82, gastos 800 → 807, suma 21.25 USD ·
todo se revierte`; después del apply: 10 CHECK —los 8 de siempre + los 2
  nuevos—, `uq_gasto_inventario_movimiento` fuera,
  `idx_gasto_inventario_movimiento` puesto, 81 movimientos y 800 gastos
  intactos, `get_advisors` sin hallazgos nuevos)** —
  `20260922000003_inventario_salida_flota_sin_avion.sql` (invariante 8: la
  SALIDA «para todas las matrículas» deja de exigir avión **y la liga
  gasto→movimiento deja de ser única**). **SON DOS CANDADOS Y HAY QUE QUITAR
  LOS DOS** (revisión adversaria 22-sep-2026, con INSERT REAL revertido en
  prod): quitar solo el primero cambia el 23514 por un 23505.
  (A) Cambia UN CHECK sin nombre —el de `20260515000004`, que Postgres
  bautizó `inventario_movimiento_check` y que se busca por su **DEFINICIÓN**
  en `pg_constraint` (`aeronave_id IS NOT NULL`), patrón de
  `20260914000002`; de los 9 CHECK de la tabla coincide EXACTAMENTE 1, los de
  cantidad/costos/moneda/TC/venta se quedan— por DOS con nombre:
  `inventario_movimiento_salida_destino_chk` (`tipo <> 'SALIDA' or
aeronave_id is not null or para_flota`) y
  `inventario_movimiento_para_flota_chk` (`not para_flota or (tipo =
'SALIDA' and aeronave_id is null)`).
  (B) Cambia el índice ÚNICO `uq_gasto_inventario_movimiento`
  (`20260703000001`) por uno NORMAL con el mismo predicado parcial
  (`idx_gasto_inventario_movimiento`): la salida de flota crea N gastos con
  el MISMO `inventario_movimiento_id` y el segundo renglón del lote moría con
  «duplicate key value violates unique constraint
  "uq_gasto_inventario_movimiento"». El índice se conserva (no se borra a
  secas) porque TODAS las lecturas de la liga van por esa columna
  (`gastoIdPorMovimiento`, `gastosDeMovimiento`, el replay idempotente,
  `llenarCostoVentaRefacciones`, `inventario_eliminar_movimiento`).
  **Sin triggers nuevos y sin backfill**: las 81 filas de hoy ya cumplen las
  dos condiciones (toda SALIDA tiene avión, 0 con `para_flota`) y no hay
  movimiento con más de un gasto ligado, así que los `add constraint` validan
  y el índice nuevo se construye sin conflicto. Aun así va en seco primero,
  porque el camino que desbloquea ESCRIBE dinero: el guion de la CABECERA
  corre dentro de `begin … rollback` **con los `ALTER` DENTRO** (fuera de
  ellos probaría el CHECK viejo y demostraría lo contrario) y es CONCLUYENTE
  — (1) INSERT REAL de la salida de flota que DEBE reventar con 23514 _antes_
  del ALTER (el bug del cliente, reproducido), (2) el cuerpo real de la
  migración parte 1 + aserción de que quedaron los dos checks Y de que no se
  llevó ningún otro, (3) tres negativos (SALIDA sin destino, SALIDA con avión
  Y flota, ENTRADA con `para_flota`), (4) INSERT REAL de la salida, que ya
  entra, (5) los 7 gastos que DEBEN reventar con 23505 mientras el índice
  único siga puesto (el segundo candado, invisible para cualquier `select`),
  (6) el cuerpo real parte 2 (swap del índice), (7) los 7 gastos
  prorrateados **tal como los arma `crearGastosDeSalidaFlota`** (origen
  SISTEMA, REFACCION, BODEGA, SIN_COMPROBANTE, `capturado_en`,
  `inventario_movimiento_id`, montos 1/7 con el residuo en el primero) para
  que disparen TODOS los triggers de `gasto` —bitácora, personal_dueno,
  sync_facturacion, updated_at: un error de trigger es INVISIBLE para
  cualquier `select`, forma exacta del incidente del ENUM `moneda` del
  15-sep—, con aserciones de +1 movimiento, +N gastos, Σ = total AL CENTAVO
  y una fila de bitácora por gasto, y (8) cierre con `raise exception
'DRYRUN_OK …'` que revierte + los conteos de control tras el `rollback`
  (81 movimientos · 799 gastos · 481 bitácora · 0 con `para_flota` · 9
  CHECK · índice único aún presente, verificados en prod el 22-sep).
  **El guion ya se corrió en prod** (22-sep, como una sola sentencia
  autoabortada, equivalente al `begin … rollback`): `ok1 · ok2(10) · ok3a ·
ok3b · ok3c · ok4 · ok5 · ok6 · ok7 · DRYRUN_OK`, con
  `primero=36.42 base=36.43 suma=255.00`, `movs 81→82`, `gastos 799→806`,
  `bitacora 481→488`, y los conteos post-rollback idénticos a los de antes.
  `tipo` es ENUM (`tipo_movimiento_inventario`): en el CHECK y en
  los INSERT del guion el literal es SQL (se resuelve solo, como el CHECK
  original); en plpgsql sería `::text`. El API 0.0.22 corre CON o SIN la
  migración: sin ella la salida de flota responde **503
  `MIGRACION_PENDIENTE`** («captura la salida por avión») en vez del 500
  genérico de antes —tanto por el 23514 del movimiento como por el 23505 de
  los gastos, y en ese caso el movimiento se revierte: no queda nada
  escrito—, y cualquier otro 23514 del insert es un **400
  `MOVIMIENTO_INVALIDO`** con el nombre del constraint en `details`. Tras
  aplicar: `get_advisors` y repetir la captura del cliente desde el panel
  (SALIDA de 12 con «Para todas las matrículas» ⇒ 200 + 7 gastos
  REFACCION/BODEGA que suman el total al centavo: 36.42 + 6 × 36.43 =
  255.00 USD).
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
  decide el CLIENTE: hoy no se tocan. **Las colisiones de color en Google
  están CERRADAS**: semáforo de 5 el 22-sep-2026 y de 6 el 24-sep-2026 (6
  hex → 6 colorId distintos, ver el bullet del espejo). Lo pendiente es
  operativo: después de cada cambio de color, correr
  `POST /v1/calendar/resync` (o esperar al reconcile de las 00:15).
- **Ingresos (24-sep-2026, invariante 29) — decisiones del cliente
  pendientes** (v1 hace lo indicado entre paréntesis): ingresos sin vuelo en
  el reparto a socios (fuera); ingreso con avión (solo referencia); reembolso
  de proveedor ligado a un gasto (ingreso de VuelaTour); venta de activos
  (resultado; la salida de bodega aparte); efectivo recibido y caja chica
  (no entra al fondo); devolución o retención de un anticipo sin vuelo
  (reclasificar / aplicar a un cancelado); avisos de pre-cierre para
  anticipos con saldo e ingresos sin conciliar (no se agregan); reversos
  (solo se clasifica el abono); depósito BillPocket agrupado 1 ↔ N (no);
  roles (COORDINADOR registra y aplica pero no concilia ni desaplica);
  préstamos con saldo de deuda (no); **auto-cruce de la cuenta Paywise con
  cobros por TRANSFERENCIA** (no: se ven como «1 con el monto exacto» y se
  ligan a mano o con la IA — caso #235); CFDI de anticipo (fuera); vuelo en
  un ingreso solo para reembolsos recibidos; líneas duplicadas del banco
  (se avisan, no se borran).
- **Hueco PREEXISTENTE (anotado el 24-sep-2026, no se tocó)**:
  `ConciliacionService.cargarCobrosPorMetodo` pide `.limit(2000)` a
  `cobro_vuelo` y PostgREST corta en 1000 sin avisar: con más de 1,000
  cobros bancarios en la ventana, «cobros sin banco», la auditoría Paywise
  y el pre-cierre verían una foto recortada (hoy hay 225 cobros en total).
  Lo nuevo de ingresos ya pagina.
- **Hueco PREEXISTENTE (anotado en la revisión adversaria del 24-sep-2026,
  no se tocó para cobros normales)**: `FlightsService.updateCobro` recalcula
  `comision_banco_monto` desde `comision_banco_pct` (4 decimales) siempre
  que el PATCH trae `monto`, aunque sea el MISMO: en montos grandes mueve
  centavos (98,765.43 con comisión 8,747.21 ⇒ 8,747.26). Para cobros de
  ANTICIPO ya se congela; para los normales es decisión aparte.
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
