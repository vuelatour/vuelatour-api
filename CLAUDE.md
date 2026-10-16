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
   local para evitar dependencia circular; desde el 0.0.37 la misma lectura
   alimenta el aviso de saldo/sobrecobro de la edición con cobros). Un cobro MXN sin TC toma
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
TRANSFERENCIA, PAYWISE, DOMICILIADO)` + moneda de la cuenta (PAYWISE es
   bancario desde el 2-sep-2026; DOMICILIADO = «Pago domiciliado», cargo
   automático a la cuenta, bancario y solo oficina desde el 13-oct-2026,
   invariante 64; caja chica sigue mirando SOLO EFECTIVO). `BODEGA` (cargo
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
   **DESDE EL 0.0.52 (2-oct-2026) la liga cargo ↔ gasto vive en la PUENTE
   `movimiento_bancario_gasto` y vale en los DOS sentidos (1 gasto ↔ N
   cargos y 1 cargo ↔ N gastos): ver invariante 40.** Lo de abajo sigue
   siendo la regla POR GASTO; donde dice «|monto| del cargo» léase
   `monto_parte` de la puente, el trigger `tg_mov_bancario_gasto_suma` pasó
   a ser solo el candado de monto/cuenta de un cargo con partes, y
   `conciliado`/`tc_gasto` los escribe SOLO la BD
   (`recalcular_gasto_conciliado`) — el `recalcularGasto` TS queda para el
   camino directo SIN la migración.
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
     ±`MATCH_DAYS` — **desde el 2-oct-2026 un candidato EXACTO (desfase
     0.00) descarta a los de ±0.01, y si SOLO hay de ±0.01 queda AMBIGUO**
     (`separarPorDesfase` + `textoSoloCentavo`, en `elegirCandidato`,
     `elegirMovimiento` y por tanto en `autoMatchCargo`, la lista
     «se puede cruzar» e `intentarCruzarGasto`; el FALTANTE compara con
     `monto_cruce`). Caso REAL: el SPEI de SAESA de $2,231.38 se ligó solo al
     gasto #318 de $2,231.37 y el EXACTO #321 se capturó 15 min después —
     un centavo de diferencia ya no se liga sin un humano → si hay ≥2
     candidatos, **terminación de tarjeta**
     (últimos 4 dígitos de `referencia` SOLO si la referencia tiene ≥8
     dígitos y esos 4 son una terminación real de
     `tarjeta_corporativa`: la referencia de 6 dígitos '174465' no inventa
     tarjeta) → **descripción** del banco contra `lugar` / primera línea de
     `notas` / proveedor (sinónimos del giro + **veto por ciudad**; exige ≥2
     tokens comunes y margen sobre el segundo) → si nada desempata,
     **AMBIGUO** y se queda pendiente con su motivo. Después del monto se
     prueba el **FALTANTE** de un gasto con pagos parciales y, en cuenta MXN,
     la compra USD por TC implícito (15-25). Desde el 0.0.75 exige además
     el T.C. oficial del día del cargo a ±2 %, leyenda que coincide y
     recíproco (invariante 70); el camino inverso NO cruza USD contra
     cuentas MXN.
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
   - **Devoluciones de cargos** («CARGO INDEBIDO 21 SEP …», «DEVOLUCION»,
     «REV …»; 30-sep-2026): el re-cruce y la importación, DESPUÉS del cruce
     contra gastos/cobros, emparejan cada devolución con su cargo pendiente
     (criterio `REVERSO`, `reversos`/`reversos_emparejados`): invariante 33.
   - **Dedupe de re-importación: la REFERENCIA NUNCA veta un duplicado
     (29-sep-2026, API 0.0.42; incidente «se me están duplicando los
     gastos»).** Hasta el 0.0.41 «la referencia manda cuando existe de los dos
     lados» y dos cargos iguales con referencias distintas eran dos
     movimientos. Pero la referencia que la IA transcribe del PDF NO es
     estable entre lecturas: el MISMO cargo del 7-sep (AEROPUERTO DE COZUMEL
     $125.82) llegó como «0025830577» (8-sep, número de TARJETA, que se repite
     en todos los cargos de esa tarjeta), «00000000000000000001» (22-sep,
     consecutivo del archivo) y «00000000000000000001 AUT. 456529» (29-sep), y
     la descripción variaba por truncado («ZOMAY HOLBOX» / «HOLBO», «ASA
     CANCUN» / «ASA CANCUN\CARR CANCUN»). Cada re-subida insertó otra vez lo
     que ya estaba: en prod GASTOS GNRAL tenía 396 filas de septiembre para
     ~200 movimientos y COMBUSTIBLE 99 para 75. Fuente única
     `emparejarDuplicados` (+ `descDedupe`, `nivelDescripcionDedupe`,
     `mismaDescripcionDedupe`, `leyendasNombranDistinto`,
     `descripcionesSeContradicen`, PURAS en `auto-cruce.util.ts`); la usa
     SOLO `ejecutarImport` (camino de `importar` e `importarAsync`); el
     re-cruce (`autoMatchPendientes`) no inserta ni deduplica.
     - **Bucket** (fecha | tipo | monto a centavos) y, dentro, niveles de
       empate de más a menos fuerte (`nivelEmpateDedupe`): (0) referencia
       igual **y** leyenda tolerante igual; (1) leyenda normalizada IGUAL;
       (2) leyenda TRUNCADA (prefijo); (3) mismo INICIO (12 caracteres);
       (4) referencia igual con leyendas que NO se contradicen (la IA redactó
       distinto: «AEROPUERTO DE COZUMEL» / «Aeropuerto Cozumel (TUA)»). En
       (1)–(3) la referencia no cuenta. Sola es la señal MÁS débil: los 7
       abonos «CARGO INDEBIDO 21 SEP 355xx» del 23-sep traen la MISMA
       referencia.
     - **EMPAREJAMIENTO MÁXIMO por niveles** (Kuhn, revisión adversaria
       29-sep): se abre un nivel a la vez y una línea ya emparejada puede
       ceder su fila previa y moverse a otra con la que también empata. Con
       «el primero que encuentre», «ASA CANCUN I\CARR CANC» (empata por
       prefijo con las DOS filas «ASA CANCUN» y «ASA CANCUN I») le robaba la fila a «ASA
       CANCUN\CARR CANCUN» y la carga se insertaba otra vez; y un «mismo
       inicio» le ganaba a un prefijo según el orden del archivo. Ahora el
       conteo de duplicados = emparejamiento máximo, NO depende del orden
       (en la revisión se cotejó contra fuerza bruta en 3,000 casos
       aleatorios), y una pareja fuerte gana siempre a una floja.
     - **Leyenda tolerante** (`mismaDescripcionDedupe`, normalizada con
       `normalizarTextoBanco`: sin acentos, mayúsculas, signos, espacios
       dobles ni prefijos de agregador): iguales, o una es PREFIJO de la otra
       con el lado corto ≥ `DEDUPE_PREFIJO_MIN` (8), o comparten los primeros
       `DEDUPE_INICIO_COMUN` (12) caracteres — SALVO que
       `leyendasNombranDistinto`: plazas distintas («AEROPUERTO DE CANCUN» /
       «AEROPUERTO DE COZUMEL» comparten 12 caracteres) o números sueltos
       (≥ 3 dígitos) distintos («CARGO INDEBIDO 21 SEP 35554» / «35552»,
       «AUTOZONE 7226» / «7227»); un número truncado («355» / «35554») no
       cuenta. Umbral del prefijo = 8: una marca sola («ASUR», «UBER»,
       «OXXO») nunca es prefijo de nada; «OXXO CISNE» (10) ya trae sucursal.
       **Se contradicen** (`descripcionesSeContradicen`) cuando nombran
       plazas/números distintos o las dos traen texto y no comparten NINGÚN
       token con significado (UBER vs OXXO): así la tarjeta repetida no junta
       comercios distintos (ni «ASUR CANCUN» con «ASUR MERIDA»).
     - **MULTICONJUNTO intacto**: cada fila previa se usa UNA vez; dos cargos
       legítimos iguales del mismo día entran si el archivo trae dos y la base
       uno, y las líneas del MISMO archivo nunca se deduplican entre sí (los
       dos DIDI de $101 del 8-sep, los 2 Cozumel reales). Por eso la
       tolerancia es segura cuando las dos lecturas traen el día COMPLETO:
       solo decide QUÉ línea es la repetida, nunca cuántas entran.
       **Límite conocido (día partido)**: si un estado de cuenta empieza a
       mitad de un día (en prod 83dda1f9 trae 14 de las 29 líneas del 7-sep)
       y trae una línea REALMENTE nueva con el mismo monto que una fila previa
       compatible que el archivo NO repite, se toma por duplicada. Con
       referencias de IA inestables no hay forma de distinguirlas; el panel
       muestra `duplicados_omitidos`.
     - **Verificado contra prod (29-sep, solo lectura)**: re-jugando las 13
       importaciones reales en orden, la regla nueva deja 713 de 927 filas
       (GASTOS sep 396 → 207, COMBUSTIBLE sep 99 → 75, julio 190 → 189 por el
       «OXXO Cisne» del 16-jul leído en las dos importaciones que lo
       traslapan; agosto y Paywise intactos), ninguna de las 214 filas que
       marca como duplicado está conciliada con gasto, cobro ni ingreso (9 lo
       están por clasificación de traspaso) y no queda ningún par (fecha,
       tipo, monto) entre importaciones distintas. Las filas YA duplicadas NO
       las borra este cambio: solo evita las nuevas.
     - Specs (`auto-cruce.util.spec.ts`) con las lecturas REALES: Cozumel 5
       filas ⇒ 2, ZOMAY 3 ⇒ 1, traspaso 3 ⇒ 1, ASA CANCUN con « REF. … AUT. …»,
       tarjeta repetida, UBER/OXXO, los 7 «CARGO INDEBIDO» y el 8.º real, DIDI
       y la pareja exacta que gana a la tolerante; 8 de ellos FALLAN con la
       regla del 0.0.41. Revisión adversaria: ASA CANCUN / ASA CANCUN I en
       cualquier orden, prefijo gana a mismo inicio, plazas distintas (por 12
       caracteres y por la misma tarjeta), números distintos, «ASUR» sola y
       una fila previa usada una sola vez; 8 FALLAN con la primera versión
       del 0.0.42.
     - **Espejo SQL**: la limpieza `20260929000001_limpieza_duplicados_…`
       agrupa con el MISMO predicado (`mismaDescripcionDedupe`); si cambia
       aquí (p. ej. el veto de plazas/números), cambia allá.
     **Desde el 0.0.75 (invariante 69)** los previos se leen PAGINADOS por
     la PK (`leerPreviosDedupe`; el `.limit(20000)` de antes NO bastaba:
     PostgREST corta en max-rows = 1000 sin avisar; con más de 20,000 ⇒ 400
     «impórtalo por partes») y en un orden determinista
     (`ordenarPreviosParaDedupe`), y `emparejarDuplicados` devuelve además
     `parejas` (qué línea es qué fila) con el MISMO predicado: alimentan el
     concepto del SPEI al re-subir.
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
       comentario del código ya lo decía; el código no lo hacía. Desde el
       0.0.75 exige además el T.C. oficial del día del cargo a ±2 %,
       leyenda que coincide y recíproco (invariante 70); el camino inverso
       NO cruza USD contra cuentas MXN.
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
   `BODEGA` (precio de venta o, sin él, el **ÚLTIMO PRECIO DE COMPRA**
   vigente el día de la salida + margen de la tienda — desde el API 0.0.36;
   en **MXN** cuando esa compra fue en pesos — moneda operativa del cliente
   —, si no USD; `tc_gasto` = T.C. OFICIAL del día de la venta, el mismo de
   las cotizaciones. Hasta el 0.0.35 era el costo FIFO con el TC ponderado
   de las capas: ver «ÚLTIMO PRECIO DE COMPRA + T.C. DEL DÍA» abajo) ligado
   por `inventario_movimiento_id`; la devolución lo revierte en la moneda
   nativa de la devolución (peso contra peso; TC solo si la moneda difiere).
   No duplicar ese costo en otro lado. Caso aceites 28-ago-2026: una entrada
   en pesos capturada como USD multiplicó ×17 el costo del avión.

   **JAMÁS UN USD SUMADO COMO MXN EN EL VALORIZADO (22-sep-2026).** Fuente
   única `inventario-cardex.util.ts#statsDe` (desde el API 0.0.36; antes
   `statsFromLayers`, que se ELIMINÓ con el FIFO): `valor_mxn` = existencia
   × último precio de compra en pesos REALES (compra en MXN, o USD al T.C.
   oficial de HOY); si el último precio es USD y no hay T.C. de hoy, el
   valor va en `valor_usd_sin_tc` (en DÓLARES) y `pesos_exactos` = false.
   Los dos campos no se suman entre sí NUNCA (criterio de `costoSinTc`: un
   costo de $0 vale 0 en cualquier moneda y NO cuenta como «sin TC»).
   `valor_usd` = existencia × `costo_unitario_usd` del último precio (USD
   interno). En la **hoja «inventario» del Balance general**
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
   `listItems` su `valor_total_usd_sin_tc`. `costo_fifo_mxn_actual` y
   `costo_fifo_actual` quedan DEPRECADOS (compat, nadie los pinta):
   `costo_fifo_mxn_actual = costo_vigente_mxn ?? 0` — jamás el USD en un
   campo «mxn» (antes caía al USD sin TC).

   **COSTO UNITARIO en la hoja «inventario» (13-oct-2026, API 0.0.74).**
   Pedido del cliente (decisión 6 del lote del 13-oct): ver el último
   precio de compra de cada producto en el Balance general. Cada fila de
   `resumenTiendita` lleva `costo_unitario_mxn` (= `statsDe.costo_vigente_mxn`,
   el MISMO número que `precio_vigente.unitario_mxn_hoy` de la ficha del
   panel: compra en MXN tal cual o USD × T.C. oficial de hoy) y
   `costo_unitario_usd` (SOLO si el último precio es USD y no hay T.C. de
   hoy —el caso `sin_tc`—, en dólares sin convertir); nunca los dos a la
   vez; null sin compra con costo (`fijaPrecio`). ADITIVOS en los dos
   sentidos: pyservices pinta «COSTO UNITARIO MXN» y «COSTO UNITARIO USD
   (sin T.C.)» entre EXISTENCIA ACTUAL y VALOR A COSTO MXN solo si alguna
   fila trae valor (payload viejo ⇒ hoja idéntica; pyservices viejo ⇒ los
   ignora). No es un importe: TOTALES no lo suma y existencia × unitario
   redondeado puede diferir centavos del VALOR A COSTO
   (`round2(round2(q×u)×tc)`: aceite 84 × 375.55 = 31,546.20 vs 31,546.13);
   la nota de la hoja lo dice — NO «corregirlo» tocando `statsDe` (movería
   el valorizado del panel, el export y el bloque VUELATOUR) ni poniendo el
   VALOR como fórmula. `StatsInventario`/`statsDe` NO se ampliaron (su
   spread `{ ...item, ...stats }` llega al panel). Prueba:
   `npx jest src/modules/inventory/inventory.service.tiendita.spec.ts`
   (describe «COSTO UNITARIO»); en pyservices
   `tests/test_balance_inventario_xlsx.py` (sección «COSTO UNITARIO»).

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
     contrario) y el NUMÉRICO de
     `src/modules/inventory/eliminar-movimiento.util.ts#evaluarEliminacion`
     (helper PURO con spec sobre el caso real del 29-ago):
     `STOCK_NEGATIVO`. **Solo se elimina si en NINGÚN punto de la
     cronología la existencia queda negativa.** El mensaje dice SIEMPRE qué
     eliminar primero (se borra de lo más nuevo a lo más viejo).
     **`CAMBIA_COSTO_FIFO` ya NO se emite desde el API 0.0.36**: el costo de
     cada salida está GUARDADO en su fila (último precio de compra vigente
     el día de la salida) y ninguna baja lo mueve. El código se conserva en
     `CODIGOS_BLOQUEO_ELIMINACION` (un API previo aún podría mandarlo) y
     `salidas_afectadas` viaja siempre `[]`. La vista previa gana
     `precio_vigente_antes/despues` + `cambia_precio_vigente` y el `detalle`
     lo dice («El último precio de compra pasa de $30.00 USD (5 sep 2026) a
     $21.00 USD (10 ago 2026)…») y cuántas salidas se cobraron con el
     precio de esa compra (conservan su cargo). Historia (≤ 0.0.35): el
     candado comparaba el costo FIFO de las demás salidas EN LAS DOS
     MONEDAS porque 66 de 75 movimientos eran USD sin TC y «null vs null» se
     leía como «no cambió».
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
   (desde el API 0.0.36, el ÚLTIMO PRECIO DE COMPRA; en 0.0.35, el costo
   FIFO), configurable** (`configuracion_sistema.inventario_margen_venta_pct`,
   25 por default, `PATCH /v1/config/inventario_margen_venta_pct` 0–100 o
   **400 `VALOR_FUERA_DE_RANGO`**). Toda SALIDA a un avión (también «para toda
   la flota», prorrateada con el residuo en el primero) **sin precio** se
   cobra a `último precio × (1 + margen)`, en la MISMA moneda de esa compra.
   Precedencia intacta: precio capturado > 0 → `precio_venta` del ítem →
   costo + margen → a costo; **el 0 explícito sigue siendo «a costo»** (sin
   utilidad). Utilidad = venta − costo de la salida (el de su fila).
   - **Fuente ÚNICA** en `inventario-cardex.util.ts`: `margenVentaValido`
     (config rota ⇒ 25), `ventaUnitariaConMargen` (round 4),
     `precioVentaDeSalida` (la precedencia, con `origen` PRECIO_CAPTURADO |
     PRECIO_PRODUCTO | MARGEN | A_COSTO), **`montoGastoDeSalida` (se MOVIÓ
     aquí desde el pie de `inventory.service.ts`, mismo cuerpo)** y
     **`ventaDeSalida(mov)`** (desde 0.0.36 recibe SOLO la fila: el costo es
     el guardado): la utilidad de UNA salida — en PESOS con venta y costo al
     T.C. del día de la venta (el de la fila); RESPALDO de filas sin T.C.
     (legado): dólares cuando la venta es USD (venta USD − costo USD
     interno); venta en PESOS sobre costo USD sin T.C. ⇒ `utilidadIncompleta`
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
     `(último precio + 25 %)` | `(a costo)` (hasta 0.0.35: `(costo FIFO + 25
     %)` | `(costo FIFO)`; fuente única `etiquetaCargoDeSalida`). El panel VIEJO manda
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
     nunca 500—), `PUT ubicaciones/orden` y `DELETE ubicaciones/:id` (desde
     el 0.0.38, bullet siguiente), `POST items/mover-ubicacion` (UN update;
     200 `{movidos, sin_cambio, no_encontrados, inactivos, ubicacion}`) y el
     filtro `GET items?ubicacion=<id>|sin`. El Excel pinta «Bodega Cancún
     (anterior)».
   - **ELIMINAR Y REORDENAR (28-sep-2026, API 0.0.38, SIN migración; pedido
     del cliente con la captura del selector del producto: «una forma rápida
     y ágil para poder editar, borrar o agregar opciones a este listado de
     lugares»).** Helpers PUROS en `inventario-ubicacion.util.ts` (spec).
     - `DELETE ubicaciones/:id` (ADMIN/MECANICO) borra DE VERDAD solo si
       NINGÚN producto la usa, **activo o dado de baja** (lo mismo que mira la
       FK `on delete restrict`; conteo paginado `usoDeUbicacion`). Si la usan
       ⇒ **409 `UBICACION_EN_USO`** con `details { productos,
       productos_activos }` y `mensajeNoEliminable`: solo activos ⇒ «X» tiene
       N productos: muévelos con «Mover a…» y vuelve a intentar»; solo dados
       de baja ⇒ «…la usan N productos dados de baja (historial): no se puede
       eliminar; desactívala…» (el panel NO mueve dados de baja: mandarlo a
       «Mover a…» sería mandarlo a otro 409); mezcla ⇒ las dos cosas. La FK
       es el candado final: el **23001** (o 23503) de una carrera —alguien
       movió un producto ahí entre la lectura y el DELETE— también es 409
       `UBICACION_EN_USO` (re-cuenta), nunca 500. 200 `{ deleted: true, id,
       nombre }`; 404 `UBICACION_NO_EXISTE` (también si otra persona la borró
       entre la lectura y el DELETE). Verificado en prod (28-sep, solo
       SELECT): la ÚNICA FK hacia `inventario_ubicacion` es
       `inventario_item_ubicacion_id_fkey` (`confdeltype = r`) y el catálogo
       NO tiene triggers de DELETE ⇒ borrar una sin productos no toca ninguna
       otra fila. El COMMENT de la tabla aún dice «Sin DELETE en el API»
       (cosmético, sería DDL: no se tocó).
     - `PUT ubicaciones/orden { ids }` (ADMIN/MECANICO; DTO
       `OrdenUbicacionesDto`: 1–999 uuids sin repetir): TODAS las ACTIVAS en su
       nuevo orden (puede incluir inactivas; las que no vengan van al final en
       su orden de hoy). `planOrdenUbicaciones` numera 1..n y solo se escriben
       las filas que cambian (sin índice único sobre `orden` ⇒ no hay choque
       intermedio; reintentar la misma lista termina un trabajo a medias).
       Lista VIEJA (falta una activa, sobra un id que ya no existe, repetido)
       ⇒ **409 `UBICACIONES_CAMBIARON`** con `details { faltan, desconocidos,
       repetidos }` SIN escribir. 200 = el catálogo completo
       (`listUbicaciones(true)`). Declarada ANTES de `ubicaciones/:id`
       (convención). Antes el panel mandaba dos PATCH por flecha.
     - **Nombre repetido**: la pre-validación sin acentos ni mayúsculas ya
       respondía 409 `UBICACION_DUPLICADA`; el **23505** del índice
       `uq_inventario_ubicacion_nombre` (`lower(nombre)`, carrera con otra
       alta o renombre) ahora relee el catálogo y responde el 409 con el
       nombre REAL de la que ganó + `details { id, nombre }`
       (`errorDeUbicacion` pasó a `async`).
     - Sin la migración 20260925000001: las dos rutas ⇒ 503
       `MIGRACION_PENDIENTE` (sonda de siempre).
     - Specs: `inventario-ubicacion.util.spec.ts` (mensajes y plan de orden),
       `inventory.service.ubicacion.spec.ts` (el PostgREST falso ganó DELETE
       con la FK restrict: borra, 409 activos / dados de baja / mezcla, 404,
       carrera 23001, orden 1..n con solo lo que cambia, lista vieja, carrera
       23505, 503) e `inventory.controller.ubicaciones.spec.ts` (HTTP real:
       rutas antes de `:id`, roles, DTO, `code` + `details` por el filtro).
   - **Tolerancia**: sonda única `columnaOpcional(inventario_item.
     ubicacion_id)`. Sin la migración todo lo de ubicación se comporta como
     0.0.34 (sin llaves nuevas; alta con «Bodega Cancún») y lo nuevo responde
     **503 `MIGRACION_PENDIENTE`**. La utilidad y el margen NO dependen de la
     migración.

   **ÚLTIMO PRECIO DE COMPRA + T.C. OFICIAL DEL DÍA (25-sep-2026, API
   0.0.36; pedido del cliente: «que los precios se ajusten en automático al
   último registrado … el remanente que teníamos de agosto ahora igual su
   costo de 30 DLS» y «En el tipo de cambio, que sea los mismos que usan en
   las cotizaciones (Tipo de cambio del día de la venta)»).** El FIFO SE
   ELIMINÓ de todo el inventario (`buildLayers`, `statsFromLayers`,
   `consumeFifo`, `ventaYGananciaDe` ya no existen). Fuente única
   `inventario-cardex.util.ts` (spec con el ejemplo del cliente y el cardex
   REAL de prod en `cardex-prod-25sep.fixture-spec.ts`):
   - **Costo vigente** (`costoVigenteEn`): el precio unitario, con su
     moneda, de la ENTRADA con costo > 0 más reciente con
     `fecha_movimiento ≤ corte` (orden `fecha, created_at, id`).
     DEVOLUCION/AJUSTE y entradas a $0 NO lo cambian. Corte `{ fecha }` =
     salida nueva / valorizado (hoy); corte `{ alRegistrar: S }` = lo que
     vio el API al escribir S (`created_at < S.created_at`): una compra
     recibida después con fecha atrasada no reescribe el pasado.
   - **El costo de una SALIDA se CONGELA en su fila** (`costo_unitario_usd`,
     `moneda`, `costo_unitario_mxn`) y TODO lector lo lee de ahí
     (`costoDeSalida`); nada lo recalcula. Semántica de la fila de una
     SALIDA en PESOS: `costo_unitario_mxn` = pesos de la compra vigente (lo
     canónico), `costo_unitario_usd` = el USD interno de ESA compra (con el
     T.C. de la compra) y `tc_usd_mxn` = T.C. oficial del día de la VENTA:
     ya NO se cumple `usd × tc ≈ mxn` en esa fila — ningún lector deriva
     pesos de `usd × tc` en una fila MXN. En una SALIDA, la columna «TC» del
     Excel del cardex significa «T.C. del día de la venta».
   - **Escritura** (`createMovimiento`): SALIDA = existencia de todo el
     cardex (textos de siempre) + costo vigente de SU fecha + T.C. oficial
     de SU fecha sellado en `tc_usd_mxn` (⇒ `tc_gasto` del cargo). Si hay
     compras con costo pero todas son POSTERIORES a la fecha de la salida ⇒
     **400 `SALIDA_ANTES_DE_LA_COMPRA`** (nada escrito; un $0 silencioso no).
     Sin ninguna compra con costo ⇒ costo $0 + `aviso:
     'SIN_COSTO_VIGENTE'`: sin precio va a costo $0 SIN gasto; con precio
     (capturado o del producto) el avión SÍ paga ese precio y toda la venta
     es utilidad — `aviso_mensaje` dice cuál de los dos (revisión adversaria
     25-sep-2026: el texto único decía «sin cargo al avión» también cuando
     sí hubo cargo) y que completar después el costo de la compra NO
     re-cobra esa salida. ENTRADA/DEVOLUCION/AJUSTE: T.C. capturado > 0
     gana; si no, el oficial de SU fecha (MXN sin ninguno ⇒ 400 «No hay T.C.
     oficial para esa fecha»; en MXN el T.C. ya es OPCIONAL). Todo T.C.
     escrito pasa por `redondearA(tc, 4)` (precisión de la columna).
     Respuesta ADITIVA: `costo_vigente`, `tc_venta`, `aviso`,
     `aviso_mensaje`, `regla_costo: 'ULTIMO_PRECIO'`.
   - **T.C.** = `TipoCambioService.oficialDetallePara(fecha)` — la MISMA
     función (y la misma ventana de 7 días / descarga) que el cotizador;
     `InventoryModule` importa `TipoCambioModule` (sin ciclo) y el servicio
     lo recibe `@Optional()` (5.º parámetro; sin él ⇒ «sin T.C.», como
     0.0.35). `tcOficialDe` (público: lo usa `compras.service`) memoiza por
     fecha 10 min, positivo y negativo, guardando la promesa. El T.C. se
     SELLA al escribir (una captura antes de las 07:05 puede llevar el de
     ayer si open.er-api no contesta; no se recalcula — igual que la
     cotización).
   - **Conversión a pesos** (`aMxn`/`aUsd`/`montosDeCompra`/`costoDeSalida`/
     `ventaDeSalida`): siempre el TOTAL nativo redondeado × T.C.
     (`round2(round2(cant × u) × tc)`, idéntico a `numeric` de Postgres en
     los 77 movimientos de prod). Compras al T.C. de SU día; venta Y costo
     de una salida al del día de la VENTA (utilidad MXN ≈ utilidad USD × T.C.
     ±1 ¢); valorizado al T.C. oficial de HOY (se mueve cada día). El USD
     ORIGINAL (`*_usd_original`) es dato secundario de una utilidad que YA
     cuenta en pesos (solo venta y costo en dólares nativos); los campos
     `ventas_usd`/`utilidad_usd` son SOLO el respaldo de filas sin T.C.
   - **«Editar costo» de una ENTRADA** (`updateCostoEntrada`): se retiró el
     candado «capa consumida»; corregir el precio cambia el valorizado y las
     SIGUIENTES salidas, jamás las ya cobradas. Si alguna salida usó (o
     habría usado) ese precio (`salidasQueDependenDe`, también las que
     salieron a $0 SIN cargo) y el DTO no trae `confirmar_salidas: true` ⇒
     **409 `ENTRADA_CON_SALIDAS`** con `details.salidas` y NADA escrito.
     USD sin T.C. en el DTO conserva el de la fila (antes lo borraba).
     Re-costear una salida mal cobrada = baja con motivo + recaptura.
     `compras.service#recibirInterno` (recosteo) ya no borra el T.C. de la
     entrada: `tc ?? tc de la fila ?? oficial del día de la compra`.
   - **Lecturas** (todo ADITIVO + `regla_costo`): lista (`costo_vigente`,
     `costo_vigente_mxn`, `tc_hoy` raíz, `*_usd_original`,
     `ventas_a_costo_mxn`, `movimientos_sin_tc`), detalle (ENTRADA
     `fija_precio`/`es_precio_vigente`/`salidas_con_este_precio`/
     `salidas_sin_cargo`; SALIDA `tc_venta`/`costo_total`/`costo_moneda`/
     `costo_total_mxn`/`venta_total_mxn`/`ganancia_usd_original`), la FICHA
     `GET items/:id/resumen` (`precio_vigente` con `siguiente_salida`,
     `tc_hoy`, `dinero_generado` — el panel lo pinta TAL CUAL, no suma),
     tienda/resumen, Excel del inventario («Último precio de compra» +
     «Moneda», «Vendido (MXN)»; las columnas USD solo si algún producto las
     trae), cardex libro (`nota`) y hoja «inventario» del Balance general
     (`tc_hoy`, `regla_costo`, `*_usd_original` por fila).
   - **Balance GENERAL, hoja «refacciones»**
     (`aircraft/refacciones-costo.util.ts`, con spec): el costo de cada
     salida se convierte con el MISMO T.C. con que la fila convierte la
     VENTA (`tc_gasto` de SU gasto, adjuntado por índice junto a
     `inventario_movimiento_id`, o el promedio del libro) — ya no con el
     `tc_usd_mxn` del movimiento. En las 13 salidas históricas da idéntico
     y la migración de T.C. no mueve la ganancia de la hoja. Diferencia
     VISIBLE aceptada: en septiembre la utilidad por ítem (bloque 1, T.C.
     del día de la venta) y el detalle de salidas (bloque 2, T.C. del gasto
     ⇒ promedio) difieren ≈ $60 MXN para las 10 salidas del 01-sep (sus
     gastos siguen con `tc_gasto` null; alinearlos sería otra migración que
     SÍ mueve la cascada — decisión de la oficina). `gasto.tc_gasto` de
     gastos existentes NO se toca; los NUEVOS nacen con el T.C. oficial del
     día de la salida.
   - **Pendientes conocidos**: la DEVOLUCIÓN revierte con el costo capturado
     en la devolución (el avión conserva el 25 % de lo devuelto); el
     `precio_venta` fijo del producto sigue ganando al margen y no sigue al
     último precio; un movimiento que se escribe sin T.C. porque no había
     dato queda «sin T.C.» (no hay cron que lo complete); la función de BD
     `inventario_eliminar_movimiento` conserva «FIFO» en su COMMENT
     (cosmético, sería DDL).

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
    los libros por avión (balance, reparto, Libro Dinero) no la cobran; vive
    en "Otros movimientos"/"otros ingresos" como ingreso + egreso apareado
    (el pago al vendedor: el GASTO REAL `COMISION_VENDEDOR` del vuelo o, sin
    él, la PROVISIÓN — invariante 31). **Desde `comisiones_al_avion_desde`
    (default 2026-09-01, invariante 50) el balance por avión y el reparto SÍ
    la DESCUENTAN** — la provisión (solo de vuelos COMPLETADOS), con la parte
    del avión de la comisión bancaria, en COMISIONES / `comisiones_venta_usd`
    — y en «otros movimientos» esa provisión CUBRE el pago al vendedor
    (desde el 0.0.66 VuelaTour solo paga lo que el pago real la EXCEDE; ya
    no hay línea de ingreso «a cargo del avión»); lo cobrado al cliente por
    ella sigue siendo ingreso de VuelaTour, UNA vez. El Libro Dinero no
    cambia. **SUPERSEDIDO el 13-oct-2026 (invariante 61, dos categorías)**:
    ya no hay PROVISIÓN en ningún libro — el balance y el reparto descuentan
    SOLO el pago capturado como «Comisión del vendedor (avión)»
    (`COMISION_VENDEDOR_AVION`) en vuelos COMPLETADOS o CANCELADOS con cobros
    retenidos, en cualquier fecha, y «otros movimientos» lo trae «a cargo del
    avión» con egreso $0.00; la «Comisión del vendedor (VuelaTour)»
    (`COMISION_VENDEDOR`) la paga siempre VuelaTour; el Libro Dinero resta
    los pagos de las dos (sin pago, nada).
    En vuelos
    MULTI-AVIÓN (tramos en aviones distintos) la venta del avión y lo que
    deriva de ella se REPARTE con `participacionPorAeronave` +
    `repartirUsd` (`src/common/participacion-aeronave.util.ts`: PARTES
    IGUALES POR TRAMO VENDIDO — nunca horas, ni cotizadas ni tacos; los
    tramos operativos/ferry no reparten; centavos por residuo mayor). La
    parte de VuelaTour y los avisos del vuelo los reporta UNA vez
    `avionQueReporta`. Los gastos NO se reparten: van al avión del tramo
    (`avionDelGasto`: escala → gasto → vuelo, y `expenses.service` sella el
    avión del tramo al capturar). **EXCEPCIÓN documentada (13-oct-2026,
    invariante 61)**: la «Comisión del vendedor (avión)» es costo de la
    VENTA, no de un tramo — se reparte entre los aviones por participación
    (`parteAvion`/`repartirUsd`, como la venta y la comisión bancaria; Σ de
    los aviones == el pago al centavo) y el avión sellado en el gasto es solo
    referencia. La comisión COTIZADA que se compara contra el pago es
    `pagoVendedorUsd` (comisión + su IVA) en todos los lectores (solo para
    comparar y avisar: desde el 13-oct-2026 ningún libro ni el reporte por
    vuelo la RESTA — invariantes 61 y 73). Ningún lector recalcula estas
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
    vuelo (la columna OTROS quedó en SOLO FBO —y desde el 13-oct-2026 FBO
    + COMISARIATO, invariante 63—; antes OTRO con vuelo caía
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
    `CATEGORIAS_GASTO_SIN_AVION` = empresa + INDIRECTO + PERSONAL_DUENO +
    COMISION_VENDEDOR (28-sep-2026, invariante 31) — sin `vuelo_id` en la
    condición; `COMISION_VENDEDOR_AVION` NO está a propósito (13-oct-2026,
    invariante 61: arma el `not.in` de PostgREST). Antes cada lector traía la lista a mano
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
    `cobroEstaConciliado` (`src/common/cobro-conciliado.util.ts`; desde el
    0.0.78, invariante 77, eso es «tiene liga» —el criterio del candado— y
    el ESTADO «Conciliado» = CUBIERTO sale de `common/cobro-banco.util.ts`).
    Quitar o reemplazar un avión NO re-parte solo: avisa (decisión del cliente
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
      cualquier estado no cancelado. **Excepción POR PERSONA desde el API
      0.0.37 (26-sep-2026)**: los usuarios de la lista
      `editores_cotizacion_cobrada` SÍ revisan con cobros — ver invariante 30.
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
true` (en `operational-legs`, con su `orden` calculado y, desde el
      0.0.46, `comercial`/`aviso` derivados de la fila — invariante 35);
      llave reutilizada
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
    COMIDA, COMISARIATO —desde el 13-oct-2026, invariante 63—, HOTEL, TAXI,
    PILOTO_EXTERNO) más PERMISO; las de
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
    vuelo, las reglas de siempre no cambian. **Excepción (28-sep-2026,
    invariante 31; las DOS categorías desde el 13-oct-2026, invariante 61):
    `COMISION_VENDEDOR` y `COMISION_VENDEDOR_AVION` exigen vuelo para TODOS
    los roles** (oficina incluida, en el alta Y en la edición: desligar el
    vuelo o reclasificar a comisión un gasto sin vuelo ⇒ el mismo 400 con la
    etiqueta de SU categoría; `categoriaExigeVueloSiempre` /
    `CATEGORIAS_GASTO_VUELO_OBLIGATORIO`).

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

    - **Columna y filtro «Banco» (9-oct-2026, API 0.0.67; pedido de
      oficina: «un apartado donde me diga si el gasto está conciliado con el
      banco»)**: tercera pregunta, aparte de las dos de arriba: «¿ya cruzó
      con el estado de cuenta?». Helper PURO `expenses/estado-banco.util.ts`
      (`estadoBancoGasto`: CONCILIADO si `gasto.conciliado` —solo lo escribe
      la BD al cubrir el gasto, también un efectivo ligado con
      justificación—; PARCIAL si `monto_vinculado` > 0 sin cubrir; SIN_CONCILIAR
      si el medio es bancario (TARJETA_CORP/TRANSFERENCIA/PAYWISE) sin cargo;
      NO_APLICA el resto) → columna «Banco» del Excel de gastos (`listXlsx`,
      vacía cuando no aplica) y espejo en el panel
      (`lib/admin/conciliacion-estado.ts`, `BancoBadge`). `GET /expenses?
      conciliado=true|false` filtra por `gasto.conciliado` (false incluye los
      parciales); el panel lo manda con `?banco=conciliados|sin_conciliar` y el
      Excel hereda el filtro. Solo lectura: el cruce sigue viviendo en
      Conciliación — desde el 0.0.75 el badge de ADMIN/FACTURACION abre la
      conciliación al revés y el Excel trae el detalle del banco a quien
      concilia (invariante 71).

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
    llevando a `/admin/taco-live`. (El renglón `vuelos_sin_gasto_operaciones`
    tiene su propio numeral: invariante 45.)

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
      Desde el 30-sep-2026 (0.0.46, invariante 35) tampoco se borra el
      SOBRANTE que la OPERACIÓN agregó y nunca se cotizó
      (`sobranteNoCotizadoSeConserva`: hay snapshot, el `orden` no estaba en
      él y no es «adoptar la operación» — `adoptaOperacion`; el GRUPO sí lo
      conserva): se conserva y AVISA (`avisoTramoNoCotizadoConservado`).
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
      lote, 4 consultas por cada 200 vuelos —la de `cobro_vuelo` PAGINADA—,
      tolerante a las dos migraciones; envoltorio de `facturasDeVuelos`
      desde el 13-oct-2026) sobre la cascada PURA `etiquetaFacturaVuelo`:
      CFDI vivo (`serie-folio` no cancelado) → `vuelo.factura_folio` →
      etiqueta del estatus («Facturado» / «Factura elaborada y enviada») →
      «Pendiente de factura» / «No lleva factura» / vacío = sin cobros
      (invariante 60). La usan
      el Libro Dinero (hoja 1 y «otros ingresos»), «otros movimientos» del
      Balance y, desde el 30-sep-2026 (API 0.0.45), la hoja PRINCIPAL del
      balance por avión y del general (`factura_vuelatour` por fila,
      invariante 34). **Nadie vuelve a armar su propio `facturaPorVuelo`**
      con la tabla `factura` a secas.
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
    - **Caja MADRE (invariante 83)**: el detalle trae `cajas_fondeadas`
      (por reponer de cada hija = última fila de SU libro, misma fuente) y
      `repuesto_a` en los espejos; la reposición a una hija se registra con
      el POST de movimientos de la HIJA (el espejo sale solo; sin fecha =
      hoy Cancún, nunca el `CURRENT_DATE` UTC de la BD).

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
      estatus → «Pendiente de factura» / «No lleva factura» / vacío = sin
      cobros (invariante 60). Las rutas viejas `flights/:id/factura-cliente/*` siguen vivas
      (compatibilidad); el panel ya no sube por ahí.
    - **Solicitud en `vuelo`** (`factura_solicitada_at/_por`,
      `factura_solicitud_nota`, `factura_paga_contra_factura`): `POST|DELETE
      v1/flights/:id/solicitud-factura` (`FacturaSolicitudService`,
      idempotente; `todo_el_grupo` = UNA notificación). **«Por facturar» es
      DERIVADO, nunca se guarda** (`factura-solicitud.util#estadoSolicitud`,
      con `esPorFacturar` encima): solicitada AND no CANCELADO AND
      `facturado` (PAC) ≠ true AND 0 emitidas VIGENTES ligadas AND —desde el
      13-oct-2026, invariante 65— `factura_estatus` ≠ FACTURADO AND —desde
      el 0.0.77, invariante 60— no es una solicitud AUTOMÁTICA cuyo vuelo ya
      no exige factura (`YA_NO_APLICA`, aditivo `ya_no_aplican`); los
      FACTURADO a mano sin registro van en la NOTA `marcados_sin_registro`.
      Aviso `factura_solicitada` a
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
      - **`desde`/`hasta` (13-oct-2026, API 0.0.74, decisión 5 del lote, sin
        migración ni pyservices)**: ambas rutas aceptan `desde`/`hasta` sobre
        `fecha_vuelo` (`YYYY-MM-DD` = día Cancún `T00:00:00-05:00` /
        `T23:59:59-05:00`, UTC−5 fijo; ISO con hora tal cual — mismo patrón
        que `GET /flights`; cualquier otro texto ⇒ 400 con mensaje es-MX
        «desde debe ser una fecha YYYY-MM-DD o un instante ISO 8601»),
        aplicados en `aplicarFiltrosLista` (fuente única, helper puro
        `limiteFechaVuelo`; `BuilderFiltrosLista` ganó `gte/lte` con las
        firmas de `BuilderCas`) y por tanto en las CUATRO consultas de las
        flechas, sobre `idx_vuelo_fecha_vuelo`. Con rango, las cotizaciones
        SIN fecha de vuelo quedan fuera (NULL no cumple `gte`/`lte`); el
        ancla sigue siendo la actual aunque caiga fuera del rango (anterior =
        último dentro del rango antes del ancla; siguiente = primero dentro
        del rango después); `desde > hasta` ⇒ lista vacía, no 400. Las
        respuestas y el orden (`fecha_solicitud desc` en la lista, cronológico
        en las flechas) no cambian. Por qué: el cliente pidió «Desde / Hasta»
        en Cotizaciones y las flechas deben recorrer exactamente lo que la
        lista enseña. **El panel YA manda el rango** (commit `147b925` del
        13-oct-2026: `FILTROS_LISTA` de `src/lib/admin/quote-navegacion.ts`
        incluye `desde`/`hasta`, solo `YYYY-MM-DD`, invertido se intercambia)
        y contra un API sin este cambio recibe 400 y DEGRADA: relee SIN rango
        la lista y `/vecinos` y avisa (`data-aviso="rango-api-viejo"`), así
        que el filtro solo surte efecto con este API desplegado. Se prueba
        con `quotes.service.vecinos.spec.ts` (describe «rango desde/hasta en
        día Cancún»: semana 20–21, frontera 23:30 Cancún = 04:30Z, ISO tal
        cual, ancla fuera, sin fecha, un solo extremo, invertido, combinado
        con `estado`; y PARIDAD `list` ↔ `vecinos` de los `gte/lte`) y
        `quotes.controller.vecinos.spec.ts` (DTO: 8 filtros y mensajes es-MX;
        HTTP: `desde`/`hasta` llegan intactos, `?desde=nada` ⇒ 400).
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
      `eq/gt/lt/gte/lte/ilike/in/or/order/limit`: mismo día más tarde, día
      siguiente, empate, extremos, recorrido completo ida y vuelta, filtros,
      `q` resuelta una vez, ancla fuera del filtro, sin fecha, 404, error que
      sube, la paridad del `.or` con `list`, y desde el 13-oct-2026 el rango
      Cancún `desde`/`hasta` y la paridad `gte/lte` con `list`) y
      `quotes.controller.vecinos.spec.ts` (HTTP real con `RolesGuard`: ruta
      antes de `:id`, roles = los de la lista, `limit` ⇒ 400, `desde`/`hasta`
      intactos y `?desde=nada` ⇒ 400).
    - **CORREGIDO el 5-oct-2026 (API 0.0.53)**: con `enableImplicitConversion`
      class-transformer convierte `'false'` ⇒ `true` ANTES de los
      `@Transform`, así que `@ToBooleanQuery()` recibía el valor ya
      invertido y `?conciliado=false` (pestaña «Pendientes» de Conciliación)
      devolvía los conciliados; igual `pendientes`, `duplicados`, `activo`,
      `activa`, `es_externo` y `forzar`. Ahora el decorador lee el valor CRUDO
      de la query (`obj[key]`) y `@Type(() => Boolean)` ya no se usa en
      ningún query DTO (airports `activo`, aeronaves `activa` pasaron a
      `@ToBooleanQuery()`). Spec: `to-boolean-query.decorator.spec.ts` con
      las MISMAS opciones del pipe. Todo booleano de query nace con
      `@ToBooleanQuery()`, nunca con `@Type(() => Boolean)`. Desde el
      6-oct-2026 (API 0.0.63) también mapea `'1'`/`'0'` (el panel manda
      `incluir_no_bancarios=1`); cualquier otro texto sigue siendo 400.

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
      uno»), con spec de paridad contra `cobrosSinBanco`. Desde el 0.0.78
      (invariante 77) `conciliacionDeCobro` es la VÍA de la liga; el ESTADO
      (CONCILIADO = cubierto, PARCIAL…) sale de
      `cobro-banco.util#estadoBancoCobro` y un PARCIAL también sale en
      «Cobros sin banco».
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
      cambian (decisión del cliente) — salvo los ingresos de resultado CON
      avión desde el API 0.0.75 (invariante 67): cuentan en el balance y el
      reparto de ese avión y salen de «otros movimientos» y de utilidades
      del Libro Dinero. **Sin ingresos, payload BYTE-IDÉNTICO**
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

30. **EDITORES DE COTIZACIONES COBRADAS — el candado D3 se abre POR PERSONA
    (26-sep-2026, API 0.0.37, migración `20260926000001` APLICADA el 26-sep tras
    DRYRUN_OK).** Pedido de Alejandro y Pablo Canales por WhatsApp con las
    capturas de #305 y #317 («Bloqueada · vuelo cobrado»): «un vuelo que se
    cobró en efectivo pero estaba cotizado como para transferencia, entonces
    tenía IVA: decía 754 dólares, pero entró el cobro en efectivo por 600
    dólares. Quiero editar para quitarle el IVA … Yo necesito que eso se
    desbloquee para mí, no para todos». En prod #305 = COMPLETADO, $754.00
    con $104.00 de IVA, un cobro de $600 USD; #317 = $2,893.04 cobrados en
    pesos a 17.5.
    - **Lista, no rol**: `configuracion_sistema.editores_cotizacion_cobrada`
      (`valor_json` = arreglo de uuids, MISMO patrón que
      `responsables_facturacion`), sembrada con Alejandro Canales
      (`c691cc8b-…`) y Pablo Canales (`e5aa04a8-…`). TODA la oficina es
      ADMIN (Alejandro Villalobos también) y NO lo tiene: jamás derivar el
      permiso del rol. Fuente única `ConfiguracionService`
      (`CONFIG_EDITORES_COTIZACION_COBRADA`, `puedeEditarCotizacionCobrada`,
      `permisosDe`, `editoresCotizacionCobradaNombres`); la lectura de
      `valor_json` se generalizó en `leerIdsLista(clave)` (la comparten las
      dos listas; caché de 60 s POR CLAVE). La clave se EXCLUYE de
      `GET /v1/config` y `PATCH /config/:clave` la rechaza (400
      `CLAVE_NO_EDITABLE_AQUI`), igual que la de responsables.
    - **Candado** (`QuotesService.assertSinCobros`, ahora devuelve
      `CobrosRetenidos | null`): solo si el D3 habría rebotado se consulta la
      lista **SIN caché** (una baja aplica al instante) — sin cobros o con
      neto 0 nadie la consulta. En la lista ⇒ pasa; si no ⇒ el 409 de
      siempre, cuyo mensaje ahora NOMBRA a quién puede editarla («… no se
      puede revisar. Solo pueden editarla: Alejandro Canales, Pablo Canales.
      Pídeselo a ellos, o elimina o reembolsa …») y `details.editores`
      (ADITIVO, `{id, nombre}[]`, solo oficina ACTIVA con rol que revisa
      —`ROLES_REVISAN_COTIZACION`, el mismo criterio de `/me`—, orden de la
      lista; revisión adversaria 26-sep-2026: el PUT acepta FACTURACION, pero
      el 409 jamás manda a «pedírselo» a quien no puede revisar).
      **Falla CERRADO**: lista ilegible o `ConfiguracionService` ausente
      (@Optional, 10.º parámetro del constructor; los specs viejos no lo
      pasan) ⇒ nadie tiene el permiso y el mensaje es byte-idéntico al de
      antes. Aplica a `revise` y `quickAdjust` (que delega en él); **NO al
      camino del GRUPO** (`reviseParaGrupo` ⇒ `permiteConPermiso: false`, sin
      nombres: el grupo congela a sus hijos cobrados con `HIJOS_CONGELADOS`).
      CFDI del PAC, mes cerrado y vuelo de servicio se evalúan ANTES y siguen
      bloqueando al editor; las reglas de vuelo ya volado (invariante 14)
      aplican igual.
    - **Los COBROS no se tocan**: ni una escritura a `cobro_vuelo`. El ingreso
      del vuelo sigue saliendo de `cobrosEnUsd`. Lo único que cambia es el
      total de la cotización y, con él, el saldo.
    - **Tras guardar**: `refreshCobradoTrasRecotizar` (gemelo de
      `refreshCobradoFlag`) recalcula `cobrado` — quitar el IVA puede dejar
      el vuelo LIQUIDADO (semáforo y «Pagado» azul en calendario/Google vía
      el trigger con `cobrado`) y subir el total puede des-liquidarlo. Ahora
      DEVUELVE lo que usó (`cobrado`, `cobrado_usd`, `sin_tc_*`) y la
      respuesta de `revise` lleva la bandera RECIÉN calculada (antes
      devolvía la leída antes del UPDATE). Si el UPDATE de la bandera falla
      ya no se traga: viaja como aviso («La versión se guardó, pero el estado
      «Pagado» … no se pudo actualizar»), sin 500 (un 500 invitaría a guardar
      la versión dos veces). **Lo mismo si falla la RE-LECTURA de los cobros**
      (revisión adversaria 26-sep-2026: todavía lanzaba ⇒ 500 con la versión
      ya guardada): la bandera NO se toca, aviso «…no se pudieron leer los
      cobros para recalcular el estado «Pagado»…» y el saldo del aviso sale
      de la lectura del candado (antes de guardar).
    - **Respuesta** (ADITIVA): `edicion_con_cobros: boolean` (siempre
      presente en el camino normal; `true` solo cuando el permiso abrió el
      candado; los replays idempotentes no lo traen) y en `avisos[]` el texto
      único de `quotes/edicion-con-cobros.util.ts#avisoEdicionConCobros`:
      «Se editó con cobros registrados: cobrado $600 USD, nuevo total $650
      USD, saldo $50 USD. Los cobros no se modificaron.» — o «sobrecobro $Z
      USD» cuando lo cobrado rebasa el total; cobros MXN sin T.C. se dicen
      aparte, jamás desaparecen. Montos con `fmtDineroTexto` (nunca 1
      decimal, siempre con moneda). Un avión de GRUPO con cobros del sobre
      suma `AVISO_EDICION_CON_COBROS_GRUPO` (el sobre no se re-parte solo:
      «Re-partir»). El cálculo del saldo es UNA resta a centavos
      (`saldoTrasEdicion`) sobre la MISMA lectura que decidió la bandera, con
      la MISMA tolerancia de redondeo de $1 USD en los dos sentidos
      (`semaforo-cobro.util#pendienteCobro`, la de `refreshCobradoFlag` y del
      diálogo «Guardar vN» del panel): una diferencia ≤ $1 es «saldo $0 USD
      (diferencia de redondeo de $0.50 USD)», nunca «saldo $0.50» con el
      vuelo en «Pagado» (revisión adversaria 26-sep-2026).
    - **Historial**: el motivo de la versión lleva el prefijo
      `PREFIJO_MOTIVO_CON_COBROS` = «[Con cobros · permiso especial] » (una
      sola vez, `motivoConCobros`).
    - **`GET /v1/me` y `PATCH /v1/me`** (mismo shape) agregan
      `permisos: { editar_cotizacion_cobrada }` = en la lista **Y** rol en
      `ROLES_REVISAN_COTIZACION` (ADMIN, COORDINADOR — los `@Roles` de
      revise). Caché de 60 s, best-effort (`false` si falla; nunca tumba
      /me). El panel decide su candado con esto; el API vuelve a validar.
    - **`GET /v1/config/editores-cotizacion-cobrada`** (ADMIN, COORDINADOR,
      FACTURACION) ⇒ `{ usuario_ids, usuarios: {id, nombre}[],
      puede_modificar, candidatos }` (`candidatos` ADITIVO = oficina activa
      que acepta el PUT). **`PUT` mismo path `{ usuario_ids }`**, en este
      orden: quien no está YA en la lista ⇒ 403
      `SOLO_EDITORES_COTIZACION_COBRADA` (sin la fila sembrada nadie puede);
      `[]` ⇒ 400 `LISTA_VACIA` (el DTO NO lleva `@ArrayMinSize` para que
      llegue el código); ids que no son oficina ACTIVA
      (ADMIN/COORDINADOR/FACTURACION, no piloto externo) ⇒ 400
      `USUARIOS_INVALIDOS` + `details.ids`. Escritura con CAS sobre
      `updated_at` (dos editores a la vez ⇒ 409 `EDITORES_CAMBIARON`) e
      invalidación del caché. Quitarse a sí mismo está permitido si queda
      alguien.
    - **Sin la migración**: lista vacía ⇒ todo como el 0.0.36 (409 para
      todos sin nombres, `permisos.editar_cotizacion_cobrada: false`, PUT
      403). Deploy en cualquier orden.
    - Specs: `edicion-con-cobros.util.spec.ts` (textos y resta con los casos
      #305/#317), `quotes.service.cobrada-permiso.spec.ts` (editor pasa con
      cobros intactos, Villalobos 409 con nombres, CFDI/mes cerrado/grupo
      siguen, falla cerrado, `cobrado` que se liquida y se des-liquida,
      sobrecobro, MXN convertido y sin T.C., sobre de grupo, `quickAdjust`),
      `configuracion.editores-cotizacion-cobrada.spec.ts` (exclusión,
      PATCH, permiso por persona, /me por rol, GET, los 3 errores del PUT,
      CAS y caché), `configuracion.controller.editores.spec.ts` (HTTP real:
      ruta antes de `:clave`, roles, DTO) y `me.controller.permisos.spec.ts`.

31. **COMISIÓN DEL VENDEDOR COMO GASTO (28-sep-2026, API 0.0.39, migraciones
    `20260928000001` y `20260928000002` APLICADAS el 28-sep tras DRYRUN_OK).** Pedido del cliente con
    las capturas de «otros movimientos» y «otros gastos» del balance general:
    «¿cómo registro un gasto para que aparezca en la hoja de otros
    movimientos? Como pagarle una comisión a Saab. Veo que está prellenada con
    la leyenda de que es PROVISIÓN sin un gasto real capturado… Si lo agrego
    en Gastos como "Otros gastos VuelaTour" me lo manda a la hoja de Otros
    gastos como un gasto aparte: queda duplicado.» Hasta el 0.0.38 el pago
    al vendedor SOLO existía como provisión calculada.
    - **13-oct-2026 (invariante 61): DOS categorías.** `COMISION_VENDEDOR`
      pasó a llamarse «Comisión del vendedor (VuelaTour)» (solo la etiqueta;
      la paga SIEMPRE VuelaTour) y nació `COMISION_VENDEDOR_AVION` =
      «Comisión del vendedor (avión)», destino «Pago al vendedor (columna
      COMISIONES del balance del avión; sí es costo del avión)», que carga el
      avión del vuelo. Las reglas (1)–(6) de abajo valen para las DOS (la
      (3) para la «(avión)» es «no es costo GENÉRICO del avión: resta SOLO
      en COMISIONES por `comisionesDelVuelo`»). Lo de abajo describe la
      historia de la «(VuelaTour)»; la regla vigente del dinero es la
      invariante 61.
    - **Categoría nueva** `COMISION_VENDEDOR` = «Comisión del vendedor»
      (desde el 13-oct-2026 «Comisión del vendedor (VuelaTour)»), destino
      «Pago al vendedor (otros movimientos VuelaTour; no es costo del
      avión)» (tabla canónica IDÉNTICA en API, panel y app). Reglas: (1)
      **exige vuelo a TODOS los roles** — 400 `GASTO_REQUIERE_VUELO` con el
      mismo `message`/`details` que el del piloto (`errorGastoRequiereVuelo`),
      en `create()` ANTES de tocar la BD y en `update()` sobre el estado
      FUSIONADO (desligar el vuelo o reclasificar un gasto sin vuelo ⇒ 400;
      moverla a OTRO vuelo sí se puede; `escala_id` cuenta como vuelo);
      respaldo CHECK `gasto_comision_vendedor_exige_vuelo`, cuyo 23514 el API
      traduce al MISMO 400 (nunca el 409 genérico); (2) el avión se hereda del
      vuelo solo como referencia; (3) **NO es costo del avión** en ningún
      libro; (4) **NO va a «otros gastos»** (no es de EMPRESA:
      `CATEGORIAS_GASTO_EMPRESA` NO cambia, se deriva del destino y el spec la
      congela); (5) monto libre (parcial, exacto o mayor), varios por vuelo,
      proveedor opcional, cualquier moneda; no repartible
      (`CATEGORIAS_REPARTIBLES` y `tg_gasto_reparto_valida` sin cambio), sin
      TUA embebido (`CATS_SIN_TUA_EMBEBIDO`), no ligable a compras
      (`CATEGORIAS_NO_LIGABLES`); (6) la IA de tickets no la sugiere (el
      `valid_cats` de pyservices descarta códigos desconocidos).
    - **Fuente única del apareo** `src/common/pago-vendedor.util.ts` (PURO, con
      spec; prohibido reimplementarlo): `pagosVendedorDeVuelo(gastos, aMxn)`
      ⇒ `{n, pagadoMxn, sinTc, fecha}` — filtra por categoría, suma CRUDA con
      el **conversor del libro que llama** (sin cadena de T.C. propia:
      Balance = su `gastoMxn` de «otros movimientos», MXN directo / USD ×
      (tc_gasto > 0 ?? T.C. PROMEDIO del periodo); Libro Dinero = la regla de
      su TUA pagado, MXN directo / USD × (tc_gasto > 0 ?? T.C. de VENTA del
      vuelo), extraída a `pagadoAMxn` y usada por los dos) y `round2` al
      final; fecha = la más reciente. Consecuencia aceptada: una comisión USD
      SIN `tc_gasto` puede diferir entre libros (igual que las TUAS; prod el
      28-sep: 0 gastos USD con vuelo sin T.C.).
      `conceptoPagoVendedorReal` (gramática exacta, 2 decimales es-MX y
      moneda): `pago <etiqueta> · gasto real[ (N pagos)][ · parcial: faltan
      $X MXN | · excede $X MXN][ (parcial: USD sin TC) | (USD sin TC)]` —
      «faltan/excede» solo con línea y pagado conocidos, sin USD sin T.C., y
      |d| ≥ `TOLERANCIA_PAGO_VENDEDOR_MXN` (1.00). Sin línea: `pago
      <etiqueta> · sin comisión cobrada en la cotización | vuelo cancelado:
      sin comisión cobrada | desglose de la cotización inconsistente: sin
      apareo`, con el motivo de `motivoSinLineaComision` (cancelado gana;
      inconsistente SOLO con `comision_vendedor_usd > 0`) — MISMA función en
      los dos libros (el Libro no ve líneas con partición inconsistente).
      Todos los conceptos empiezan con `pago comisión vendedor` ⇒
      `colapsarFilasDeVuelo` los clasifica sin cambio.
    - **Balance general «otros movimientos»** (`buildOtrosMovimientos`): en la
      rama `COMISION_VENDEDOR && !p.inconsistente`: `n = 0` ⇒ la PROVISIÓN de
      siempre (texto, monto y fecha byte-idénticos); `n > 0` ⇒ la PRIMERA
      línea de comisión lleva egreso = `pagadoMxn`, concepto real y fecha del
      pago más reciente (una 2.ª línea, rara, sin egreso); remanente con la
      fórmula de siempre (exacto ⇒ 0, parcial ⇒ +faltante, excedido ⇒
      −excedente). `lineaMxn` = Σ round2(totalUsd × K) de las líneas de
      comisión DESPUÉS de absorber el residuo. Pago real sin línea que lo
      aparee ⇒ fila de SOLO-egreso (antes del sobrecobro), remanente
      −egreso: es un AVISO, no se esconde. **La provisión existe SOLO sin
      gasto real.** Bandera ADITIVA de la hoja `hay_pago_vendedor_real: true`
      SOLO si algún vuelo del periodo tuvo `n > 0` (sin pagos reales la clave
      no existe ⇒ payload byte-idéntico; pyservices cambia sus leyendas solo
      con ella). **Desde el 0.0.65 (invariante 50)**, en los vuelos de la
      vigencia de `comisiones_al_avion_desde` el AVIÓN absorbe la provisión
      (lo cobrado al cliente, comisión + IVA, × su parte; SOLO si el vuelo
      está COMPLETADO) en su columna COMISIONES, y la provisión del avión NO
      depende del gasto real. **Desde el 0.0.66 (7-oct-2026)** en esos
      vuelos el ingreso cobrado se queda UNA vez y el egreso del vendedor es
      `pagoVendedorCubiertoPorAvion`: «pago comisión vendedor (X) ·
      cubierto por el avión XB-PEV (provisión $… en su balance)» por 0 sin
      gasto real, o SOLO el exceso del gasto real sobre la provisión («·
      gasto real $… · excede $… MXN»; menor ⇒ 0 con «· parcial: faltan $…
      MXN»). El 0.0.65 sumaba una línea de INGRESO «comisión del vendedor a
      cargo del avión … (regla sep-2026)» con el egreso completo y el
      cliente la leyó como comisión duplicada: ELIMINADA. Sin provisión de
      avión (antes de la vigencia, vuelo no realizado, EXTERNOS, llamada
      directa) la rama de siempre, byte a byte. **SUPERSEDIDO el
      12-oct-2026 (invariante 58): la PROVISIÓN ya no se pinta en «otros
      movimientos»** — con `n = 0` la línea de comisión no lleva egreso
      (ni «cubierto por el avión … · PROVISIÓN (sin gasto real capturado)»
      por $0.00 ni la provisión por el mismo monto); todo lo de `n > 0`
      sigue igual. **SUPERSEDIDO el 13-oct-2026 (invariante 61)**: «La
      provisión existe SOLO sin gasto real» y «el AVIÓN absorbe la provisión
      … NO depende del gasto real» dejaron de valer — el avión absorbe el
      pago REAL (n ≥ 1) en su columna COMISIONES y la pestaña lo trae «a
      cargo del avión» con egreso $0.00; `pagoVendedorCubiertoPorAvion` y
      `MARCA_PROVISION_SIN_GASTO_REAL` se eliminaron.
    - **Libro Dinero** («Otros ingresos» y utilidades): misma partición por
      vuelo. `n = 0` ⇒ provisión (`comisionProvisionadaMxn`); `n > 0` ⇒
      egreso real en la primera línea de comisión con `NOTA_PAGO_VENDEDOR_REAL`
      (`comisionPagadaMxn`); sin línea ⇒ solo-egreso con
      `NOTA_PAGO_VENDEDOR_SIN_LINEA` que **sí** se descuenta (a diferencia del
      TUA sin línea). `utilidades_otros_ingresos_mxn = r2(Σ ingresos −
      provisionada − pagada − comisiones de ingresos)`: por vuelo se resta la
      provisión **o** lo pagado, **jamás ambos** (la provisión se REEMPLAZA
      entera; no queda «provisión del faltante»: exacto ⇒ utilidad igual,
      parcial ⇒ +faltante, excedido ⇒ −excedente — mismo número que
      «otros movimientos»). `utilidades_comision_vendedor_provisionada_mxn` =
      solo provisiones VIVAS; `utilidades_comision_vendedor_pagada_mxn` es
      clave NUEVA que viaja SOLO si algún vuelo tuvo `n > 0`. **Única cadena
      que cambia sin gastos nuevos** (excepción sancionada: el texto viejo
      decía «hoy no existe categoría de gasto de comisión de venta», falso
      desde el 0.0.39): la `nota_egreso` de la provisión =
      `NOTA_PROVISION_PAGO_VENDEDOR` («…captúralo en Gastos con la categoría
      «Comisión del vendedor» ligado a este vuelo… no lo captures como «Otros
      gastos VuelaTour»: quedaría duplicado…»). Un CANCELADO con una comisión
      pagada entra al libro (es dinero real, como sus cobros/gastos).
      **SUPERSEDIDO el 13-oct-2026 (invariante 61)** el bloque `n = 0 ⇒
      provisión`: sin gasto real la fila de comisión NO lleva egreso y no se
      resta nada; `NOTA_PROVISION_PAGO_VENDEDOR` y `comisionProvisionadaMxn`
      se eliminaron y `utilidades_comision_vendedor_provisionada_mxn` viaja
      en 0. Con `n > 0`, igual (la nota ya no dice «reemplaza la
      provisión»).
    - **Fuera del avión — cada lector** (`CATEGORIAS_GASTO_FUERA_DEL_AVION` =
      empresa ∪ las DOS del pago al vendedor —`CATEGORIAS_GASTO_PAGO_VENDEDOR`,
      13-oct-2026—, `categoriaFueraDelAvion`; la «(avión)» entra a un libro
      SOLO por `comisionesDelVuelo`, nunca por este eje): Balance por
      avión (`CAT_FUERA_DEL_AVION`: fila del vuelo —sin esto caía a
      OPERACIONES como «categoría no mapeada»—, aviso de doble costo del
      externo, pendiente de fechas fuera del periodo, «Gastos Indirectos»;
      y, SOLO para la comisión —`categoriaEsPagoVendedor`, para no mover a
      las de empresa sin gastos nuevos—, **el T.C. de costos Z del vuelo** y
      el pendiente «gasto asignado a un avión que no vuela ningún tramo»:
      revisión adversaria 28-sep-2026 — el `tc_gasto` de un pago MXN, que el
      panel pide y la oficina captura días después del vuelo, movía
      `tc_costos`, la ganancia USD, el costo/hr y el T.C. promedio de TODO el
      libro del avión; y tras un cambio de avión del vuelo el pendiente decía
      en falso «así no aparece en ningún balance», cuando la comisión vive en
      «otros movimientos» con cualquier avión sellado);
      `aircraft.aircraftMetrics.finanzas`; `groups.gastosPorHijo`;
      `dashboards.gastos` (⇒ `gastos_empresa_usd`, fuera de
      `gastos_usd`/`costo_hora_usd`); acreditación del Libro Dinero;
      reparto a socios (rama EXPLÍCITA `EXCLUIDO` con la clave
      `PAGO_VENDEDOR_CLAVE_DETALLE` = «COMISION_VENDEDOR (egreso VuelaTour —
      Otros movimientos)», espejo de la de TUAS: EMPIEZA con el código para
      que `detalleGastos` derive «Comisión del vendedor (egreso VuelaTour —
      Otros movimientos)»); reporte por vuelo (se LISTA con «pago al vendedor
      — ya descontado en «pago al vendedor» (no resta aparte)», fuera de
      `gastos_total_usd`/costo/remanente; la ganancia sigue restando el pago
      COTIZADO `pagoVendedorUsd` una vez; nota informativa «Pago real al
      vendedor capturado: $X USD en N gasto(s) (la ganancia de este reporte
      resta el pago cotizado de $Y USD).» —o la variante de CANCELADO— con una
      conversión PURA local, NUNCA con `gastoUsd`, que tiene el efecto lateral
      `gastosTcVueloCount += 1`; el aviso «Vuelo externo con N gasto(s)… ADEMÁS
      del costo del operador» no la cuenta. **SUPERSEDIDO el 13-oct-2026
      (invariante 73)**: la ganancia resta el pago REAL de las dos categorías
      con esa misma conversión pura y, sin gasto, nada). **SIN cambio a propósito**: la
      hoja «otros gastos» (`gastosEmpresaYSueltos` / `.or` del Libro), los
      parciales de reparto (`CAT_EMPRESA`) y `pendienteGastosVueloSinLibro`
      (la exclusión sería un no-op). El pre-cierre la ve como cualquier gasto
      (facturación, conciliación, gasto en cancelado, duplicados); solo cambia
      su membresía en `CATEGORIAS_GASTO_SIN_AVION` (no pide avión).
    - **`GET /flights/:id/gastos-resumen`**: PILOTO y MECÁNICO NO ven los
      gastos del pago al vendedor —las DOS categorías desde el 13-oct-2026—
      (lo pagado al vendedor no es de la tripulación); la oficina sí. Filtro
      en JS, NUNCA en el query.
    - **DEPENDENCIA DURA DE LA MIGRACIÓN** (crítica verificada en prod): un
      literal de enum que no existe revienta la LECTURA PostgREST (22P02), no
      solo la escritura — `not.in(CATEGORIAS_GASTO_SIN_AVION)` (bandeja de
      pendientes, `sugerirAsignaciones`, alerta `gastos_sin_avion`,
      pre-cierre) y los `.eq('categoria', …)` anti-duplicado que corren ANTES
      del insert. El API 0.0.39 contra una BD sin `20260928000001` da **500**
      ahí ⇒ la migración va ANTES del deploy (chequeo de `pg_enum` justo
      antes del push; sonda `GET /v1/version` = 0.0.39 y
      `GET /v1/expenses?pendientes=1` = 200). Todo filtro NUEVO por esta
      categoría va en JS. `mensajeCategoriaSinMigracion` (22P02 del enum con
      COMISION_VENDEDOR ⇒ 400 «…necesita la migración 20260928000001…»; con
      COMISION_VENDEDOR_AVION, «…20261013000003…») es solo un cinturón del
      insert/update. **13-oct-2026**: `CATEGORIAS_GASTO_SIN_AVION` NO lleva
      `COMISION_VENDEDOR_AVION` (ningún query de PostgREST nombra el literal
      nuevo) — consecuencia aceptada: una «(avión)» con `aeronave_id` null
      (vuelo sin avión de la flota) sale en la bandeja, la alerta y el
      pre-cierre; la salida es reclasificarla a «(VuelaTour)».
      **ROLLBACK a 0.0.38 PROHIBIDO con comisiones capturadas**: el 0.0.38
      las restaría como OPERACIONES en la fila del vuelo Y seguiría
      provisionando ⇒ doble conteo. Solo tras reclasificarlas o con un fix
      hacia adelante. **«Un gasto por vuelo»** (riesgos R1/R14): una sola
      transferencia que paga varias comisiones (o los aviones de un grupo) se
      captura como N gastos, uno por vuelo; un pago agregado en un solo vuelo
      sale «excede» ahí y los demás siguen PROVISIONANDO ⇒ doble conteo por
      diseño (y ese cargo no se puede conciliar contra ninguno de los N gastos:
      `GASTO_YA_CUBIERTO`). Desde el 0.0.74 (invariante 61) los demás ya no
      provisionan: quedan SIN restar hasta capturar su gasto (el pendiente
      de captura del balance los lista). Apareo por grupo o gasto multi-vuelo = cambio
      aparte. «faltan/excede» con USD pagado a otro T.C. es la diferencia
      cambiaria REAL, no un error (R15). Las 2 PRUEBAS del cliente en #317
      (OTRO, 250,000.00 y 870,000.00 MXN) NO se tocan: las borra la oficina.
    - Specs: `categoria-gasto.util.spec` (20 valores, tabla canónica, listas
      congeladas, mensaje sin migración), `pago-vendedor.util.spec`
      (conversor inyectado, round2 al final, fecha, TODA la gramática,
      tolerancia 0.99/1.00, motivos, notas), `expenses.service.sin-vuelo.spec`
      (4 roles sin vuelo sin tocar la BD, con vuelo/tramo hereda avión,
      update desliga/reclasifica/mueve, 22P02, 23514 del CHECK nuevo vs otro
      23514), `aircraft-balance.service.pago-vendedor.spec` (golden de
      ingresos BYTE-IDÉNTICO sin gasto, exacto/parcial/excedido/varios, T.C.
      promedio vs `tc_gasto`, sin línea, cancelado, inconsistente, exclusión
      del libro del avión con mutación verificada; i4 una comisión MXN CON
      `tc_gasto` no mueve Z ni el libro, con control OPERACIONES que sí lo
      mueve; i5 comisión sellada a otro avión sin el pendiente falso, con
      control que sí grita — los dos fallan sin el fix),
      `dinero-report.service.pago-vendedor.spec` (utilidades golden / +400 /
      −400 / −500, hoja 3 intacta, T.C. de venta, USD sin T.C., test CRUZADO
      de conceptos con el Balance), `profit-sharing.service.empresa.spec`
      (EXCLUIDO + etiqueta derivada, utilidad idéntica),
      `flight-report.service.pago-vendedor.spec`,
      `dashboards.service.comision-vendedor.spec`,
      `aircraft.service.comision-vendedor.spec` y
      `flights.service.gastos-resumen.spec` (el query no lleva filtro de
      categoría). Mundo compartido en
      `aircraft/libros-pago-vendedor.fixture-spec.ts` (copia literal del de
      los specs de ingresos; fuera del build y de jest). En
      `dinero-report.service.ingresos.spec` solo cambió la `nota_egreso` de la
      provisión en el golden (la excepción sancionada).

32. **SEGUIMIENTO DE LA COTIZACIÓN POR VUELO (29-sep-2026, API 0.0.43,
    migración `20260929000002`)** — pedido del cliente con la captura del
    vuelo #358: «un apartado para poner unas notas que se deben agregar a la
    cotización. Ejemplo: Pablo ya terminó el vuelito de hoy y los pax
    pidieron un transporte el cual no está incluido en la cotización pero se
    necesita cobrar». NO es otra `notas`: `vuelo.notas` (cliente/operación),
    `vuelo.notas_internas` y `escala.notas` (piloto) siguen igual y ninguno
    tiene estado. Esto es una LISTA con SEGUIMIENTO.
    - **Tabla `vuelo_seguimiento`**: `texto` (1–1000, recortado),
      `afecta_cotizacion` (default true = «debe reflejarse en la
      cotización»), `estado` PENDIENTE | RESUELTA (texto + CHECK, no enum),
      `resuelta_at/_por`, `resolucion` (≤ 500), `created_*`, `updated_at`
      (`tg_set_updated_at`), soft delete `deleted_at/_by` — **TODO lector
      filtra `deleted_at is null`**. CHECK: RESUELTA ⇔ `resuelta_at`; una
      PENDIENTE no arrastra `resuelta_por` ni `resolucion` (reabrir LIMPIA).
      vuelo ON DELETE CASCADE. La nota **no toca la fila `vuelo`**: ni
      `updated_at` (CAS de la app sin internet) ni la cola de Google.
    - **Fuente única PURA** `flights/vuelo-seguimiento.util.ts` (con spec):
      orden de la lista (PENDIENTE primero, luego `created_at` desc, empate
      por id), `contarPendientes`, `detallePendientesCotizacion` (solo
      PENDIENTE + afecta, máx 20), `aNota` (`creado_por` SIEMPRE objeto:
      usuario borrado ⇒ `{id: null, nombre: null}`, jamás un uuid como
      nombre; `resuelta_por` null mientras está pendiente),
      `parcheSeguimiento` (sellos) y el aviso del pre-cierre. I/O en
      `flights/vuelo-seguimiento.service.ts` (provider de FlightsModule,
      exportado; NO inyecta FlightsService).
    - **Rutas** (`@Roles` explícito en CADA una; constantes
      `ROLES_SEGUIMIENTO_*` en el util): `GET /v1/flights/:id/seguimiento`
      (ADMIN, COORDINADOR, FACTURACION, SOCIO, ANALISTA); `POST
      /v1/flights/:id/seguimiento` `{texto, afecta_cotizacion?}` → 201 con
      la nota; `PATCH /v1/flights/seguimiento/:notaId` `{estado?,
      resolucion?, texto?, afecta_cotizacion?}`; `DELETE
      /v1/flights/seguimiento/:notaId` → soft delete (se permite aunque esté
      RESUELTA; el panel CONFIRMA). Escrituras: ADMIN, COORDINADOR,
      FACTURACION. PILOTO/MECANICO/VISITANTE ⇒ 403. 404 estructurados:
      `VUELO_NO_EXISTE` / `SEGUIMIENTO_NO_EXISTE` (nota borrada = no
      existe). Las rutas por NOTA van bajo el literal `seguimiento/` (como
      `legs/` y `cobros/`).
    - **Sellos de PATCH**: RESUELTA desde PENDIENTE sella `resuelta_at =
      ahora` y `resuelta_por = actor` (+ resolución opcional). Pedir el
      estado que YA tiene (doble clic, dos personas) responde la nota TAL
      CUAL, sin re-sellar ni escribir. En una resuelta se corrige la
      resolución sin re-sellar. PENDIENTE (reabrir) limpia sello y
      resolución. Resolución sobre una pendiente ⇒ 400
      `SEGUIMIENTO_RESOLUCION_SIN_RESOLVER`; cuerpo vacío ⇒ 400
      `SEGUIMIENTO_SIN_CAMBIOS`. `afecta_cotizacion` se valida sobre el
      valor CRUDO del body (`enableImplicitConversion` convertiría el texto
      'false' en `true`; patrón de `preview-quote.dto#sucio`). **En el PATCH
      `null` NO es «omitido»** (revisión adversaria 29-sep-2026): `estado` y
      `afecta_cotizacion` usan `@ValidateIf(v !== undefined)` en vez de
      `@IsOptional` ⇒ `null` = 400; con `@IsOptional` un
      `{afecta_cotizacion: null}` pasaba y el parche lo guardaba como
      `false` (la nota dejaba de vigilarse en silencio). `parcheSeguimiento`
      lo repite (400 `SEGUIMIENTO_AFECTA_INVALIDO` si no es booleano).
      **CAS por `estado`** (misma revisión): el UPDATE exige el estado LEÍDO
      (`.eq('estado', actual.estado)`); con 0 filas se relee (404 si la
      borraron) y se recalcula UNA vez. Sin él, dos «Marcar resuelta» a la
      vez re-sellaban y la segunda BORRABA la resolución de la primera, y
      corregir la resolución de una nota recién reabierta por otra persona
      reventaba el CHECK ⇒ 500 (hoy: la nota tal cual / 400
      `SEGUIMIENTO_RESOLUCION_SIN_RESOLVER`). Dos fallos seguidos ⇒ 409
      `SEGUIMIENTO_CAMBIO_CONCURRENTE`.
    - **ADITIVOS**: `GET /v1/flights/:id` (detalle) y el snapshot llevan
      `seguimiento_pendientes` (PENDIENTE vivas) y
      `seguimiento_cotizacion_pendientes` (las que afectan la cotización)
      SOLO para los roles que leen la lista (`rolVeSeguimiento`): para la
      tripulación las llaves se OMITEN (ni se leen). `GET /v1/quotes/:id`
      (ahora `QuotesService.detalle` = `findById` + bloque) lleva el mismo
      par + `seguimiento_pendientes_detalle` `[{id, texto, created_at,
      creado_por_nombre}]` para el banner ámbar NO ocultable del cotizador;
      los caminos internos (revise/confirm/cancel/PDF) siguen con
      `findById` a secas (el panel rehidrata con esta ruta tras guardar).
    - **Degradación**: tabla ausente (42P01/PGRST205, migración sin aplicar)
      ⇒ lista `[]`, contadores 0 (no existe ninguna nota), pre-cierre sin
      vuelos y ESCRITURAS 503 `SEGUIMIENTO_NO_DISPONIBLE`. Cualquier OTRO
      fallo de lectura en los bloques aditivos ⇒ contadores **`null`** (≠ 0:
      jamás se afirma «no hay pendientes» sin haber leído) y detalle `[]`,
      con `warn`; el detalle del vuelo y el cotizador NO se caen.
    - **Pre-cierre** (`profit-sharing.preCierre`): item
      `seguimiento_cotizacion_pendiente` («Vuelos con ajustes pendientes de
      reflejar en la cotización»), **NO bloqueante** (fuera de
      `bloqueantes`, sin `informativo`: hay algo que hacer). Vuelos cuya
      `fecha_vuelo` cae en el periodo (cortes Cancún, invariante 4; TODOS
      los estados — una nota pendiente de un cancelado también se cierra a
      mano) con notas PENDIENTE + afecta + vivas. `count` = VUELOS, `notas`
      = total, `vuelos[] {id, folio, estado, fecha_vuelo, notas}` por folio,
      `detalle` «N vuelo(s) con ajustes pendientes de reflejar en la
      cotización: #a, #b…» (15 folios y «y N más»). Lectura fallida ⇒ count
      0 con `lectura_fallida: true` y un texto que lo dice. La lectura va
      **PAGINADA** (`order('id')` + `range` de 1000, tope 20 páginas ⇒
      lectura fallida): PostgREST corta en max-rows = 1000 sin avisar y el
      `.limit(5000)` original no lo evitaba. Sin la tabla, PostgREST responde
      **PGRST205 también con el embed `vuelo:vuelo_id!inner`** (verificado
      contra prod el 29-sep, no PGRST200), así que `esTablaInexistente` la
      reconoce.
    - **Pendiente (fuera de alcance)**: que el PILOTO deje la nota desde la
      app (Flutter); cotizaciones de GRUPO (el banner vive en la cotización
      por vuelo/hijo).
    - Specs: `vuelo-seguimiento.util.spec` (orden, contadores, banner máx
      20, forma, sellos, textos del pre-cierre), `vuelo-seguimiento.service.spec`
      (BD en memoria: sin borradas, defaults, 404/503, soft delete, null ≠
      0, resolver la última pendiente vacía el banner),
      `flights.controller.seguimiento.spec` (HTTP real: `@Roles` en cada
      ruta, 403 por rol, 400 del DTO incluido 'false' en texto, PATCH/DELETE
      por nota no caen en `:id`, 503 sin el service),
      `flights.service.seguimiento.spec` (llaves en detalle y snapshot por
      rol), `quotes.service.seguimiento.spec` y
      `profit-sharing.service.seguimiento.spec` (filtros y cortes Cancún de
      la consulta, no bloquea, tabla ausente, lectura fallida, 2,350 notas
      en 3 páginas). Carreras del CAS en `vuelo-seguimiento.service.spec`
      («carreras (CAS por estado)»: 2 de sus casos FALLAN sin el `.eq` del
      estado) y `null` ⇒ 400 en `flights.controller.seguimiento.spec`.

33. **REVERSOS: CARGO DEVUELTO ↔ SU DEVOLUCIÓN (30-sep-2026, API 0.0.44,
    migración `20260930000001` — APLICADA en prod el 30-sep-2026 (DRYRUN_OK con el par real); DRYRUN_OK en prod con
    el par REAL).** Pregunta del cliente con la captura de Conciliación ·
    GASTOS GNRAL: «¿Cómo puedo conciliar los cargos reembolsados?». Caso
    real: el 21-sep 8 cargos «ASUR CANCUN» $825.13 (1 con su gasto, 7
    «sin candidato») y el 23-sep 7 abonos «CARGO INDEBIDO 21 SEP 355xx» de
    $825.13 (MISMA referencia en los 7). Un cargo devuelto y su devolución
    **se anulan: no son gasto ni ingreso**; hasta hoy se clasificaban a mano
    los 14.
    - **Modelo**: `movimiento_bancario.reverso_de_id` va en el ABONO y
      apunta al CARGO que devuelve (FK a sí misma `on delete set null`;
      índice ÚNICO parcial `uq_mov_bancario_reverso_de`: un cargo se
      devuelve UNA vez). Los DOS quedan `conciliado = true` con la
      clasificación canónica «Reverso de un cargo»
      (`asegurarClasificacionReverso`: búsqueda sin distinguir mayúsculas,
      la crea si falta y la REACTIVA si está de baja) y una nota que nombra
      al otro, ANTEPUESTA a lo que ya había: abono «Devuelve el cargo del
      21-09 · ASUR CANCUN», cargo «Devuelto el 23-09 · CARGO INDEBIDO 21 SEP
      35552». El abono pierde gasto/cobro/sobre/ingreso (null).
    - **Candado de verdad en BD**: `tg_mov_bancario_reverso` (BEFORE INSERT
      / UPDATE OF reverso_de_id, tipo, monto, cuenta_bancaria_id, gasto_id,
      cobro_id, cobro_grupo_id, ingreso_id; INVOKER, `search_path ''`,
      `tipo::text`). Lado ABONO: la fila es ABONO sin ligas; el destino es
      CARGO de la MISMA cuenta, MISMO monto (±0.005), sin ligas, sin reverso
      propio ni otra devolución (`for update` sobre el cargo: serializa dos
      emparejados o un emparejado y una liga a gasto). Lado CARGO: un cargo
      emparejado no cambia tipo/monto/cuenta ni se liga a
      gasto/cobro/sobre/ingreso. Lanza 23514 `REVERSO_INVALIDO: <motivo>`;
      el API lo traduce a 409 `REVERSO_INVALIDO` (`details.motivo`) con
      `motivoTriggerReverso` (también el 23505 del índice único). Espejo
      PURO para el 409 previo: `motivoParInvalido`.
    - **Fuente única PURA** `conciliacion/reverso-cruce.util.ts` (con spec y
      las leyendas REALES): `patronDevolucion`/`esDevolucionDeCargo` (CARGO
      INDEBIDO | DEVOLUCION | REVERSO | CONTRACARGO | ABONO POR ACLARACION |
      RECLAMACION como inicio de palabra, + el prefijo «REV …» de
      `patronReverso`), `pistaFechaDevolucion` («21 SEP» ⇒ la última fecha
      con ese día/mes no posterior al abono; día inexistente ⇒ null),
      ventanas (cargo en [abono − 60 d, abono]; abono en [cargo, cargo +
      60 d]), `elegirCargoReverso` y `emparejarReversos`, notas, etiqueta del
      reporte y `movimientoLibreParaReverso`.
    - **Regla del emparejado automático (solo lo INEQUÍVOCO)**: candidatos =
      cargos PENDIENTES y LIBRES (sin gasto/cobro/sobre/ingreso/
      clasificación/devolución — **jamás un cargo ligado a gasto**) de la
      misma cuenta y monto en la ventana. Con fecha en la leyenda: los de
      ESE día; si no hay, ±3 días; si tampoco, SIN_CANDIDATO (nunca otra
      fecha «por si acaso»). Todos del mismo día ⇒ intercambiables: el más
      antiguo (fecha, `created_at`, id). Fechas distintas sin pista ⇒
      AMBIGUO (queda pendiente). En lote: primero las devoluciones con
      fecha en la leyenda, luego las demás, y se repasa mientras alguna se
      empareje (al consumirse un cargo, una AMBIGUA puede quedar con uno);
      cada cargo se usa UNA vez. Caso real ⇒ 7 pares distintos del 21-sep.
      **Freno de los cargos YA LIGADOS con dinero** (revisión adversaria
      30-sep, `cargoLigadoConDinero`: gasto/cobro/sobre/ingreso; una
      clasificación NO cuenta): nunca se emparejan, pero si el cargo que
      nombra la leyenda está ligado ⇒ SIN_CANDIDATO (no se brinca a ±3
      días); con ±3 días, un ligado MÁS CERCA de la fecha que el libre ⇒
      AMBIGUO; sin pista, un ligado MÁS RECIENTE que el libre más reciente ⇒
      AMBIGUO (el banco casi seguro devolvió ESE). Caso REAL: «REV.ASUR
      MERIDA» del 07-08 ($110.82) con su cargo del 07-08 ligado a gasto y
      dos «ASUR Merida» pendientes del 06-07 — sin el freno se emparejaba
      con uno del 06-07, un mes antes. Un ligado del MISMO día que los
      libres no frena (el 21-sep). El `sugerido` del diálogo usa el mismo
      freno.
    - **Rutas** (roles de la CLASE: ADMIN, FACTURACION — quienes concilian;
      el contrato pedía también COORDINADOR, pero la página de Conciliación
      y todo `conciliacion/*` son ADMIN+FACTURACION y el invariante 29 dice
      «COORDINADOR no concilia»): `GET conciliacion/movimientos/:id/
      reverso-candidatos` (`:id` ABONO ⇒ cargos, fecha desc; `:id` CARGO ⇒
      abonos, devoluciones primero; cada uno `{id, fecha, descripcion,
      referencia, monto, tipo, es_devolucion, sugerido}` con a lo más UN
      `sugerido`; `[]` = no hay; 409 `MOVIMIENTO_YA_LIGADO` si ya está
      conciliado); `POST conciliacion/movimientos/:id/reverso {cargo_id}`
      (también `:id` = cargo con `{abono_id}`; el rol sale del TIPO; los
      dos a la vez ⇒ 400 `REVERSO_SIN_PAR`) ⇒
      `{abono, cargo, idempotente}` con los aditivos `reverso_de` /
      `revertido_por`; reintento del mismo par ⇒ 200 `idempotente: true` sin
      escribir (si el par quedó A MEDIAS —abono apuntando y cargo
      pendiente— el reintento COMPLETA el cargo, `idempotente: false`); 404 `MOVIMIENTO_NO_EXISTE`; 400 `REVERSO_SIN_PAR`; `DELETE
      conciliacion/movimientos/:id/reverso` (`:id` abono O cargo) ⇒ los DOS
      pendientes (sin clasificación) y se quitan SOLO los renglones del
      emparejado de sus notas (`quitarNotaReverso`); 404 `SIN_REVERSO`;
      `POST conciliacion/reversos/auto {cuenta_bancaria_id?, desde?,
      hasta?}` (fecha del ABONO, default 90 días Cancún, 400
      `PERIODO_MUY_GRANDE` > 3,000 abonos) ⇒ `{revisados, emparejados,
      sin_candidato, ambiguos, errores, desde, hasta, cuenta_bancaria_id,
      detalle[{abono_id, cargo_id, resultado, motivo, pista_fecha,
      candidatos_n, abono_fecha, abono_descripcion, cargo_fecha,
      cargo_descripcion}], detalle_truncado}`.
    - **Escritura = UNA transacción lógica** (`escribirParReverso`): primero
      el ABONO con CAS COMPLETO (`conciliado = false`, `reverso_de_id`,
      `gasto_id`, `cobro_id`, `cobro_grupo_id`, `clasificacion_id` e
      `ingreso_id` en null — el patch los pone en null, así que sin el CAS
      una liga escrita entre la lectura y el update se borraba en silencio
      y el trigger no la veía; el trigger valida y el índice reserva el
      cargo), luego el CARGO con CAS
      (`conciliado = false`, sin gasto ni clasificación); si el segundo
      falla, el abono se REGRESA a como estaba (si ni eso se puede ⇒ 500
      `REVERSO_A_MEDIAS`: reintentar lo COMPLETA, o «Quitar»). Desemparejar: abono
      con CAS por su `reverso_de_id` y compensación simétrica.
    - **Integración con el cruce** (misma función `emparejarDevoluciones`):
      «Cruzar pendientes» (`autoMatchPendientes`) y la IMPORTACIÓN corren el
      emparejado DESPUÉS del cruce contra gastos/cobros/ingresos —esos
      tienen prioridad: el reverso solo toma lo que nadie explicó— sobre los
      abonos de la corrida que siguen pendientes (`aplicarReversosEnCorrida`,
      best-effort: un fallo NUNCA tumba la corrida). Los movimientos
      emparejados pasan a resultado/criterio `REVERSO` (`ResultadoCruce` y
      `CriterioCruce` + `ConteoCruce.reversos`, por MOVIMIENTO: un par suma
      2) y la respuesta suma los ADITIVOS `reversos` y `reversos_emparejados`
      (PARES); en la importación `conciliados_auto` los incluye y el job los
      guarda en `resultados`. Una devolución que el cruce dejó SIN_CANDIDATO
      y el reverso no pudo emparejar lleva el motivo del reverso («Devolución
      de un cargo: …»). Con la migración, un ABONO con leyenda de devolución
      (fuera de las cuentas PASARELA) **NO se cruza contra cobros/sobres/
      ingresos** en `cruzarMovimiento` (revisión adversaria 30-sep): no es
      el pago de un cliente, y antes un cobro del mismo monto ±días se
      quedaba con la devolución; queda SIN_CANDIDATO y el paso de reversos
      lo empareja o dice por qué. Sin la migración, como el 0.0.43.
    - **Candados en los demás caminos**: `link` (gasto, ligar Y desligar) y
      `linkCobro` rebotan 409 `MOVIMIENTO_EN_REVERSO` (`details {abono_id,
      cargo_id}`) sobre un movimiento emparejado; `clasificarMovimiento` con
      `null` («Quitar clasificación») en CUALQUIERA de los dos DESEMPAREJA
      AMBOS (respuesta = la fila + `desemparejado_con`), con OTRA
      clasificación ⇒ 409 `MOVIMIENTO_EN_REVERSO` y con la MISMA solo edita
      notas. `linkIngreso` y las rutas de Ingresos ya rechazaban un abono
      clasificado/conciliado.
    - **Lectores**: `GET conciliacion/movimientos` suma `reverso_de_id` y los
      ADITIVOS `reverso_de` (abono) / `revertido_por` (cargo) `{id, fecha,
      descripcion} | null` en TODAS las filas (dos lecturas en lote por
      página, ≤ 200 ids; si fallan quedan null). El reporte Excel dice
      «Conciliado con: Reverso de un cargo · devuelve el cargo del 21-09 ·
      ASUR CANCUN» / «… · devuelto el 23-09 · CARGO INDEBIDO 21 SEP 35552»
      (`etiquetaConciliadoReverso`). Ingresos → «Por conciliar», el resumen
      de Ingresos y el aviso del pre-cierre leen `conciliado = false`: la
      devolución emparejada ya no aparece ni cuenta como ingreso. Libro
      Dinero, balance y reparto NO cambian (los movimientos bancarios no
      entran al dinero).
    - **Sonda ÚNICA** `common/reverso-disponible.util` (columna
      `reverso_de_id`, re-sondeo ≤ 10 min): sin la migración las rutas
      nuevas ⇒ 503 `REVERSOS_NO_DISPONIBLE` y NINGUNA otra consulta nombra
      la columna (lista/reporte/re-cruce/importación/ligas como el 0.0.43;
      `reverso_de`/`revertido_por` viajan null).
    - **Cargo que paga VARIOS gastos (2-oct-2026, invariante 40)**: su
      `gasto_id` es null (espejo) y `gastos_n ≥ 2`. «Ligado a gasto» del par
      = `gasto_id is not null or gastos_n > 0` (fuente única
      `ligadoAGasto`/`gastosLigadosN` en `reverso-cruce.util`, el MISMO
      predicado del trigger reescrito): `movimientoLibreParaReverso`,
      `cargoLigadoConDinero` (freno), `ligaDe` («El cargo ya está conciliado
      con 3 gastos: quítalo antes.»), el check inline de `emparejarReverso`
      y `reverso-candidatos` lo usan; `MOV_REVERSO_COLS` suma `gastos_n` y
      los 4 CAS (`escribirParReverso` abono y cargo, `completarCargoReverso`,
      `desemparejarReverso`) agregan `.eq('gastos_n', 0)` — todo detrás de la
      sonda de partes. Sin ella, como el 0.0.51.
    - **Lo que NO se tocó (pendiente)**: `analizarAbono` / `sugerir-abonos`
      de Ingresos siguen marcando `patron: 'REVERSO'` SOLO con el prefijo
      «REV …» y proponiendo `CLASIFICAR_REVERSO` (clasifica solo el abono):
      lo natural ahora es ofrecer «Es la devolución de un cargo» ahí también
      (panel).
    - Specs: `reverso-cruce.util.spec` (leyendas, pista de fecha, ventanas,
      ambiguo/idénticos/pista, lote REAL 7 ↔ 7 y determinista, espejo del
      trigger, notas y etiquetas), `conciliacion.service.reverso.spec`
      (emparejar en los dos sentidos, idempotente, 409/404/400, trigger ⇒
      409, compensación, desemparejar, «Quitar clasificación», candados de
      link/linkCobro/clasificar, candidatos, auto con el caso real, re-cruce
      donde el GASTO se lleva su cargo y las 7 devoluciones los otros 7,
      importación, lista, reporte, «Por conciliar», y sin migración: 503 y
      solo la sonda nombra la columna), `conciliacion.controller.reverso.spec`
      (HTTP real: rutas, DTO, roles, 503) y `reverso-disponible.util.spec`.

34. **FACTURA VUELATOUR EN LA HOJA PRINCIPAL DEL BALANCE (30-sep-2026, API
    0.0.45, sin migración).** Marie, para Ale, con la foto del Excel
    «balance-XA-VGV-2026-09-01-2026-09-30» (bloque STATUS DE COBROS): «en
    balance por avión el reporte de excel se ocupa que diga el num de
    factura que nosotros emitimos del servicio, no aparece en la columna, y
    si puede salir en el reporte general también». Hasta el 0.0.44 solo la
    traían «otros movimientos» y el Libro Dinero.
    - **Campo ADITIVO `factura_vuelatour: string | null`** al FINAL de cada
      fila de `BalanceAvionPayload.vuelos` (después de `por_cobrar_usd`),
      con la etiqueta de la FUENTE ÚNICA `etiquetasFacturaDeVuelos`
      (invariante 25/27: CFDI vivo → emitidas VIGENTES «A-0424» → folio
      tecleado → estatus → «Pendiente de factura» / «No lleva factura» /
      `null` = sin cobros, invariante 60). Es del VUELO: un multi-avión lleva la
      MISMA etiqueta en la fila de cada libro, y un CANCELADO o una fila
      «solo gastos de tramo cancelado» también la llevan. Ningún número del
      payload cambia: con y sin facturas el libro es idéntico salvo esa
      llave (spec). El consolidado del general la hereda por el spread de
      las filas. pyservices la pinta al final de STATUS DE COBROS («FACTURA
      VUELATOUR», sin sumar en TOTALES); uno viejo la ignora.
    - **Memo POR VUELO** (`etiquetasFacturaMemo`, mismo patrón que
      `memoTc`): `buildPayload` y `buildOtrosMovimientos` reciben
      `memoFactura: Map<vuelo_id, Promise<string | null>>` (opcional, al
      final; los specs viejos no lo pasan). Solo se consultan los vuelos que
      el memo aún no tiene, en UN lote (la helper parte en bloques de 200):
      en el general UNA lectura por libro con vuelos nuevos, un multi-avión
      no se pide dos veces y «otros movimientos» solo pide los vuelos que
      ningún libro cargó (en la práctica los que no tienen avión). En el
      libro individual, una sola lectura. Nunca N+1.
    - **Un fallo de lectura TUMBA el libro** («Balance XB-TST: fallo al leer
      facturas: …», misma regla que cobros/gastos): jamás una columna vacía
      que parezca «sin factura». La tolerancia a las migraciones de factura
      sigue viviendo en la helper (`columnaOpcional`).
    - Spec: `aircraft-balance.service.factura.spec.ts` (emitida vigente gana
      al folio tecleado y una CANCELADA no cuenta, CFDI vivo, CFDI cancelado
      ⇒ folio, cancelado rotulado, `null` sin facturas en individual y
      general, payload idéntico salvo la llave, un lote por libro, fallo con
      contexto, multi-avión en los dos libros y en el consolidado, libro
      EXTERNOS y fila «solo gastos de tramo cancelado» con la etiqueta de su
      vuelo —falla si alguna de las dos se deja en `null`—, cada vuelo
      pedido UNA vez en todo el general —falla si «otros movimientos» no
      comparte el memo—, y el memo unitario: faltantes, reutilización,
      rechazo sin etiqueta inventada, cero consultas sin vuelos).

35. **TRAMO AGREGADO A UN VUELO YA CREADO: DEL CLIENTE U OPERATIVO
    (30-sep-2026, API 0.0.46, sin migración; caso #364).** Pregunta del
    cliente con capturas de la app: Itzi dio de alta el #364 con CUN→CET y
    CET→PTU (ferry, 0 pax; comerciales, orden 1 y 2) y Pablo agregó desde
    «Editar vuelo» PTU→CUN con 4 pasajeros; la app lo pintó «Interno (no
    del cliente)» y en el detalle «tramo 100» (en la lista, 3): «¿Por qué
    aparece ese aviso? ¿A qué se refiere?». Causa: `POST
    /v1/flights/:id/operational-legs` (`createOperationalLeg`, el ÚNICO
    camino de la app «Editar vuelo» → `tramo_operativo` y del panel
    «Agregar tramo») insertaba SIEMPRE `solo_operativa: true` en
    `orden = max(maxOrden+1, 100)`, aunque el tramo llevara pasajeros: el
    tramo del cliente quedaba fuera de la cotización, del precio, del
    reparto (`participacion-aeronave.util`) y de «adoptar operación».
    - **Fuente única PURA** `flights/tramo-agregado.util.ts` (con spec).
      `esTramoOperativo`: FERRY, o parada de SERVICIO **sin** pasajeros ⇒
      operativo (`solo_operativa`, `orden ≥ OPERATIVA_ORDEN_BASE = 100`, como
      siempre). Todo lo demás es del CLIENTE (comercial) — la MISMA regla del
      alta (`legsDeReserva`: `solo_operativa = es_ferry`). **Desviación
      consciente del contrato** («SERVICIO ⇒ operativo»): una parada de
      SERVICIO CON pasajeros es del cliente — en prod #150 (CUN→CET, 5 pax,
      «ajustar el magneto»), #84 y #57 son vuelos del cliente que dejan el
      avión en el taller y están cotizados; marcarlos operativos repetiría
      el bug del #364.
    - **`orden` del tramo comercial** (`ubicarTramoAgregado`): el mayor
      `orden < 100` de los tramos NO cancelados + 1, saltando los números
      que ocupe un tramo cancelado (el índice ÚNICO
      `escala_vuelo_id_orden_key` cubre TODAS las filas). Así cae en el rango
      1..n que `quotes.replaceEscalas` maneja por UPSERT de `orden`: la
      cotización muestra «hay un tramo 3 PTU → CUN que no se cotizó» (panel,
      `divergenciasDeOperacion`) y «Actualizar la cotización con la
      operación» lo ACTUALIZA en su lugar, sin duplicarlo. En el #364 queda
      orden 3 = el número de la lista.
    - **FRENO DE CRONOLOGÍA (horas sagradas, invariantes 1 y 5)**: la cadena
      de tacómetros (`propagarLlegadaASalidaSiguiente`, `fillTacoGaps`,
      rotaciones) camina por `orden` y un tramo nuevo se agrega AL FINAL de
      la ruta. Si hay un tramo NO cancelado en `orden ≥ 100` que va ANTES
      —ya voló o está volando (llegada, o salida que no es copia DEDUCIDA),
      o su `fecha_salida_plan` es anterior a la del nuevo—, numerar el nuevo
      por debajo de 100 lo pondría ANTES en la cadena: su salida se copiaría
      de la llegada equivocada y las horas del ferry se contarían dos veces.
      Ahí el tramo queda OPERATIVO (`orden ≥ 100`, cronología intacta) y la
      respuesta lo dice con `AVISO_TRAMO_CLIENTE_OPERATIVO` («…quedó como
      operativo y no entra a la cotización. Si hay que cobrarlo, agrégalo
      como ajuste o extra…» — NO «como tramo»: un tramo nuevo en la
      cotización lo INSERTARÍA otra vez en la operación). Sin fechas se
      asume lo que la lista ya pinta: el operativo ≥ 100 (ferry de regreso)
      va al final y el tramo del cliente antes. Caso típico del freno: vuelo
      COMPLETADO cuyo ferry de regreso (100) ya voló y el cliente pide otro
      tramo.
    - **Respuesta ADITIVA**: la escala + `comercial: boolean` + `aviso:
      string | null` (`AVISO_TRAMO_COMERCIAL` = «Este tramo es del cliente:
      la cotización mostrará que la operación difiere y ofrecerá
      adoptarlo.» cuando es comercial; null en un ferry/servicio vacío). El
      replay idempotente (pre-check y carrera 23505 de la llave) los DERIVA
      de la fila guardada (`avisoDeTramoGuardado`): devuelve lo que se creó.
      Todo lo demás que reacciona a un tramo nuevo NO cambió
      (`refreshPermisosDeVuelo`, `reabrirTrasTramoNuevo`, `syncFlight`,
      `notificarTramoNuevo`, `fecha_fin` por trigger).
    - **Carrera de `orden`** (dos altas a la vez calculan el mismo número):
      el 23505 de `escala_vuelo_id_orden_key` relee y recalcula (3
      intentos) y, si no cede, 409 «Otro tramo se agregó a este vuelo al
      mismo tiempo: vuelve a intentarlo.» — antes era un 500 (y un 500
      dispara el reintento del outbox). Si la lectura de las escalas falla,
      se LANZA: jamás se adivina un `orden`.
    - **La cotización no borra el tramo que agregó la operación**
      (`tramos-cotizados.util#sobranteNoCotizadoSeConserva`, con spec):
      hasta hoy un tramo comercial con `orden` > los tramos que llegan era
      «sobrante» y, sin tacómetro, se BORRABA (con su evento de Google y un
      push «tramos eliminados»). Con tramos comerciales nacidos en la
      operación eso significaba: Pablo agrega PTU→CUN, la oficina guarda la
      cotización por un T.C. (o `quickAdjust` registra un cobro) y el tramo
      DESAPARECE del vuelo. Ahora `replaceEscalas` lo CONSERVA y avisa
      (`avisoTramoNoCotizadoConservado`, solo si no está cancelado) cuando
      hay snapshot con tramos, ese `orden` NO estaba cotizado y la lista no
      es «adoptar la operación» (`replaceEscalas` opción `adoptaOperacion` =
      `tramos_base 'OPERACION'`: esa sí manda la lista viva completa). El
      GRUPO confía en su DTO para las columnas (`confiarEnDto`) pero NO
      cuenta como adoptar (revisión adversaria 30-sep-2026): re-materializa
      su PLANTILLA, que no conoce el tramo que la operación agregó a un hijo,
      y antes lo BORRABA cada vez que alguien editaba el grupo. Un tramo que
      SÍ estaba cotizado y la oficina quitó se sigue borrando (edición
      deliberada). La vista previa (`quoteLikeParaPreview`) usa la MISMA
      función.
    - **Rotaciones del hijo de GRUPO sobre lo COTIZADO**
      (`grupo-armador.util#rotacionesDeHijo`, con spec; revisión adversaria
      30-sep-2026): la doble rotación se deducía contando las escalas VIVAS
      comerciales (`plantilla × 3`). Con tramos del cliente nacidos en la
      operación, un tramo agregado a un hijo de doble rotación lo volvía «una
      vuelta» y re-materializar el grupo lo re-preciaba (y borraba los tramos
      cotizados de la segunda vuelta); con plantilla de 1 tramo y dos
      agregados pedía una doble rotación imposible (`tramosDeHijo` lanza).
      Ahora se cuenta `tramosCotizados(calculo_snapshot)`; sin snapshot con
      tramos (legado), las vivas como antes.
    - **Datos legados NO se migran**: el #364 (escala orden 100,
      `solo_operativa = true`, 4 pax, sin tacos) sigue como estaba —el API
      no tiene un PATCH de `solo_operativa`—; la app (1.1.3+77) y el panel lo
      marcan con el chip ámbar «Lleva pasajeros y no está cotizado: revisa
      la cotización». Para arreglarlo: cancelar ese tramo y volver a
      agregarlo desde «Editar vuelo» (nace comercial en el orden 3), o una
      corrección de datos autorizada. Mismo caso, ya volados: #290 (CZM→CUN
      3 pax) y #213 (MHL→CUN 1 pax), los dos COMPLETADOS.
    - Specs: `tramo-agregado.util.spec.ts` (regla, SERVICIO con y sin pax,
      orden con cancelados, freno por taco/salida real/fecha, DEDUCIDA no
      frena, rango lleno, replay), `flights.service.ola-b.spec.ts` (#364 con
      el DTO real de la app ⇒ orden 3 comercial + aviso, ferry ⇒ 100,
      servicio, freno, replay y carrera de llave con `comercial`, carrera de
      orden ⇒ reintento / 409, lectura fallida),
      `quotes.service.tramos.spec.ts` (guardar SIN adoptar NO lo borra y
      avisa; panel viejo tampoco; ADOPTAR = UPDATE del orden 3 sin INSERT ni
      DELETE; control: un cotizado quitado sí se borra),
      `quotes.service.cotizador.spec.ts` (la vista previa lo conserva),
      `tramos-cotizados.util.spec.ts`, `quotes.service.tramos.spec.ts`
      (re-materializar el GRUPO conserva el tramo agregado; adoptar borra un
      sobrante no cotizado CANCELADO) y `grupo-armador.util.spec.ts`
      (`rotacionesDeHijo`).
    - **Riesgo residual conocido (previo, 0 casos en prod)**: «adoptar la
      operación» re-numera por POSICIÓN (`orden = idx + 1`). Con un tramo
      COMERCIAL cancelado en medio (p. ej. 1, 2 cancelado, 3 agregado), el
      orden 2 cancelado REVIVE con la ruta del 3 y el 3 se borra; si el 3 ya
      tenía tacómetro se conserva y queda DUPLICADO. En prod solo hay 4
      escalas canceladas y todas son operativas.

36. **EXTENSIÓN Y/O ANTELACIÓN DE HORARIO = TRASLADO AL CLIENTE, COMO EL TUA
    (regla 7 ampliada; 1-oct-2026, API 0.0.47, sin migración).** Ale con la
    captura del balance XA-VGV/N4142R, vuelo #192 (CUN-CTM-CUN): «en este
    vuelo me se está poniendo la extensión de servicios como Operación y no
    va en ese apartado». La cotización de #192 cobra el EXTRA «Extensión de
    servicios» ($1,200 USD, ingreso de VuelaTour) y la factura del aeropuerto
    (gasto 8ab208c4, OPERACIONES $4,549.06: «AE-Extension y/o antelacion de
    horario» 3,921.60 + IVA 627.46) caía ENTERA en la columna OPERACIONES:
    costo del avión que no es suyo.
    - **Fuente única `common/desglose-gasto.util.ts`** (spec

      `desglose-gasto.util.spec.ts` con los conceptos REALES de #192 y #190).
      `esExtension` (regex: «extensión [y/o] [antelación] [de] horario |
      servicio(s)», «antelación de horario», «AE-Extension»; una palabra
      suelta «Extensión» NO basta — folio 11 de ASUR la trae y no se toca).
      `desgloseGastoPartes` devuelve además `extension` (con su IVA, mismas
      formas a/b y misma verificación de cuadre que el TUA): Operación =
      total − TUA − FBO − extensión. Un renglón que es FBO o TUA NO es
      extensión (gana el FBO / el TUA). SOLO con extensión, 1-5 ¢ «negativos»
      de Operación (IVA por renglón) los absorbe la extensión; sin ella, la
      regla de siempre (null). `desgloseGastoLineas` imprime «Extensión de
      horario (IVA incluido) - $X MXN» (notas del gasto, sync IA y vista
      previa del panel, que LEE `desglose_lineas` del API: no hay copia).
    - **Claves ASUR sin nombre (6-oct-2026, API 0.0.61):** `CLAVES_TUA = ['130700', '230700']` en `common/desglose-gasto.util.ts` (130700 = TUA nacional Cozumel, factura FEACZM 72139 vuelo #305; 230700 = TUA Cozumel jul-2026). 210100/210200/210300 son aterrizaje/plataformas (operación). Una clave nueva de TUA se agrega SOLO ahí, con la factura que la prueba.
    - **RESPALDO POR TEXTO** (`extensionPorNotas` / `partesDeGasto`): un
      gasto SIN conceptos IA (null, `[]` o sin renglones válidos) de
      categoría OPERACIONES/ATERRIZAJE (`CATS_EXTENSION_POR_NOTAS`) cuya
      PRIMERA línea de notas cumple `esExtension` es extensión COMPLETA
      (monto − propina). Es regla de TEXTO, no de factura: #314 0d2c6f0c
      «extensión de servicio inspector Baraona $500 efectivo». Con conceptos
      IA manda la factura: si no cuadra ⇒ `null` y NO hay respaldo.
      CONSERVADOR (revisión del mismo día): una primera línea que NIEGA la
      extensión («sin extensión de horario», «no hubo extensión…») o que la
      MEZCLA con otro servicio del aeródromo (aterrizaje, plataforma,
      embarque, pernocta, estacionamiento, combustible, TUA, FBO) NO es
      extensión completa — sin factura no hay partes; se queda como siempre.
      Abreviaturas («ext serv», «3 horas ext servicios») tampoco entran.
    - **`trasladosEmbebidosDeGasto(g) → {tua, extension}`** generaliza a
      `tuaEmbebidoDeGasto` (firma vieja intacta = `.tua`): solo gastos CON
      vuelo, nunca parciales de reparto, `CATS_SIN_TUA_EMBEBIDO` ni
      categorías de EMPRESA (cinturón: los lectores ya las saltaban — las
      extensiones de Roman Zúñiga capturadas como OTRO siguen ENTERAS en
      «otros gastos»). Topes: TUA ≤ monto, extensión ≤ monto − TUA. Desde
      el 13-oct-2026 (invariante 66) la TUA sale de UNA prioridad
      (`gasto.tua_incluida` de oficina > renglón reconocido > `tua_monto`
      con tabla que cuadra) y «tuas pagadas», Libro Dinero y pre-cierre leen
      `trasladosPagadosDeGasto` (TUAS entero + la embebida).
    - **Lectores** (todos por la fuente única, ninguno recalcula):
      - Fila del vuelo del Balance (`separarPartes` → `partesDeGasto`): la
        parte extensión NO suma a OPERACIONES ni a OTROS; va en la nota de
        OPERACIONES «Extensión de horario (IVA incluido) $X**» (mismo pie **
        del TUA). Campo ADITIVO `extension_pagada_mxn` al FINAL de la fila y
        en `totales` (libro individual y consolidado), que **solo viaja con
        valor ≠ 0**: sin extensiones el payload es byte-idéntico al 0.0.46.
        Gasto USD con varias partes y Operación 0 (TUA + extensión): el
        −1/−2 ¢ del redondeo proporcional lo absorbe la extensión (antes la
        factura caía ENTERA a OPERACIONES y la extensión se contaba además
        en «Otros movimientos»); sin extensión, la regla de siempre.
      - «Otros movimientos» del general: egreso `CONCEPTO_EXTENSION_PAGADA`
        = «extensión de horario pagada» (sufijos «(parcial: USD sin TC)» /
        «(USD sin TC)» como las TUAS), apareado con la PRIMERA línea EXTRA
        cuyo concepto cumple `esExtension` («Extensión de servicios») o, sin
        ella, fila de SOLO-egreso (remanente −egreso). Fecha = la del gasto.
        `colapsarFilasDeVuelo` lo tipifica «extensión de horario».
      - Libro Dinero «otros ingresos»: la MISMA mecánica que el TUA
        (apareado o solo-egreso «… (sin línea de extensión cobrada | vuelo
        cancelado)»); se ANOTA, no se descuenta de utilidades (solo cuentan
        los ingresos, igual que el TUA).
      - Reparto a socios: se descuenta del costo igual que el TUA embebido
        (solo de lo que SÍ resta: grupo ≠ EXCLUIDO) y sale en la fila
        informativa «Extensión de horario (excluido)» SOLO cuando hubo.
      - Las lecturas de `gasto` de «Otros movimientos», Libro Dinero y
        reparto suman `notas` al select (el respaldo por texto las necesita).
    - **Efecto en prod (SELECT del 1-oct-2026)**: #192 8ab208c4 $4,549.06,
      #190 ccf37888 $4,549.04 (IA) **y b15080c3 $3,648.00** (OPERACIONES,
      `conceptos: []`, «2 horas extension servicio PEV 25 agosto · Proveedor:
      Roman Zuñiga» — entra por el respaldo de texto), #314 0d2c6f0c
      $500.00. Ninguno tiene reparto. Sin cambio: 6e21976a (#192, OTRO,
      «3 horas ext servicios ctm») y 5c88260d (folio 11, «Extensión» suelta
      y factura que no cuadra).
    - **pyservices** (contrato aditivo): con `extension_pagada_mxn` en
      alguna fila o en `totales`, el pie ** dice que TUA y extensión de
      horario son traslados al pasajero y el bloque de totales suma el
      renglón «Extensión de horario pagada del periodo»; sin la llave,
      byte-idéntico. El concepto de «Otros movimientos» y del Libro Dinero
      viaja armado desde el API.

37. **URLs FIRMADAS DE STORAGE: 8 h PARA MINIATURAS + RE-FIRMA ACOTADA
    `POST /v1/storage/firmar` (1-oct-2026, API 0.0.48, sin migración).**
    Reporte de la oficina con capturas de Gastos: «las fotos de las facturas
    no están cargando» — la miniatura de «Comp.» salía como una rayita blanca
    y el visor como una franja delgada. Los archivos estaban sanos: el panel
    firma al RENDERIZAR (`POST /v1/expenses/photo-urls`, entonces 1 h) y la
    pestaña se queda abierta toda la mañana; al vencer, Supabase responde
    HTTP 400 JSON `InvalidJWT · "exp" claim timestamp check failed` y el
    navegador pinta la imagen rota.
    - **Vigencias, fuente única `common/url-firmada.util.ts`**:
      `SEGUNDOS_URL_MINIATURA` = **8 h** para lo que alimenta miniaturas y
      visores que se quedan en pantalla — `expenses.signPhotos` (default del
      parámetro nuevo `segundos`; lo usan Gastos, gastos personales,
      combustibles, detalle de vuelo, caja chica y compras de inventario),
      `flights.tacoPhotos` (`GET flights/:id/taco-photos`), `flights.tacoLive`,
      `aircraft` tacómetros del avión (`GET aircraft/:id/tacometros`),
      `flights.signCobroVouchers` (`cobro-voucher-urls`) y
      `flights.flightPlanUrl` (`GET flights/:id/plan-vuelo-url`: revisión
      adversaria 1-oct-2026 — el detalle del vuelo lo firma al RENDERIZAR y
      lo deja como href de «Ver foto del plan de vuelo» en la misma página
      que las miniaturas; con 1 h el enlace abría el JSON `InvalidJWT`) y
      `POST invoices/file-urls` (`/admin/facturas` firma los enlaces XML/PDF
      del CFDI al renderizar; `signFacturaFiles(paths, segundos)` con
      default 1 h, que sigue usando el buzón de recibidas al clic).
      **Regla**: toda URL que el panel firma al renderizar y el operador
      usa DESPUÉS (miniatura, visor o href) va con `SEGUNDOS_URL_MINIATURA`.
      `SEGUNDOS_URL_PUNTUAL` = 1 h para lo que se usa en el acto: las dos
      lecturas de IA de `expenses` (reanálisis y enriquecimiento offline)
      piden 1 h EXPLÍCITO — la URL se le entrega a un tercero. **NO cambian**
      (se piden al CLIC, no al renderizar): `signedTacoUrl` (IA del
      tacómetro, 1 h), póliza/vencimientos, estado de cuenta de
      conciliación, `invoices/recibidas/file-urls` (1 h) y las de 10 min de
      facturas cliente/emitidas, ingresos y la respuesta de subir un
      comprobante de cobro.
    - **`POST /v1/storage/firmar` {bucket, paths[]} → {urls: {path: url},
      expira_en_s}** (módulo `storage/`, helper PURO `storage-firma.util.ts`
      con spec): el visor del panel (`ImagePreview`) pide aquí una URL NUEVA
      del MISMO archivo cuando la miniatura falla o cuando abre el visor con
      una URL de más de 50 min — sin recargar la página y **sin proxy de
      Vercel** (Active CPU del plan Hobby): las imágenes siguen yendo directo
      a Supabase. Firma con `SEGUNDOS_URL_MINIATURA`. Reglas, en este orden:
      1. **Lista blanca** `BUCKETS_FIRMABLES` (gasto-fotos, taco-fotos,
         cobro-vouchers, planes-vuelo, facturas, estados-cuenta,
         documentos-flota, ingresos, inventario-fotos y, desde el 0.0.49,
         reparto-comprobantes — invariante 38). Otro bucket ⇒ 400
         `BUCKET_NO_PERMITIDO` aun para ADMIN: se firma con la service key y
         `csd` guarda los certificados de sello del SAT. **Un bucket nuevo
         NO entra solo**: agregarlo aquí es una decisión explícita.
      2. **Roles POR BUCKET, default-deny** (`ROLES_POR_BUCKET`; revisión
         adversaria 1-oct-2026): este endpoint **NUNCA firma a un rol más de
         lo que ya le daban** el endpoint específico del bucket o la
         política de lectura de Storage (verificada en prod: gasto-fotos,
         taco-fotos, planes-vuelo y cobro-vouchers ⇒ `authenticated`;
         inventario-fotos público; facturas, estados-cuenta, ingresos y
         documentos-flota SIN política, solo service key). Con «oficina
         firma todo» ANALISTA y SOCIO sacaban estados de cuenta, CFDI e
         ingresos que sus endpoints les niegan. Matriz:
         gasto-fotos y taco-fotos = oficina (ADMIN, COORDINADOR,
         FACTURACION, SOCIO, ANALISTA) + PILOTO/MECANICO; planes-vuelo e
         inventario-fotos = oficina (el PILOTO tiene el plan solo de SUS
         vuelos por `assertAccess`, aquí no hay vuelo que verificar);
         cobro-vouchers, facturas e ingresos = ADMIN, COORDINADOR,
         FACTURACION (= `cobro-voucher-urls`, `archivo-url` de facturas,
         `ROLES_INGRESOS`); documentos-flota = ADMIN, COORDINADOR (=
         `expirations/:id/archivo` y la póliza); estados-cuenta = ADMIN,
         FACTURACION (= conciliación); reparto-comprobantes = ADMIN,
         FACTURACION, ANALISTA, SOCIO (= `GET profit-sharing/pagos` y
         `GET profit-sharing/socios/:id/estado-cuenta`, que al SOCIO solo le
         entregan SUS entregas y sus paths — invariante 38 v2). `@Roles` = la unión. Rol fuera ⇒ 403
         `BUCKET_FUERA_DE_ROL` (el panel pinta su placeholder). VISITANTE ⇒
         403 del RolesGuard. **Un bucket nuevo en la lista blanca exige su
         fila en la matriz** (el tipo `Record<BucketFirmable, …>` no
         compila sin ella) **copiada del `@Roles` de su endpoint**.
      3. **Tope** `MAX_PATHS_FIRMA` = 100 (DTO `ArrayMaxSize` ⇒ 400; el
         helper repite el tope con código `DEMASIADOS_PATHS`).
      4. **Cada path** es la llave DENTRO del bucket tal como vive en la BD:
         sin `/` inicial, sin segmentos `.`/`..`, sin `\`, sin caracteres de
         control, ≤ 1024 y NUNCA una URL completa ⇒ 400 `PATH_INVALIDO`
         (el panel deriva el path de una URL firmada con su propia util).
      Vacíos y repetidos se limpian; `[]` ⇒ 200 sin tocar Storage. Un path
      que no existe NO aparece en `urls` (el panel pinta su placeholder);
      falla de Storage para el lote ⇒ 503 `FIRMA_NO_DISPONIBLE` (el panel
      ofrece «Reintentar»). Specs: `storage-firma.util.spec.ts`,
      `storage.controller.spec.ts` (HTTP con ValidationPipe, filtro y
      RolesGuard reales; matriz por bucket) y `firmas-vigencia.spec.ts`
      (8 h vs 1 h: photo-urls, vouchers, fotos de tacómetro del vuelo, plan
      de vuelo y `invoices/file-urls` vs recibidas).

38. **CUENTA CORRIENTE DEL SOCIO — PAGOS DE UTILIDADES v2 (2-oct-2026, API
    0.0.50; migraciones `20261001000001` y `20261002000001` APLICADAS en
    prod el 1-oct-2026).** La v1 (0.0.49, 1-oct) llevaba un estatus por
    avión × mes; el cliente aclaró por audio el 1-oct: «cuando el socio dice:
    necesito que me adelanten 70,000 pesos de mis utilidades, necesitamos
    poder grabarlo en algún lado y que se lleve el HISTÓRICO de cuánto se le
    ha ido repartiendo a los socios, cuánto falta por repartir, cómo se le
    repartió (transferencia o efectivo), la fecha de la entrega y algún
    comprobante escaneado». Es una CUENTA CORRIENTE por socio. La v1 se
    REFORMÓ (0 filas en prod): ya no existen los estados PENDIENTE/PARCIAL/
    PAGADO/SIN_UTILIDAD por mes, ni `SIN_UTILIDAD_QUE_PAGAR` /
    `PAGO_EXCEDE_UTILIDAD`, ni los items `pagos_socios_pendientes` /
    `pagos_socios_sobrepagados`, ni `GET pagos?mes=` (⇒ 410).
    - **Saldo (lo POR ENTREGAR) = `saldo_inicial_usd` + Σ utilidades
      generadas − Σ entregas vivas.** Estados: |saldo| ≤ $1.00 ⇒
      `AL_CORRIENTE`; > $1.00 ⇒ `POR_ENTREGAR`; < −$1.00 ⇒ `ADELANTADO` (se
      le entregó más de lo generado). Aritmética en CENTAVOS.
    - **Las utilidades NO se guardan**: salen de `compute(primer día, último
      día)` de CADA mes calendario desde `cuenta_desde` hasta el mes EN
      CURSO inclusive (hora Cancún) — jamás un compute de todo el rango: los
      % con vigencia cambian por mes. Del reparto de cada avión se LEE
      `reparto[].monto_usd` (residuo mayor); dos vigencias del mismo socio en
      un mes se suman (`partesDeSociosEnAvion`). Fuente ÚNICA:
      `ProfitSharingService.utilidadesSociosPorMes(meses, mesActual)` →
      `reparto-utilidades.memo.ts#UtilidadesMensualesSocios` (vive en
      ProfitSharingService, dueño de `compute`, para que el pre-cierre y los
      servicios de la cuenta compartan la memoria sin ciclo): meses CERRADOS
      memoizados 10 min en las LECTURAS (un cobro/gasto tardío de un mes
      cerrado se refleja a lo más 10 min después; nadie llama `olvidar()`
      desde cobros ni gastos), el mes en curso JAMÁS se memoiza, ≤ 3
      computes en paralelo, un fallo no se memoiza y SUBE (nunca un número
      parcial). Las ESCRITURAS de entregas (alta y corrección:
      `RepartoPagoService.contexto` ⇒ `contextoSocio({fresco:true})`) piden
      `{fresco: true}`: recalculan sin leer la memoria y la renuevan — el
      candado y `saldo_snapshot_usd` nunca deciden con utilidades viejas.
      El mes en curso viaja aparte (`mes_en_curso_usd`, `en_curso:true`).
    - **El candado del ADELANTO mide lo por entregar de MESES CERRADOS**:
      `por_entregar_cerrado_usd` (ADITIVO en el renglón del resumen y en
      `totales` del estado de cuenta) = por entregar − mes en curso. Contra
      ESE número deciden el 409 del alta y de la corrección, el `disponible`
      de la carrera de altas, `saldo_snapshot_usd` y el aviso
      `socios_adelantados` del pre-cierre. Motivo (revisión 2-oct): el mes en
      curso se mueve — a principios de mes suele ir NEGATIVO (gastos ya
      capturados, ningún vuelo cobrado) y entregar exactamente lo que el
      pre-cierre dice que se debe pedía confirmar un «adelanto» y luego lo
      marcaba adelantado; a medias va POSITIVO y se podía entregar utilidad
      no realizada sin confirmar. `por_entregar_usd` (con el mes en curso) y
      `estado` siguen siendo lo que se MUESTRA (contrato): en los primeros
      días del mes un socio pagado al corriente puede verse «Adelantado» en
      el resumen por los gastos del mes — el diálogo «Registrar entrega»
      debe mostrar `por_entregar_cerrado_usd` como el tope sin confirmación.
    - **Un mes con PÉRDIDA resta** (utilidad negativa del avión ⇒ cargo
      negativo en la cuenta): la cuenta suma lo que dice el reparto, tal
      cual. DECISIÓN DE LA V2 pendiente de confirmar con el cliente (la v1
      no compensaba pérdidas entre aviones); si se decide que la empresa
      absorbe las pérdidas, el cambio es UNA línea en `movimientosDeCuenta`.
    - **Tablas**: `reparto_pago` = una ENTREGA por fila (`socio_id` NOT NULL;
      `aeronave_id` y `periodo` NULL-ables = «corresponde a» INFORMATIVO —
      `periodo` null = ADELANTO A CUENTA; `utilidad_snapshot_usd` legado
      NULL-able, la v2 SIEMPRE lo deja null; `saldo_snapshot_usd` = lo por
      entregar de meses cerrados ANTES de la entrega —el número del
      candado—; `updated_by` = quién corrigió por última vez, sellado por
      el API en TODA escritura: corrección, comprobante, baja y la baja por
      carrera).
      `moneda`/`metodo` TEXTO + CHECK (no el enum), `tc_usd_mxn` (12,6) ⇔
      MXN, `monto_usd` = lo que descuenta (USD = monto; MXN = round(monto /
      T.C., 2) con T.C. en la banda 15–25). Soft delete `deleted_at/_by` +
      `motivo_baja`: **TODO lector filtra `deleted_at is null`**.
      `client_request_id` único parcial (incluye borradas). Bucket privado
      `reparto-comprobantes`. `reparto_cuenta_socio` (opcional por socio):
      `cuenta_desde` (día 1), `saldo_inicial_usd` (positivo = se le debía;
      negativo = ya se le había adelantado), `notas` ≤ 500, `created_*`/
      `updated_*`. **Sin fila ⇒ default 2026-09 con saldo 0 y
      `configurada:false`** (el panel invita a ajustarla).
      **`reparto_bitacora`** (trigger `tg_reparto_bitacora`, AFTER
      INSERT/UPDATE/DELETE en las DOS tablas, patrón `tg_gasto_bitacora`,
      atómico con la escritura): `{tabla, registro_id (reparto_pago.id o
      reparto_cuenta_socio.socio_id), socio_id, accion, actor_id (updated_by;
      deleted_by en la baja; created_by en el alta), diff {col: {antes,
      despues}} de las columnas de NEGOCIO (sellos y llave fuera), snapshot
      (solo DELETE), created_at}`. Es el HISTÓRICO de correcciones del
      dinero entregado y del saldo inicial (sin endpoint todavía: se
      consulta en BD). Sin FK a propósito; RLS sin policies.
    - **Fuentes únicas PURAS** (con spec): `reparto-cuenta.util.ts` (meses
      `mesesEntre`/`mesActualCancun`, `cuentaDefault`/`aCuentaSocio`,
      `estadoCuenta`, `excedeSaldo`, `excedeSaldoEnOrdenDeCaptura`,
      `utilidadMesDesdeAviones`, `armarSociosBase` (universo),
      **`movimientosDeCuenta` = EL CORAZÓN: saldo corrido de toda la cuenta
      — lo leen el resumen, el estado de cuenta, el candado del adelanto y el
      pre-cierre**, `totalesDeMovimientos`, `filaCuentaSocio`,
      `totalesCuentas`, `armarEstadoCuenta`, `resumenPrecierreCuentas`,
      conceptos y textos) y `reparto-pago.util.ts` (UNA entrega: dinero,
      fecha, `aPagoSocio`, orden de captura en microsegundos, path del
      comprobante `<socio>/<entrega>/<uuid>.<ext>`). El panel NUNCA
      recalcula: pinta lo que llega.
    - **Universo de socios** = todos los de `aeronave_socio` (cualquier
      vigencia) ∪ quien tenga cuenta ∪ quien tenga entregas; aviones del
      socio con `porcentaje` (Σ de las vigencias de HOY, o la más reciente),
      `vigente` (hoy) y el ADITIVO `activa`. Nombre sin fila de usuario ⇒
      'Socio' (respaldo de `compute`). Un avión dado de baja NO suma (compute
      solo trae activos) y la cuenta lo AVISA. `socio.es_empresa` (ADITIVO,
      de `usuario.es_empresa`): la propia empresa como socio («Aero Charter
      Cancún») viaja MARCADA en el resumen, el estado de cuenta y los
      `socios[]` del pre-cierre; NO se excluye de nada (decisión pendiente de
      la oficina). **Avisos de la cuenta** (`avisos[]`, texto listo):
      entregas antes del arranque, aviones dados de baja y, por avión-mes
      desde el arranque, los % de los socios ≠ 100
      (`avisosPorcentajesDeReparto`, lee `reparto_porcentaje_total` de
      compute vía `UtilidadMesSocios.aviones[].reparto_porcentaje_total`):
      p. ej. 69 % + 70 % = 139 % cuando se cierra una vigencia y se abre otra
      en el MISMO mes (compute da a cada una su % completo) — la cuenta suma
      lo que dice el reparto, tal cual, y avisa.
    - **Sonda ÚNICA** `reparto-cuenta.lector.ts` (columna
      `reparto_pago.saldo_snapshot_usd`; 42703/PGRST204/42P01/PGRST205 ⇒
      no disponible, re-sondeo ≤ 10 min; mecánica de `columnaOpcional`),
      compartida por los servicios y el pre-cierre (vive APARTE: sin ciclo).
      Lecturas de entregas PAGINADAS (1000, tope 10 páginas ⇒ error, nunca
      recortada); `usuario` en lotes de 150. Sin la migración: lecturas
      `disponible:false`, escrituras 503 `CUENTA_SOCIO_NO_DISPONIBLE`
      (`details.migracion = 20261002000001`) — el 0.0.50 es desplegable
      antes de aplicarla.
    - **Rutas** (literales `socios/…` y `pagos/…`, `@Roles` en CADA una;
      lectura `ROLES_PAGOS_SOCIOS_LECTURA` = ADMIN, ANALISTA, FACTURACION,
      SOCIO; escritura `ROLES_PAGOS_SOCIOS_ESCRITURA` = ADMIN, FACTURACION):
      - `GET socios` ⇒ `{disponible, hasta_mes, socios: [{socio {id, nombre,
        rol, estado, es_empresa}, cuenta {cuenta_desde 'YYYY-MM',
        saldo_inicial_usd, notas, configurada, updated_at}, generado_usd,
        mes_en_curso_usd, entregado_usd, por_entregar_usd,
        por_entregar_cerrado_usd, estado, ultimo_pago {id,
        fecha_pago, monto, moneda, monto_usd, metodo} | null, aviones [{id,
        matricula, porcentaje, vigente, activa}], avisos[]}], totales
        {generado_usd, entregado_usd, por_entregar_usd (Σ de los saldos
        POSITIVOS: un adelanto no compensa lo que se le debe a otro),
        adelantado_usd, socios_por_entregar, socios_adelantados} | null}`.
        SOCIO: solo el suyo (la lectura ya va acotada) y `totales: null`.
      - `GET socios/:socioId/estado-cuenta?desde=YYYY-MM&hasta=YYYY-MM`
        (default arranque … mes en curso; `hasta` futuro se recorta; >120
        meses o invertido ⇒ 400 `RANGO_INVALIDO`; SOCIO ajeno ⇒ 403
        `SOCIO_SOLO_SU_CUENTA` sin leer nada; socio desconocido ⇒ 404
        `SOCIO_NO_EXISTE`) ⇒ `{disponible, socio, cuenta, aviones, desde,
        hasta, saldo_anterior_usd, movimientos [{fecha, tipo SALDO_INICIAL |
        SALDO_ANTERIOR | UTILIDAD | ENTREGA, concepto, mes, aeronave {id,
        matricula} | null, porcentaje, cargo_usd (lo que SUMA; negativo solo
        en un mes con pérdida), abono_usd (lo que RESTA, ≥ 0), saldo_usd,
        en_curso, pago}], por_mes [{mes, utilidad_usd, en_curso, por_avion
        [{aeronave, porcentaje, monto_usd}], entregado_usd (por fecha de
        entrega)}], totales (cuenta COMPLETA de hoy) {generado_usd,
        mes_en_curso_usd, entregado_usd, por_entregar_usd,
        por_entregar_cerrado_usd, estado}, rango
        {generado_usd, entregado_usd, saldo_final_usd}, avisos[]}`. Lo
        anterior a `desde` se colapsa en SALDO_ANTERIOR («Saldo al cierre de
        ago 2026»). UTILIDAD fechada el ÚLTIMO día del mes, una línea por mes
        y avión («Utilidad sep 2026 · N4142R 69 %»; una utilidad de $0 no hace
        renglón); el mismo día: saldo inicial, utilidades por matrícula,
        entregas por captura. ENTREGA «Entrega · Transferencia · ref … ·
        corresponde a sep 2026 · N4142R» o, sin mes, «Adelanto a cuenta ·
        Efectivo · $70,000 MXN a T.C. 18.5». Entregas fechadas antes del
        arranque SÍ cuentan (y se avisa). `pago` = PagoSocio con nombres
        (`entregado_por_nombre`, `created_by_nombre` y los ADITIVOS
        `updated_by` / `updated_by_nombre`), avión y `comprobante_url` (8 h).
      - `PUT socios/:socioId/cuenta {cuenta_desde 'YYYY-MM', saldo_inicial_usd,
        notas?}` ⇒ el renglón del resumen. Sin fila INSERT (`created_by`), con
        fila UPDATE (conserva `created_by`; carrera 23505 ⇒ UPDATE); `notas`
        omitidas = null (PUT reemplaza). 400 `SOCIO_INVALIDO` (no está en
        `aeronave_socio`), `CUENTA_DESDE_FUTURA`, `CUENTA_DESDE_FUERA_DE_RANGO`
        (> 36 meses atrás: cada mes es un compute), `SALDO_INICIAL_INVALIDO`.
      - `GET pagos?desde=YYYY-MM-DD&hasta=YYYY-MM-DD[&socio_id]` ⇒
        `{disponible, pagos: PagoSocio[]}` (vivas, MÁS RECIENTE PRIMERO;
        SOCIO solo las suyas, otro socio ⇒ 403). `?mes=` y `?aeronave_id=`
        (v1; el panel 0.0.49 manda los DOS cuando el reparto está filtrado
        por avión) se DECLARAN en el DTO solo para responder **410
        `PAGOS_POR_MES_RETIRADO`** con un mensaje claro a un panel viejo (sin
        declararlos, `forbidNonWhitelisted` daba un 400 genérico).
      - `POST pagos {socio_id, monto, moneda, tc_usd_mxn?, fecha_pago, metodo,
        referencia?, entregado_por_id?, recibido_por?, factura_folio?, notas?,
        aeronave_id?, mes?, aceptar_exceso?, client_request_id?}` ⇒ 201
        `{pago, cuenta}` (cuenta = el renglón del resumen ya recalculado; la
        respuesta REUTILIZA las utilidades de la misma petición). Orden:
        idempotencia PRIMERO (replay ⇒ 200 `idempotente:true`; llave de otro
        socio o de una entrega borrada ⇒ 409 `CLIENT_REQUEST_ID_EN_USO`),
        dinero (`TC_REQUERIDO`/`TC_NO_APLICA`/`TC_FUERA_DE_RANGO`/
        `MONTO_INVALIDO`), fecha no futura (`FECHA_PAGO_FUTURA`), `mes` no
        futuro (`MES_FUTURO`), quién entregó ACTIVO, socio en
        `aeronave_socio` (`SOCIO_INVALIDO`) y avión del socio (cualquier
        vigencia, `SOCIO_NO_ES_DE_LA_AERONAVE`) — ANTES de calcular
        utilidades —, y el saldo: **monto_usd > por entregar de MESES
        CERRADOS + $1.00 ⇒ 409 `PAGO_EXCEDE_SALDO` `details
        {por_entregar_usd (cerrado), mes_en_curso_usd, monto_usd,
        exceso_usd, saldo_despues_usd}`** («Esta entrega de $X USD supera lo
        que hay por entregar ($Y USD). Se registrará como ADELANTO y el saldo
        quedará a favor de VuelaTour por $Z USD. ¿Registrar?»; si el mes en
        curso ≠ $0 el paréntesis dice «($Y USD, sin contar el mes en curso:
        $W USD)» — `mensajeExcedeSaldo`, el panel copia el `message`) salvo
        `aceptar_exceso` (booleano CRUDO del body): un ADELANTO es legítimo
        y se guarda. `saldo_snapshot_usd` = lo por entregar de meses
        cerrados ANTES. Carreras:
        (a) misma llave ⇒ `replaySiYaQuedo` antes del 409 y el 23505 ⇒
        replay; (b) llaves distintas que juntas rebasan sin confirmar ⇒ tras
        el INSERT se releen las entregas del socio
        (`excedeSaldoEnOrdenDeCaptura`, disponible = saldo inicial +
        generado en meses cerrados): la capturada DESPUÉS se da de baja
        (`MOTIVO_BAJA_CARRERA_ALTA`) liberando su llave y responde el 409
        para confirmar el adelanto con la MISMA llave. Best-effort (si
        falla, la entrega se queda y el pre-cierre la avisa como adelanto).
      - `PATCH pagos/:id` (estado FUSIONADO; no cambia el socio; «corresponde
        a» `aeronave_id`/`mes` sí, `null` los limpia; una entrega de alguien
        que ya no está en `aeronave_socio` SÍ se corrige) ⇒ `{pago, cuenta}`.
        Si el monto en USD SUBE ⇒ se mide contra el saldo de meses cerrados
        SIN esta entrega (409 `PAGO_EXCEDE_SALDO` salvo `aceptar_exceso`);
        corregir el dinero renueva `saldo_snapshot_usd`; sella `updated_by`
        (el valor anterior queda en `reparto_bitacora`). CAS por `updated_at` ⇒ 409
        `PAGO_CAMBIO_CONCURRENTE`; vacío ⇒ 400 `PAGO_SIN_CAMBIOS`.
      - `DELETE pagos/:id {motivo 5–300}` ⇒ `{deleted, cuenta}` (404
        `PAGO_NO_EXISTE` también si ya estaba borrada; el panel CONFIRMA).
      - `POST pagos/:id/comprobante` (multipart `file`, imagen o PDF ≤ 10 MB)
        ⇒ `{pago}`; path `<socio>/<entrega>/<uuid>.<ext>` (el anterior se
        CONSERVA en el bucket), CAS sobre el path (409 `COMPROBANTE_CAMBIO`).
    - **Pre-cierre** (solo mes calendario, NO bloqueantes, solo para
      `ROLES_PAGOS_SOCIOS_LECTURA` — COORDINADOR y sin rol no los reciben ni
      se calcula nada): `socios_por_entregar` («Socios con utilidad por
      entregar»: saldo > $1.00 con las utilidades HASTA el mes del cierre y
      TODAS las entregas registradas hoy — una entrega de octubre por la
      utilidad de septiembre sí limpia septiembre; solo socios cuya cuenta
      ya había arrancado; `count`, `monto_usd`, `socios[≤50] {socio {id,
      nombre, es_empresa}, por_entregar_usd}` mayor primero, `detalle`,
      `lectura_fallida`, `disponible`) y `socios_adelantados` («Socios con
      entregas adelantadas (más de lo generado)»: saldo SIN el mes en curso
      < −$1.00 —utilidades hasta `mesHastaAdelantosPrecierre` = el último
      mes cerrado, o el mes revisado si ES el en curso, para que nadie salga
      «por entregar» y «adelantado» a la vez— y todas las entregas: el MISMO
      número del candado; `socios[] {socio, por_entregar_usd,
      adelantado_usd}`; MISMA forma, incluye `disponible`; solo con la
      lectura buena). Sin la migración o con cualquier fallo ⇒ count 0 +
      `lectura_fallida: true` y un texto que lo dice.
    - **Riesgos / pendientes**: «Aero Charter Cancun S.A. de C.V.» (la propia
      empresa como socio) sale POR ENTREGAR cada mes — ya viaja marcada
      (`es_empresa`); excluirla o separarla es decisión del cliente;
      pérdidas que restan (arriba); `GET socios` lee TODAS las entregas
      vivas y calcula el mes en curso en cada lectura; el PDF/Excel del
      reparto no imprimen las entregas; en LECTURAS la utilidad de un mes
      cerrado puede tardar 10 min en reflejar un cobro tardío (memo; las
      escrituras van frescas). **La utilidad de los meses cerrados NO está
      congelada**: la cuenta los recalcula con los datos de HOY, así que (a)
      dar de baja un avión borra lo que generó (aviso), (b) `PATCH
      /v1/aircraft/owners/:id {porcentaje}` reescribe el % de TODOS los
      meses de esa vigencia (sin aviso: no queda rastro del % anterior) y
      (c) cerrar y abrir vigencia en el mismo mes suma los dos % (aviso de
      Σ % ≠ 100). Las entregas ya hechas pasan a «adelanto» o «por
      entregar» sin que nadie entregue nada. DECISIÓN DE FONDO pendiente con
      el cliente: congelar la utilidad mensual por socio al cerrar el mes
      (snapshot) o rechazar el PATCH de `porcentaje` cuando la vigencia ya
      cubre meses cerrados (forzar cerrar + crear). No se incluyen aviones
      dados de baja en meses pasados a propósito: la cuenta debe cuadrar
      con la pantalla del reparto de ese mes (que tampoco los trae).
      **Rollback del API a 0.0.49 con CUALQUIER entrega v2 capturada:
      PROHIBIDO** (la v1 asume avión, mes y `utilidad_snapshot_usd`).
      Rollback del bucket: Storage API (pie de `20261001000001`).
    - Specs: `reparto-cuenta.util.spec` (N4142R 69/29/2 sobre $2,023.10, el
      adelanto de 70,000 MXN a 18.5 = $3,783.78 que deja ADELANTADO, saldo
      anterior, pérdidas, en curso, pre-cierre), `reparto-pago.util.spec`,
      `reparto-utilidades.memo.spec` (memo, en curso, `fresco`, ≤ 3, fallo),
      `reparto-cuenta.service.spec` y `reparto-pago.service.spec` (BD en
      memoria del mundo compartido `reparto-cuenta.fixture-spec.ts`: cuenta
      default vs configurada, saldo anterior, 409 y `aceptar_exceso` con la
      misma llave, replay y las dos carreras —la de llaves distintas FALLA sin
      la baja—, candado contra meses CERRADOS con octubre en −$345 y en
      +$500, escrituras `fresco`, `updated_by` en toda escritura, SOCIO solo
      la suya, soft delete, sin migración ⇒ `disponible:false`/503),
      `profit-sharing.controller.reparto-pago.spec` (HTTP real: rutas, roles,
      DTO, codes, 410 también con `?mes=&aeronave_id=`) y
      `profit-sharing.service.pagos-socios.spec` (pre-cierre con el
      `computeAvion` REAL, compute UNO por mes con memo, entrega de octubre
      que limpia septiembre, adelanto, mes en curso negativo ⇒ ni por
      entregar ni adelantado, positivo a medias ⇒ adelanto, `es_empresa`,
      COORDINADOR sin items).

39. **MODELO DE IA CONFIGURABLE (2-oct-2026, API 0.0.51, SIN migración).**
    Pedido del cliente en Configuración → Créditos de IA: «dejar una opción en
    la configuración para adaptar el modelo que quieran utilizar, aunque
    ahorita dejaremos por default el que estamos usando actualmente». **En
    prod NO cambia nada al desplegar**: la clave arranca sin configurar ⇒
    pyservices usa su `ANTHROPIC_MODEL` (claude-opus-4-8).
    - **Fuente única PURA** `common/ia-modelo.util.ts` (spec): catálogo
      `CATALOGO_MODELOS_IA` `{id, nombre, descripcion, in_usd_por_millon,
      out_usd_por_millon}` (opus-4-8, sonnet-4-6, haiku-4-5-20251001;
      tarifas DERIVADAS de `TARIFAS`, que `ia-uso.service` ahora EXPORTA
      junto con `tarifaIa`, la regla única de prefijo que también usa
      `costoIaUsd`), `REGEX_ID_MODELO_IA = ^claude-[a-z0-9.-]{3,80}$` (misma
      en pyservices y panel), `esIdModeloValido`, `tarifaDe`,
      `resolverModeloEfectivo`, `headersModeloIa`, `avisoModeloIa` y los
      textos. El panel (`lib/admin/ia-modelo.ts`) guarda una COPIA LITERAL
      del catálogo y de `TARIFAS` con test de paridad (lee este repo si está
      al lado): si cambia aquí, cambia allá en el mismo cambio.
    - **El catálogo SOLO lleva modelos que NO piensan cuando pyservices omite
      `thinking`** (revisión del 2-oct-2026). Sonnet 5 y Opus 5.5 corren
      thinking ADAPTATIVO si se omite (Opus 5.5 ni deja apagarlo: `disabled`
      = 400) y esos tokens cuentan contra los `max_tokens` chicos de
      pyservices (800 tacómetro/gasto→vuelo, 1000 combustible/constancia,
      1024 vencimientos, 2048 compras): la lectura podía salir truncada o
      vacía. Se sacaron del catálogo; siguen elegibles por «Otro» (con
      `AVISO_FUERA_DE_CATALOGO` y su tarifa). **Para volverlos al catálogo**:
      primero pyservices decide `thinking`/`effort` por modelo junto a
      `modelo_actual()` (Sonnet 5: `thinking={'type':'disabled'}`; Opus 5.5:
      `output_config={'effort':'low'}` y más `max_tokens`) y se prueban con
      un ticket y un tacómetro reales.
    - **Tarifas**: Opus 5.5 tiene renglón propio (4/20) ANTES de
      `claude-opus-5` (5/25) — `tarifaIa` toma la PRIMERA coincidencia por
      prefijo y antes caía en la de Opus 5 (+25 %). Su lectura de caché es
      0.05x (`FACTOR_LECTURA_CACHE`, aparte de `TARIFAS` para no cambiar la
      forma de sus renglones); los demás, 0.10x.
    - **Clave `configuracion_sistema.ia_modelo`** (`CONFIG_IA_MODELO`):
      `valor_json = ["<id>"]` — **ARREGLO de un elemento, no string**: el
      CHECK `configuracion_sistema_valor_json_chk` solo admite null o arreglo
      (un string suelto revienta con 23514); se LEE también un string suelto
      por si algún día se relaja. `null` = el del servidor. La fila NO existe
      hasta el primer PUT, que la CREA con `upsert` + `ignoreDuplicates` (ON
      CONFLICT DO NOTHING: `activa: true` y la descripción fija solo al
      nacer) y luego hace `update` de SOLO `valor_json`/`updated_at`/
      `updated_by` — una descripción editada en la BD no se pisa. Se EXCLUYE
      de `GET /v1/config` y `PATCH :clave` la rechaza (400
      `CLAVE_NO_EDITABLE_AQUI`), como las listas (`CLAVES_SECCION_PROPIA`).
    - `ConfiguracionService.modeloIa()` = caché de 60 s (mismo TTL), **nunca
      lanza y nunca tarda más de `TOPE_LECTURA_MODELO_IA_MS` (1.5 s)**: corre
      ANTES de CADA llamada a pyservices (PDFs y Excel incluidos) y
      supabase-js no trae timeout; al vencer aborta la consulta
      (`abortSignal`) y responde el último conocido o null. Tras un fallo no
      reconsulta en `ESPERA_TRAS_FALLO_MODELO_IA_MS` (10 s), las llamadas
      simultáneas comparten UNA consulta y una lectura lenta no pisa lo que
      un PUT/GET escribió mientras tanto (`versionModeloIa`). El PUT y el GET
      rearman el caché al instante en este proceso (otra réplica: ≤ 60 s).
      `headersModeloIa()` ⇒ `{ 'X-IA-Modelo': id }` SOLO con modelo válido.
    - **El header viaja en TODA llamada del API a pyservices que lee con IA.
      OJO: no todas pasan por `PyservicesService`**: visión (tickets,
      tacómetros, combustible, constancia, inventario y `health`),
      vencimientos, compras y conciliación (`parse`, `sugerir`,
      `sugerir-abonos`) hacen su propio `fetch`. Cada uno recibe
      `ConfiguracionService` `@Optional()` (último parámetro; sus módulos
      importan `ConfiguracionModule`) y suma el header; `PyservicesService`
      lo pone en `postForJson`/`postForBuffer`/`getForBuffer`. **Un cliente
      NUEVO de pyservices con IA tiene que hacer lo mismo** o usará el modelo
      del servidor en silencio. Quedan sin header a propósito los que no usan
      IA (`quotes-pdf.service`, `facturacion.client`).
    - **DI**: `ConfiguracionModule` ↔ `PyservicesModule` con `forwardRef` en
      los DOS imports (la ruta GET pide a pyservices su default; pyservices
      lee el modelo configurado). Entre providers no hay ciclo;
      `PyservicesService` inyecta `@Optional() @Inject(forwardRef(() =>
      ConfiguracionService))`. Verificado compilando `AppModule` completo.
    - **Rutas** (literales ANTES de `:clave`, solo ADMIN): `GET
      /v1/config/ia-modelo` ⇒ `{configurado, default_servidor, efectivo,
      catalogo, actualizado_at, actualizado_por_nombre, aviso}`
      (`default_servidor` = pyservices `GET /ia/modelo`, best-effort con
      tope de 5 s: viejo/caído ⇒ null; `efectivo = configurado ??
      default_servidor`); `PUT /v1/config/ia-modelo {modelo: string|null}`
      (DTO: `modelo` obligatorio, string ≤ 200 o null; la forma la valida el
      service ⇒ 400 `MODELO_INVALIDO`; recorta espacios) ⇒ lo mismo que el
      GET. Un id con forma válida FUERA del catálogo se acepta y `aviso` lo
      dice (`AVISO_FUERA_DE_CATALOGO` + `AVISO_SIN_TARIFA` si no tiene tarifa:
      su consumo se registra con costo 0).
    - **Riesgo asumido**: un id con forma válida que Anthropic no conoce
      tumba TODAS las lecturas con IA hasta corregirlo (nadie lo prueba al
      guardar). `GET /v1/vision/health` ya viaja con el modelo configurado:
      sirve para confirmarlo (consume una llamada).
    - Compatibilidad: pyservices viejo ignora el header; API viejo no lo
      manda. Orden de deploy pyservices → API → panel, tolerante en
      cualquier orden. Specs: `ia-modelo.util.spec`, `ia-uso.service.spec`,
      `configuracion.ia-modelo.spec` (alta sin pisar la descripción,
      arreglo, caché, tope, espera tras fallo, lectura compartida,
      invalidación, exclusión, PATCH),
      `configuracion.controller.ia-modelo.spec` (HTTP real),
      `pyservices.service.ia-modelo.spec` (incluye BD colgada ⇒ la petición
      sale a los 1.5 s sin header) y `vision.service.ia-modelo.spec`
      (visión, vencimientos, compras y conciliación `parse` / `sugerir` /
      `sugerir-abonos`).

40. **1 CARGO DEL BANCO ↔ N GASTOS («lote», 2-oct-2026, API 0.0.52,
    migración `20261002000002_conciliacion_partes.sql`).** Caso real
    (verificado en prod): 29 «Pago VIP SAESA» capturados por Jimmy Chi el
    30-sep y los SPEI del 24-sep de GASTOS GNRAL — 8,404.20 = 3 × 2,801.40
    (#315, #319, #326), 4,462.75 = 2,231.37 + 2,231.38 (o 2 × 2,231.37 +
    0.01: SAESA factura 2,231.375) y 2,236.25 = 2 × 1,118.12 + 0.01. Hasta
    el 0.0.51 el modelo era 1 gasto ↔ N cargos y un cargo no podía pagar
    varios gastos.
    - **Ligado a gasto = `gasto_id is not null or gastos_n > 0`.**
      `movimiento_bancario.gasto_id` es un ESPEJO (el gasto cuando hay UNA
      parte; null con 0 o ≥ 2) que siguen leyendo panel/app viejos y el embed
      `gasto:gasto!gasto_id(...)`. La FUENTE ÚNICA de la liga es la puente
      `movimiento_bancario_gasto (movimiento_id, gasto_id, monto_parte,
      moneda = la de la CUENTA del cargo)`; `gastos_n` = número de partes.
      **`gasto.conciliado` y `gasto.tc_gasto` los escribe SOLO la función de
      BD `recalcular_gasto_conciliado`** (el TS ya no los escribe con la
      sonda encendida). **El centavo del lote vive en `gastos_diferencia` y
      JAMÁS se ajusta el gasto.**
    - **Reglas** (espejo puro en `conciliacion-parcial.util.ts`, con spec y
      los montos SAESA; el candado real es la BD): parte CRUZADA =
      `parte.moneda ≠ gasto.moneda` (solo el 1 ↔ 1 USD↔MXN). Por gasto: Σ
      partes no cruzadas ≤ `gasto.monto + 1.00`. Lote (N ≥ 2): todos en la
      moneda de la cuenta (`LOTE_MONEDA_DISTINTA`), cada gasto entra por su
      `faltante_lote` (`faltanteLote`: 0 si sus OTRAS partes ya lo cubren;
      si no `monto − Σ partes no cruzadas de OTROS cargos` — las de este
      cargo no cuentan, así el reemplazo [A] → [A, B] no rebota) o
      `GASTO_YA_CUBIERTO`, y `|Σ − |cargo|| ≤ toleranciaLote(N) =
      least(1.00, greatest(0.02, 0.01 × N))` o `CARGO_NO_CUADRA`
      (`puedeRepartirCargo`). No existe el «cargo parcial». Con N = 1 la
      regla de siempre (`puedeLigar`, `monto_parte = |monto|`). Solo un
      CARGO admite partes (400 `SOLO_CARGOS`).
    - **Sonda ÚNICA** `common/partes-disponible.util.ts`
      (`partesDisponibles` = `columnaOpcional(movimiento_bancario.gastos_n)`,
      re-sondeo ≤ 10 min; `errorPartesNoDisponibles` ⇒ 503
      `CONCILIACION_PARTES_NO_DISPONIBLE`). `esPartesAusentes` ⇒ 503 SOLO
      con `PGRST202`/`PGRST205` o un 42883/42P01 cuyo mensaje NOMBRA
      `OBJETOS_PARTES` (las 2 RPC, la puente, la vista); **42883 también es
      «operator does not exist» (el `public.moneda = text` del 15-sep): eso
      sube como 500 con su texto real**, y `errorRpcPartes` registra en el
      log el code y el mensaje de Postgres ANTES de traducir (antes se
      disfrazaba de «falta aplicar una actualización» y se perdía). **El «sí»
      de la sonda se memoriza para siempre: si se ejecuta el ROLLBACK de
      20261002000002 hay que REINICIAR o redesplegar el API** (si no, lista,
      resumen y reporte responden 500 por `gastos_n` y la liga 503).
      **REGLA DURA: todo select/update/filtro que nombre `gastos_n`, la
      puente o `v_gasto_conciliacion` va detrás de la sonda.** Las partes se
      leen con `leerPorLotesPaginado` (lotes de 200 ids, cada uno paginado
      por la PK con `.order().range()`: 200 cargos × 50 partes rebasan el
      tope de 1000 de PostgREST). Sin la migración: lectores con el espejo y |monto|
      (0.0.51), `link()` con UN gasto por el camino directo
      (`linkDirecto`, intacto) y lote / candidatos ⇒ 503 (spec que falla si
      alguna consulta nombra lo nuevo).
    - **`PATCH /v1/conciliacion/movimientos/:id`** (ADMIN, FACTURACION):
      `LinkMovimientoDto.gasto_ids?: string[] | null` (1..50, únicos, uuid;
      `null` = ausente) además de `gasto_id`. Los DOS en el cuerpo ⇒ 400
      `LOTE_INVALIDO` (`loteInvalido`: presente = `!== undefined`; con
      target ES2022 `'gasto_id' in dto` siempre es true). `gasto_ids` de UN
      elemento = `gasto_id`; `gasto_id: null` desliga TODO (también un lote).
      Con la sonda la escritura es SOLO por las RPC
      `conciliacion_ligar_cargo_gastos(p_movimiento_id, p_gasto_ids,
      p_actor)` (valida, escribe la puente como DIFF y recalcula; una
      re-liga idéntica es no-op) y `conciliacion_desligar_cargo_gastos`;
      antes, en TS y con los MISMOS textos, la pre-validación (`puedeLigar` /
      `puedeRepartirCargo`) para responder 409 sin tocar nada. Lote sobre un
      cargo que ya paga ≥ 2 y llega UN gasto ⇒ 409 `MOVIMIENTO_CON_LOTE`
      (panel viejo). Error de la BD: `code = hint ?? prefijo «CODIGO:»`,
      `details` = el JSON de `detail` sobre los de la pre-validación
      (`leerErrorPartes`); `GASTO_YA_CUBIERTO` conserva su forma (con el
      `includes('MONEDA')` anidado) + `details.gasto_id`; 409:
      `CARGO_EXCEDIDO`, `CARGO_NO_CUADRA {monto_cargo, suma_gastos,
      diferencia, tolerancia, moneda, gastos[{id, monto, faltante}]}`,
      `LOTE_MONEDA_DISTINTA {gasto_id, moneda_gasto, moneda_cuenta}`,
      `MOVIMIENTO_CON_LOTE`, `MOVIMIENTO_YA_LIGADO`, `REVERSO_INVALIDO`,
      `LOTE_SOLO_API_NUEVO`, `PARTES_INCOHERENTES` y `CARGO_LIGADO` (el
      cargo cambió: `MENSAJE_CARGO_CAMBIO`); `LOTE_INVALIDO` ⇒ 400. Sus
      textos salen de helpers (`mensajeErrorPartes`,
      `mensajeLoteInvalidoDeBd`), NUNCA del texto de la BD (trae uuid
      crudos). `GASTO_YA_CUBIERTO`: `details.motivo` de la BD gana
      (`motivoGastoCubiertoDeBd`; el `includes('MONEDA')` queda de
      respaldo) y un gasto ya cubierto 1 ↔ 1 en otra moneda se explica como
      MONEDA_DISTINTA (`afinarMotivoGastoCubierto`). Lote con la moneda de
      la cuenta ilegible ⇒ 503 `CUENTA_SIN_MONEDA` (`errorSinMonedaCuenta`,
      el mismo de los candidatos), jamás un LOTE_MONEDA_DISTINTA. Los ids se
      comparan en minúsculas (`normalizarUuid` en `link`/`linkGastos`). Respuesta: la fila
      RELEÍDA (`movCols()` + `gastos_n`) + `gastos_estado[{gasto_id,
      monto_parte, moneda, gasto_conciliado, monto_vinculado, faltante}]`
      (de `v_gasto_conciliacion`) SIEMPRE y, con exactamente UNA parte, los
      tres planos de siempre (null con 0 o ≥ 2). Desligar un movimiento sin
      partes es un no-op (ya no le quita la clasificación). Textos nuevos:
      `MENSAJE_LOTE_AMBOS`, `mensajeLoteInvalido`, `MENSAJE_SOLO_CARGOS`,
      `mensajeMovimientoConLote`, `mensajeLoteMonedaDistinta`,
      `mensajeCargoNoCuadra`, `textoSinPrefijo` (todos con spec).
    - **`GET /v1/conciliacion/movimientos/:id/gastos-candidatos`** (ADMIN,
      FACTURACION; `GastosCandidatosQuery {q ≤ 80, dias 1..180 = 30,
      limite 1..300 = 100}`): gastos bancarios sin conciliar (con pago
      parcial, por su faltante) en la moneda de la cuenta y ±`dias` de la
      fecha del cargo; en cuenta MXN y sin `q`, también USD con T.C.
      implícito 15–25 (`cruzado: true`, al final; desde el 0.0.75 con
      cualquier búsqueda, con `tc_cruce`, en su nivel y con `tc_oficial` en
      la raíz: invariante 70). `q`
      (`interpretarBusquedaGasto`, `gastos-candidatos.util.ts`): entero ⇒
      [q, q+1), con decimales ⇒ ±0.01, texto ⇒ DOS consultas (proveedor
      `ilike` ≤ 50 ids, luego `or(notas|lugar|folio_ticket ilike,
      proveedor_id.in)` con `patronIlikeSeguro` de facturas-emitidas). Orden
      `ordenarCandidatosGasto`: los que cuadran (|monto o faltante − cargo|
      ≤ 1.00), cercanía de monto, cercanía de fecha, fecha desc. Respuesta
      `{movimiento {id, fecha, monto, moneda}, ventana {desde, hasta},
      candidatos (forma de la IA + cruzado?, nota, lugar, vuelo_folio,
      matricula, capturado_por, monto_vinculado, faltante), truncado}`
      (tope de lectura 1000). ABONO ⇒ 400 `SOLO_CARGOS`; sin sonda ⇒ 503.
      La ficha del candidato es UNA (`aCandidatoGasto`, la misma de la IA).
    - **`excluidos`: POR QUÉ un gasto NO es candidato (6-oct-2026, API
      0.0.63, sin migración).** Caso real: cargo de $212.00 del 07-sep
      (ASUR CANCUN, GASTOS GNRAL); la oficina buscó «212», vio «Ningún gasto
      pendiente coincide…» y creyó que era un bug: los TRES gastos de $212.00
      (estacionamiento ASUR del 24, 27 y 28-sep, #338 y #330) estaban en
      EFECTIVO. **Solo con `candidatos` VACÍO** viajan los ADITIVOS
      `excluidos` y `excluidos_monto`; con candidatos la respuesta es
      byte-idéntica al 0.0.62 y NO hay consulta extra. Se hace UNA consulta a
      `gasto` por monto (`rangoMontoExcluidos`: el MISMO rango que la
      búsqueda de los candidatos —entero «212» ⇒ [212, 213), «2801.40» ⇒
      ±0.01—; sin `q` o con texto, el |monto| del cargo ±0.01; revisión
      6-oct-2026: con 212.00 ±0.01 un efectivo de $212.40 que la búsqueda
      «212» sí abarca quedaba sin explicar; `excluidos_monto` sigue siendo
      212) y fechas (±max(120, dias) del cargo), SIN filtro de medio, conciliado
      ni moneda; el tope de 1000 no aplica (`.limit(500)`). Clasificación
      PURA en `conciliacion/candidatos-excluidos.util.ts` (spec), con
      precedencia `EFECTIVO_U_OTRO_MEDIO` (medio ∉ `MEDIOS_BANCARIOS`:
      EFECTIVO, BODEGA, PERSONAL_*) > `YA_CONCILIADO` > `OTRA_MONEDA` >
      `FUERA_DE_VENTANA` (dentro de ±120 pero fuera de ±dias); un gasto que SÍ
      es del universo (no lo trajo la búsqueda de TEXTO) no se reporta.
      Forma: `excluidos: [{motivo, n, gastos: [{id, fecha_gasto, monto,
      moneda, medio_pago, categoria, vuelo_id, vuelo_folio,
      conciliado_con?}]}]` — grupos en ese orden fijo y solo con gastos; `n`
      = TODOS los del motivo; `gastos` = los 5 más CERCANOS al cargo, en orden
      cronológico. `conciliado_con` SOLO en `YA_CONCILIADO`:
      `[{movimiento_id, fecha, monto (monto_parte), moneda, cuenta (alias)}]`
      de la puente (`[]` sin partes; `null` si esa lectura falla). BEST-EFFORT:
      si la consulta extra falla, la respuesta sale SIN los dos campos (el
      panel pinta el vacío de siempre). `MEDIOS_BANCARIOS` se mudó a
      `gastos-candidatos.util.ts` (fuente única del universo y del motivo).
      Specs: `candidatos-excluidos.util.spec` y el bloque «excluidos» de
      `conciliacion.service.lote.spec` (caso real, mezcla de motivos, con
      candidatos no viaja, `q` de texto ⇒ monto del cargo, best-effort).
      Con `incluir_no_bancarios` (mismo 0.0.63) el efectivo y los
      PERSONAL_* entran al universo y dejan de ser `EFECTIVO_U_OTRO_MEDIO`
      (solo BODEGA lo sigue siendo): **invariante 48**.
    - **Lectores** (sobre la puente / `v_gasto_conciliacion`, regla de parte
      cruzada; nunca el |monto| del movimiento): `sumasLigadasDe`,
      `cargosDeGasto` (monto = `monto_parte`), `leerCargosDeGastos` y
      `conciliacionDeGasto` (conciliación al revés, invariante 71; la puente
      con su autor por `partesDeGastos({conAutor})`), `estadoConciliacion`,
      `conflictoGastoCubierto` (`details.movimientos[].monto_parte` y
      `details.gasto_id`), `candidatosCercanos`, `gastosSinBanco`,
      `reporteGastosSinBancoXlsx`, `candidatoPorFaltante`,
      `intentarCruzarGasto`, `expenses.anexarConciliacionParcial`,
      `expenses.cargosBancariosDe` (cuenta PARTES: el 409
      `GASTO_CONCILIADO` + `details.movimientos_ligados` no cambia),
      `inventory.gastosDeMovimiento`. `inventory.revertirGastoPorDevolucion`
      SALTA los gastos con cargo del banco ligado (ni DELETE ni ajuste del
      monto) y LEE el error del DELETE y del UPDATE: el que falla se salta y
      se sigue con el siguiente (lo que falte queda en `sin_revertir`).
      `GET movimientos` (ADITIVOS, en lote por página, best-effort: si una
      lectura falla no se anota NADA): `gastos_n`, `gastos:
      MovimientoGasto[]` (+ `monto_parte`, `moneda_parte`, `monto_vinculado`,
      `faltante`, `lugar`, `notas_primera_linea`; sin `notas` crudas),
      `gastos_suma`, `gastos_diferencia` (`diferenciaLote`: |monto| − Σ;
      null sin partes o con parte cruzada). `resumen` por cuenta:
      `diferencia_lotes` (Σ de los cargos con ≥ 2; null si la lectura
      falla). Excel: «Conciliado con» = `etiquetaConciliadoLote` («3 gastos:
      Operaciones · vuelo #315 ($2,801.40) · …» + «· diferencia $0.01») y
      «Matrícula» = unión con « + »; con UNA parte, como siempre.
      `clasificarMovimiento` (no clasifica un cargo con partes; «quitar» no
      lo desconcilia), `linkCobro` (`conciliado … || gastos_n > 0`; y un
      movimiento ligado a gasto(s) NO admite un cobro/sobre: 409
      `MOVIMIENTO_YA_LIGADO` `mensajeMovimientoConGastos` — la BD no tiene
      CHECK de exclusividad gasto ↔ cobro y su dinero se contaría dos
      veces) y `linkIngreso` usan `ligadoAGasto`. `ingresos.leerAbono` no aplica
      (ABONO).
    - **Fuera de alcance (v1)**: `UpdateGastoDto.conciliado` (override
      manual) sobre un gasto con partes se SOBRESCRIBE en el siguiente
      cambio de la puente; `anotarMotivoPendiente` no propone lotes (criterio
      SUMA) y la IA tampoco.
    - Specs: `partes-disponible.util.spec`, `conciliacion-parcial.util.spec`
      (SAESA real, tolerancia, textos, `leerErrorPartes`, Excel),
      `gastos-candidatos.util.spec`, `auto-cruce.util.spec` (desfase),
      `reverso-cruce.util.spec` (gastos_n), `dto/conciliacion.dto.lote.spec`
      (plainToInstance + validate), `conciliacion.service.lote.spec` (lote
      SAESA, 409/400/503, desligar, reemplazo, no-op, lectores, candidatos y
      «sin migración»), `conciliacion.controller.lote.spec` (HTTP real),
      `conciliacion.service.parcial.spec` (TODO el contrato del 14-sep en
      los dos modos; se borró el caso 23505 obsoleto), y los fakes de
      `autocruce`, `reverso`, `ingresos`, `expenses.service.conciliado` e
      `inventory.service.eliminacion` con la RPC emulada
      (`conciliacion-partes.fixture-spec.ts`: G/H/B/I y la vista en memoria,
      fuera del build y de jest).
    - **Orden de deploy**: migración (dry-run → aplicar → advisors) → API
      0.0.52 → panel ENSEGUIDA (un panel viejo pinta un lote como
      «Pendiente» y ofrece «Vincular gasto»: el API responde 409
      `MOVIMIENTO_CON_LOTE`, no destruye nada). Con la migración y el API
      0.0.51, el trigger de compatibilidad de la BD mantiene la puente (y el
      camino directo del 0.0.52 traduce sus códigos a 409 en la ventana de la
      sonda).

41. **EDITAR DATOS DEL PILOTO DESDE «PILOTOS» (2-oct-2026, sin migración).**
    `PATCH /v1/users/:id` = ADMIN y COORDINADOR; el controller pasa el rol
    (`users.update(id, patch, updatedBy, actorRol?)`; sin rol —llamados
    internos como `softDelete`— = ADMIN). ADMIN sin cambio. COORDINADOR
    (fuente única PURA `users/usuario-edicion.util.ts`, con spec): (1) solo
    campos ⊆ {nombre, telefono, apodo, tarjeta_terminacion} — «presente» =
    `!== undefined` (el DTO ES2022 define TODAS sus llaves) — si no 403
    `SOLO_ADMIN_EDITA_USUARIOS`; (2) solo si el destino es `rol = 'PILOTO'` o
    `es_piloto_externo = true`: alguien de oficina que también vuela
    (`es_piloto` con rol ADMIN/SOCIO/…, p. ej. Pablo Canales) NO cuenta ⇒ 403
    `SOLO_ADMIN_EDITA_USUARIOS` «Ese usuario es de oficina: solo un ADMIN lo
    edita»; (3) la tarjeta debe estar LIBRE o ya ser del piloto, si no 403
    `TARJETA_DE_OTRO_USUARIO` «Esa tarjeta es de <nombre>: un ADMIN la
    reasigna desde Tarjetas corp.». Todo ANTES de escribir nada. `pilots`
    `USUARIO_COLS` lleva `es_piloto` en duro y `apodo` con la MISMA
    degradación que `users.service`. **La tarjeta del gasto se SELLA al
    capturar** (`gasto.tarjeta_terminacion`): cambiar la tarjeta del piloto no
    toca gastos anteriores (salvo uno viejo SIN terminación que se edite con
    medio TARJETA_CORP). Procedimiento: alta de la tarjeta nueva en Tarjetas
    corp. (ADMIN) → vincularla al piloto → INACTIVAR la vieja (nunca editar su
    terminación). Specs: `usuario-edicion.util.spec`,
    `users.controller.pilotos.spec` (HTTP real con el servicio real) y
    `pilots.service.es-piloto.spec`. Deploy: API antes que panel.

42. **FECHA NUEVA EN LA COTIZACIÓN ⇒ «¿mover también el vuelo operativo?»
    (5-oct-2026, API 0.0.55, sin migración).** Pedido del cliente: al guardar
    una cotización con OTRA fecha, un modal pregunta si el vuelo operativo se
    mueve también (solo FECHA: la hora de cada tramo se edita desde el
    vuelo). `revise` NO cambió: escribe `vuelo.fecha_vuelo` y NO mueve los
    tramos — salvo los EXTREMOS que no tenían fecha, que `replaceEscalas`
    llena con la salida/regreso NUEVOS (`fechas.inicio/fin`). Si la oficina
    dice «Sí» (o usa la banda del detalle del vuelo), el panel llama
    `POST /v1/flights/:id/tramos/alinear-fecha` (ADMIN, COORDINADOR; 200;
    `AlinearFechaTramosDto {fecha_vuelo?}` — el panel manda `{}` y vale la
    `fecha_vuelo` persistida). **REGLA RECTORA (revisión 5-oct-2026): el «Sí»
    mueve el vuelo OPERATIVO y jamás reescribe lo que la cotización acaba de
    guardar.**
    - **Plan PURO** `flights/alinear-fecha.util.ts#planAlinearFecha` (spec):
      tramos VIVOS por `orden`; **referencia** = primer tramo con
      `fecha_salida_plan`, salvo que esté EXACTAMENTE en el instante objetivo
      y algún tramo posterior tenga un día anterior (revise llenó el tramo 1
      vacío con la salida nueva: `se_conserva: 'ya_en_la_fecha'`, no se mueve
      y la referencia es el siguiente). `delta_dias` = objetivo − referencia
      (días calendario Cancún, `diasEntreDiasCancun`); cada tramo que se
      recorre CONSERVA SU HORA DE PARED (`common/fecha-cancun.util#
      moverDiasHoraParedCancun`: jamás 86 400 s a ciegas); sin fecha se queda
      sin fecha. **Delta 0 ⇒ no escribe nada** (idempotente). Sin ningún
      tramo con fecha, el primero recibe el objetivo tal cual
      (`delta_dias: null`).
    - **El REGRESO (`fecha_traslado_final`) es de la COTIZACIÓN** («Fecha
      traslado final» del formulario) y se RESPETA mientras sea coherente
      (su día Cancún ≥ el día objetivo). Se recorre `delta` días SOLO si (a)
      quedó ANTES de la salida nueva (`delta > 0`: la oficina olvidó el
      regreso; en prod, 3 de los 79 vuelos con regreso de los últimos 120
      días lo tienen así) o (b) el vuelo operativo era
      de UN DÍA (todos los tramos con fecha y el regreso en el día de la
      referencia): un viaje de un día se mueve completo, regreso incluido
      (71 de esos 79 lo tienen el mismo día de la salida). Si
      el regreso NO se mueve y es coherente, los tramos —salvo la
      referencia— que YA están en su día se quedan (`se_conserva:
      'dia_del_regreso'`): revise llenó el tramo final vacío con el regreso
      nuevo, o la operación ya coincide. Bug que esto cierra (repro de la
      revisión): t1 10-oct, t2 sin fecha, sin regreso; la oficina guardó
      salida 15 y regreso 17-oct 16:00 ⇒ revise llenó t2 = 17 y el «Sí»
      corría t2 Y el regreso de la cotización al 22 (15 de 63 vuelos
      abiertos tenían el último tramo sin fecha ni regreso). Ambigüedad
      aceptada: sin saber qué cambió la oficina en ESE guardado, un viaje de
      varios días con el regreso intacto sigue a la cotización (acortarlo o
      alargarlo no se adivina). El arreglo exacto exige que el panel mande
      `tramos_antes` / `fecha_traslado_final_antes` (campos ADITIVOS, NO
      implementados: la banda del detalle del vuelo no los tiene).
      `vuelo.fecha_vuelo` NO se toca nunca (tampoco con `fecha_vuelo` en el
      cuerpo: eso solo mueve la operación).
    - **`fecha_vuelo` del cuerpo = instante ISO CON hora y zona**
      (`RE_INSTANTE_ISO_CON_ZONA` + `MENSAJE_FECHA_VUELO_SIN_ZONA`, 400):
      `@IsDateString` solo aceptaba «2026-10-13» (medianoche UTC = el 12 en
      Cancún) y «2026-10-13T02:00» (TZ del servidor).
    - **Candados ANTES de escribir**: 404 `VUELO_NO_EXISTE`; 409
      `VUELO_CANCELADO`; 409 `VUELO_YA_VOLO` «La operación ya empezó: la
      fecha de cada tramo se edita desde el vuelo.» (fuente única
      `estadoVueloVolado`: EN_VUELO/COMPLETADO o algún tramo VIVO con
      tacómetro); 400 `SIN_FECHA`. Textos y errores en el util (con spec).
    - **Escritura con CAS por tramo** (`escribirFechaTramo`: fecha LEÍDA con
      `aplicarCas` —o `is null`—, tramo vivo y SIN tacómetro). El tramo
      **ANCLA** (`plan.ancla_id`: la referencia, o el que recibe el objetivo)
      se escribe PRIMERO: si su CAS falla, el delta ya no vale ⇒ **409
      `OPERACION_CAMBIO`** sin mover nada (antes movía el resto con un delta
      viejo y respondía 200). Otro tramo que cambió entre la lectura y la
      escritura NO se pisa (`movido: false`). Regreso con CAS sobre
      `fecha_traslado_final`. Si la BD falla a medio camino, lo ya movido se
      REGRESA (`revertirAlineacion`) y responde **503 `TRAMOS_NO_MOVIDOS`**
      (`details.revertido`); a medias (`revertido: false`) se refrescan igual
      permisos y Google. Con la reversa fallida un reintento da delta 0 (el
      ancla ya está en el día nuevo) y los tramos que faltaron se corrigen a
      mano desde el vuelo — lo dice el texto del 503.
    - **Después** (solo si algo se movió): `refreshPermisosDeVuelo`,
      `calendar.syncFlight` (`refrescarTrasAlinear`, nunca lanza) y un aviso
      PROPIO a la tripulación `avisoOperacionMovida` («Vuelo #N: la operación
      cambió de día» · «Tramos movidos (hora Cancún): CUN → HOL jue 15 oct
      08:00 · HOL → CUN sáb 17 oct 16:00.», solo los tramos MOVIDOS, más de 4
      ⇒ 3 y «y N más»; `tipo` de siempre `vuelo_asignado`). NO es el texto
      de reagenda: `revise` ya mandó segundos antes «Vuelo #N reagendado ·
      ahora sale <fecha de la cotización>» y repetirlo con la hora del tramo
      daba al piloto dos «ahora sale» con horas distintas (desviación
      consciente del contrato, que pedía el mismo texto). Es el SEGUNDO aviso
      de la secuencia. `avisoReagendaVuelo` queda solo para «Editar datos»
      (`update`); **revise conserva su PROPIA copia de esa plantilla**
      (pendiente migrarla al helper cuando se toque revise). Sin tripulación,
      sin aviso.
    - **Respuesta** `{vuelo_id, folio, delta_dias, fecha_objetivo, tramos
      [{id, orden, origen_iata, destino_iata, fecha_salida_plan_antes,
      fecha_salida_plan, se_conserva, movido}], fecha_traslado_final,
      tramos_movidos}` + ADITIVOS `fecha_traslado_final_antes`,
      `fecha_traslado_final_movida` y `tramos[].se_conserva`.
    - Specs: `alinear-fecha.util.spec` (incluye el repro de la revisión,
      salida y regreso movidos, hacia atrás con el tramo llenado, viaje de un
      día hacia atrás con y sin regreso movido, viaje acortado, tramo 1
      llenado, regex del DTO y el aviso propio), `fecha-cancun.util.spec`,
      `flights.service.alinear-fecha.spec` (BD en memoria que interpreta los
      filtros: repro, 409 del ancla sin escrituras, 503 a medias con
      refrescos, aviso solo con lo movido) y
      `flights.controller.alinear-fecha.spec` (HTTP real con RolesGuard;
      `fecha_vuelo` sin zona ⇒ 400). Deploy: API antes que panel (con un API
      viejo el «Sí» responde 404 y el panel lo explica).

43. **COMBUSTIBLE POR AERONAVE: LA CARGA GAS SE AJUSTA AL COMBUSTIBLE DEL
    AVIÓN (5-oct-2026, API 0.0.56, migración `20261005000001`).** Caso real:
    Luis capturó desde la app 74 L para el vuelo #280 del XB-PEV (Chetumal,
    tarjeta ****0585) y eligió «Turbosina»; el PEV (Cessna 205, pistón) solo
    carga AVGAS y el balance Excel del avión mostró «Combustible TURBOSINA».
    Pedido aprobado: «dejar registrado en cada avión qué combustible usa, y
    que al capturar una carga el sistema la ajuste al combustible del avión y
    la marque para revisión si el piloto eligió otro».
    - **Dato**: `aeronave.combustible` text NOT NULL default 'AVGAS' + CHECK
      `aeronave_combustible_chk` (AVGAS | TURBOSINA; texto, NO enum). Las
      turbinas son N58BT y N621TX; el resto AVGAS. `gasto.tipo_combustible`
      sigue TEXT sin enum y NO se migró (el 5-oct las 134 cargas GAS ya
      coincidían con su avión; 82 en null).
    - **Fuente única PURA** `common/combustible.util.ts` (spec):
      `COMBUSTIBLES`, `COMBUSTIBLE_DEFAULT`, `normalizarCombustible`,
      `etiquetaCombustible` (**«Gasavión» / «Turbosina»**: así le dice el
      cliente al AVGAS, como el botón de la app, el selector del panel y la
      categoría «Gasavión / Turbosina»; las etiquetas son SOLO texto: lo
      persistido sigue siendo `AVGAS` / `TURBOSINA`),
      `resolverTipoCombustible({capturado, delAvion, matricula, motivo?}) →
      {tipo, nota, corregido, rellenado, …}`: sin `delAvion` ⇒ tal cual;
      `capturado` vacío ⇒ el del avión SIN nota (`rellenado`); igual ⇒ nada;
      distinto ⇒ el del avión + `nota` CON ETIQUETAS «⚠ se capturó Turbosina
      pero el XB-PEV carga Gasavión: se corrigió a Gasavión — revisar»
      (`motivo: 'cambio_avion'` ⇒ «⚠ el gasto traía Turbosina pero …»).
      Además `anexarLineaUnica` (sin duplicar), `leerNotaCombustible` /
      `notasCombustible` / `quitarNotaCombustible` (la nota tiene forma
      EXACTA: es la clave para leerla y retirarla, como
      `quitarAvisoAvionTramo`; por tolerancia también reconocen la forma
      vieja con códigos «… carga AVGAS: se corrigió a AVGAS …», y el PATCH
      no la duplica en la forma nueva), `reescribirLineaCombustible`
      (abajo), `ajustarCombustiblePatch` (regla del PATCH, abajo),
      `avisoCombustibleCorregido` (push a oficina; el cuerpo NO repite el
      título), `avisoFilaCombustible` (carga masiva, `preview` / `guardada`)
      y `MENSAJE_COMBUSTIBLE_INVALIDO` (400 del DTO: «El combustible del
      avión es Gasavión (AVGAS, pistón) o Turbosina (TURBOSINA, turbina).»).
      Push, avisos de la masiva y nota usan las ETIQUETAS, nunca el código
      crudo; los dos textos de ERROR (400 del DTO y tipo inválido de una fila
      de la masiva, `mensajeTipoCombustibleFilaInvalido`) dicen etiqueta Y
      código, porque la API solo acepta el código. El panel y la app COPIAN
      las etiquetas.
    - **Renglón «Combustible …» de la app** (`reescribirLineaCombustible
      (notas, codigoFinal)`, PURA): la app arma las notas de una carga como
      «Combustible TURBOSINA · 74 L · …» y el balance Excel por avión toma el
      detalle de la hoja «combustible» de `g.notas` (NO de
      `tipo_combustible`). **El renglón sigue al tipo cuando el tipo CAMBIA**:
      en el alta (y por `create` la carga masiva) cuando el tipo guardado no
      es el capturado (la regla corrige o rellena un vacío); en el PATCH
      cuando la regla corrige, cuando el tipo final es distinto al GUARDADO
      (relleno, o la oficina eligió a mano el del avión: el panel pinta
      «El XB-PEV carga Gasavión…» y el operador elige Gasavión) o al retirar
      la nota vieja por cambio de avión. Ahí el PRIMER renglón que EMPIEZA
      con «Combustible AVGAS» / «Combustible TURBOSINA» se reescribe con el
      código final ANTES de anexar la nota ⚠: solo el código, una sola
      reescritura, sin tocar otros renglones ni un «Combustible …» a media
      línea; sin renglón o si ya coincide ⇒ notas intactas. **Si el tipo no
      cambia (se respeta el capturado/guardado), el renglón no se toca**
      aunque diga otro (spec en las dos rutas). Sin renglón de la app
      (panel, masiva con notas vacías) la nota ⚠ queda como PRIMERA línea:
      la hoja «combustible» del balance pinta las notas completas y la del
      Libro Dinero la primera línea entera («⚠ se capturó Turbosina pero el
      XB-PEV carga Gasavión: se corrigió a Gasavión — revisar»). Es
      intencional: dice a qué se corrigió y pide revisión.
    - **Sonda ÚNICA** `common/combustible-disponible.util.ts`
      (`combustibleAeronaveDisponible` = `columnaOpcional(aeronave.
      combustible)`, re-sondeo ≤ 10 min). **REGLA DURA: todo select/insert/
      update que nombre `aeronave.combustible` va detrás de ella.** Sin la
      migración: flota y gastos como el 0.0.55 (sin el campo; las cargas se
      guardan tal cual). El «sí» se memoriza: tras un ROLLBACK de la
      migración hay que reiniciar el API.
    - **Flota** (`aircraft.service`): `GET /v1/aircraft`, `GET /:id`, alta y
      edición devuelven `combustible` (ADITIVO, `aeronaveCols()`).
      `CreateAeronaveDto`/`UpdateAeronaveDto`: `combustible?: 'AVGAS' |
      'TURBOSINA'` (`@IsOptional @IsIn`). Alta sin valor ⇒ AVGAS; `null` en
      la edición = sin cambio (la columna es NOT NULL); sin la migración el
      campo se OMITE del insert/update (warn) en vez de un 500.
    - **Avión de la regla = el avión al que CUENTA el gasto** (misma
      prioridad que `avionDelGasto` en balance, reparto y Libro Dinero): el
      del TRAMO (con herencia del vuelo) → el explícito/heredado del gasto →
      el del vuelo. Con un avión explícito distinto al del tramo la carga
      lleva el combustible del TRAMO (ahí la cuenta el balance; el aviso ⚠
      avión≠tramo ya lo dice); si no, el balance del N621TX mostraría AVGAS,
      el mismo síntoma del #280 al revés (revisión 5-oct). La validación de
      matrícula sigue contra el avión asignado.
    - **Alta de gasto** (`expenses.create`): con `categoria = GAS` y avión
      resuelto se lee `combustible` en la MISMA consulta de flota que la
      matrícula (UNA lectura sirve a las dos) y se aplica la regla. Si
      corrige: el renglón «Combustible …» de la app se reescribe con el
      código del avión, la nota va a `notas` (al final),
      `requiere_visto_bueno = true` y aviso a ADMIN y ANALISTA por el MISMO
      canal que la matrícula
      (`alerta_sistema`, título «Carga de combustible corregida», `data
      {gasto_id, motivo: 'combustible_corregido'}`, `link /admin/expenses`;
      SIN el actor, como «gasto_registrado»; `notificar:false` lo calla, como
      en la carga masiva). Vacío ⇒ solo se rellena.
    - **PATCH de gasto** (`ajustarCombustibleEnUpdate` → PURA
      `ajustarCombustiblePatch`): si el PATCH trae `tipo_combustible` o
      cambia `aeronave_id`/`vuelo_id`/`escala_id`/`categoria` de un gasto GAS,
      la regla se re-aplica contra el avión VIGENTE tras el merge (tramo
      heredado / auto-limpiado incluidos; quitar el avión de una carga con
      vuelo ⇒ el del vuelo). **La oficina tampoco deja un tipo distinto al
      del avión**: si el avión de verdad cambió de combustible, se corrige en
      su ficha. Reglas finas (revisión 5-oct): (a) reenviar el MISMO tipo
      que ya tenía el gasto (formulario completo) cuenta como «lo que el
      gasto traía», no como captura; (b) si las notas traen una corrección
      de OTRO avión (matrícula de la nota ≠ la vigente) se RETIRAN todas las
      de combustible y se re-evalúa con el valor de ANTES de la primera
      corrección: caso #280 al revés (piloto capturó bien TURBOSINA, el gasto
      quedó en el PEV ⇒ AVGAS + nota; la oficina lo mueve al N621TX ⇒
      TURBOSINA, sin nota y sin otro visto bueno); (c) `requiere_visto_bueno
      = true` SOLO con una corrección NUEVA (cambia el valor guardado o el
      PATCH mandó otro tipo); mover entre dos aviones del mismo combustible
      solo reescribe la nota con el avión nuevo; (d) si corrige, si el tipo
      final es distinto al guardado o si se retiró la nota vieja por cambio
      de avión, el renglón «Combustible …» de la app queda con el tipo FINAL
      (el #280 al revés vuelve a «Combustible TURBOSINA …»; la oficina que
      elige Gasavión sobre una carga TURBOSINA del PEV deja «Combustible
      AVGAS …»). Nunca se APAGA el visto bueno. El PATCH no
      avisa por push (la oficina ve la respuesta).
    - **Enriquecimiento IA offline** (`enriquecerGastoConIA`) NO pasa por la
      regla y no la necesita: nunca cambia la categoría (solo anota la
      discrepancia) y solo pone avión a gastos SIN avión, cosa que una carga
      GAS no puede ser (el alta lo exige y ahí ya se rellenó el tipo).
    - **Carga masiva** (`combustible-masivo.service`): el preview lee la flota
      con la columna; la columna «tipo» acepta el código o la etiqueta
      («Gasavión», «gasavion», «Turbosina»; `combustibleDeTexto`) y guarda el
      código; tipo vacío ⇒ el del avión; distinto ⇒ ADVERTENCIA (no error);
      otro texto ⇒ error con etiqueta y código. La carga pasa por `create`
      (que corrige, y reescribe el renglón «Combustible …» SI la fila lo trae
      en sus notas —casi nunca: la nota ⚠ queda como primera línea—) y la
      respuesta suma el
      ADITIVO `avisos: [{fila, aviso}]` con las filas que quedaron con el
      combustible del avión (derivado del `tipo_combustible` GUARDADO).
    - Specs: `combustible.util.spec`, `combustible-disponible.util.spec`,
      `expenses.service.combustible.spec` (caso #280 con herencia del vuelo,
      relleno, coincide, avión ausente, masiva sin push, matrícula + combustible
      en UNA lectura, tramo que dicta el avión, explícito ≠ tramo, otra
      categoría, sin migración; PATCH que cambia de avión, oficina que manda
      otro tipo, sin duplicar, null, sin tocar, no-GAS, solo tramo, solo
      vuelo con tramo auto-limpiado, OTRA→GAS, #280 al revés con la nota
      vieja retirada, a otro AVGAS, tramo vigente ≠ explícito, avión quitado
      con vuelo, sin migración; renglón «Combustible …» reescrito en alta,
      masiva y PATCH, intacto si el tipo no cambia o a media línea, de vuelta
      al tipo final en el #280 al revés, con el relleno y cuando la oficina
      elige a mano el del avión; el harness responde `escala` y `vuelo`
      por id), `combustible-masivo.service.spec`,
      `aircraft.service.combustible.spec` y `dto/create-aeronave.dto.spec`.
      Deploy: migración → API → panel → app.

44. **NÚMERO DE FACTURA DEL GASTO EN CONCILIACIÓN (5-oct-2026, API 0.0.57,
    migración `20261005000002`).** Pedido del cliente con la captura del
    Excel de conciliación: «al momento de la conciliación me apoyan a poner
    el número de la factura con la que se enlaza el movimiento. Aquí en
    notas estaría perfecto» (la columna «Notas» salía vacía).
    - **Fuente única PURA** `common/folio-comprobante.util.ts` (spec):
      `folioComprobanteDeGasto({folio_ticket, ia_folio, factura})` con esta
      prioridad: (1) factura recibida ligada (`gasto.factura_recibida_id`)
      con `folio` ⇒ `[serie, folio].join('-')` («A-0411»,
      «FEACZM-72128»); (2) `gasto.folio_ticket` recortado; (3)
      `valor_ia_extraido->>folio` (lectura IA no persistida); (4) factura con
      `uuid_fiscal` ⇒ «CFDI <uuid>»; (5) null. `folioComprobanteDeFila`
      (fila cruda de PostgREST, embed objeto o arreglo), `embedFolioGasto
      (conSerieFolio)` (las columnas que hay que pedir del gasto:
      `folio_ticket, ia_folio:valor_ia_extraido->>folio,
      factura:factura_recibida!factura_recibida_id(serie, folio,
      uuid_fiscal)`; sin la migración la factura pide SOLO `uuid_fiscal`),
      `conFolioComprobante(g)` (agrega `folio_comprobante` y RETIRA los
      campos crudos: la respuesta crece en UN campo),
      `etiquetaFacturasReporte(folios)` (1 ⇒ «Factura X»; N ⇒ «Facturas X ·
      Y», sin vacíos ni duplicados; 0 ⇒ null) y `notasReporteConFactura
      (etiqueta, notasBanco)` (etiqueta PRIMERO, « · », y sin factura la nota
      del banco BYTE A BYTE como el 0.0.56). **Nadie más arma el número.**
    - **Excel de conciliación** (`reporteXlsx`): el embed del gasto 1 ↔ 1 y
      `GASTO_PARTE_REPORTE_COLS` (lotes) llevan `embedFolioGasto`; «Notas» =
      `notasReporteConFactura(etiquetaFacturasReporte(folios de los gastos
      ligados), m.notas)` — un lote lista el de cada gasto en el orden de sus
      partes, sin duplicar. Cobros, ingresos, clasificaciones, reversos y
      gastos sin número: la nota del banco como hoy. «Gastos sin banco»
      (`reporteGastosSinBancoXlsx`) gana la columna «Factura» AL FINAL (el
      resalte naranja sigue en la col 7 = Monto).
    - **Panel al conciliar (aditivos)**: `GET /v1/conciliacion/movimientos`
      ⇒ `gasto.folio_comprobante` y cada `gastos[].folio_comprobante` del
      lote; `GET movimientos/:id/gastos-candidatos` y `sugerir` /
      `sugerir-lote` ⇒ cada candidato con `folio_comprobante`
      (`aCandidatoGasto`; `gastoRicoCols()` = `GASTO_RICO_COLS` + embed). El
      candidato viaja a pyservices `/conciliacion/sugerir` con el campo de
      más: pydantic lo IGNORA (extra por default).
    - **Facturas recibidas**: `factura_recibida.serie`, `.folio`,
      `.folio_releido_at` (migración 20261005000002). pyservices
      `parse_cfdi` devuelve `serie`/`folio` (atributos del Comprobante,
      recortados, vacío ⇒ null); `FacturaRecibidaParsed.serie?/folio?`
      ADITIVOS. **Sonda ÚNICA** `common/serie-folio-recibida-disponible.util`
      (`serieFolioRecibidaDisponible` = `columnaOpcional(factura_recibida.
      serie)`; las 3 columnas entran en UN ALTER). **REGLA DURA: todo
      select/insert/update que nombre esas columnas va detrás de ella**
      (conciliación incluida: el embed de la factura). Con la columna,
      `crearRecibida` y `crearRecibidaDeGasto` (con XML) insertan `serie`,
      `folio` y `folio_releido_at = now()` (`recibida-folio.util#
      camposSerieFolioInsert`), y `colsRecibida()` devuelve `serie, folio`
      en lista/detalle. **Un pyservices VIEJO** (respuesta SIN las llaves
      `serie`/`folio`) deja `folio_releido_at` null: sellar diría «ya se
      leyó» y la factura quedaría sin folio para siempre. Un amarre a una
      factura YA registrada (mismo UUID) no la relee: lo hace el cron.
    - **Cron `recibidas-releer-folio`** (`*/10 * * * *`,
      `InvoicesService.releerFoliosRecibidas`, candado en memoria como los
      de `alerts`): con la sonda en «sí», toma hasta 50
      (`RELECTURA_FOLIO_LOTE`) filas con `xml_url` y `folio_releido_at is
      null` (las más viejas primero), descarga el XML
      (`downloadB64('facturas', xml_url)`), lo parsea y escribe `serie`,
      `folio`, `folio_releido_at = now()` con CAS `folio_releido_at is
      null` (jamás pisa una fila sellada). CFDI sin Serie/Folio ⇒ sellado
      sin folio (no se reintenta eternamente). `clasificarFalloRelectura`:
      pyservices 400/422 con `detail` de TEXTO (`{"detail":"…"}`: XML roto,
      DTD) o «Object not found» de Storage ⇒ ILEGIBLE: se sella y `notas`
      += «Folio no legible del XML» (`notasConFolioNoLegible`, línea nueva,
      sin duplicar) con las notas RELEÍDAS justo antes del UPDATE y CAS
      sobre ellas (`eq notas` / `is notas null`, un reintento): la corrida
      tarda minutos y jamás pisa una edición de la oficina (PATCH de
      recibidas). **Un 422 de VALIDACIÓN de FastAPI (`detail` LISTA: el body
      no cumple el schema) es TRANSITORIO**, nunca ILEGIBLE (sellaría las 59
      con XML sanos). pyservices caído/lento/sin configurar/5xx/401 ⇒ esa
      fila NO se sella y se SIGUE con la siguiente; con DOS fallos
      transitorios SEGUIDOS (`cortarRelecturaPorPyservices`,
      `RELECTURA_FOLIO_FALLOS_SEGUIDOS = 2`; el contador vuelve a 0 cuando
      pyservices responde) se CORTA la corrida: así un XML que tumba a
      pyservices no bloquea la cola (el lote sale siempre en el mismo orden
      y esa fila encabezaría todas las corridas). pyservices VIEJO (sin las
      llaves) corta de inmediato; un error de red de Storage solo salta esa
      fila. Las 3 recibidas solo-PDF de prod quedan sin folio (nada que
      leer). En prod (5-oct): 62 recibidas, 59 con XML ⇒ ≤ 2 corridas.
    - Specs: `folio-comprobante.util.spec`,
      `serie-folio-recibida-disponible.util.spec`,
      `facturacion/recibida-folio.util.spec`,
      `facturacion/invoices.service.recibida-folio.spec` (cron: sin
      migración, relleno, sin Serie/Folio, ilegible con nota, XML ausente,
      red de Storage, pyservices caído (corta tras 2 seguidos), XML que
      tumba a pyservices sin bloquear la cola, 422 de validación sin
      sellar, notas editadas durante la corrida con CAS, pyservices viejo,
      lote de 50, CAS y candado; altas con/sin migración, pyservices viejo,
      solo PDF) y el bloque «NÚMERO DE FACTURA» de
      `conciliacion.service.lote.spec` (Notas 1 ↔ 1 y lote, cobros /
      ingresos / clasificaciones / reversos con la nota del banco BYTE A
      BYTE, «CFDI <uuid>», «Factura» de gastos sin banco, lista y
      candidatos con `folio_comprobante` — en «Sugerir» con folio de la
      factura y de la IA, que solo llegan por el embed de `gastoRicoCols()`
      —, sin la migración ninguna consulta nombra `serie`). Deploy:
      pyservices → migración → API → panel.

45. **PRE-CIERRE «VUELOS COMPLETADOS SIN GASTO DE OPERACIONES» (5-oct-2026,
    sin migración).** Pregunta del cliente: «la conciliación no tiene
    pendientes, pero en el balance por avión hay vuelos sin ningún gasto:
    ¿cómo confío en el cierre?». La conciliación prueba que cada movimiento
    del BANCO tiene su gasto; no ve un gasto que nunca se capturó ni pasó por
    la tarjeta. Este renglón cierra el hueco desde el lado del VUELO, para
    que el cierre quede en DOS señales: «Pendientes de conciliación» vacío y
    pre-cierre sin avisos.
    - **Item `vuelos_sin_gasto_operaciones`**, NO bloqueante (fuera de
      `bloqueantes`, sin `informativo`), justo DESPUÉS de `pistas_sin_gasto`
      (aquella mira el TRAMO fuera de CUN sin su cuota; esta, el VUELO sin
      NINGUNA pista — incluye CUN→CUN). `count` = vuelos;
      `vuelos[] {id, folio, fecha_vuelo, matricula}` por `fecha_vuelo`
      (empate por folio);
      `lectura_fallida: true` (count 0 y texto «No se pudo verificar…»)
      cuando la lectura falla — jamás un 0 silencioso.
    - **Universo**: vuelos COMPLETADO del periodo (cortes Cancún, invariante
      4), PROPIOS (no `es_externo`, con `aeronave_id`). **Cliente interno y
      vuelos de servicio ENTRAN** (revisión 5-oct-2026): aquí importa el
      COSTO, no el cobro — su pista resta en el balance por avión y en el
      reparto como la de cualquier vuelo. En prod, de los 14 de ago-sep que
      la exclusión original escondía, 13 traían su pista y el único sin ella
      era un faltante real (#136, CET→CUN de reposicionamiento). Fuera:
      externos, sin avión y cancelados (esos los cubre
      `gastos_en_cancelados`). «Sin gasto» = NINGÚN gasto `OPERACIONES` /
      `ATERRIZAJE` con `vuelo_id` = el vuelo, de CUALQUIER fecha (la cuota se
      paga días después). Casos reales: #295 y #268 (sep), #136, #142, #194 y
      #206 (ago).
    - **Fuente única PURA** `profit-sharing/vuelos-sin-gasto.util.ts`
      (`candidatosSinGastoOperaciones`, `vuelosSinGastoOperaciones`, textos).
      La lectura de gastos va en lotes de ≤ 200 ids, cada lote PAGINADO por
      `id` (anti-cap-1000: un vuelo cuyo gasto quedara pasada la fila 1000
      saldría «sin gasto» en falso). No lee tramos.
    - **No se puede descartar**: el vuelo sigue en la lista mientras no tenga
      un gasto de pista ligado (el texto lo dice: «Captura el gasto en el
      vuelo…»). Un vuelo que de verdad no pagó pista deja el aviso vivo ese
      mes; marcarlo «sin cargo confirmado» exigiría una columna nueva
      (pendiente, decisión del cliente).
    - Spec: `profit-sharing.service.pre-cierre-vuelos-sin-gasto.spec.ts` (BD
      en memoria con max-rows 1000: #295/#268, COMIDA no cuenta, pista de
      otro mes y ATERRIZAJE sí, interno y servicio listados, externo / sin
      avión / cancelado / fuera de periodo no, orden por fecha con folio
      menor posterior y empate por folio —falla si se ordena solo por folio
      o sin desempate—, anti-cap y lectura fallida).

46. **RELECTURA CON IA DEL FOLIO DE LOS COMPROBANTES (6-oct-2026, API
    0.0.58, migración `20261006000001` APLICADA 6-oct-2026).** Pedido
    aprobado por el cliente: el Excel de conciliación pone el número de
    factura solo si el gasto tiene folio (invariante 44) y en prod (6-oct)
    477 gastos con foto no tenían NINGUNO (ni `folio_ticket`, ni factura
    recibida, ni `valor_ia_extraido->>folio`); la IA ya había leído 457 de
    esas fotos y devolvió el folio vacío (ASUR de principios de septiembre,
    antes de afinar el prompt). Una pasada de IA los rellena.
    - **Cron `gastos-releer-folio`** (`*/5 * * * *`,
      `expenses/folio-relectura.service.ts`, servicio APARTE de
      `ExpensesService`; candado en memoria como los de `alerts`; nunca
      lanza). Sonda ÚNICA `common/folio-releido-gasto-disponible.util`
      (`columnaOpcional(gasto.folio_releido_at)`): sin la migración NO hace
      nada (ni Storage ni IA ni créditos). **REGLA DURA: todo select/update
      que nombre `folio_releido_at` va detrás de ella.** Sin visión
      configurada tampoco lee.
    - **Configuración** (`configuracion_sistema`, SIN fila = default). La
      migración SIEMBRA las dos que el panel edita (Configuración; `update`
      responde 404 sin fila, así que sin sembrar no había cómo PAUSAR):
      `folios_releer_activo` (`activa`, default true: apagarla detiene el
      cron en ≤ 60 s), `folios_releer_lote` (`valor_numerico`, default 15;
      el PATCH valida 1–50 en `RANGOS_NUMERICOS`). Las fechas NO se siembran
      (se cambian por SQL; una fila suya saldría en el panel como switch sin
      significado): `folios_releer_desde`
      (`valor_json` = `["AAAA-MM-DD"]`, default 2026-09-01, sobre
      `fecha_gasto`) y `folios_releer_capturados_hasta` (`valor_json`,
      default **2026-10-05**, día Cancún inclusive sobre `created_at`: lo
      capturado después ya se leyó con el prompt afinado del 2-oct y es lo
      que piloto y oficina siguen editando — releerlo gastaría créditos
      cada 5 min y movería `updated_at` bajo el CAS de la app offline). Las
      fechas viven en `valor_json` porque la tabla no tiene columna de texto
      y su CHECK solo admite arreglos; las lee
      `ConfiguracionService.fecha(clave, def)` (caché 60 s, best-effort).
    - **Cola**: `foto_url` not null, `folio_ticket`, `factura_recibida_id`,
      `folio_releido_at` y `valor_ia_extraido->>folio` null, `fecha_gasto >=
      desde`, `created_at < corteCapturadosHasta(hasta)`, `fecha_gasto`
      desc (empate por id). **Ningún gasto se lee sin tope** (revisión
      6-oct): uno que falla (lectura, Storage o BD) va AL FINAL de la cola
      y se reintenta a lo más cada hora (`REINTENTO_POSTERGADO_MS`,
      `ordenarCandidatos`; `postergados` en memoria, tope 500, un reinicio
      lo olvida). Contadores puros (`registrarFallo`/`destinoTrasFallo`):
      los fallos que NO cuestan (`falloSinCosto`: «Sin conexión con
      pyservices», `pyservices 502/503/504` de la orilla de Railway, IA
      «saturada») y los de Storage solo mueven la hora; los demás suman un
      `intento` y, si la IA está viva (el fallo es `RESPUESTA_IA` o la IA le
      contestó a OTRO gasto después de que éste empezó a fallar —en su
      primer fallo, antes en la misma corrida—), un `conIa`. Con 3 `conIa`
      ⇒ se SELLA como ilegible (warn); con 6 `intentos` sin esa prueba ⇒
      sale de la cola de ESTE proceso sin sellar (warn; un reinicio lo
      regresa). Un fallo de ESCRITURA (la IA ya cobró, la BD rechazó) suma
      `intento` pero nunca `conIa`. Antes, con la cola vacía, un gasto que
      siempre fallaba (422 «Respuesta truncada», timeout) se leía en CADA
      corrida (~288 lecturas/día, sin rastro en `ia_uso`).
    - **Lectura** como `reanalizarConIA`: imagen por URL firmada de 1 h
      (`SEGUNDOS_URL_PUNTUAL`), TODAS las hojas si hay
      `fotos_adicionales`, PDF/Excel en bytes (`download`). Consumo en
      `ia_uso` con categoría `RELEER_FOLIO`, `usuarioId` null y contexto
      `{gasto_id, origen: 'releer_folio'}`. El folio se decide con
      `expenses/folio-ticket.util#folioTicketDeLectura` — fuente única que
      también usa `enriquecerGastoConIA` (recorte, 60 caracteres, «S/N»,
      «N/A», «Sin folio»… ⇒ sin folio); `normalizarFolio` y
      `FOLIO_CANDADO_MIN` se MOVIERON ahí desde `expenses.service.ts`.
    - **Resultados** (`folio-relectura.util#evaluarLecturaFolio`, PURO):
      (a) folio ⇒ `folio_ticket`, `valor_ia_extraido` = la lectura PREVIA
      con su llave `folio` rellenada (la IA solo llena vacíos; desglose,
      proveedor y `fotos_adicionales` intactos; sin lectura previa se guarda
      la nueva completa sin `motivo`), `folio_releido_at = now()`,
      `updated_by = null`; (b) ese folio ya es de OTRO gasto (23505 del
      índice único `uq_gasto_folio_ticket_norm`) ⇒ SIN folio,
      `duplicado_sospechado = true`, «⚠ IA: folio X ya existe en otro gasto
      — revisar» al final de `notas` (sin repetirla; el ⚠ enciende el aviso
      ámbar de «Verificar»), sello y `updated_by = null`; (c) legible sin
      folio, `legible: false`, error PROPIO del comprobante (pesa
      demasiado, pixeles, formato, foto ilegible, documento largo,
      demasiadas fotos) o archivo ausente en Storage ⇒ SOLO
      `folio_releido_at` (no deja renglón en la bitácora y no toca
      `updated_by`); (d) `clasificarMotivoLectura`: IA NO DISPONIBLE (sin
      saldo, límite de gasto, llave, modelo inexistente, token interno,
      visión deshabilitada) ⇒ no sella y CORTA ya; todo lo demás
      (pyservices caído, timeout, IA saturada, «Claude no disponible (…)»
      genérico, texto desconocido) es TRANSITORIO ⇒ no sella, se posterga y
      con DOS seguidos (`cortarRelecturaPorPyservices`, el MISMO del cron de
      recibidas) se corta; un error de red de Storage solo salta esa fila.
      `RESPUESTA_IA` (422 de `/vision/gasto` DESPUÉS de que la IA contestó:
      «Respuesta truncada», «Respuesta sin JSON», «JSON inválido», «No se
      pudo interpretar», `N validation error(s) for`; se reconoce por el
      INICIO del texto, el resto puede traer lo que escribió el modelo) NO
      cuenta para el corte (la IA vive) y sí para sellar ese gasto. Los 422
      de Excel antes de la IA («Excel viejo», «está vacío o no se pudo
      leer») son COMPROBANTE. Archivo VACÍO (0 bytes) = ausente ⇒ (c):
      con él `readGastoTicket` devolvía null («visión deshabilitada») y la
      corrida se cortaba en ese gasto para siempre.
      Los textos que se reconocen son los de `pyservices/app/services/
      ia_errores.py`: si cambian allá, caen en TRANSITORIO (lado seguro).
    - **Escritura con la fila RELEÍDA y CAS** (`folio_ticket`,
      `folio_releido_at` y `factura_recibida_id` null + `updated_at` vía
      `aplicarCas`): un folio tecleado, una factura ligada, una lectura IA
      con folio, un sello de otro camino o **OTRO comprobante** (foto u
      hojas distintas de las que se leyeron: `archivosDelComprobante` es la
      fuente única de lo que se manda a la IA y de lo que se compara,
      `mismoComprobante`) mientras la IA leía ⇒ `omitidos` sin escribir (y
      sin postergar: la foto nueva se lee en la siguiente corrida). Antes
      el folio de la foto VIEJA se escribía y el sello impedía releer la
      nueva. Otros cambios (monto, notas) no invalidan el folio leído. 0
      filas ⇒ relee y decide otra vez (≤ 3 vueltas, el 23505 cuenta una). **Actor**: `tg_gasto_bitacora` registra
      `folio_ticket`/`notas` con `actor_id = new.updated_by`; sin el
      `updated_by = null` el cambio se atribuiría a quien editó el gasto
      por última vez (el piloto). Null ⇒ el historial del panel pinta
      «Sistema» (precedente: `20260925000002`). El sello de verificación
      (`verificado_por/at`) NO se limpia: el cron no es un rol de campo.
    - **Resumen por corrida** (log y retorno): `{activo, disponible,
      tomados, con_folio, duplicados, sin_folio, ilegibles, omitidos,
      fallos}`.
    - **Costo y tiempo** (6-oct): 118 en la cola con la configuración por
      default (8 PDF); lectura media `GASTO_TICKET` 0.0516 USD ⇒ ~6 USD de
      un saldo de ~16. Los 477 completos (desde julio) costarían ~25 USD:
      ampliar `folios_releer_desde` solo tras recargar. Cada lectura tarda
      20–40 s con Opus: una corrida de 15 dura ~5–10 min y el candado salta
      el tick que la alcance, así que en la práctica corre cada 10–15 min ⇒
      118 / 15 = 8 corridas = **entre 1 y 2 horas** después del deploy Y de
      aplicar la migración, más ≤ 10 min de la sonda (lo que se le dice al
      usuario: «entre 1 y 2 horas, unos 6 USD»). Tope de lo que puede
      gastar un gasto que falla siempre: 4 lecturas si la IA vive (se
      sella), 6 por arranque del API si no hay prueba (se retira).
    - Specs: `folio-ticket.util.spec`, `folio-relectura.util.spec`,
      `folio-relectura.service.spec` (sin migración, config apagada, sin
      visión, (a) con y sin lectura previa, (b) 23505, (c) en sus 6 formas
      incl. PDF y archivo borrado, PDF borrado en `download` y PDF VACÍO
      (sella sin IA y la corrida sigue), (d) pyservices caído / sin saldo /
      transitorio aislado / Storage, lote y orden con los filtros de la
      cola, configuración, postergados, multi-hoja, CAS —folio a mano
      durante la lectura, entre la relectura y el UPDATE, notas editadas
      antes del UPDATE del duplicado, FOTO reemplazada y HOJAS cambiadas
      durante la lectura— , reintentos acotados con reloj simulado
      —timeout siempre en el mismo gasto ⇒ 1/h y sellado, «Respuesta
      truncada» no corta y sella, solo en la cola ⇒ 6 y retirado,
      pyservices caído toda la noche ⇒ ni sella ni retira, BD que rechaza
      ⇒ 6 y retirado— y candado; el mock PROYECTA las columnas del
      `select` como PostgREST; 13 mutaciones detectadas el 6-oct y 13 más
      en la revisión), `folio-relectura.util.spec`
      (`registrarFallo`/`destinoTrasFallo`, `falloSinCosto`,
      `RESPUESTA_IA`, `archivosDelComprobante`/`mismoComprobante`),
      `folio-releido-gasto-disponible.util.spec`,
      `configuracion/configuracion.fecha.spec` y
      `configuracion.service.spec` (lote 1–50).

47. **BLOQUE «VUELATOUR (empresa)» AL FINAL DE LA HOJA «balance» DEL
    GENERAL (6-oct-2026, API 0.0.59, sin migración).** Pedido del cliente:
    «en la hoja de balance falta, hasta el final, el balance de la empresa
    VuelaTour». Campo ADITIVO `empresa` del payload del general (pyservices
    lo pinta; sin él, el libro es el de antes) y `es_empresa` (de
    `usuario.es_empresa`, SIEMPRE booleano) en cada `balance.socios[]` de
    los dos libros. Aritmética en la fuente única PURA
    `aircraft/balance-empresa.util.ts` (spec); `xlsxGeneral` solo junta
    insumos ya calculados — **nadie recalcula una utilidad, un T.C. ni una
    hoja**:
    - `participaciones` / `participacion_usd`: el `monto_usd` de los socios
      `es_empresa` de cada bloque de `aviones` (utilidad COBRADA × %), tal
      cual; Σ redondeada; sin socio-empresa ⇒ `[]` y 0.
    - `ingresos_propios_usd` / `pagos_vendedor_usd`: Σ `ingreso_mxn` /
      Σ `egreso_mxn` de «otros movimientos» (filas + sueltas), cada fila ÷
      SU T.C., redondeo al final. **`pagos_vendedor_usd` son TODOS los
      egresos de la pestaña** (pago al vendedor, TUAs pagadas, extensión de
      horario, comisión bancaria, gastos sueltos): restar solo el pago al
      vendedor dejaría las TUAs cobradas como ingreso sin su costo. Desde el
      0.0.65 (invariante 50) la comisión bancaria de la pestaña es SOLO la
      parte de VuelaTour; desde el 0.0.66 los ingresos son lo cobrado a los
      clientes (sin la línea «a cargo del avión») y el pago al vendedor que
      cubre la provisión de los aviones egresa 0 (solo su exceso): el bloque
      los toma de las filas sin cambio de código y su resultado es el del
      0.0.65 salvo un pago real MENOR que la provisión (el 0.0.65 contaba
      ese faltante como ingreso); la participación como socia ya viene
      después de comisiones. Su `nota` (revisión 7-oct-2026, insumo
      opcional `pagoVendedorCubiertoPorAvion`, que `xlsxGeneral` prende
      cuando algún avión carga provisión del vendedor —la misma condición
      de la rama «cubierto por el avión»—) decía hasta el 0.0.72 «Egresos =
      pago al vendedor (real o provisión; en los vuelos completados de la
      regla de comisiones, solo lo que el pago real exceda la provisión que
      ya carga el avión), …» y, sin la señal, «(real o provisión)» a secas
      (que contradecía el pie de pyservices). Desde el 0.0.73 (invariante
      58) la pestaña ya no provisiona el pago al vendedor y
      `pagos_vendedor_usd` baja esas provisiones en los vuelos sin
      provisión del avión, así que la `nota` dice «Egresos = pago al
      vendedor (solo el gasto real «Comisión del vendedor» capturado; en
      los vuelos completados de la regla de comisiones, solo lo que ese
      pago exceda la provisión que ya carga el avión), …» y, sin la señal,
      «(solo el gasto real «Comisión del vendedor» capturado)»: el «real o
      provisión» era falso y chocaba con la fila 2 y el pie nuevos de
      pyservices (revisión adversaria del 12-oct-2026; specs
      `balance-empresa.util.spec` y `comisiones-general.spec`). Desde el
      0.0.74 (invariante 61) el insumo es `pagoVendedorACargoDelAvion` (algún
      avión absorbió el pago REAL de un vuelo) y la `nota` con la señal dice
      «… en los vuelos completados de la regla de comisiones lo carga el
      avión en su columna COMISIONES y aquí egresa $0.00)»: las filas «a
      cargo del avión» egresan 0, así que `pagos_vendedor_usd` no cuenta ese
      pago (ya restó en el avión). **Ajuste del 13-oct-2026 (dos categorías,
      invariante 61)**: la señal es «algún avión absorbió un pago «Comisión
      del vendedor (avión)»» y la `nota` dice «Egresos = pago al vendedor
      (solo los gastos reales capturados: la «Comisión del vendedor
      (VuelaTour)» egresa aquí; la «Comisión del vendedor (avión)» que carga
      un avión en su columna COMISIONES aquí egresa $0.00), …»; sin ella,
      «(solo los gastos reales de comisión del vendedor capturados)».
      `pagos_vendedor_usd` = Σ «(VuelaTour)» + «(avión)» que nadie carga.
      Desde el 0.0.74 (invariante 62) la
      pestaña trae además una fila «AFAC · matrícula» por avión:
      `ingresos_propios_usd` incluye la provisión AFAC del periodo de cada
      avión, ÷ el `totales.tc_promedio` del libro de su avión (alineado en
      `tcFilas` por `payloadGeneral`); los permisos pagados (TODOS los
      gastos PERMISO de su hoja «permisos») van CITADOS con egreso $0.00
      (revisión del 13-oct-2026: ya restan en la cascada del avión), así que
      `pagos_vendedor_usd` NO los cuenta; el insumo `afacEnFilas` solo
      cambia la `nota` («(por vuelo, AFAC por avión y sueltas)… más la
      provisión AFAC del periodo de cada avión… los permisos pagados de cada
      avión van en su fila «AFAC · matrícula» con egreso $0.00…»). El T.C.
      por fila lo recoge `buildOtrosMovimientos` en el parámetro opcional
      `tcFilas` (alineado por índice; NO viaja en el payload de la pestaña,
      que sale byte-idéntico, y sin él no hay consultas nuevas): fila por
      vuelo = el K de venta del vuelo (sin K, el promedio de la pestaña);
      suelta USD = el T.C. que la llevó a pesos (`tc_gasto` / promedio /
      el del ingreso); suelta en pesos = T.C. oficial de su día
      (`tcOficialDeDias`, mismo `memoTc`; respaldo, el promedio).
      Desalineadas ⇒ se LANZA.
    - `otros_gastos_empresa_usd` = EXACTAMENTE `gastos_empresa.usd` (la
      celda TOTAL USD de «otros gastos») y `tc_usado` = `tc_promedio` =
      `consolidado.totales.tc_promedio`. `tienda_utilidad_usd` =
      `inventario.total_utilidad_mxn` ÷ ese T.C. (null sin inventario; la
      utilidad USD legado sin T.C. NO entra y la `nota` lo dice).
    - `resultado_usd` = round2(participación + ingresos − egresos − otros
      gastos + tienda). **`null` se propaga**: una participación null, una
      fila de la pestaña rotulada «sin TC» (o con pesos y sin T.C.) —
      `movimientos_sin_tc` las cuenta—, «otros gastos» sin USD o la tienda
      sin T.C. dejan su renglón y el resultado vacíos. `nota` = la base de
      cada línea, lista para pintar. PERSONAL_DUENO ya está fuera de todas
      las fuentes.
    - Specs: `balance-empresa.util.spec.ts` y
      `aircraft-balance.service.bloque-empresa.spec.ts` (socia en 2 aviones
      = las celdas de cada bloque, filas y sueltas con su T.C., oficial del
      día y su respaldo, gasto USD con su T.C., sin inventario / con
      inventario, sin socio-empresa, fila sin T.C. ⇒ vacío, payload de la
      pestaña idéntico). Deploy: pyservices (tolera `empresa` ausente) → API.
    - **Revisión (6-oct-2026, mismo 0.0.59):**
      - **Avión SIN vuelos ⇒ sus hojas con el T.C. OFICIAL del cierre.** Sin
        un vuelo no hay Z: las hojas con pesos salían sin USD y vaciaban la
        utilidad, el reparto y TODO el bloque VUELATOUR (XB-ANU, oct-2026:
        0 vuelos, empresa al 30 %, PERMISO $2,549 + $2,969). Hoy
        `buildPayload` convierte esas hojas con el oficial del último día
        del periodo (u hoy si no ha terminado), lo pone en
        `totales.tc_promedio` y lo dice en un pendiente; la utilidad es la
        pérdida (−gastos) y el reparto la refleja. SOLO con `vuelos = 0`
        (con un vuelo sin T.C. las hojas siguen vacías: la venta no se
        omite). El T.C. de la FLOTA promedia solo libros con vuelos
        (idéntico al de antes). Sin oficial, null como siempre y la `nota`
        NOMBRA el avión que vacía la participación.
      - **Base de «otros movimientos» = lo COTIZADO** de los vuelos no
        cancelados (COTIZADO/RESERVA incluidos), no lo cobrado — opción
        «etiqueta» de la revisión, alineada con pyservices. La parte de
        VuelaTour AÚN POR COBRAR viaja INFORMATIVA
        (`ingresos_por_cobrar_usd`, `vuelos_por_cobrar`, aditivos; NO se
        resta): `cobrosEnUsd` con el K del vuelo, `cobradoParteVuelatour`
        y la tolerancia de `pendienteCobro`; la `nota` la dice con monto.
        Si el cliente pide el bloque «sobre lo cobrado», se resta ESE
        número de `ingresos_propios_usd` (una línea en el util).
      - **T.C. oficial: puerta única `tcOficialDeDias`** (memo por día +
        máx. 5 consultas a la vez) para el K de respaldo, las sueltas en
        pesos y el respaldo de las hojas; el atajo sin límite se quitó.

48. **GASTO NO BANCARIO LIGADO A UN CARGO, CON JUSTIFICACIÓN (6-oct-2026,
    API 0.0.63, sin migración).** Caso real (texto del cliente): cargo de
    $212.00 del 07-sep (ASUR CANCUN, GASTOS GNRAL) que «ningún piloto subió»;
    el 27 y 28-sep hubo dos estacionamientos de ese monto en EFECTIVO (#330)
    que Mari facturó «para no perder la deducción». Se liga a uno «sin
    cambiar la forma de pago, ya que eso afectaría la caja de los pilotos».
    Regla: un gasto NO bancario (≠ `MEDIOS_BANCARIOS`: EFECTIVO, PERSONAL_*)
    SÍ se liga a un cargo, pero SOLO con una razón escrita, y la liga
    **JAMÁS toca `medio_pago`, `verificado_por/at` ni
    `requiere_visto_bueno`** (caja chica no lee `gasto.conciliado`: la caja
    de los pilotos no se mueve). BODEGA (salida de inventario) nunca.
    - **Candidatos**: `GET …/gastos-candidatos?incluir_no_bancarios=true|1`
      (`@ToBooleanQuery`, que desde hoy también acepta `1`/`0`; default
      false) cambia el filtro de medio de `in(MEDIOS_BANCARIOS)` a
      `neq(BODEGA)` con las MISMAS reglas (sin conciliar, moneda de la
      cuenta, ventana, búsqueda). **Los cruzados (USD contra cuenta MXN)
      siguen SOLO bancarios** aun con la bandera (`leer('USD', false)`):
      ligado 1 ↔ 1, `recalcular_gasto_conciliado` le derivaría `tc_gasto`
      del cargo a un efectivo en dólares que ese cargo no pagó.
      `no_bancario: boolean` viaja SIEMPRE en cada candidato. **Orden por
      NIVELES** (`ordenarCandidatosPorNiveles`, revisión 6-oct-2026), cada
      uno con `ordenarCandidatosGasto`: bancarios que CUADRAN, no bancarios
      que CUADRAN, resto de bancarios, resto de no bancarios. Antes iban
      «todos los bancarios y después el efectivo» y, con el corte a
      `limite` (100), el caso real (prod: 254 bancarios sin conciliar en ±30
      días, ninguno de $212, y 223 no bancarios) devolvía 100 bancarios y
      CERO de los tres estacionamientos de $212.00: encender el interruptor
      no mostraba nada. Sin no bancarios el orden es EXACTAMENTE el del
      0.0.62 (spec). Desde el 0.0.75 son 7 niveles (invariante 70):
      bancarios que cuadran · cruzados CERCA del oficial · no bancarios que
      cuadran · resto de bancarios · cruzados SIN oficial · cruzados LEJOS
      (o sin `tc_cruce`: la posición de siempre) · resto de no bancarios;
      los cruzados siguen SOLO bancarios. Con la bandera, `excluidos`
      (`ContextoExclusion.incluirNoBancarios`) solo cuenta BODEGA (y sin
      medio) como `EFECTIVO_U_OTRO_MEDIO`. Helpers PUROS en
      `gastos-candidatos.util.ts`: `MEDIO_BODEGA`, `esMedioBancario`,
      `esMedioNoBancarioVinculable`, `clasificarMediosVinculo`,
      `ordenarCandidatosPorNiveles`.
    - **PATCH `movimientos/:id`**: `justificacion?` (recortada; vacía o solo
      espacios = ausente; 10–300 o 400 de validación). `validarMediosVinculo`
      corre al FINAL de la pre-validación y ANTES de la RPC (también en
      `linkDirecto`): BODEGA en el cuerpo ⇒ 409 `GASTO_BODEGA
      {details.gastos_bodega[{id, fecha_gasto, monto}]}` SIEMPRE; un no
      bancario que ENTRA en OTRA moneda que la de la cuenta ⇒ 409
      `NO_BANCARIO_OTRA_MONEDA {details.moneda_cuenta,
      details.gastos_otra_moneda[{id, moneda, fecha_gasto, monto}]}` ni con
      razón (`mensajeNoBancarioOtraMoneda`; el T.C. de arriba), y sin la
      moneda de la cuenta (lectura caída) ⇒ 503 `CUENTA_SIN_MONEDA` (no se
      adivina); un no bancario que ENTRA (no estaba en las partes del
      cargo; sin medio cuenta como no bancario) sin razón válida ⇒ 400
      `JUSTIFICACION_REQUERIDA {details.gastos_no_bancarios[{id,
      medio_pago, fecha_gasto, monto}]}` (cronológico) y message de
      `mensajeJustificacionRequerida` («El gasto del 28 sep está en
      efectivo: para vincularlo a un cargo del banco escribe por qué (no
      cambia el medio de pago).»). Re-liga idéntica = no-op sin razón. Lote
      mixto: solo el no bancario pide razón. El auto-cruce (`ligarAuto`)
      jamás ve no bancarios (su universo es `MEDIOS_BANCARIOS`).
    - **La liga es la de siempre** (RPC/puente; `gasto.conciliado` lo
      recalcula la BD) y DESPUÉS `sincronizarNotasVinculo` anota los DOS
      lados: cargo += «Vinculado a gasto en EFECTIVO del 28-sep-2026 (Taxi /
      estacionamiento · vuelo #330 · $212.00 · gasto 3f9a1c2e): <razón> —
      <usuario>, 06-oct-2026» (una por gasto); gasto += «⚠ Conciliado con el
      cargo bancario del 07-sep-2026 ($212.00 · ASUR CANCUN) sin cambiar el
      medio de pago (EFECTIVO): <razón> — <usuario>, 06-oct-2026». Fuente
      única PURA `common/vinculo-no-bancario.util.ts` (spec): etiquetas
      `etiquetaMedioPago` (en mayúsculas) / `etiquetaCategoriaGasto`, fechas
      dd-mmm-aaaa cortando el texto (hoy = `hoyCancun()`), firma = nombre
      del usuario (`c.nombre`; vacío ⇒ «Oficina»). UNA línea por PAR cargo ↔
      gasto (la misma no se duplica; otra razón la reemplaza en su lugar).
      **Llaves** (revisión 6-oct-2026): en el CARGO, «gasto 3f9a1c2e» = los
      8 primeros caracteres del id del gasto (`refGastoNota`, minúsculas) —
      con fecha · categoría · vuelo · monto como llave, dos estacionamientos
      iguales del mismo día en un lote compartían UNA línea (soltar uno
      borraba la del otro) y un gasto al que le cambiaban categoría o vuelo
      después de ligarse (siguen editables; monto/moneda/medio no) dejaba su
      línea huérfana al soltarlo—; en el GASTO, fecha + monto + leyenda del
      cargo (vienen del estado de cuenta, no se editan; el formato no
      cambió). Ni el medio ni los datos editables del gasto entran en la
      llave. Va justo después del ÚLTIMO renglón con texto, tras un renglón
      en blanco (la limpieza del «Desglose:» del panel se lleva las líneas
      pegadas a él), renglón seguido entre líneas del vínculo, y con el fin
      de línea de las notas (`\r\n` si ya lo usan). Escritura `reescribirNotas`:
      SOLO `notas` + `updated_by` (la bitácora del gasto registra quién), CAS
      sobre `updated_at` (0 filas ⇒ relee y reintenta UNA vez), sin cambio ⇒
      cero escrituras. **Best-effort**: si falla, la liga SE QUEDA (jamás una
      liga a medias), warn y `vinculo_no_bancario.notas_anotadas: false`.
    - **Desvincular** (`gasto_id: null`): el cargo pierde TODAS sus líneas
      (`todoElCargo`: aunque la lectura previa de sus partes falle —warn— y
      aunque el gasto haya cambiado) y cada gasto que pagaba pierde la línea
      de ESE cargo (`quitarNotasVinculoNoBancario`, regex de la forma
      EXACTA). Un reemplazo (la RPC escribe la puente como DIFF) quita del
      cargo la línea de cada gasto que soltó POR SU ID (`{gastoId}`) y del
      gasto la de este cargo. **Lo de la oficina queda byte a byte**
      (revisión 6-oct-2026; antes un regex global compactaba sus renglones
      en blanco, `trim` y `\r\n` ⇒ `\n`): se quitan SOLO las líneas del
      vínculo y, si un bloque de ellas se va COMPLETO, el renglón en blanco
      que el alta puso antes; agregar → quitar devuelve las notas de antes
      exactas (spec con blancos, espacios finales, tabs y `\r\n`).
      Desligar un cargo de gastos bancarios no lee la cuenta ni escribe.
    - **Respuestas ADITIVAS**: PATCH ⇒ `gastos_estado[].medio_pago` y, solo
      si entró un no bancario, `vinculo_no_bancario {gasto_ids,
      notas_anotadas}`; la fila (`notas`) ya viene anotada. `GET
      movimientos` ⇒ `gasto.medio_pago` y `gastos[].medio_pago`.
    - **Panel**: `expense-verify-dialog.tsx` pinta «La IA detectó
      discrepancias» con CUALQUIER «⚠» en las notas; la línea del gasto lo
      dispararía (excluir `/^⚠ Conciliado con el cargo bancario del /`). El
      panel reconoce la línea del cargo solo por su prefijo «Vinculado a
      gasto en» (el «gasto 3f9a1c2e» va dentro del paréntesis). Si
      `vinculo_no_bancario.notas_anotadas` llega `false`, la liga quedó pero
      la razón no: el panel debe avisar (re-ligar el mismo gasto es un no-op
      y NO re-anota; desvincular y volver a vincular sí).
    - Specs: `vinculo-no-bancario.util.spec`, `gastos-candidatos.util.spec`
      (medios, bandera y niveles: el caso real 254 + 3) y
      `candidatos-excluidos.util.spec` (medios, bandera y
      `rangoMontoExcluidos`), el bloque «GASTO NO BANCARIO» de
      `conciliacion.service.lote.spec` (candidatos con y sin la bandera, MÁS
      bancarios que el límite, cruzados solo bancarios, BODEGA nunca, 409
      `NO_BANCARIO_OTRA_MONEDA` en los dos caminos, 503 sin moneda, 400 sin
      razón y nada escrito, liga con razón sin tocar medio/verificado,
      desvincular —también con el gasto editado y con la lectura previa
      caída—, lote mixto, gastos IGUALES en un lote, idempotencia,
      reemplazo —también con el gasto editado—, CAS con reintento, fallo
      tras ligar, lista, camino directo), el de «excluidos» (`q` entero ⇒
      [q, q+1)) y `conciliacion.controller.lote.spec` (DTO por HTTP:
      recorte, vacía, 10–300, `incluir_no_bancarios` 1/true/0/false/otro).

49. **«BALANCE MENSUAL» Y «BALANCE GENERAL»: `?modo=` EN LA DESCARGA DE LA
    FLOTA (6-oct-2026, API 0.0.64, sin migración).** Pedido del cliente: el
    libro de siempre se llama «Balance mensual» y el nuevo «Balance general»
    resume la hoja «reporte horas FLOTA» a COSTO TOTAL y COSTO POR HORA («el
    total de todos los gastos, entre el tiempo volado, entre el tipo de
    cambio del día, entre 1.16»). `GET
    /v1/aircraft/balance-general.xlsx?modo=mensual|general` (DTO
    `BalanceGeneralQuery extends BalanceAvionQuery`): sin `modo` =
    `mensual` (el panel previo baja lo de siempre); cualquier otro valor
    —«GENERAL», vacío, repetido— ⇒ 400 «El modo del balance debe ser
    «mensual» o «general».»; el libro de UN avión NO acepta `modo` (400).
    `xlsxGeneral(desde, hasta, modo)` valida ANTES de leer nada y manda
    `variante = modo` AL FINAL del payload (aditivo: pyservices sin
    `variante` o con `mensual` pinta el libro byte-idéntico). **Es lo ÚNICO
    que cambia**: el payload se arma igual —mismos números, mismas
    consultas— y las columnas de la variante general salen de atributos que
    cada fila YA trae (`subtotal_mxn`, `tiempo_vuelo`, `costo_total_mxn`,
    `tc_costos`, `costo_usd`, `costo_hr_usd`, `costo_hr_usd_siva` = AO = Y
    ÷ z ÷ O ÷ 1.16, `iva_pagado_*`, `remanente_mxn`): lo que falte se arma en
    pyservices como FÓRMULA de esas celdas, nunca como un número paralelo
    aquí. Archivo: `balance-<modo>-vuelatour-<desde>-a-<hasta>.xlsx` (el
    `balance-general-vuelatour-…` de antes hoy es el MENSUAL). Fuente única
    `aircraft/balance-general-modo.util.ts` (`MODOS_BALANCE_GENERAL`,
    default, mensaje, `esModoBalanceGeneral`, `nombreArchivoBalanceGeneral`;
    el tipo `VarianteBalanceGeneral` vive en `pyservices.service.ts`).
    Specs: `balance-general-modo.util.spec`, `aircraft.controller.spec`
    (HTTP con el ValidationPipe de main.ts: default, general, mensual
    explícito, los 400, roles ADMIN/ANALISTA, orden de rutas, libro por
    avión sin `modo`) y `aircraft-balance.service.modo.spec` (variante por
    modo, payload IDÉNTICO salvo `variante` y con las mismas tablas leídas,
    llave al final, 400 sin leer la BD). Deploy: pyservices (tolera
    `variante`) → API → panel (el API previo responde 400 a `?modo=` por
    `forbidNonWhitelisted`).
    - **Revisión (6-oct-2026, mismo 0.0.64):**
      - **Orden de deploy OBLIGATORIO, cada push solo tras verificar el
        paso anterior.** (1) pyservices con `variante` (commit e9ac370 o
        posterior) como deployment ACTIVO en Railway. Un pyservices previo
        IGNORA la llave (`extra="ignore"`) y pinta el libro MENSUAL: con el
        API 0.0.64 arriba, «Descargar balance general» bajaría EN SILENCIO
        el libro mensual con nombre `balance-general-…`, sin un solo error.
        El API no lo puede detectar: pyservices no expone su versión
        (`/health` fijo) y responde los mismos encabezados en las dos
        variantes. (2) API: `GET /v1/version` = `0.0.64` (un health 200 no
        prueba que corra la imagen nueva). (3) Panel: manda `modo` SIEMPRE,
        también el mensual, así que contra un API ≤ 0.0.63 los DOS botones
        responden 400.
      - **TOTALES vacíos por diseño en la variante general**: COSTO X HORA
        (DLLS S/IVA), IVA X HR, TOTAL PARA PROVEEDOR (DLLS), IVA TOTAL
        PAGADO (DLLS y PESOS) y TOTAL PAGADO S/IVA. `totales` y
        `totalesFlota` no traen `costo_usd`, `costo_usd_siva`,
        `iva_pagado_usd`, `iva_pagado_mxn` ni un promedio de
        `costo_hr_usd_siva` (tampoco antes: el mensual deja vacías COSTO
        TOTAL USD, USD S/IVA, IVA PAGADO y COSTO X HORA USD S/IVA) y
        pyservices no inventa totales. Si el cliente los pide: campos
        ADITIVOS en los dos objetos, con la semántica de las fórmulas de
        pyservices, en un contrato aparte. Sus filas son fórmulas SIN
        redondeo (`=Y/z`, `=AE−AE/1.16`, `=AG×z`), así que el total que
        cuadra con `ROUND(SUM())` es `round2(Σ Y÷z)` sobre las filas con
        T.C., no la Σ de los `costo_usd` ya redondeados.

50. **COMISIONES A CARGO DEL AVIÓN (6-oct-2026, API 0.0.65, SIN
    migración).** Pedido del cliente: «En el balance, cuando hay una comisión
    de un banco, en la parte de total cobrado no refleja el monto real que
    entró a la cuenta… La comisión del banco y vendedor se puede ir a la
    columna de (comisiones del vendedor) pero cambiar el nombre a
    "comisiones"… para que el monto real total cobrado ya sea después de
    cualquier comisión. Por si no le estaríamos poniendo dinero al socio.»
    Respuestas (6-oct): la comisión del vendedor la ABSORBE el avión; lo que
    se le cobra al cliente por ella se queda como ingreso de VuelaTour;
    vigencia desde septiembre de 2026 («es el cierre que estamos haciendo»).
    - **Vigencia**: `fecha_vuelo` (día Cancún) ≥ clave
      `comisiones_al_avion_desde` (`CONFIG_COMISIONES_AL_AVION_DESDE`,
      `valor_json` = `["AAAA-MM-DD"]`, `ConfiguracionService.fecha`, caché
      60 s; sin fila o inválida ⇒ `COMISIONES_AL_AVION_DESDE_DEFAULT` =
      2026-09-01; NO se siembra, se cambia por SQL). El general la lee UNA
      vez para todos sus libros. Servicio armado sin ConfiguracionService
      (specs) ⇒ el default. **Vuelos anteriores: TODO byte-idéntico**
      (verificado contra el 0.0.64 con un spec temporal: libros
      individuales, general mensual/general y `compute`).
    - **Fuente única PURA** `common/comisiones-avion.util.ts`
      (`comisionesDelVuelo` ⇒ `{aplica, banco_mxn, banco_usd, vendedor_mxn,
      vendedor_usd, total_mxn, total_usd, detalle, banco_sin_tc,
      vendedor_sin_tc}`): el balance usa MXN y el reparto USD; prohibido
      reimplementarla. Recibe `estado` (no un booleano `cancelado`: UNA
      entrada decide las dos reglas de estado y los lectores no pueden
      mandarlas contradictorias). BANCO = por cobro, comisión × el MISMO
      factor con que el cobro se prorratea al avión (`factor_avion`; 1 en
      CANCELADO o sin precio; con SOBRECOBRO —lo cobrado del vuelo por
      `cobrosEnUsd` con K de respaldo supera el total— se TOPA como
      `cobradoParteAvion`: cobrado al avión ÷ cobrado, revisión 6-oct: el
      excedente es de VuelaTour y su comisión también) y la parte de ESTE
      avión con la MISMA función que reparte la venta y el cobro
      (`parteAvion` / `repartirUsd`) — sin sobrecobro es el primer término
      de `parteFilaDeCobro`: Σ aviones + VuelaTour == comisión al centavo.
      La bancaria aplica en CUALQUIER estado: sigue al cobro, que el balance
      cuenta (el anticipo de un CONFIRMADO ya entró a la cuenta). VENDEDOR =
      PROVISIÓN = `pagoVendedorUsd(p)` (comisión + IVA si la cotización
      grava) × la parte del avión, en MXN al K del vuelo; **SOLO en
      COMPLETADO** (revisión 6-oct-2026: el universo del reparto, que solo
      lee COMPLETADO y CANCELADO — en un SOLICITUD/COTIZADO/RESERVA/
      CONFIRMADO/EN_VUELO el balance lista la venta y POR COBRAR la
      neutraliza, pero la provisión restaba de la utilidad cobrada y de los
      socios una comisión que aún no existe, «otros movimientos» le cobraba
      al avión una cotización y el balance dejaba de cuadrar con el
      reparto); nunca con partición inconsistente; NO depende del gasto real
      `COMISION_VENDEDOR`. Cobro MXN ⇒ USD = comisión ÷ (T.C. del cobro ??
      K); cobro USD ⇒ MXN = comisión × (T.C. del cobro ?? K); sin T.C. no se
      suma (pendiente de siempre de la comisión USD; `vendedor_sin_tc` ⇒
      pendiente nuevo). **SUPERSEDIDO el 13-oct-2026 (invariante 61)**:
      «VENDEDOR = PROVISIÓN … NO depende del gasto real» ya no vale — en el
      MISMO universo (vigencia ∧ COMPLETADO ∧ partición consistente ∧
      comisión cotizada > 0) el avión absorbe el pago REAL (Σ gastos
      `COMISION_VENDEDOR` del vuelo, entrada `gastos` del util) y sin gasto,
      nada; `comision_vendedor_prov_mxn` viaja en 0 y nacen
      `comision_vendedor_real_mxn` / `_real_pagos`. **AJUSTADO el mismo
      13-oct-2026 (dos categorías, invariante 61)**: la parte del vendedor
      es SOLO la «Comisión del vendedor (avión)» (`COMISION_VENDEDOR_AVION`)
      y su universo ya NO es el de esta invariante: COMPLETADO, o CANCELADO
      con cobros retenidos, en CUALQUIER fecha —también ANTES de la vigencia
      (la fila y sus llaves nacen solo si absorbe, con banco 0)— y sin exigir
      comisión cotizada ni partición consistente. Esta vigencia gobierna SOLO
      la parte BANCARIA. La «Comisión del vendedor (VuelaTour)» nunca la
      absorbe el avión.
    - **Balance por avión** (`buildPayload`). R1, en TODA fila de la
      vigencia (EXTERNOS incluido): cada cobro gana `neto_mxn` (=
      `monto_mxn − comision_mxn` de la fila, AL FINAL) y `cobrado_con`
      empieza con «Bruto $20,400.00 · comisión banco 5 % $1,020.00 · neto
      $19,380.00 · …» (`etiquetaCobradoCon` con `comision`);
      `cobrado_real_mxn` = Σ netos. COBRADO AVIÓN (`cobrado_mxn`), POR
      COBRAR y la red de «pagado completo» siguen en BRUTO. R3/R4 SOLO en
      filas de un AVIÓN con parte de la venta (el libro EXTERNOS no tiene
      avión ni socios: su comisión bancaria sigue completa en «otros
      movimientos»): llaves ADITIVAS al final `comisiones_mxn` (null = sin
      comisiones), `comisiones_detalle` (nota de la celda: una línea por
      concepto, «N conceptos» con más de uno), `comision_banco_avion_mxn`,
      `comision_vendedor_prov_mxn` (0 en un vuelo no COMPLETADO);
      `ganancia_mxn` = round2(remanente − comisiones) ⇒ `ganancia_usd`, la
      cascada de «balance» y los socios
      quedan después de comisiones. `comision_vendedor_mxn` sigue null
      (compat). Totales (libro y flota): `comisiones_mxn` y sus dos partes
      SOLO si alguna fila trae la regla. RESUMEN del general:
      `comisiones_mxn` = las del libro (VENTA − COSTO − COMBUSTIBLE −
      COMISIONES = GANANCIA). Bloque `balance` (0.0.66, ADITIVOS al final,
      con la MISMA condición que los totales): `comisiones_usd` y
      `utilidad_antes_comisiones_usd` (ver «Ajuste 0.0.66» abajo).
    - **«Otros movimientos»** (`buildOtrosMovimientos`, parámetro
      `comisionesAvion` que arma `xlsxGeneral` con las partes TAL CUAL de
      las filas de los libros — nadie las recalcula ahí): el egreso de
      comisión bancaria es SOLO la parte de VuelaTour (comisión − partes de
      los aviones; $0 ⇒ no se pinta; sufijo «(parte VuelaTour: la del avión
      va en su columna COMISIONES)»), también el apareado con «Comisión
      BillPocket»; la fila del vuelo conserva el ingreso de la comisión
      cobrada (UNA vez) y, si los aviones cargan la provisión del vendedor
      (`comision_vendedor_prov_mxn` > 0 en sus filas), su egreso del
      vendedor es `pagoVendedorCubiertoPorAvion` (0.0.66, abajo).
      **SUPERSEDIDO el 12-oct-2026 (invariante 58): la PROVISIÓN ya no se
      pinta en «otros movimientos»** — sin gasto real `COMISION_VENDEDOR`
      la fila no lleva egreso del vendedor (ni la marca del amarillo) en
      ninguna regla; `pagoVendedorCubiertoPorAvion` solo se llama con gasto
      real. **SUPERSEDIDO el 13-oct-2026 (invariante 61)**:
      `pagoVendedorCubiertoPorAvion` se ELIMINÓ; con gasto real en un vuelo
      que absorben los aviones (`comision_vendedor_real_pagos > 0` en sus
      filas) el egreso es 0 con `conceptoPagoVendedorACargoDelAvion` («· a
      cargo del avión XB-PEV ($… en su columna COMISIONES)»). El 0.0.65
      agregaba UNA línea de INGRESO por avión «comisión del vendedor a cargo
      del avión XB-PEV (regla sep-2026)» con el egreso completo (provisión o
      real): ELIMINADA en el 0.0.66 junto con `conceptoVendedorACargoDelAvion`
      y su clasificación en `colapsarFilasDeVuelo` (`etiquetaReglaComisiones`
      se conserva: pyservices ya acepta `regla_comisiones`). Sin partes
      (fuera de la vigencia, sin avión o llamada directa) la pestaña es la de
      siempre (golden). El bloque «VUELATOUR (empresa)» sale solo de esas
      filas (invariante 47).
    - **Reparto a socios** (`computeAvion`): por vuelo de la vigencia,
      `comisionesDelVuelo(...).total_usd` (con `parte` = `repartirUsd` y el
      K capturado ?? oficial) se suma en `ingresos.comisiones_venta_usd` —
      el campo de siempre, que PDF/XLSX y panel ya restan en la cascada —
      ⇒ `saldo_disponible_usd`, reparto, `utilidadesSociosPorMes` y la
      cuenta corriente. `fetchCobros` trae `comision_banco_monto,
      comision_banco_pct, metodo_cobro`; `detalle.vuelos[]` gana
      `comisiones_avion_usd`, `comision_banco_avion_usd`,
      `comision_vendedor_prov_usd` (solo vigencia). El bloque informativo
      `externos` no cambia.
    - **Sin cambio**: Libro Dinero, reporte por vuelo, PDF de cotización y
      pre-cierre (salvo las cuentas de los socios, que leen el reparto).
      `dashboards.overview` (revisión 6-oct): su «Gastos» (por avión y
      `gastos_totales_usd`) SÍ incluye `comisiones_venta_usd` — el saldo ya
      las descontó y sin ellas Ingresos − Gastos ≠ Saldo — con el desglose
      ADITIVO `comisiones_usd` (por avión y en el resumen); antes de la
      vigencia valen 0 y el tablero es el de siempre.
    - **PENDIENTE DE DECISIÓN DEL CLIENTE (revisión 6-oct-2026; el
      contrato no lo decide)**: si la cotización ya cobró la comisión
      bancaria al cliente como EXTRA («Comisión BillPocket», «Comision
      transferencia»), HOY ese extra sigue siendo ingreso de VuelaTour y el
      avión igual absorbe su parte proporcional de la comisión (regla
      literal del contrato y el mismo trato que el cliente decidió para la
      comisión del vendedor —lo cobrado al cliente es de VuelaTour y el
      avión la absorbe—, pero por el extra bancario nadie preguntó).
      Alternativa si el cliente dice que el extra CUBRE la comisión: en el
      util, parte del avión = factor × max(0, comisión − extra de comisión
      cobrado en MXN) y el egreso de VuelaTour con el mismo dato. Caso real
      ÚNICO (ago–oct): #293 (20-sep, COMPLETADO): 840 USD de tiempo + 100 de
      TUA + 35 de «Comision transferencia (sin IVA)» ($595 al K 17); cobros
      240 USD en efectivo + $12,495 por Paywise con $624.76 de comisión ⇒ el
      avión absorbe $538.25 (factor 840/975) y VuelaTour se queda $595 −
      $86.51 = $508.49; con la alternativa el avión absorbería $25.64. NO
      cambiar sin la respuesta; confirmarla ANTES de regenerar el cierre de
      septiembre.
    - **Consecuencia aceptada**: el reparto de SEPTIEMBRE ya entregado baja
      (comisiones bancarias y del vendedor): la cuenta corriente puede marcar
      adelantos — avisar al cliente.
    - **Ajuste 0.0.66 (7-oct-2026, SIN migración; contrato «comisiones
      ajuste general»).** Pedido del cliente: «Estas comisiones se están
      duplicando en la general, ya que las tenemos en el apartado de "Otros
      movimientos"… deben aparecer pero en el individual de los avioncitos,
      ya que en el reporte de los aviones no está la pestaña "Otros
      movimientos"», y «en "otros movimientos", en el ingreso estás
      duplicando la comisión» (#247: «comisión vendedor (Pablo Canales) =
      $5,467.97 · comisión del vendedor a cargo del avión N4142R (regla
      sep-2026) = $5,467.97» ⇒ ingreso $10,935.94).
      - **Lo que NO cambia** (fixture CONGELADO del 0.0.65 en
        `aircraft-balance.service.comisiones-general.spec`): el cálculo de
        `comisionesDelVuelo`, la fila (COMISIONES, ganancia), la cascada
        (antes/después/cobrada), los socios, el RESUMEN, el reparto, las
        utilidades por mes y la cuenta corriente. Ni un centavo.
      - **«Otros movimientos»**: sin la línea «a cargo del avión»; con
        provisión de los aviones el egreso del vendedor es
        `pagoVendedorCubiertoPorAvion` (`comisiones-avion.util.ts`, puro):
        «pago comisión vendedor (Pablo Canales) · cubierto por el avión
        XB-PEV (provisión $5,467.97 en su balance) · PROVISIÓN (sin gasto
        real capturado)» por $0 sin gasto real (la cola es
        `MARCA_PROVISION_SIN_GASTO_REAL`, revisión 7-oct-2026: es la marca
        «· PROVISIÓN (» con que pyservices pinta el AMARILLO pedido el 6-oct
        —`_MARCA_PROVISION`—; sin ella los completados de la regla salían
        sin amarillo, como si el pago ya estuviera capturado, mientras la
        leyenda «Amarillo = provisión» seguía saliendo por algún vuelo no
        realizado; con gasto real NUNCA la lleva);
        con gasto real «· gasto real $X[ (N pagos)]» y egreso =
        max(0, round2(pagado − provisión)) con «· excede $X MXN» (≥ 1.00);
        menor ⇒ egreso 0 con «· parcial: faltan $X MXN» (aún se le debe al
        vendedor; el avión ya lo cargó); USD sin T.C. como
        `conceptoPagoVendedorReal` (ninguno convierte ⇒ egreso null).
        Multi-avión: «cubierto por los aviones A (provisión $a en su
        balance) y B (provisión $b en su balance)». Solo la PRIMERA línea de
        comisión lleva el egreso (la provisión cubre todas); el pago real
        queda apareado (no sale como solo-egreso). Fecha: la del pago más
        reciente o la del vuelo. Remanente de cada fila y resultado del
        bloque VUELATOUR = los del 0.0.65 (Σ ingreso − egreso no cambia:
        sale la provisión de los dos lados), SALVO un pago real MENOR que la
        provisión: el 0.0.65 contaba ese faltante como ingreso de VuelaTour
        y ahora no (queda «parcial: faltan»; PENDIENTE de confirmar con el
        cliente, ver «Pendientes conocidos»). Conservación (spec): Σ
        ganancia de los libros + Σ remanente de la pestaña == la regla
        anterior menos esos faltantes. **SUPERSEDIDO el 12-oct-2026
        (invariante 58) en lo que toca al pago SIN gasto real**: ya no sale
        el egreso por $0 con la marca de PROVISIÓN (la fila no lleva egreso
        del vendedor) y la conservación pasa a ser «la regla anterior − las
        provisiones de los vuelos sin gasto real − esos faltantes»; con
        gasto real, todo lo de arriba sigue byte a byte. **SUPERSEDIDO el
        13-oct-2026 (invariante 61) también con gasto real**: ya no hay
        provisión que exceder — el avión carga el pago REAL completo y la
        pestaña lo trae con egreso 0 «· a cargo del avión …» (con
        «excede/faltan» contra lo COBRADO); la conservación vuelve a ser
        EXACTA: Σ ganancia + Σ remanente == la regla anterior, al centavo.
      - **`balance.comisiones_usd`** (por avión, ADITIVO): Σ por fila de
        lo que la fila RESTÓ, en USD. Con K (lo normal):
        `comisionesDelVuelo(...).total_usd` — la MISMA cifra por vuelo que
        `ingresos.comisiones_venta_usd` del reparto (fuente única). SIN K
        (revisión 7-oct-2026): `comisiones_mxn` ÷ el T.C. con que la fila
        convierte su ganancia (`z ?? tcPromedio`) — el util no puede llevar
        las dos monedas por el mismo camino (la provisión del vendedor no
        llega a pesos, `vendedor_sin_tc`, y un cobro sin T.C. propio solo
        llega a una), así que `total_usd` traía la provisión que la fila NO
        restó e inflaba «antes de comisiones»; el reparto sí la resta en USD
        y la diferencia ya la grita el pendiente «comisión del vendedor sin
        TC de venta». Fila sin comisiones en pesos o sin ganancia USD
        (ningún T.C. en el libro): 0. Coincide con el reparto al centavo
        salvo la comisión bancaria de ANTICIPOS de vuelos aún no realizados
        (el balance cuenta su cobro y su comisión; el reparto no lee el
        vuelo — septiembre real: #314 CONFIRMADO con $5,000 de comisión
        Paywise) y los vuelos sin K.
        **`balance.utilidad_antes_comisiones_usd`** = round2(utilidad_antes
        + comisiones): la línea «UTILIDAD ANTES DE GASTOS USD (antes de
        comisiones)» de la cascada del GENERAL; round2(antes − comisiones)
        == `utilidad_antes_usd` al centavo. Puede diferir por CENTAVOS de Σ
        round2(REMANENTE ÷ T.C.) de las filas (el reparto redondea cada
        comisión en USD por vuelo; la fila redondea su ganancia neta): se
        eligió la cifra EXACTA del reparto para «(−) COMISIONES». Solo
        centavos porque, en prod, el T.C. de costos de la fila (Z) y el de
        cada cobro son el K: los gastos MXN ligados a un vuelo no traen
        `tc_gasto` (ago–oct: 0 de 592) y los cobros con comisión de la
        vigencia llevan el T.C. de su cotización (12 de 12); si eso cambia,
        la diferencia es la de convertir las comisiones a esos T.C. y no al
        de la ganancia de la fila.
      - **pyservices** (mismo contrato): el libro GENERAL ya no pinta la
        columna COMISIONES MXN en «reporte horas FLOTA» (GANANCIA MXN =
        ROUND(REMANENTE, 2) en el mensual; REMANENTE VENTA MENOS COMPRA =
        ROUND(VENTA − PROVEEDOR, 2) en el general) y su cascada gana «antes
        de comisiones» (valor del API) y «(−) COMISIONES (banco + vendedor)
        USD»; el INDIVIDUAL no cambia. El RESUMEN del general conserva su
        columna COMISIONES MXN. Sin `comisiones_usd` (API ≤ 0.0.65) la
        cascada del general queda como antes. Deploy: pyservices ANTES del
        API 0.0.66.
      - **Revisión (7-oct-2026, mismo 0.0.66, sin migración)**: (1) el pago
        al vendedor «cubierto por el avión» SIN gasto real conserva la
        marca de PROVISIÓN (`MARCA_PROVISION_SIN_GASTO_REAL`, arriba): con
        el pyservices de hoy vuelve el amarillo que el primer 0.0.66 les
        quitaba (en prod, los completados de la vigencia sin gasto
        `COMISION_VENDEDOR`: 14 de septiembre y 4 de octubre), sin tocar
        pyservices (su `_MARCA_PROVISION` ya la busca; verificado pintando
        el general con el pyservices 3e33997: amarillas las mismas filas que
        con la regla anterior). Su test `_FILA_CUBIERTA` todavía copia el
        texto SIN la marca. SUPERSEDIDO el 12-oct-2026 (invariante 58): con
        el API 0.0.73 ninguna fila lleva la marca ni el amarillo (y desde el
        0.0.74, invariante 61, la marca y su función se eliminaron). (2)
        `comisiones_usd` sin K = lo que la fila restó (arriba). (3) La
        `nota` del bloque VUELATOUR precisa el egreso del vendedor cubierto
        (invariante 47). (4) `regla_comisiones` sigue SIN viajar (ni en los
        balances ni en el reparto): pyservices escribe su respaldo «regla de
        septiembre 2026», que ES la vigencia default y la de prod (no hay
        fila `comisiones_al_avion_desde`). **Antes de cambiar la vigencia
        por SQL** hay que mandar `regla_comisiones:
        etiquetaReglaComisiones(vigencia)` en los TRES payloads (individual,
        general y reparto) —por eso la función se conserva— o los textos
        seguirán diciendo septiembre. Specs nuevos: util (la marca es la de
        pyservices y solo la lleva el pago sin gasto real), general (vigencia
        a mitad del periodo en `comisiones_usd` y en la pestaña; vuelo SIN
        K; libro sin ningún T.C.; DOS líneas `COMISION_VENDEDOR` con pago
        mayor que la provisión ⇒ el exceso UNA vez; el amarillo; la nota de
        la empresa) y `balance-empresa.util.spec` (la nota con y sin la
        señal); mundos `conVueloSinK`, `mundoDosSoloSinK` y
        `conVueloDosComisiones` en `comisiones-general.fixture-spec`.
        Mutación: 14 mutantes de las cuatro reglas, todos muertos.
    - **Deploy**: pyservices (pinta `neto_mxn`, COMISIONES y GANANCIA =
      REMANENTE − COMISIONES; tolera la ausencia de los campos) ANTES del API
      0.0.65: un pyservices previo pinta COBRO n en bruto y GANANCIA =
      REMANENTE, y el verificador de fórmulas degrada esas celdas a valor
      sin explicar la diferencia. Después, regenerar el balance de
      septiembre.
    - Specs: `comisiones-avion.util.spec`, `cobro-etiqueta.util.spec`
      (comisión), `aircraft-balance.service.comisiones.spec` (fila, cobros,
      totales, antes/después/día de la vigencia, mitad del periodo, sin
      config, CANCELADO, IVA, multi-avión, EXTERNOS, «otros movimientos» y su
      golden pre-vigencia, RESUMEN, bloque VUELATOUR, una lectura de config)
      y `profit-sharing.service.comisiones.spec` (saldo, antes de la
      vigencia, select de cobros, CANCELADO, multi-avión, utilidades por
      mes, cruce con el balance). `cobrado-con` y `bloque-empresa` corren
      con vigencia POSTERIOR (prueban la regla de siempre). Revisión 6-oct:
      util (provisión solo en COMPLETADO; sobrecobro), balance (vuelos no
      realizados y cascada; anticipo de un CONFIRMADO; «otros movimientos»
      solo del COMPLETADO; BillPocket apareado con conservación del dinero;
      sobrecobro; vuelo sin K con T.C. oficial), reparto (corte por día
      Cancún; cobro MXN sin T.C. en vuelo sin K; cruces con no realizados y
      sin K) y `dashboards.service.overview-comisiones.spec`. 0.0.66:
      `aircraft-balance.service.comisiones-general.spec` (mundo
      `comisiones-general.fixture-spec`: dos aviones con socios, multi-avión,
      externo, anticipo CONFIRMADO, BillPocket, el #247 con IVA y pagos reales
      por encima y por debajo de la provisión) — fixture CONGELADO del 0.0.65
      (bloques del individual y del general, reparto, RESUMEN, pestaña
      número por número), `comisiones_usd` == reparto, la identidad de la
      cascada, «otros movimientos» sin la línea y con el egreso cubierto,
      bloque VUELATOUR y conservación; `comisiones-avion.util.spec`
      (`pagoVendedorCubiertoPorAvion`) y los casos del 0.0.65 de
      `aircraft-balance.service.comisiones.spec` actualizados a la regla.

51. **RLS NO AÍSLA POR ROL: SIN POLÍTICAS DE LECTURA PARA USUARIOS FINALES
    (8-oct-2026, migración `20261008000001` APLICADA).** Caso «los pilotos
    ven vuelos que no son de ellos» (#404 Chetumal): la app y el panel NO
    exponen vuelos ajenos (filtro `piloto_id` forzado en el controller de
    `GET /flights`, `assertAccess` en detalle/snapshot/legs/payments,
    `/v1/calendar` solo oficina, alertas sin PILOTO), pero desde mayo-2026
    32 tablas (vuelo, escala, cobro_vuelo, gasto, cliente, cuenta_bancaria,
    movimiento_bancario, tarjeta_corporativa…) tenían la política
    `<tabla>_read_active_user` = «cualquier usuario ACTIVO lee todo» vía
    PostgREST con la anon key del APK. Se dropearon las 32 (+
    `aeronave_imagen_read_public`, qual `true`). Hallazgo del dry-run: en la
    práctica NUNCA funcionaron porque `usuario_admin_select_all`
    (`20260512000001`) consulta `usuario` dentro de su propio qual y toda
    lectura autenticada que toque `usuario` termina en 42P17 «infinite
    recursion»; solo `aeronave_imagen` (52 filas) se leía. Hoy toda lectura
    directa como usuario final devuelve 0 filas; `usuario` sigue en 42P17
    (no se tocó). Sin políticas de escritura para `authenticated`.
    - **REGLA DURA:** el aislamiento por rol vive en el API (controller +
      `assertAccess`), NUNCA en RLS; ni la app ni el panel leen tablas con
      el token del usuario (cero `.from(` fuera de storage, cero
      realtime/rpc, cero edge functions) y así debe seguir. Un endpoint
      nuevo de lectura de vuelos fuerza el filtro en el controller o pasa
      por `assertAccess`.
    - **Pendientes de decisión del cliente (anotados, no tocados):**
      `GET /expenses/sugerir-vuelo` (@Roles incluye PILOTO) devuelve la
      siguiente salida de cualquier avión ±7/+14 días y la app de piloto no
      lo usa (solo `FuelLoadScreen` del mecánico); `GET
      /aircraft/:id/tacometros` sin @Roles (rutas pasadas de todos); el
      mecánico ve TODOS los vuelos (decisión del 18-jun) y su «Vuelos de
      hoy» en la app lista también los de mañana (`todayFlights` pide
      ayer–mañana y solo ordena); el panel web solo bloquea VISITANTE
      (PILOTO/MECANICO entran, el API les niega los datos).

52. **VISTA EN PANTALLA DE LOS BALANCES = EL MISMO LIBRO (12-oct-2026, API
    0.0.68).** Pedido del cliente: «ver el balance como el Excel sin
    descargarlo… mismo formato, colores y estructura» y después «editar la
    celda y que afecte a lo relacionado». `GET
    /v1/aircraft/balance-general/libro?desde&hasta&modo` y `GET
    /v1/aircraft/:id/balance/libro?desde&hasta` (ADMIN/ANALISTA, los mismos
    DTOs y roles que los .xlsx; la literal va ANTES de `:id`) devuelven
    `{libro, desde, hasta, modo | matricula, archivo}`: `libro` es el JSON
    que arma pyservices (`libro_json`, `POST /pdf/balance-*-libro`) del
    MISMO libro openpyxl que se descarga —hojas, celdas con el número del
    API y su texto formateado, fórmulas visibles, estilos, combinadas, notas
    y el rojo de los negativos— y `archivo`, el nombre con que bajaría el
    .xlsx. REGLA: el payload se arma UNA sola vez (`payloadAvion` /
    `payloadGeneral`, privados) y lo comparten `xlsx*` y `libro*`: la
    pantalla y el Excel no pueden divergir ni en un número. El API no lee
    ni recalcula celdas (`LibroVista` en `pyservices/libro-vista.types.ts`
    es solo el tipo que transporta). Fase 2 (edición): cada celda podrá
    traer `vinculo {tipo, id, campo}` que pyservices anota; el PATCH del
    registro y la regeneración del libro vivirán aquí. Deploy: pyservices
    (f407786) antes que el API. Spec: `aircraft.controller.spec` (rutas,
    roles, orden, cuerpo) y los specs del balance (el refactor del payload
    no cambia una llave: `aircraft-balance.service.modo.spec`).

53. **PERMISO AFAC: TARIFA POR FILA EN EL GENERAL Y BLOQUE «PERMISOS AFAC»
    EN «OTROS MOVIMIENTOS» (12-oct-2026, API 0.0.69, sin migración).**
    Pedido de Ale: «una de las columnas de Permisos de AFAC necesitamos que
    venga con la fórmula en el excel» (columna T, PERMISO AFAC (PROVISIÓN),
    de la hoja de vuelos) y «en el balance general en la página de otros
    movimientos no se ven los AFAC, aquí deben estar también».
    - Cada fila de `BalanceAvionVueloPayload` gana el ADITIVO
      `permiso_afac_usd_hr` = la tarifa del avión del libro
      (`permisoAfacUsdHr`; null en EXTERNOS y sin tarifa). El consolidado la
      hereda por el spread. La provisión `permiso_afac_mxn` NO cambia (sigue
      siendo `round2(tarifa × z × D)`): pyservices solo la escribe como
      fórmula por fila en la hoja de la flota (en el individual ya citaba
      `$B$1`).
    - `BalanceHojaOtrosMovimientosPayload.afac` (ADITIVO) lo arma la fuente
      única PURA `aircraft/afac-otros-movimientos.util.ts#bloqueAfacOtrosMovimientos`
      sobre los libros YA calculados: por avión la provisión del periodo (Σ
      `totales.permiso_afac_mxn`, cuántas filas la traen, la tarifa) y los
      permisos PAGADOS (filas de su hoja `permisos`, gastos PERMISO), con
      totales y `remanente_mxn` = provisión − pagado. **INFORMATIVO por
      diseño**: la provisión ya resta en cada avión y los permisos pagados en
      su hoja «permisos»; pyservices lo pinta DEBAJO de TOTALES y no entra a
      los totales de la pestaña ni al bloque VUELATOUR (invariante 47 lee
      `filas`/`filas_sueltas`, no `afac`). Sin provisión ni pagos la llave NO
      viaja (payload byte-idéntico). Nadie recalcula una provisión aquí.
      **SUPERSEDIDO el 13-oct-2026 (invariante 62)**: desde el API 0.0.74
      las filas «AFAC · matrícula» SUMAN dentro de `filas` (TOTALES y bloque
      VUELATOUR) y el API ya no manda `afac` (`bloqueAfacOtrosMovimientos`
      se eliminó); el bloque informativo solo lo pinta pyservices para un
      API 0.0.69–0.0.73.
    - Deploy: pyservices (lee los dos aditivos; un pyservices previo los
      ignora: columna como valor y sin bloque) → API. Specs:
      `afac-otros-movimientos.util.spec.ts`.

54. **FECHA DEL VUELO EN LOS CANDIDATOS DE COBRO (12-oct-2026, API 0.0.69,
    sin migración).** Pedido del cliente: «agregar la fecha del vuelo y la
    fecha de cobro porque por ejemplo el vuelo es del 04 de octubre y el 06
    se cobró y solo estamos viendo el del cobro». ADITIVO `fecha_vuelo`
    (ISO de `vuelo.fecha_vuelo` o `vuelo_grupo.fecha_vuelo`; null si no
    resuelve — fuente única `common/fecha-vuelo-candidato.util.ts#fechaVueloDe`)
    en TODO lo que lista cobros o sobres candidatos: `CandidatoCobroVuelo` y
    `CandidatoSobreGrupo` de `GET conciliacion/movimientos/:id/candidatos-cobro`,
    `CandidatoAbonoFicha` de `sugerir-abonos` (propuesta y alternativas) y
    los candidatos del 409 `ABONO_TIENE_COBRO_CANDIDATO` (`details.candidatos`,
    `cobrosQueCuadranConAbono`). Los embeds `vuelo:vuelo!vuelo_id(folio,
    fecha_vuelo, …)` y `grupo:vuelo_grupo!grupo_id(…, fecha_vuelo, …)` van
    en la MISMA consulta (cero round-trips). El panel pinta «vuelo 4 oct ·
    cobro 6 oct» (`fechasCandidatoCobro`); con un API previo, solo el cobro.

55. **EL REPORTE DE CONCILIACIÓN SALE EN EL ORDEN DEL ESTADO DE CUENTA
    (12-oct-2026, API 0.0.70, migración `20261012000001` PENDIENTE de
    aplicar).** Pedido del cliente: «cuando se exporta el estado de cuenta
    me lo acomoda diferente al estado de cuenta que subimos, y para comparar
    necesitamos tenga el mismo orden».
    - `movimiento_bancario.orden_archivo` = posición de la línea en el
      archivo importado (1 = primera línea de `dto.movimientos`, contando
      también las que se descartan por no traer fecha). `ejecutarImport` la
      escribe SOLO con la columna aplicada (sonda única
      `common/orden-archivo-disponible.util.ts#ordenArchivoDisponible`,
      patrón `columnaOpcional`); la dedupe (`emparejarDuplicados`) conserva
      el campo. Las líneas de antes quedan null (se insertaron en lote: su
      orden original no se puede reconstruir).
    - `reporteXlsx` lee `estado_cuenta_id` siempre y `orden_archivo` con la
      sonda, y ordena con la fuente única PURA
      `conciliacion/orden-estado-cuenta.util.ts#ordenarComoEstadoDeCuenta`:
      si TODAS las líneas del reporte salieron del MISMO archivo y traen su
      posición, el orden del archivo tal cual (aunque vaya del más nuevo al
      más viejo: así lo ve el cliente en su banco); si no (varios archivos,
      líneas a mano o anteriores), cronológico de siempre y, en el mismo día,
      primero las del archivo por posición y luego las demás por
      `created_at`. La lista del panel NO cambia (fecha desc).
    - Sin la migración: nada cambia (la sonda apaga lectura y escritura).
      Spec: `orden-estado-cuenta.util.spec.ts`.

56. **1 ABONO ↔ N COBROS DE VUELO («un pago para varios vuelos», 12-oct-2026,
    API 0.0.71, migración `20261012000002` PENDIENTE de aplicar).** Pedido
    del cliente: «al momento de vincular un cobro o ingreso puedas
    seleccionar 2 para un solo cobro… hicieron un pago para el vuelo 379 y
    380». Hasta el 0.0.70 un abono solo se ligaba a UN cobro
    (`movimiento_bancario.cobro_id`, índice único).
    - **Modelo (mismo patrón que la invariante 40)**: la liga vive en la
      PUENTE `movimiento_bancario_cobro (movimiento_id, cobro_id,
      monto_parte)` y `movimiento_bancario.cobros_n` es su espejo. Hasta el
      0.0.77 llevaba índice ÚNICO por `cobro_id` (un cobro se conciliaba UNA
      vez); desde la invariante 77 (20261014000003) es M:N: sin
      `uq_mov_cobro_parte_cobro` ni `uq_mov_bancario_cobro`, con el índice NO
      único `idx_mov_cobro_parte_cobro (cobro_id, movimiento_id)`. `cobro_id`
      queda como ESPEJO DERIVADO (= la parte con `cobros_n = 1`; NULL con 0
      o ≥ 2): lo siguen leyendo panel/app previos y el embed `cobro:cobro_vuelo!
      cobro_id(...)`. Triggers: A (candados por fila: ABONO sin
      gasto/sobre/ingreso/reverso; cobro positivo, sin sobre, sin anticipo y
      —hasta el 0.0.77— libre; desde la 77 decide por COBERTURA: cubierto o
      «de un solo abono» con otro ⇒ `COBRO_YA_CONCILIADO`, un PARCIAL admite
      más abonos), B (espejos `cobros_n`/`cobro_id`/`conciliado`/
      `clasificacion_id`/`updated_by`), C (espejo LEGADO: un `cobro_id`
      escrito directo —API ≤ 0.0.70— se traduce a la puente; sobre un lote
      ⇒ `LOTE_SOLO_API_NUEVO`), D (con cobros ligados no entra
      gasto/sobre/ingreso/reverso —`MOVIMIENTO_YA_LIGADO`—; el abono no
      cambia tipo/monto/cuenta —`ABONO_LIGADO`— con UNO o más cobros desde
      la 77 (hasta el 0.0.77 solo un LOTE) y un LOTE no se desconcilia a
      mano) y K (constraint trigger DIFERIDO: espejos = puente o
      `COBROS_INCOHERENTES`; desde la 77 escucha también monto y cuenta).
      El CHECK de ingresos gana `and cobros_n = 0`. Backfill: cada
      `cobro_id` de hoy ⇒ una parte por |monto| (el abono completo; copió
      `updated_at`/`updated_by` del ABONO, por eso «Registró la liga» de un
      cobro solo cuenta desde `LIGAS_COBRO_REGISTRADAS_DESDE`, invariante
      78). Desde el 14-oct-2026 (invariante 77, migración 20261014000003)
      la puente es M:N: un cobro se paga con 1..N abonos y «conciliado» =
      CUBIERTO; en un lote cada cobro entra por su FALTANTE.
    - **Regla (RPC `conciliacion_ligar_abono_cobros`, espejo PURO
      `conciliacion/cobros-lote.util.ts#puedeLigarCobros`)**: 1 cobro ⇒
      parte = |abono| con las reglas de la 77 (parcial, de más, comisión,
      otra moneda). N ≥ 2 ⇒ todos en la MONEDA DE LA CUENTA
      (`LOTE_MONEDA_DISTINTA`), parte = NETO del cobro (`monto −
      comision_banco_monto`, lo que depositó el banco; desde la 77, su
      FALTANTE fuera de ese abono) y `|Σ netos − |abono||
      ≤ tolerancia_lote(N)` = least(1.00, greatest(0.02, 0.01 × N))
      (`ABONO_NO_CUADRA` con `details {monto_abono, suma_cobros,
      diferencia, tolerancia, moneda, cobros[]}`). Otros 409:
      `COBRO_YA_CONCILIADO` (también dentro del lote de OTRO abono),
      `COBRO_DE_GRUPO`, `COBRO_DE_ANTICIPO`, `COBRO_INVALIDO` (reembolso),
      `MOVIMIENTO_YA_LIGADO`, `REVERSO_INVALIDO`, `MOVIMIENTO_CON_LOTE` (un
      `cobro_id` suelto sobre un lote: se cambia con `cobro_ids`); 400
      `LOTE_INVALIDO`, `SOLO_ABONOS`, `COBRO_NO_EXISTE`. Errores 23514 con
      `message «CODIGO: …»`, `hint = CODIGO`, `detail = jsonb`
      (`leerErrorCobros`); los textos es-MX los arma `mensajeErrorCobros`.
    - **`PATCH /v1/conciliacion/movimientos/:id/cobro`** gana `cobro_ids`
      (1..50 uuid sin repetir; excluyente con `cobro_id`/`cobro_grupo_id`).
      Con la sonda ENCENDIDA todo `cobro_ids` va por la RPC (también con 1:
      así reemplaza un lote por un cobro en una transacción); `cobro_id`
      suelto sigue por el camino directo (trigger C mantiene la puente) con
      la pre-validación del trigger A (hasta el 0.0.77, «ocupado» = cualquier
      liga, también la de la puente; desde la 77, por COBERTURA con
      `prevalidarCobroUnico`: un PARCIAL admite el abono); desvincular
      (ambos null) sobre un lote llama `conciliacion_desligar_abono_cobros`
      ANTES del camino de siempre. Respuesta ADITIVA: `cobros_n` y
      `cobros_estado[{cobro_id, monto_parte, vuelo_id, folio, cliente,
      fecha_cobro, monto, moneda, metodo_cobro, comision_banco_monto, neto}]`.
    - **LECTOR ÚNICO `conciliacion/ligas-cobro.lector.ts#leerLigasDeCobros`**:
      espejo (`cobro_id` / `cobro_grupo_id` / `ingreso_id`, en lotes de ≤
      150 ids) + partes de la puente expandidas como ligas `{id:
      movimiento_id, cobro_id}` (`ligasDesdePartes`), para que la fuente
      única `cobro-conciliado.util` (`movimientoDeCobro`,
      `cobroEstaConciliado`, `conciliacionDeCobro`) vea un cobro de un lote
      sin cambiar una línea. Lo usan: `autoMatchAbono` (ocupados), el
      conteo de libres, `candidatosCobro` (ocupados; `movimiento.cobros_n`
      y `cobro_ids` ADITIVOS para que el panel marque los que ya paga),
      `ligasDeCobros` (Paywise y «cobros sin banco»), `abonosPendientes`
      (universo + puente paginada), `flights.adjuntarSobres` (chip
      «conciliado» de la card de cobros), `flights.assertCobroSinConciliar`
      (candado de PATCH/DELETE) e `ingresos.service` (vía de conciliación,
      ocupados del 409 y el replay de `cobro-de-vuelo`). **Nadie vuelve a
      consultar `movimiento_bancario` con `filtroLigaCobros` por su
      cuenta.** `GET movimientos` suma `cobros_n` y, con 2+ partes,
      `cobros[]` (vuelo, folio, cliente, montos), `cobros_suma` y
      `cobros_diferencia` (best-effort); el Excel pinta «Conciliado con: 2
      cobros: vuelo #379 ($1,000.00) · vuelo #380 ($2,500.00)» y la
      matrícula como unión de sus aviones.
    - **Sonda ÚNICA** `common/cobros-lote-disponible.util.ts`
      (`columnaOpcional(movimiento_bancario.cobros_n)`; la de parciales es
      `common/cobros-parciales-disponible.util.ts`, invariante 77). REGLA
      DURA: todo
      select/update/filtro que nombre `cobros_n`, la puente o las RPC va
      detrás de ella. Sin la migración: UN cobro como el 0.0.70, 2+ ⇒ 503
      `CONCILIACION_COBROS_NO_DISPONIBLE`, lectores solo con el espejo. El
      «sí» se memoriza: tras el ROLLBACK, reiniciar el API.
    - Specs: `cobros-lote.util.spec`, `ligas-cobro.lector.spec`,
      `cobros-lote-disponible.util.spec`,
      `conciliacion.service.cobros-lote.spec` (RPC emulada: partes = neto,
      espejo NULL, 409 sin escribir, lote de OTRO abono, DIFF, desvincular,
      candidatos, cobros sin banco, lista; sin migración 503 / camino
      directo) y `conciliacion.controller.cobros-lote.spec` (HTTP real: DTO,
      roles, 503 con `code`).

57. **REFACCIÓN A INVENTARIO/TIENDA DESDE EL ALTA DE GASTO (12-oct-2026,
    API 0.0.72, sin migración).** Pedido del cliente: «si se selecciona un
    avión al dar de alta un gasto de un artículo de inventario, una nota
    visual: entra a inventario pero se asignará/venderá a ese avión,
    quedando la traza del artículo»; «el gasto asignado directo al avión se
    va al avión sin cambiar el precio de venta; desde inventario debe pedir
    precio de venta obligatorio; el gasto REFACCION crea el ítem si no
    existe». Hasta el 0.0.71 un gasto REFACCION con avión era SOLO un gasto
    indirecto del avión y la bodega solo se alimentaba desde Compras.
    - **Contrato**: `POST /v1/expenses` acepta, SOLO con `categoria =
      REFACCION`, el bloque opcional `inventario: { item_id? | nombre (+
      numero_parte?, categoria?), cantidad > 0, precio_venta ≥ 0 (0 = a
      costo) OBLIGATORIO, precio_venta_moneda, vender_al_avion? }`
      (`RefaccionInventarioDto`). Sin el bloque, el alta es la de siempre
      («directo al avión»: gasto indirecto del avión, la bodega y el precio
      de venta del artículo NO se tocan). Un PATCH con `inventario` rebota
      400 `INVENTARIO_SOLO_AL_CREAR`.
    - **Validación ANTES de tocar la BD** (`refaccion-inventario.util.ts`,
      PURO + spec): `INVENTARIO_SOLO_REFACCION`, `INVENTARIO_MEDIO_BODEGA`,
      `INVENTARIO_ITEM_REQUERIDO`, `INVENTARIO_CANTIDAD_INVALIDA`,
      `INVENTARIO_PRECIO_INVALIDO`, `INVENTARIO_AVION_REQUERIDO` (vender al
      avión sin `aeronave_id`) e `INVENTARIO_TC_REQUERIDO` (pesos sin
      `tc_gasto` y sin T.C. oficial del día: la entrada se valoriza con el
      del gasto o, en su defecto, el oficial, la MISMA fuente que las
      compras). Códigos estables en `error`.
    - **El gasto de COMPRA se crea SIN `aeronave_id`/`vuelo_id`/`escala_id`**
      (`ExpensesService.create` → `crearGasto`): el avión recibe su cargo
      por la SALIDA de bodega (gasto REFACCION medio BODEGA, hoja
      «refacciones»); dejarle el avión al gasto de compra lo contaría DOS
      veces (indirectos + refacciones). Es el mismo modelo que Compras.
    - **La cadena** (`entrarRefaccionAInventario`, reutiliza lo que existe):
      `ComprasService.create({gasto_mercancia_id, moneda del gasto,
      tc_usd_mxn, UNA línea = monto ÷ cantidad a 4 decimales, item_id o
      nombre/nº de parte/categoría})` → `ComprasService.recibir(id, userId,
      forzar)` (la ENTRADA del cardex; `findOrCreateItem` crea el artículo
      si no existe) → `InventoryService.updateItem(precio_venta,
      precio_venta_moneda)` (el precio queda en la ficha: esta salida y las
      siguientes lo usan) → con `vender_al_avion`,
      `InventoryService.createMovimiento(SALIDA, cantidad, aeronave_id,
      venta_unitaria = precio_venta, fecha = la del gasto, referencia «Gasto
      <id8>»)` ⇒ el cargo de bodega del avión. Respuesta: el gasto fresco
      (ya con `compra_id`) + `inventario: { item_id, item_nombre,
      item_creado, compra_id, compra_folio, entrada_id,
      precio_venta_guardado, salida {movimiento_id, gasto_id, monto,
      moneda} | null, error: 'NO_DISPONIBLE'|'ITEM'|'COMPRA'|'RECIBIR'|
      'SALIDA'|null, avisos[] }`.
    - **El gasto YA creado NUNCA se borra** (candados de dinero, el patrón
      del reparto): cada etapa que falla se anota en `inventario.error` +
      `avisos` con qué hacer (la compra quedó ABIERTA → recibirla desde
      Compras; la pieza entró pero no salió → darle salida desde el
      artículo), lo hecho antes se conserva y el alta responde 201. Un
      replay idempotente (`client_request_id`) de un gasto que ya tiene
      `compra_id` NO arma otra compra (`inventario: null`).
    - Módulos: `ExpensesModule` importa `ComprasModule` e `InventoryModule`
      (ninguno importa `ExpensesModule`: sin ciclo); en el servicio van
      `@Optional()` para que los specs que lo arman a mano no cambien.
      Specs: `refaccion-inventario.util.spec.ts` y
      `expenses.service.inventario.spec.ts` (validación sin insertar, la
      cadena con sus argumentos exactos, cada etapa fallida, el PATCH).
    - Panel: ver «Refacción: directo al avión o a Inventario/Tienda» en
      `vuelatour-next/AGENTS.md` (segmento en el alta, precio de venta
      obligatorio, nota de la traza con avión, toast por etapa).

58. **SIN GASTO REAL, SIN PROVISIÓN DEL VENDEDOR EN «OTROS MOVIMIENTOS»
    (12-oct-2026, API 0.0.73, sin migración).** Pedido del cliente (punto
    17 del lote del 12-oct-2026), textual: «provisión: los gastos que
    todavía no se hacen no deben aparecer». Con la captura de la hoja 'otros
    movimientos' del Balance general en pantalla precisó: «son estas las
    provisiones que están en amarillo las que te digo» — las filas de
    vuelos con la línea de ingreso «comisión vendedor (Pablo Canales)
    $12,148.35» cuyo EGRESO decía «pago comisión vendedor (Pablo Canales) ·
    cubierto por el avión … · PROVISIÓN (sin gasto real capturado)» con
    $0.00 en amarillo y, en vuelos sin provisión del avión, «pago comisión
    vendedor (X) · PROVISIÓN (mismo monto que lo cobrado: comisión + IVA;
    sin gasto real capturado)» con el monto.
    - **Regla** (`buildOtrosMovimientos`, rama `COMISION_VENDEDOR &&
      !p.inconsistente`): mientras NO exista un gasto real «Comisión del
      vendedor» (`COMISION_VENDEDOR`) capturado en Gastos y ligado al vuelo
      (`pagosVendedorDeVuelo(...).n === 0`), la línea de comisión NO lleva
      egreso —`egreso_mxn`, `concepto_egreso` y `fecha_egreso` en null— en
      NINGUNO de los dos sub-casos de hasta el 0.0.72: con provisiones de
      los aviones (la rama «cubierto por el avión … · PROVISIÓN (sin gasto
      real capturado)» por $0.00, la marca del amarillo) y sin ellas (la
      PROVISIÓN por el mismo monto que lo cobrado con fecha del vuelo). El
      ingreso cobrado al cliente sigue (es dinero real): su concepto, monto
      y fecha no cambian, y el remanente conserva la fórmula de siempre
      (ingreso − egreso; con egreso null ⇒ remanente = ingreso). Con
      `n > 0` NADA cambia, byte a byte: `pagoVendedorCubiertoPorAvion` con
      gasto real (exceso / «parcial: faltan» en la vigencia) o
      `conceptoPagoVendedorReal` (gasto real sin provisión del avión, con
      «faltan/excede»); `hay_pago_vendedor_real` sigue igual; el pago real
      sin línea sigue saliendo como solo-egreso.
    - **Bandera ADITIVA `sin_provision_vendedor: true`** (viaja SIEMPRE
      desde el 0.0.73; declarada opcional en `pyservices.service.ts` porque
      un API previo no la manda): en el payload de `otros_movimientos` del
      general (al final del objeto, junto a `hay_pago_vendedor_real`) y al
      nivel raíz del payload INDIVIDUAL de cada avión (`buildPayload`:
      libros individuales y `aviones[]` del general; el consolidado «FLOTA»
      del general, armado a mano, no la lleva: su nota no habla del pago al
      vendedor). pyservices activa con ella sus leyendas nuevas (fila 2 de
      'otros movimientos', fragmento del RESUMEN, reglas «cubre avión», la
      base del pie del bloque VUELATOUR —sin «o provisionado»— y la nota
      del libro individual); sin ella conserva las de hoy. Su amarillo
      (`_MARCA_PROVISION`) no se toca: con el API nuevo no llega ninguna
      marca y no pinta nada; con un API previo sigue pintando.
    - **Lo que NO cambia**: `common/comisiones-avion.util.ts`
      (`pagoVendedorCubiertoPorAvion`, `MARCA_PROVISION_SIN_GASTO_REAL`) es
      PURO y conserva su rama `n = 0` y su spec — solo deja de llamarse con
      `n = 0` desde el balance. El Libro Dinero (`dinero-report.service`)
      SIGUE provisionando (`comisionProvisionadaMxn`,
      `NOTA_PROVISION_PAGO_VENDEDOR`): no se tocó en esta ronda y se le dice
      al cliente. La columna COMISIONES del libro individual y el reparto
      siguen cargando la provisión del vendedor (decisión del 6-oct-2026,
      invariante 50). El panel no cambia (la vista en pantalla lee el mismo
      libro, invariante 52). Sin migración. **SUPERSEDIDO el 13-oct-2026
      (invariante 61)**: el Libro Dinero ya NO provisiona, la columna
      COMISIONES y el reparto cargan el pago REAL (no la provisión) y el
      util perdió su rama `n = 0` (`pagoVendedorCubiertoPorAvion` y
      `MARCA_PROVISION_SIN_GASTO_REAL` se eliminaron).
    - **Consecuencia aceptada**: en vuelos SIN provisión del avión
      —anteriores a la vigencia, no COMPLETADOS (CONFIRMADO con anticipo,
      COTIZADO, RESERVA), EXTERNOS— el remanente de la fila y el bloque
      «VUELATOUR (empresa)» de la hoja 'balance' SUBEN lo que valía la
      provisión hasta que se capture el gasto real (en el mundo del spec el
      #513 CONFIRMADO pasa de −36 a 1,404 y `pagos_vendedor_usd` baja 80
      USD). En los vuelos COMPLETADOS de la vigencia nada se mueve (el
      egreso ya era $0.00): la provisión solo resta en el avión, así que la
      conservación de `comisiones-general.spec` pasa a ser «Σ ganancia de
      los libros + Σ remanente de la pestaña == la regla anterior − las
      provisiones de los vuelos sin gasto real − los faltantes». La `nota`
      del bloque VUELATOUR (invariante 47) dice desde el 0.0.73 «pago al
      vendedor (solo el gasto real «Comisión del vendedor» capturado; …)»:
      el «real o provisión» de hasta el 0.0.72 era falso con esta regla
      (revisión adversaria del mismo día); pyservices, con la bandera,
      cambia también la base del pie del bloque («lo pagado (el pago al
      vendedor solo cuando se captura el gasto real …)» en vez de «lo
      pagado o provisionado»).
    - **Orden de deploy**: API antes que pyservices (con el API nuevo y un
      pyservices previo las filas ya no salen y las leyendas viejas quedan
      un rato desfasadas; al revés, las leyendas nuevas no se activan
      porque falta la bandera).
    - Specs: `aircraft-balance.service.pago-vendedor.spec` (golden sin
      gasto real = sin egreso del vendedor, `sin_provision_vendedor` y
      ningún «PROVISIÓN (» en la hoja; Σ remanentes = Σ ingresos − Σ
      egresos reales; e2–e5: COMPLETADO por llamada directa, CONFIRMADO,
      EXTERNO y gasto real byte a byte),
      `aircraft-balance.service.comisiones-general.spec` (#507/#501/#503/
      #513/#522 sin egreso ni marca, #505/#506 idénticos, `OM_0073` y
      `OM_ANTES` número por número, bloque VUELATOUR y conservación con las
      provisiones de los aviones como fuente única),
      `aircraft-balance.service.comisiones.spec` (multi-avión, no
      realizados, BillPocket, sobrecobro y vuelo sin K: conservación −
      provisión; la bandera RAÍZ de `buildPayload` en el libro individual y
      en cada `aviones[]` del general, y su ausencia en el consolidado
      FLOTA), `balance-empresa.util.spec` (la `nota` sin «real o
      provisión»), `aircraft-balance.service.bloque-empresa.spec` y
      `aircraft-balance.service.ingresos.spec` (goldens: egreso 1,850 y
      remanente 2,750 del #501); `libros-pago-vendedor.fixture-spec`
      (`GOLDEN_OM`) actualizado.

59. **T.C. POR FILA Y MONTO MXN COMO FÓRMULA EN LA HOJA «PERMISOS»
    (13-oct-2026, API 0.0.74, sin migración).** Decisión 1 del lote del
    cliente del 13-oct-2026: en la hoja «permisos» del libro INDIVIDUAL del
    balance por avión quiere ver con qué tipo de cambio se convirtió cada
    gasto a pesos (columna «T.C.») y que MONTO MXN sea una FÓRMULA visible
    (ROUND(MONTO ORIGINAL × T.C., 2)), no un número suelto. SOLO esa hoja
    cambia; las demás hojas de gastos quedan byte a byte.
    - **Contrato (ADITIVO, opcional, en `pyservices.service.ts`)**:
      `BalanceAvionGastoFilaPayload.tc_aplicado?: number | null` = el T.C.
      con el que `buildHoja` convirtió `monto_original` a `monto_mxn`
      (`pos(g.tc_gasto) ?? tcHojas`: el `tc_gasto` del gasto o, sin él, el
      T.C. de las hojas —promedio CRUDO del periodo, u oficial del cierre en
      un avión sin vuelos—), **EXACTAMENTE el número que multiplicó, sin
      re-redondear** (pyservices lo cita en la fórmula y debe reproducir el
      centavo; redondearlo a 6 podría degradar a valor un gasto grande
      convertido con el promedio); `null` en gastos en MXN y en USD sin
      ningún T.C. (`monto_mxn` null). `BalanceAvionHojaGastosPayload.
      tc_por_fila?: boolean` = `true` SOLO en `permisos`.
    - **Cómo**: `buildHoja` gana el sexto parámetro `opciones: { tcPorFila?:
      boolean }` y SOLO la llamada de `filasPermisos` lo pasa
      (`{ tcPorFila: true }`); con él cada fila lleva `tc_aplicado` y la
      hoja `tc_por_fila: true`; sin él no se agrega NINGUNA llave
      (indirectos, refacciones, otros, combustible y gastos de empresa del
      general salen byte-idénticos: ningún golden se mueve). pyservices
      (`_hoja_gastos` kwarg `con_tc`, solo en la pestaña 'permisos' y solo
      con la bandera) pinta la columna «T.C.» AL FINAL (letra calculada;
      VALOR con formato `TC`, nota en el encabezado) y MONTO MXN como
      fórmula verificada por `xlsx_formulas`: `=ROUND(F{r}*G{r},2)` en
      moneda extranjera con T.C.; `=ROUND(F{r},2)` en pesos —para que exista
      la fórmula, la fila en pesos muestra «MXN» en MONEDA ORIGINAL y su
      importe en MONTO ORIGINAL: es una COPIA del `monto_mxn` del API, no
      una conversión; el contrato `moneda_original`/`monto_original` null ⇔
      gasto en MXN NO cambia—; celda vacía sin fórmula cuando `monto_mxn`
      es null (USD sin T.C., como hoy); valor del API si llegara
      `monto_mxn` sin `tc_aplicado` (defensa). A5 sigue siendo
      `ROUND(SUM(D8:Dn),2)`; B5..E5 y la cascada `'permisos'!$C$5` no
      cambian.
    - **Lo que NO cambia**: ningún número (cada fórmula reproduce el
      `monto_mxn` del API o `xlsx_formulas.finalizar` la degrada a ese
      valor: total de la hoja, `(−) PERMISOS USD`, reparto y el bloque AFAC
      de «otros movimientos» —que lee fecha/detalle/`monto_mxn`, invariante
      53— intactos). El Balance general NO tiene hoja «permisos» (desde el
      29-ago vive solo en el individual): sus `aviones[]` llevan la bandera
      por venir de `buildPayload` y el consolidado (`hojaFlota`) hereda
      `tc_aplicado` por el spread de cada fila pero NO copia la bandera, a
      propósito (útil para la Decisión 2: T.C. por fila de los egresos AFAC
      en `tcFilas`, invariante 47 — nadie recalcula un T.C.; al final la
      Decisión 2, invariante 62, usó `totales.tc_promedio` del libro y no
      `tc_aplicado`).
      `bloqueAfacOtrosMovimientos` y `adjuntarLigasRefacciones` no se tocan
      (desde la invariante 62 el bloque es `filasAfacOtrosMovimientos`, que
      lee el MISMO `monto_mxn` ya convertido).
      La vista en pantalla (invariante 52) pinta el mismo libro: la columna
      T.C. aparece sola en 'permisos' (el panel no se toca; avisar al
      cliente). Sin migración.
    - **Skew en ambos sentidos**: API 0.0.74 + pyservices previo ⇒
      `extra="ignore"` descarta los dos campos ⇒ hoja de siempre; API ≤
      0.0.73 + pyservices nuevo ⇒ sin bandera ⇒ `con_tc=False` ⇒ hoja
      byte-idéntica (huella `_firma_hoja`). Orden de deploy recomendado:
      pyservices → API (cualquier orden funciona).
    - Specs: `aircraft-balance.service.empresa.spec` (describe «Hoja
      «permisos» — T.C. por fila»: `tc_aplicado` null/17.123456/20 con
      `monto_mxn` 2,500/2,568.52/1,600, USD sin T.C. ⇒ null + pendiente,
      sin la opción ni una llave nueva por `Object.keys`, y `buildPayload`
      con la bandera SOLO en `permisos` y `permisos_usd` = 333.43
      congelado); `afac-otros-movimientos.util.spec` sin cambios en esta
      decisión (lo reescribió la invariante 62). En
      pyservices, `tests/test_balance_formulas.py` (sección 3b) y
      `tests/test_libro_json.py`.

60. **FACTURA OBLIGATORIA POR CUENTA DE COBRO (13-oct-2026, API 0.0.74, SIN
    migración).** Decisión 4 del lote del cliente del 13-oct-2026: un cobro
    que cae en HSBC Dólares / HSBC Pesos / Scotiabank Dólares / Scotiabank
    Pesos EXIGE factura del servicio al cliente. Tres piezas y UNA regla;
    NINGÚN número se mueve: solo texto por vuelo, las 4 columnas de
    solicitud de `vuelo` que ya existen desde `20260924000003` (aplicada en
    prod) y un item NO bloqueante del pre-cierre. Nada se suma, así que nada
    puede contarse dos veces ni en dos meses.
    - **Regla ÚNICA y PURA `common/cuentas-cobro.ts`**: `cuentaExigeFactura`
      (la CUENTA manda: las 4 de banco ⇒ sí; 'Paywise' ⇒ no; vacía, null o
      fuera del catálogo ⇒ no decide) y `cobroExigeFactura` (monto no finito
      o ≤ 0 —reembolsos— ⇒ nunca; sin cuenta decide el MÉTODO:
      `METODOS_COBRO_EXIGEN_FACTURA_SIN_CUENTA` = HSBC_LINK, TRANSFERENCIA,
      CHEQUE; BILLPOCKET/EFECTIVO/PAYWISE/DOLARES/OTRO/vacío ⇒ no);
      `vueloExigeFactura(cobros)` tri-estado EXIGE | NO_EXIGE | SIN_COBROS
      sobre TODOS los cobros del vuelo (de cualquier fecha; las partes de un
      sobre entran porque `crearParte` copia cuenta y método del sobre):
      sin cobros positivos ⇒ SIN_COBROS; **por el NETO** (revisión
      13-oct-2026) ⇒ EXIGE solo si en alguna cuenta (o método sin cuenta)
      que exige QUEDÓ dinero neto, por grupo `cuentaDeCobroTexto` + `moneda`
      (`netosQueExigen`: un reembolso se clasifica por SU cuenta/método sin
      mirar el signo; tolerancia 0.005; un reembolso SIN moneda no netea
      —jamás se suman USD y MXN—); si no ⇒ NO_EXIGE. **ANTICIPO DEVUELTO
      (decisión del cliente del 14-oct-2026: «¿Un anticipo devuelto lleva
      CFDI?» ⇒ «eso no»; API 0.0.77)**: el dinero devuelto COMPLETO no lleva
      factura salga por donde salga —misma cuenta, efectivo, otra cuenta,
      sin cuenta u otra moneda— y se mide por DINERO, no por el estado del
      vuelo. Dos reglas en `netosQueExigen(cobros, cobrado?)`: (1) **por
      moneda, exacta y sin T.C.**: si la Σ de TODAS las filas de una moneda
      (cobros y reembolsos de cualquier cuenta o método) es ≤ 0.005, ningún
      grupo de esa moneda exige (los mismos pesos devueltos con otro T.C.
      cuentan como devueltos); (2) **devolución CRUZADA**
      (`devolucionCruzadaCompleta`): SOLO si alguna moneda quedó con Σ <
      −0.005 (el reembolso salió en otra moneda), hay cobro y reembolso, toda
      fila es USD o MXN, `cobrado` = `cobrosEnUsd(cobros, vuelo.tc_usd_mxn)`
      convirtió todo (`sin_tc_count` 0) y quedó ≤ `TOLERANCIA_COBRO_USD`
      (1). Sin una moneda negativa la (2) NO se evalúa: una devolución
      PARCIAL en la misma moneda a ≤ 1 USD (p. ej. 1,500 MXN de penalización
      retenidos en HSBC con el reembolso tecleado al T.C. mínimo que pasa el
      candado de `createReembolso`) sigue EXIGIENDO (revisión del
      14-oct-2026). Devuelto en PARTE ⇒ lo retenido EXIGE si quedó en un
      grupo que exige; mezcla de cuentas en la MISMA moneda ⇒ conservador
      (EXIGE); ENTRE monedas la moneda identifica el dinero (pesos devueltos
      completos y dólares retenidos en un método que no exige ⇒ NO exige:
      excepción consciente, pregunta abierta al cliente). Sin `cobrado` solo
      aplica la (1). **Límite conocido (revisión del 14-oct-2026, sin
      corregir en el 0.0.77)**: la (2) confía en el T.C. TECLEADO del
      reembolso (`createReembolso` solo exige reembolso ≤ cobrado neto +
      0.01 y el diálogo no lo prellena): una devolución PARCIAL en otra
      moneda tecleada a un T.C. bajo (16,000 MXN a 16.00 de un cobro de
      1,000 USD con el oficial en 17.50) pasa por completa y deja $1,500 MXN
      retenidos sin CFDI. Un 400 duro contra el oficial bloquearía
      devoluciones legítimas al T.C. del banco y calcular la (2) con el
      oficial sería un cálculo paralelo a `cobrosEnUsd`: la salida es un 409
      con «aceptar el T.C.» que pide el panel nuevo (sale con él). Prod al
      14-oct-2026: 0 devoluciones cruzadas. `dineroDevueltoCompleto` es la
      definición ÚNICA de «se devolvió completo» (la usa el pre-cierre `cobros_en_cancelados` para
      su marca `diferencia_cambiaria`; `retieneCobros` sigue siendo la
      medida en USD del REPARTO y cuenta la diferencia cambiaria: decisión
      de dinero aparte). El lector suma `moneda` y `tc_usd_mxn` al select de
      `cobro_vuelo` y `tc_usd_mxn` al de `vuelo`. Desde el 0.0.77 el PANEL ya
      no decide: pinta `factura_servicio.exigencia` / `origenes_exigen` y su
      espejo queda como respaldo de un API ≤ 0.0.76. Producción al
      14-oct-2026: 1 reembolso en toda la base (#215, BillPocket, NO_EXIGE
      antes y después); 0 de 234 vuelos cambian. `cuentaDeCobroTexto`
      ('HSBC Pesos' / 'Transferencia sin cuenta destino'),
      `origenCobroTexto` ('en HSBC Pesos' / 'por Transferencia'),
      `cuentasQueExigenFactura` (distintas, en orden, solo las de neto > 0)
      y —0.0.77— `origenesQueExigenFactura` (los `origenCobroTexto` de esos
      grupos: `factura_servicio.origenes_exigen`); las dos reciben `cobrado`
      y aplican las reglas 1 y 2. `cobroExigeFactura` (por cobro, los
      ganchos) no cambia: un reembolso nunca exige por sí solo.
      **Es por cuenta/método, NO por rol**: el PILOTO también la dispara
      desde la app con HSBC_LINK (está en `METODOS_COBRO_PILOTO`). Etiquetas
      de método SIEMPRE por `etiquetaMetodoCobro` (invariante 7).
      `CUENTAS_COBRO` y los `@IsIn` de los DTO no cambian.
    - **Columna «FACTURA VUELATOUR» — paso 5 de la cascada única**
      (`etiquetaFacturaVuelo`, dos insumos OPCIONALES `exigencia` y
      `solicitada`; los pasos 1-4 se extrajeron a
      `etiquetaFacturaRegistrada`): sin factura registrada ⇒
      `ETIQUETA_FACTURA_PENDIENTE` = «Pendiente de factura» si EXIGE **o si
      su solicitud CUENTA** (`solicitada`: MANUAL viva —también en un
      CANCELADO que retuvo dinero— o AUTOMÁTICA mientras el vuelo exige; una
      automática que YA NO APLICA ya no la pone «Pendiente», 14-oct-2026)
      (refinamiento explícito sobre la decisión
      literal: la columna nunca contradice la bandeja «Por facturar» ni
      «paga contra factura»; el pre-cierre NO usa esta rama);
      `ETIQUETA_FACTURA_NO_LLEVA` = «No lleva factura» si NO_EXIGE; `null` =
      SIN COBROS (desde ahora la celda vacía significa «sin cobros», no
      «sin factura»). Un CANCELADO con cobro retenido en HSBC dice
      «Pendiente de factura». Sin los dos campos el resultado es
      EXACTAMENTE el de antes. El lector en lote se partió en
      `facturasDeVuelos` (detalle `{registrada, exigencia, solicitada,
      estado, cuentas_exigen, etiqueta}` + `origenes_exigen`,
      `solicitud_automatica` y `solicitud_ya_no_aplica` (0.0.77; `cobros` y
      `tc_vuelo` solo con `{conCobros: true}`) de TODOS los ids pedidos; **4
      consultas por cada 200 vuelos**: la de `cobro_vuelo` va PAGINADA con
      `.order('id', {ascending: true}).range()` de 1000 en 1000 y tope de 20
      páginas —nunca `.limit(10000)`: PostgREST corta en max-rows sin avisar
      y un vuelo cuyos cobros cayeran después de la fila 1000 saldría «sin
      cobros» en falso—; el select de `vuelo` suma SIEMPRE `estado` y
      `tc_usd_mxn` y, solo con la sonda `20260924000003`,
      `factura_solicitada_at` y `factura_solicitud_nota`; cualquier
      error de las 4 LANZA) y `etiquetasFacturaDeVuelos` quedó como
      envoltorio con la MISMA firma y contrato (solo vuelos con etiqueta),
      así que el balance individual (col AU), el general («reporte horas
      FLOTA»), «otros movimientos» (col J) y el Libro Dinero (hoja 1 y
      «otros ingresos») pintan el texto nuevo sin cambiar código — y, por
      la invariante 34, un fallo al leer `cobro_vuelo` TUMBA el libro
      («fallo al leer facturas»); en el pre-cierre el item degrada a
      `lectura_fallida`. Hacia pyservices viaja SOLO la bandera raíz
      ADITIVA `factura_vuelatour_segun_cobros: true` (libro individual,
      cada `aviones[]` **y el consolidado FLOTA**, a diferencia de
      `sin_provision_vendedor`, porque los dos usan `_hoja_maestra`; NO en
      `otros_movimientos` ni en el Libro Dinero) que cambia ÚNICAMENTE la
      nota al pie de la hoja maestra; sin bandera, libro byte-idéntico
      (huellas `_firma_hoja`). Desde el 0.0.77 la sigue
      `factura_vuelatour_devolucion: true` (mismos libros, justo después):
      la nota al pie dice además que un anticipo devuelto no lleva factura
      (`_NOTA_FACTURA_VUELATOUR_DEVOLUCION` de pyservices); sin ella, las
      dos notas de siempre.
    - **Solicitud AUTOMÁTICA** `FacturaSolicitudService.solicitarPorCobro`
      = la MISMA vía que «Necesito factura»: mismas 4 columnas, mismo CAS
      `.in('id', candidatos).is('factura_solicitada_at', null).select('id,
      folio')` (se avisa SOLO por los que ENTRARON; una carrera deja fuera a
      alguno sin re-aviso), misma `avisarSolicitud` →
      `ConfiguracionService.destinatariosFacturacion(actorId)` (excluye al
      actor como hoy y no baja de nivel), mismo link `#por-facturar`. JAMÁS
      lanza (todo en try/catch ⇒ `{solicitados: [], notificados: [],
      motivo: 'FALLO'}` + warn «Solicitud automática de factura falló (el
      cobro <id> quedó registrado): …»); idempotente: solo vuelos con
      `registrada == null` (un CFDI vivo, una emitida VIGENTE, un folio o
      un estatus ≠ SIN_FACTURA lo omiten), sin solicitud viva (no se toca
      su nota ni se re-avisa) y estado ≠ CANCELADO; sin la migración ⇒
      no-op con log, NUNCA 503 desde un cobro. Persiste
      `factura_solicitada_por` = quien registró/corrigió el cobro (ese
      usuario recibirá «Ya está la factura A-123», comportamiento de la vía
      existente), `factura_solicitud_nota` = `notaSolicitudAutomatica` =
      «Solicitada automáticamente: cobro en HSBC Pesos» / «… cobro por
      Transferencia» (≤ 500), `factura_paga_contra_factura = false`,
      `updated_by`. Aviso `factura_solicitada` con
      `textoAvisoSolicitud({automatica: {origen}})`: título «Factura
      pendiente: vuelo #341» (grupo: «Factura pendiente: grupo G-12» / «…
      vuelos #341, #342 y #343»), cuerpo «Cobro en HSBC Pesos registrado
      por Itzi: el vuelo #341 necesita factura · Maqar · 27 sep · Total
      $8,050.40 USD.» (tramos vacíos se omiten; sin «Nota:» ni «paga contra
      factura»; nombre vacío ⇒ «Alguien de la oficina», nunca el uuid) y
      `data` con las llaves ADITIVAS `origen: 'COBRO'`, `cobro_id`,
      `cobro_grupo_id` (la app ignora `data` que no conoce). «Por facturar»
      sigue DERIVADO y la bandeja la muestra como cualquier solicitud; se
      retira igual (`DELETE :id/solicitud-factura`). Bitácora en el log de
      cada decisión (pedida / nada que pedir con el motivo por vuelo /
      omitida sin migración / falló). Desde el 0.0.77 solo pide si el vuelo
      EXIGE (con las reglas del anticipo devuelto).
    - **Solicitud AUTOMÁTICA que YA NO APLICA (14-oct-2026, API 0.0.77)**:
      una solicitud viva con nota `PREFIJO_NOTA_SOLICITUD_AUTOMATICA`
      («Solicitada automáticamente: cobro …») cuyo vuelo ya no EXIGE (dinero
      devuelto, cuenta corregida o cobro eliminado) NO se retira sola
      (retirar es destructivo y pide confirmación): `estadoSolicitud(v,
      vigentes, exigencia)` —3.er parámetro OBLIGATORIO; `null` = no leída ⇒
      como antes— da 'YA_NO_APLICA' (después de MARCADO_SIN_REGISTRO, antes
      de POR_FACTURAR): sale de `por_facturar` (badge, bandeja, selector de
      «Registrar factura»), viaja en el ADITIVO `ya_no_aplican` (lista y
      conteo), el bloque `factura_servicio` gana `exigencia`,
      `origenes_exigen` y `solicitud_ya_no_aplica` (últimas llaves) y la
      columna dice «No lleva factura». Una MANUAL, nunca (si la oficina edita
      la nota de una automática, pasa a ser manual); `solicitudYaNoAplica`
      NO mira el estado del vuelo. Exigencia solo de las automáticas vivas
      (`exigenciasDeAutomaticas`, en lote); si la lectura falla ⇒ warn y
      POR_FACTURAR como antes. Avisos por TRANSICIÓN
      (`FacturaSolicitudService.avisarCambioSolicitudAutomatica`, contrafactual
      `cobrosAntesDelCambio` sobre los cobros de DESPUÉS —sin leer antes de
      escribir—; compuerta de UNA consulta a `vuelo`, 42703 ⇒ `NO_DISPONIBLE`;
      jamás lanza ni revierte dinero) a `destinatariosFacturacion(actor)`:
      tipo `factura_solicitud_ya_no_aplica` (EXIGE ⇒ no exige; título «Ya no
      aplica: factura del vuelo #341», link `/admin/flights/<vuelo>#cobros`
      —el DETALLE del vuelo, donde cualquier panel ofrece «Retirar»;
      revisión del 14-oct-2026: el ancla `#ya-no-aplican` de la bandeja solo
      existe en el panel nuevo y, con el API 0.0.77 y el panel de antes, el
      aviso aterrizaba en una bandeja sin el vuelo—) y
      `factura_solicitud_vuelve_a_aplicar` (no exige ⇒ EXIGE con la
      automática todavía viva; «Vuelve a aplicar: factura del vuelo #341»,
      `#por-facturar`); `data` = `{vuelo_id, folio, origen: 'YA_NO_APLICA' |
      'VUELVE_A_APLICAR', motivo: COBRO_NUEVO | REEMBOLSO | COBRO_CORREGIDO |
      COBRO_ELIMINADO, cobro_id}`; cuerpos en `textoAvisoCambioSolicitud`
      (p. ej. «Se registró la devolución del dinero del vuelo #341 · Maqar ·
      27 sep: un anticipo devuelto no lleva factura. Su solicitud automática
      salió de «Por facturar»; retírala desde el detalle del vuelo (botón
      «Retirar»).»). Desde `createCobro`
      (sin sobre, cualquier método), «Es el pago de un vuelo»,
      `createReembolso` (sin sobre), `deleteCobro` y `updateCobro` (dinero,
      cuenta o método); sin transición no avisa (nunca repite). La
      solicitud que el MISMO cobro acaba de crear no avisa (el aviso va
      encadenado DESPUÉS de `solicitarPorCobro`); la compensación interna de
      «Es el pago de un vuelo» (`deleteCobro(…, {omitirAvisoFactura:
      true})`) tampoco; un replay idempotente tampoco. Sobres de grupo: no
      avisan (0 en prod). Specs: `factura-solicitud.util.spec` (estados,
      contrafactual, transiciones, textos y links exactos),
      `factura-solicitud.service.spec` (compuerta, transición, sin
      transición, motivos, `data`), `flights.service.factura-por-cobro.spec`
      y `flights.service.anticipo.spec` (los cinco caminos, la solicitud
      recién creada no avisa), `ingresos.service.spec` (compensación sin
      aviso) y `facturas-emitidas.service.spec` (`ya_no_aplican` en lista y
      conteo, fuera del badge).
    - **Ganchos** (puerta pública `FlightsService.solicitarFacturaPorCobros`:
      sin `facturaSolicitud` inyectado —specs posicionales— ⇒ null; cobro
      que no exige ⇒ null; try/catch con warn; jamás 5xx, jamás revierte
      dinero): `createCobro` sin sobre ⇒ **FIRE-AND-FORGET** (`void
      …catch(() => undefined)` después de `notificarCobroRegistrado`: el
      POST del outbox del piloto con HSBC_LINK no espera 4 lecturas + update
      + pushes —un timeout daría un «fallido» falso, invariante 13—; el
      replay idempotente y el 23505 retornan ANTES y no re-disparan; las
      PARTES de sobre no disparan); `updateCobro` (solo oficina) cuando el
      PATCH trae `cuenta_destino` o `metodo_cobro` ⇒ `await` best-effort
      (la oficina no tiene outbox); sobre de grupo UNA vez en
      `registrarCobro` (tras `escribirPartes` OK, ANTES del aviso
      `cobro_registrado`) y en `repartirCobro` (tras re-escribir las
      partes), con los vuelos de las partes con monto > 0
      (`vuelosConParteCobrada`, puro en `particion-cobro.util.ts`) y
      `cobroGrupoId`; `GroupsService` NO inyecta nada nuevo (usa
      `this.flights`). Hereda sin tocar `ingresos.service.ts` el anticipo
      aplicado (método del anticipo, sin cuenta) — ruido esperado en
      facturación (crea solicitud y avisa; se deduplica por vuelo con el
      CAS), dicho al cliente. **«Es el pago de un vuelo» desde el banco NO
      hereda el gancho** (revisión 13-oct-2026): `createCobro` gana el 7.º
      parámetro INTERNO `CobroAltaInternaOpts.omitirSolicitudFactura` y
      `IngresosService.cobroDeVueloDesdeAbono` dispara
      `solicitarFacturaPorCobros` (fire-and-forget, TRANSFERENCIA ⇒ exige;
      PAYWISE ⇒ no) SOLO después de que `linkCobro` responde bien: si la
      liga falla (409 MOVIMIENTO_YA_LIGADO o un error de PostgREST) su
      compensación BORRA el cobro, y antes la solicitud («Por facturar»,
      «Pendiente de factura») y el aviso a facturación ya habían salido por
      un cobro que no existe. NO disparan la SOLICITUD: `createReembolso`,
      `deleteCobro`, `eliminarCobro`, ni corregir HACIA BillPocket/Paywise.
      Desde el 0.0.77 `createCobro` (sin sobre), «Es el pago de un vuelo»,
      `createReembolso` (sin sobre), `deleteCobro` y `updateCobro` (dinero,
      cuenta o método) llaman `avisarCambioSolicitudAutomatica`, que solo
      AVISA la transición de una automática viva («ya no aplica» / «vuelve a
      aplicar»); jamás la retira (la oficina, a mano y con confirmación).
      Las respuestas HTTP de los endpoints de cobro no cambian ni un byte.
    - **Pre-cierre**: item ADITIVO NO bloqueante `vuelos_cobrados_sin_factura`
      («Vuelos cobrados en cuentas que exigen factura sin factura
      registrada»; clave, título y textos en
      `profit-sharing/vuelos-sin-factura.util.ts`, PURO) sobre TODOS los
      vuelos del periodo que ya lee el pre-cierre (pendientes + completados
      + cancelados; externos y sin avión entran con `matricula: null`),
      estrictamente `exigencia === 'EXIGE' && registrada == null` (la
      solicitud viva NO lo mete ni lo saca: `solicitada` solo informa),
      `vuelos[] {id, folio, fecha_vuelo, matricula, solicitada, cuentas}`
      (+ `estado: 'CANCELADO'` ADITIVO SOLO en un cancelado —revisión
      13-oct-2026: para él no existe «pídela desde el vuelo» (el panel
      oculta «Necesito factura», el API responde 409 VUELO_CANCELADO y la
      solicitud automática lo descarta); el chip del panel ya lo pinta
      «#430 (CANCELADO)» y el detalle dice «si el vuelo está cancelado,
      regístrala directo en Facturas emitidas»—)
      por `fecha_vuelo` (empate por folio, sin fecha al final),
      `lectura_fallida` (count 0 + «No se pudo verificar…»), justo después
      de `externos_sin_honorario`; `bloqueantes` y `listo` no cambian. Los
      selects de `pendRes` y `canceladosRes` suman `aeronave_id`.
      Consecuencia documentada: un cobro en HSBC registrado DESPUÉS de
      cerrar el mes ya no sale en el pre-cierre de ese mes (lo cubre la
      solicitud automática); los cobros HISTÓRICOS no reciben solicitud
      retroactiva (no hay backfill): el pre-cierre los lista hasta que se
      registre la factura. Bordes aceptados: `cuenta_destino` legado fuera
      del catálogo o método OTRO sin cuenta ⇒ no exige (la oficina captura
      la cuenta); en `createCobro` el snapshot que el panel refresca
      milisegundos después puede todavía no traer la solicitud. Desde el
      0.0.77 un anticipo devuelto COMPLETO, por cualquier vía, sale del
      renglón (regla de `netosQueExigen`); el texto del detalle lo dice y
      pide registrar el dinero devuelto como REEMBOLSO. El informativo
      `cobros_en_cancelados` lista solo los cancelados que el reparto cuenta
      (`retieneCobros`: ya no salen filas de $0.00) y marca
      `diferencia_cambiaria: true` (ADITIVO, solo cuando aplica) cuando el
      dinero ya se devolvió completo (`dineroDevueltoCompleto`): lo que queda
      es la diferencia entre el T.C. del cobro y el del reembolso, que el
      reparto cuenta como venta; su detalle lo explica y pide registrar el
      reembolso (no eliminar el cobro).
    - **Skew / deploy**: sin migración ni cambios en panel (la vista en
      pantalla lee el mismo libro, invariante 52; la bandeja «Por facturar»
      ya pinta nota y solicitante; el pre-cierre ignora `vuelos[]` extra) ni
      Flutter (respuestas de cobro idénticas; `data` desconocido se ignora).
      pyservices nuevo + API ≤ 0.0.73 ⇒ libro byte-idéntico (sin bandera;
      `extra="ignore"`); API 0.0.74 + pyservices viejo ⇒ los textos nuevos
      se pintan y SOLO la nota al pie vieja («vacía = sin factura») queda
      desfasada hasta desplegar pyservices (cero 422). Orden recomendado:
      pyservices → API (al revés de la invariante 58, cuya lógica es la
      opuesta).
    - Specs: `common/cuentas-cobro.spec` (tabla de verdad: devuelto
      completo por la misma cuenta, en efectivo, por otra cuenta o sin
      cuenta ⇒ NO_EXIGE; mismos pesos con otro T.C. ⇒ NO_EXIGE; USD devuelto
      en MXN con `cobrado` ⇒ NO_EXIGE y sin `cobrado` ⇒ EXIGE; parcial ⇒
      EXIGE, también a ≤ 1 USD en la misma moneda (R1, R2, R3, R5, R6);
      ambiguo en una moneda ⇒ EXIGE; pesos devueltos y dólares retenidos en
      efectivo ⇒ NO_EXIGE (excepción consciente); otra moneda sin T.C. y sin
      moneda ⇒ EXIGE; bordes 1.00 / 1.01; `devolucionCruzadaCompleta`,
      `dineroDevueltoCompleto`, `origenesQueExigenFactura`),
      `factura-cliente.util.spec` (paso 5; `etiquetaFacturaRegistrada` ≡
      cascada vieja), `factura-cliente-etiquetas.spec` (CANCELADO con
      anticipo devuelto completo / en parte, devuelto en efectivo o por otra
      cuenta ⇒ fuera, automática que ya no aplica ⇒ «No lleva factura» y
      select con `moneda` y `tc_usd_mxn`; 3
      consultas por lote + puente con la sonda, select con
      `estado`/`factura_solicitada_at`,
      paginación 1 001 cobros ⇒ 2 páginas sin perder el vuelo 1 001,
      solicitud viva solo con la sonda, reembolso no cuenta, `facturasDeVuelos`
      con TODOS los ids, error de `cobro_vuelo` lanza),
      `factura-solicitud.util.spec` (textos byte a byte sin `automatica`;
      título/cuerpo/nota exactos), `factura-solicitud.service.spec`
      (`solicitarPorCobro`: nota/actor/CAS/aviso/`data`, idempotencia,
      registrada en sus 4 formas, cancelado, NO_EXIGE sin tocar la BD,
      NO_DISPONIBLE sin lanzar, FALLO con warn, sobre G-12 con UN update y
      UN aviso; los 6 de `solicitar` intactos),
      `flights.service.factura-por-cobro.spec` (`createCobro` con
      `setImmediate` para vaciar la cola, TRANSFERENCIA sin cuenta, PILOTO
      con HSBC_LINK, BillPocket/Paywise/efectivo no, parte de sobre no,
      replay no, mock que rechaza ⇒ cobro igual y solo warn, reembolso
      nunca; `updateCobro` con cuenta ⇒ `await`, solo referencia/notas no,
      hacia BillPocket no; 9 argumentos ⇒ null; la opción INTERNA
      `omitirSolicitudFactura` no la dispara),
      `ingresos.service.spec` («Es el pago de un vuelo»: la solicitud sale
      DESPUÉS de `linkCobro` con el cobro creado; si la liga falla, se borra
      el cobro y no sale ninguna),
      `groups/particion-cobro.util.spec` (`vuelosConParteCobrada`),
      `groups/groups.service.cobro-factura.spec` (orden sobre → partes →
      factura → aviso, BillPocket, fallo, sin partes con dinero,
      `repartirCobro`), `profit-sharing/vuelos-sin-factura.util.spec` y
      `profit-sharing.service.pre-cierre-vuelos-sin-factura.spec` (BD en
      memoria con max-rows 1000: 7 casos + orden, no bloquea, cada regla,
      anti-cap con páginas `[0,999]`/`[1000,1999]`, lectura fallida,
      `estado: 'CANCELADO'` solo en cancelados, CANCELADO devuelto completo
      fuera y en parte dentro, devuelto en efectivo o por otra cuenta ⇒
      fuera; `cobros_en_cancelados` sin filas de $0.00 y con
      `diferencia_cambiaria`; `permisos_sin_avion`),
      `aircraft-balance.service.factura.spec` (paso 5 en el individual, en
      los dos libros del multi-avión, en el consolidado y en col J con UNA
      lectura por vuelo; bandera en individual, `aviones[]` y consolidado y
      no en la pestaña; fallo de `cobro_vuelo` tumba el libro) y
      `aircraft-balance.service.comisiones.spec` (bandera raíz). Goldens
      actualizados SOLO en el texto de `factura`/`factura_vuelatour` con
      `ETIQUETA_FACTURA_NO_LLEVA` donde el vuelo tiene cobros sin cuenta ni
      método (`libros-pago-vendedor.fixture-spec`,
      `aircraft-balance.service.ingresos.spec`,
      `dinero-report.service.ingresos/pago-vendedor.spec`) y
      `dinero-report.service.empresa.spec` gana «con cobros ⇒ No lleva
      factura / HSBC ⇒ Pendiente». En pyservices,
      `tests/test_balance_factura_vuelatour.py`.

61. **COMISIÓN DEL VENDEDOR SOLO COMO GASTO REAL, EN DOS CATEGORÍAS
    (13-oct-2026, API 0.0.74, migraciones `20261013000003` y
    `20261013000004`).** Decisión 3 del lote del cliente del 13-oct-2026
    («comisión del vendedor SOLO como gasto real en todos lados»: la
    PROVISIÓN —`pagoVendedorUsd` = comisión cotizada + IVA— desaparece de
    todos los libros) AJUSTADA el mismo día a las 17:10, textual: «aqui en
    las categorias necesitamos una opcion que sea Comision del vendedor pero
    que esa opcion si se cargue al balance del avión, y dejamos el otro que
    se va a balance de vuelatour para tener esas 2 opciones». La versión de
    dd431583 hacía que el avión absorbiera la `COMISION_VENDEDOR` por
    vigencia: ya no existe (la D3 se corrigió EN SU LUGAR, sin bandera nueva;
    D3 y ajuste salen JUNTOS en el 0.0.74 y nunca se empuja uno sin el otro).
    - **Las dos categorías** (tabla canónica IDÉNTICA en API
      `categoria-gasto.util`, panel `categorias-gasto.ts` y app
      `categoria_gasto.dart`; en el selector del panel, justo después de
      PILOTO_EXTERNO y en este orden):
      | código | etiqueta | destino |
      |---|---|---|
      | `COMISION_VENDEDOR` | Comisión del vendedor (VuelaTour) | Pago al vendedor (otros movimientos VuelaTour; no es costo del avión) |
      | `COMISION_VENDEDOR_AVION` | Comisión del vendedor (avión) | Pago al vendedor (columna COMISIONES del balance del avión; sí es costo del avión) |
      `COMISION_VENDEDOR` conserva su código (solo cambia la etiqueta). Ni
      una ni otra empieza con «Gastos directos del vuelo» ni es destino de
      EMPRESA ⇒ `CATEGORIAS_GASTO_EMPRESA` NO cambia.
    - **Reglas comunes** (las dos): vuelo obligatorio a TODOS los roles (400
      `GASTO_REQUIERE_VUELO` en alta y en el estado fusionado del PATCH, con
      la etiqueta de SU categoría; `escala_id` cuenta como vuelo; respaldo
      CHECK `gasto_comision_vendedor_exige_vuelo` (28-sep) y
      `gasto_comision_vendedor_avion_exige_vuelo` (000004), cuyo 23514 se
      traduce al MISMO 400 con la categoría que nombra el CHECK
      —`categoriaDeCheckExigeVuelo`, nunca la del dto: un PATCH que solo
      quita el vuelo trae `categoria` undefined—); no repartibles
      (`CATEGORIAS_REPARTIBLES` y `tg_gasto_reparto_valida` sin cambio); sin
      TUA ni extensión embebidos (`CATS_SIN_TUA_EMBEBIDO`); no ligables a
      compras (`CATEGORIAS_NO_LIGABLES`); la IA no las sugiere ni las pisa
      (`valid_cats` de pyservices no las tiene). **Reclasificar entre las
      dos** en «Verificar / editar» está permitido aunque el gasto esté
      conciliado (`GASTO_CONCILIADO` cubre solo monto, moneda y medio).
      22P02 (enum sin migración) ⇒ 400 «Comisión del vendedor (avión)»
      necesita la migración 20261013000003 en la base de datos; avisa a
      sistemas (el gasto no se guardó). —la etiqueta y la migración de SU
      categoría, `MIGRACION_DE_CATEGORIA`— solo si el mensaje trae la
      categoría ENVIADA entre comillas dobles (`mensajeCategoriaSinMigracion`;
      con un `includes` sin comillas 'COMISION_VENDEDOR' casaría con el
      mensaje de la nueva).
    - **Quién paga.** (1) La «(VuelaTour)» la paga SIEMPRE VuelaTour: egresa
      en «otros movimientos» del Balance general y en «Otros ingresos» del
      Libro Dinero con las ramas de siempre, byte a byte; nunca es costo del
      avión, tampoco dentro de `comisiones_al_avion_desde`. (2) La «(avión)»
      la absorbe el avión del vuelo en su columna COMISIONES (ganancia,
      cascada, `balance.comisiones_usd`, socios) y en el reparto
      (`ingresos.comisiones_venta_usd` ⇒ utilidades por mes, cuenta
      corriente, `dashboards.overview`), SIEMPRE en el MES DEL VUELO; lo
      cobrado al cliente sigue siendo ingreso de VuelaTour, UNA vez, y en
      «otros movimientos» el pago sale con egreso $0.00 «a cargo del avión
      …». Un vuelo puede traer pagos de las DOS: cada uno va a su lado y
      ninguno se cuenta dos veces. (3) Sin pago capturado nadie resta nada
      (sin provisión en ningún libro); la parte BANCARIA del avión solo en la
      vigencia (invariante 50); la provisión AFAC no se toca.
    - **Universo de la «(avión)»** (`pagoVendedorAvionEnUniverso`, PURO):
      vuelo COMPLETADO, o CANCELADO con cobros retenidos —`retieneCobros(
      cobrosEnUsd(cobros, K))` = USD > 0 o MXN sin T.C. > 0, el MISMO
      criterio con que el reparto salta al cancelado sin cobros (que ahora
      usa esa función)—, y que la fila sea de un avión con parte de la
      venta (el lector no llama al util para EXTERNOS). NO exige comisión
      cotizada ni partición consistente (la elección explícita manda): sin
      línea que aparear la nota de COMISIONES lo dice con
      `TEXTO_SIN_LINEA_COMISION`. (a) **Antes de la vigencia SÍ la carga el
      avión**: la vigencia ya solo gobierna la parte bancaria; la columna y
      sus llaves nacen en una fila anterior SOLO si absorbe un pago
      «(avión)» (con `comision_banco_avion_mxn` 0, `aplica: false`,
      `lleva_comisiones: true`); sin él, la fila byte a byte. (c)
      **Multi-avión**: se reparte por participación (`parteAvion` /
      `repartirUsd`, como la venta y la bancaria) — EXCEPCIÓN documentada a
      la invariante 10 (es costo de la venta, no de un tramo); el avión
      sellado en el gasto es solo referencia; Σ de los aviones == el pago al
      centavo. EXTERNO con avión de referencia: lo carga ese avión (factor
      1 en balance y reparto). **Fuera del universo** (CONFIRMADO, COTIZADO,
      RESERVA, SOLICITUD, EN_VUELO, CANCELADO sin cobros, vuelo sin avión de
      la flota) nadie lo absorbe: VuelaTour lo egresa con el motivo en el
      concepto y el libro que reporta el vuelo lo lista en pendientes. Nunca
      se pierde: «otros movimientos» decide con las FILAS de los libros
      (`comision_vendedor_real_pagos > 0`) y jamás recalcula el universo.
    - **Fuente única** `common/comisiones-avion.util#comisionesDelVuelo` +
      los helpers puros de `comisiones-avion.util` y `pago-vendedor.util`
      (prohibido reimplementarlos). `ComisionesDelVuelo`: `aplica` (vigencia,
      solo bancaria), `lleva_comisiones` (= aplica ∨ vendedor_absorbido),
      `vendedor_avion_universo`, `vendedor_avion_pagos_n`,
      `vendedor_vuelatour_pagos_n`, `vendedor_absorbido` (= universo ∧ ≥ 1
      «(avión)»: la SEÑAL entre libros), `vendedor_pendiente_captura`
      (vigencia ∧ COMPLETADO ∧ partición consistente ∧ comisión cotizada ∧
      CERO pagos de las dos), `vendedor_mxn/_usd` (parte de ESTE avión de
      las «(avión)»), `vendedor_sin_tc`, `vendedor_usd_sin_tc_n/_mxn` (solo
      «(avión)»: el filtro es `ladoPagoVendedor === 'AVION'`, así una
      «(VuelaTour)» MXN sin K nunca cae en `gastos_sin_tc` del avión). Se
      QUITARON `vendedor_absorbe` y `vendedor_pagos_n` de la D3.
      **Conversión** (la de la D3, sin cambio): gasto MXN ⇒ MXN tal cual,
      USD = ÷ (tc_gasto > 0 ?? K); gasto USD ⇒ USD tal cual, MXN = ×
      (tc_gasto > 0 ?? K); suma CRUDA y round2 UNA vez por moneda
      (`pagosVendedorDeVuelo` con dos conversores: en la llamada USD
      `pagadoMxn` son DÓLARES) y después `parteAvion`.
    - **Regla de lectores (prefijo PROHIBIDO)**: 'COMISION_VENDEDOR' es
      prefijo de 'COMISION_VENDEDOR_AVION' ⇒ toda comparación es EXACTA
      (`Set.has` / `===`), nunca `startsWith`/`includes`/LIKE/regex sin
      ancla. Eje GENÉRICO («¿es pago al vendedor?», «¿fuera del costo
      genérico del avión?»): la UNIÓN —`categoriaEsPagoVendedor`,
      `CATEGORIAS_GASTO_PAGO_VENDEDOR`, `CATEGORIAS_GASTO_FUERA_DEL_AVION` =
      empresa ∪ las dos, `CATEGORIAS_GASTO_VUELO_OBLIGATORIO` = las dos—, sin
      cambio de código en cada lector (fila del vuelo, Z, aviso del externo,
      fechas fuera, avión que no vuela, Gastos Indirectos, ficha, grupo,
      reporte por vuelo, gastos-resumen del piloto, acreditación del
      Dinero). QUIÉN paga: SOLO `ladoPagoVendedor` ('VUELATOUR' | 'AVION' |
      null). `pagosVendedorDeVuelo(gastos, aMxn, lado)` y
      `contarPagosVendedor(gastos, lado)` EXIGEN el lado ('VUELATOUR' |
      'AVION' | 'AMBOS', sin default: tsc delata a quien no lo decida). La
      «(avión)» entra a un libro SOLO por `comisionesDelVuelo`.
      `CATEGORIAS_GASTO_SIN_AVION` NO lleva el literal nuevo (arma el
      `not.in` de PostgREST): ningún query de PostgREST del API nombra la
      categoría nueva.
    - **«Otros movimientos»: gramática ÚNICA del egreso del vendedor**
      (`egresoPagoVendedorDeVuelo`, 8 casos; etiqueta «comisión vendedor
      (Pablo Canales)»): D1 con línea, solo «(VuelaTour)» (byte a byte):
      «pago comisión vendedor (Pablo Canales) · gasto real · parcial: faltan
      $500.00 MXN», egreso Σ VuelaTour. D2 con línea, solo «(avión)» que
      carga un avión (byte a byte D3): «… · gasto real · a cargo del avión
      XB-PEV ($3,000.00 en su columna COMISIONES)», egreso $0.00. D3 con
      línea, MIXTO: «… · gasto real (2 pagos) · VuelaTour $2,000.00 · a cargo
      del avión XB-PEV ($1,000.00 en su columna COMISIONES)», egreso
      $2,000.00 (faltan/excede contra lo pagado en TOTAL; «(USD sin TC)»
      solo del tramo VuelaTour: «· VuelaTour (USD sin TC)» o «· VuelaTour
      $2,000.00 (parcial: USD sin TC)»). D4 con línea y una «(avión)» que
      ningún avión carga: «… · gasto real · incluye «Comisión del vendedor
      (avión)» que ningún avión carga (el vuelo aún no se completa: al
      completarse lo cargará el avión): la paga VuelaTour», egreso Σ de las
      dos. D5 sin línea, solo «(VuelaTour)» (byte a byte): «pago comisión
      vendedor · sin comisión cobrada en la cotización». D6 sin línea, solo
      «(avión)» que carga un avión: fila NUEVA, INFORMATIVA (sustituye la
      guarda con `logger.warn` de la D3): «pago comisión vendedor · sin
      comisión cobrada en la cotización · a cargo del avión N621TX
      ($1,305.00 en su columna COMISIONES)», egreso $0.00, remanente 0 (nunca
      −0). D7 sin línea, MIXTO: «… · vuelo cancelado: sin comisión cobrada (2
      pagos) · VuelaTour $500.00 · a cargo del avión …», egreso $500.00. D8
      sin línea y una «(avión)» que nadie carga: «… · vuelo cancelado: sin
      comisión cobrada · incluye «Comisión del vendedor (avión)» que ningún
      avión carga (vuelo cancelado sin cobros retenidos): la paga VuelaTour».
      Motivos (en este orden): «vuelo sin avión de la flota» · «vuelo
      cancelado sin cobros retenidos» · «el vuelo aún no se completa: al
      completarse lo cargará el avión» · «ningún libro de avión la cargó»
      (defensivo). Variantes del sufijo de la D3 sin cambio (varios aviones;
      «(resta en su columna COMISIONES)» si las cifras no cuadran; «(sin
      T.C. no entra en pesos …)»). Todos empiezan con «pago comisión
      vendedor»; ninguno con «PROVISIÓN (»; las filas con $0.00 nunca llevan
      «sin TC».
    - **Bloque VUELATOUR** (invariante 47, sin cambio de aritmética): nota con
      la señal `pagoVendedorACargoDelAvion` «pago al vendedor (solo los
      gastos reales capturados: la «Comisión del vendedor (VuelaTour)»
      egresa aquí; la «Comisión del vendedor (avión)» que carga un avión en
      su columna COMISIONES aquí egresa $0.00)»; sin ella «pago al vendedor
      (solo los gastos reales de comisión del vendedor capturados)».
      `pagos_vendedor_usd` = Σ «(VuelaTour)» + «(avión)» que nadie carga; las
      filas $0.00 no lo bajan ni anulan el lado.
    - **Balance** (`buildPayload`): `calcComisiones` para TODA fila de avión
      con parte (con `gastosPorVuelo.get(v.id)`, la lista COMPLETA del vuelo,
      NUNCA `vGastos`); la fila lleva COMISIONES con `lleva_comisiones`.
      `comision_vendedor_real_pagos = vendedor_absorbido ?
      vendedor_avion_pagos_n : 0`. Pendientes (una vez por vuelo, en el
      avión que reporta): captura («Vuelo #233 (03-sep …): comisión del
      vendedor cotizada ($162.40 USD) sin pago capturado — captúralo en
      Gastos ligado a este vuelo como «Comisión del vendedor (avión)» si lo
      carga el avión (resta en su columna COMISIONES) o como «Comisión del
      vendedor (VuelaTour)» si lo paga VuelaTour ('otros movimientos' del
      Balance general)»), sin T.C. de la «(avión)» y «gasto «Comisión del
      vendedor (avión)» que ningún avión carga (motivo) — lo paga VuelaTour
      …; si el pago es de VuelaTour, reclasifícalo a «Comisión del vendedor
      (VuelaTour)»» (plural «N gastos … los paga … reclasifícalos»; en el
      libro EXTERNOS cuenta las «(avión)» de sus vuelos con motivo «sin
      avión»).
    - **Reparto** (`profit-sharing.service`): `compute()` arma el Set GLOBAL
      `vuelosConPagoVendedorAvion` (universo con el MISMO K de
      `comisionesDelVuelo` ∧ algún factor > 0) y lo pasa en `ctx`;
      `computeAvion` calcula `comisionesDelVuelo` SIEMPRE (`comisionesVuelo =
      lleva_comisiones ? calc : null`), salta el cancelado con
      `!retieneCobros(conv)` y ya no tiene `vuelosVendedorACargo`. **K de las
      comisiones = el MISMO del balance** (revisión 13-oct-2026,
      `kComisionesDeVuelo`): tc_usd_mxn ?? oficial del día de la cotización
      (`fecha_solicitud ?? fecha_vuelo`) — el de los cobros si lo pidieron
      (`cobrosNecesitanTc`); si no, el del mapa APARTE `tcKComisionesVuelo`,
      que `compute()` resuelve en el MISMO lote de días para los vuelos sin
      tc_usd_mxn con un pago «(avión)» MXN sin tc_gasto
      (`pagoVendedorAvionNecesitaK`). Antes el reparto solo pedía el oficial
      para los cobros: un pago «(avión)» en pesos de un vuelo sin
      tc_usd_mxn (101 de 271 COMPLETADO de jul–oct) restaba en el balance y
      NO en el reparto (quedaba en `gastos_sin_tc`; los socios cobraban el
      pago de más). `cobros_tc_oficial_count`, `detalle.vuelos[].tc_oficial`
      y `tc_oficial` siguen contando SOLO los vuelos cuyos COBROS lo usaron.
      `fetchGastosVendedorDeVuelos` sin filtro
      de categoría ni de fecha (el mapa guarda las dos por la unión; el
      util elige el lado). Cuatro claves EXCLUIDO por el eje fecha_gasto
      (SOLO transparencia, ninguna suma; cada una empieza con el código
      EXACTO y « · » para que `detalleGastos` derive la etiqueta):
      «COMISION_VENDEDOR · egreso en «otros movimientos» del Balance
      general» (toda «(VuelaTour)»), «COMISION_VENDEDOR_AVION · resta en
      Comisiones del avión (mes del vuelo)», «COMISION_VENDEDOR_AVION · vuelo
      de otro periodo o aún no completado (cuenta en el mes de su vuelo)» y
      «COMISION_VENDEDOR_AVION · ningún avión la carga: la paga VuelaTour en
      «otros movimientos»». El Set global arregla la clave de una comisión
      sellada a OTRO avión (caso i5). Integridad sin doble aviso: la clave
      «resta en Comisiones» no suma a `gastos_sin_tc_*` ni a T.C. oficial.
      El bloque `externos` NO cambia (sigue restando `pagoVendedorUsd`
      cotizado a la utilidad externa, que no se reparte).
    - **Libro Dinero** (d): aritmética SIN cambio — es la CAJA de VuelaTour
      (sin utilidad por avión) y resta UNA vez los pagos de las DOS
      categorías (`pagosVendedorDeVuelo(…, 'AMBOS')`;
      `utilidades_comision_vendedor_pagada_mxn` = Σ de las dos;
      `utilidades_otros_ingresos_mxn = r2(Σ ingreso − pagada − comisiones de
      ingresos)`; provisionada 0). Cambian el concepto (`+
      sufijoParteAvionDinero`: « · incluye «Comisión del vendedor (avión)»
      por $3,000.00: la resta el avión en el Balance general» o « · incluye
      «Comisión del vendedor (avión)» que ningún avión carga») y la nota
      (`NOTA_PAGO_VENDEDOR_REAL` / `_SIN_LINEA` nuevas + `notaParteAvionDinero`),
      que solo deciden textos (`avionLaCarga` = universo con el K del libro ∧
      algún factor > 0, nunca dinero). Llave NUEVA informativa
      `utilidades_comision_vendedor_avion_mxn` (Σ MXN de las «(avión)» que
      carga un avión; solo > 0). **Diferencia ESPERADA** con el bloque
      VUELATOUR del Balance general == esa llave (la «(VuelaTour)» resta
      igual en los dos libros). Si CHARTERS/UTILIDAD llegan a tener regla
      por avión, la «(avión)» que carga un avión debe dejar de restarse en
      el Dinero (se contaría dos veces).
    - **`dashboards.gastos`**: renglón ADITIVO
      `resumen.gastos_comision_vendedor_avion_usd` (la «(avión)», por
      fecha_gasto, antes del corte por `categoriaFueraDelAvion`): DENTRO de
      `gastos_totales_usd`, FUERA de `gastos_avion_usd`, costo por hora,
      utilidad por avión y `gastos_empresa_usd` (el costo del avión lo lleva
      `overview` vía el reparto). La «(VuelaTour)» sigue en empresa.
    - **Contrato / skew (todo ADITIVO, sin bandera nueva)**: la bandera
      `comision_vendedor_solo_gasto_real: true` de la D3 (raíz de cada
      `BalanceAvionPayload` —individual, cada `aviones[]` y el consolidado
      FLOTA—, `otros_movimientos`, `RepartoPdfPayload` y `DineroXlsxPayload`)
      significa desde el 0.0.74 «solo gasto real, en dos categorías» y
      pyservices reescribe EN SU LUGAR sus textos (sin ella, byte a byte).
      Fila del balance: `comision_vendedor_real_mxn` = parte de ESTE avión de
      las «(avión)» que absorbe; `comision_vendedor_real_pagos` = cuántas
      (LA señal; nunca `vendedor_mxn > 0`); `comision_vendedor_prov_mxn` 0;
      `comisiones_mxn` = banco + «(avión)» (null si 0); las llaves viajan en
      la vigencia y en filas ANTERIORES que absorben. Reparto:
      `detalle.vuelos[].comision_vendedor_real_usd` = solo «(avión)»;
      `comisiones_venta_usd` puede ser ≠ 0 en un mes anterior a la regla.
      Dinero: `utilidades_comision_vendedor_avion_mxn?: number | null`.
      Skew: pyservices nuevo + API ≤ 0.0.73 ⇒ sin bandera, libros de
      siempre; API 0.0.74 + pyservices de prod (4d206ab) ⇒ números
      correctos, leyendas viejas un rato, cero 422 (`extra="ignore"`); panel
      nuevo + API 0.0.73 ⇒ la categoría nueva rebota con el 400 de IsEnum
      (panel DESPUÉS del API); API 0.0.74 sin 000003 ⇒ solo fallan el alta y
      la edición de «(avión)» (400 legible) y el filtro `?categoria=…` (500).
      **ROLLBACK del API a ≤ 0.0.73 PROHIBIDO con gastos «(avión)»
      capturados** (la fila los sumaría a OPERACIONES y el reparto volvería
      a provisionar): primero reclasificarlos a «(VuelaTour)».
    - **Datos y consecuencias para el cliente** (prod, 13-oct): #251
      (N990GG, $4,080.00 en efectivo) y #332 (N621TX, $1,305.00,
      conciliado, sin comisión cotizada) se quedan «(VuelaTour)»: nada se
      reclasifica solo. Con el 0.0.74 y sin reclasificar, al regenerar
      septiembre N990GG deja de restar 240 USD en COMISIONES y VuelaTour
      egresa los $4,080.00; si el pago le toca al avión, la oficina lo cambia
      a «(avión)» en Verificar / editar y queda como hoy («a cargo del avión
      N990GG ($4,080.00 …)»). #332 no cambia; si se reclasifica, N621TX resta
      $1,305.00 y la pestaña pinta la fila informativa $0.00. Comisiones
      cotizadas SIN pago (el pendiente de captura las lista): #233, #237,
      #260 y #317 (N4142R, septiembre), #404 y #417 (N990GG, octubre) y #442
      (XA-VGV, CONFIRMADO para el 30-oct) — capturarlas con el monto real en
      la categoría correcta y SOLO después regenerar septiembre y octubre
      (balance, reparto, cuenta corriente y Libro Dinero). Elegir la
      categoría equivocada mueve utilidad entre los socios y VuelaTour
      (defensas: etiquetas y destinos simétricos, ayudas por categoría,
      reclasificación libre). Una «(avión)» de un vuelo aún no completado la
      paga VuelaTour hasta completarse (regenerar la pasa al avión). Una
      «(avión)» de un vuelo sin avión aparece en la bandeja «sin avión», la
      alerta y el pre-cierre (no se puede poner el literal en
      `CATEGORIAS_GASTO_SIN_AVION`); asignarle avión al gasto no cambia quién
      paga: la salida es reclasificarla a «(VuelaTour)».
    - **Eliminado** (D3, código muerto que re-cablearía la provisión):
      `pagoVendedorCubiertoPorAvion`, `PagoVendedorCubiertoPorAvion`,
      `ProvisionVendedorDeAvion`, `MARCA_PROVISION_SIN_GASTO_REAL` y
      `NOTA_PROVISION_PAGO_VENDEDOR`; del ajuste: `vendedor_absorbe`,
      `vendedor_pagos_n`, `vuelosVendedorACargo`,
      `PAGO_VENDEDOR_OTRO_PERIODO_CLAVE_DETALLE` y la guarda con
      `logger.warn` de «otros movimientos».
    - **Deploy y operación**: migraciones 000003 → 000004 (ver «Migraciones
      y despliegue») → pyservices → API 0.0.74 (justo antes del push,
      `pg_enum` con el valor) → panel (SIEMPRE después del API) → Flutter:
      commit local +82 — **NO publicar el APK hasta la migración
      20261013000001 y el API 0.0.75** (la +82 incluye Comisariato +81:
      `COMISARIATO` sale en los chips del piloto y el API 0.0.74 la rechaza
      con 400 por IsEnum; el outbox la trata como determinista ⇒ captura
      FALLIDO al primer intento). Después: avisar al cliente, la oficina decide
      #251/#332 y captura los pendientes, y SOLO entonces se regeneran
      septiembre y octubre. DEUDA que el ajuste NO toca: `aircraft.metrics.
      finanzas` y `groups.gastosPorHijo` (por fecha_gasto, no ven
      COMISIONES); el reporte por vuelo restaba el pago COTIZADO (RESUELTO el
      13-oct-2026, invariante 73: resta el pago REAL); un
      avión dado de baja que voló absorbe en el balance y no en el reparto
      (`compute()` solo trae activos); `regla_comisiones` sigue sin viajar;
      T.C. heredado de la D3 (COMISIONES y reparto con tc_gasto ?? K —K el
      MISMO en los dos libros: capturado ?? oficial del día de la
      cotización, también en el reparto para un vuelo cuyos cobros no lo
      piden (revisión 13-oct-2026)—; la pestaña con tc_gasto ?? promedio;
      el Dinero con tc_gasto ?? T.C. de venta: un pago USD sin tc_gasto
      puede diferir por centavos, hoy 0 casos; el renglón informativo
      `gastos_tc_oficial` del pre-cierre da por convertido un pago
      «(avión)» MXN sin tc_gasto con el oficial del día del GASTO —el real
      usa el K de su vuelo y cuenta en el mes del vuelo—: si el día de la
      cotización no tuviera dato, lo grita `gastos_sin_tc` del avión en el
      reparto); el universo del Dinero (solo textos y la llave) puede diferir
      del Balance únicamente en un CANCELADO con reembolso neto cero en otra
      moneda sin T.C.; sin QA visual en navegador.
    - Specs: `categoria-gasto.util.spec` (21 valores con AVION justo después
      de COMISION_VENDEDOR —22 con Comisariato—, tabla exacta, EMPRESA
      congelada, unión/lado exactos, SIN_AVION sin el literal, 22P02 sin
      cruce de prefijo, `categoriaDeCheckExigeVuelo`, guardián del prefijo),
      `cobros-usd.util.spec` (`retieneCobros`), `pago-vendedor.util.spec`
      (lados VT 2,000 / avión 1,000 / ambos 3,000, `contarPagosVendedor`,
      notas nuevas), `comisiones-avion.util.spec` (D3 re-apuntada a
      «(avión)» con las mismas cifras; universo; antes de la vigencia;
      SIN_LINEA/inconsistente/cancelado con cobros; mixto; multi 1,000.01;
      «(VuelaTour)» MXN sin K fuera de `gastos_sin_tc`; pendiente de captura;
      motivos; los 8 casos de `egresoPagoVendedorDeVuelo` exactos; textos de
      pendientes y del Dinero), `aircraft-balance.service.comisiones.spec`
      (describe «dos categorías»: VT byte a byte, mixto, cancelado con/sin
      cobros, CONFIRMADO, EXTERNOS, externo con avión, antes de la vigencia,
      multi), `.comisiones-general.spec` (espec CRUZADO estado × categoría:
      cada pago en EXACTAMENTE un lado y el dinero baja el pago una vez;
      conservación con `aVuelatour`; antes de la vigencia con las dos),
      `.pago-vendedor.spec` (b)–h) VT byte a byte; i)/i4)/i5) con las dos;
      g″) D6 informativa), `balance-empresa.util.spec` (notas, fila mixta),
      `profit-sharing.service.comisiones.spec` / `.empresa.spec` (las cuatro
      claves con sus etiquetas, Set global i5, cancelado con/sin cobros,
      agosto con «(avión)»; cruce balance↔reparto con un vuelo SIN
      tc_usd_mxn, T.C. oficial y cobros que no lo piden: USD == MXN ÷ K,
      `comisiones_venta_usd == balance.comisiones_usd`, Δ saldo == Δ utilidad
      cobrada, sin `gastos_sin_tc` y sin tocar los conteos del oficial),
      `dinero-report.service.pago-vendedor.spec`
      (sufijo y notas, llave, cruce con el Balance), `expenses.service.
      sin-vuelo.spec` (400 por categoría en los 4 roles, reclasificación
      conciliada, 23514 de cada CHECK sin categoría en el dto, 22P02 de la
      nueva), `dashboards.service.comision-vendedor.spec` (balde nuevo),
      `flights.service.gastos-resumen.spec`, `flight-report.service.
      pago-vendedor.spec` y `aircraft.service.comision-vendedor.spec`. En
      pyservices, `tests/test_comision_vendedor_notas.py`,
      `test_balance_comisiones.py`, `test_balance_comisiones_general.py`,
      `test_reparto_comisiones.py` y `test_vision_validaciones.py`.

62. **PERMISOS AFAC COMO FILAS QUE SUMAN EN «OTROS MOVIMIENTOS» DEL
    BALANCE GENERAL (13-oct-2026, API 0.0.74, SIN migración).** Decisión 2
    del lote del cliente del 13-oct-2026, textual: «AFAC en "otros
    movimientos" del Balance general: filas en la tabla principal que suman
    en TOTALES (provisión AFAC del periodo = ingreso de VuelaTour por avión;
    cada permiso pagado = egreso), ya no bloque informativo bajo totales».
    SUPERSEDE el punto (2) de la invariante 53 (el bloque informativo
    `afac`). **Revisión del 13-oct-2026, ANTES del deploy (hallazgo alta de
    la revisión adversaria), CONFIRMADA por el cliente el 14-oct-2026 («el
    AFAC lo cargan al Avión»)**: el permiso PAGADO resta en el avión, así
    que en la fila va CITADO con egreso **$0.00** «a cargo del avión» —ver
    «UN PERMISO PAGADO, UNA VEZ» abajo—; la provisión sí suma como ingreso.
    - **Regla**: `payloadGeneral` (la UNA armadura que comparten
      `xlsxGeneral` y `libroGeneral`, invariante 52; NO `xlsxGeneral`)
      ANEXA AL FINAL de `otros_movimientos.filas` (después de la última fila
      por vuelo; nunca en `filas_sueltas`) UNA fila «AFAC · matrícula» por
      avión REAL de `librosAviones`, en su orden (el de los bloques de
      «balance»; el libro EXTERNOS nunca llega: `esAvion = false`). INGRESO
      = `totales.permiso_afac_mxn` del libro (= Σ de su columna T «PERMISO
      AFAC (PROVISIÓN)», round2(tarifa × z × D) por vuelo, TAL CUAL: nadie
      la recalcula); EGRESO = **$0.00 INFORMATIVO**: se citan las filas de su
      hoja `permisos` (TODOS los gastos PERMISO del avión del periodo, con o
      sin vuelo —no solo los de AFAC—: exactamente `filasPermisos` de
      `buildPayload`) con su Σ en el concepto, pero no egresan (ya restan en
      la cascada del avión). Apareados en la MISMA fila como las TUAS
      (remanente = ingreso − 0 = la provisión, 0 si solo hay permisos;
      pyservices escribe `ROUND(G−D,2)` como en toda fila). Un avión sin
      provisión ni permisos no genera fila. Como viven DENTRO de `filas`,
      suman en TOTALES con las fórmulas de siempre y entran UNA vez al
      bloque VUELATOUR (invariante 47: `ingresos_propios_usd` suma la
      provisión; `pagos_vendedor_usd` NO cambia: el egreso es 0).
    - **Fuente única PURA**
      `aircraft/afac-otros-movimientos.util.ts#filasAfacOtrosMovimientos
      (librosAviones) → {filas, tcs}` (spec; cero consultas, cero recálculo
      de provisiones o de T.C.). `payloadGeneral` empuja EN EL MISMO PASO las
      filas, su T.C. (`tcFilasOM.filas`) y su «por cobrar» 0
      (`tcFilasOM.porCobrarVtUsd`), SIEMPRE después de
      `buildOtrosMovimientos` (que ya llenó `tcFilasOM`) y antes de
      `armarBalanceEmpresa` (`movimientosConTc` LANZA si los tres arreglos no
      miden igual: un olvido tira el general con 500). `buildOtrosMovimientos`
      no conoce los libros: su retorno sigue byte a byte.
    - **Fila (orden de llaves fijo)**: `clave` «AFAC · XB-PEV» (la categoría
      primero, para no imitar el «clave · ESTADO» de los vuelos),
      `avion_color` del libro, SIN `estado`, `fecha_vuelo`/`fecha_ingreso`/
      `factura` null y `seccion: 'AFAC'` como ÚLTIMA llave. Ingreso (solo con
      provisión ≠ 0 o vuelos con provisión): «provisión AFAC del periodo · 3
      vuelos · tarifa 25.00 USD/hr» («1 vuelo»; sin tarifa > 0, sin « ·
      tarifa …») y `nota_ingreso` = «Provisión AFAC de cada vuelo de XB-PEV
      (columna PERMISO AFAC de su hoja de vuelos): tarifa 25.00 USD/hr × T.C.
      de costos × horas cobradas» + una línea «{clave del vuelo} =
      $1,082.50» por vuelo con provisión. Egreso (solo con permisos),
      `egreso_mxn` = **0**: uno ⇒ «permiso AFAC pagado · {detalle} · a cargo
      del avión XB-PEV ($2,500.00 en su hoja «permisos»)»; varios ⇒
      «permisos AFAC pagados · N conceptos (ver nota) · a cargo del avión
      XB-PEV ($5,518.00 en su hoja «permisos»)» con `nota_egreso` de una
      línea por permiso («permiso AFAC pagado · {detalle} = $2,500.00 ·
      05/09/2026»; «= —» sin pesos); `fecha_egreso` = la fecha no nula más
      antigua; permisos en USD sin T.C. ⇒ «($2,500.00 en su hoja «permisos»;
      1 en USD sin T.C.)» / «(en USD sin T.C. en su hoja «permisos»)» —NUNCA
      la marca «sin TC» que `ladoEnUsd` respeta: la fila egresa $0.00 y a
      ese lado del bloque no le falta nada; el avión sin T.C. deja su propia
      utilidad vacía—. `remanente_mxn` = round2(ingreso − 0) (nunca −0).
      Ningún texto lleva «· PROVISIÓN (» (la marca del amarillo de
      pyservices): «provisión» va en minúsculas.
    - **UN GASTO, UNA VEZ, UN MES**: las filas derivan EXCLUSIVAMENTE de los
      libros ya calculados. La provisión sigue `fecha_vuelo` (día Cancún); el
      permiso pagado, la regla del libro: `gastosAvion` (sin vuelo,
      `fecha_gasto` ∈ periodo) y `gastosVueloDelAvion` (por el MES DEL VUELO
      aunque `fecha_gasto` sea otro), parciales de reparto con su parte. Cada
      permiso cae en el mismo libro/mes que su hoja «permisos» y nunca en
      dos. Un PERMISO sin avión ni vuelo no entra (sigue en «otros gastos» ⇒
      `otros_gastos_empresa_usd`, una vez); uno de un vuelo EXTERNO se queda
      en el libro EXTERNOS (no egresa en VuelaTour). Reconstruir estas filas
      con una consulta propia a `gasto` rompería esa identidad.
    - **T.C. de la fila** (bloque VUELATOUR; NO viaja a pyservices):
      `totales.tc_promedio` del libro de su avión (promedio de las z de
      costos redondeado a 2; sin vuelos, el oficial del cierre —invariante
      47—; null se propaga: con provisión, la fila cuenta en
      `movimientos_sin_tc` y deja el lado de ingresos y el resultado vacíos;
      con solo permisos (egreso $0.00) no vacía nada —el avión sin T.C. ya
      deja vacía su participación, coherente con `permisos.usd` null—). Drift
      DOCUMENTADO: la provisión en USD (Σ X_i ÷ promedio de z) difiere de
      tarifa × Σ horas cuando z varía dentro del mes (con 100 USD/hr en las
      7 aeronaves puede ser de dólares, no de centavos); el egreso es $0.00
      (sin drift). Refinamiento NO adoptado (aditivo, solo si el cliente
      exige el USD exacto de la provisión): T.C. ponderado `ingreso ÷
      Σ(X_i ÷ z_i)` para el ingreso. El permiso pagado NO egresa aquí
      (decisión del cliente del 14-oct-2026): no hace falta un `tc_egreso`.
      El `tc_aplicado` por fila de la hoja «permisos» (invariante 59) NO se
      usa aquí para recalcular nada.
    - **Contrato (ADITIVO; skew en los dos sentidos)**:
      `BalanceOtroMovimientoFilaPayload.seccion?: 'AFAC'` (solo las filas
      AFAC) y `BalanceHojaOtrosMovimientosPayload.afac_en_filas?: true`, que
      viaja SOLO con ≥ 1 fila AFAC y se asigna DESPUÉS de construir el objeto
      (ÚLTIMA llave, tras `comision_vendedor_solo_gasto_real`): sin tarifa
      AFAC ni PERMISO con avión, la pestaña y el bloque VUELATOUR salen byte a
      byte como sin esta decisión (`GOLDEN_OM`). El API 0.0.74 YA NO manda
      `afac` (sus 3 interfaces TS y `bloqueAfacOtrosMovimientos` se
      eliminaron): nunca filas + bloque desde el mismo API (un pyservices
      viejo pintaría las filas sumadas Y la leyenda «NO entran a los
      TOTALES»). `armarBalanceEmpresa` gana el insumo `afacEnFilas?:
      boolean`, que SOLO cambia la `nota`; la aritmética ya absorbe las filas
      por `movimientos`.
    - **`nota` del bloque VUELATOUR con la señal** (sin ella, byte a byte la
      de siempre): «Ingresos y egresos propios: hoja 'otros movimientos' (por
      vuelo, AFAC por avión y sueltas), cada fila a USD con el T.C. de su
      vuelo; las filas «AFAC · matrícula» con el T.C. promedio de costos del
      libro de su avión (sin vuelos, el oficial del cierre); las sueltas con
      su T.C. o el oficial del día. Ingresos = lo COTIZADO (TUAs, extras,
      pernocta y comisión del vendedor) de los vuelos del periodo no
      cancelados, COTIZADO y RESERVA incluidos, más la provisión AFAC del
      periodo de cada avión (la que ese avión ya carga como costo en su
      columna PERMISO AFAC). Egresos = {pagoVendedor}, TUAs pagadas, extensión
      de horario, comisión bancaria y gastos sueltos; los permisos pagados de
      cada avión van en su fila «AFAC · matrícula» con egreso $0.00: ya
      restan en el balance de su avión (hoja «permisos»).» —
      `{pagoVendedor}` es el fragmento de la invariante 61, TAL CUAL.
    - **Posición**: al FINAL de `filas` (pyservices las pinta tras el último
      vuelo, con un encabezado de sección, y antes de «MOVIMIENTOS SIN AVIÓN
      / SIN VUELO»). Si el cliente las prefiere al inicio es un `unshift` de
      los TRES arreglos al mismo índice, sin cambio de contrato.
    - **Variante «general»** (costo por hora): su hoja de la flota no lleva
      la columna T, pero la provisión sale de `totales` ⇒ las MISMAS filas
      AFAC en las dos variantes (spec). Pantalla = .xlsx (invariante 52).
    - **Skew / deploy**: API 0.0.74 + pyservices previo (sin `afac_en_filas`:
      4d206ab en prod, o 982488d) ⇒ filas AFAC pintadas y SUMADAS como filas
      normales (sin encabezado ni leyendas, sin bloque): números idénticos al
      bloque VUELATOUR. API 0.0.69–0.0.73 + pyservices nuevo ⇒ bloque
      informativo de siempre, pestaña idéntica. API ≤ 0.0.68 ⇒ nada. El
      payload mixto (`afac` + bandera) nunca lo manda el API; pyservices
      nuevo prioriza las filas y omite el bloque. Orden RECOMENDADO
      pyservices → API; los dos órdenes son numéricamente seguros (NO es
      dependencia dura): en la ventana API nuevo + pyservices viejo los
      INGRESOS PROPIOS y el RESULTADO suben con la provisión (~$27k
      MXN/avión/mes con 100 USD/hr) sin que la etiqueta lo diga.
    - **UN PERMISO PAGADO, UNA VEZ — DECISIÓN DEL CLIENTE (14-oct-2026,
      pregunta CERRADA: «¿El permiso AFAC pagado lo carga el avión o lo paga
      VuelaTour?» ⇒ «el AFAC lo cargan al Avión»)**: el permiso PAGADO resta
      SOLO en su avión —hoja «permisos» → `permisos_usd` → utilidad cobrada
      → socios (y la participación de la empresa como socia en el bloque
      VUELATOUR); en el reparto, el grupo PERMISO (eje `fecha_gasto`)—, como
      desde antes del 0.0.74 y como se entregó el reparto de septiembre. La
      fila lo CITA con egreso $0.00 (patrón de la «Comisión del vendedor
      (avión)», invariante 61): el grupo lo resta UNA vez. SUPERSEDE el texto
      literal de la decisión 2 del 13-oct («cada permiso pagado = egreso»).
      c9ac1022 lo egresaba además en VuelaTour (XB-ANU oct-2026: 5,518 de
      caja ⇒ −11,036 en el grupo). **DESCARTADO** el cambio alterno (que
      VuelaTour lo pague): no se implementa sin una decisión NUEVA del
      cliente. **Candado (API 0.0.77, revisión del 14-oct-2026)**: un
      PERMISO sin avión resoluble (`avionDelGasto`: tramo → sellado → vuelo)
      y que no sea de un vuelo externo sin avión caería en «otros gastos» de
      VuelaTour y en ningún reparto —lo contrario de la decisión—: el
      pre-cierre lo BLOQUEA (item `permisos_sin_avion` «Permisos sin avión»,
      justo después de `combustible_sin_avion` y en `bloqueantes`; `count`,
      `monto_mxn` y, solo si hay, `monto_usd` —jamás se suman monedas—;
      detalle «El permiso lo carga el avión (decisión del cliente del
      14-oct-2026): sin avión no resta en ningún balance ni en el reparto y
      el Balance general lo pondría como gasto de VuelaTour. Asígnale el
      avión o el vuelo en Gastos.»; 0 casos al 14-oct-2026). Con UN solo
      permiso el concepto copia su detalle SIN la marca «sin TC»
      (`detalleSinMarcaSinTc` ⇒ «sin T.C.»: con la marca, `ladoEnUsd`
      vaciaba EGRESOS y RESULTADO del bloque VUELATOUR aunque la fila egrese
      $0.00; riesgo latente, 0 casos). La provisión NO es doble (−T en el
      avión, +T en la pestaña). TODA la hoja «permisos» se cita rotulada
      «permiso AFAC pagado» (el detalle en la nota). Fuera de esta decisión:
      la aportación AFAC por hora (columna T) la carga el avión solo en el
      balance; el reparto no la cobra (ver «Pendientes conocidos»).
    - **Fuera de alcance**: Libro Dinero, pre-cierre (salvo el candado
      `permisos_sin_avion` del 0.0.77), la hoja «permisos» del
      libro individual (invariante 59) y la columna T con la tarifa por fila
      de la flota (invariante 53 (1)) no cambian. Sin migración.
    - Specs: `afac-otros-movimientos.util.spec` (fila exacta con egreso
      $0.00 «a cargo del avión», varios permisos, USD sin T.C. parcial y
      total SIN la marca «sin TC», solo permisos (remanente 0) / solo
      provisión, singular y sin tarifa, centavos, T.C. null, orden y
      EXTERNOS, ningún texto con la marca del amarillo, «un permiso, una
      vez» y —0.0.77— UN permiso cuyo detalle trae «sin TC» ⇒ «sin T.C.» en
      el concepto y los dos lados del bloque con número),
      `profit-sharing.service.pre-cierre-vuelos-sin-factura.spec`
      (`permisos_sin_avion`: sin avión ni vuelo ⇒ count, `monto_mxn` y
      `monto_usd` aparte y `listo` false; con vuelo propio o de un externo
      sin avión ⇒ no bloquea y sigue en `gastos_sin_avion`),
      `aircraft-balance.service.afac-om.spec` (mundo con tarifa 25 y tres
      permisos —uno del #501 pagado el 03-oct: cuenta en el MES DEL VUELO—:
      fila al final con ingreso = `totales.permiso_afac_mxn` y egreso $0.00
      citando `permisos.total_mxn`, bandera última llave y sin `afac`, Σ
      remanente, bloque VUELATOUR (ingresos ± 0.01, egresos IGUALES),
      conservación —dinero total == el mundo sin AFAC (la provisión netea) y
      el permiso resta UNA vez, en la cascada (`permisos_usd`)—, sin
      AFAC `GOLDEN_OM` byte a byte, dos aviones en el orden de `aviones` con
      el PERMISO de EXTERNOS en su libro, el inverso del caso «consolidado ==
      buildOtrosMovimientos directo», variante general y un PERMISO de
      empresa que sigue en «otros gastos»),
      `aircraft-balance.service.bloque-empresa.spec` (los 3 casos con
      PERMISO: XB-ANU sin vuelos con el T.C. del cierre, egresos IGUALES y
      el resultado baja SOLO la participación al 30 % (−30.59, no −101.96 −
      30.59), XB-DOS y XB-ANU sin T.C. ⇒ fila $0.00 que no vacía el lado y
      resultado vacío por la participación; el caso «consolidado ==
      directo» vale SOLO sin AFAC) y `balance-empresa.util.spec` (nota con y
      sin la señal, con el fragmento «a cargo del avión» intacto; `ladoEnUsd`
      con la fila AFAC informativa —egreso 0 que nunca vacía su lado, ni con
      «USD sin T.C.»— y `movimientosConTc` con una fila AFAC). En
      pyservices, `tests/test_balance_otros_movimientos_afac.py`.

63. **COMISARIATO (13-oct-2026, API 0.0.75, migraciones `20261013000001`
    y `20261013000002`).** Pedido del cliente (Jimmy, 12-oct-2026): «agregar
    en la categoría de gastos: Comisariato; entraría en [la columna OTROS de
    costos directos] en el balance del avión». Hasta hoy el comisariato de
    los PASAJEROS (snacks, bebidas, hielo) se capturaba como «Otros gastos
    VuelaTour» (OTRO) y, desde el 11-sep-2026, un OTRO con vuelo es gasto de
    la EMPRESA: no llegaba al avión.
    - **Tabla canónica** (IDÉNTICA en API `categoria-gasto.util`, panel
      `categorias-gasto.ts` y app `categoria_gasto.dart` —la app ya la
      tiene desde 66e8036/+81—; va JUSTO después de COMIDA en el enum del
      DTO, en el selector del panel y en los chips de la app): código
      `COMISARIATO`, etiqueta «Comisariato», destino «Gastos directos del
      vuelo (en el balance del avión)» (el MISMO de COMIDA). En la BD es el
      22.º valor del enum `categoria_gasto`, AL FINAL (21 ⇒ 22: la 000003
      del lote 1 ya puso COMISION_VENDEDOR_AVION). `CATEGORIA_COMISARIATO`
      exporta el literal.
    - **Reglas** (todas derivadas o por lista existente; ninguna lista de
      `categoria-gasto.util` cambió): directa del vuelo ⇒
      `categoriaExigeVuelo` true, candado SOLO del PILOTO (400
      `GASTO_REQUIERE_VUELO` «Esta categoría es del vuelo: elige el vuelo.
      «Comisariato» siempre se registra con el vuelo al que pertenece.»,
      `details` {categoria, categoria_label 'Comisariato', destino}); la
      oficina la captura SUELTA y la liga después; NO está en
      `CATEGORIAS_GASTO_VUELO_OBLIGATORIO` (la única con vuelo para todos
      sigue siendo la comisión), NO es de EMPRESA, NO es «sin avión» (sin
      avión SÍ es pendiente real: bandeja `?pendientes=1`,
      `sugerirAsignaciones`, alerta `gastos_sin_avion` y pre-cierre, como
      COMIDA), NO queda fuera del avión. SÍ en `CATS_SIN_TUA_EMBEBIDO`
      (ticket de súper/OXXO: jamás se separa TUA/FBO/extensión), en
      `CATEGORIAS_NO_LIGABLES` de compras; no repartible
      (`CATEGORIAS_REPARTIBLES` y `tg_gasto_reparto_valida` sin cambio). La
      IA de tickets SÍ la sugiere (pyservices: «snacks/bebidas para los
      PASAJEROS»; sin señas ⇒ tripulación); el enriquecimiento offline nunca
      pisa la categoría (si difiere, «⚠ categoría capturada Comida, la IA
      sugiere Comisariato»).
    - **Libros (sin campos nuevos; con 0 gastos COMISARIATO todo payload es
      byte-idéntico)**: Balance por avión, fila del vuelo: `CAT_OTROS` =
      {FBO, COMISARIATO} ⇒ `otros_mxn` += el monto ENTERO en MXN con la
      cadena de siempre (`tc_gasto ?? z ?? tcPromedio`; USD sin T.C. ⇒
      `usd_sin_tc` como cualquier directa) y una línea en `otros_detalle`
      («Comisariato · <proveedor/primera línea> — $X[ (efectivo)]»); nunca
      OPERACIONES ni PILOTO (CATS_SIN_TUA_EMBEBIDO ⇒ `separarPartes` null
      aunque la IA traiga renglones); su `tc_gasto` MXN pesa en Z como
      cualquier directa. Con avión y SIN vuelo ⇒ hoja «Gastos Indirectos»
      del avión (la regla de COMIDA); sin vuelo NI avión ⇒ suelto en «otros
      gastos» del general (regla existente) y pendiente de avión. Reparto a
      socios: set `DIRECTO` (clave `COMISARIATO`, etiqueta «Comisariato»):
      resta de la utilidad y de los socios. Libro Dinero: como todo gasto
      directo del vuelo (COMIDA, OPERACIONES…) NO tiene columna ahí —no sale
      en «otros gastos» (que lee sin vuelo o de EMPRESA) ni se acredita a
      ningún avión en 'utilidades'—; su costo vive en el balance del avión
      (revisión del lote 2, 14-oct-2026: antes decía «acreditado al avión
      del vuelo», y no es así). Reporte por vuelo, tablero, ficha del
      avión y grupos: gasto del vuelo (no está en `categoriaFueraDelAvion`).
      «Otros movimientos»/TUAS pagadas: no lo ven.
    - **Cinturón 22P02**: `MIGRACION_DE_CATEGORIA` gana `COMISARIATO:
      '20261013000001'` ⇒ sin la migración el alta/edición responde 400
      «Comisariato» necesita la migración 20261013000001 en la base de
      datos; avisa a sistemas (el gasto no se guardó).
      (`MENSAJE_COMISARIATO_SIN_MIGRACION`); el de la comisión no cambió ni
      un byte. **Dependencia dura**: el API hace `.eq('categoria',
      'COMISARIATO')` en el anti-duplicado ANTES del insert y acepta
      `?categoria=COMISARIATO` ⇒ contra una BD sin el valor, 22P02/500: la
      migración 000001 va ANTES del push del API (comprobar `pg_enum` justo
      antes).
    - **Reclasificación de agosto (000002, datos, con bitácora)**: los 4
      OTRO de agosto CON vuelo cuyas notas dicen «comisariato» pasan a
      COMISARIATO: 30ab4bca (#141 N58BT, 441.50, conciliado), 83da7c99
      (#164 XA-VGV, 176.50), fab45352 (#175 N990GG, 120.00 efectivo) y
      962ecdf4 (#178 N621TX, 553.00) = **1,291.00 MXN**; línea de traza al
      final de `notas`, sello de verificación limpio, `updated_by` null ⇒
      bitácora «Sistema»; NO toca dinero ni ligas (el cargo de 30ab4bca no
      se entera). Excluidos a propósito: 671d350a (Walmart, 935.50,
      «refrescos oficina y artículos de limpieza», SIN vuelo ni avión,
      conciliado y facturado: compra de OFICINA; como COMISARIATO sería un
      pendiente de avión eterno) y b54126d5 (COMIDA «torta para 2 pilotos»:
      tripulación). Función `pg_temp` idempotente con guardas (todas o
      nada). Va DESPUÉS de la 000001 Y con el API 0.0.75 ya desplegado. **Efecto
      en dinero ya cerrado** (avisar al cliente y regenerar agosto): N58BT
      +441.50, XA-VGV +176.50, N990GG +120.00 y N621TX +553.00 en la
      columna OTROS de su vuelo ⇒ baja la ganancia y el reparto de agosto
      (ya entregado ⇒ la cuenta corriente de los socios puede marcar unos
      dólares «adelantados»); «otros gastos» del general de agosto baja
      1,291.00 y el Libro Dinero de agosto deja de listarlos en «otros
      gastos» (sin acreditarlos a ningún avión). Un peso, una vez, en el
      mismo mes.
    - **Skew / rollback**: panel previo ⇒ pinta «Comisariato» por el
      fallback capitalizado y no la propone al crear; app ≤ +80 la lee como
      código con etiqueta capitalizada. pyservices nuevo ANTES del API es
      SEGURO (revisión del lote 2, 14-oct-2026; antes este punto decía lo
      contrario): la app publicada (+80) y el panel de prod solo aplican una
      `categoria_sugerida` de SU catálogo (COMISARIATO no está ⇒ la
      ignoran), el API 0.0.74 nunca pisa la categoría (solo anota la
      discrepancia) y el APK +81/+82 NO se publica hasta la 000001 y el API
      0.0.75 — el 400 IsEnum solo lo dispara el chip de una app +81
      publicada antes de tiempo, con o sin pyservices. Orden ÚNICO del lote:
      «ORDEN DE DESPLIEGUE DEL LOTE 0.0.75» en «Migraciones y despliegue».
      **ROLLBACK del API a ≤
      0.0.74 PROHIBIDO con gastos COMISARIATO** (la fila los sumaría a
      OPERACIONES como «categoría futura no mapeada» y el reparto los dejaría
      EXCLUIDOS); el valor del enum no se retira (inofensivo sin filas).
    - Specs: `categoria-gasto.util.spec` (22 valores, COMISARIATO justo
      después de COMIDA, tabla exacta, partición DEL_VUELO, derivados, 22P02
      de las tres categorías nuevas sin cruce), `desglose-gasto.util.spec`
      (nada se separa de un COMISARIATO), `aircraft-balance.service.
      comisariato.spec` (OTROS 750 = FBO 500 + 250 con IA de OXXO, OP 300,
      PILOTO null, línea en `otros_detalle`, OTRO con vuelo fuera, cascada
      −250 exacto, con avión sin vuelo ⇒ «Gastos Indirectos» como COMIDA,
      mismas llaves con y sin comisariato), `profit-sharing.service.
      empresa.spec` (DIRECTO con su monto exacto, sin TUA embebido; control
      OTRO ⇒ EXCLUIDO) y `expenses.service.sin-vuelo.spec` (las 10 del
      vuelo rebotan al PILOTO; oficina sin vuelo; hereda avión; 22P02 ⇒
      400; reclasificar OTRO→Comisariato con cargo ligado).

64. **«PAGO DOMICILIADO» (DOMICILIADO) COMO MEDIO DE PAGO BANCARIO
    (13-oct-2026, API 0.0.75, migración `20261013000009`).** Pedido del
    cliente (13-oct-2026, 12:16): «a la hora de vincular un gasto… no viene
    en método de pago algo que diga Pago domiciliado». En el estado de
    cuenta ya hay cargos automáticos («STR*AMAZON RET REC Carg Recur.»,
    «DLO*STARLINK Carg Recur.», «03 POR COBRANZA DOMICILIADA») que la
    oficina capturaba como tarjeta o transferencia.
    - **Valor**: `DOMICILIADO`, 8.º y último de `public.medio_pago`
      (`MedioPago.DOMICILIADO` del DTO). Etiqueta ÚNICA «Pago domiciliado»
      en las dos tablas del API (`common/medio-pago.util#MEDIO_PAGO_LABEL`
      —reportes, columna PAGO del balance— y
      `expenses/medio-tarjeta.util#MEDIO_LABEL` —Excel de gastos y avisos—),
      en el panel (`MEDIO_PAGO_LABELS`) y en la app.
    - **Bancario** ⇒ entra a `MEDIOS_BANCARIOS`
      (`conciliacion/gastos-candidatos.util`, FUENTE ÚNICA, el valor AL
      FINAL: el panel lee ese arreglo por regex y compara el ORDEN con su
      espejo `MEDIOS_BANCARIOS_CONCILIACION`). Desde hoy los lectores del API
      lo LEEN de ahí en vez de copiarlo: `estado-banco.util` (columna y
      filtro «Banco»: SIN_CONCILIAR / PARCIAL / CONCILIADO),
      `expenses.service#MEDIOS_PAGO_BANCARIOS` (auto-cruce best-effort al
      crear/editar y aditivos `monto_vinculado`/`faltante`/`parcial` de
      `list()`) y el pre-cierre `gastos_bancarios_sin_conciliar` (texto:
      «Tarjeta corporativa, transferencia, PayWise o pago domiciliado sin
      cruzar con el banco: …»). Consecuencias automáticas: auto-cruce de la
      importación, candidato de «Vincular gasto» SIN justificación
      (`no_bancario: false`, `esMedioNoBancarioVinculable` false), «Gastos
      sin banco» y su Excel (columna «Medio» = «Pago domiciliado» vía
      `etiquetaMedioSinBanco`; tarjeta/PayWise/transferencia byte a byte
      como antes), pagos parciales y lotes como cualquier bancario. Se
      concilia como una transferencia.
    - **Solo oficina**: en el ALTA (`crearGasto`, antes de la regla del
      visitante y ANTES de tocar la BD) PILOTO/MECANICO/VISITANTE ⇒ 400
      `{ message: 'El pago domiciliado lo registra la oficina: elige otro
      medio de pago.', error: 'MEDIO_SOLO_OFICINA' }`
      (`MENSAJE_MEDIO_SOLO_OFICINA`). En la EDICIÓN no se bloquea: la app
      re-manda el medio vigente de un gasto que la oficina ya puso en
      DOMICILIADO (`_medioExtra`). La carga masiva de combustibles
      (`Object.values(MedioPago)`) lo acepta (es de oficina).
    - **Sin tarjeta**: `terminacionPrevia` y `acoplarTarjetaEnUpdate` ⇒ null /
      'limpiar' fuera de TARJETA_CORP (y el CHECK `gasto_check`). La IA de
      tickets NO lo sugiere y `cruzarMedioConIa` no lo cruza (un domiciliado
      no tiene ticket).
    - **Dependencia dura (la más fuerte del lote)**: el API arma
      `.in('medio_pago', MEDIOS_BANCARIOS)` CON el valor en la importación,
      candidatos, gastos sin banco y su Excel, y `?medio_pago=DOMICILIADO`
      en la lista ⇒ contra una BD sin la migración: 22P02 ⇒ 500 en TODA la
      conciliación. La migración 000009 va ANTES del push del API (comprobar
      `pg_enum` justo antes). Panel nuevo con API ≤ 0.0.74 ⇒ el selector lo
      ofrece y el API responde 400 legible de IsEnum (panel DESPUÉS del API).
      pyservices y app: tolerantes (str / `_medioExtra`). ROLLBACK del API a
      ≤ 0.0.74 solo con 0 gastos DOMICILIADO.
    - **Panel** (contrato que el API respeta): selector tras «Transferencia»
      (sin preselección), filtro «Medio» `?medio=DOMICILIADO`, ayuda bajo el
      selector y prellenado desde el cargo con `pareceCargoRecurrente`
      («Carg Recur.», «DOMICILIA…», «CARGO AUTOM…», «SUSCRIP…» ⇒
      DOMICILIADO sin tarjeta, aunque la referencia traiga 8+ dígitos).
    - Specs: `gastos-candidatos.util.spec` (arreglo EXACTO con DOMICILIADO al
      final, bancario, sin justificación), `candidatos-excluidos.util.spec`,
      `estado-banco.util.spec` (SIN_CONCILIAR/PARCIAL/CONCILIADO y
      `etiquetaMedioSinBanco`), `medio-pago.util.spec` y
      `medio-tarjeta.util.spec` (etiqueta, sin cruce con la IA, limpia la
      tarjeta), `expenses.service.medio-domiciliado.spec` (400
      MEDIO_SOLO_OFICINA en los 3 roles de campo sin tocar la BD; oficina
      sin tarjeta y con auto-cruce; aditivos de `list()`),
      `conciliacion.service.lote.spec` (candidato bancario y liga sin
      justificación ni notas) y `profit-sharing.service.pre-cierre-vuelos-
      sin-factura.spec` (renglón de bancarios sin conciliar).

65. **BANDEJA «POR FACTURAR»: CASO #376 Y ESTATUS MANUAL «FACTURADO»
    (13-oct-2026, API 0.0.75, SIN migración).** Reporte de Diego (13-oct,
    12:36): el #376 seguía en «Por facturar» aunque «Mary dice que ya lo
    hizo». **Diagnóstico (código + SELECT + edge_logs): la regla NO tenía
    defecto.** Itzi pidió factura de #375 y #376 (mismo cliente, January
    Davila, $904.51 USD c/u) el 5-oct; el 8-oct 14:46 Mary registró A-0440
    ($31,435.91 MXN ≈ los DOS vuelos) y la ligó SOLO a #375 (el API avisó
    TOTAL_DISTINTO_VUELO, que sugería «parcial», no «¿cubre otro vuelo?»);
    #376 tenía solicitud viva y CERO ligas ⇒ por facturar, correcto. El
    13-oct 13:21 Mary agregó #376 a A-0440 y el CAS lo subió a FACTURADO (el
    «FACTURADO manual» era el efecto de ligar). Sin arreglo de datos.
    - **Regla (fuente única `estadoSolicitud(v, vigentesLigadas,
      exigencia)` —el 3.er parámetro es OBLIGATORIO desde el 0.0.77: `null`
      = no leída ⇒ como antes—)**: 'POR_FACTURAR' = lo de siempre ∧
      `factura_estatus` ≠ 'FACTURADO' ∧ no YA_NO_APLICA;
      'MARCADO_SIN_REGISTRO' = lo mismo pero marcado «Facturado» a mano
      (gana sobre YA_NO_APLICA); 'YA_NO_APLICA' (0.0.77, invariante 60) =
      solicitud AUTOMÁTICA viva y el vuelo ya no exige; 'NINGUNO' en
      cualquier otro caso. `esPorFacturar`, `esMarcadoSinRegistro` y
      `esSolicitudYaNoAplica` (misma firma) ≡ cada estado. Sin la
      llave `factura_estatus` la función se comporta como antes (todo
      lector que la alimenta la suma al select: `COLS_VUELO_SOLICITUD`,
      `filasSolicitud`, `conteoPorFacturar`, `porFacturar`,
      `vuelosCandidatos`). ELABORADA_ENVIADA y SIN_FACTURA siguen por
      facturar (la factura no está registrada). La solicitud AUTOMÁTICA por
      cobro (invariante 60) ya omitía los FACTURADO: bandeja y solicitud
      ahora dicen lo mismo.
    - **Contrato (TODO aditivo; el panel trata cada campo como opcional)**:
      `GET /v1/facturas-emitidas/por-facturar` ⇒ `ListaPorFacturar { data,
      count, marcados_sin_registro, ya_no_aplican }` (`ya_no_aplican` desde
      el 0.0.77, invariante 60, misma forma y orden; `data` solo
      POR_FACTURAR con el orden
      de siempre; `marcados_sin_registro` con la MISMA forma y orden, cada
      item con `vuelo.estatus_manual: 'FACTURADO'`). `GET …/por-facturar/
      conteo` ⇒ `ConteoPorFacturar { por_facturar, paga_contra_factura,
      marcados_sin_registro, ya_no_aplican }` (el badge del menú lee SOLO
      `por_facturar`;
      `ResumenFacturas.por_facturar` y la fila del Excel «Por facturar
      (pedidas sin factura)» = el mismo conteo). `factura_servicio`
      (snapshot, POST/DELETE solicitud-factura) ⇒ + `marcado_sin_registro:
      boolean` y, desde el 0.0.77, `exigencia`, `origenes_exigen` y
      `solicitud_ya_no_aplica` (últimas llaves); `factura_servicio_resumen`
      conserva su forma (su
      `por_facturar` ya aplica la regla: el chip ámbar desaparece para los
      FACTURADO a mano).
    - **Parte B — prevención del caso (`PorFacturarItem.facturas_del_cliente`,
      ADITIVO al final del item)**: facturas VIGENTES no borradas del MISMO
      cliente (`vuelo.cliente_id`) que NO están ligadas a ese vuelo y con
      `fecha_emision` ≥ día Cancún de (solicitada_at − 30 días); máx. 3,
      `fecha_emision` desc y `folio_num` desc; `{ id, etiqueta ('A-0440'),
      fecha_emision, total (number), moneda, vuelo_ids, vuelo_folios }`
      (listas vacías = factura registrada SIN vuelo). Se calcula para `data`
      y para `marcados_sin_registro`; lotes de 200 y anti-cap (`leerTodo`);
      si falla ⇒ `[]` + warn (la bandeja nunca se cae). El panel ofrece
      «Ligar a A-0440» CON confirmación y usa el `PATCH
      /v1/facturas-emitidas/:id` de siempre con `vuelo_ids` = la UNIÓN
      releída justo antes (el PATCH REEMPLAZA el conjunto). Además
      TOTAL_DISTINTO_VUELO dice ahora «…Revisa el total (si es un anticipo,
      márcala como parcial; si cubre más vuelos del cliente, agrégalos en
      «Vuelos»).».
    - **Consecuencia aceptada**: al CANCELAR/ELIMINAR una factura, un vuelo
      que quedó FACTURADO (por el CAS de ligar o a mano) ya NO regresa al
      badge ni a «Por facturar»: cae en «Marcados «Facturado» sin factura
      registrada» (la misma pantalla) y cancelar ya avisa
      VUELO_SIGUE_FACTURADO (invariante 27). Si el cliente prefiere que
      vuelvan al badge, basta sumar `marcados_sin_registro` en el conteo del
      menú (decisión del cliente). El estatus manual NUNCA se baja solo.
    - **Skew**: API nuevo + panel previo ⇒ los FACTURADO a mano salen de la
      bandeja sin nota hasta desplegar el panel (en prod hoy son 0); panel
      nuevo + API previo ⇒ sin tarjeta 2, chip ámbar de siempre, sin «Ligar».
      Orden API → panel (el inverso también es seguro). pyservices y Flutter
      no consumen estos campos.
    - Specs: `factura-solicitud.util.spec` (los tres estados, ELABORADA /
      SIN_FACTURA / sin llave, FACTURADO + cancelado/PAC, bloque y resumen),
      `factura-solicitud.service.spec` (bloque y resumen con FACTURADO, el
      select del vuelo lee `factura_estatus`), `facturas-emitidas.service.
      spec` (ajuste del #342 a `marcados_sin_registro` con conteo {1, 0, 1};
      regresión #375/#376: ligada a uno ⇒ el otro queda y SUGIERE A-0440;
      ligada a los dos ⇒ vacío; cancelada ⇒ el FACTURADO a la nota y el
      otro a la bandeja; borrada / otro cliente / antes de la ventana no se
      sugieren y el día 30 sí; máx. 3 en orden; lectura caída ⇒ `[]` + warn;
      250 vuelos ⇒ `.in` ≤ 200) y `facturas-emitidas.util.spec` (texto
      nuevo de TOTAL_DISTINTO_VUELO).

66. **TUA SISTÉMICA: UNA PRIORIDAD PARA LA TUA EMBEBIDA (13-oct-2026, API
    0.0.75, migración `20261013000008`; decisión 2 del lote 2 del
    13-oct-2026).** Caso #383 (gasto 8c60e428): la IA leyó corrida la tabla
    resumen de ASUR y llamó «Autobuses» a la Tarifa TUA de $559.63 — nada se
    separó, la fila del vuelo cargó la TUA como OPERACIONES (costo del avión
    que no es suyo) y «Otros movimientos» dejó la TUAS cobrada sin egreso. Y
    #118 (45007a9c, ago): sus renglones no cuadran por $29.71 y su TUA nunca
    se separó.
    - **Prioridad ÚNICA** (`common/desglose-gasto.util.ts#partesDeGasto`,
      moneda del gasto, IVA incluido, base = monto − propina):
      `gasto.tua_incluida` (OFICINA; 0 = sin TUA: esa parte vuelve a
      Operación y FBO/extensión de la lectura se conservan; > 0 = esa TUA,
      topada a la base, aunque los renglones no cuadren, y FBO/extensión de
      la lectura se RECORTAN al resto: la TUA manda; con 0 y sin lectura que
      separe ⇒ null) > renglón reconocido (`esTua`/`CLAVES_TUA`, sin cambio)
      > `valor_ia_extraido.tua_monto` (la TUA con IVA que la IA leyó APARTE;
      `desgloseGastoPartes(…, { tuaMonto })`) SOLO si ningún renglón es TUA,
      0 < tua_monto ≤ total + 0.05 y la tabla CUADRA (formas a/b de siempre;
      ya trae IVA: jamás × 1.16). Sin renglones válidos o con tabla que no
      cuadra ⇒ nada: pyservices vacía la tabla que no suma
      (`validar_suma_conceptos`) y separar con la señal sola sería reparar
      una lectura rota (regla del 26-ago, caso #118). Orden deliberado de
      `partesDeGasto`: conceptos → respaldo por notas → nada. Sin
      `tua_incluida` ni `tua_monto`, byte-idéntico (it.each sobre TODAS las
      fixtures de siempre).
    - **Las exclusiones de `trasladosEmbebidosDeGasto` GANAN aun con
      override** (sin vuelo, parcial de reparto, `CATS_SIN_TUA_EMBEBIDO`,
      categorías de EMPRESA).
    - **«TUA pagada» = `trasladosPagadosDeGasto(g).tua`** (empresa ⇒ 0;
      `TUAS` ⇒ el gasto ENTERO; si no, la embebida con override;
      `tuaPagadaDeGasto` = su `.tua`): fuente única de «tuas pagadas»
      («Otros movimientos»), del Libro Dinero y del pre-cierre — prohibido
      volver a escribir el ternario `categoria === 'TUAS' ? … :
      trasladosEmbebidosDeGasto(…)`. La fila del vuelo (`separarPartes` →
      `partesDeGasto`) y el reparto (`computeAvion` →
      `trasladosEmbebidosDeGasto(g)`, fila informativa «TUA embebido
      (excluido)» y costo DIRECTO) ven el override SIN cambio de lógica:
      `tua_pagado_mxn`, «tuas pagadas» y «TUA embebido (excluido)» son el
      MISMO número.
    - **`gasto.tua_incluida` es de OFICINA**: PILOTO/MECANICO/VISITANTE la
      PIERDEN en el controller y en el service (alta y PATCH; jamás un 400
      por un campo que su app no ve). Solo en `CATEGORIAS_TUA_INCLUIDA` =
      OPERACIONES, ATERRIZAJE, FBO (subconjunto de donde
      `trasladosEmbebidosDeGasto` separa; el panel la COPIA con test de
      paridad; en prod solo OPERACIONES trae renglones TUA) y ≤ monto −
      propina, validado sobre el estado FUSIONADO (reglas PURAS en
      `expenses/tua-incluida.util.ts`: `errorTuaIncluidaAlta`,
      `decidirTuaIncluidaEnUpdate`, `celdasTuaExcel`). DTO: `tua_incluida?:
      number | null` (≥ 0, 2 decimales; `@Type(() => Number)` conserva el
      null con `enableImplicitConversion`). PATCH: ausente = no tocar; null =
      volver a la lectura de la IA; 0 = sin TUA. Errores (`{ message, error,
      details }`): 400 `TUA_INCLUIDA_NO_APLICA` «La categoría «Comida» no
      lleva TUA incluida: solo las facturas de aeropuerto (Operaciones,
      Aterrizaje o FBO). Déjala vacía o cambia la categoría.» (la categoría
      se revisa ANTES que el importe; `details {categoria}`); 400
      `TUA_INCLUIDA_MAYOR_QUE_TICKET` «La TUA incluida ($600 MXN) no puede
      ser mayor que el monto del ticket ($559.63 MXN, sin propina).»
      (`details {tua_incluida, base, moneda, vigente: false}`) o, cuando la
      OFICINA baja el monto bajo la TUA vigente sin tocarla, «Este gasto
      tiene una TUA incluida de $559.63 MXN fijada por la oficina y el nuevo
      monto del ticket ($500 MXN, sin propina) es menor: corrige o vacía
      «TUA incluida en este gasto» en el mismo guardado.» (`vigente: true`);
      409 `TUA_INCLUIDA_NO_DISPONIBLE` «La TUA incluida todavía no se puede
      guardar: falta aplicar la migración 20261013000008. Mientras tanto la
      TUA se separa solo con la lectura de la IA.» (`details {migracion}`)
      si llega un NÚMERO sin la migración (null sin ella = no-op); 409 «La
      TUA incluida no puede ser negativa.» si el CHECK responde 23514
      (`mensajeCheckGasto`, primera rama). **Limpieza automática** (null +
      warn; la bitácora registra el cambio) en un PATCH SIN la llave con una
      TUA vigente > 0: la categoría efectiva ya no la admite o cambió la
      MONEDA del gasto (la cifra estaba en la moneda vieja: USD y MXN nunca
      se mezclan) — todos los roles —, o un rol de campo bajó el monto bajo
      ella. Un 0 vigente nunca se limpia solo. Un PATCH que no toca nada de
      eso no lee el gasto vigente ni decide. **Con la llave presente la
      limpieza por MONEDA no aplica** (la cifra se acepta en la moneda
      nueva si cabe): por eso el PANEL (revisión del lote 2, 14-oct-2026) ya
      no reenvía la cifra precargada al cambiar la moneda — la manda SOLO si
      la oficina la reescribió en el campo; si no, la llave no viaja, aplica
      esta limpieza y el panel lo avisa y pide confirmación antes del PATCH
      (igual al reclasificar fuera de Operaciones/Aterrizaje/FBO). Antes,
      corregir USD 1,000 → MXN 17,500 sin tocar la TUA de 300 la guardaba
      como 300 MXN en silencio. **No es dinero del banco**: no
      entra a `cambiaDineroDelGasto` (se corrige con el gasto conciliado), al
      candado del reparto manual ni al auto-cruce.
    - **Sonda ÚNICA** `common/tua-incluida-disponible.util.ts`
      (`tuaIncluidaDisponible`, `colTuaIncluida`, `MIGRACION_TUA_INCLUIDA` =
      `20261013000008`; patrón `columnaOpcional`). **REGLA DURA: todo
      select/insert/update que nombre `gasto.tua_incluida` va detrás**:
      Gastos `cols()`/`listCols()` (los 8 selects de `expenses.service`:
      list, findById, darVistoBueno, releerGasto, insert, replay
      idempotente, update y listOtrosGastos), la consulta de gastos de
      vuelos del balance (`buildPayload`), «Otros movimientos», Libro
      Dinero, reparto (`fetchGastos`) y pre-cierre. NO la leen (nunca
      separan TUA): gastos del avión sin vuelo, combustible y el embed de
      `gasto_reparto`. Sin la migración todo como el 0.0.74. El «sí» se
      memoriza: tras el ROLLBACK de la migración hay que reiniciar el API.
      Las consultas con el select dinámico se tipan a mano (`as unknown
      as …`). OJO specs: la sonda es un `from('gasto').select('tua_incluida')
      .limit(1)` más; los fakes con resultados EN COLA por tabla deben
      contestarla sin consumir la cola (patrón de
      `expenses.service.cas.spec`).
    - **Aditivos (el panel trata cada uno como opcional)**: `GET
      /v1/expenses` y `GET /v1/expenses/:id` ⇒ `tua_incluida` (string |
      number | null; la LLAVE solo existe con la migración) y
      `tua_detectada_ia` (number | null: lo que separa la LECTURA, ignorando
      el override; lo suma `findById`, así que también viaja en lo que éste
      relee — el PATCH sin campos de negocio y `details.actual` del 409
      `CONFLICTO_VERSION`, que la app fusiona `{...copia, ...actual}`).
      Lectura de comprobantes (`VisionService.readGastoTicket`: `POST
      /v1/vision/gasto-ticket` y `POST /v1/expenses/:id/reanalizar-ia`) ⇒
      `tua_monto` (eco de pyservices) y `tua_detectada` (siempre que la
      lectura sea legible con monto; la vista previa no conoce categoría ni
      vuelo); `desglose_lineas` se arma con la señal y viaja con ≥ 2
      conceptos (como hoy) o, con `tua_monto`, con ≥ 2 líneas («Operación -
      $1365.64 MXN», «TUA (IVA incluido) - $559.63 MXN»). El alta y el
      enriquecimiento IA usan la señal en el bloque «Desglose:» de las
      notas; las notas YA guardadas NO se reescriben. Excel de gastos
      (`GET /v1/expenses/export`): «TUA incluida» (money: la TUA que separan
      los libros; 0.00 si la oficina fijó «sin TUA»; vacía si nada) y
      «Origen TUA» («Oficina» | «IA» | vacío) JUSTO después de «Monto»
      («Capturado» se corre dos lugares). Nota del balance (fila del vuelo):
      «TUA (IVA incluido) $700.00** (fijada por oficina)» cuando la TUA es de
      oficina (`SUFIJO_TUA_FIJADA_OFICINA`) y «TUA: 0 (fijada por oficina)»
      (`NOTA_TUA_CERO_OFICINA`, `tuaAnuladaPorOficina`) cuando la oficina
      anuló una TUA que la IA sí separaba; sin `tua_incluida`, texto
      byte-idéntico. El payload a pyservices NO cambia de forma.
    - **Pre-cierre `tua_cobrada_sin_pagada`** (fuente PURA
      `profit-sharing/tua-cobrada-sin-pagada.util.ts`): «Vuelos con TUA
      cobrada al cliente sin TUA pagada», NO bloqueante (fuera de
      `bloqueantes`, sin `informativo`), JUSTO después de
      `vuelos_sin_gasto_operaciones`. Universo: COMPLETADO del periodo
      (cortes Cancún), PROPIOS (`es_externo` ≠ true) con
      `particionIngresoVuelo(v).tuas_usd > 0` (pre-IVA; FUENTE ÚNICA de la
      TUA cobrada, prohibido leer `vuelo.tuas_usd` o el snapshot a mano; las
      particiones `inconsistente` ENTRAN: «Otros movimientos» también lista
      sus líneas TUAS) y SIN ningún gasto con `vuelo_id` = el vuelo (de
      CUALQUIER fecha: la factura del aeropuerto llega días después) con
      `tuaPagadaDeGasto > 0` (existencia, no se convierte moneda). Externos
      y cancelados fuera. Forma: `{ clave, titulo, detalle, count,
      monto_usd (Σ tua_cobrada_usd, round2), vuelos [{id, folio,
      fecha_vuelo, matricula | null, tua_cobrada_usd}] por fecha_vuelo (folio
      de desempate, sin fecha al final), lectura_fallida }`. Lectura
      (`vuelosTuaCobradaSinPagada`) en lotes de ≤ 200 ids y PAGINADA
      (`leerEnLotesPaginado`, anti-cap-1000), sin filtro de fecha ni de
      categoría (la regla vive en el util; filtrar enums en la consulta
      arriesga un 22P02); lectura caída ⇒ count 0, monto_usd 0,
      `lectura_fallida: true` y «No se pudo verificar la TUA pagada…». Sin
      «descartar» (como `vuelos_sin_gasto_operaciones`).
    - **Avisos al cliente (con el deploy)**: (a) capturar la TUA incluida (o
      «Reanalizar con IA» + guardar) en un gasto VIEJO mueve la TUA de
      OPERACIONES a «Otros movimientos» en el mes de ESE gasto — septiembre
      ya cerrado incluido (no existe candado de mes cerrado para gastos) —, y
      el reparto ya entregado puede moverse; (b) el primer pre-cierre
      estrenará el renglón (estimado por SELECT del 13-oct: agosto #132,
      #169, #172, #198 y #118; septiembre #192, #210, #226, #293, #329;
      octubre #384, #417); algunos pueden ser TUA pagada en ventanilla sin
      factura (el aviso queda vivo); (c) un 0 de oficina manda sobre lecturas
      futuras (volver a la IA = vaciar el campo y guardar); (d) un
      `tua_monto` con renglones vacíos o que no cuadran NO separa: queda el
      paso manual (el panel enseña «La IA leyó una TUA de $X…»); (e) «la TUA
      manda» recorta FBO/extensión de la lectura cuando la cifra de oficina
      no cabe junto a ellos (factura 1,925 con FOB 300 y TUA 1,800 ⇒ FBO 125).
    - **Deploy**: pyservices (prompt + `tua_monto`; un API ≤ 0.0.74 ignora la
      llave y la app/panel la guardan dentro de `valor_ia_extraido`) →
      migración `20261013000008` (cualquier momento: el API la sondea) → API
      0.0.75 → panel DESPUÉS del API (con un API viejo o sin la migración el
      gasto no trae la llave y el campo no se pinta: cero 400 por
      `forbidNonWhitelisted`). Flutter: sin cambio. Rollback: API ⇒ versión
      anterior (la columna extra no estorba); la migración solo por el SQL
      Editor exportando antes las TUA fijadas y reiniciando el API.
    - Specs: `desglose-gasto.util.spec` (señal `tua_monto` con #383, forma a
      sin × 1.16, #118 que no cuadra, mayor que el total, renglón nombrado
      que manda; override con #383/#118/mixta/#314/USD/propina; exclusiones;
      helpers; it.each de regresión con opciones neutras),
      `tua-incluida-disponible.util.spec` (42703 y PGRST204 ⇒ false con
      re-sondeo, memoria del «sí», `colTuaIncluida`),
      `expenses/tua-incluida.util.spec` (textos exactos, alta, tabla de
      decisiones del PATCH, celdas del Excel), `expenses/dto/expenses.dto.
      spec` (559.63, 0, «559.63», null ≠ 0, −1/abc/1.234 ✗, alta y PATCH),
      `medio-tarjeta.util.spec` (CHECK negativo),
      `expenses.service.tua-incluida.spec` (alta oficina/piloto/campo,
      400/409 sin insertar, null sin migración, PATCH null / solo la TUA /
      reclasificar / moneda / piloto baja el monto / oficina baja el monto /
      COMIDA / conciliado sin consultar cargos / solo notas, sonda en false
      sin nombrar la columna, `tua_detectada_ia`, Excel y «Desglose:» con la
      señal), `vision.service.tua-monto.spec` (#383, sin señal, renglón que
      manda, un renglón + señal, pyservices previo idéntico salvo
      `tua_detectada`), `aircraft-balance.service.tua-incluida.spec` (#383
      con señal: el MISMO número en la fila y en «tuas pagadas»; 0 de
      oficina con su nota; 700 con «(fijada por oficina)»; OTRO; USD 185;
      GOLDEN con y sin la migración idéntico y solo dos lecturas nombran la
      columna), `dinero-report.service.tua-incluida.spec` (0 sin egreso, 700
      apareado, empresa 0, sonda en false),
      `profit-sharing.service.tua-incluida.spec` (700 ⇒ fila informativa y
      costo − 700; 0 sobre «Tarifa TUA» ⇒ costo entero; select de
      `fetchGastos` según la sonda), `tua-cobrada-sin-pagada.util.spec`
      (universo, TUA pagada, orden, textos) y
      `profit-sharing.service.pre-cierre-tua-cobrada.spec` (BD en memoria
      max-rows 1000: posición, `monto_usd`, no bloquea, gasto de otro mes,
      consulta sin fecha ni categoría, anti-cap [0,999]/[1000,1999], externo
      y cancelado, lectura fallida, sonda en false).

67. **INGRESO ASIGNADO A UN AVIÓN: CUENTA PARA ESE AVIÓN (13-oct-2026, API
    0.0.75, migración `20261013000005` = solo CHECK + COMMENT; la columna
    `ingreso.aeronave_id`, su FK, el índice y su bitácora existen desde
    `20260924000004`).** Pedido (Diego Rmz, 13-oct-2026 12:16–12:44;
    decisión del usuario el mismo día): «`ingreso.aeronave_id` + hoja «Otros
    ingresos» en el balance por avión que SUMA al remanente y entra al
    reparto». Hasta el 0.0.74 el avión de un ingreso era «solo referencia»
    (invariante 29) y el dinero iba a VuelaTour.
    - **Regla (una vez, un mes, un lugar)**: un ingreso VIVO de RESULTADO
      (OTRO_INGRESO, INGRESO_BANCARIO, REEMBOLSO_DEVOLUCION, VENTA_ACTIVO)
      con `aeronave_id` cuenta UNA vez, en el mes de `ingreso.fecha` (DATE,
      día Cancún), para ESE avión — y deja de ser ingreso de VuelaTour.
      Anticipos y aportaciones JAMÁS llevan avión: CHECK
      `ingreso_aeronave_chk` + 400 `AVION_SOLO_EN_RESULTADO` («Un anticipo o
      una aportación no se asigna a un avión: el avión solo aplica a
      ingresos que suman a resultados (otros ingresos, intereses, reembolsos
      y ventas).»), validado sobre el estado FUSIONADO (alta y PATCH:
      reclasificar a anticipo/aportación con el avión vigente ⇒ 400; el panel
      manda `aeronave_id: null` al reclasificar) y antes de escribir o subir
      nada; el 23514 del CHECK sale con el MISMO code (`CHECK_A_CODE`).
    - **Fuentes únicas (PURAS, con spec)**: `common/categoria-ingreso.util`
      — `categoriaIngresoAdmiteAvion` (≡ `categoriaIngresoSumaAResultados`,
      espejo del CHECK), `DestinoIngreso`, `destinoIngreso`,
      `destinoIngresoAvion`, `textoDestinoIngreso` (el panel copia los 5 con
      los MISMOS nombres y textos; las tablas LABEL/DESTINO/AYUDA NO
      cambiaron); `common/ingreso-resultado.util` — `partirIngresosPorAvion`
      (LA partición: su avión XOR VuelaTour, orden del lector, lo que no es
      resultado en ningún lado), `ingresoEsDelAvion`, `netoIngresoUsd` y
      —0.0.77— `diaTcOficialIngreso` y `usdDeIngresoAvion` (la conversión
      ÚNICA, abajo) y —revisión del 14-oct-2026— `gastosLigadosDelLibro`,
      `excedenteSobreCargado` y `avisosReembolsoGasto` (el reembolso ligado,
      abajo); `aircraft/otros-ingresos-avion.util` —
      `filaHojaOtrosIngresos`, `notaTcUsdIngreso`, `hojaOtrosIngresosAvion`,
      `fusionarOtrosIngresosFlota`. Los pesos
      salen SIEMPRE de `filaLibroDeIngreso` (sin cambio): MXN directo, USD ×
      su `tc_usd_mxn` PROPIO, comisión bancaria como egreso, neto =
      remanente. `filaLibroDeIngreso`, `leerIngresosDeResultado` (lee además
      `aeronave_id`, `notas`, `cuenta:cuenta_bancaria_id(alias, banco)` y,
      desde el 0.0.77, `gasto_id`) y
      `buildHoja` no cambiaron de comportamiento. Prohibido reimplementar la
      partición en un lector.
    - **Dónde SÍ cuenta**: (1) hoja «Otros ingresos» del libro de su avión
      (`otros_ingresos_avion` = `{filas, total_mxn, usd, usd_por_ingreso:
      true}` —la bandera desde el 0.0.77, ÚLTIMA llave, SIEMPRE—; fila
      `{ingreso_id, clave, fecha, categoria (etiqueta), detalle (clave ·
      descripción · cliente|pagador · vuelo #n), moneda_original,
      monto_original, tc_aplicado (USD: el T.C. EXACTO; MXN: null),
      ingreso_mxn, comision_mxn, neto_mxn, cuenta ('alias · banco' |
      'Efectivo / caja'), notas, tc_usd, neto_usd, tc_usd_origen ('PROPIO' |
      'GASTO_LIGADO' | 'OFICIAL_DEL_DIA'), tc_usd_nota}` —las cuatro
      últimas ADITIVAS del 0.0.77: `tc_usd` = el T.C. EXACTO que dividió
      (USD: null), `neto_usd` = el USD de la conversión ÚNICA y
      `tc_usd_nota` = `notaTcUsdIngreso` (OFICIAL_DEL_DIA ⇒ «T.C. oficial de
      referencia del día del ingreso (open.er-api, dato del 2026-09-04): el
      ingreso en pesos no traía tipo de cambio.»; GASTO_LIGADO ⇒ «T.C. con el
      que este libro convierte el gasto que reembolsa (gasto 70e8c3a4 del
      15-sep-2026, T.C. promedio de las hojas): reembolso y gasto se anulan
      en este libro.» si el NETO del reembolso es lo que el libro le carga
      al avión de ese gasto (±0.005); menos ⇒ «…: el reembolso anula $1,000
      MXN de los $1,365.64 MXN que este libro le carga al avión de ese
      gasto.»; más ⇒ «…: este libro solo le carga $1,365.64 MXN de ese gasto
      al avión; los $559.63 MXN restantes del reembolso no se anulan con
      nada.» —revisión del 14-oct-2026, `notaTcUsdIngreso(conv, netoMxn)`—;
      PROPIO o USD ⇒ null)—);
      (2) la línea «(+) OTROS INGRESOS USD» que SUMA en la cascada
      (`balance.otros_ingresos_avion_usd` = hoja.usd; `utilidad_despues_usd`
      = round2(antes − combustible − indirectos − refacciones − otros −
      permisos + otros ingresos), null se propaga) ⇒ utilidad cobrada ⇒
      socios ⇒ participación de la empresa en el bloque VUELATOUR; (3) el
      reparto (`computeAvion`: `ingresos.otros_ingresos_avion_usd` SUMA a
      `saldo_disponible_usd`, NO se mezcla con `cobrado_usd`) ⇒ utilidades
      por mes, cuenta corriente y dashboards; (4) Libro Dinero: lista APARTE
      `otros_ingresos_avion` (misma fila + `matricula`/`avion_color`, solo con
      filas) y la columna `utilidades_aviones[].otros_ingresos_mxn` = Σ
      remanente (llave solo con dato; un avión con solo ingresos entra con
      las otras 4 en null).
    - **Dónde NO**: «otros movimientos» del general (las sueltas ING-n son
      solo las de VuelaTour; bandera `otros_ingresos_por_avion: true`), el
      bloque VUELATOUR (empresa) —`ingresos_propios_usd` los excluye por
      construcción— y `utilidades_otros_ingresos_mxn` / TOTALES de «Otros
      ingresos» del Libro Dinero (ni su ingreso ni su comisión). CRUCE con
      spec: Σ remanente ING del Libro Dinero (las dos listas) == Σ sueltas
      ING del general + Σ `aviones[].otros_ingresos_avion.total_mxn`.
    - **Conversión ÚNICA del ingreso de un avión (decisión del cliente del
      14-oct-2026: «hazlo, si es lo mejor hazlo»; API 0.0.77)**: balance,
      reparto y tablero convierten CADA ingreso con la MISMA función pura
      `usdDeIngresoAvion(i, {oficialDelDia, gastoLigado})`
      (`common/ingreso-resultado.util`): USD ⇒ su neto (monto − comisión)
      tal cual; MXN ⇒ neto ÷ (T.C. propio ?? T.C. del gasto LIGADO ?? oficial
      del día de su `fecha`); cada usd a centavos y total = round2(Σ). El día
      lo decide `diaTcOficialIngreso` (solo MXN sin T.C. propio y con una
      `fecha` AAAA-MM-DD válida) y el oficial sale de la única puerta
      `TipoCambioService.oficialDetallePara` (balance: `tcOficialDeDias` con
      su memo por día, compartido por todo el general —un día, una
      consulta—; reparto: `resolverTcOficial`, mismo lote de vuelos y
      gastos). **Reembolso LIGADO** (REEMBOLSO_DEVOLUCION en pesos con
      `gasto_id` de un gasto en pesos que ESE libro le CARGA al avión): se
      convierte con el T.C. con el que ESE libro convierte su gasto —balance:
      el T.C. de costos de la fila de su vuelo (`tc_costos ?? tcPromedio`,
      el divisor de `ganancia_usd`; los vínculos 'suma' de la fila) o
      `tcHojas` si vive en una hoja; reparto: `tc_gasto ?? oficial del día
      del gasto` (el divisor de `toUsd`, solo gastos que restan: grupo ≠
      EXCLUIDO)— para que reembolso y gasto se anulen EXACTOS en cada libro
      (revisión del 14-oct-2026: con la regla por ingreso un reembolso exacto
      del gasto 70e8c3a4 dejaba +45.12 USD en el balance y +27.15 en el
      reparto que no existen en pesos); su USD puede diferir entre libros
      igual que el de su gasto. **Lo CARGADO, no solo el T.C. (segunda
      revisión del 14-oct-2026)**: la fuente única `gastosLigadosDelLibro`
      (PURA, la usan los DOS libros) arma por gasto el divisor Y
      `cargado_mxn` = Σ de las partes que RESTAN en la utilidad del avión
      —balance: los vínculos 'suma' (su `monto_mxn`: la parte op/FBO, no la
      TUA ni la extensión) SOLO de filas con `ganancia_usd` (una fila sin
      parte en la venta, factor 0, no resta sus gastos) + las filas de sus
      hojas (un parcial del reparto, su parte); reparto: `monto − TUA −
      extensión` de cada parte que resta—; Σ ≤ 0 ⇒ el gasto NO entra (el
      avión no lo carga) y `usdDeIngresoAvion` exige `cargado_mxn > 0` (un
      `divisor` distinto entre partes, imposible por construcción, se pondera
      para que lo cargado se anule igual). Caso #192 (8ab208c4, extensión
      completa): ya no se «liga» en el reparto (antes ÷ 16.8925 = +269.29 USD
      a los socios) y los DOS libros usan el oficial del día del reembolso.
      `avisosReembolsoGasto` (textos ÚNICOS: balance = un pendiente con el
      prefijo de la hoja; reparto = `tc_aviso` de la línea, unidos con « · »)
      dice cuándo NO se anula: el libro no le carga el gasto ⇒ «ING-7
      reembolsa un gasto que este libro no le carga al avión (otro mes, otro
      avión u otra moneda, o un traslado, un gasto de VuelaTour o un tramo
      sin venta): se convirtió con el T.C. oficial de su día y no se anula
      con su gasto» (o «con su T.C. propio»); T.C. PROPIO (manda, captura
      explícita) que no da el mismo centavo que el divisor del libro ⇒ «ING-7
      trae T.C. propio (17.5000) y este libro convierte el gasto que
      reembolsa con 17.2377 (T.C. promedio de las hojas): reembolso y gasto
      no se anulan exactos»; el reembolso EXCEDE lo cargado (> 0.005; caso
      #383, 8c60e428: 1,925.27 = operación 1,365.64 + TUA 559.63) ⇒ «ING-7
      reembolsa $1,925.27 MXN de un gasto del que este libro solo le carga
      $1,365.64 MXN al avión: $559.63 MXN no se anulan con nada y suman al
      avión — si esa parte no es suya, corrige el monto o el avión del
      ingreso» (el reembolso entero sigue contando para el avión: lo decide
      el `aeronave_id` de la oficina; un reembolso MENOR que lo cargado es
      legítimo y no avisa). NO se bloquea en Ingresos un reembolso de un
      gasto que el avión no carga: decidirlo exigiría repetir la regla de
      cada libro en la escritura (cálculo paralelo). El
      balance YA NO divide la hoja entre `tcHojas` y los ingresos YA NO
      cuentan para el respaldo «avión sin vuelos» (con gastos E ingresos el
      pendiente dice «sus hojas de gastos se convirtieron a USD con el T.C.
      oficial de referencia del {día} ({tc}, {fuente}) y cada uno de sus
      otros ingresos con su T.C. propio o el oficial de su día; la utilidad
      del periodo es el resultado de esos movimientos»; solo gastos, el
      texto de siempre byte a byte; solo ingresos, sin respaldo ni
      pendiente). Sin T.C., cada libro su regla: balance ⇒ fila sin NETO
      USD, hoja `usd` null, utilidad vacía y pendiente «… ingreso ING-n en
      pesos sin T.C. propio ni T.C. oficial de su día — fila sin USD; la
      utilidad después de gastos queda vacía»; reparto ⇒ no suma y va a
      `otros_ingresos_avion_sin_tc_mxn`. Una fila USD ya no anula la hoja por
      no tener pesos (su NETO USD sí suma; pendiente «… en USD sin tipo de
      cambio — fila sin monto MXN (su NETO USD sí suma)»). ING-4 (N990GG,
      $46,550.80 del 4-sep, oficial 16.9479, sin gasto ligado) = 2,746.70
      USD en los tres (antes el balance daba 2,710.47 = ÷ 17.17442; +36.23
      en N990GG sep-2026: +18.48 Angel Alvarez, +17.75 Aero Charter).
      Reasignar un ingreso sin gasto ligado ya no cambia su USD. Reparto,
      cuenta corriente, tablero y Libro Dinero NO cambian (el reparto solo
      se refactoriza; 0 ingresos con `gasto_id` al 14-oct-2026). Los GASTOS
      siguen con dos T.C. por diseño (hojas al promedio del libro, como el
      Excel del cliente; reparto gasto por gasto). La etiqueta de la fuente
      sale de `common/fuente-tc-oficial.util#fuenteTcLegible` (PURA;
      `TipoCambioService` la re-exporta): el util de la hoja NO importa el
      servicio, que los specs sustituyen con `jest.mock`.
    - **Presencia de llaves (todo ADITIVO; skew en los dos sentidos)**: hoja
      y línea SIEMPRE en los libros de avión (individual y `aviones[]`; vacía
      `{filas: [], total_mxn: 0, usd: 0, usd_por_ingreso: true}`, también
      EXTERNOS, que no lee
      `ingreso`), como ÚLTIMAS llaves de la raíz y del bloque `balance`;
      `consolidado.otros_ingresos_avion` (hoja «otros ingresos aviones») SOLO
      con filas, ÚLTIMA llave, detalle «MATRÍCULA · …», usd = round2(Σ) con
      null que se PROPAGA y `usd_por_ingreso: true` (0.0.77; las filas llevan
      las cuatro llaves del 0.0.77 antes de `matricula`/`avion_color`);
      `otros_movimientos.otros_ingresos_por_avion: true`
      SIEMPRE, tras `comision_vendedor_solo_gasto_real` y antes de
      `afac_en_filas`; Libro Dinero solo con dato; reparto SIEMPRE (0 / [] en
      `ingresos` y `detalle.otros_ingresos_avion`, cuya línea gana
      `tc_origen` y —revisión del 14-oct-2026— `tc_aviso` (string | null) AL
      FINAL desde el 0.0.77 —el PDF/XLSX del reparto no los lleva—),
      `tc_oficial.ingresos`
      `{count, monto_mxn}` y el payload del PDF/XLSX por avión con
      `otros_ingresos_avion_usd`, `otros_ingresos_avion_sin_tc_mxn` y
      `otros_ingresos_avion` (`saldo_usd` YA lo incluye). El general LEE
      `ingreso` UNA vez (`payloadGeneral` pasa la partición a cada
      `buildPayload` —7.º parámetro opcional— y a `buildOtrosMovimientos` —8.º
      opcional, sin él se lee y se parte ahí—); un avión con solo un ingreso
      entra al general (`tieneActividad`). Sin ingresos con avión: libros,
      pestaña y reparto byte a byte salvo esas llaves (specs con
      `diferencias`).
    - **API de Ingresos (ADITIVO)**: `Ingreso.destino` ('AVION' |
      'VUELATOUR' | 'FUERA_DE_RESULTADOS') y `destino_etiqueta`
      (`textoDestinoIngreso`: «Otros ingresos del avión N990GG (balance del
      avión y reparto a socios)»); columna «Destino» del Excel = ese texto
      («Matrícula» se queda); `GET /v1/ingresos?aeronave_id=`; `avisos[]` al
      dar de alta o cambiar el avión («Este ingreso cuenta para el avión
      {matrícula}: entra a la hoja «Otros ingresos» de su balance y a su
      reparto a socios; ya no cuenta como ingreso de VuelaTour.») y al
      quitarlo de un ingreso de resultado («Este ingreso ya no cuenta para
      ningún avión: vuelve a ser ingreso de VuelaTour (Balance general y
      Libro Dinero).»). Textos ÚNICOS del API en `ingresos/ingresos.util`.
      **`aeronave_id` se cambia aunque el ingreso esté conciliado** (es
      asignación, no dinero del banco: ni el 409 `INGRESO_CONCILIADO` ni
      `tg_ingreso_candados` lo vigilan; `tg_ingreso_bitacora` lo registra).
    - **Avión dado de baja (XB-IJP)**: el reparto computa SOLO aviones
      activos: su ingreso sale en su libro, en el general y en el Libro
      Dinero, pero en NINGÚN reparto (el panel lo marca «Dado de baja: cuenta
      en su balance, no en el reparto» al elegirlo, sin deshabilitarlo).
    - **Dashboards** (`overview`, invariante 50): `ingresos_cobrados_usd`
      sigue siendo SOLO la venta; aparte `resumen.otros_ingresos_aviones_usd`
      y `por_avion[].otros_ingresos_avion_usd` (ÚLTIMAS llaves) con la
      identidad `ingresos_cobrados_usd + otros_ingresos_aviones_usd −
      gastos_totales_usd == saldo_disponible_usd`, por avión y en el resumen.
    - **Pendiente (punto 5 del lote)**: el vínculo celda → registro
      `{tipo:'ingreso'}` de la hoja «Otros ingresos» NO se anota aún; el
      `ingreso_id` ya viaja por fila.
    - **Efecto RETROACTIVO en septiembre 2026 (PASO 0 BLOQUEANTE antes del
      push del API)**: ING-4 (N990GG, REEMBOLSO_DEVOLUCION, $46,550.80 MXN,
      4-sep, conciliado, pagador «angel alvarez» = socio al 51 % de N990GG;
      notas «reembolso del pago del serv de 50 hrs en toledo, fact 53») sale
      de «otros movimientos», del bloque VUELATOUR y de OTROS INGRESOS del
      Libro Dinero y entra a la hoja, la cascada y el reparto de N990GG (51 %
      Angel Alvarez / 49 % Aero Charter): VuelaTour baja y el avión y sus
      socios suben. OJO: el único «Servicio 50hrs … Toledo» de jun–oct es de
      N4142R ($45,483.60, 15-sep): la oficina confirma ING-4 en el panel
      ACTUAL antes del deploy (es de N990GG ⇒ nada; de otro avión o de
      VuelaTour ⇒ Editar → Avión). `reparto_pago` tiene 0 filas (ningún
      snapshot de entregas queda inconsistente). La cuenta corriente lo ve en
      ≤ 10 min (memo de utilidades mensuales).
    - **Deploy**: pyservices (tolera la ausencia de todas las llaves) → API
      0.0.75 → migración `20261013000005` (recomendada DESPUÉS del API: así el
      23514 llega traducido; antes también es seguro: hoy ningún anticipo
      lleva avión) → panel (único que ofrece el selector nuevo). Si el API
      sale antes que pyservices los números quedan correctos pero sin la
      pestaña ni la línea (UTILIDAD DESPUÉS como valor): subir pyservices de
      inmediato. Flutter: sin cambio. **0.0.77** (conversión única):
      pyservices (bandera `usd_por_ingreso`) ⇒ COMPUERTA del deployment
      ACTIVO (invariante 49) ⇒ API; rollback primero el API (con el API
      0.0.77 y un pyservices viejo la C5 vieja evalúa ÷ el promedio y
      `finalizar` la deja como VALOR: números correctos, pero B5 y tres
      notas desfasadas).
    - Specs: `categoria-ingreso.util.spec` (los 5 exports, membresía,
      literales, sin «Otros ingresos VuelaTour»), `ingreso-resultado.util.spec`
      (mapeo de los campos nuevos —`gasto_id` desde el 0.0.77—, fila
      byte-idéntica, partición, neto USD, `diaTcOficialIngreso` y
      `usdDeIngresoAvion` con las cifras reales: 2,746.70 / 2,660.05 /
      2,638.61; `cargado_mxn` 0 ⇒ jamás ligado; `gastosLigadosDelLibro`,
      `excedenteSobreCargado` y `avisosReembolsoGasto` con #192 y #383
      reales, T.C. propio y los textos LITERALES),
      `otros-ingresos-avion.util.spec` (fila ING-4 literal con las cuatro
      llaves del 0.0.77 —16.9479 ⇒ 2,746.70—, `notaTcUsdIngreso` igual /
      parcial / de más, USD con comisión, sin T.C., ligado y no ligado con
      sus pendientes literales —T.C. propio con el gasto en el libro y
      exceso de lo cargado—, vacía con la bandera, fusión con orden estable
      y null que se propaga),
      `aircraft-balance.service.otros-ingresos-avion.spec`
      (individual 2,586.16 con el oficial 18 del día del ingreso —el libro
      promedia 20—, cascada y socios, `diferencias` acotadas, ajenos y
      anticipo forzado fuera, EXTERNOS sin leer `ingreso`, avión sin vuelos:
      oficial de SU día y sin respaldo; con gastos e ingreso, el pendiente
      nuevo; general con UNA lectura, sueltas,
      consolidado, bandera, bloque VUELATOUR y el CRUCE con el Libro Dinero),
      `aircraft-balance.service.ingresos.spec` (sueltas idénticas con un
      ingreso de avión; delta 6,800), goldens de «otros movimientos» con la
      bandera (fixture `libros-pago-vendedor`, ingresos, comisiones,
      comisiones-general, afac-om), `dinero-report.service.ingresos.spec`
      (lista aparte, utilidades sin moverse, columna por avión, USD 33,250,
      golden intacto), `profit-sharing.service.otros-ingresos-avion.spec`
      (oficial 18 ⇒ 2,586.16, T.C. propio, USD neto, sin T.C., ajenos,
      `q.aeronave_id`, sin ingresos/sin migración idénticos, un día = una
      consulta, payload del PDF y utilidades por mes; `tc_origen` y el
      reembolso LIGADO con `tc_gasto` y con el oficial del día del gasto;
      `tc_aviso` null por lo cargado y el aviso del exceso),
      `aircraft-balance.service.ingreso-conversion-unica.spec` (0.0.77,
      CRUCE: ING-4 = 2,746.70 en balance, reparto y tablero con un libro que
      promedia 20; USD 970 en los tres; avión sin vuelos; una consulta del
      oficial por día en el general; reembolso ligado a un gasto de hoja, de
      la fila de un vuelo y de otro mes; revisión del 14-oct-2026: extensión
      completa del #501 ⇒ oficial en los TRES con pendiente y `tc_aviso`,
      TUA de oficina ⇒ ligado por lo CARGADO con el aviso del exceso en los
      dos libros y +25 USD exactos en el balance, gasto de un tramo cancelado
      de otro avión ⇒ el balance no lo liga y el reparto sí),
      `dashboards.service.overview-otros-ingresos.spec` (identidad al
      centavo), `ingresos.service.spec` / `ingresos.util.spec` /
      `ingresos-xlsx.spec` (201 con aviso, 400 en alta y PATCH, conciliado
      200, quitar avión, CHECK ⇒ 400, `?aeronave_id`, destinos, literales,
      «Destino»). Migración ensayada en PGlite (14-oct-2026) con el esquema
      REAL de `ingreso` y sus 3 triggers: `DRYRUN_OK` sin residuos, cuerpo
      idempotente, CHECK validado, anticipo/aportación con avión ⇒ 23514
      `ingreso_aeronave_chk`, cambio de avión de un conciliado con su
      bitácora, dry-run sobre la aplicada ⇒ `DRYRUN_FALLA A`.

68. **ID DE VUELO POR CLIENTE JUNTO AL FOLIO (13-oct-2026, API 0.0.75,
    migración `20261013000006_vuelo_id_cliente`; decisión 6 del lote del
    13-oct-2026).** Cada vuelo muestra, JUNTO a su folio (nunca en su
    lugar), un ID por cliente «january02-211026».
    - **Forma**: alias del cliente + número de vuelo de ESE cliente con 2
      dígitos mínimo (100 ⇒ «diego100») + '-' + DDMMAA del DÍA CANCÚN de
      `fecha_vuelo` (03:30Z del 14 ⇒ «…-131026»); sin fecha, sin sufijo.
      Prod: #364 «beh05-011026», #376 «january02-211026», #166 (sin fecha)
      «francisco10», #115 cancelado «riviera02-050826» y su clon #117
      «riviera03-050826».
    - **BD, alias**: `cliente.alias` text NOT NULL, CHECK `cliente_alias_chk`
      `^[a-z]{1,24}$`, **NO único** (9 grupos repetidos en prod: juan ×4,
      victor ×3…; el panel avisa). Default por `trg_cliente_alias_default`
      (BEFORE INSERT OR UPDATE OF alias) = `public.cliente_alias_default(nombre)`:
      primera palabra, sin acentos (translate de 50 caracteres, espejo
      EXACTO de `aliasSugerido` del panel), minúsculas, solo a-z, máx. 24;
      vacío ⇒ 'cliente'. null o '' ⇒ se recalcula del nombre ACTUAL;
      cualquier otro valor ⇒ `lower(btrim(valor))`. **Renombrar NO toca el
      alias.**
    - **BD, contador y número**: `cliente_consecutivo_vuelo (cliente_id PK →
      cliente, ultimo ≥ 0, updated_at)` con RLS SIN políticas (invariante
      51; solo lo usa el trigger, el API nunca lo lee ni lo escribe).
      `vuelo.consecutivo_cliente` integer NOT NULL ≥ 1, UNIQUE
      `uq_vuelo_cliente_consecutivo (cliente_id, consecutivo_cliente)`; lo
      asigna SOLO `vuelo_consecutivo_cliente` (BEFORE INSERT OR UPDATE OF
      cliente_id, consecutivo_cliente; SECURITY DEFINER, patrón
      `calendar_sync_encolar`, para que un escritor que no sea service_role
      no falle por la RLS sin políticas; `search_path ''`). Alta ⇒ siguiente
      del contador AUNQUE el payload traiga otro valor (el clon de
      `reassignAircraft` toma número NUEVO; además `consecutivo_cliente`
      está en `CAMPOS_NO_CLONABLES`). Cambio de `cliente_id` ⇒ siguiente
      del cliente nuevo (el contador anterior no baja). Editarlo ⇒ 23514
      `CONSECUTIVO_CLIENTE_INMUTABLE: el número del vuelo #<folio> dentro de
      su cliente se asigna al crear y no se edita`. **Nunca se reutiliza**:
      borrar o compensar un alta deja hueco; un alta RECHAZADA no gasta
      número (su +1 se revierte con ella). Cotizaciones, reservas,
      cancelados, cada avión de un grupo y el clon de un cambio de avión
      CONSUMEN número (el Libro Dinero mostrará huecos: es la decisión).
      Histórico por `(fecha_vuelo asc nulls last, folio)` (75 vuelos de 13
      clientes quedan en orden distinto al del folio); desde la migración,
      por orden de captura. **NO renombrar el trigger a «trg_…»**: corre
      DESPUÉS de `trg_vuelo_set_updated_at` (los BEFORE van por orden
      alfabético) a propósito, para que el llenado conserve
      `vuelo.updated_at` (cero 409 CONFLICTO_VERSION falsos en la app).
      **La FK del contador no tiene cláusula de borrado** (el MCP filtra la
      palabra): fusionar o borrar físicamente un cliente con contador exige
      mover o borrar ANTES su fila del contador (SQL Editor, con
      confirmación del usuario).
    - **Fuentes únicas**: `common/clave-cliente.util.ts` (PURA: `ALIAS_REGEX`
      y `MENSAJE_ALIAS_INVALIDO` —mismos literales que el CHECK y que
      `src/lib/admin/clave-cliente.ts` del panel, cuyo vitest los compara—,
      `normalizarAliasEntrada`, `ddmmaaCancun`, `claveCliente`,
      `parseBusquedaClave`, `claveLibro`, `claveOtrosMovimientos`,
      `claveDinero`); `common/clave-cliente-lectura.util.ts` (el ÚNICO que
      lee `consecutivo_cliente` y `cliente.alias` para armar o buscar IDs:
      `clavesClienteDeVuelos` en lotes de 150 en paralelo y
      `vueloIdsPorClaveCliente`; best-effort, TODO O NADA por llamada,
      NUNCA lanza —un fallo es `warn` y vacío—); `common/id-cliente-disponible.util.ts`
      (sonda `columnaOpcional` de `vuelo.consecutivo_cliente`,
      `MIGRACION_ID_CLIENTE`, 503 `ID_CLIENTE_NO_DISPONIBLE`). **REGLA DURA
      de la sonda**: todo select, insert, update, filtro o embed que nombre
      `consecutivo_cliente`, `cliente.alias` o `cliente_consecutivo_vuelo` va
      detrás de `await idClienteDisponible(sb)` (el «sí» se memoriza para
      siempre: tras la reversa hay que REINICIAR el API). `VUELO_COLS` de
      flights y quotes NO lleva las columnas (se usan en escrituras y en
      `insert().select()`); el `.or()` de la búsqueda JAMÁS las nombra.
    - **Se calcula al LEER y no se guarda**: cambiar el alias o reprogramar
      el vuelo re-etiqueta TODOS sus vuelos (un Excel ya enviado conserva la
      etiqueta vieja). El FOLIO sigue siendo la llave del dinero (cobros,
      gastos, facturas, conciliación, bitácoras, flechas, reparto, PDFs):
      el ID es una etiqueta. Panel, pyservices y app NUNCA lo recalculan.
    - **Superficies (todo ADITIVO; sin la migración responde como el
      0.0.74)**: `GET /v1/flights` (cada fila, AL FINAL tras `servicio`,
      SIEMPRE presente; también a PILOTO/MECANICO) y `/flights/:id/snapshot`
      (tras `cliente_razon_social`) ⇒ `clave_cliente: string|null`; `GET
      /v1/quotes` (filas, al final) y `GET /v1/quotes/:id` (se arma en
      `detalle()`, `findById` no cambia) ⇒ `clave_cliente`. `?q=` de
      cotizaciones y de `/vecinos`: si `q.trim()` cumple
      `/^([a-z]{1,24})([0-9]{1,4})(-[0-9]{6})?$/i` con número ≥ 1, se SUMA
      `id.in.(ids)` (clientes con ese alias ≤ 50 ⇒ sus vuelos con ese número
      ≤ 50, en consultas aparte; la fecha escrita se IGNORA: un vuelo
      reprogramado se encuentra con su ID viejo); cualquier otro `q` hace
      las consultas de siempre. `/v1/clients`: `alias_disponible: boolean`
      al FINAL de la lista (true solo con la migración); con la migración
      cada fila (lista, `:id`, POST, PATCH) += `alias` y
      `alias_compartido_con` (nombres recortados de OTROS clientes con el
      mismo alias —activos e inactivos, todo el catálogo—, orden es-MX,
      máx. 5; [] si nadie; **null si no se pudo leer: jamás un [] falso**) y
      `q` busca también en el alias. Body de POST/PATCH: `alias?: string |
      null` (trim + minúsculas, '' ⇒ null; null = volver al sugerido; 400
      class-validator con `MENSAJE_ALIAS_INVALIDO` «Alias inválido: usa de 1
      a 24 letras minúsculas, sin acentos, espacios, números ni signos (ej.
      diego).»; 23514 de `cliente_alias_chk` ⇒ 400 `ALIAS_INVALIDO`; alias
      definido —aunque sea null— sin la migración ⇒ 503
      `ID_CLIENTE_NO_DISPONIBLE` ANTES de escribir; OJO: con target ES2022
      la clase DTO define TODAS sus llaves en undefined, así que el servicio
      decide por VALOR, nunca por presencia). Ruta NUEVA `GET
      /v1/clients/alias-en-uso?alias=&excluir=` (ADMIN y COORDINADOR,
      declarada ANTES de `:id`) ⇒ `{alias, clientes: [{id, nombre,
      activo}]}` por nombre, sin el excluido; 400 alias inválido o excluir
      no-uuid; 503 sin la migración. **Libros** (solo etiquetas; ningún
      importe, T.C., partición ni total cambia): maestra y cobranza
      `claveLibro` «#364 · beh05-011026 · Beh Kay » (libro individual,
      `aviones[]` del general, EXTERNOS y, por el spread, el consolidado
      FLOTA; la nota de la fila «AFAC · matrícula» cita esa CLAVE); «otros
      movimientos» `claveOtrosMovimientos` «#364 · beh05-011026» (sin ID el
      legado «vtbeh364»; también tras `colapsarFilasDeVuelo`); Libro Dinero
      `claveDinero` «beh05-011026» (+ « (50 % N4142R)» en multi-avión; un
      vuelo de SERVICIO siempre «vtservicio»; sin ID «vtbeh») en dinero-vlos
      y en las CUATRO filas «Otros ingresos» del vuelo (ING-n sin cambio).
      `clave_cliente` viaja a pyservices SOLO con valor (última llave de la
      fila del libro y de la de Dinero; en «otros movimientos», en la base
      de la fila): pyservices no la pinta, solo ensancha la columna A por
      contenido con tope (48 balances / 40 Dinero). **Sin ID, cada libro
      sale byte a byte como el 0.0.74** (lector vacío ⇒ ninguna llave).
      Costo: a lo más UNA lectura de claves por cada 150 vuelos de cada
      libro/lista, en paralelo; `alias_compartido_con` una consulta por
      llamada a `/v1/clients`.
    - **Lo que NO cambia**: `findById` de vuelos y cotizaciones, POST
      reserva/externo/clon, PATCH de vuelos, `QuoteVecino`, PDFs, reparto,
      pre-cierre, conciliación, facturas, Google Calendar (ninguna columna
      nueva está en `trg_vuelo_calendar_sync` ni en
      `trg_cliente_calendar_fanout`) y la app (lee por llave y sigue
      mostrando «#376»; el delta `updated_since` no se entera de un cambio
      de alias porque no mueve `vuelo.updated_at`).
    - **Deploy**: migración (cualquier momento: el API la sondea; con el
      0.0.74 los triggers numeran y ponen el alias en silencio) →
      pyservices (antes que el API, para no ver la CLAVE cortada en la
      columna A de 16) → API 0.0.75 → panel. Si el API sale antes que la
      migración no hay ningún 500: `clave_cliente` null,
      `alias_disponible: false` y todo aparece solo ≤ 10 min después de
      aplicarla. Flutter: sin cambio.
    - Specs: `clave-cliente.util.spec` (regex, mensaje, normalizar, día
      Cancún, IDs de prod, búsqueda, plantilla de siempre con ID null,
      'vtservicio'), `id-cliente-disponible.util.spec` (sonda, 42703 y
      PGRST204, 503 exacto), `clave-cliente-lectura.util.spec` (sin ids = 0
      consultas, sonda 42703, lotes 150+1, embed objeto/arreglo, todo o
      nada, sin `.from`, búsqueda), `clients.service.spec` (con y sin
      migración, `alias_compartido_con` es-MX/máx. 5/null si falla, 503 sin
      escribir, 23514), `clients.controller.alias.spec` (roles, orden de
      rutas, DTO y HTTP con el ValidationPipe de main.ts),
      `flights.service.clave-cliente.spec` (list una lectura por página,
      PILOTO con redacción, snapshot, `findById` sin lector),
      `clon-vuelo.util.spec` (`consecutivo_cliente` no clonable),
      `quotes.service.clave-cliente.spec` (lista/detalle, búsqueda por ID,
      sin migración, cero consultas nuevas sin forma de ID, paridad con
      `/vecinos`), `quotes.service.seguimiento.spec` (ajustado:
      `clave_cliente: null`), `aircraft-balance.service.clave-cliente.spec`
      (maestra, general, FLOTA, multi-avión, otros movimientos colapsada,
      AFAC, sin ID sin llaves e importes idénticos) y
      `dinero-report.service.clave-cliente.spec` (ID, sufijo multi-avión,
      'vtservicio', otros ingresos, golden sin ID, totales idénticos). La
      migración se ensayó en PGlite (13 y 14-oct-2026) con el esquema y los
      triggers REALES de prod: `DRYRUN_OK C1–C12` sin residuos, idempotente,
      `DRYRUN_FALLA A` sobre la aplicada, §4 aborta con un contador
      atrasado, `updated_at` y la cola de Google intactos.

69. **CONCEPTO DEL SPEI: SE COMPLETA AL RE-SUBIR Y «Factura NNNN» EN
    CONCILIACIÓN (13-oct-2026, lote 2, API 0.0.75, SIN migración).** Caso
    real (VIP SAESA): los SPEI de septiembre se importaron con la IA leyendo
    SOLO el renglón principal («SEL TRANSF. INTERBANCARIA SPEI»): de 98 filas
    de EJE SCOTIA, 73 son leyendas sin concepto (39 «SEL TRANSF.
    INTERBANCARIA SPEI», 30 «TRANSF INTERBANCARIA SPEI», 2 «03 POR COBRANZA
    DOMICILIADA», 1 «SEL PAGO DE SERVICIOS», 1 «SCN Pagos a Proveedores») y
    en GASTOS GNRAL 14 del 24-sep; el concepto («… BANORTE fact vip 7360»)
    es lo que dice QUÉ factura pagó cada una. Premisa corregida: re-subir el
    PDF con el prompt nuevo de pyservices (renglones de continuación) NO
    duplica —el dedupe ya tolera el prefijo— pero tampoco completaba nada.
    Datos verificados el 13-oct (solo SELECT): 0 filas con `orden_archivo`,
    0 con vínculo no bancario, todas IMPORTADO; los 29 «Pago VIP SAESA» están
    conciliados como TRANSFERENCIA sin folio ni factura; los 5 SPEI de SAESA
    del 12-oct (fact vip 7349, 7352, 7357, 7359 y 7360) traen concepto y
    siguen sin conciliar; las 3 «pre factura corner» tienen una factura
    recibida con ESE número (4409, 4480, 4481).
    - **La referencia NO veta el dedupe** (invariante 7): reabriría el
      incidente del 29-sep (los SPEI traen la referencia de relleno
      «00000000000000000001»). Solo desempata gemelos (regla REFERENCIA).
    - **Fuente única PURA `conciliacion/enriquecer-descripcion.util.ts`**
      (`planEnriquecimiento` y sus constantes). Solo se completan las
      LEYENDAS de la lista blanca `LEYENDAS_SIN_CONCEPTO` (las 6 de prod +
      CGO SPEI, SPEI ENVIADO, SPEI RECIBIDO), NO «cualquier prefijo» (con un
      prefijo genérico «ASA CANCUN» recibiría el texto de «ASA CANCUN I»), y
      se mide con `normalizarPlano`, NUNCA con `descDedupe` (quita «SEL» y
      «SPEI»). Por bucket (fecha|tipo|monto) y leyenda T: G = previas con
      texto T; L = líneas con texto T o que lo extienden (menos las que el
      dedupe emparejó FUERA de G); C = las que lo extienden; K = las iguales.
      Reglas, EN ORDEN: INTERCAMBIABLES (toda G virgen: indistinguibles;
      UNICO si G y C son de uno), UNICO, MISMO_TEXTO, REFERENCIA (pares de
      nivel 0 con referencias distintas en G y en L), ORDEN_ARCHIVO (gemelos
      de UN mismo archivo con dirección conocida del viejo y del nuevo; se
      empareja por rango y cada pareja debe seguir siendo la misma línea
      para `nivelEmpateDedupe`) y FOLIO (el número de la factura del gasto
      ligado: un ÚNICO emparejamiento perfecto, ≤ 7 gemelos). **No adivina**:
      si ninguna regla decide, GEMELOS con sus ids, conceptos (≤ 5) y
      facturas — el resumen dice qué facturas pagó el par y se coteja en el
      portal del banco. Candado extra (revisión del lote 2): fuera de
      INTERCAMBIABLES y REFERENCIA (que asignan las parejas del dedupe tal
      cual) una regla solo aplica si TODA línea que completa es duplicado de
      una fila del grupo: una línea que además se va a INSERTAR jamás presta
      su texto a otra fila. Una fila MANUAL nunca se toca; una con vínculo no
      bancario (invariante 48: su nota cita la leyenda) tampoco ⇒
      VINCULO_NO_BANCARIO. Idempotente: una fila ya completada deja de ser
      leyenda.
    - **`emparejarDuplicados` devuelve además `parejas`** ({nuevo, previo,
      nivel}, índices de los arreglos recibidos, ordenadas por línea) con el
      MISMO predicado (`parejas.length === duplicados`; el espejo SQL
      20260929000001 no cambia); `nivelEmpateDedupe` se exporta y
      `ordenarPreviosParaDedupe` da el orden determinista de las previas.
      Los previos se leen PAGINADOS por la PK (`leerPreviosDedupe`: el
      `.limit(20000)` de antes lo cortaba PostgREST en 1000 sin avisar; con
      más de 20,000 ⇒ 400 «El periodo del archivo trae más de 20,000
      movimientos previos en la cuenta: impórtalo por partes.»), con
      `estado_cuenta_id` y, detrás de sus sondas, `orden_archivo` y
      `reverso_de_id`. Lecturas SOLO cuando hacen falta y best-effort
      (`foliosParaGemelos` por la puente o el espejo; `direccionesDeArchivos`
      ≤ 5): si fallan, esos gemelos quedan GEMELOS.
    - **La escritura** (`aplicarEnriquecimiento`, secuencial): SOLO
      `descripcion` + `updated_by`, con CAS `.eq('id').eq('descripcion',
      antes).eq('origen','IMPORTADO')`; 0 filas ⇒ CAMBIO_CONCURRENTE (jamás
      pisa una edición de la oficina); un error ⇒ ERROR (≤ 200) y se sigue.
      Jamás cambia monto, fecha, tipo, referencia, notas, ligas,
      `conciliado`, `estado_cuenta_id`, `orden_archivo` ni el número de
      filas. Según `pg_trigger` (13-oct) ese UPDATE solo dispara
      `trg_movimiento_bancario_set_updated_at` (las listas `UPDATE OF` de los
      demás no incluyen `descripcion` ni `updated_by`). Las filas completadas
      NO se vuelven a cruzar (para eso está «Cruzar pendientes»).
    - **Rastro** en `conciliacion_import_job.resultados` (jsonb, ya existe):
      `enriquecidos`, `enriquecimiento_omitidos` (Σ de los movimientos que
      se quedaron sin concepto) y `enriquecimiento {estado_cuenta_id,
      detalle ≤ 300 [{movimiento_id, fecha, tipo, monto, antes, despues,
      regla}], omitidos ≤ 50 [{motivo GEMELOS | VINCULO_NO_BANCARIO |
      CAMBIO_CONCURRENTE | ERROR, fecha, tipo, monto, moneda, movimiento_ids,
      conceptos, facturas, detalle?}]}`; se escribe TAMBIÉN a medio job
      (`onProgress(24, …, parcial)`) y sobrevive si después algo truena (el
      catch no toca `resultados`). Reversión con el mismo CAS: `update
      movimiento_bancario m set descripcion = d->>'antes' from
      conciliacion_import_job j, jsonb_array_elements(j.resultados->
      'enriquecimiento'->'detalle') d where j.id = '<job>' and m.id =
      (d->>'movimiento_id')::uuid and m.descripcion = d->>'despues'`.
    - **Contrato (todo ADITIVO)**: `importar` / `importar-async` /
      `importar-status` ganan `enriquecidos`, `enriquecimiento_omitidos` y
      `enriquecimiento`; en el modo normal además `nuevos_mismo_dia_y_monto`
      + `_detalle` (≤ 20; líneas que se INSERTAN en un bucket que ya tenía
      filas: casi siempre la misma línea leída de otro modo —renglón
      reescrito, otro dígito de factura, clave de rastreo—). Cuerpo
      `solo_enriquecer?: boolean` (estricto: un «"si"» ⇒ 400; un API previo
      responde 400 «property solo_enriquecer should not exist»): no inserta,
      no cruza ni empareja reversos, archiva el PDF con
      `movimientos_importados = 0` y devuelve `solo_enriquecer: true`,
      `no_encontrados` + `_detalle` (≤ 50, con `factura`). **`POST
      importar/vista-previa`** (ADMIN, FACTURACION; 200) corre la MISMA
      preparación SIN archivar ni escribir: `{total, ya_estaban, nuevos,
      nuevos_mismo_dia_y_monto, se_enriquecen, enriquecimiento_omitidos,
      moneda, omitidos ≤ 20, nuevos_detalle ≤ 50 (+ mismo_dia_y_monto),
      enriquecibles_detalle ≤ 50}`. `ParsedStatement.advertencias?` queda
      tipado.
    - **«Factura NNNN»: fuente única PURA `conciliacion/factura-concepto.util.ts`**
      (`facturaDeConcepto`: clave FACTURA(S)/FACT(S)/FAC(S) con PRE pegado o
      separado; ventana de 6 tokens, pista ≤ 4 palabras, un mes corta, 2–8
      dígitos o serie, encadenado Y/E/,/'/'/&/-, ≤ 5 números; precisión antes
      que cobertura: «Folio 383», «COT 337» y «… F A0422 …, SPID» de HSBC USD
      NO se leen). El panel NO parsea. `GET movimientos`: cada fila que cita
      una factura gana `factura_concepto {tipo FACTURA|PREFACTURA, numeros,
      texto, pista, ligados, repetida_en}`. `ligados` = coherencia con los
      folios de SUS gastos (`estadoLigados`: COINCIDE | PARCIAL | NO_COINCIDE
      | SIN_FOLIO; null en ABONOS, sin gasto o si el lote no se pudo leer):
      el embed 1 ↔ 1 suma `notas_fc:notas` y la copia que viaja lo retira (la
      respuesta del gasto NO crece); `anotarPartes` aporta los de cada parte.
      `repetida_en` = la MISMA factura (mismo número y pistas compatibles) en
      otro movimiento del mismo tipo, en CUALQUIER cuenta a ±120 días, con
      UNA consulta por página (`ilike '%fac%'`); **null = no verificado** (la
      lectura falló o llegó a 1000 filas), [] = no se repite. Una página sin
      facturas: cero consultas y byte a byte igual. La PREFACTURA cuenta: en
      Corner su número es el folio de la factura recibida.
    - **«Vincular gasto»**: solo cuando el concepto cita una factura, cada
      candidato gana `coincide_factura` (factura recibida, `folio_ticket`,
      folio de la IA o «fact NNNN» en la 1.ª línea de las notas; folios de
      más de 8 dígitos no cuentan, son recibos SPEI) y la respuesta
      `factura_concepto {…, otros_gastos}` (gastos a ±120 días con esa
      factura que no son candidatos, forma de `excluidos` con
      `conciliado_con`; null = no se pudo leer). `coincide_factura` es una
      SEÑAL dentro de su nivel de monto (`ordenarCandidatosGasto`: cruzado →
      cuadra → coincide_factura → dMonto → dFecha): jamás brinca sobre un
      candidato que cuadra, jamás liga ni preselecciona (no exigir monto
      compatible: rompería los pagos parciales de la invariante 7), y el
      auto-cruce, «Sugerir» y «sugerir-lote» NO la usan (sin la llave).
    - **Regla del folio en transferencias** (la oficina): una factura ↔ un
      gasto ⇒ «Folio»; una factura ↔ varios gastos ⇒ «fact NNNN» en la
      PRIMERA línea de las notas de cada gasto (o amarrar la factura
      recibida a cada uno): `uq_gasto_folio_ticket_norm` es único desde 4
      caracteres y el 2.º gasto rebotaría con 409. «7352-A» se reconoce como
      7352.
    - Specs: `factura-concepto.util.spec` (los 44 casos del prototipo,
      folios, coherencia, repetidas), `enriquecer-descripcion.util.spec` (los
      20 escenarios sobre el dedupe REAL + ORDEN_ARCHIVO), `auto-cruce.util.spec`
      (cada llamada del spec verifica `parejas` en TODOS los fixtures de
      siempre; orden determinista; regresión del concepto),
      `gastos-candidatos.util.spec` (golden SAESA sin el campo),
      `conciliacion.service.enriquecer.spec` y
      `conciliacion.service.factura-concepto.spec` (PostgREST falso que
      respeta `range`, el tope de 1000 y el CAS:
      `conciliacion-postgrest.fixture-spec.ts`),
      `dto/conciliacion.dto.enriquecer.spec` y
      `conciliacion.controller.enriquecer.spec` (HTTP y roles).

70. **GASTO EN DÓLARES ↔ CARGO EN PESOS: SOLO CON EL T.C. OFICIAL DEL DÍA
    DEL CARGO (13-oct-2026, lote 2, API 0.0.75, SIN migración).** Caso real
    (Aircraft Spruce): el auto-cruce ligaba un gasto USD a un cargo MXN solo
    porque el cociente caía en la banda 15–25 y el candidato era único. Así
    el tubo Michelin (gasto 2d37d95e, 422.86 USD, 01-sep) quedó ligado a
    «ASA CANCUN» $8,939.38 de COMBUSTIBLE (T.C. 21.14 contra un oficial de
    17.01, +24.3 %; la BD derivó `tc_gasto` 21.140300) y las bujías
    (340c3dc6, 794.61 USD, 24-sep) a «ASA CANCUN I\CARR CANC» $14,197.17
    (+2.3 %), mientras sus cargos reales «AIRCRAFT SPRUCE AND SP» ($7,214.14
    y $14,431.18) y los gastos GAS en pesos seguían pendientes. **La
    corrección de datos YA se aplicó** el 13-oct-2026 a las 21:40 Cancún
    (`gasto_bitacora` la registra con actor): 2 desligues + 5 ligas; hoy hay
    6 ligas cruzadas y todas quedan entre −0.4 % y +1.5 % del oficial (tubo
    17.060351, bujías 18.161337, 516.35 USD 17.550770, llantas 17.224360,
    325.00 USD 18.508338, 203.90 USD 18.345414). Este lote NO la repite:
    impide que vuelva a pasar y hace visible lo sospechoso. Ningún número
    cambia: `tc_gasto` lo sigue derivando SOLO la BD
    (`recalcular_gasto_conciliado`, banda 15–25 intacta) y el panel no
    calcula.
    - **Fuente única PURA `conciliacion/auto-cruce.util.ts`** (punto 4 del
      encabezado): `TC_IMPLICITO_MIN/MAX` (15/25, espejo de la BD; se
      mudaron del servicio), `TOLERANCIA_TC_OFICIAL_PCT` = 2 (ÚNICA; el
      comentario lleva los datos de prod: correctas entre −0.4 % y +1.5 %,
      equivocadas +24.3 % y +2.3 %, señuelo 7,380.80 ↔ tubo +3.0 %),
      `TOPE_CRUCE_USD` = 25, `MIN_PALABRAS_COMUNES_USD` = 2,
      `PALABRAS_SIN_IDENTIDAD_USD` (AND, THE, INC, LLC, LTD, CORP, FOR, WWW,
      COM, PAYPAL; `VACIAS` no se tocó); `evaluarTcCruce` (tc_implicito =
      round6(|mxn| ÷ |usd|), en_banda con el cociente SIN redondear como la
      BD, desvío a 1 decimal con −0 ⇒ 0; CERCA ⟺ |desvío| ≤ 2 con el valor
      que se MUESTRA: «+2.0 %» es CERCA), `ligaUsdFueraDeLugar` (no en banda
      o LEJOS), `piezaTcCruce`/`textoTcCruce`/`tituloTcCruce`/
      `tcCruceUsdPublico` («T.C. 17.06 · oficial 17.01 (+0.3 %)», «…: lejos
      del oficial», «…: fuera de la banda 15–25», «T.C. 17.55 · sin T.C.
      oficial del día»; el título con el T.C. exacto de 6 decimales, el
      oficial de 4, el día REAL del dato y la fuente legible),
      `contrasteDescripcionUsd` (tokens CRUDOS de `tokensTexto`, SIN
      `expandirTokens`, sin ciudades/IATA, sin TODA palabra del giro
      —llaves y valores de `SINONIMOS`— ni relleno en inglés: ≥ 2 comunes
      COINCIDE, 1 DEBIL, 0 CONTRADICE, un lado vacío SIN_TEXTO; NO se
      reutiliza `puntuarDescripcion`: «ASUR CANCUN» empataría con
      «Aeropuerto de Cancún»), `decidirCruceUsd`, `competidoresCruceUsd`,
      `textoReciprocoCruceUsd`, `textoSePuedeCruzarUsd` y los 4 textos
      `TEXTO_CRUCE_USD_*`. `puntuarDescripcion`, `elegirCandidato`,
      `separarPorDesfase` y el dedupe NO cambiaron.
    - **Auto-cruce** (importación y «Cruzar pendientes»; pasos 1 —monto con
      desfase— y 2 —FALTANTE— byte a byte): el paso 3 (solo cuentas MXN) lee
      los USD bancarios sin conciliar EN BANDA del cargo (`rangoBandaUsd`,
      ±MATCH_DAYS, `.limit(25)`; llegar al tope ⇒ AMBIGUO), sin los que ya
      tienen partes, y liga SOLO si hay T.C. oficial del día del CARGO, el
      gasto queda a ±2 %, la leyenda del banco COINCIDE con él y ningún otro
      cargo pendiente de una cuenta en pesos cuadra igual (RECÍPROCO: fecha
      del gasto ±MATCH_DAYS, |monto| en `rangoBandaMxnDeUsd`, tope 25; un
      competidor CERCA o SIN oficial ⇒ AMBIGUO con candidatos 1 + n). Sin
      oficial ⇒ AMBIGUO «No hay T.C. oficial del …»; ≥ 2 CERCA ⇒ AMBIGUO;
      1 CERCA que no COINCIDE ⇒ AMBIGUO con el porqué; solo LEJOS ⇒
      SIN_CANDIDATO con el motivo de siempre + el detalle. Lectura del
      oficial fallida ⇒ ERROR `TEXTO_CRUCE_USD_SIN_LECTURA_TC`; lectura del
      recíproco (o del oficial de un competidor) fallida ⇒ ERROR
      `TEXTO_CRUCE_USD_RECIPROCO_ERROR`. El criterio sigue siendo
      `TC_IMPLICITO`. **Camino inverso DIFERIDO**: `intentarCruzarGasto`
      sigue solo con cuentas de la MISMA moneda (un gasto USD capturado
      después se liga con «Cruzar pendientes» o a mano).
    - **T.C. oficial**: tabla `tipo_cambio_oficial` con respaldo de 7 días
      (`VENTANA_RESPALDO_TC_DIAS`), la misma fuente del cotizador.
      `TipoCambioService.oficialesPorDias(dias, {descargar})` lee en UNA
      consulta por tramo de ≤ 900 días (`tcOficialVigente`, PURA: la fila
      válida más reciente de [día − 7, día], fuente legible); null = lectura
      fallida (jamás «sin dato»). **Descarga híbrida**: la importación (job
      asíncrono) y el pre-cierre bajan ≤ `DESCARGAS_TC_MAX` (5) días
      faltantes vía `oficialDetallePara` (con sus throttles); lista,
      «Vincular gasto», IA y «Cruzar pendientes» solo leen la tabla
      (`CruceCtx.descargarTc`, memo por día por corrida). `ConciliacionService`
      recibe `TipoCambioService` como 6.º parámetro @Optional y
      `ConciliacionModule` importa `TipoCambioModule` (sin ciclo;
      `conciliacion.module.spec` congela el import: sin él todo «funciona»
      pero SIN oficial).
    - **«Vincular gasto»** (`GET movimientos/:id/gastos-candidatos`): en
      cuentas MXN los USD bancarios en banda salen con CUALQUIER búsqueda
      (vacía o texto ⇒ la banda, + el `orTexto` de siempre; monto ⇒ DOS
      lecturas: el rango en dólares tal cual y, con oficial, el equivalente
      en pesos ÷ oficial ±3 % —`rangosUsdDeBusqueda`,
      `TOLERANCIA_BUSQUEDA_EQUIVALENTE_PCT`, más ancha porque es un filtro
      humano—; jamás `.or(and(…))`), se unen por id, se filtra EXACTO en
      banda y se quitan los que tienen partes. Cada cruzado lleva
      `tc_cruce` (oficial de TABLA; lectura fallida ⇒ SIN_OFICIAL y sin
      rango equivalente) y el orden es de 7 niveles (ver invariante 48). La
      raíz `tc_oficial {tc, fecha_dato, fuente} | null` viaja SIEMPRE (null
      en cuenta no MXN, sin dato o con la lectura fallida): el panel la usa
      como capacidad. **Lectura FALLIDA ≠ «sin dato» (revisión del lote 2,
      14-oct-2026)**: si `oficialesTabla` devuelve null (PostgREST caído), el
      nivel sigue SIN_OFICIAL pero el `tc_cruce` lleva el ADITIVO
      `lectura_fallida: true` con su propio texto («T.C. 21.14 · no se pudo
      leer el T.C. oficial del día»; título «… no se comprobó; vuelve a
      abrir «Vincular gasto» para compararlo», `tcCruceUsdPublico(ev,
      {lecturaFallida})`) y la raíz el ADITIVO `tc_oficial_lectura_fallida:
      true` (ausente si la lectura funcionó): el panel lo pinta en ámbar
      con «Vincular de todos modos» y no promete la búsqueda en pesos.
      Antes decía «sin T.C. oficial del día» (afirmaba que no había dato) y
      el caso Aircraft Spruce (+24.3 % real) salía en gris, sin aviso. `excluidos`: un USD bancario en banda deja de ser
      OTRA_MONEDA (`ContextoExclusion.montoCargo/cruzadosUsd`).
    - **Lista** (`GET movimientos`): cada CARGO con EXACTAMENTE una parte
      cruzada lleva `tc_cruce` a nivel de FILA (en su propio try: si el
      oficial no se puede leer, ninguna fila lo lleva); los CARGOS de cuentas
      MXN que con la regla de siempre quedan SIN_CANDIDATOS pasan por la
      regla USD (UNA lectura en lote de USD en banda, paginada, + oficiales
      de tabla, SIN recíproco): LIGAR ⇒ SE_PUEDE_CRUZAR con `motivo_detalle`
      = `textoSePuedeCruzarUsd`; AMBIGUO ⇒ AMBIGUO con el porqué;
      SIN_CANDIDATOS con LEJOS ⇒ el detalle. Si esa lectura o la de
      oficiales falla o se trunca, esos cargos quedan SIN anotar.
    - **IA** (`sugerir`, `sugerir-lote`): los cruzados se leen en banda con
      el oficial de tabla; los LEJOS ya NO se mandan y los que van llevan
      `tc_cruce` (pyservices ignora el campo extra). Con la LECTURA del
      oficial fallida no va NINGÚN cruzado (no se sabe cuáles quedan LEJOS;
      revisión del lote 2, 14-oct-2026), con un warn en el log.
    - **Pre-cierre** (`GET /v1/profit-sharing/pre-cierre`): item
      `gastos_usd_tc_fuera_de_lugar` JUSTO después de
      `gastos_bancarios_sin_conciliar`, NO bloqueante (`listo` no cambia):
      `ligas[]` (`LigaUsdTcFueraDeLugar`, `conciliacion/ligas-usd-tc.util.ts`:
      texto «$422.86 USD · <1.ª línea de la nota, ≤ 60> (01 sep) ↔ cargo
      «ASA CANCUN» de $8,939.38 del 01 sep (COMBUSTIBLE): <tc_cruce.texto>»)
      y `sin_verificar` (ligas en banda sin oficial del día de su cargo).
      `ConciliacionService.ligasUsdTcFueraDeLugar(desde, hasta)` NUNCA lanza:
      gastos USD conciliados por `fecha_gasto` (DATE, día Cancún; paginados,
      tope 5,000) → partes cruzadas → cargos → oficiales (aquí SÍ descarga)
      → `evaluarTcCruce`; sin la sonda de partes, sin el servicio o
      truncado ⇒ null ⇒ «sin verificar». Textos en
      `profit-sharing/ligas-usd-tc-precierre.util.ts`. El sistema NO corrige
      nada: la oficina desvincula (con confirmación) y vincula el cargo
      correcto, que sale primero con su línea de T.C.
    - **Límites conocidos**: recíproco CONSERVADOR (con 2 cargos CERCA del
      mismo gasto, o uno sin oficial, queda AMBIGUO sin mirar
      descripciones); margen ±2 % estrecho (una compra legítima con
      sobreprecio del banco > 2 % va a mano y el aviso la marca CADA mes:
      «descartarla» exigiría decisión del cliente y una columna); cargos
      anteriores a julio de 2026 (la tabla empieza el 01-jul) siempre a mano;
      la lista no corre el recíproco ni el FALTANTE para USD (un
      SE_PUEDE_CRUZAR puede terminar AMBIGUO al cruzar, con su motivo); el
      prompt de pyservices sigue hablando de la banda 15–25.
    - Specs: `auto-cruce.util.spec` (describe «T.C. oficial del día»: las 8
      ligas reales, bordes ±2.0/2.1, textos y títulos, contraste con el
      mutante de `expandirTokens`, decisión, recíproco),
      `gastos-candidatos.util.spec` (7 niveles, golden, «220 + tubo»,
      rangos), `candidatos-excluidos.util.spec`, `ligas-usd-tc.util.spec`,
      `conciliacion.service.cruce-usd.spec` (PostgREST falso que respeta
      `range` y los DEFAULT de la BD: auto-cruce, recíproco, errores,
      descarga solo en la importación, lista, «Vincular gasto», injerto #8,
      IA y el aviso del pre-cierre con las ligas de ANTES y DESPUÉS de la
      corrección), `conciliacion.service.autocruce.spec` (UNO y DOS USD con
      oficial 20), `conciliacion.service.lote.spec` (USD al buscar, raíz
      `tc_oficial`), `conciliacion.module.spec`,
      `tipo-cambio.service.oficiales.spec` y los dos del pre-cierre en
      `profit-sharing`.

71. **CONCILIACIÓN AL REVÉS DE UN GASTO (13-oct-2026, lote 2, API 0.0.75,
    SIN migración).** Pedido de la oficina: en Gastos el badge «Conciliado»
    de la columna «Banco» no decía CON QUÉ cargo; había que ir a
    Conciliación y buscarlo a ojo. Ahora, desde el gasto: el cargo, la
    cuenta, el estado de cuenta de origen y quién registró la liga; y el
    Excel de gastos sale COMPLETO (antes se cortaba en 1,000 filas: prod
    tiene 1,112 gastos) con ese detalle para quien concilia.
    - **Ruta** `GET /v1/conciliacion/gastos/:id` en `ConciliacionController`
      SIN `@Roles` propio: hereda los de la clase, que ahora es
      `@Roles(...ROLES_CONCILIACION)` (`conciliacion/roles-conciliacion.ts`,
      FUENTE ÚNICA de «quién ve el banco» = [ADMIN, FACTURACION]; la
      metadata quedó idéntica). `roles-conciliacion.spec` la compara con la
      metadata de la clase y con `ROLES_POR_BUCKET['estados-cuenta']`
      (invariante 37): abrir uno sin el otro truena el spec. COORDINADOR,
      ANALISTA, SOCIO, PILOTO, MECANICO y VISITANTE ⇒ 403 del RolesGuard;
      uuid inválido ⇒ 400 (`ParseUUIDPipe`); gasto inexistente ⇒ 404
      `GASTO_NO_EXISTE` «Ese gasto ya no existe: recarga la página.»; una
      lectura PRINCIPAL caída (gasto, puente, movimientos o vista) ⇒ 500,
      JAMÁS «sin cargos». CERO escrituras.
    - **Lector ÚNICO** `ConciliacionService.leerCargosDeGastos(gastos,
      {vista?})` ⇒ `Map<id, {fuente, vista, cargos}>` con TODOS los ids
      pedidos (normalizados; sin cargos ⇒ `[]`). Lo usan la hoja
      (`conciliacionDeGasto`) y el Excel: los dos dicen lo mismo. Orden de
      lectura con la sonda de partes: puente por PK con su autor
      (`partesDeGastos(ids, {conAutor: true})` = `PARTE_COLS +
      ligador:usuario!created_by(nombre)`, la MISMA lectura paginada; sin la
      opción, byte a byte la de siempre) → vista (salvo `{vista: false}`) →
      movimientos por id en lotes de 200 con `MOV_DETALLE_GASTO_COLS`
      (cuenta, estado de cuenta + quién lo importó, quién creó el cargo;
      JAMÁS `numero_cuenta`, `clabe` ni `storage_path`) + `gastos_n` +
      `orden_archivo` SOLO con su sonda → `anotarPartes` (el lector de GET
      movimientos) SOLO para los cargos con `gastos_n` ≥ 2, best-effort (si
      falla, `lote.gastos` = null y la alerta LOTE_SIN_DETALLE). Una parte
      cuyo cargo ya no se lee (carrera) se OMITE con un warn, jamás se
      inventa. Sin la sonda (REGLA DURA de la invariante 40): ESPEJO
      `gasto_id` con parte SINTÉTICA (|monto|, moneda de la cuenta, sin
      registro), `vista`/`lote` null, `fuente: 'ESPEJO'`. Nunca nombra
      `cobros_n`. Un error de la puente, los movimientos o la vista se LANZA.
    - **Ningún número se recalcula** (modelo PURO en
      `conciliacion/cargos-de-gasto.util.ts`, con spec): estado =
      `estadoBancoGasto` (la misma de la columna «Banco»; `monto_vinculado`
      de la vista, en ESPEJO Σ de las partes); aporte de cada cargo =
      `monto_parte`; suma y faltante = los de `v_gasto_conciliacion` TAL
      CUAL (un cruzado tiene suma 0 y `monto_vinculado` = monto por
      definición: el panel nunca escribe «suman $0.00»); T.C. =
      `gasto.tc_gasto` GUARDADO (`normalizarTc`), nunca monto_parte/monto;
      diferencia del lote = la de `anotarPartes` (`diferenciaLote`), que
      jamás ajusta un gasto. Cargos ordenados por fecha y luego por id.
      Desde el 0.0.78 la base de cada cargo es `aMovimientoDetalle`
      (`CargoDeGastoDetalle extends MovimientoDetalle`: mismas llaves, mismo
      orden), COMPARTIDA con el abono de una entrada de dinero (invariante
      78); `registroDeParte(p, desde)` recibe el corte como 2.º parámetro (sin
      él, `LIGAS_REGISTRADAS_DESDE`: byte a byte lo de siempre).
    - **«Sin archivo» por ORIGEN y día Cancún** (`motivoSinArchivo`): con
      `estado_cuenta_id` ⇒ null; `origen` MANUAL ⇒ CAPTURA_MANUAL; cualquier
      otro ⇒ IMPORTADO_SIN_ARCHIVO. Prod (13-oct): 124 movimientos sin
      archivo, TODOS IMPORTADO del 16-jul-2026 en hora Cancún (17-jul en
      UTC), 7 de ellos ligados, 0 MANUAL — decir «capturado a mano» sería
      falso; además viaja quién importó el cargo (`creado_por`).
    - **«Registró la liga» SOLO desde `LIGAS_REGISTRADAS_DESDE`**
      (`2026-10-02T05:00:00.000Z` = 2-oct-2026 00:00 Cancún,
      `registroDeParte`): las partes anteriores son el BACKFILL de
      20261002000002, que copió `updated_at`/`updated_by` del CARGO (373 de
      506 en prod; la última del backfill 2026-10-01T22:54:57Z, la primera
      real 2026-10-02T22:14:39Z). Para ellas `registro` = null y el Excel
      dice «(anterior al 02-oct-2026)». En las ligas automáticas el registro
      nombra a quien importó el estado de cuenta o capturó el gasto. Si
      alguien vuelve a correr un backfill, la regla se revisa.
    - **Justificación** de un gasto no bancario ligado (invariante 48):
      `justificacionVinculoDeCargo(notas del cargo, gastoId)` en
      `common/vinculo-no-bancario.util.ts` — la ÚNICA lectura de esa línea,
      por la LLAVE «gasto 3f9a1c2e» (en un lote cada gasto la suya; una
      línea vieja sin llave no se reconoce y se queda en las notas).
      `notas_oficina` = las notas del cargo SIN las líneas del vínculo; las
      notas crudas no viajan (del gasto solo `notas_primera_linea`).
    - **Alertas** (solo hechos guardados, en este orden):
      CONCILIADO_SIN_CARGOS (marcado conciliado sin partes),
      ESTADO_DESFASADO (`conciliado` ≠ `cubierto` de la vista con partes),
      TC_NO_REGISTRADO (parte cruzada sin `tc_gasto`), LOTE_SIN_DETALLE.
      `ultimos_movimientos` (solo SIN_CONCILIAR o PARCIAL): última `fecha`
      de cada cuenta `activa` por alias, best-effort (falla ⇒ null; en un
      CONCILIADO ni se lee). La DESCARGA del estado de cuenta es el `POST
      /v1/conciliacion/estados-cuenta/:id/url` de siempre (1 h, mismos
      roles), NO `/storage/firmar`.
    - **Excel de gastos** (`GET /v1/expenses/export`, roles SIN cambio):
      `listParaXlsx` lee en páginas de 1000 (`PAGINA_XLSX_GASTOS`) hasta
      20,000 (`TOPE_XLSX_GASTOS`; al llegar, el subtítulo dice « · OJO: se
      exportaron 20,000 de N gastos (tope del Excel); acota los filtros»).
      `list()` desempata por `id` (17 grupos de prod empatados en fecha +
      alta: el offset repetía o saltaba filas, también en `listGastosAll`
      del panel). Con `puedeVerDetalleBanco(rol)` (ADMIN/FACTURACION)
      `listXlsx(q, {detalleBanco: true})` usa `hojas`: la pestaña de siempre
      (mismo título, subtítulo, resumen, columnas y filas) + AL FINAL
      «Factura», «Cargo del banco», «Estado de cuenta», y la pestaña «Cargos
      del banco» (22 columnas, una fila por par gasto × cargo, «Diferencia
      del lote» resaltada con |d| ≥ 0.005, T.C. como TEXTO, sin fila de
      totales: no se suman monedas). COORDINADOR/ANALISTA: el libro de
      siempre (raíz, sin `hojas`). Las dos lecturas del detalle son
      INDEPENDIENTES y best-effort: cargos (`leerCargosDeGastos(…, {vista:
      false})` solo de los conciliados o con algo vinculado; `faltante` y
      `monto_vinculado` ya vienen de `list()`) ⇒ si fallan (o no hay módulo
      de conciliación, @Optional) las dos celdas dicen «No se pudo leer el
      detalle del banco (vuelve a exportar)» en las filas CONCILIADO o
      PARCIAL, el subtítulo lo avisa y no sale la pestaña 2; folios
      (`foliosDeGastos`, `folioComprobanteDeFila` con la sonda de serie de
      la invariante 44) ⇒ si fallan, «Factura» vacía con su nota. Etiquetas
      PURAS en `expenses/gastos-xlsx.util.ts` («30-sep-2026 · EJE SCOTIA ·
      $11,205.60 (paga 4 gastos; a este $2,801.40)», «… (T.C. 17.2244)», «…
      · faltan $X de $Y», «scotia eje sep.pdf (importado 06-oct-2026)»,
      «Sin archivo (importado el 16-jul-2026)»). «Concepto» sale de
      `conceptoDeGasto` (la misma expresión de siempre, ahora compartida).
    - **Columna «Avión» del Excel de gastos** (15-oct-2026, API 0.0.78,
      hallazgo #20 de la revisión del panel de Gastos; solo TEXTO, cero
      lecturas nuevas): `celdaAvionGasto` (`expenses/gasto-avion.util.ts`,
      PURO) dice lo MISMO que la columna «Avión · vuelo» de la tabla del panel
      con SU precedencia: (1) reparto ⇒ «Repartido: N4142R, N621TX», con
      «VuelaTour» al final si queda remanente según `expandirConReparto` (la
      fuente de los libros) y «¿?» en una parte sin matrícula; (2)
      PERSONAL_DUENO ⇒ «Personal»; (3) empresa o «Comisión del vendedor
      (VuelaTour)» ⇒ «VuelaTour» siempre (en 2 y 3, con avión sellado, « (ref.
      N4142R)»); (4) con avión ⇒ su matrícula (un INDIRECTO con avión dice la
      matrícula: resta en ese balance); (5) INDIRECTO sin avión ⇒ «VuelaTour»;
      (6) «Falta avión» = EXACTAMENTE la bandeja `?pendientes=true` (37 en
      prod). Gasto con avión sin matrícula en el join ⇒ «Avión asignado». En
      prod (1,144 gastos) cambian 296 celdas y ninguna otra columna.
      `gasto-avion.paridad.spec` EJECUTA el `gasto-avion.ts` del panel
      (transpilado con el `typescript` del API) contra 3,360 combinaciones +
      filas reales y revisa cómo dibuja la tabla cada caso; corre si
      `../vuelatour-next` está al lado o con `VUELATOUR_NEXT_DIR` (y entonces
      es OBLIGATORIA: un archivo movido truena); si no, se salta. Lee el
      ÁRBOL DE TRABAJO del panel (no un commit) y solo truena por una REGLA o
      un TEXTO (revisión del 15-oct-2026): las piezas de la tabla son
      patrones sin nombres de variables locales (`PIEZAS_TABLA_AVION`) y un
      paquete npm que importe un módulo del panel (`lib/format.ts`,
      `categorias-gasto.ts`…) se sustituye por un módulo que truena SOLO si
      la regla lo usa. Si el panel cambia esa columna, `lib/admin/
      gasto-avion.ts`, `categorias-gasto.ts` o `format.ts`, se cambian los dos
      en el mismo lote; el AGENTS.md del panel debe citar esta paridad (lo
      escribe el lote del panel: este repo no lo toca). Specs:
      `gasto-avion.util.spec`, `gasto-avion.paridad.spec` (con
      `gasto-avion.fixture-spec.ts`: 11 filas reales sin notas ni datos
      personales + la matriz) y `expenses.service.xlsx.spec`.
    - **`anexarConciliacionParcial`** (aditivos de `GET /expenses`): el
      universo suma los NO bancarios que pueden tener un cargo ligado con
      justificación (todo menos BODEGA) y siguen sin conciliar; esas filas
      reciben `monto_vinculado`/`faltante`/`parcial` SOLO si tienen algo
      ligado (si no, byte a byte igual): un efectivo ligado a medias dice
      «Parcial» en vez de «—» (hoy 0 casos). Las bancarias, como siempre.
    - Las dos ligas sospechosas que encontró el diseño (2d37d95e ↔ «ASA
      CANCUN» $8,939.38 y 340c3dc6 ↔ «ASA CANCUN I\CARR CANC» $14,197.17)
      ya se corrigieron con la invariante 70; la hoja muestra cualquier liga
      tal cual (ni corrige ni avisa del T.C. contra el oficial: eso vive en
      el pre-cierre, invariante 70).
    - Specs: `roles-conciliacion.spec`, `cargos-de-gasto.util.spec` (filas
      reales: lote SAESA, EJE SCOTIA 0.02, cruzado 913a7d19, sin archivo del
      16-jul, Paywise; bordes del corte; nunca storage_path/numero_cuenta/
      clabe), `vinculo-no-bancario.util.spec` (bloque
      `justificacionVinculoDeCargo`), `conciliacion.service.lote.spec`
      (describe «CONCILIACIÓN AL REVÉS» casos a–r: 1↔1 con registro,
      backfill, lote con 0 y 0.01, dos cargos y PARCIAL, cruzado y
      TC_NO_REGISTRADO, efectivo justificado, pasarela, sin archivo,
      SIN_CONCILIAR con `ultimos_movimientos`, 404, anti-tope de 1,050
      partes, lote best-effort, lecturas principales que lanzan,
      `orden_archivo` con su sonda —el fake ganó `sinOrdenArchivo`—, sin
      `cobros_n`/`storage_path`/`clabe`, `{vista: false}`, cero escrituras;
      y ESPEJO en «SIN la migración»), `conciliacion.controller.lote.spec`
      (metadata + HTTP 200/403/400/404), `gastos-xlsx.util.spec`,
      `expenses.service.xlsx.spec` (1,112 filas en 2 páginas, desempate,
      COORDINADOR igual que hoy, ADMIN con 2 hojas, fallas con su nota, sin
      módulo, sin la sonda de serie, tope),
      `expenses.controller.export.spec` (el rol decide `detalleBanco`;
      PILOTO 403; cabeceras), `expenses.service.conciliado.spec` (no
      bancarios con y sin la puente) y `expenses.service.spec` (orden con
      `id`).

72. **VÍNCULO GASTO → CELDA DEL BALANCE Y ENLACES DESDE CONCILIACIÓN
    (13-oct-2026, lote 2 punto 5, API 0.0.75, SIN migración).** Desde
    Conciliación, «Ver en balance del avión N4142R» / «Ver en balance
    general» abren el libro en pestaña nueva EN LA CELDA del gasto. Tres
    piezas, todas ADITIVAS; ningún número, consulta de dinero ni regla de
    acreditación cambia.
    - **(i) Metadatos del payload** (`aircraft-balance.service.ts`): cada
      fila del vuelo lleva `op_vinculos`, `piloto_vinculos` y
      `otros_vinculos` (`BalanceVinculoGastoPayload {id, rol: 'suma' |
      'nota' | 'sin_tc', monto_mxn, gasto_mxn?}`) — TODA rama del bucle `for
      (const g of vGastos)` que empuja una línea de `*_detalle` nacida de un
      GASTO empuja su vínculo con el MISMO monto (helper local `vincular`):
      PILOTO/OTROS/OPERACIONES 'suma' con el gasto entero; factura con
      desglose IA ⇒ op 'suma' con `opParte` y FBO 'suma' con `fboParte`, las
      dos con `gasto_mxn` (la MISMA factura puede salir en las dos celdas);
      solo traslados ⇒ op 'nota'; TUAS ⇒ op 'nota' con `gasto_mxn` = su
      MXN; USD sin ningún T.C. ⇒ 'sin_tc' en la columna de su categoría. El
      costo del operador externo y el encabezado «Op CUN» NO llevan vínculo
      (no son gastos). Σ de los 'suma' de una lista == la celda (OPERACIONES
      menos el costo del operador) ±0.01 por el redondeo de USD convertidos.
      Las listas van JUSTO después de `otros_detalle` y ANTES de
      `permiso_afac_mxn` (comisiones.spec congela las últimas llaves). Cada
      fila de las hojas ledger (`buildHoja`) termina en `gasto_id` (en un
      parcial del reparto, el del PADRE) + `gasto_parte: 'reparto' |
      'remanente'` (el remanente lo marca `gastosEmpresaYSueltos` con
      `es_remanente_reparto`). Metadatos: JAMÁS se suman.
    - **(ii) La regla «a qué libro y a qué mes»** vive en
      `common/ubicacion-balance-gasto.util.ts` (`ubicacionBalanceDeGasto`,
      PURO, nunca lanza), ESPEJO de los libros, con los conjuntos y lectores
      compartidos en `common/hojas-balance.util.ts` (`embebido`,
      `vueloEmbebido`, `esVueloExternoSinAvion`, `avionDeGastoEmbebido`,
      `HOJAS_APARTE_BALANCE`, `PARCIAL_A_INDIRECTOS`, `parcialEntraAlAvion`;
      se MUDARON del servicio sin cambio de conducta). Reglas en orden: R1
      PERSONAL_DUENO ⇒ null; R2 las DOS categorías del pago al vendedor ⇒
      null (restan en COMISIONES o en «otros movimientos», celdas sin
      vínculos); R3 GAS ⇒ su avión (`avionDelGasto`), eje gasto, combustible
      en los dos libros; de un externo sin avión ⇒ eje VUELO y solo el
      general; si no, null; R4 reparto manual (categoría repartible y
      `parcialEntraAlAvion`) ⇒ eje gasto, los aviones del reparto en «Gastos
      Indirectos» y en el general «otros gastos» si hay remanente y
      `gastosEmpresaYSueltos` lo lee (EMPRESA o suelto sin vuelo ni avión),
      si no «repartidos a aviones» salvo INDIRECTO/NOMINA (sin general); R5
      EMPRESA ⇒ solo «otros gastos», eje gasto; R6 con vuelo ⇒ el mes del
      VUELO (día Cancún): externo sin avión ⇒ «reporte horas FLOTA» (PERMISO
      e INDIRECTO ⇒ null: el general no pinta esas hojas); si no, el avión
      de `avionDelGasto` — PERMISO ⇒ «permisos» sin general, INDIRECTO ⇒
      «Gastos Indirectos» (con inventario: refacciones / inventario), el
      resto (TUAS, COMISARIATO, REFACCION y categorías futuras) ⇒ la fila del
      vuelo en los dos; un gasto SIN tramo sellado a un avión distinto del
      del vuelo (también un vuelo aún sin avión) vive en el libro de ese
      avión SOLO si voló un tramo VIVO (`necesitaTramosVivos` +
      `aviones_con_tramo_vivo`; si no, null — caso #255); R7 sin vuelo ⇒ el
      mes del GASTO: TUAS ⇒ null, con avión PERMISO ⇒ «permisos», el resto
      ⇒ «Gastos Indirectos» (inventario ⇒ refacciones / inventario), sin
      avión ⇒ «otros gastos»; R8 periodo = `mesCalendarioDe` (nuevo en
      `fecha-cancun.util`) de la fecha del eje. **Mover una categoría de hoja
      o de eje en el libro obliga a tocar los dos lados**: la ALARMA DE
      PARIDAD de `ubicacion-balance-gasto.util.spec` lee
      `aircraft-balance.service.ts` como texto (sin espacios) y exige sus
      consultas y reglas (fecha_vuelo, externos, GAS de flota y de externos,
      sin vuelo del avión, salto PERMISO/INDIRECTO/GAS, `CAT_FUERA_DEL_AVION`,
      hojas del avión, «otros gastos», reparto por la fecha del padre y los
      conjuntos importados de `hojas-balance.util` sin copias locales).
    - **(iii) `balance` en `GET /v1/conciliacion/movimientos`** (en `gasto`
      1 ↔ 1 y en cada `gastos[]`): `{periodo: {desde, hasta}, eje: 'vuelo' |
      'gasto', aviones: [{id, matricula}] (por matrícula, null al final),
      general, hoja_avion, hoja_general}` o null (no vive en ningún libro: sin
      enlace). Lo pone `anotarUbicacionBalance` con lecturas PROPIAS en lote
      (`GASTO_UBICACION_COLS` con los embeds por columna, `fetchRepartos`,
      escalas vivas solo de los que lo necesitan, matrículas cosméticas) —
      NUNCA en el select principal de la bandeja. Desde el 15-oct-2026 esa
      lectura es el LECTOR COMPARTIDO `common/ubicacion-balance-lector.ts`
      (`leerUbicacionBalance`, mudado sin cambio de conducta; también lo usa
      Caja chica, invariante 82): quien quiera `balance` de un gasto lo llama
      a él, jamás copia la lectura ni decide libro o mes por su cuenta. Best-effort: si falla la
      lectura de gastos o de repartos no hay campo (el panel no pinta
      enlaces); si fallan las escalas, no se verifica; si fallan las
      matrículas, `matricula: null`. `hoja_general` = la PRIMERA hoja del
      general donde aparece (informativo).
    - **(iv) `vinculos_gasto: true`** viaja SOLO en las peticiones del libro
      en pantalla (spread en `libro()` / `libroGeneral()`): pyservices anota
      `vinculos` en las celdas y la bandera en la raíz del libro JSON
      (`LibroVista.vinculos_gasto?`, `LibroVistaCelda.vinculos?`, solo
      transporte). `payloadAvion`, `payloadGeneral` y los `.xlsx` no
      cambian.
    - **(v) Sin enlace en esta ronda** (`balance: null`) y siguiente paso:
      las dos comisiones del vendedor (la «(avión)» resta en COMISIONES del
      avión que lo absorbe —inv. 61—: anotar `comisiones_vinculos` y saber
      quién absorbe), PERMISO en la fila «AFAC · matrícula» de «otros
      movimientos» (inv. 62: anotar el egreso con los gasto_id de su hoja
      «permisos»; hoy PERMISO solo enlaza a su avión), TUAS sin vuelo, gas
      sin avión, PERMISO/INDIRECTO de un externo sin avión, vuelos sin
      fecha y el hueco #255. FACTURACION (quien concilia) no ve los enlaces
      porque los libros son ADMIN/ANALISTA: abrirlos es decisión del
      cliente.
    - Specs: `fecha-cancun.util.spec` (`mesCalendarioDe` 31/30/28/29 y el
      cruce de mes a las 22:30 de Cancún), `hojas-balance.util.spec`,
      `ubicacion-balance-gasto.util.spec` (R1–R8 con los repartos reales,
      externos, #255, vuelo sin avión, embeds en arreglo, EMPRESA congelada y
      la alarma de paridad), `aircraft-balance.service.vinculos.spec` (Σ por
      lista == la celda, nota y sin_tc, operador externo sin vínculo,
      `gasto_id`/`gasto_parte`, orden de llaves, cada gasto una vez salvo
      op + FBO) y `conciliacion.service.ubicacion-balance.spec` (eje vuelo y
      gasto, lote, empresa, reparto, #255 ⇒ null con UNA lectura de escalas
      vivas, best-effort sin campo, matrícula null, bitácora). Siguen verdes
      sin tocarse comisiones.spec, empresa.spec, modo.spec, afac-om.spec y
      lote.spec.

73. **REPORTE POR VUELO: EL PAGO AL VENDEDOR ES EL GASTO REAL (13-oct-2026,
    lote 2, API 0.0.75, SIN migración).** Decisión 3 del cliente («en todo:
    solo gastos reales»): el PDF/Excel del vuelo (`flight-report.service`)
    seguía restando el pago COTIZADO (`pagoVendedorUsd` = comisión + su
    IVA), la provisión que la D3 sacó de todos los libros (invariante 61).
    - **Regla**: `GANANCIA = remanente − pago REAL al vendedor − comisiones
      bancarias`. Pago REAL = Σ de los gastos del vuelo de las DOS
      categorías (`categoriaEsPagoVendedor`: «Comisión del vendedor
      (VuelaTour)» + «(avión)»; aquí no importa quién lo absorbe: es la
      economía COMPLETA del vuelo), en USD con la MISMA conversión PURA que
      ya tenía su nota (USD directo; MXN ÷ `tc_gasto` > 0 o el T.C. del
      vuelo), suma cruda y `toFixed(2)` al final, NUNCA con `gastoUsd` (su
      efecto lateral `gastosTcVueloCount += 1` alteraría la nota de los
      costos). En TODO estado: un CANCELADO con pago capturado también lo
      resta (es dinero que sí salió). Sin gasto real NO se resta nada. Los
      gastos se siguen LISTANDO con «pago al vendedor — ya descontado en
      «pago al vendedor» (no resta aparte)» y fuera del costo y del
      remanente (restarlos también como gasto sería doble). Un pago en MXN
      sin ningún T.C. NO se resta y se AVISA («N pago(s) al vendedor en MXN
      por $X SIN tipo de cambio …»); no cuenta en `gastos_sin_tc_*` (no es
      costo del vuelo).
    - **K DE LOS LIBROS en TODO el reporte (revisión del lote 2,
      14-oct-2026)**: el «T.C. del vuelo» del reporte era SOLO el capturado
      (`tc_usd_mxn`); en un vuelo sin él (#70 y #157, COMPLETADOS, con
      comisión cotizada) un pago al vendedor en pesos sin `tc_gasto` no se
      restaba aquí y SÍ en los libros (balance: K = capturado ?? oficial;
      reparto: `kComisionesDeVuelo`). Hoy el reporte usa el MISMO K:
      `tc_usd_mxn` ?? T.C. OFICIAL de referencia del día Cancún de la
      COTIZACIÓN (`fecha_solicitud`; si no, el del vuelo) vía
      `TipoCambioService.oficialDetallePara` (la cadena de
      `tcOficialPorVuelos`), para TODO lo que está en pesos sin T.C. propio:
      cobros y sus comisiones bancarias (`cobrosEnUsd`), gastos del costo y
      pagos al vendedor. `FlightReportService` lo recibe @Optional (3.er
      parámetro; `FlightsModule` importa `TipoCambioModule`, congelado en
      `flights.module.spec`); sin servicio, sin fecha o sin dato ⇒ como
      antes (solo el capturado, y se avisa lo que no convirtió). Nunca en
      silencio: «N gasto(s) en MXN sin T.C. propio convertidos con el T.C.
      oficial del día de la cotización (17.3943).» y «El vuelo no tiene T.C.
      en la cotización: lo que está en pesos sin T.C. propio (cobros, gastos
      y pagos al vendedor) se convirtió con el T.C. oficial de referencia
      del día de la cotización, 17.3943 (dato del 2026-07-21, fuente
      open.er-api) — el mismo que usan el balance por avión y el reparto.»
      (solo si alguna partida lo usó). El `tc_usd_mxn` del payload sigue
      siendo el CAPTURADO (columna MXN del PDF). Consecuencia: #70 y #157
      (todos sus gastos en MXN sin `tc_gasto`) dejan de excluir el 100 % de
      sus costos del reporte.
    - **Payload** (`ReporteVueloPayload`, contrato con pyservices):
      `comision_vendedor_usd` sigue siendo la COTIZADA (dato de la
      cotización); `pago_vendedor_usd` = el pago REAL que resta la ganancia
      (0 explícito si la cotización trae comisión y no hay pago; null sin
      comisión ni pagos); `neto_vuelatour_usd` = total − ese pago (CANCELADO:
      lo retenido − ese pago); ADITIVOS la bandera
      `comision_vendedor_solo_gasto_real: true` (la misma de los libros) y
      `pago_vendedor_cotizado_usd` (la cotizada con su IVA como DATO de la
      cotización, null sin comisión; jamás se resta). Con
      el pyservices de hoy la cascada visible cuadra con la ganancia
      («(−) Pago comisión vendedor» pinta `pago_vendedor_usd`; con 0 no se
      pinta) — DEUDA de presentación: su etiqueta dice «(c/IVA)» / «(comisión
      + IVA)» cuando el pago supera la comisión pre-IVA, que con un pago real
      puede no ser IVA, y la sección de la cotización pinta «Pago comisión
      vendedor −$0.00» / «Neto VuelaTour» = total cuando no hay pago:
      pyservices puede rotular con la bandera y pintar ahí la cotizada.
    - **Notas** (`notas_horas`): con pago «Pago real al vendedor capturado:
      $100 USD en 1 gasto(s); la ganancia de este reporte resta este pago
      real (la comisión cotizada con su IVA es de $80 USD).» (sin la
      cotizada si no hay comisión; variante de CANCELADO «…; el vuelo se
      canceló, pero es dinero que sí salió: la ganancia de este reporte lo
      resta.»); sin pago y con comisión «Comisión del vendedor cotizada $80
      USD sin gasto real capturado: la ganancia de este reporte no resta
      pago al vendedor (si ya se pagó, captúralo en Gastos como «Comisión del
      vendedor (VuelaTour)» o «Comisión del vendedor (avión)» ligado a este
      vuelo).» (CANCELADO: «Vuelo CANCELADO: comisión del vendedor cotizada
      $80 USD sin gasto real capturado; este reporte no resta pago al
      vendedor y el neto de VuelaTour es lo retenido.»). El aviso del externo
      («Vuelo externo con N gasto(s)… ADEMÁS del costo del operador») sigue
      sin contarlos.
    - **Consecuencia para el cliente**: los reportes por vuelo de comisiones
      cotizadas SIN pago capturado (#233, #237, #260, #317, #404, #417, #442
      al 13-oct) suben su ganancia por el cotizado hasta capturar el pago;
      #251 y #332 restan su pago real. Ningún otro libro cambia (balance,
      reparto y Dinero ya eran solo gasto real desde el 0.0.74).
    - Spec: `flight-report.service.pago-vendedor.spec` (resta el real y no
      el cotizado, sin pago 0/neto/nota, sin efecto lateral en la nota del
      T.C. del vuelo, USD + `tc_gasto`, MXN sin T.C. avisado y fuera de
      `gastos_sin_tc`, las dos categorías, vuelo sin comisión (#332),
      CANCELADO con y sin pago, bandera, externo; y desde la revisión del
      lote 2 el K de los libros: #70 sin T.C. ⇒ pago de $2,000 MXN ÷ 17.3943
      = 114.98 USD restado con el día Cancún de `fecha_solicitud`, cobros en
      pesos con el mismo K, con T.C. capturado no se consulta el oficial,
      sin dato como antes, todo en dólares sin la nota) y
      `flights.module.spec` (el import de `TipoCambioModule`).
    - **pyservices (revisión del lote 2)**: con la bandera, la sección
      «Cotización» del PDF/Excel pinta la COTIZADA
      (`pago_vendedor_cotizado_usd`) y su neto (total − cotizada, como el
      panel), y la cascada rotula «(−) Pago real al vendedor» con
      `pago_vendedor_usd`, sin «(c/IVA)» (la DEUDA de presentación de arriba
      quedó resuelta allá; sin la bandera, byte a byte como antes).

74. **FECHA DEL PAGO DESDE CONCILIACIÓN (14-oct-2026, API 0.0.76, SIN
    migración).** Pedido de la oficina en «Vincular gasto» de
    `/admin/conciliacion?f=pendientes`: corregir ahí la fecha del gasto
    «solo para ajustar bien». Decisión del 13-oct-2026: la fecha del gasto
    es la FECHA DEL PAGO (la del cargo / SPEI); el auto-cruce sigue a ±3
    días (`MATCH_DAYS = 3`) y NO se amplía.
    - **Ruta ADITIVA** `PATCH /v1/expenses/:id/fecha`, solo
      `ROLES_CONCILIACION` (ADMIN, FACTURACION; el resto 403). DTO
      `CambioFechaGastoDto { fecha_gasto, fecha_anterior, confirmar? }`
      (`@Matches` AAAA-MM-DD, no `@IsDateString`: un timestamp UTC podría
      correr el día; `confirmar` es booleano ESTRICTO sobre el valor crudo
      —'false' en texto es 400, no `true`—; cualquier otra llave ⇒ 400).
      Regla y textos en `expenses/cambio-fecha-gasto.util.ts` (PURO);
      `ExpensesService.cambiarFechaGasto` solo lee y escribe. Respuesta 200
      `{ id, fecha_gasto, fecha_anterior, cambio, cambia_de_mes,
      fecha_hora_carga, fecha_hora_carga_movida, updated_at, aviso }`
      (`cambio: false` = ya tenía esa fecha: no escribe ni mueve
      `updated_at`; `fecha_hora_carga` = la que QUEDÓ en la fila y
      `fecha_hora_carga_movida` = true SOLO si esta llamada la movió —una
      carga que ya caía en el día nuevo no se toca y el panel no debe decir
      que «pasó al mismo día»—; `aviso` = la línea de «mes terminado» cuando
      hubo confirmación).
    - **JAMÁS dispara el auto-cruce**: escribe por `update(id, dto, userId,
      rol, { autoCruce: false })` con CAS sobre el `updated_at` LEÍDO por
      la propia petición (0 filas ⇒ 409 `CONFLICTO_VERSION`). El 5.º
      parámetro de `update()` es INTERNO, va AL FINAL y es opcional: su
      único llamador en producción es el controller del PATCH general
      (verificado por grep el 14-oct: ningún otro módulo inyecta
      `ExpensesService` para `update`; `combustible-masivo` solo usa
      `create`), que no lo pasa ⇒ `PATCH /v1/expenses/:id` («Verificar /
      editar») sigue IGUAL, auto-cruce incluido. Liga la persona con
      «Vincular»: con montos repetidos (VIP SAESA) el cruce en segundo plano
      podía ligar OTRO cargo sin que el panel se enterara.
    - **Candados, en orden**: (1) fechas ANTES de tocar la BD (400
      `FECHA_GASTO_INVALIDA` —día que no existe, nueva o anterior—,
      `FECHA_GASTO_FUTURA` —después de hoy en Cancún— y
      `FECHA_GASTO_MUY_ANTIGUA` —más de 365 días; aquí no existe «permitir
      fecha antigua»); (2) 404 `GASTO_NO_EXISTE`; (3) medio bancario
      (`MEDIOS_BANCARIOS`; EFECTIVO —su fecha decide qué reposición de caja
      chica lo cubre—, PERSONAL_*, BODEGA o sin medio ⇒ 409
      `FECHA_GASTO_SOLO_BANCARIOS` con `details.medio_pago`; se corrigen en
      Gastos); (3b) YA CONCILIADO (`gasto.conciliado`, en
      `GASTO_CAMBIO_FECHA_COLS`) ⇒ 409 `FECHA_GASTO_YA_CONCILIADO` «Este
      gasto ya quedó conciliado con un cargo del banco: su fecha es la de
      ese pago y ya no se cambia desde Conciliación. Si ese cargo no es su
      pago, desvincúlalo primero.», aun con `confirmar` y aunque la fecha
      sea la misma (revisión del 14-oct-2026: el CAS solo ve lo que cambia
      entre la lectura y el UPDATE de ESTA petición; quien ligó el gasto a
      OTRO cargo —«Vincular», «Cruzar pendientes» o el auto-cruce del PATCH
      general— mientras «Vincular gasto» seguía abierto dejaba que la ruta
      lo fechara con el cargo equivocado y, con otro mes, lo movía de mes en
      balance, reparto y Libro Dinero). El panel nunca ofrece conciliados,
      así que solo atrapa esa carrera (y un «Deshacer» después de
      vincular); un pago PARCIAL (`conciliado = false`) sí se corrige. El
      flujo futuro sobre cargos ya conciliados (decisión del cliente) tendría
      que relajarlo de forma explícita; (4) misma fecha ⇒ 200 `cambio:
      false` (doble clic idempotente); (5) `fecha_anterior` ≠ la vigente ⇒ 409
      `FECHA_GASTO_CAMBIO` con `details.fecha_actual`; (6) mes del vuelo =
      ESPEJO EXACTO de `fechasFuera` del balance (gasto con vuelo de fecha
      legible, categoría fuera de `CATEGORIAS_GASTO_FUERA_DEL_AVION`, mes
      nuevo ≠ mes del vuelo —día Cancún— y ≠ el que ya tenía ⇒ 409
      `FECHA_GASTO_FUERA_DEL_MES_DEL_VUELO`, aun con `confirmar`; también
      GAS y TUAS con vuelo; moverse dentro del mes y REGRESAR al mes del
      vuelo sí se permiten; fuente única `candadoMesDelVuelo`); (7)
      confirmación (409 `FECHA_GASTO_CONFIRMAR` con el texto armado por el
      API y `details { cambia_de_mes, mes_antes, mes_despues,
      etiqueta_mes_despues, meses_terminados }`) cuando la fecha mueve un
      libro de mes o cambia el T.C. con que un libro convierte el gasto con
      un mes que ya terminó (mes < mes de hoy en Cancún): el del reparto
      (pesos sin `tc_gasto` con alcance) o el del bloque VUELATOUR del
      Balance general (sueltas en pesos de «otros movimientos», abajo); sin
      líneas de efecto (pago al vendedor con vuelo, PERSONAL_DUENO, cambio
      dentro del mes en curso) se guarda directo.
    - **La ficha del candidato lleva el candado** (`aCandidatoGasto` de
      Conciliación, ADITIVO 0.0.76): `candado_mes_vuelo { vuelo_dia,
      vuelo_folio }` SOLO cuando `candadoMesDelVuelo` aplica (la llave no
      viaja si no, como `tc_cruce`); `GASTO_RICO_COLS` pide `fecha_vuelo`
      en el embed del vuelo. El panel ya no invita («corrígela con
      «Fecha»») a mover la fecha a un mes que este candado rechaza y lo dice
      antes de guardar (revisión del 14-oct-2026; caso vivo: TAXI 64ef1bd8
      del vuelo #109 del 31-jul contra el cargo del Tren Maya del 10-ago).
      La IA recibe la llave de más y pydantic la ignora.
    - **Banda de fechas = la de oficina de `update()`**: el borde de 365
      días es el MISMO (`assertFechaRazonable` rechaza `dias < -365`; la
      ruta, `diasEntreDiasCancun(nueva, hoy) > 365`: 365 pasa y 366 no, las
      dos con la cuenta a mediodía UTC y el «hoy» de ICU America/Cancun) y
      hacia adelante la ruta es más estricta (≤ hoy contra +30). Como
      `update()` vuelve a leer el reloj, si la medianoche de Cancún cae entre
      la validación y la escritura una fecha de justo 365 días que la ruta
      ya aceptó saldría 400 con el texto del PATCH general («marca permitir
      fecha antigua», que en Conciliación no existe): la ruta pasa
      `permitir_fecha_antigua: true` (no es columna: `update()` la quita
      antes del UPDATE) para que esa banda no se re-evalúe con otro reloj.
      La banda del PATCH general NO se tocó.
    - **Los textos son ESPEJO de los libros**, no reglas nuevas: el balance
      por `ubicacionBalanceDeGasto` (invariante 72) y las sueltas de «otros
      movimientos» del general (`esSueltaOtrosMovimientos`: TUAS sin vuelo,
      con o sin avión, y GAS sin avión que ningún tramo ni vuelo resuelve y
      que no es de un externo sin avión — espejo de las tres lecturas de
      `buildOtrosMovimientos`), el reparto por los conjuntos del
      ternario de `computeAvion` —MUDADOS tal cual a
      `profit-sharing/grupos-reparto.util.ts` (DIRECTO, INDIRECTO, PERMISO,
      FIJO, TUAS_CAT; el ternario y el pool de FIJO no cambiaron)— y el
      Libro Dinero por sus dos lecturas por `fecha_gasto` («otros gastos»
      sin vuelo o de EMPRESA salvo PERSONAL_DUENO; todo GAS). Mover una
      categoría o una lectura obliga a tocar el util: la ALARMA DE PARIDAD
      de su spec lee `aircraft-balance.service.ts` (incluido
      `tcDeGastoSuelto` y las tres lecturas de sueltas),
      `dinero-report.service.ts` y `profit-sharing.service.ts` como texto.
      Si un libro cambia, solo puede desfasarse un TEXTO, nunca un número.
    - **`fecha_hora_carga`** (GAS con hora de carga) se mueve a la MISMA
      hora de pared Cancún del día nuevo (`moverDiasHoraParedCancun`, la
      regla de «Verificar / editar» y de la carga masiva); si ya cae en el
      día nuevo o no se puede leer, no se toca. No toca `verificado_*`,
      `medio_pago`, el monto ni los cargos ligados; la compra y la entrada
      a inventario conservan su fecha y su T.C. La bitácora
      (`tg_gasto_bitacora`) registra el antes/después con actor =
      `updated_by` (quien concilia) y el API deja un `logger.log`.
    - **La memoria del 13-oct («en los balances no cambia nada») es
      INCOMPLETA**: solo vale para el balance por avión de un gasto con
      vuelo. El reparto a socios (`fetchGastos`), la cuenta corriente y el
      Libro Dinero (gastos sin vuelo y GAS) cuentan por `fecha_gasto`, y el
      reparto convierte los pesos sin `tc_gasto` con el T.C. oficial del
      DÍA (septiembre: 16.8894 el 7-sep a 18.0243 el 30-sep, +6.7 %).
    - **Sueltas del bloque VUELATOUR (hueco CERRADO en la revisión del
      14-oct-2026)**: «otros movimientos» del Balance general convierte con
      el oficial de SU día las sueltas en pesos (`tcDeGastoSuelto`, que
      ignora `tc_gasto` en MXN). Moverlas dentro de un mes ya terminado se
      guardaba sin confirmar aunque al regenerar ese mes su bloque VUELATOUR
      cambiara (TUAS sin vuelo de $5,000 del 7 al 30 de septiembre: 296.04
      → 277.40 USD). Hoy, en pesos y con cambio de mes o un mes terminado,
      la confirmación suma «El balance general convierte este gasto a
      dólares con el tipo de cambio oficial del día del gasto: con la fecha
      nueva cambia lo que vale en dólares.» (nunca junto con la del reparto:
      TUAS y el gas sin avión no tienen alcance) y el gas sin avión, al
      cambiar de mes, dice también «En el balance general pasa a …». En
      dólares no hay línea (su USD no cambia).
    - **Skew**: panel nuevo con API ≤ 0.0.75 ⇒ 404 «Cannot PATCH
      /v1/expenses/<id>/fecha» (el panel lo traduce a RUTA_NO_DISPONIBLE y
      no escribe nada); API nuevo con panel viejo ⇒ nadie llama la ruta y
      `update()` se comporta igual. Orden: API ⇒ panel.
    - Specs: `cambio-fecha-gasto.util.spec` (fechas con el borde exacto,
      medios, candados en orden, los casos de prod Winjet 08c0632c,
      92bd5379 y b15080c3, todas las líneas de la confirmación con sus
      textos exactos, frontera Cancún, matrícula desconocida, tabla
      congelada de las 22 categorías, Libro Dinero, el candado de
      conciliado, `candadoMesDelVuelo` contra el 409, las sueltas del bloque
      VUELATOUR y la alarma de paridad),
      `grupos-reparto.util.spec` (membresía congelada; el servicio ya no
      declara los conjuntos), `expenses.service.cambio-fecha.spec` (lee con
      `GASTO_CAMBIO_FECHA_COLS`, UPDATE EXACTO `{ fecha_gasto, updated_by }`
      con CAS ±1 ms, cero consultas con fechas mal, 404/409 sin UPDATE
      —YA_CONCILIADO incluido—, CONFLICTO_VERSION,
      `fecha_hora_carga_movida` (movida y ya en el día nuevo), repartos
      solo de categorías repartibles,
      matrículas best-effort, el borde de 365 días del PATCH general sin
      tocar y la medianoche de Cancún a mitad de la petición; de CONTROL,
      el PATCH general de solo fecha SÍ dispara el auto-cruce) y
      `expenses.controller.cambio-fecha.spec` (HTTP real: roles, DTO
      estricto, code/details del filtro y `PATCH /:id` que sigue llegando a
      `update` con 4 argumentos) y, en Conciliación,
      `conciliacion.service.lote.spec` (`candado_mes_vuelo` en la ficha
      solo con candado y la `fecha_vuelo` del embed).
    - **Versión**: `package.json` = `0.0.76` desde la revisión del
      14-oct-2026 (`GET /v1/version` es la compuerta del panel).

75. **OMITIR LA CONCILIACIÓN (14-oct-2026, API 0.0.77, lote B, migración
    `20261014000002`).** Pedido del usuario con la captura de
    /admin/conciliacion: «Necesitamos una opción de pendientes de conciliar
    venga una opción de Omitir la conciliación.» Un movimiento del banco que
    la oficina decide NO conciliar (comisión o IVA del banco, cargo
    duplicado por el banco, prueba de la terminal…) deja de ser «pendiente»
    CON UN MOTIVO FIRMADO y se puede deshacer. Ningún número cambia: los
    movimientos bancarios no entran al dinero (invariante 33).
    - **Marca**: la clasificación CANÓNICA «Omitido de la conciliación»
      (por NOMBRE, sin distinguir mayúsculas ni espacios —`lower()` en la
      BD, `esClasificacionOmitida` en el API—; NO se siembra: la crea
      `conciliacion_clasificacion_omitido` en la primera omisión y la
      REACTIVA si está de baja) + `conciliado = true` + la línea firmada
      ARRIBA de las notas: «Omitido de la conciliación: <motivo> —
      <usuario>, dd-mmm-aaaa» (día Cancún; motivo 10–300 en UNA línea;
      firmante ≤ 80, sin nombre «Oficina»; la línea ≤ 500; lo que había
      queda debajo byte a byte). Fuente única PURA
      `conciliacion/omision.util.ts` (con spec): la línea
      (`lineaOmision`), su lectura (`leerOmision`, `omisionDeFila`), el
      espejo del UPDATE que deshace (`quitarLineaOmision`: solo la PRIMERA
      línea canónica; ida y vuelta byte a byte, `\r\n` incluido), el espejo
      del CASE de la RPC (`estadoMovimientoParaOmitir`: gasto > cobro >
      sobre > ingreso > reverso —también un cargo al que apunta una
      devolución— > omitido > clasificado > conciliado), el riesgo y TODOS
      los textos. El panel NO arma la línea ni decide el estado.
    - **Escritura SOLO por las RPC** (SECURITY INVOKER, `search_path ''`,
      23514 con `hint = CODIGO` y `detail` jsonb):
      `conciliacion_omitir_movimientos(ids, linea, actor)` — 1..200 sin
      repetir (LOTE_INVALIDO), línea canónica (OMISION_INVALIDA), FOR
      UPDATE por id, inexistentes ⇒ MOVIMIENTO_NO_EXISTE {ids} (el API los
      expone como `details.faltan`), TODO O NADA pendientes y libres ⇒
      MOVIMIENTO_NO_PENDIENTE {movimientos[{id, fecha, tipo, monto,
      descripcion, estado}]}, UN UPDATE —; `conciliacion_quitar_omision(ids,
      actor)` — mismas listas; todos deben tener la canónica
      (MOVIMIENTO_NO_OMITIDO; un omitido al que APUNTA una devolución sale
      con estado REVERSO y no se restaura —quedaría un par a medias—:
      `mensajeNoOmitidos` pide quitar primero el emparejamiento); vuelven a
      Pendientes sin la primera línea canónica (vacío ⇒ null); es el ÚNICO
      camino que le quita la omisión a un movimiento: abre el paso del
      trigger con `set_config('vt.quitar_omision', '1', true)` justo antes
      de su UPDATE y lo cierra ('') justo después. Interbloqueo (40P01) ⇒
      409 CONFLICTO_CONCURRENTE.
    - **Candado en BD** `trg_mov_bancario_omitido_sin_ligas` (BEFORE UPDATE
      OF gasto_id, gastos_n, cobro_id, cobros_n, cobro_grupo_id, ingreso_id,
      reverso_de_id, clasificacion_id, conciliado WHEN old.clasificacion_id
      is not null; no modifica NEW; las 9 columnas = `COLUMNAS_TRIGGER_OMITIDO`):
      un omitido NO recibe ninguna liga por ningún camino (RPC G, RPC de
      cobros por su UPDATE de sincronía, `cobro_id` directo, sobre,
      ingreso, `gasto_id` legado, reverso) y —revisión del 14-oct-2026— NO
      PIERDE la omisión por fuera de `conciliacion_quitar_omision` (otra
      clasificación, sin clasificación o `conciliado = false` sin su paso
      `vt.quitar_omision`: el «desvincular» de `linkCobro` —cobro_id null,
      conciliado false, clasificacion_id null— la borraba en silencio y
      dejaba su línea en las notas) ⇒ 23514 MOVIMIENTO_OMITIDO. Un SEGUNDO
      trigger, `trg_mov_bancario_reverso_omitido` (BEFORE INSERT OR UPDATE
      OF reverso_de_id WHEN new.reverso_de_id is not null; corre DESPUÉS de
      `trg_mov_bancario_reverso` por su nombre y lee el cargo FOR SHARE),
      frena emparejar una devolución con un CARGO omitido (el primero solo
      mira la fila que se actualiza, el abono) con el mismo código. Una
      clasificación que NO es la canónica se sigue pisando al ligar, como
      siempre. El API lo traduce a 409 en `errorRpcPartes`,
      `errorRpcCobros`, la rama 23514 de `linkCobro` (`mensajeErrorPartes`
      / `mensajeErrorCobros`), el UPDATE de «Clasificar» (409
      MOVIMIENTO_OMITIDO con el motivo) y el emparejado de reverso
      (`motivoTriggerReverso` ⇒ 409 REVERSO_INVALIDO «Uno de los dos
      movimientos se omitió de la conciliación: deshaz la omisión antes de
      emparejarlos.»), nunca 500. Borrar la fila canónica (ON DELETE SET
      NULL) no pasa por estos candados: nadie la borra (la reversa la deja
      inactiva).
    - **Rutas** (literales bajo `movimientos/`, ANTES de `movimientos/:id`;
      roles de la CLASE = `ROLES_CONCILIACION`; 200):
      `POST movimientos/omitir/revisar {movimiento_ids}` (SOLO LECTURA;
      funciona aun sin la migración) ⇒ `{movimientos[{id, fecha, tipo,
      monto, moneda, descripcion, cuenta_alias, estado, texto_estado,
      riesgo, texto_riesgo, candidatos_n}], no_existen, resumen {n,
      pendientes, no_pendientes, con_riesgo}}`;
      `POST movimientos/omitir {movimiento_ids, motivo, aceptar_riesgo_ids?}`
      ⇒ `{omitidos, clasificacion_id, movimientos}` (relectura con
      `omision`); `POST movimientos/quitar-omision {movimiento_ids}` ⇒
      `{restaurados, movimientos}`. DTO (`RevisarOmisionDto`,
      `OmitirMovimientosDto`, `QuitarOmisionDto`): 1..200 uuid sin repetir
      y el motivo recortado 10..300, con textos es-MX («Elige al menos un
      movimiento.», «El motivo debe tener al menos 10 caracteres.»…).
      Orden de `omitir`: sonda ⇒ filas (lotes de ≤ 150) ⇒ 404 ⇒ 409
      MOVIMIENTO_NO_PENDIENTE SIN llamar la RPC ⇒ 400
      ACEPTAR_RIESGO_INVALIDO (un aviso confirmado fuera de la selección) ⇒
      409 OMITIR_CON_RIESGO ⇒ la línea (`c.nombre`, `hoyCancun()`) ⇒ la
      RPC (re-exige el pendiente bajo FOR UPDATE: una carrera es su 409
      traducido) ⇒ relectura. `logger.log` con quién, cuántos y el motivo.
    - **Riesgo (falla CERRADO: lo que no se pudo revisar se confirma)**:
      CARGO ⇒ `anotarMotivoPendiente` sobre COPIAS (las MISMAS reglas del
      auto-cruce y del badge): SE_PUEDE_CRUZAR ⇒ GASTO_QUE_CUADRA, AMBIGUO
      ⇒ GASTOS_AMBIGUOS, sin anotar (lectura caída o truncada, cuenta sin
      moneda) ⇒ SIN_VERIFICAR; ABONO ⇒ `cobrosExactosLibresDeAbono` (≤ 5 en
      paralelo; PAGINADA por la PK con tope `TOPE_UNIVERSO` desde la revisión
      del 14-oct-2026 —con `.limit(1000)` un cobro exacto después de la fila
      1000 daba 0: omitir o ligar al ingreso sin aviso— y pasado el tope ⇒
      null) > 0 ⇒ COBRO_QUE_CUADRA, null o error ⇒ SIN_VERIFICAR, y
      `esDevolucionDeCargo` ⇒ DEVOLUCION; los dos ⇒ `patronTraspaso` ⇒
      TRASPASO. Prioridad GASTO_QUE_CUADRA > GASTOS_AMBIGUOS >
      COBRO_QUE_CUADRA > TRASPASO > DEVOLUCION > SIN_VERIFICAR. Cada
      movimiento con riesgo exige estar en `aceptar_riesgo_ids`.
    - **«Clasificar» endurecido** (`ClasificarMovimientoDto.
      esperado_clasificacion_id?: uuid | null`, 5.º parámetro OPCIONAL
      `{esperado, usuarioNombre}`; ausente = la conducta de siempre): (0) la
      canónica como destino ⇒ 400 USA_OMITIR antes de leer nada; (1) lee
      clasificación, conciliado, notas (+ `cobros_n` con su sonda); (2) con
      `esperado` distinto de lo vigente (o null y ya conciliado) ⇒ 409
      MOVIMIENTO_CAMBIO `{actual {conciliado, clasificacion_id,
      clasificacion}}`, ANTES de la rama del reverso; (3) reverso como
      siempre; (4) omitido (por el id de la canónica O por el NOMBRE
      embebido en la misma lectura: revisión del 14-oct-2026, sin depender
      del memo) + null ⇒ deshacer por la RPC; omitido + otra ⇒ 409
      MOVIMIENTO_OMITIDO con su motivo; (5) un lote de cobros (`cobros_n >
      0`) no se clasifica; la clasificación destino se lee con su `nombre`
      y la canónica por nombre ⇒ 400 USA_OMITIR (si la lectura del id cayó
      en (0)); (6) UPDATE con CAS sobre lo leído (`conciliado` +
      `clasificacion_id`): 0 filas ⇒ 409 MOVIMIENTO_CAMBIO; el 23514
      MOVIMIENTO_OMITIDO del trigger ⇒ 409 MOVIMIENTO_OMITIDO.
      La respuesta suma `omision: null`. El catálogo (`GET clasificaciones`)
      NO ofrece la canónica y `POST clasificaciones` con su nombre ⇒ 400
      USA_OMITIR sin insertar.
    - **Candados TS** (antes del trigger, con mejor texto; sin escribir):
      `ligarPartes` (al ligar; `leerMovimientoPartes` suma
      `clasificacion_id, notas` y el nombre embebido), `linkCobro` (ligar Y
      «desvincular»: su UPDATE pone `clasificacion_id = null` y borraría la
      omisión) y `ligarCobrosPorRpc` ⇒ 409 MOVIMIENTO_OMITIDO
      (`bloquearSiOmitido`, que desde la revisión del 14-oct-2026 decide
      PRIMERO por el NOMBRE de la clasificación embebido en la MISMA lectura
      —`clasificacion:conciliacion_clasificacion!clasificacion_id(nombre)`—
      y solo sin él por el id memorizado; una carrera o una lectura caída
      las frena el trigger); `linkIngreso` ⇒ el 409 MOVIMIENTO_YA_LIGADO de
      siempre con el motivo y `details.omitido: true`. Reversos, auto-cruce
      e Ingresos ya no tocan un movimiento clasificado/conciliado; el
      reintento «idempotente» del emparejado de reverso exige que el cargo
      siga como SU devolución (conciliado con «Reverso de un cargo» y sin
      otra liga; si no ⇒ 409 REVERSO_INVALIDO «El abono ya apunta a este
      cargo, pero el cargo ya no está como su devolución…») y un 40P01 al
      escribir el par (interbloqueo con «Omitir» de un lote) ⇒ 409
      CONFLICTO_CONCURRENTE (`conflictoConcurrenteReverso`), también en el
      emparejado automático (su `motivo`).
    - **Lectores (ADITIVOS)**: `GET movimientos` ⇒ cada fila con `omision:
      {motivo, por, fecha} | null` SIEMPRE (del embed de la clasificación y
      las notas: cero consultas; el panel detecta el API nuevo por la
      LLAVE) y `?solo_omitidos=true|1` (pestaña «Omitidos»: filtra en el
      API; sin la canónica ⇒ `{data: [], count: 0}` sin leer movimientos;
      lectura del id caída ⇒ 503 OMITIDOS_NO_DISPONIBLE, jamás un vacío
      falso); `GET resumen` ⇒ por cuenta `omitidos` y `monto_omitido` (Σ
      |monto| en la moneda de la cuenta; null si no se pudo leer la
      canónica — los «conciliados» los INCLUYEN); Excel de conciliación ⇒
      Estatus «Omitido», «Conciliado con» = `etiquetaOmisionReporte`
      («Omitido: Comisión o IVA del banco (Alejandro Canales,
      14-oct-2026)»), Notas sin la línea canónica y el subtítulo «N
      conciliados (M omitidos)» SOLO con M > 0 (sin omitidos, byte a
      byte); auditoría Paywise ⇒ los abonos omitidos fuera del universo y
      el conteo `resumen.movimientos_omitidos` (null si no se pudo leer la
      canónica). El id de la canónica: `leerIdClasificacionOmitido` (por
      NOMBRE, memo POSITIVO de 10 min; `fallo` ≠ «no existe»).
    - **Pre-cierre**: renglón INFORMATIVO `movimientos_omitidos`
      («Movimientos del banco omitidos de la conciliación», `count`,
      `monto_mxn`, `monto_usd`, `informativo: true`) JUSTO después de
      `sin_conciliar`, fuera de `bloqueantes`; lo calcula
      `ConciliacionService.omitidosDelPeriodo(desde, hasta)` (fecha DATE
      del movimiento, paginado, NUNCA lanza; una cuenta sin moneda ⇒ null)
      con el patrón de `ligasUsdTcPrecierre` (stub sin el método, null o
      excepción ⇒ `lectura_fallida: true` y «No se pudo leer cuántos
      movimientos se omitieron.»).
    - **Sonda ÚNICA** `common/omision-cargos-disponible.util.ts` (la
      comparte la invariante 76): llama `conciliacion_omitir_movimientos`
      con la lista VACÍA ⇒ 23514 LOTE_INVALIDO (o sin error) ⇒ «sí» PARA
      SIEMPRE; PGRST202 o un «function … does not exist» que NOMBRA una de
      sus RPC (`esOmisionCargosAusente`; un «operator does not exist» es un
      BUG de plpgsql, no la migración ausente) ⇒ «no», re-sondeo ≤ 10 min
      (se enciende sola al aplicarla) y un solo `warn`; otro error o
      excepción ⇒ «sí» SIN memorizar. Sin la migración: omitir / deshacer
      ⇒ 503 `CONCILIACION_OMITIR_NO_DISPONIBLE` («Esta opción todavía no
      está activa: avisa a sistemas.», `details.migracion`) y TODO lo demás
      como el 0.0.76. Tras la reversa de la migración hay que REINICIAR el
      API (el «sí» se memoriza).
    - **De paso** (revisión del mismo lote): `anotarMotivoPendiente` lee los
      gastos PAGINADOS por la PK (`leerPaginado`, tope
      `MOTIVO_GASTOS_MAX`): el `.limit()` de antes lo cortaba PostgREST en
      1000 sin avisar y anotaba con una foto recortada.
    - Specs: `omision.util.spec`, `omision-cargos-disponible.util.spec`,
      `omision-cargos.paridad.spec` (lee el ARCHIVO SQL: nombre canónico,
      prefijo, topes, las 9 columnas del trigger, el orden del CASE, los
      códigos que el API traduce —también el del trigger del cargo omitido
      por `motivoTriggerReverso`—, el paso `vt.quitar_omision` abierto y
      cerrado alrededor del UPDATE del deshacer, el estado REVERSO primero
      en su CASE, todo SECURITY INVOKER con `search_path ''` y ni una
      palabra que el MCP decline),
      `conciliacion.service.omitir.spec` (PostgREST falso con CAS y embeds
      + las RPC emuladas en `omision-cargos.fixture-spec.ts`: la línea
      exacta y las notas de vuelta byte a byte, 404/409/400/503 sin
      escribir, riesgos y su confirmación —el cobro exacto después de la
      fila 1,000 y más de 3,000 candidatos ⇒ SIN_VERIFICAR—, carreras de la
      RPC, revisar, deshacer, lista/resumen/Excel/Paywise, clasificar con
      `esperado` y CAS, candados de gasto/cobro/ingreso y el trigger,
      pre-cierre), `conciliacion.service.reverso.spec` (el reintento sobre
      un cargo que ya no es la devolución ⇒ 409; 40P01 ⇒ 409
      CONFLICTO_CONCURRENTE; el trigger del cargo omitido ⇒ 409 legible),
      `conciliacion.controller.omitir.spec` (HTTP real: rutas, roles, DTO,
      `esperado`, `?solo_omitidos`) y
      `profit-sharing.service.pre-cierre-omitidos.spec`.

76. **VARIOS CARGOS → UN GASTO (14-oct-2026, API 0.0.77, lote B, migración
    `20261014000002`).** Pedido del usuario con la captura de
    /admin/conciliacion: «necesitamos poder seleccionar varias filas de
    conciliaciones pendientes para todo eso ponerlas a un solo gasto, si no
    existe el gasto que permita crearlo por la cantidad de la suma». Es el
    sentido 1 gasto ↔ N cargos de la invariante 40 (la puente
    `movimiento_bancario_gasto`), ahora de un golpe y con la SUMA calculada
    por el API. Jamás se encadena la RPC G de un cargo para N cargos.
    - **Regla y textos PUROS** en `conciliacion/cargos-a-gasto.util.ts`
      (con spec): `resultadoCargosSobreGasto` (en CENTAVOS, tolerancia
      `TOLERANCIA_CONCILIACION` = 1.00 sobre lo que le FALTA al gasto:
      |Σ − faltante| ≤ 1.00 ⇒ CUBRE; Σ < faltante − 1.00 ⇒ PARCIAL
      `faltante_tras`; si no ⇒ EXCEDE `excedente`),
      `ordenarCandidatosPorSuma` (CUBRE → PARCIAL → EXCEDE; |faltante − Σ|;
      distancia de la fecha al rango de los cargos; fecha desc; id),
      `terminacionComun`, `validarCargosParaGasto` (espejo de la RPC con
      sus códigos y su ORDEN) y los mensajes («Los 3 cargos suman $9,700.00
      y al gasto le faltan $9,591.49 (vale $9,591.49): se pasarían por
      $108.51 (tolerancia $1.00). Revisa la selección o el monto del
      gasto.», etc.).
    - **`POST cargos/gastos-candidatos`** (SOLO LECTURA; roles de la clase;
      `CargosGastosCandidatosDto {movimiento_ids 2..50, q?, dias 1..180 =
      30, limite 1..300 = 100}`) ⇒ `{cargos {ids, n, suma, moneda,
      fecha_min, fecha_max, cuentas[{id, alias}], terminacion_comun},
      ventana, candidatos (ficha de `aCandidatoGasto` + no_bancario,
      resultado, faltante_tras, excedente), truncado,
      cargos_con_candidato_propio [{id, motivo, candidatos_n}] | null,
      excluidos?, excluidos_monto?}`. Valida como la RPC (404, SOLO_CARGOS,
      MOVIMIENTO_NO_PENDIENTE —acción «vincular»—, CARGOS_MONEDA_DISTINTA;
      cuenta sin moneda ⇒ 503 CUENTA_SIN_MONEDA; sin partes ⇒ 503). El
      UNIVERSO es el MISMO lector de «Vincular gasto» de un cargo
      (`leerUniversoGastos` + `orTextoBusquedaGasto`, EXTRAÍDOS de
      `gastosCandidatosDeMovimiento` sin cambio de conducta: bancarios, sin
      conciliar, moneda de las cuentas, la búsqueda de siempre, tope 1,000
      ⇒ `truncado`) en `[fecha_min − dias, fecha_max + dias]`; los cruzados
      (USD contra cuenta MXN) NO entran. `cargos_con_candidato_propio` =
      `anotarMotivoPendiente` sobre COPIAS (null si alguno no se pudo
      anotar: jamás un «ninguno» falso). `excluidos` + `excluidos_monto`
      SIEMPRE (`excluidosDeCandidatos` con el monto = Σ o el de `q`;
      revisión del 14-oct-2026: antes solo con la lista vacía, y un gasto
      bancario cualquiera del mismo monto escondía el COMIDA de $400 en
      EFECTIVO o el gasto ya conciliado contra otro cargo que «Créalo por la
      suma» duplicaría; en prod 123 de 282 gastos no bancarios y 97 de 537
      conciliados tienen un bancario sin conciliar del mismo monto a ±120
      días). UNA consulta acotada por monto y fechas; si falla, sin la
      llave (warn). `crearConCargos` NO revisa duplicados: el panel hace el
      paso de duplicados (`q` = la suma, `dias` 120) y enseña `excluidos`.
    - **`POST gastos/:id/cargos {movimiento_ids 2..50}`** (otro MÉTODO que
      `GET gastos/:id`; `:id` con ParseUUIDPipe) ⇒ `{gasto_id,
      idempotente, nuevos, partes[{movimiento_id, monto_parte, moneda}],
      gasto_estado {monto, moneda, n_partes, monto_vinculado, faltante,
      cubierto}, movimientos}` (relectura con `omision`). SOLO por la RPC
      `conciliacion_ligar_cargos_a_gasto(gasto, ids, actor)` (SECURITY
      INVOKER): cargos FOR UPDATE por id y DESPUÉS el gasto (mismo orden
      global que la RPC G y el trigger A); MOVIMIENTO_NO_EXISTE, SOLO_CARGOS
      {abonos}, los ya ligados a ESTE gasto como su única parte = reenvío
      IDEMPOTENTE, los demás pendientes y libres (MOVIMIENTO_NO_PENDIENTE
      con OMITIDO incluido), una moneda de cuenta (CARGOS_MONEDA_DISTINTA),
      GASTO_NO_EXISTE, moneda del gasto = la de los cargos
      (LOTE_MONEDA_DISTINTA: un USD pagado en pesos va con UN cargo), medio
      ∈ `MEDIOS_BANCARIOS` en el MISMO orden (GASTO_NO_BANCARIO; BODEGA ⇒
      409 GASTO_BODEGA con el texto de siempre), parte cruzada previa ⇒
      GASTO_YA_CUBIERTO (MONEDA_DISTINTA), Σ ligado + Σ nuevos ≤ monto +
      1.00 (CARGOS_EXCEDEN_GASTO); UN INSERT … SELECT de UNA parte por
      cargo ENTERO (`abs(monto)`): los triggers A/B/K de siempre validan y
      recalculan y `gasto.conciliado` lo escribe SOLO
      `recalcular_gasto_conciliado`. Los textos salen de los helpers, nunca
      del texto de la BD; MOVIMIENTO_NO_PENDIENTE relee la moneda de cada
      cuenta (best-effort). 40P01 ⇒ 409 CONFLICTO_CONCURRENTE; PGRST202 ⇒
      503 `CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE`; la sonda (la de la
      invariante 75) en «no» ⇒ el mismo 503 sin llamar la RPC.
    - **«Créalo por la suma»**: `POST /v1/expenses` con
      `CreateGastoDto.conciliar_con_movimientos?: uuid[]` (2..50 sin
      repetir; ADITIVO). Controller: el campo con valor (`!= null`: `null`
      = ausente, el MISMO criterio de `create()`; revisión del 14-oct-2026,
      antes `!== undefined` daba 403 a un alta normal con la llave en null)
      y el rol fuera de `ROLES_CONCILIACION` ⇒ 403
      CONCILIAR_SOLO_ADMIN_FACTURACION antes del servicio. Servicio
      (`create` ⇒ `crearConCargos`; `null` = ausente): (1) refacción a
      Inventario ⇒ 400 INVENTARIO_NO_DESDE_CARGOS; (2) sin
      `client_request_id` ⇒ 400 CLIENT_REQUEST_ID_REQUERIDO; (3) sin el
      módulo de conciliación o la sonda en «no» ⇒ 503 sin crear; (4)
      REPLAY: la llave ya creó un gasto ⇒ con los MISMOS monto, moneda y
      medio, la RPC (idempotente) y `idempotente: true` (si falla, NO se
      retira nada: el error sale con `details.gasto_id`); con otros datos
      ⇒ 409 CLIENT_REQUEST_ID_EN_USO; (5) prevalidación PURA
      (`prevalidarCargosParaGastoNuevo` ⇒ `validarCargosParaGasto`) ⇒ los
      4xx con «No se registró el gasto: » y SIN crear; (6) el alta por
      `crearGastoInterno(…, {autoCruce: false})`, que devuelve `{data,
      despues, replay}` —`despues` = lo que el alta hace tras el insert en
      su orden de SIEMPRE: aviso de matrícula, aviso de combustible
      corregido, lectura IA offline, auto-cruce y «gasto_registrado»— SIN
      ejecutarlo (un 23505 de la llave ⇒ el replay de (4)); (7)
      `ligarCargosAGasto(…, {accion: 'crear'})` (los textos de validación
      ya con el prefijo); bien ⇒ corre `despues` y responde 201 = el gasto
      RELEÍDO (`conciliado` ya recalculado por la BD) + `conciliacion
      {movimiento_ids, idempotente, partes, gasto_estado}`; (8) mal ⇒
      `remove` del gasto y el error relanzado con «No se registró el
      gasto: » y `details.compensado: true` (un error que no es HTTP ⇒ 500
      GASTO_NO_REGISTRADO con `details.tecnico`); (9) si el retiro también
      falla ⇒ 500 GASTO_SIN_VINCULAR {gasto_id} («…vuelve a pulsar
      «Guardar» para reintentar la liga (no se duplica)…»: el reintento
      con la misma llave es el replay). `crearGasto` = `crearGastoInterno`
      + correr `despues` de inmediato: el alta de siempre (app, panel,
      carga masiva) es byte a byte la de antes, avisos y auto-cruce en su
      orden. PATCH con la llave ⇒ 400 CONCILIAR_SOLO_AL_CREAR antes de
      tocar nada (junto al rebote de `inventario`).
    - Specs: `cargos-a-gasto.util.spec`, `omision-cargos.paridad.spec`
      (topes 2..50, tolerancia 1.00, MEDIOS en el mismo orden, códigos),
      `conciliacion.service.cargos-gasto.spec` (suma y orden, ventana,
      pagos previos, búsqueda, terminación común, cargos con su propio
      gasto, excluidos —también CON candidatos: el efectivo y el ya
      conciliado del mismo monto—, rechazos en el orden de la RPC, la liga
      con UNA llamada y sin la G, idempotente, parciales, cada código con su
      texto, omitido, interbloqueo, un 42883 que NO es «migración ausente»,
      sin la migración, `accion: 'crear'`, prevalidación),
      `conciliacion.controller.cargos-gasto.spec` (HTTP real),
      `expenses.service.crear-con-cargos.spec` (PostgREST falso: alta de
      siempre con auto-cruce y aviso; alta por la suma sin auto-cruce y con
      el aviso DESPUÉS de la liga; rechazos sin crear; compensación,
      GASTO_NO_REGISTRADO y GASTO_SIN_VINCULAR; replay, llave en uso,
      carrera 23505; PATCH) y `expenses.controller.crear-con-cargos.spec`
      (403 a quien no concilia, la llave en `null` = ausente para cualquier
      rol, DTO).

77. **UN COBRO, VARIOS ABONOS: «CONCILIADO» = CUBIERTO (14-oct-2026, API
    0.0.78, migración `20261014000003`, por el SQL Editor).** Pedido del
    cliente: «que un cobro acepte varios abonos, el aviso de «Conciliado
    parcial», la alerta al vincular un abono de otro monto y la de «cobrado de
    más» en la card». Casos reales: #315/#332 (dos camionetas de $1,700 contra
    un cobro de $3,400; $69,183 = $68,205.55 + $977.45 con el cobro del #315
    editado a $69,183), #254/#255 y #277/#278. Hasta el 0.0.77 la puente
    admitía UN abono por cobro (índice único): el segundo SPEI se quedaba
    pendiente o se ligaba a otro cobro, y un cobro con un abono de la mitad
    decía «Conciliado».
    - **Modelo** (BD): la puente `movimiento_bancario_cobro` pasa a M:N (sin
      `uq_mov_cobro_parte_cobro` ni `uq_mov_bancario_cobro`; índice
      `idx_mov_cobro_parte_cobro (cobro_id, movimiento_id)`; la FK al cobro
      sigue RESTRICT). `monto_parte` va en la moneda de la CUENTA del abono:
      con UN cobro = |abono|; en un lote = el FALTANTE del cobro fuera de ese
      abono. Neto = `neto_de_cobro` (monto − comisión capturada si > 0; si no
      da positivo, monto). CUBIERTO = `regla_cobro_cubierto` (cruzado ⇒ sí;
      sin abonos ⇒ no; neto ≤ 0 ⇒ sí; Σ partes de su moneda + 1e-6 ≥ neto −
      1.00). Estados: CONCILIADO · PARCIAL · VIA_ANTICIPO · SIN_CONCILIAR ·
      NO_BANCARIO; `conciliado` = CONCILIADO o VIA_ANTICIPO (un parcial ya NO
      dice «Conciliado»). La vista `v_cobro_conciliacion` (security_invoker)
      es la definición SQL para VERIFICAR: el API NO la lee. Sin columnas
      nuevas ni backfill (las 57 partes de prod cumplen la regla nueva).
    - **Espejo TS ÚNICO** `common/cobro-banco.util.ts` (PURO): `netoDeCobro`
      (mudado desde `conciliacion/cobros-lote.util`, que lo re-exporta;
      candidatos, «Cobros sin banco» y `entradaDeCobro` de Ingresos ya no
      restan por su cuenta), `cubreCobro`, `coberturaCobro`,
      `faltanteFueraDe`, `estadoBancoCobro`, `cobroCubiertoEnBanco`,
      `tcImplicitoCobro`, `alVincularAbono` (el trigger A en su MISMO orden),
      `cambiaDineroDelCobro`, `cobroDeUnSoloAbono` (con el método PAYWISE) y
      `cobroDeUnSoloAbonoSegunA` (la regla de A sola: la de los frenos). El
      API calcula desde la
      puente de 20261012000002: sus LECTURAS no dependen de la migración.
      `cobro-banco.paridad.spec` lee el archivo SQL; la paridad también se
      corrió contra PostgreSQL 17.2 real con las funciones de la migración
      (1,500 casos, 0 diferencias). `cobro-conciliado.util`
      (`movimientoDeCobro`, `cobroEstaConciliado`, `conciliacionDeCobro` y el
      nuevo `movimientosDeCobro`) sigue diciendo «tiene liga y por dónde»: es
      el criterio del CANDADO de dinero (un parcial también está ligado),
      JAMÁS el del estado. Lector único (invariante 56): la puente es la
      FUENTE, PAGINADA por (cobro_id, movimiento_id) con el abono embebido y
      PRIMERO en `unirLigas`; `partesDeLigas` saca las partes de lo ya leído y
      `leerPartesDeCobros` lee solo partes; el espejo y `partesDeAbonos`
      también paginan por la PK. Nadie lee `movimiento_bancario_cobro` ni la
      vista por su cuenta, salvo `contextoAbonos` (el universo de la puente
      paginado por la misma llave; truncado ⇒ `completo = false`: falla
      CERRADO).
    - **Reglas al ligar** (BD: trigger A por COBRO con el cobro bloqueado `for
      update` y la RPC G para lotes; API: pre-validación con el MISMO código y
      `details` —`puedeLigarCobros`, con UN cobro vía `prevalidarCobroUnico`
      (la cobertura de sus OTROS abonos) o con el lote de `cobro_ids`—). Banco
      sin comisión y en la moneda del cobro: abono MENOR que lo que falta ⇒
      PARCIAL (permitido, sin bandera; el panel confirma); MAYOR que lo que
      falta + $1.00 ⇒ 409 `ABONO_EXCEDE_COBRO` (también el PRIMER abono) con
      `sugeridos[≤ 3]` del API (`sugeridosParaExcedente`: cobros libres de la
      cuenta, en su moneda, a ±60 días, cuyo faltante es el excedente ±$0.02).
      Cobro con comisión capturada o abono de una cuenta PASARELA ⇒ UN abono =
      neto ± $1.00: abono > monto + $1.00 ⇒ `ABONO_EXCEDE_COBRO` (`un_solo:
      true`); si no cuadra ⇒ `COMISION_NO_CUADRA` (`comision_real`,
      `corregible`). `corregir_comision: true` en el PATCH (booleano ESTRICTO
      del cuerpo, patrón `solo_enriquecer`: el texto `"false"` no es true;
      el texto del 409 no nombra ese botón —«Corrige la comisión del cobro
      antes de vincular.»—, API 0.0.79: el 409 también lo ve quien no lo
      tiene a la mano)
      escribe la comisión real r2(monto − |abono|) con `escribirComisionReal`
      y liga (si la liga falla después, la comisión QUEDA y
      `details.comision_corregida` lo dice) SOLO si el veredicto SIN corregir
      es COMISION_NO_CUADRA y la comisión real vale (= `corregible`):
      `decidirCorregirComision` (PURO, `cobros-lote.util`) decide ANTES de
      escribir, en los dos caminos (revisión del 15-oct-2026; ENDURECE D6:
      antes un pago PARCIAL de banco se volvía una comisión de hasta 99.99 %
      y la PARTE de un sobre por `cobro_ids` quedaba con la comisión escrita
      aunque la liga rebotara COBRO_DE_GRUPO). No aplica ⇒ 400
      `CORREGIR_COMISION_NO_APLICA` (`motivo` VARIOS_COBROS | SOBRE |
      CON_ABONOS | DEPOSITO_MAYOR | SIN_COBRO | MONEDA_DISTINTA |
      DEPOSITO_INVALIDO | PARCIAL —banco sin comisión: es un pago en partes—
      | NO_HACE_FALTA —ya cuadra—); la liga rechazada por otra cosa (parte de
      un sobre, anticipo, reembolso, abono de más) ⇒ ESE 409/400, el mismo
      que sin la bandera, sin escribir (desviación de la letra de D6, que
      pedía 400 también ahí: así ya respondía el camino directo). Sin tope
      de % en el servidor: el aviso de > 15 % es del panel (D6). Otra moneda
      ⇒ 1↔1 y nunca en lote: banda 15–25 en BD
      (`COBRO_MONEDA_DISTINTA`, motivo TC_FUERA_DE_BANDA) y ±2 %
      (`TOLERANCIA_TC_OFICIAL_PCT`) del T.C. del cobro o, sin él, del vuelo en
      el API (TC_LEJOS). Cubierto, o «de un solo abono» con otro ⇒
      `COBRO_YA_CONCILIADO` (`details.motivo` CUBIERTO | UN_SOLO_ABONO). Lote
      (N ≥ 2) por FALTANTE, en la moneda de la cuenta y con
      `tolerancia_lote(N)`. Sobre en cuenta BANCO de su moneda ⇒ |abono| =
      neto del sobre ± $1.00 o `SOBRE_NO_CUADRA` (SOLO en el API). Sobres,
      anticipos e ingresos siguen 1↔1 con su abono (pagados con varios abonos:
      fuera de alcance); un reembolso o el cobro de un anticipo nunca se
      ligan. Los mensajes nuevos de la BD terminan con la marca
      `[ABONO_NO_CUADRA]` (`TOKEN_ABONO_NO_CUADRA`, con un espacio antes: un
      API ≤ 0.0.77 responde 409, no 500); el API lee el hint
      (`leerErrorCobros`) y retira la marca. `SOLO_ABONOS` también en el
      camino directo (después de los 409 de siempre) y una cuenta sin moneda ⇒
      503 `CUENTA_SIN_MONEDA` también en el camino directo y en el del sobre.
      Con la puente la respuesta es SIEMPRE `respuestaCobros` (fila releída +
      `cobros_estado[]` con `cobro_estado`, `cobro_neto`,
      `cobro_monto_vinculado`, `cobro_faltante` y `cobro_abonos_n`; si la
      relectura falla, la fila del UPDATE); `linkCobro(…, {respuesta: false})`
      es INTERNO (auto-cruce y Paywise: no releen).
    - **Candados**: E (`trg_cobro_vuelo_abonos_candado`, BEFORE UPDATE OF
      monto, moneda, comision_banco_monto, cobro_grupo_id,
      ingreso_anticipo_id; SECURITY DEFINER sin EXECUTE para
      anon/authenticated): con abonos no cambian monto, moneda, comisión,
      sobre ni anticipo (23514 `COBRO_CONCILIADO` {cobro_id, abonos, campos[],
      movimiento_ids[]}). El API decide antes en `updateCobro` con
      `cambiaDineroDelCobro` (valor NUEVO contra VIGENTE) ⇒ 409
      `COBRO_CONCILIADO` ESTRUCTURADO {cobro_id, estado,
      movimientos_ligados[{movimiento_id, fecha, monto_parte, cuenta}],
      parcial, faltante} (+ `via: 'SOBRE'` en un sobre; el texto de
      `mensajeCobroConciliado` por caso) y CONGELA el dinero reenviado sin
      cambio (no recalcula la comisión desde el % de 4 decimales, que movería
      un centavo contra E; ese reenvío ya no dispara el aviso de transición
      del 0.0.77). Carrera: E en el UPDATE o la FK RESTRICT (23503/23001) en
      el DELETE ⇒ el MISMO 409 releído, nunca 500. D: con UNO o más cobros el
      abono no cambia tipo, monto ni cuenta (`ABONO_LIGADO`; antes solo un
      lote). K (diferido, escucha también monto y cuenta): UN cobro ⇒ parte =
      |abono|; lote ⇒ moneda de la cuenta y Σ en tolerancia. Desvincular =
      soltar el ABONO: los otros abonos del cobro siguen (queda PARCIAL, o
      SIN_CONCILIAR sin ninguno) y la respuesta trae
      `cobros_liberados[{cobro_id, folio, estado, faltante, abonos_n}]` con el
      estado DESPUÉS (best-effort).
    - **Auto-cruce** (`autoMatchAbono`, con la puente Y la sonda): UN universo
      —cobros sin abonos por neto/bruto + parciales de BANCO por su FALTANTE
      exacto al centavo—; la cobertura de la ventana se lee ANTES del filtro
      de monto (`leerPartesDeCobros`; si falla ⇒ ERROR y el abono sigue
      pendiente) y la ocupación es UNA regla, `cobroParaCruce` (sobre
      `cobroOcupadoParaAbono`, la de candidatos y sugeridos): cubierto,
      cruzado, abono de la pasarela o «de un solo abono» (`cobroDeUnSoloAbono`
      también cuenta el MÉTODO PAYWISE: el auto nunca completa ese parcial; a
      mano sí; los FRENOS no, ver abajo) ⇒ ocupado. Un parcial que gana solo ⇒
      criterio `FALTANTE`;
      empate ⇒ nombre del ordenante o AMBIGUO; nunca crea un parcial. La IA de
      abonos no recibe parciales y, si un parcial espera EXACTAMENTE ese
      abono, su REGISTRAR_INGRESO o LIGAR a un ingreso pasa a REVISAR (la
      guarda D12 lee los candidatos con la regla del FRENO: también el
      parcial Paywise sin comisión con un SPEI de banco; API 0.0.79). Anti
      doble conteo: `cobrosExactosLibresDeAbono` (riesgo de «Omitir» y freno
      de ligar a un ingreso; un abono de la pasarela no completa parciales;
      sus sondas solo corren si algún neto rebasa el abono) y
      `cobrosQueCuadranConAbono` de Ingresos (409
      `ABONO_TIENE_COBRO_CANDIDATO` en «otro ingreso» y en «Es el pago de un
      vuelo»; faltante ±$1.00; el candidato parcial gana `parcial`,
      `faltante`, `monto_vinculado` y `abonos_n`; uno que cuadra solo por el
      MONTO y cuya liga directa rebotaría —comisión capturada o abono de la
      pasarela: solo se liga por su neto ± $1.00— gana `liga_no_cuadra`
      (COMISION_NO_CUADRA | SOBRE_NO_CUADRA, `ligaCandidatoNoCuadra`) y
      `comision_real`, y el 409 pide corregir la comisión
      (`mensajeAbonoCuadraSoloPorMonto`) en vez de «vincúlalo» —API 0.0.79,
      el freno sigue frenando—; los demás, byte a byte)
      cuentan el faltante de los parciales con `cobroParaCruce(…, {freno:
      true})`: «de un solo abono» por la regla del trigger A tal cual
      (`cobroDeUnSoloAbonoSegunA`: comisión capturada, parte de la pasarela
      o cruzada), SIN el método PAYWISE, que solo decide si el AUTO liga
      (revisión del 15-oct-2026: un cobro Paywise sin comisión con un SPEI
      de banco sí acepta el 2.º SPEI en la BD y antes ese dinero pasaba como
      «otro ingreso»). Límite HEREDADO (no se cambió): los frenos miran
      ±30 días por `fecha_cobro`; un parcial registrado antes no frena
      («Vincular» sí lo ofrece: ±60). «Por conciliar» (`contextoAbonos`) es
      el espejo del AUTO: cada cobro candidato lleva además su vista de FRENO
      (`freno`, `vistaFrenoCandidato` ⇒ `manualesFreno`) y con ella deciden
      `cobrosExactos` (el espejo de `cobrosExactosLibresDeAbono`),
      `exactos_manual` y la guarda D12 de la IA; los candidatos que se le
      ENVÍAN a la IA siguen con la regla de ligar (sin parciales; API
      0.0.79: antes las tres decidían con la regla de ligar y un parcial
      Paywise sin comisión quedaba «Se puede cruzar» mientras el auto lo
      dejaba AMBIGUO). El replay de «Es el
      pago de un
      vuelo» usa `some()` y ese camino pre-valida con `alVincularAbono` ANTES
      de `createCobro` (409 `COMISION_NO_CUADRA` con
      `mensajeComisionAlRegistrarCobro`, sin crear el cobro). «Por conciliar»
      (`contextoAbonos`): ocupado por cobertura y `montoExactoAbono` /
      `difMontoAbono` contra el faltante. Paywise: BRUTO sin comisión del
      archivo infiere la comisión real (`comisionRealDeCruce`) y la escribe
      (`escribirComisionReal`) antes de ligar SOLO si con ella el abono cuadra
      (`comisionAEscribirEnCruce` / `cruceCuadraConComision`, la regla de A
      para un abono de la pasarela; revisión del 15-oct-2026): si no —NETO
      exacto con un bruto del archivo distinto del cobro, o una comisión
      directa que no es bruto − neto— NO se escribe, se liga con la vigente
      (warn) y la diferencia queda en la auditoría (`comision_distinta`); si
      tampoco cuadra, la liga rebota SIN haber escrito nada (antes la del
      archivo quedaba escrita y el par dejaba de cuadrar). Un abono de lote
      no es «libre»
      (`movimientos_en_lote`); su universo sigue tomando cualquier liga como
      ocupada (un cobro de la pasarela es «de un solo abono»).
    - **Lecturas** (de la puente, también SIN la migración): cobros del vuelo
      (`adjuntarSobres`: card y snapshot) con `conciliacion_estado`,
      `ligado_banco` (el criterio del candado), `neto_banco`,
      `monto_vinculado`, `faltante`, `sobrante` y `abonos_banco[]` por
      antigüedad (OMITIDO para PILOTO/MECANICO/VISITANTE: `listCobros(vueloId,
      current)`; `movimiento_bancario_id` = el abono más antiguo); candidatos
      (`GET movimientos/:id/candidatos-cobro`) con el parcial por su faltante
      (`parcial`, `monto_vinculado`, `faltante`, `abonos_n`, `abonos[]`,
      `dif_monto` contra el faltante; la pasarela no recibe parciales),
      `al_vincular` (cobro: el de `alVincularAbono` + `sugeridos[]` en EXCEDE,
      y el sugerido que no entró en los 60 va al final; sobre: CONCILIADO |
      SOBRE_NO_CUADRA) y las capacidades `movimiento.cobros_parciales`,
      `tipo_cuenta` y `corregir_comision`; bandeja (`anotarCobrosDeAbonos`,
      antes `anotarCobrosLote`; dos fases best-effort) con
      `cobros[i].cobro_estado/cobro_neto/cobro_faltante/cobro_abonos_n` en un
      lote y `cobro_conciliacion` {cobro_id, folio, estado, neto,
      monto_vinculado, faltante, sobrante, abonos_n, faltante_sin_este,
      abonos[]} en un abono de UN cobro; «Cobros sin banco» = los NO cubiertos
      (`parcial`, `monto_vinculado`, `faltante`, `abonos_n`, `abonos[]`; raíz
      `parciales`; `por_moneda[i]` Σ faltante; si la lectura falla, se lanza);
      pre-cierre `cobros_bancarios_sin_conciliar` con `parciales` y por cobro
      `parcial`/`faltante`/`monto_vinculado` (la frase del detalle SOLO con
      parciales > 0); lista de Ingresos: un parcial sigue SIN_CONCILIAR con
      `conciliacion.parcial` {monto_vinculado, faltante, abonos_n}; Excel de
      conciliación «Conciliado con» con la cobertura
      (`etiquetaConciliadoCobroUnico`: «… · pago parcial: este abono $1,700.00
      de $3,400.00 (faltan $1,700.00)», «… · 2 de 2 abonos ($3,400.00
      cubierto)», «… · el abono trae $977.45 de más»; en un lote «vuelo #278
      ($18,001.00 de $28,001.00 · completa el cobro)»; UNA lectura, y si falla
      el reporte se tumba).
    - **«Cobrado de más»** (`common/cobrado-de-mas.util.ts`, PURO): excedente
      = `sobrecobroUsd` (la cifra que el balance manda a «otros movimientos»)
      y solo avisa si `pendienteCobro(cobrado, total) > 0` (argumentos al
      revés a propósito: lo que sobra por más de `TOLERANCIA_COBRO_USD` =
      $1.00); lo cobrado = `cobrosEnUsd` con la cadena de T.C. de quien llama
      (`entradaCobradoDeMas`), total e IVA = `particionIngresoVuelo`; null en
      un vuelo CANCELADO, con cotización abierta o con total ≤ 0. Causa
      ordenada SOBRE_DE_GRUPO → COMISION_PAGADA_POR_CLIENTE → IVA_NO_COTIZADO
      → COBRO_DUPLICADO → REDONDEO_TC (exige un cobro en pesos que SÍ
      convirtió) → OTRO_VUELO_DEL_CLIENTE (solo snapshot, best-effort y solo
      si quedaría SIN_CAUSA_CLARA: vuelos vivos del cliente paginados, sus
      cobros bancarios en lotes de 150 a ±30 días Cancún, sin liga del banco,
      sin sobre ni anticipo; EXACTAMENTE uno ±$1.00; si falla, SIN_CAUSA_CLARA
      con un warn) → SIN_CAUSA_CLARA; comparaciones en centavos;
      `requiere_revision` falso solo en comisión y redondeo. Textos con
      `fmtDineroTexto` (montos enteros sin decimales: «Cobrado de más: $52
      USD»). Snapshot: `cobrado_de_mas` justo después de `cobros_sin_tc_mxn`
      (null = VERIFICADO y sin aviso; la llave se OMITE si falló la lectura
      de la fila de precios —con un warn; revisión del 15-oct-2026: antes
      salía null, igual que «sin excedente»— y para
      PILOTO/MECANICO/VISITANTE) y `cobros[].monto_usd` (`cobroEnUsd`, la
      MISMA cadena de T.C. que `total_cobrado`; a todo rol). Pre-cierre
      `vuelos_cobrados_de_mas`
      (`profit-sharing/vuelos-cobrados-de-mas.util.ts`) NO bloqueante, justo
      después de `cobros_pendientes`, mismo universo y T.C. que ese renglón
      (cotización ?? oficial del día), sin OTRO_VUELO_DEL_CLIENTE: `count` =
      los que requieren revisión, `monto_usd`, `vuelos[]` (con `saldo_usd` =
      excedente), `explicados[]` y `explicados_n`; `fetchCobros` lee además
      `id, fecha_cobro, cobro_grupo_id` y los completados
      `cotizacion_abierta`. La card convierte solo con el T.C. del vuelo y el
      pre-cierre con el de respaldo: un cobro en pesos sin T.C. puede dar
      cifras distintas (como ya pasaba con lo cobrado).
    - **Sonda** `common/cobros-parciales-disponible.util.ts` (rpc
      `regla_cobro_cubierto(1, 1, false, 1)` = true ⇒ «sí» PARA SIEMPRE;
      PGRST202 o 42883 que NOMBRA la función ⇒ «no», re-sondeo ≤ 10 min y un
      solo warn; otro error, excepción o `data` ≠ true ⇒ «sí» sin memorizar;
      un «operator does not exist» NUNCA es «falta la migración»). Modo
      ESTRICTO `cobrosParcialesConfirmados` (`SondaCobrosParciales.confirmada`,
      revisión del 15-oct-2026): «sí» SOLO con el `true` de la función
      memorizado o recién leído; una respuesta dudosa ⇒ «no»; lo usa SOLO lo
      que afirma en pantalla (`varios_abonos_por_cobro`, invariante 78), las
      escrituras siguen con la sonda normal. REGLA DURA:
      el segundo abono de un cobro, los candidatos parciales, el auto-cruce
      por faltante y los faltantes de los frenos de Ingresos van detrás de
      ella; las LECTURAS de estado no. Sin la migración: el segundo abono a un
      parcial ⇒ 503 `CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE`
      (`details.migracion`); las lecturas y la pre-validación TS funcionan
      igual. El «sí» se memoriza: tras la reversa, REINICIAR el API.
    - Specs: `cobro-banco.util.spec`, `cobro-banco.paridad.spec` (lee el
      archivo de la migración), `cobros-parciales-disponible.util.spec`,
      `cobro-conciliado.util.spec`, `cobros-usd.util.spec` (`cobroEnUsd`),
      `cobrado-de-mas.util.spec` (con `cobrado-de-mas.fixture-spec.ts`: filas
      reales de #81, #84, #92, #111, #193, #217, #259, #285, #315 antes y
      después y #332; el tope ABSOLUTO de $10 de REDONDEO_TC con un total de
      $5,000: $10.00 explicado, $10.01 y $40 piden revisión),
      `cobros-lote.util.spec`, `abono-cruce.util.spec`,
      `paywise-cruce.util.spec`, `ligas-cobro.lector.spec`,
      `conciliacion.service.cobros-estado.spec`,
      `conciliacion.service.cobros-parciales.spec` (con
      `cobros-parciales.fixture-spec.ts`: PostgREST falso que emula A/B/C/D/E
      y G/H traducidos del plpgsql, también la BD vieja; una escritura fallida
      se revierte entera), `conciliacion.service.cobros-parciales-cruce.spec`,
      `conciliacion.service.cobros-lote.spec`,
      `conciliacion.controller.cobros-parciales.spec` (HTTP real),
      `flights.service.cobros-estado.spec`,
      `flights.service.cobros-parciales.spec`,
      `flights.service.cobrado-de-mas.spec`, `flights.service.anticipo.spec`,
      `ingresos.service.cobros-estado.spec`,
      `ingresos.service.cobros-parciales.spec`,
      `profit-sharing.service.pre-cierre-cobros-parciales.spec` y
      `profit-sharing.service.pre-cierre-cobrados-de-mas.spec`.

78. **CONCILIACIÓN AL REVÉS DE UNA ENTRADA DE DINERO (14-oct-2026, API 0.0.78,
    SIN migración).** Pedido del usuario desde /admin/ingresos: «y me hace
    falta que si doy clic en Conciliado vea el detalle de con qué estado de
    cuenta se concilio y sus detalles». Gemela de la de Gastos (invariante
    71): desde un COBRO de vuelo (también la parte de un sobre o el cobro de
    un anticipo) o desde un INGRESO, sus ABONOS del banco con la cuenta, el
    estado de cuenta de origen, lo que aporta cada uno, el lote que pagó y
    quién registró la liga.
    - **Rutas** `GET /v1/conciliacion/cobros/:id` y `GET
      /v1/conciliacion/ingresos/:id` en `ConciliacionController` SIN `@Roles`
      propio (heredan `ROLES_CONCILIACION` = ADMIN, FACTURACION; los demás
      roles ⇒ 403 del RolesGuard, sin `code`); `cobros/:id` no choca con
      `cobros-sin-banco`. UN método `conciliacionDeEntrada(origen, id)`, UNA
      respuesta `ConciliacionDeEntradaRespuesta`, CERO escrituras. uuid
      inválido ⇒ 400; 404 `COBRO_NO_EXISTE` / `INGRESO_NO_EXISTE` (un ingreso
      dado de baja responde 200 con `dado_de_baja: true`); 503
      `INGRESOS_NO_DISPONIBLE` solo en `ingresos/:id` sin 20260924000004 (en
      `cobros/:id` no viaja nada de `ingreso*`); una lectura PRINCIPAL caída
      (la entrada, las ligas o los movimientos) ⇒ 500, JAMÁS «sin abonos».
      Best-effort: el detalle del lote, los aviones del sobre, la bitácora,
      los nombres, `ultimos_movimientos`, `mismo_dia_cliente`,
      `cruce_no_corrio` y la sonda del 0.0.78. La DESCARGA del estado de
      cuenta es el `POST /v1/conciliacion/estados-cuenta/:id/url` de siempre.
    - **Ningún número se recalcula** (modelo PURO en
      `conciliacion/abonos-de-entrada.util.ts`, con spec): estado de 5 valores
      (CONCILIADO, PARCIAL, VIA_ANTICIPO, SIN_CONCILIAR, NO_BANCARIO) con las
      MISMAS fuentes de la lista de Ingresos (`leerLigasDeCobros` ⇒
      `partesDeLigas` ⇒ `coberturaCobro` ⇒ `estadoBancoCobro` de la invariante
      77, la cadena de `adjuntarSobres`; `estadoConciliacionIngreso` para un
      ingreso) y paridad lista ↔ hoja en los 5 estados (el SIN_CONCILIAR +
      `parcial` de la lista es el PARCIAL de la hoja); la cobertura del 0.0.78
      TAL CUAL por UN adaptador (`coberturaDeEntrada`; solo cobros positivos
      sin sobre ni anticipo y con estado ≠ NO_BANCARIO); neto = `netoDeCobro`
      / `netoIngreso` (`entradaDeCobro` de Ingresos usa ya `netoDeCobro` y
      `conceptoDeCobro`). Por abono (`aAbonoDeEntrada`): `liga` {vía,
      `monto_parte` solo en DIRECTO, `moneda`, `cruzada`, `tc_implicito` (solo
      cruzada: `tcImplicitoCobro`), `cuadre` del ingreso con
      `montoCuadraIngreso`, `registro`, `sin_registro`} y el lote de
      `anotarCobrosDeAbonos` TAL CUAL (si no se lee ⇒ alerta
      LOTE_SIN_DETALLE). Alertas: CONCILIADO_SIN_ABONOS, ABONO_CON_SOBRANTE,
      LOTE_SIN_DETALLE. Sin TC_NO_REGISTRADO en cobros (USD nunca guarda T.C.
      —97/97 en prod— y MXN guarda el de VENTA): `entrada.tc_usd_mxn` es
      informativo, jamás el del cruce. `fuente`: COLUMNA solo con liga de
      SOBRE o ANTICIPO (y en un ingreso); si no, PUENTE | ESPEJO.
    - **Núcleo compartido con la 71** (en `cargos-de-gasto.util.ts`, sin mudar
      archivos): `aMovimientoDetalle` (`CargoDeGastoDetalle extends
      MovimientoDetalle`: mismas llaves, mismo orden), `cuentaDeFila`,
      `motivoSinArchivo`, `registroDeParte(p, desde)` (sin el 2.º parámetro,
      el corte de los gastos: Gastos byte a byte igual) y
      `MOV_DETALLE_ABONO_COLS` = `MOV_DETALLE_GASTO_COLS` + monto_bruto,
      comision_monto, cobro_id, cobro_grupo_id.
      `ultimosMovimientosPorCuenta({conPrimera: true})` agrega `primera_fecha`
      (solo esta ruta; `ultimos_movimientos` solo en SIN_CONCILIAR o PARCIAL,
      cuentas ACTIVAS).
    - **«Registró la liga»**: puente desde `LIGAS_COBRO_REGISTRADAS_DESDE` =
      `2026-10-12T05:00:00.000Z` (12-oct-2026 00:00 Cancún; el backfill de
      20261012000002 copió `updated_at`/`updated_by` del ABONO: 29 de 57
      partes, la última 2026-10-08T18:17:53Z; la primera real
      2026-10-13T15:56:03Z), leída con `leerLigasDeCobros({conAutor: true})`
      (`PARTE_COBRO_AUTOR_COLS`, a nivel de la PARTE ⇒ `parte_created_at` /
      `ligada_por` por `ligasDesdePartes`, sin pisar el `created_at` del abono
      embebido); si la fecha de la parte no se lee ⇒ null/null (jamás
      ANTERIOR_AL_CORTE). Ingresos y anticipos: el último CONCILIAR de
      `ingreso_bitacora` de ESE abono; sobres: «no se guarda»; ESPEJO: nada.
      Si alguien vuelve a correr un backfill de la puente, el corte se revisa.
    - **Cobro «Sin conciliar»** (los cobros NO tienen cruce «al revés»: solo
      existen `intentarCruzarGasto` e `intentarCruzarIngreso`):
      `mismo_dia_cliente` (otros cobros sin conciliar del mismo cliente, día
      Cancún y moneda: bancarios, positivos, sin liga, sin sobre ni anticipo;
      ≤ 10 por folio, `n` y `suma_netos` con LA fórmula del neto, este
      incluido) y `cruce_no_corrio` (abonos PENDIENTES de su ventana
      —±MATCH_DAYS en cuentas BANCO activas de su moneda; método PAYWISE:
      ±`PAYWISE_VENTANA_DIAS` en la PASARELA— importados ANTES de
      registrarlo), los dos best-effort. `entrada.cuenta_destino` viaja tal
      cual se capturó (texto, no FK): el API no infiere nada de él.
      `varios_abonos_por_cobro` = la sonda del 0.0.78 en modo ESTRICTO
      (`cobrosParcialesConfirmados`: «sí» solo con la migración CONFIRMADA) Y
      `!cobroDeUnSoloAbono` (comisión > 0, método PAYWISE, parte de la
      pasarela o cruzada); false en un ingreso, la parte de un sobre, un cobro
      de anticipo o un reembolso, sin la migración y si la sonda falla o no
      responde claro (red, timeout, 5xx; revisión del 15-oct-2026: antes la
      sonda asumía «sí» ante un error raro y la hoja lo afirmaba).
    - **Sondas y anti-tope**: ingresos (503 / nada de `ingreso*` en
      `cobros/:id`), puente (ESPEJO, REGLA DURA de la 56), `orden_archivo` y
      la del 0.0.78 en modo estricto (`varios_abonos_por_cobro`). Los vuelos
      del cliente se
      paginan por la PK (`TOPE_VUELOS_CLIENTE` 10,000; truncado ⇒ null); los
      cobros del día y los abonos por id van en lotes de ≤ 150 (`leerPorLotes`
      / `leerPorLotesPaginado` ganaron `tamLote` opcional; default 200).
      `INGRESO_HOJA_COLS` lee también `vuelo_id, vuelo:vuelo_id(folio)` (sin
      eso el vuelo del ingreso salía null aunque la lista lo muestra). Jamás
      `numero_cuenta`, `clabe`, `storage_path`, `foto_voucher_url`,
      `archivo_path` ni notas crudas (del cobro solo `conceptoDeCobro`; del
      abono `notas_oficina` sin las líneas canónicas).
    - Specs: `abonos-de-entrada.util.spec`,
      `conciliacion.service.entradas.spec` (con
      `conciliacion-entradas.fixture-spec.ts`: PostgREST falso que proyecta
      columnas como el real + filas reales de prod con los valores «veneno» y
      los bordes etiquetados; casos a–x, d bis, u bis —la sonda que falla
      sin decir «no está» ⇒ false—, RC5 y la paridad lista ↔ hoja),
      `conciliacion.controller.entradas.spec` (HTTP real: roles, 400,
      404, 503), `cargos-de-gasto.util.spec` (Gastos con las MISMAS llaves en
      el MISMO orden), `ligas-cobro.lector.spec` (`conAutor`) e
      `ingresos.util.spec` (`conceptoDeCobro`).

82. **CAJA CHICA: UBICACIÓN EN EL BALANCE DE CADA GASTO DEL FONDO
    (15-oct-2026, sin migración).** Pedido del cliente con la captura del
    fondo de Pablo Canales («Gasto en efectivo #436 · Taxi / estacionamiento
    · −$500.00»): «estaria genial que se mande a la celda en los balances» y
    «que diga en qué hoja del excel del balance está». `getFondoDetail`
    (`GET /v1/caja-chica/fondos/:id`) pone en cada entrada del `historial`
    con `origen: 'gasto'` el ADITIVO `balance` — la MISMA forma de la 72
    (iii): `{periodo, eje, aviones: [{id, matricula}], general, hoja_avion,
    hoja_general}` o null (no vive en ningún libro) — como ÚLTIMA llave de
    la entrada. Las entradas de `origen: 'caja'` no cambian (sin la llave).
    - **Fuente**: el lector COMPARTIDO `common/ubicacion-balance-lector.ts`
      (`leerUbicacionBalance`; la regla sigue siendo SOLO
      `ubicacionBalanceDeGasto`, invariante 72), UNA llamada en lote por
      detalle con los ids de los gastos del libro (`balancesDeGastos`). El
      panel NUNCA decide libro, mes ni hoja: pinta lo que dice `balance`.
    - **Best-effort**: si falla la lectura de gastos o de repartos, NINGUNA
      entrada lleva la llave (warn «Caja chica sin enlaces al balance …»;
      el panel no pinta enlaces); un gasto que no volvió en la lectura queda
      sin la llave; escalas y matrículas como en la 72. Nunca lanza y no toca
      el libro: saldos, `por_reponer`, orden y `cargarLibro` son los mismos
      (ningún número cambia). Skew-safe: panel viejo ignora la llave; panel
      nuevo con API viejo no ve la llave y no pinta enlaces.
    - Specs: `ubicacion-balance-lector.spec` (paridad con la bandeja de
      Conciliación, reglas puras, lecturas, #255, principal caída ⇒ null con
      el warn de la etiqueta, escalas/matrículas best-effort, lotes de 200
      sin repetidos, cero consultas sin ids) y
      `caja-chica.service.balance.spec` (#436 Taxi del vuelo ⇒ avión y
      general de octubre, EMPRESA ⇒ «otros gastos», PERSONAL_DUENO ⇒ null,
      `balance` última llave, caja sin la llave, UNA lectura sin el gasto de
      otra moneda, lectura caída ⇒ sin la llave y lo demás idéntico, sin
      gastos ⇒ cero lecturas). `conciliacion.service.ubicacion-balance.spec`
      sigue verde sin tocarse.

83. **CAJA CHICA MADRE: A QUIÉN SE REPUSO Y CAJAS QUE FONDEA (15-oct-2026,
    sin migración ni ruta nueva).** Pedidos del cliente sobre la caja de
    Mary Cruz (fondea a Gregorio Jurado, Jimmy Chi, Nelson Hau, Luis
    Cáceres, Itzi, Alexander E. Saab…): «que diga a quien le repuso en el
    movimiento» (el renglón «Reintegro a dirección · Espejo automático de la
    reposición en la caja vinculada» no decía a quién: el panel pinta
    `descripcion = notas ?? referencia` y la referencia «Fondeo a <nombre>»
    quedaba tapada) y «que pueda seleccionar a quien le va a reponer el
    fondo». Vínculo = `caja_chica_fondo.fondo_origen_id` (hija → madre, 20-ago-2026);
    espejo = `caja_chica_movimiento.espejo_de_id` → la REPOSICIÓN de la hija.
    Todo ADITIVO en `getFondoDetail` (`GET /v1/caja-chica/fondos/:id`,
    LECTURA); la app y el panel viejo ignoran las llaves nuevas.
    - **`repuesto_a: {fondo_id, usuario_id, nombre} | null`** en cada entrada
      del `historial` con `origen: 'caja'` cuyo movimiento es ESPEJO (como
      ÚLTIMA llave; las demás entradas no la llevan): la caja de la
      reposición que originó el espejo y su dueño con el nombre VIVO
      (`usuario.nombre`, no el texto congelado de la referencia). null = la
      reposición o su caja no volvieron en la lectura. `descripcion` no
      cambia. Lectura `repuestoADeEspejos`: DOS consultas en lote
      (movimientos de origen `id, fondo_id` → cajas con dueño), ≤ 150 ids por
      `in` (`LOTE_ESPEJOS`), cero consultas sin espejos. BEST-EFFORT: si una
      falla, NINGUNA entrada lleva la llave (warn «Caja chica sin «a quién se
      repuso» en los espejos: …»); nunca lanza ni toca el libro.
    - **`cajas_fondeadas: [{fondo_id, usuario_id, nombre, moneda, activo,
      por_reponer, ultima_reposicion: {fecha, monto} | null}] | null`**
      (última llave del detalle): las cajas ACTIVAS con `fondo_origen_id` =
      este fondo, ordenadas por nombre (`localeCompare` es-MX). `por_reponer`
      = `por_reponer` de la ÚLTIMA fila del libro de cada hija
      (`cargarLibro` → `historialConSaldo` → `porReponerCaja`; libro vacío ⇒
      0) — la MISMA cifra que su Excel de lo pendiente
      (`tramoDeReposicion(…, null).por_reponer_antes`) y que la tarjeta «Por
      reponer» de las CLÁSICAS con nominal (`porReponerDeFondo` del panel lee
      `historial[0].por_reponer`). En una ACUMULADA la tarjeta «Por reponer
      (caja acumulada)» pinta `fondo.saldo` CON signo (negativo si se repuso
      de más) y aquí sale topado en 0 (`porReponerCaja`): 0 es lo correcto
      para prellenar, no es un desfase. Cero fórmulas nuevas. `ultima_reposicion` con `ultimaReposicion` (la de
      la lista). Libros en paralelo con tope `TOPE_LIBROS_HIJAS` = 4
      (`mapConTope`). `[]` = no fondea a nadie; **null = cualquier lectura
      cayó** (la de hijas o el libro de UNA hija; warn «Caja chica sin «cajas
      que fondea»: …») — jamás un `[]` falso que diga «no fondea». Corre en
      paralelo con `balance` (82) y `repuesto_a`; el libro de la madre, sus
      saldos y su orden no cambian.
    - **Reponer a una hija desde la madre = la ruta de SIEMPRE**: `POST
      /v1/caja-chica/fondos/:hijaId/movimientos` con `{tipo: 'REPOSICION',
      monto, fecha?, autorizado_por?, referencia?, notas?}` (GESTION = ADMIN,
      FACTURACION; el mismo rol que en la madre, no hace falta otra
      validación). Ya responde la fila creada (`MOV_COLS`, con `id`) — de
      ahí el panel baja `GET /v1/caja-chica/movimientos/:id/reposicion.xlsx`
      — y `insertarEspejo` escribe solo el REINTEGRO espejo en la madre
      (referencia «Fondeo a <nombre>»; si falla, la reposición se revierte).
      NO hay ruta nueva ni se duplica esa regla. **Sin `fecha` (o vacía) el
      API escribe `hoyCancun()`** — jamás el `DEFAULT CURRENT_DATE` de la BD,
      que corre en UTC (`TimeZone` = 'UTC' en prod): de 19:00 a 23:59 Cancún
      la reposición y su espejo (que copia `mov.fecha`) quedaban con el día
      siguiente y el libro contaba como repuestos los gastos de ese día
      (revisión del 15-oct-2026; aplica a todo `createMovimiento`). No
      existe GET de un movimiento suelto: `createMovimiento`/`updateMovimiento` devuelven la
      fila cruda (con `espejo_de_id`) y un espejo no se edita (409).
    - **Filtro Desde/Hasta del historial**: lo hace el panel en el navegador
      sobre el historial COMPLETO (el saldo corrido es del libro entero);
      el API no cambió para eso.
    - Specs: `caja-chica.service.fondeo.spec` (BD en memoria: nombre VIVO
      vs referencia, origen perdido ⇒ null, solo espejos con la llave y
      última, cero lecturas en la hija, DOS lecturas en lote sin repetidos,
      163 orígenes ⇒ 150 + 13, cada lectura caída ⇒ sin la llave con el
      resto idéntico; hijas activas de ESTA madre ordenadas, acumulada con
      arrastre 250, clásica nominal 700 sin el gasto USD, libro vacío 0,
      paridad con la última fila del libro de cada hija (y en la acumulada
      con su saldo topado en 0), acumulada repuesta de más ⇒ tarjeta −350 y
      selector 0, no-madre ⇒ [], hijas o un libro caído ⇒ null, tope 4 con
      12 hijas; POST de la hija ⇒ fila con id, espejo «Fondeo a Gregorio
      Jurado» en la madre con `repuesto_a` y por reponer 0; sin fecha a las
      19:30 Cancún ⇒ reposición y espejo con el día de Cancún y el gasto del
      día siguiente sigue por reponer; fecha explícita se respeta; el fake
      de la BD pone `1999-12-31` por default para que se note si el API deja
      de mandar la fecha). `caja-chica.service.spec` y `.balance.spec` siguen verdes
      sin tocarse.

## Convenciones NestJS

- **Orden de rutas**: las rutas literales (`taco-live`, `descansos`,
  `pre-cierre`, `resumen`) se declaran ANTES de las rutas `':id'` del mismo
  segmento, o Nest las captura como id.
- Crones: aviso de tacos vencidos (push al piloto, sin escrituras)
  `*/10 * * * *`; resumen nocturno de tacos `45 4 * * *` UTC (23:45 Cancún);
  vuelos zombi `55 4 * * *`; alertas diarias `0 8 * * *` con
  `timeZone: America/Cancun`; programa de servicio por horas
  `*/10 * * * *` Cancún (`runServicioHoras`, red de seguridad del hook de
  tacómetro — invariante 21); relectura con IA del folio de gastos
  `*/5 * * * *` (`gastos-releer-folio`, invariante 46); recordatorios de eventos NO-vuelo
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
    22-sep) — hoy son 7: ver «SÉPTIMO COLOR: SERVICIO CAFÉ» abajo**. 22-sep: «para que en los calendarios no se vean tantos colores
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
  - **SÉPTIMO COLOR: SERVICIO CAFÉ (pedido del cliente del 28-sep-2026, API
    0.0.40)**: «los vuelos de Servicio, poner en color Café en el calendario
    web, app y google calendar». Todo lo de arriba sigue vigente; esto SUMA:
    - `SEMAFORO.SERVICIO = '#8B5E3C'` (texto blanco, contraste ≈ 5.6:1),
      alias `SERVICIO_COLOR`, tooltip `AYUDA_SERVICIO` («Vuelo sin pasajeros
      con parada de servicio: no es del cliente y no se cotiza.») y un 7.º
      renglón AL FINAL de `LEYENDA_SEMAFORO`: «Servicio (taller / parada
      técnica)». Panel y app lo copian byte por byte (punto final
      incluido).
    - **REGLA ÚNICA `esVueloDeServicio`** (`common/vuelo-servicio.util.ts`,
      espejo de `quote-revision.ts#esVueloDeServicio` del panel): tramos
      ACTIVOS (sin `cancelada_at`), alguno con `tipo_parada = 'SERVICIO'` y
      NINGUNO con pasajeros (> 0; null = 0 por tramo, a propósito). Antes
      vivía copiada en `quotes.assertNoEsVueloDeServicio` y en la clave
      `vtservicio` del Libro Dinero: hoy los dos la llaman, igual que
      `GET /v1/calendar`, el espejo a Google y el listado de vuelos. Nadie
      vuelve a escribir la regla a mano.
    - **Precedencia ÚNICA NUEVA**: **cancelado (rojo) > SERVICIO (café) >
      tentativo (gris) > pendiente (amarillo) > pagado (azul) > confirmado
      (verde)**. `ParamsColorVuelo.servicio` es el RESULTADO de la regla (la
      util de colores no la recalcula). Un vuelo de servicio nunca se ve
      pagado, tentativo ni pendiente; cancelado sí es rojo.
    - `GET /v1/calendar`: el select de vuelos lee `escalas.tipo_parada`
      (misma consulta, sin N+1) y cada evento de VUELO trae el ADITIVO
      `servicio: boolean` (DATO, como `pagado`: `pagado` NO se apaga en un
      servicio cobrado; el color ya viene resuelto).
    - `GET /flights` (listado): ADITIVO `servicio: boolean` por fila, de la
      MISMA lectura de escalas de `resumenEscalasPorVuelo` (se le suman
      `tipo_parada, pasajeros`; `ResumenEscalas.servicio`). Lo pinta el
      calendario del piloto en la app (Mis vuelos), que arma su propio color.
    - **Google: colorId FIJO 6 «Mandarina»** (`COLOR_ID_FIJO`, tercera
      excepción). Google NO tiene café: por redmean `#8B5E3C` cae en 8
      Grafito (d≈7 848), el gris del TENTATIVO; Mandarina (≈32 996) es el
      tono cálido más cercano y NINGÚN otro estado lo usa. La descripción
      del evento suma `LINEA_DESCRIPCION_SERVICIO` («Vuelo de SERVICIO
      (taller / parada técnica, sin pasajeros)») después del estado. Libres
      en Google: 1 Lavanda, 4 Flamenco, 9 Arándano y 10 Albahaca.
    - **El MANTENIMIENTO sigue AMARILLO** (🔧 «Servicio · …» es una orden de
      taller, no un vuelo): no confundir con el vuelo de servicio.
    - **TRIGGER**: `trg_escala_calendar_sync` NO escuchaba `tipo_parada`
      (sí `pasajeros`). Migración `20260928000003_calendar_sync_tipo_parada.sql`
      (misma lista verificada contra prod + `tipo_parada`, dry-run con
      UPDATEs REALES en el encabezado, ENUM comparado `::text`). Sin ella,
      marcar un tramo como Servicio no re-encola el vuelo hasta el reconcile
      de las 00:15.
    - **DESPLIEGUE**: API + migración (orden indiferente) → panel → APK
      1.1.3+75. Después RE-PINTAR SOLO los vuelos de servicio de la ventana
      [hoy−30d, hoy+365d] encolándolos en `calendar_sync_cola` (el SQL exacto
      está en el encabezado de la migración; 28-sep: #300, #306 y #350) o
      esperar al reconcile de las 00:15.
    - Congelado en: `vuelo-servicio.util.spec.ts`, `colores-calendario.util.spec.ts`
      (7 hex, leyenda, tabla con servicio), `google-evento.util.spec.ts`
      (7 colorId, Mandarina fija, renglón de descripción),
      `calendar.service.spec.ts` («semáforo de 7» + `servicio` +
      `tipo_parada` en el select), `calendar-sync.service.spec.ts` (6 para el
      servicio) y `busqueda-vuelo.util.spec.ts` (`servicio` del listado). Panel
      (`calendario-semaforo.test.ts`, `leyenda-semaforo.test.tsx`,
      `sin-hex-sueltos.test.ts`) y app (`semaforo_calendario_test.dart`)
      guardan su COPIA.
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

- **«Cómo se cobró» cada parcialidad en el BALANCE (6-oct-2026, API 0.0.60,
  sin migración).** Pedido del cliente con el Excel «reporte horas FLOTA»:
  «al lado de la columna STATUS, si ya se pagó, que venga la misma
  información de cómo se cobró, quién lo cobró y, si es posible, a qué
  cuenta». Cada `BalanceAvionCobroPayload` (libro individual, libros del
  general y su consolidado) gana AL FINAL tres campos ADITIVOS:
  `metodo_etiqueta` (`etiquetaMetodoCobro`, con el MISMO sufijo «· parte de
  esta fila (…)» que `metodo` en multi-avión; null sin método), `registro`
  (nombre de quien registró; null sin dato o usuario borrado) y
  `cobrado_con`, la línea YA ARMADA por la fuente única PURA
  `common/cobro-etiqueta.util.ts#etiquetaCobradoCon` (spec): «Transferencia
  → Scotiabank Pesos · Registró: Itzi», sin cuenta «Efectivo · Registró:
  Itzi», sin registro «Transferencia → Scotiabank Pesos», en multi-avión la
  parte de la fila AL FINAL (la flecha queda pegada al método), nada que
  decir ⇒ null. «Registró» y no el nombre a secas: el sistema sabe quién
  CAPTURÓ el cobro, no quién recibió el dinero (misma palabra que el panel,
  `textoRegistroCobro`). El nombre viaja en la MISMA consulta de cobros del
  libro (`registro:usuario!registrado_por(nombre)`; `cobro_vuelo` tiene
  otras dos FK a `usuario`, de ahí el hint) y se lee SOLO con
  `nombreDeRelacionUsuario` — ninguna consulta nueva y ningún número se
  mueve (spec). **Un nombre jamás tumba el libro** (revisión 6-oct-2026): la
  lectura vive en `leerCobrosDelLibro`; si PostgREST NO resuelve el embed
  (`registrado-por.util#esEmbedNoResuelto`: PGRST200/PGRST201 — caché de
  esquema sin la relación, FK renombrada), repite la consulta SIN él y lee
  los nombres en lote con `fetchNombresUsuarios` (nunca lanza; sin nombre ⇒
  `registro` null y `cobrado_con` sin «Registró»), con un `warn`. Cualquier
  OTRO error de los cobros tumba el libro como siempre (sin reintentar).
  pyservices pinta `cobrado_con` como NOTA de la celda «COBRO n» (sin
  columnas nuevas) y tolera su ausencia. Spec:
  `aircraft-balance.service.cobrado-con.spec.ts` (completo, sin cuenta, sin
  registro, embed en arreglo, campos al final, fixture sin datos ⇒ null,
  select con el embed, payload idéntico con y sin registro, multi-avión en el
  individual, en los dos libros del general y en el consolidado; los NÚMEROS
  de cada parcialidad —`monto_mxn`, `comision_mxn` y
  `totales.comision_banco_mxn`—, incluido un multi-avión con DOS
  parcialidades y comisión: con una sola, el ajuste del centavo de la última
  línea escondía un monto sin la parte de la fila; y el respaldo del embed:
  payload IDÉNTICO por los dos caminos, sin nombres que resuelvan, otro error
  que sí tumba y respaldo que también falla).

- **Facturas emitidas: la serie repetida al frente del folio no cuenta dos
  veces (5-oct-2026, API 0.0.54).** La A-0411 quedó guardada con serie «A» y
  folio «A-0411» (la lectura del PDF/la oficina traen el folio ya con su
  serie) y el XML separa «A» + «0411»: `claveCompacta` daba «AA411» vs «A411»
  y el XML se rechazaba como de OTRA factura aunque la etiqueta dijera
  «A-0411» en los dos lados. `folioSinSerie(serie, folio)` recorta la serie
  del folio SOLO con separador (guion/espacio/barra; «A123» se respeta);
  la usan `claveCompacta` (409, ya_registrada, XML) y la normalización al
  guardar (`datos.folio`). El panel tiene el espejo en
  `lib/admin/facturas-emitidas.ts` (lectura, formulario y aviso ámbar).

## Migraciones y despliegue

- **ORDEN DE DESPLIEGUE DEL LOTE 0.0.75 (lote 2 del 13-oct-2026;
  CONSOLIDADO en la revisión del 14-oct-2026 — manda sobre lo que diga cada
  invariante 63–73 y sobre el CLAUDE.md de pyservices).** Hasta la revisión
  había DOS órdenes incompatibles para el mismo push: «pyservices DESPUÉS
  del API» (Comisariato, invariante 63) y «pyservices ANTES del API»
  (ingreso por avión, ID por cliente, TUA). Nada tiene push todavía: API
  sobre `db54502d` (0.0.74, en prod), pyservices sobre `47e67a9`, panel
  sobre `4eefb3b`; la app lleva 6 commits LOCALES sobre `0b1551f`. Prod =
  `bjesduasnzbzywofukbf` (existen DOS proyectos: confirmar con un SELECT).
  **Las migraciones NO van en orden numérico ni todas antes del API**:
  aplicar `20261013000001 → 000002 → 000005 → 000006 → 000008 →
  000009` seguidas y DESPUÉS subir el API dejaría los 4 gastos de agosto
  de la 000002 como COMISARIATO frente a un API 0.0.74 que no conoce la
  categoría (la fila del vuelo los suma a OPERACIONES, el reparto los deja
  EXCLUIDOS y editarlos rebota 400 por IsEnum) mientras dure la ventana.
  No hay 000007 (el ID por cliente cupo en UNA migración atómica). Ninguna
  de las seis necesita el SQL Editor para APLICARSE (lo que se manda por
  MCP no lleva drop/delete/revoke; de la 000008 va SOLO el cuerpo entre
  «>>> CUERPO» y «<<< CUERPO»: su pie de rollback comentado sí dice drop);
  las REVERSAS de 000005, 000006 y 000008 van SOLO por el SQL Editor y con
  confirmación. Cada paso SOLO con el anterior verificado; cada migración =
  dry-run de su cabecera por `execute_sql` (`DRYRUN_OK …`) ⇒ comprobar
  que no quedó nada ⇒ `apply_migration` ⇒ postchecks ⇒ `get_advisors`
  (detalle en el bullet PENDIENTE de cada una):
  1. **Migraciones ANTES del push del API**, en este orden:
     `20261013000001` (enum COMISARIATO; dependencia DURA) →
     `20261013000006` (ID por cliente; independiente, el API la sondea) →
     `20261013000008` (TUA incluida; independiente, el API la sondea) →
     `20261013000009` (enum DOMICILIADO; dependencia DURA: sin ella, 22P02
     en TODA la conciliación). El dry-run SIN migración del concepto del
     SPEI (invariante 69) también va antes del API.
  2. **pyservices COMPLETO** (push a `main`, Railway; confirmar el
     deployment ACTIVO): `fefe97f` (COMISARIATO en visión) · `41b6ece`
     (DOMICILIADO en el contexto de conciliación) · `97e0e5a` (TUA
     sistémica, `tua_monto`) · `d445cab` (concepto del SPEI en el PDF del
     estado de cuenta) · `dd81923` (rótulo «Comisiones (banco + vendedor)»)
     · `d58faa1` (paridad de leyendas) · `07ecfaf` (otros ingresos del
     avión) · `462ce75` (vínculos gasto → celda) · `4a53304` (CLAVE con ID
     por cliente) · `b66df98` (revisión: reporte por vuelo con el contrato
     0.0.75). Seguro con el API 0.0.74 en prod: sin las llaves nuevas
     todo libro sale byte a byte; la IA puede sugerir COMISARIATO pero
     nadie la aplica (la app publicada +80 y el panel de prod solo aplican
     sugerencias de SU catálogo y el API 0.0.74 nunca pisa la categoría:
     solo anota la discrepancia); un estado de cuenta leído con los
     renglones de continuación entra igual (el panel de prod manda los
     campos del movimiento uno por uno, `MovimientoImportDto.descripcion`
     no tiene tope y el dedupe tolera el prefijo). Ventana inocua, pero sin
     re-subir estados de cuenta ni regenerar libros mientras dure.
  3. **API 0.0.75** (push a `main`, Railway): `f48c5a71` (Comisariato,
     inv. 63) · `72772dcc` (DOMICILIADO, inv. 64) · `d03e231f` (#376, inv.
     65) · `c4cc9213` (TUA, inv. 66) · `00555624` (ingreso por avión, inv.
     67) · `3b3a2272` (ID por cliente, inv. 68) · `72d5e21c` (concepto del
     SPEI, inv. 69) · `2572a8b1` (USD contra pesos, inv. 70) · `79f79115`
     (conciliación al revés, inv. 71) · `1a5c2792` (gasto → celda, inv. 72)
     · `85b87dad` (pago REAL al vendedor, inv. 73) · `5da742a0` (revisión)
     · «Versión 0.0.75» (este). Justo antes, `pg_enum` con COMISARIATO y
     DOMICILIADO (1 fila cada uno). Después `GET /v1/version` = `0.0.75`
     (nunca un health). Al revés (API antes que pyservices) los números
     quedan bien pero el libro de N990GG de septiembre saldría SIN la
     pestaña «Otros ingresos» ni la línea «(+) OTROS INGRESOS USD» con una
     UTILIDAD DESPUÉS que ya los suma, y la CLAVE con ID por cliente
     cortada en la columna A.
  4. **Migraciones DESPUÉS del API**, en este orden: `20261013000002`
     (reclasificación de agosto; dependencia DURA: SOLO con la 000001
     confirmada Y el API 0.0.75 arriba; sus conteos van acotados a los 4
     ids; después regenerar los libros de AGOSTO y avisar al cliente) →
     `20261013000005` (CHECK del ingreso con avión; sin dependencia dura,
     aquí para que su 23514 llegue traducido a `AVION_SOLO_EN_RESULTADO`).
  5. **Panel** (push a `main`, Vercel) SIEMPRE después del API: `e6f66fb`
     (Comisariato) · `f6b1b2e` (Pago domiciliado) · `f6a2e88` (factura
     obligatoria en Cobros) · `aa732be` (rótulos de las dos comisiones) ·
     `a28fb7b` (#376) · `4a1e227` (AGENTS.md) · `296c286` (TUA incluida) ·
     `6692d0a` (ingreso por avión) · `2a7665e` (ID por cliente) · `e1c00be`
     (concepto del SPEI y «Factura NNNN») · `7d51eb8` (USD contra el T.C.
     oficial) · `5a703d2` (conciliación al revés) · `7378d63` (gasto →
     celda) · `291300d` (revisión). Verificar el commit desplegado con la
     API pública de GitHub (curl).
  6. **App** (commits LOCALES; push y APK los hace el usuario): `66e8036`
     (+81 Comisariato) · `3b121e7` (+82 dos categorías) · `bef85f9` (Pago
     domiciliado) · `a86f3bf` (+83 ayuda en «Notas») · `8ae6972` (docs) ·
     `1f49f36` (verificación). El APK 1.1.3+83 SOLO con la 000001, la
     000009 y el API 0.0.75 arriba.
  Más los commits «Verificación: …» que agreguen los carriles al cierre
  (viajan en el push de su repo). Después, y ANTES de regenerar septiembre
  y octubre: el PASO 0 de la invariante 67 (la oficina confirma ING-4), las
  capturas pendientes de la invariante 61 y el checklist de datos del
  bullet siguiente. **ROLLBACK del API a ≤ 0.0.74 PROHIBIDO** con gastos
  COMISARIATO o DOMICILIADO en la BD (la 000002 ya cuenta). Verificado en
  local el 14-oct-2026 (API): `tsc --noEmit` limpio (también con
  `tsconfig.build.json`, el del build de Railway); eslint (sin --fix) de
  los 152 `.ts` cambiados desde `db54502d`: 90 errores y 12 avisos,
  idénticos (archivo, regla, mensaje y línea) a `db54502d`
  (aircraft-balance 5, expenses 5, flights 64 + 5, dinero-report 2, quotes
  14 + 7; 0 nuevos); jest 309 suites / 5,123 pruebas, 0 fallos (en
  `db54502d`: 263 / 4,433, 0 fallos; las 15 pruebas de antes que ya no
  están con su nombre son renombres o reemplazos intencionales del lote).
- **APLICADA (14-oct-2026 ~20:00 Cancún, por el usuario en el SQL Editor; verificada
  por MCP: `has_function_privilege` anon=false, authenticated=false,
  service_role=true; renglón del historial; trigger activo; `get_advisors` sin
  los 0028/0029 de esta función) — `20261014000001_revoke_rpc_tg_vuelo_consecutivo_cliente.sql`**
  (solo SQL Editor: el MCP declina el `revoke`). Tras aplicar la 000006 el
  advisor marcó dos WARN (0028/0029): `tg_vuelo_consecutivo_cliente()` es
  SECURITY DEFINER y anon/authenticated la podían invocar por RPC. Es función
  de TRIGGER (por RPC truena), pero el patrón del repo es no exponer ninguna:
  `revoke execute … from public, anon, authenticated` (el trigger sigue
  corriendo: Postgres no revisa EXECUTE al dispararlo). Paquete en
  `docs/sql-aplicar-14-oct-2026/` (aplicar + registrar el historial);
  verificar después por MCP con `has_function_privilege('anon', …,
  'EXECUTE')` ⇒ false y `get_advisors` sin los dos WARN.
- **CHECKLIST DE DATOS ANTES DE REGENERAR SEPTIEMBRE (revisión del lote 2,
  14-oct-2026; dato de prod, NO código: nada se toca sin la oficina).** En
  septiembre hay DOS repartos de utilidades a socios capturados como
  GASTO (verificado por SELECT): `448f4cd2` (INDIRECTO, $100,000.00 MXN en
  efectivo, 15-sep, sellado a N621TX, «reparto utilidades Macedo…
  efectivo fondo pablo») y `b4298c40` (OTRO, $290,800.85 MXN por
  transferencia, 21-sep, sellado a N621TX, «Reparto Utilidades Hernan
  Agosto», conciliado con el SPEI `0943ac60` de EJE SCOTIA y con factura
  SOLICITADA «Folio 280 · ASESORIA Y SERVICIOS PROFESIONALES HGSJ»). Una
  entrega a un socio NO es costo: se registra como ENTREGA de la cuenta
  corriente (invariante 38; `reparto_pago` tiene 0 filas). Efecto HOY (ya
  publicado; regenerar solo lo vuelve a publicar): el primero resta
  100,000 MXN (~5,750 USD) de la utilidad cobrada de N621TX en el BALANCE
  (bloque de socios y participación de VuelaTour), mientras el REPARTO lo
  deja EXCLUIDO (INDIRECTO sin reparto) ⇒ balance y reparto de N621TX ya
  difieren ~5,750 USD; el segundo es gasto de EMPRESA (bloque VUELATOUR
  −~16.7k USD y «otros gastos» del Libro Dinero). Orden correcto: (1) la
  oficina confirma a qué mes y a qué avión corresponde cada pago (Hernan
  tuvo 40.92 % de N621TX hasta el 7-jun-2026 y tiene el 100 % de XA-VGV;
  la nota dice «Agosto»); (2) si el pago es ANTERIOR al arranque de la
  cuenta del socio (default 2026-09 con saldo 0), se ajustan `cuenta_desde`
  / `saldo_inicial_usd` con `PUT profit-sharing/socios/:id/cuenta` — un
  `POST pagos` directo lo dejaría ADELANTADO o rebotaría 409
  `PAGO_EXCEDE_SALDO`; (3) solo entonces se reclasifican o retiran los dos
  gastos; `b4298c40` exige antes DESVINCULAR el cargo `0943ac60` (acción
  destructiva: confirma) y resolver su factura solicitada.
- **14-oct-2026 — ORDEN DE DESPLIEGUE 0.0.76, SIN migración** (fecha del
  pago desde Conciliación, invariante 74). Base: API sobre `422f5275`
  (0.0.75, en prod: `GET /v1/version` lo confirmó el 14-oct) y panel sobre
  `f23cef9`. Ruta ADITIVA `PATCH /v1/expenses/:id/fecha`; `PATCH
  /v1/expenses/:id` («Verificar / editar») y su auto-cruce no cambian. **El
  panel consume campos NUEVOS** (la ruta, `candado_mes_vuelo` en la ficha
  del candidato de «Vincular gasto» y `fecha_hora_carga_movida` en la
  respuesta), así que el API va PRIMERO:
  1. **API 0.0.76** (push a `main`, Railway): `f39b1aca` (ruta, inv. 74) ·
     `292a303a` (revisión: 409 `FECHA_GASTO_YA_CONCILIADO`,
     `fecha_hora_carga_movida`, `candado_mes_vuelo`, sueltas del bloque
     VUELATOUR y `package.json` = `0.0.76`) · «Versión 0.0.76» (este).
     Después `GET /v1/version` = `0.0.76` (nunca un health).
  2. **Panel** (push a `main`, Vercel) SOLO con el 0.0.76 arriba: `fa79752`
     (botón «Fecha», diálogo anidado, «Deshacer» y «Gastos sin banco» sin
     tabla vacía cuando falla la carga) · `c9d79d6` (revisión) y los
     «Verificación: …» que agregue su carril. Verificar el commit
     desplegado con la API pública de GitHub (curl).
  Skew: panel ANTES del API ⇒ «Fecha» abre el diálogo, pero «Guardar
  fecha» recibe 404 «Cannot PATCH …» (el panel dice RUTA_NO_DISPONIBLE) y
  no escribe nada; API nuevo con panel viejo ⇒ nadie llama la ruta,
  `update()` se comporta igual y la llave de más de la ficha
  (`candado_mes_vuelo`) la ignoran el panel de prod (no valida ese payload)
  y pyservices (`GastoCandidato` de pydantic sin `extra="forbid"`).
  Rollback del API a 0.0.75: igual de inofensivo; del panel: desaparece el
  botón. Sin dry-run, `apply_migration` ni `get_advisors`; sin pyservices
  ni app. Verificado en local el 14-oct-2026 (API): `tsc --noEmit` limpio
  (también con `tsconfig.build.json`, el del build de Railway); eslint (sin
  --fix) de los 12 `.ts` cambiados desde `422f5275`: 5 errores y 0 avisos,
  todos en `expenses.service.ts` e idénticos (regla, mensaje y renglón de
  código) a los 5 de `422f5275` (solo se corren 30 líneas; 0 nuevos); jest
  313 suites / 5,203 pruebas, 0 fallos (en `422f5275`: 309 / 5,123, 0
  fallos; las 5,123 siguen con el mismo nombre y hay 80 nuevas). Columnas de
  los selects nuevos (`GASTO_CAMBIO_FECHA_COLS` y `fecha_vuelo` en
  `GASTO_RICO_COLS`) comprobadas en prod por `information_schema` (solo
  SELECT): 22 de 22.

- **14-oct-2026 — 0.0.77, lote A (reglas del 14-oct-2026), SIN migración
  propia** (decisiones del cliente del 14-oct-2026; invariantes 60, 62 y
  67): anticipo devuelto sin factura (regla 1 por moneda + regla 2 SOLO en
  devolución cruzada; solicitud automática «ya no aplica» sin retiro
  automático, con avisos de transición; el panel pinta la exigencia del
  API), conversión ÚNICA del ingreso de un avión (`usdDeIngresoAvion`; hoja
  «Otros ingresos» con T.C. A USD / NETO USD y C5 = `ROUND(SUM(K),2)` tras
  la bandera `usd_por_ingreso`; reembolso ligado a su gasto ⇒ se anula
  exacto en cada libro), nota al pie de FACTURA VUELATOUR con
  `factura_vuelatour_devolucion` y candado del pre-cierre
  `permisos_sin_avion`. Orden: pyservices ⇒ COMPUERTA (deployment ACTIVO
  de pyservices = commit nuevo, invariante 49) ⇒ API (`GET /v1/version` =
  `0.0.77`; el número lo sube el commit «Versión 0.0.77», y si otro lote
  del mismo número trae migración, su orden manda) ⇒ panel. Rollback:
  primero el API, nunca pyservices solo con el 0.0.77 arriba; el panel en
  cualquier orden (sin la llave `exigencia` usa su respaldo). Humo como
  ADMIN: snapshot de #215 ⇒ `factura_servicio.exigencia` 'NO_EXIGE',
  `origenes_exigen` [], `solicitud_ya_no_aplica` false; conteo de «Por
  facturar» igual que antes + `ya_no_aplican` 0; pre-cierre de jul–dic con
  `permisos_sin_avion` 0 y `listo` como antes y `cobros_en_cancelados` sin
  filas de $0.00; balance N990GG sep-2026: hoja «Otros ingresos» con T.C. A
  USD 16.9479 y NETO USD 2,746.70 (= reparto y tablero). Regenerar SOLO
  N990GG sep-2026 (individual y general) dentro de la regeneración de
  septiembre (después del PASO 0 de ING-4 y del checklist de datos).

- **APLICADA (15-oct-2026 03:13Z = 14-oct 22:13 Cancún, por MCP `apply_migration`
  con el API 0.0.77 ya desplegado; en el historial `version` = 20261015031335,
  `name` = 20261014000002_conciliacion_omitir_y_cargos_a_gasto, sentencia con md5
  2e169f29ed5c85993a5ba0a8888fc6e1 = el archivo; antes DRYRUN_OK T1–T31 (md5 del
  bloque 7ff0af6591515e360bc1e10fa89efe69) y después POSTCHECK_OK T1–T31; 6
  funciones SECURITY INVOKER con `search_path ""`, 2 triggers, 0 canónicas;
  `get_advisors` sin nada nuevo) — lote B del 0.0.77 —
  `20261014000002_conciliacion_omitir_y_cargos_a_gasto.sql`** (invariantes
  75 y 76). SOLO funciones nuevas +
  DOS triggers nuevos: `conciliacion_clasificacion_omitido`,
  `conciliacion_omitir_movimientos`, `conciliacion_quitar_omision`,
  `conciliacion_ligar_cargos_a_gasto`, `tg_mov_bancario_omitido_sin_ligas`
  + `trg_mov_bancario_omitido_sin_ligas` y —revisión del 14-oct-2026—
  `tg_mov_bancario_reverso_omitido` + `trg_mov_bancario_reverso_omitido`
  (el trigger de la omisión vigila además `clasificacion_id` y
  `conciliado`); ninguna tabla, columna, CHECK, índice, vista ni función
  existente cambia y NO siembra datos. Las 6 funciones son SECURITY INVOKER
  con `search_path ''` y el archivo NO toca
  permisos ni lleva drop/delete/revoke/grant (ni en comentarios): se aplica
  ENTERO por `apply_migration`. anon/authenticated conservan el EXECUTE por
  default pero, con RLS sin políticas (invariante 51), no ven ninguna fila
  ni pueden insertar (lo prueba el dry-run, T28). Paquete en
  `docs/sql-20261014000002/` (README con el orden): `01-dryrun…sql` (legible)
  y `01-dryrun….transporte.sql` (lo que se manda por `execute_sql`),
  `02b-postcheck-lecturas…sql`, `02-postcheck…sql` (T1–T31 ya aplicada, termina
  en `POSTCHECK_OK`) y `03-reversa…sql` (SOLO SQL Editor, con confirmación).
  **Dry-run corrido en prod el 14-oct-2026, con la revisión** (bloque
  autoabortado con escrituras REALES; filas de prueba DESPUÉS del DDL; T30 =
  el «desvincular» de `linkCobro` y cualquier UPDATE que le quite la omisión
  a un omitido ⇒ MOVIMIENTO_OMITIDO, el deshacer por la RPC sí pasa y cierra
  su paso; T31 = la devolución contra un CARGO omitido ⇒
  MOVIMIENTO_OMITIDO, con el cargo pendiente sí, y el deshacer de un omitido
  con devolución ⇒ MOVIMIENTO_NO_OMITIDO estado REVERSO; `set constraints
  all immediate` en T29):
  `ERROR: P0001: DRYRUN_OK 20261014000002 · T1–T31 · canónica
  f0530ebf-e6d2-4d38-8a16-ad2e4d00eae9 · authenticated:MOVIMIENTO_NO_EXISTE
  authenticated:MOVIMIENTO_NO_EXISTE authenticated:MOVIMIENTO_NO_EXISTE
  authenticated:42501 anon:MOVIMIENTO_NO_EXISTE anon:MOVIMIENTO_NO_EXISTE
  anon:MOVIMIENTO_NO_EXISTE anon:42501 · md5 del bloque
  7ff0af6591515e360bc1e10fa89efe69 · todo se revierte`; después, por
  SELECT: las 6 funciones y los 2 triggers no existen, 0 clasificaciones
  canónicas/DRYRUN, 0 movimientos `DRYRUN`, 0 gastos `DRYRUN%`; 999
  movimientos y 7 pares de reverso, como antes.
  Procedimiento (proyecto `bjesduasnzbzywofukbf`; hay DOS: confirmar con un
  SELECT): `02b` (todo vacío) ⇒ dry-run (si pasó tiempo) ⇒ `apply_migration`
  (name `20261014000002_conciliacion_omitir_y_cargos_a_gasto`; el MCP guarda
  como `version` la marca de tiempo del MOMENTO de aplicar, no
  `20261014000002`: el historial se busca por `name` —`02b` paso 6 y la
  reversa ya lo hacen—) ⇒ `02b` (6 funciones `prosecdef = false` y
  `search_path=""`, 2 triggers, RLS sin políticas, 0 canónicas) ⇒
  `02-postcheck` ⇒ `POSTCHECK_OK` ⇒
  `get_advisors` (sin 0028/0029: nada es SECURITY DEFINER). **Sin dependencia
  dura** con el API: el 0.0.77 la sondea (sin ella, lo nuevo responde 503 y
  lo demás como el 0.0.76; se enciende sola ≤ 10 min después de aplicarla) y
  con un API ≤ 0.0.76 nadie llama las RPC y, sin omitidos, el trigger nunca
  actúa. **REVERSA** (SOLO SQL Editor, con confirmación): deshacer antes
  TODAS las omisiones (pestaña «Omitidos» o `conciliacion_quitar_omision` en
  lotes de 200), luego `03-reversa…sql` (2 triggers, 6 funciones, renglón
  del historial POR `name`; la canónica queda inactiva) y REINICIAR el API
  (la sonda memoriza el «sí»).
- **ORDEN DE DESPLIEGUE 0.0.77 (lote A + lote B, 14-oct-2026; UN solo
  despliegue: manda sobre el «Orden» de los dos bullets anteriores).** Base:
  API sobre `77558c66` (0.0.76, en prod: `GET /v1/version` lo confirmó el
  14-oct-2026 por la noche; = `origin/main`) y pyservices sobre `b66df98`
  (= `origin/main`). El lote A no trae migración y exige pyservices ANTES del
  API; el lote B trae `20261014000002` (sin dependencia dura: el 0.0.77 la
  sondea) y ningún cambio de pyservices ni de la app. Cada paso SOLO con el
  anterior verificado:
  1. **pyservices** (push a `main`, Railway): `f0c8ad1` (hoja «Otros
     ingresos» por ingreso con `usd_por_ingreso`, nota al pie de FACTURA
     VUELATOUR con `factura_vuelatour_devolucion` y la ruta `GET /version`).
     Sin las dos banderas los libros salen byte a byte con el API 0.0.76 de
     prod.
  2. **COMPUERTA de pyservices** (invariante 49): `curl
     <PYSERVICES_BASE_URL>/version` (la variable del API en Railway; la ruta
     no pide token) ⇒ `{"commit": "f0c8ad1934ba3f90fbf4187c5503fdd04d4868fc",
     "servicio": "vuelatour-pyservices"}`, o el deployment ACTIVO de Railway
     en ese commit. Mientras diga otro commit (o `null`), NO se empuja el
     API: con un pyservices viejo el 0.0.77 publica la hoja «Otros ingresos»
     con los números buenos pero con B5 y TRES notas falsas, sin un solo
     error.
  3. **API 0.0.77** (push a `main`, Railway): `77ef4012` (lote A) ·
     `8e91e15b` (lote B) · `a9ed9ecd` (revisión) · «Versión 0.0.77» (este).
     Después `GET https://vuelatour-api-production.up.railway.app/v1/version`
     = `0.0.77` (nunca un health) y el humo del lote A (bullet del lote A).
     Sin la migración, lo nuevo de Conciliación responde 503
     `CONCILIACION_OMITIR_NO_DISPONIBLE` /
     `CONCILIACION_CARGOS_A_GASTO_NO_DISPONIBLE` y TODO lo demás como el
     0.0.76; el panel de prod sigue igual (todo es ADITIVO).
  4. **Migración `20261014000002` por el MCP** (proyecto
     `bjesduasnzbzywofukbf`; hay DOS: confirmar con un SELECT), con el
     paquete de `docs/sql-20261014000002/`: `02b` (todo vacío) ⇒ dry-run
     `01…transporte.sql` por `execute_sql` ⇒ `DRYRUN_OK 20261014000002 ·
     T1–T31 · …` con `md5 del bloque 7ff0af6591515e360bc1e10fa89efe69` ⇒
     comprobar por SELECT que no quedó nada ⇒ `apply_migration` con el
     archivo COMPLETO (name
     `20261014000002_conciliacion_omitir_y_cargos_a_gasto`; no lleva
     sentencias que el MCP decline) ⇒ postchecks (`02b`: 6 funciones
     `prosecdef = false` y `search_path=""`, 2 triggers, RLS sin políticas,
     0 canónicas y 1 renglón del historial por `name`; `02-postcheck` ⇒
     `POSTCHECK_OK`) ⇒ `get_advisors` security y performance (sin
     0028/0029: nada es SECURITY DEFINER). La sonda del API la enciende sola
     en ≤ 10 min, sin redeploy. Humo como ADMIN: `POST
     /v1/conciliacion/movimientos/omitir/revisar` con un pendiente ⇒ 200 con
     su `estado` y `riesgo`; `GET
     /v1/conciliacion/movimientos?solo_omitidos=true` ⇒ `{data: [], count:
     0}` antes de la primera omisión; `GET /v1/conciliacion/clasificaciones`
     sin «Omitido de la conciliación»; el pre-cierre de septiembre con
     `movimientos_omitidos` count 0 y `listo` como antes.
  5. **Panel** (push a `main`, Vercel): LOTE APARTE, SIEMPRE después del API
     (su parte de estos lotes se implementa después). Un API 0.0.76 rechaza
     con 400 (`forbidNonWhitelisted`) `esperado_clasificacion_id` de
     «Clasificar» y `?solo_omitidos`, y responde 404 a las rutas nuevas (el
     panel detecta el API nuevo por la llave `omision` de cada fila de `GET
     movimientos`).
  **Con el panel de ANTES y el API 0.0.77**: el aviso «Ya no aplica» lleva
  al detalle del vuelo (`#cobros`, donde ese panel ofrece «Retirar»), no a
  la tarjeta «ya no aplican» que aún no existe; la canónica no sale en
  «Clasificar» y un omitido se ve como clasificado. **ROLLBACK**: primero el
  API a 0.0.76 y solo después pyservices (nunca pyservices solo con el
  0.0.77 arriba). Con omitidos en la BD el 0.0.76 ofrece la canónica como
  una clasificación más y un intento de ligar un omitido —o de
  desvincularlo o reclasificarlo— lo rechaza el trigger con un código que
  ese API no conoce (500 en la liga de gastos y en «Clasificar», 400
  genérico en la de cobros): deshacer antes las omisiones o avanzar. La
  reversa de la migración, la del bullet anterior (SOLO SQL Editor).
  Verificado en local el 14-oct-2026 (API, `77558c66..HEAD`): `tsc
  --noEmit` limpio (también con `tsconfig.build.json`); eslint (sin --fix)
  de los 66 `.ts` cambiados (18 nuevos): 74 errores y 5 avisos, idénticos
  (regla, mensaje y renglón de código) a `77558c66` (aircraft-balance 5,
  expenses 5, flights 64 + 5; 0 nuevos; los 18 archivos nuevos, limpios);
  jest `--maxWorkers=4` completo: 326 suites / 5,509 pruebas, 0 fallos (en
  `77558c66`: 313 / 5,203, 0 fallos; 11 de la base cambiaron de nombre a
  propósito —tabla del anticipo devuelto, 2,327.54 ⇒ 2,586.16 y la hoja
  «Otros ingresos» por ingreso— y hay 317 nuevas). Dry-run de
  `20261014000002` vuelto a correr en prod sobre el archivo FINAL (md5 del
  archivo `2e169f29ed5c85993a5ba0a8888fc6e1`; el transporte regenerado es
  el de `docs/` byte a byte; el archivo no contiene drop/delete/revoke):
  `ERROR: P0001: DRYRUN_OK 20261014000002 · T1–T31 · canónica
  cc0b9db4-5b54-4a19-b1ba-c98d7d677328 · authenticated:MOVIMIENTO_NO_EXISTE
  authenticated:MOVIMIENTO_NO_EXISTE authenticated:MOVIMIENTO_NO_EXISTE
  authenticated:42501 anon:MOVIMIENTO_NO_EXISTE anon:MOVIMIENTO_NO_EXISTE
  anon:MOVIMIENTO_NO_EXISTE anon:42501 · md5 del bloque
  7ff0af6591515e360bc1e10fa89efe69 · todo se revierte`; después, por
  SELECT, 0 residuos (6 funciones y 2 triggers ausentes, 0
  canónicas/DRYRUN, 0 movimientos `DRYRUN`, 0 gastos `DRYRUN%`; 999
  movimientos y 7 pares de reverso, como antes). pyservices `f0c8ad1`:
  `pytest` 7 fallas, las MISMAS 7 de entorno de esta Mac que `b66df98`
  (WeasyPrint sin libgobject y el SDK de Anthropic con `httpx`; 0 nuevas;
  las dos pruebas de `/version` pasan) y `ruff check app tests` con los
  mismos 19 de la base.

- **APLICADA (15-oct-2026, ~09:50 Cancún, por el usuario en el SQL Editor,
  con el API 0.0.78 ya desplegado) —
  `20261014000003_conciliacion_cobros_varios_abonos.sql`** (invariante 77).
  Por el usuario: `01-dryrun.sql` ⇒ `DRYRUN_OK 20261014000003 · A · T1–T17 ·
  todo se revierte` y `02-aplicar-y-registrar.sql` ⇒ `COMMIT`. Después, por
  MCP: historial con `version` `20261014000003` (una sentencia: el comentario
  de la aplicación a mano); `03-postcheck-mcp.sql` ⇒ `POSTCHECK_OK
  20261014000003 · T1–T16 · todo se revierte`; `03b` §2 todo `t` (sonda del
  API `true`), §3 sin índice único sobre `cobro_id`
  (`movimiento_bancario_cobro_pkey`, `idx_mov_cobro_parte_cobro` e
  `idx_mov_bancario_cobro` no único), §4 E y K (K diferido, escucha `monto` y
  `cuenta_bancaria_id`), §5 anon/authenticated sin permisos y los 7
  `md5(prosrc)` = los del README del paquete, §6 `57 · 0 · 0 · 0 · 4 · 0`, §7
  `0`, §8 `0 · 0 · 0` (sin residuos de 01 ni de 03) y §9 0 filas;
  `get_advisors` sin nada nuevo. Antes de aplicar (prechequeo 00 por MCP,
  15-oct-2026 ~04:35 y ~06:56 Cancún): historial con `20261014000001` y
  `20261014000002` —`version` `20261015031335`— y sin esta, los 4 md5
  esperados, §4 en 0 en las ocho columnas y 57 partes. Puente M:N (DROP
  INDEX `uq_mov_cobro_parte_cobro` y `uq_mov_bancario_cobro`; nace
  `idx_mov_cobro_parte_cobro`), funciones puras INVOKER `neto_de_cobro` y
  `regla_cobro_cubierto`, vista `v_cobro_conciliacion` (security_invoker),
  reemplazos de A, D, K (+ constraint trigger recreado con monto y
  cuenta_bancaria_id) y G, trigger E nuevo, REVOKE a anon/authenticated; sin
  columnas nuevas ni backfill (§0 aborta si la puente de hoy no cumple la
  coherencia nueva de K). Lleva DROP/REVOKE ⇒ SOLO SQL Editor con el paquete
  `docs/sql-aplicar-15-oct-2026-cobros-varios-abonos/` (README con el orden y
  las huellas; lo genera `armar.py` desde el archivo —md5
  `9e6baebd279ebf261b16a636b2d809f1`— y desde 20261012000002; si se aplica
  otro día, regenerar con `--fecha` del día: solo cambia `02`). Proyecto
  `bjesduasnzbzywofukbf` (hay DOS: confirmarlo con la 1.ª consulta).
  `execute_sql` del MCP devuelve SOLO el resultado de la ÚLTIMA sentencia:
  `00` y `03b` van por MCP una sección (§) a la vez; `03` es un solo bloque
  `do` y va entero. Procedimiento (cada paso SOLO con el anterior verificado):
  1. Antes: API 0.0.78 arriba (`GET /v1/version` = `0.0.78`) y
     `20261014000002` aplicada (lo está desde el 14-oct-2026).
  2. Claude por MCP, el MISMO día: `00-prechequeo-mcp.sql` ⇒ historial sin
     `20261014000003` (su §1 busca por `version` Y por `name`: lo aplicado con
     `apply_migration` lleva como `version` la marca de tiempo; es la única
     diferencia con la spec), md5 de A/D/K/G = los de 20261012000002 en prod
     (A `17e06fcc5d2b55570f2126cf6b7d22a2`, D
     `0062a879717c7e54ffe5d906f68160dc`, K `5890b00f5307d562c40255c9df58ef42`,
     G `d38333f588bfa41e0e4cd49648b5df42`) y 0 en las 7 primeras columnas de
     §4 (`quedarian_parciales` > 0 no aborta: avisar a la oficina qué cobros
     se verán «Conciliado parcial»).
  3. Usuario (SQL Editor): `01-dryrun.sql` completo ⇒ `ERROR: P0001: DRYRUN_OK
     20261014000003 · A · T1–T17 · todo se revierte`. Cualquier otro texto ⇒
     NO seguir y pasárselo a Claude.
  4. Usuario (SQL Editor): `02-aplicar-y-registrar.sql` ⇒ `COMMIT` (la
     migración + `insert into supabase_migrations.schema_migrations (version,
     name, statements)` con el comentario de una línea, en UNA transacción).
  5. Claude por MCP: `03-postcheck-mcp.sql` ⇒ `POSTCHECK_OK … T1–T16`;
     `03b-lecturas-mcp.sql` (índices, triggers y permisos: anon/authenticated
     sin nada, `service_role` lee la vista y la sonda da `true`; §5
     `md5(prosrc)` = `tg_mov_cobro_parte_valida`
     `54c8cb1be3d0b47ce075d3333a9f2f75`, `tg_mov_bancario_cobros_candados`
     `c66c11f8137cbe3bc480e3d4de0a2bd3`, `motivo_cobros_incoherentes`
     `adb77e165bb1fdcdd19478a369a5d8a8`, `conciliacion_ligar_abono_cobros`
     `403151e5074fca0c11ad3e8997a89e95`, `neto_de_cobro`
     `ab988e49b94fb202b2d564fc362e7826`, `regla_cobro_cubierto`
     `5d32914f7a7608633e1c59ebed518e49` y `tg_cobro_vuelo_abonos_candado`
     `0c35b459a20b1fad179380e6026acecb` —valen porque el SQL Editor conserva
     los comentarios dentro de las funciones; lo aplicado con
     `apply_migration` queda sin ellos y su md5 ya no es el del archivo—);
     `get_advisors` security y performance (nada nuevo: 0028/0029 no aplican);
     residuos con `03b` §8 (las marcas REALES de 01 y 03 en `cobro_vuelo`,
     `movimiento_bancario` y la puente ⇒ `0 · 0 · 0`) y `03b` §9 (cobros con
     2+ abonos ⇒ 0 filas recién aplicada; es también la lista de la
     reversa). Los dos se agregaron en la revisión del 15-oct-2026 (`03b`
     md5 `dc6f1023e4e837d90b742e51ecc35a44`; los demás archivos, iguales).
  6. Reiniciar el API en Railway (o esperar ≤ 10 min) y comprobar `GET
     /v1/conciliacion/movimientos/:id/candidatos-cobro` ⇒
     `movimiento.cobros_parciales: true`.
  7. Panel (push a `main`, Vercel; verificar el commit con la API pública de
     GitHub).
  Va DESPUÉS de `20261014000002` y del API 0.0.78 (la migración antes del API
  también es segura por la marca `[ABONO_NO_CUADRA]`). Al aplicarla: cambiar
  PENDIENTE por APLICADA con la fecha (commit aparte). **REVERSA** (SOLO SQL
  Editor, con confirmación del usuario): desvincular antes los abonos de más
  de todo cobro con 2+ abonos —la lista sale de `03b` §9 por MCP— (si no,
  `REVERSA_ABORTADA: N cobro(s)…` sin cambiar nada);
  `99-rollback.sql` repone A/D/K/G con el md5 de prod, recrea los índices
  únicos, quita E, la vista, las dos funciones y el índice nuevo y borra la
  fila del historial, en UNA transacción; después REINICIAR el API (la sonda
  memorizó el «sí»; sin reinicio un segundo abono rebota 409 en la BD vieja,
  sin corromper) y verificar por MCP. Probado el 14-oct-2026 en una réplica
  PostgreSQL 17.2 armada con TODAS las migraciones del repo hasta
  20261014000002 (salvo 4 de puros datos de prod) y comparada con prod por MCP
  (11 tablas y 62 funciones iguales salvo comentarios): `DRYRUN_OK` T1–T17 con
  la foto antes/después idéntica, `02` idempotente, `POSTCHECK_OK` T1–T16,
  concurrencia con dos sesiones reales (la 2.ª espera el candado del cobro y
  rebota `ABONO_EXCEDE_COBRO` —por la RPC y por el espejo legado— o
  `COBRO_CONCILIADO`; 400 + 600 cubren un cobro de 1,000 con dos abonos) y la
  reversa con los md5 de prod y su aborto. Re-corrido el 15-oct-2026
  (revisión, `03b` con §8 y §9) en una réplica NUEVA: `00` ⇒ `01`
  `DRYRUN_OK` ⇒ `02` `COMMIT` ⇒ `03` `POSTCHECK_OK` ⇒ `03b` (§8 `0 · 0 · 0`;
  con filas marcadas dentro de un `begin … rollback` da `1 · 1 · 0`: sí
  detecta) ⇒ un 2.º abono al parcial ⇒ §9 lo lista y `99` aborta ⇒
  desligado ⇒ §9 0 filas y `99` `COMMIT` con los md5 de prod ⇒ `02` y `03`
  otra vez OK. Re-corrido OTRA vez en la verificación final del lote
  (15-oct-2026, réplica nueva): todo igual; el detalle va al final del
  bullet siguiente.
- **ORDEN DE DESPLIEGUE 0.0.78 (15-oct-2026: un cobro con varios abonos,
  detalle de «Conciliado» en Ingresos y columna «Avión» del Excel de gastos;
  UN solo despliegue: manda sobre el «Procedimiento» del bullet anterior).**
  Base: API sobre `527560b0` (el commit de documentación que marca APLICADAS
  20261014000001 y 20261014000002, encima de `c96167b7` «Versión 0.0.77», que
  es lo que corre en prod: `GET /v1/version` = `0.0.77` el 15-oct-2026 ~04:35
  Cancún). Trae `20261014000003` (sin dependencia dura: el 0.0.78 la sondea);
  pyservices y la app NO cambian (un parcial sale «No» en el PDF interno: es
  la verdad). Cada paso SOLO con el anterior verificado:
  1. **API 0.0.78** (push a `main`, Railway): `3880ec2a` (migración, sin
     aplicar) · `94ea0d22` (estado y lector único) · `aaddc69a` (vincular y
     candados) · `045a7b53` (auto-cruce, Paywise e Ingresos) · `2ebf915c`
     («Cobrado de más») · `7fe1a0ea` (detalle de «Conciliado» en Ingresos,
     inv. 78) · `a0616798` (columna «Avión» del Excel de gastos, inv. 71) ·
     «Versión 0.0.78» (`6b29b614`) · «Revisión: …» (`cf60c4f7`, los
     hallazgos del 15-oct-2026: «Corregir la comisión» solo con
     COMISION_NO_CUADRA, Paywise sin escritura que no cuadre, frenos con la
     regla de A, sonda estricta de la hoja, `cobrado_de_mas` omitido si no se
     pudo verificar) · «Verificación: …» (solo este CLAUDE.md: el registro
     al final de este bullet). Después `GET
     https://vuelatour-api-production.up.railway.app/v1/version` = `0.0.78`
     (nunca un health). Sin la migración (estado intermedio normal): estados y
     parciales visibles (salen de la puente), «Cobrado de más» completo y la
     hoja de Ingresos funcionando; la pre-validación TS rechaza excedente,
     comisión y otra moneda; un segundo abono a un parcial ⇒ 503
     `CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE` y a uno cubierto ⇒ 409; sin
     candidatos parciales ni auto-cruce por faltante. Nada se corrompe: el
     índice único y la G vieja siguen siendo el candado.
  2. **Migración `20261014000003` por el SQL Editor** con su paquete y el
     procedimiento EXACTO del bullet anterior: `00` por MCP el mismo día ⇒
     `01` (`DRYRUN_OK`) y `02` (`COMMIT`) por el usuario en el SQL Editor ⇒
     `03` (`POSTCHECK_OK`), `03b` y `get_advisors` por MCP.
  3. **Reinicio del API** en Railway (o ≤ 10 min: hasta entonces la sonda
     puede seguir en «no», que es lo conservador) y
     `movimiento.cobros_parciales: true` en `GET
     /v1/conciliacion/movimientos/:id/candidatos-cobro`.
  4. **Humo como ADMIN** (SOLO lecturas GET; valores de prod del
     15-oct-2026 si nadie los movió; jest usa un PostgREST falso, así que
     las rutas nuevas y sus embeds —`ligador:usuario!created_by(nombre)`,
     `vuelo:vuelo_id(folio)`— se prueban aquí por primera vez): `GET
     /v1/flights/<id del #217>/snapshot` ⇒ `cobrado_de_mas` {causa
     IVA_NO_COTIZADO, excedente_usd 495.99, requiere_revision true}; #193 ⇒
     IVA_NO_COTIZADO 52.00; #81 ⇒ COMISION_PAGADA_POR_CLIENTE 214.26
     (requiere_revision false); #315 de hoy ⇒ `cobrado_de_mas: null` con la
     llave PRESENTE. `GET
     /v1/profit-sharing/pre-cierre?desde=2026-08-01&hasta=2026-08-31` ⇒
     `vuelos_cobrados_de_mas` {count 2, monto_usd 547.99, #193 y #217 en
     `vuelos`, #111 en `explicados`} y `listo` como antes (no bloquea);
     julio ⇒ count 0 con #81 y #84 en `explicados`; septiembre ⇒ count 0
     con #259 y #285. `GET /v1/conciliacion/cobros/<cobro de #293>` ⇒ 200
     CONCILIADO (`fuente` PUENTE, cubierto); `GET
     /v1/conciliacion/cobros/<cobro de #223>` ⇒ 200 SIN_CONCILIAR con
     `varios_abonos_por_cobro: true` (false antes del paso 3); `GET
     /v1/conciliacion/ingresos/<id de ING-3>` ⇒ 200 CONCILIADO (`fuente`
     COLUMNA). Un 5xx, un 4xx o un valor distinto ⇒ NO avisar a la oficina:
     pasárselo a Claude.
  5. **Panel** (push a `main`, Vercel): LOTE APARTE (su parte del 0.0.78 y de
     la hoja de Ingresos se implementa después), SIEMPRE después del API y en
     cuanto se pueda; verificar el commit con la API pública de GitHub (curl).
     Con el panel de ANTES y el API 0.0.78: un parcial pierde su badge verde
     (dice la verdad); su «Editar» puede ofrecer el dinero de un parcial ⇒ 409
     `COBRO_CONCILIADO` con texto (nada se escribe); un abono mayor ⇒ 409 con
     el texto del API; su guía del lote suma netos (puede decir «sobran» y el
     API aceptar por faltantes): confuso pero inofensivo; no pinta
     `cobrado_de_mas`. Panel nuevo con un API ≤ 0.0.77: la hoja recibe 404
     «Cannot GET» (el panel dice RUTA_NO_DISPONIBLE) y los campos nuevos
     ausentes se pintan como hoy.
  **Aviso a la oficina** en DOS tiempos (revisión del 15-oct-2026: el panel
  de antes no pinta la card ni el badge nuevos). Con el paso 4 en verde: el
  pre-cierre gana el renglón NO bloqueante «Vuelos cobrados de más» (el panel
  de hoy pinta cualquier renglón con `count` > 0) y el Excel de gastos cambia
  los TEXTOS de la columna «Avión» para todo rol (296 de 1,144 celdas en
  prod; ningún número). SOLO cuando el panel del lote esté en prod (paso 5):
  «Conciliado» de un cobro pasa a ser CUBIERTO (un cobro con un abono menor
  se ve «Conciliado parcial» y sigue en «Cobros sin banco») y la card del
  vuelo avisa «Cobrado de más» con su posible causa (hoy 7 vuelos de prod
  pasan de $1.00). **ROLLBACK** del API a 0.0.77: con la migración aplicada
  su pre-validación rechaza un segundo abono (conservador), los errores
  nuevos de la BD le llegan con la marca y responde 409 genérico (no 500), y
  un parcial ya creado se ve «Conciliado» mientras dure (avisar a la
  oficina); la reversa de la migración es la del bullet anterior (SOLO SQL
  Editor, con confirmación) y después se reinicia el API. Los mensajes de los
  commits de paso del lote NO registran sus corridas de `tsc`, eslint y jest
  (solo listan los specs que agregan); las de la revisión del 15-oct-2026
  van en su commit «Revisión: …» y la verificación COMPLETA del lote, aquí
  (commit «Verificación: …»). Verificado en local el 15-oct-2026 (API,
  `527560b0..HEAD`, worktree propio): `tsc --noEmit` limpio (también con
  `tsconfig.build.json`, el del build de Railway); eslint (sin --fix) de los
  60 `.ts` cambiados (30 nuevos): 69 errores y 5 avisos, idénticos
  (archivo, regla, mensaje y renglón de código) a `527560b0` (expenses 5,
  flights 64 + 5; 0 nuevos; los otros 58, limpios); jest `--maxWorkers=2`
  completo: 346 suites / 5,899 pruebas, 0 fallos y 0 saltadas con el panel
  junto (`VUELATOUR_NEXT_DIR`; sin el repo hermano —CI, Railway, un
  worktree suelto— las 6 de `gasto-avion.paridad.spec` se saltan por
  diseño); en `527560b0`: 326 / 5,509, 0 fallos; 4 cambiaron de nombre a
  propósito por la invariante 77 («UN cobro: parte = |abono|», «otra
  moneda dentro de un lote», `partesDeAbonos` paginada y «un cobro de un
  LOTE se ve ligado») y hay 394 nuevas. Paquete de `20261014000003`
  regenerado con `armar.py --fecha 15-oct-2026`: los 6 archivos, byte a
  byte los de `docs/` (md5 del README); el archivo (md5
  `9e6baebd279ebf261b16a636b2d809f1`) va entero en `02` y su CUERPO, TAL
  CUAL en `01`. En una réplica NUEVA (PostgreSQL 17.2, `reconstruir.sh`,
  puerto propio, detenida al terminar): `00` (4 md5 = prod; §4 `0 · 0 · 0 ·
  0 · 1 · 1 · 0 · 1`) ⇒ `01` `DRYRUN_OK … T1–T17` con la foto idéntica
  antes y después ⇒ `02` `COMMIT` (datos intactos; los 7 `md5(prosrc)` del
  README) ⇒ `03` `POSTCHECK_OK … T1–T16` sin residuos ⇒ `03b` (§8 `0 · 0 ·
  0`, §9 0 filas) ⇒ `99` `COMMIT` con la foto IGUAL a la de antes de la
  migración (datos, funciones con ACL, índices, triggers, vistas,
  comentario e historial) ⇒ `02` y `03` otra vez OK; `01` con la migración
  aplicada ⇒ `DRYRUN_FALLA A`; un 2.º abono al parcial ⇒ §9 lo lista y
  `99` ⇒ `REVERSA_ABORTADA` sin cambios; desligado ⇒ `99` `COMMIT` con la
  foto de antes.

- **15-oct-2026 — 0.0.79, SIN migración** (revisión del 0.0.78; base
  `c1a4ce22`, el 0.0.78 en prod con `20261014000003` APLICADA). Corrige: (1)
  «Por conciliar» y la guarda D12 de «Sugerir con IA» deciden con la regla
  del FRENO (`contextoAbonos` ⇒ `freno` por cobro ⇒ `manualesFreno`), como
  `cobrosExactosLibresDeAbono` del auto: un parcial PAYWISE sin comisión con
  un SPEI de banco ya no deja «Se puede cruzar» cuando el auto queda AMBIGUO,
  y la IA ya no propone LIGAR a un ingreso (o registrarlo) el dinero que le
  falta a ese parcial (0 casos en prod: los 4 cobros PAYWISE llevan
  comisión); (2) el 409 `ABONO_TIENE_COBRO_CANDIDATO` de Ingresos ya no dice
  «vincúlalo» para un candidato que cuadra por BRUTO con comisión capturada
  (o por el bruto de la pasarela): el candidato gana `liga_no_cuadra` /
  `comision_real` (ADITIVOS) y el texto pide corregir la comisión (0 casos
  hoy; #374 sería el primero); (3) el 409 `COMISION_NO_CUADRA` ya no nombra
  el botón «Corregir la comisión y vincular». Todo ADITIVO o de texto: panel
  e85d74c y 0e3ffbb siguen igual (el panel pinta el `message` del API);
  rollback a 0.0.78 inofensivo. Push a `main` ⇒ `GET /v1/version` =
  `0.0.79`. Pendiente del PANEL (no bloquea): en «Registrar como otro
  ingreso», con `liga_no_cuadra: 'COMISION_NO_CUADRA'` ofrecer «Corregir la
  comisión a $X y vincular» (PATCH con `corregir_comision: true`,
  confirmando) en vez del «Vincular» que rebota; con SOBRE_NO_CUADRA,
  ocultar «Vincular» y remitir al grupo.
- **15-oct-2026 — 0.0.80, SIN migración** (caja chica; invariantes 82 y
  83): (1) cada gasto del historial de un fondo trae `balance` (en qué
  libro, hoja y mes vive; lector compartido
  `common/ubicacion-balance-lector.ts`, el mismo de Conciliación); (2) en la
  caja MADRE, el espejo trae `repuesto_a` (a quién se repuso, nombre vivo) y
  el detalle `cajas_fondeadas` (cajas que fondea con su `por_reponer`); (3)
  una reposición sin fecha se fecha con `hoyCancun()`, ya no con el
  CURRENT_DATE UTC de la BD. Todo ADITIVO y best-effort: panel viejo lo
  ignora; panel nuevo con API ≤ 0.0.79 degrada a lo de antes. Orden: API ⇒
  panel. Push a `main` ⇒ `GET /v1/version` = `0.0.80`. El lote de
  tacómetro/«Resolver»/pre-cierre que estaba planeado como 0.0.80 pasa a
  0.0.81.
- **13-oct-2026 — SIN migración** para el pago REAL al vendedor en el reporte
  por vuelo (lote 2, invariante 73): solo cambia la cuenta del PDF/Excel del
  vuelo; contrato con pyservices ADITIVO (la bandera
  `comision_vendedor_solo_gasto_real`; `pago_vendedor_usd` cambia de
  significado pero la cascada visible cuadra con el pyservices de hoy).
  Cualquier orden de deploy es seguro. Verificación: el reporte de #332
  (N621TX, $1,305.00 conciliado, sin comisión cotizada) resta su pago y el
  de #233 (comisión cotizada sin pago) ya no resta nada y lo dice en notas.

- **13-oct-2026 — SIN migración** para el vínculo gasto → celda del balance
  y los enlaces desde Conciliación (lote 2 punto 5, invariante 72): nada se
  persiste (los vínculos y `balance` se derivan en cada petición de columnas
  que ya existen: `gasto.categoria/fecha_gasto/monto/vuelo_id/aeronave_id/
  escala_id/inventario_movimiento_id`, `vuelo.fecha_vuelo/aeronave_id/
  es_externo`, `escala.aeronave_id/cancelada_at`, `gasto_reparto`). Orden
  pyservices → API → panel; los tres órdenes son seguros (pyservices
  previo ignora los ids, API previo no manda `balance`, panel previo no lo
  lee). Tras el deploy: abrir en pantalla un libro de octubre (debe salir
  igual) y, en Conciliación, el cargo del gasto 2a3e7a09 (OPERACIONES
  $1,899.09, #430 de N4142R) debe ofrecer los dos enlaces; si no aparecen,
  revisar en el log el warn «Conciliación sin enlaces al balance».

- **13-oct-2026 — SIN migración** para la conciliación al revés (lote 2,
  invariante 71): solo lecturas de objetos que ya existen en prod (la
  puente con `created_at`/`created_by`, `v_gasto_conciliacion`,
  `movimiento_bancario.gastos_n/orden_archivo/origen/estado_cuenta_id/
  created_by`, `estado_cuenta_archivo`, `cuenta_bancaria.activa` y las FK
  de los embeds, verificadas por SELECT). Sin dry-run, SQL Editor ni
  `get_advisors`. Orden: API → panel (los dos órdenes son seguros: panel
  antes ⇒ la hoja dice «falta actualizar el API»; API antes ⇒ solo cambia
  el Excel de ADMIN/FACTURACION). Smoke como ADMIN: `GET
  /v1/conciliacion/gastos/4e29c476-a956-440f-bd83-2c70f78279d4` ⇒ 1 cargo
  (73a8d809…), `lote.gastos_n` 4 y `gastos_diferencia` 0, `parte.registro.por`
  «Diego Ramírez», `estado_cuenta.filename` «scotia eje sep.pdf» y NINGUNA
  llave `storage_path`; como COORDINADOR ⇒ 403 y el Excel de siempre; el
  Excel sin filtros como ADMIN ⇒ más de 1,000 filas y 2 pestañas. Nota
  para la oficina: el Excel ya sale completo (los totales por categoría
  suben a su valor real) y trae la pestaña nueva «Cargos del banco».

- **13-oct-2026 — SIN migración** para el cruce de gastos en dólares
  contra cargos en pesos (lote 2, invariante 70): solo lecturas nuevas
  (`tipo_cambio_oficial`, `gasto`, `movimiento_bancario`, la puente) y una
  regla más estricta ANTES de la RPC de siempre
  (`conciliacion_ligar_cargo_gastos`); `recalcular_gasto_conciliado`,
  `v_gasto_conciliacion` y la banda 15–25 de la BD no se tocan. La
  corrección de datos del caso real YA se aplicó (13-oct-2026, 21:40
  Cancún): NO repetirla. Orden: API 0.0.75 (verificar `/v1/version` y que
  el log no traiga errores de DI de Nest) → panel (seguro en cualquier
  orden: todo es aditivo). Verificación de SOLO LECTURA antes y después:
  `select left(p.movimiento_id::text,8) mov, m.fecha, m.monto, m.descripcion,
  c.alias, left(g.id::text,8) gasto, g.fecha_gasto, g.monto usd, g.tc_gasto,
  round(abs(m.monto)/g.monto, 6) tc_implicito, o.tc tc_oficial, o.fecha
  fecha_oficial, round((round(abs(m.monto)/g.monto, 6)/o.tc - 1)*100, 1)
  desvio_pct from movimiento_bancario_gasto p join gasto g on g.id =
  p.gasto_id join movimiento_bancario m on m.id = p.movimiento_id join
  cuenta_bancaria c on c.id = m.cuenta_bancaria_id left join lateral
  (select t.tc, t.fecha from tipo_cambio_oficial t where t.fecha between
  m.fecha - 7 and m.fecha order by t.fecha desc limit 1) o on true where
  p.moneda::text <> g.moneda::text order by m.fecha` ⇒ 6 filas, todas con
  |desvío| ≤ 2. Smoke: `GET /v1/conciliacion/movimientos/<cargo MXN
  pendiente>/gastos-candidatos` debe traer la raíz `tc_oficial` NO nula (si
  sale null, revisar el import de `TipoCambioModule`) y el pre-cierre de
  jul–oct `gastos_usd_tc_fuera_de_lugar` con count 0, sin_verificar 0 y
  lectura_fallida false.
- **13-oct-2026 — SIN migración** para el concepto del SPEI (lote 2,
  invariante 69): `movimiento_bancario.descripcion` es `text`, el rastro va
  en `conciliacion_import_job.resultados` (jsonb, desde 20260916000001) y
  `orden_archivo`/`estado_cuenta_id`/la puente ya existen. **Dry-run
  OBLIGATORIO antes del deploy** (regla del workspace: escrituras REALES en
  una transacción que se aborta; sin palabras destructivas, pasa por MCP al
  proyecto `bjesduasnzbzywofukbf`): toma un cargo conciliado con lote y un
  abono con cobros, les hace el UPDATE de `descripcion` con la CAS, `set
  constraints all immediate` y comprueba que ninguna otra columna ni las
  partes se movieron, que `updated_at` sí y que la CAS no pisa un texto ya
  cambiado ⇒ debe terminar en `ERROR: DRYRUN_OK` (probado en un Postgres 17
  local con espejo de los triggers BEFORE y diferidos):

      do $dry$
      declare v_id uuid; v_ab uuid; v_a record; v_d record; v_n int;
      begin
        select m.id into v_id from public.movimiento_bancario m
         where m.origen::text = 'IMPORTADO' and m.tipo::text = 'CARGO' and m.conciliado
           and coalesce(m.gastos_n, 0) >= 2 and m.descripcion is not null
         order by m.fecha desc, m.id limit 1;
        if v_id is null then raise exception 'DRYRUN_FALLA A: no hay cargo conciliado con lote'; end if;
        select * into v_a from public.movimiento_bancario where id = v_id;
        update public.movimiento_bancario
           set descripcion = v_a.descripcion || ' BANORTE fact vip 9999 DRYRUN', updated_by = v_a.updated_by
         where id = v_id and descripcion = v_a.descripcion and origen::text = 'IMPORTADO';
        get diagnostics v_n = row_count;
        if v_n <> 1 then raise exception 'DRYRUN_FALLA B: el CAS no tomó la fila (%)', v_n; end if;
        set constraints all immediate;
        select * into v_d from public.movimiento_bancario where id = v_id;
        if (v_d.monto, v_d.fecha, v_d.tipo::text, v_d.cuenta_bancaria_id, v_d.conciliado, v_d.gastos_n, v_d.cobros_n)
             is distinct from (v_a.monto, v_a.fecha, v_a.tipo::text, v_a.cuenta_bancaria_id, v_a.conciliado, v_a.gastos_n, v_a.cobros_n)
           or (v_d.gasto_id, v_d.cobro_id, v_d.cobro_grupo_id, v_d.clasificacion_id, v_d.ingreso_id, v_d.reverso_de_id)
             is distinct from (v_a.gasto_id, v_a.cobro_id, v_a.cobro_grupo_id, v_a.clasificacion_id, v_a.ingreso_id, v_a.reverso_de_id)
           or (v_d.notas, v_d.referencia, v_d.estado_cuenta_id, v_d.orden_archivo, v_d.origen::text)
             is distinct from (v_a.notas, v_a.referencia, v_a.estado_cuenta_id, v_a.orden_archivo, v_a.origen::text)
        then raise exception 'DRYRUN_FALLA C: el UPDATE de descripcion movió otra columna'; end if;
        if v_d.descripcion is distinct from v_a.descripcion || ' BANORTE fact vip 9999 DRYRUN' then raise exception 'DRYRUN_FALLA C2: la descripción no quedó como se escribió'; end if;
        if v_d.updated_at is not distinct from v_a.updated_at then raise exception 'DRYRUN_FALLA D: updated_at no se movió'; end if;
        if (select count(*) from public.movimiento_bancario_gasto p where p.movimiento_id = v_id) <> v_a.gastos_n then raise exception 'DRYRUN_FALLA E: cambiaron las partes del lote'; end if;
        update public.movimiento_bancario set descripcion = 'X'
         where id = v_id and descripcion = v_a.descripcion and origen::text = 'IMPORTADO';
        get diagnostics v_n = row_count;
        if v_n <> 0 then raise exception 'DRYRUN_FALLA F: el CAS pisó una descripción ya cambiada'; end if;
        select m.id into v_ab from public.movimiento_bancario m
         where m.origen::text = 'IMPORTADO' and m.tipo::text = 'ABONO' and m.conciliado
           and coalesce(m.cobros_n, 0) >= 1 and m.descripcion is not null
         order by m.fecha desc, m.id limit 1;
        if v_ab is null then raise exception 'DRYRUN_FALLA G: no hay abono conciliado con cobros'; end if;
        select * into v_a from public.movimiento_bancario where id = v_ab;
        update public.movimiento_bancario
           set descripcion = v_a.descripcion || ' TRASLADO AEREO DRYRUN', updated_by = v_a.updated_by
         where id = v_ab and descripcion = v_a.descripcion and origen::text = 'IMPORTADO';
        get diagnostics v_n = row_count;
        if v_n <> 1 then raise exception 'DRYRUN_FALLA G2: el CAS del abono no tomó la fila (%)', v_n; end if;
        set constraints all immediate;
        select * into v_d from public.movimiento_bancario where id = v_ab;
        if (v_d.conciliado, v_d.cobros_n, v_d.cobro_id, v_d.monto) is distinct from (v_a.conciliado, v_a.cobros_n, v_a.cobro_id, v_a.monto)
           or (select count(*) from public.movimiento_bancario_cobro p where p.movimiento_id = v_ab) <> v_a.cobros_n
        then raise exception 'DRYRUN_FALLA G3: el UPDATE del abono movió su conciliación'; end if;
        raise exception 'DRYRUN_OK';
      end
      $dry$;

  Orden: el del lote («ORDEN DE DESPLIEGUE DEL LOTE 0.0.75», arriba):
  dry-run → pyservices (prompt con renglones de continuación) → API 0.0.75
  → panel → APK (ayuda en Notas). Los dos órdenes entre pyservices y el API
  son seguros aquí: con el API nuevo y pyservices previo no hay conceptos
  que completar; con pyservices nuevo y el API 0.0.74 la descripción solo
  llega más larga (el dedupe tolera el prefijo); con el panel previo el
  enriquecimiento ocurre igual pero el resumen no lo menciona. Re-subir
  septiembre SOLO con el API 0.0.75 arriba.
  Operación con septiembre: snapshot SQL antes y después (cifras idénticas
  salvo `sin_concepto`), re-subir «scotia eje sep.pdf» y «scotia gastos
  (6).pdf» con «Solo completar conceptos» si la vista previa marca líneas
  nuevas con la misma fecha y monto.
- **PENDIENTE (lote 2 del 13-oct-2026) — `20261013000006_vuelo_id_cliente.sql`**
  (invariante 68, ID de vuelo por cliente; NO aplicada: la aplica el
  orquestador por el MCP; UNA sola migración atómica, independiente de las
  demás del lote). `cliente.alias` + `cliente_alias_default` +
  `trg_cliente_alias_default`, contador `cliente_consecutivo_vuelo` (RLS sin
  políticas), `vuelo.consecutivo_cliente` + `uq_vuelo_cliente_consecutivo` +
  `vuelo_consecutivo_cliente` (SECURITY DEFINER), llenado histórico por
  `(fecha_vuelo asc nulls last, folio)` y verificación §4 que aborta todo.
  El archivo COMPLETO no lleva drop/delete/revoke/disable/truncate (ni en
  comentarios): va por `apply_migration` ENTERO. Procedimiento (proyecto
  `bjesduasnzbzywofukbf`; verificar el project_ref, hay DOS): (1) lecturas
  previas `select (select last_value from public.vuelo_folio_seq) seq,
  (select count(*) from public.calendar_sync_cola) cola, (select
  max(updated_at) from public.vuelo) vuelo_max, (select count(*) from
  public.vuelo) vuelos;` (2) dry-run por `execute_sql` con poco tráfico
  (toma ACCESS EXCLUSIVE sobre vuelo y cliente ~1 s): el bloque `do $dry$`
  de la cabecera sin el prefijo «-- » y con §1, §2 y §3 pegados TAL CUAL en
  las DOS marcas (B y C12) —si se arma con `String.replace` de JS, usar la
  forma de FUNCIÓN: el cuerpo trae `$'` dentro de '^[a-z]{1,24}$'—; escrituras
  REALES, DDL antes de las filas de prueba, vuelos de prueba con folio
  NEGATIVO (nextval no se revierte) ⇒ se espera `DRYRUN_OK · clientes 102 ·
  alias distintos 90 · grupos repetidos 9 · vuelos 387+ · clientes con
  vuelos 90+ · C1–C12`; CUALQUIER `DRYRUN_FALLA` u otro error ⇒ NO aplicar
  (si C1 reporta otro orden de los BEFORE de vuelo, revisar que ningún
  BEFORE que toque `updated_at` quede DESPUÉS de `vuelo_consecutivo_cliente`;
  si C5 dice otros números para #364/#375/#376, alguien capturó un vuelo
  anterior de esos clientes: revisar antes de seguir); (3) residuo cero en
  consultas aparte (las dos columnas no existen, `to_regclass` /
  `to_regprocedure` NULL, 0 clientes y 0 vuelos con la marca
  `DRYRUN-ID-CLIENTE`, mismo `last_value`; el id bigserial de
  `calendar_sync_cola` sí avanza, inocuo); (4) `apply_migration` (name
  `20261013000006_vuelo_id_cliente`, el archivo EXACTO; si el MCP
  declinara: SQL Editor envuelto en `begin … commit` + `insert into
  supabase_migrations.schema_migrations (version, name, statements) values
  ('20261013000006', '20261013000006_vuelo_id_cliente', array['-- aplicada
  desde el SQL Editor; contenido en supabase/migrations'])`); (5)
  `get_advisors` security y performance: esperado SOLO el INFO
  `rls_enabled_no_policy` de `cliente_consecutivo_vuelo` (estado deseado,
  invariante 51), ningún `function_search_path_mutable` (las 3 funciones
  fijan `search_path ''`), a lo más un INFO de índice sin uso de
  `uq_vuelo_cliente_consecutivo`; (6) post-checks: `select count(*) from
  public.vuelo where consecutivo_cliente is null` ⇒ 0; `select count(*)
  from public.cliente_consecutivo_vuelo` ⇒ clientes con vuelos (90 el
  13-oct); `select folio, consecutivo_cliente from public.vuelo where folio
  in (115,117,166,261,267,364,375,376,383,448) order by folio` ⇒ 115=2,
  117=3, 166=10, 261=2, 267=3, 364=5, 375=1, 376=2, 383=4, 448=42; `max(updated_at)`
  de vuelo igual al previo (salvo actividad real); grupos de alias
  repetidos (`select alias, count(*), string_agg(nombre, ' | ' order by
  nombre) from public.cliente group by 1 having count(*) > 1 order by 2
  desc, 1` ⇒ angel, eduardo, erick, fernando, francisco, juan ×4,
  mauricio, tatiana, victor ×3) y genéricos (`… where alias in
  ('cliente','fly','grupo','jet','lic','servicio','this','vuelos')`): las
  DOS listas se entregan a la oficina. PGRST204/42703 al pedir las
  columnas ⇒ `notify pgrst, 'reload schema';`. Ensayada en PGlite (13 y
  14-oct-2026, esquema y textos REALES de `tg_set_updated_at`,
  `calendar_sync_encolar`, `calendar_sync_fanout_cliente` y
  `trg_vuelo_recompute_fecha_fin`): `DRYRUN_OK C1–C12` sin residuos,
  aplicada dos veces idempotente, `DRYRUN_FALLA A` sobre la aplicada, §4
  aborta con un contador atrasado, `vuelo.updated_at` y la cola de Google
  intactos, alta = siguiente número, clon con número en el payload =
  número NUEVO, editar = 23514 con el mensaje exacto, alta sin cliente =
  23502. Marcarla «APLICADA» con la fecha al aplicarla. **REVERSA (SOLO
  aquí, NUNCA en el .sql; SOLO por el SQL Editor y con confirmación del
  usuario: es una baja física)** — antes, anotar los alias editados por la
  oficina (se pierden): `select id, nombre, alias from public.cliente where
  alias is distinct from public.cliente_alias_default(nombre);` y luego:
  `begin; drop trigger if exists vuelo_consecutivo_cliente on public.vuelo;
  drop function if exists public.tg_vuelo_consecutivo_cliente(); drop
  index if exists public.uq_vuelo_cliente_consecutivo; alter table
  public.vuelo drop column if exists consecutivo_cliente; drop table if
  exists public.cliente_consecutivo_vuelo; drop trigger if exists
  trg_cliente_alias_default on public.cliente; drop function if exists
  public.tg_cliente_alias_default(); alter table public.cliente drop column
  if exists alias; drop function if exists public.cliente_alias_default(text);
  delete from supabase_migrations.schema_migrations where name =
  '20261013000006_vuelo_id_cliente'; commit;` ⇒ **REINICIAR el API en
  Railway** (la sonda memoriza el «sí»: `/v1/clients` y las listas
  responderían 42703). Panel y pyservices no se revierten: degradan solos.
- **PENDIENTE (lote 2 del 13-oct-2026) — `20261013000005_ingreso_aeronave_resultado.sql`**
  (invariante 67, ingreso asignado a un avión; NO aplicada: la aplica el
  orquestador por el MCP). SOLO el CHECK `ingreso_aeronave_chk`
  (`aeronave_id is null or categoria in ('OTRO_INGRESO','INGRESO_BANCARIO',
  'REEMBOLSO_DEVOLUCION','VENTA_ACTIVO')`, idempotente dentro de `do $$ … if
  not exists … $$`) + COMMENT en `ingreso.aeronave_id` + verificación `do
  $ver$` (aborta sin el CHECK validado). NO crea columna ni índice (existen
  desde `20260924000004`); sin triggers nuevos; `tg_ingreso_candados` no se
  toca. El archivo COMPLETO (comentarios incluidos) no lleva drop/delete/
  revoke en ninguna capitalización (`grep -niE` vacío): el MCP lo acepta
  entero (o solo el cuerpo entre «>>> CUERPO» y «<<< CUERPO»). Procedimiento
  (proyecto `bjesduasnzbzywofukbf`; confirmar con un SELECT del ING-4): dry-run
  de su cabecera por `execute_sql` (UN bloque `do $dry$`, quitando «-- »: A
  contexto —sin el CHECK, 0 filas que lo violen, un ADMIN activo, un avión y
  un cliente activos—, B cuerpo REAL, C1 estructura, C2 INSERT REAL con avión
  + bitácora, C3 UPDATE a anticipo con avión ⇒ 23514 del CHECK, C4 alta de
  aportación con avión ⇒ 23514, C5 quitar/poner el avión con bitácora UPDATE,
  C6 filas reales cumplen e idempotente ⇒ `DRYRUN_OK · C1 … C6`) ⇒ lecturas
  (0 CHECK, 0 filas `DRYRUN-20261013000005%`) ⇒ `apply_migration` (name
  `20261013000005_ingreso_aeronave_resultado`) ⇒ POSTCHECK
  (`pg_get_constraintdef` validado, `col_description`, ING-4 intacto) ⇒
  `get_advisors` (nada nuevo esperado). Ensayada en PGlite (14-oct-2026,
  esquema REAL de `ingreso` + sus 3 triggers): `DRYRUN_OK` sin residuos,
  cuerpo dos veces = 1 CHECK validado, anticipo y aportación con avión ⇒
  23514 `ingreso_aeronave_chk`, dry-run sobre la aplicada ⇒ `DRYRUN_FALLA A`.
  **Sin dependencia dura**; se recomienda DESPUÉS del push del API 0.0.75
  (así el 23514 siempre llega traducido a `AVION_SOLO_EN_RESULTADO`). Orden
  del punto: PASO 0 (la oficina confirma ING-4, invariante 67) → pyservices
  → API 0.0.75 → esta migración → panel. **REVERSA (SOLO SQL Editor; el MCP
  la rechaza)**: `alter table public.ingreso drop constraint if exists
  ingreso_aeronave_chk;` (y registrar la reversa en el historial si se
  aplica).
- **PENDIENTE (lote 2 del 13-oct-2026) — `20261013000008_gasto_tua_incluida.sql`**
  (invariante 66, TUA sistémica; era la 000003 del diseño, renumerada: la
  000003 es la categoría COMISION_VENDEDOR_AVION; NO aplicada: la aplica el
  orquestador por el MCP). `gasto.tua_incluida numeric(14,2) NULL` + CHECK
  `gasto_tua_incluida_check` (null o ≥ 0) + COMMENT + `tg_gasto_bitacora`
  reemplazada (texto de 20260901000001 + 'tua_incluida' en su lista de
  columnas de negocio; la rama del borrado escribe `tg_op`, así que el
  CUERPO no lleva palabras destructivas y el MCP lo acepta; el trigger no se
  recrea) + verificación `do $ver$` que aborta si algo no quedó. Dry-run de
  su cabecera por `execute_sql` (UN bloque `do $dry$`, el cuerpo YA va
  pegado: A contexto —sin la columna, la función de prod = la de
  20260901000001, un OPERACIONES con vuelo sin conciliar ni factura y un
  ADMIN activo—, B cuerpo, C0 re-aplicar = no-op ANTES de cualquier fila de
  prueba (1 CHECK), C1 estructura, C2–C7 UPDATE REALES —559.63 ⇒ 0 ⇒ null
  con su bitácora y actor, −1 ⇒ 23514, el mismo valor no deja renglón, notas
  sin nombrarla—, C8 alta REAL con 250 ⇒ `DRYRUN_OK 20261013000008 · A–C8`)
  ⇒ comprobar (columna 0, residuos `DRYRUN-20261013000008` 0) ⇒
  `apply_migration` (name `20261013000008_gasto_tua_incluida`, SOLO el
  cuerpo entre «>>> CUERPO» y «<<< CUERPO»; si el filtro lo rechazara: SQL
  Editor + registro en `supabase_migrations.schema_migrations` como
  20261012000002) ⇒ `get_advisors` ⇒ `select count(*) from public.gasto
  where tua_incluida is not null` = 0. Correr el dry-run fuera de horas de
  captura intensa (el ALTER toma un candado breve sobre `gasto`). Ensayada en
  PGlite (13-oct-2026, esquema de `gasto` + sus 4 triggers REALES + `origen`):
  `DRYRUN_OK` sin residuos (huella md5 de gasto y conteo de bitácora
  iguales), aplicar dos veces idempotente (1 CHECK), dry-run sobre la
  aplicada ⇒ `DRYRUN_FALLA A`, −5 ⇒ CHECK, UPDATE con su diff y actor, y un
  borrado real deja la acción DELETE vía `tg_op`. **Sin dependencia dura**:
  el API 0.0.75 es desplegable antes o después (sonda; un número sin la
  migración ⇒ 409 `TUA_INCLUIDA_NO_DISPONIBLE`). Rollback SOLO por el SQL
  Editor (pie del archivo), exportando antes las TUA fijadas y reiniciando
  el API después (la sonda memoriza el «sí»).
- **13-oct-2026 — SIN migración** para la bandeja «Por facturar» (caso
  #376, invariante 65): `vuelo.factura_estatus` existe desde
  `20260923000001` y el puente `factura_emitida_vuelo` desde
  `20260924000003` (las dos aplicadas). Sin arreglo de datos: la liga
  (A-0440, #376) ya existe (Mary, 13-oct 13:21). Orden API → panel.
  Verificación de solo lectura antes/después del deploy: vuelos con
  solicitud viva, no cancelados y sin CFDI ⇒ hoy 6 (#324, #337, #343,
  #345, #375, #376), todos con 1 VIGENTE ligada ⇒ «Por facturar (0)» y
  «Marcados…» vacío.
- **PENDIENTE (lote 2 del 13-oct-2026) — `20261013000009_medio_pago_domiciliado.sql`**
  (invariante 64; era la 000004 del diseño, renumerada: la 000004 es el
  CHECK de la comisión del avión). SOLO `alter type public.medio_pago add
  value if not exists 'DOMICILIADO'` (AL FINAL: 7 ⇒ 8; sola en su archivo).
  Dry-run de su cabecera por `execute_sql` (UN bloque ⇒ `DRYRUN_OK
  20261013000009 · A–C4`: conteo RELATIVO, DOMICILIADO al final,
  `gasto_check` intacto, idempotente, INSERT+UPDATE REALES de un gasto
  TRANSFERENCIA después del DDL con bitácora +2, 55P04 al usar el valor
  antes del commit) ⇒ comprobar que no quedó nada ⇒ `apply_migration`
  (name `20261013000009_medio_pago_domiciliado`) ⇒ `pg_enum` (8, último
  DOMICILIADO) ⇒ `get_advisors`. **DEPENDENCIA DURA: ANTES del push del
  API 0.0.75** (sin ella, 22P02 en TODA la conciliación); justo antes del
  push, `select 1 from pg_enum … enumlabel = 'DOMICILIADO'` ⇒ 1 fila. Sin
  palabras destructivas. El cuerpo plpgsql del dry-run se compiló en prod el
  13-oct-2026 dentro de un bloque que termina en `raise exception`.
- **PENDIENTES (lote 2 del 13-oct-2026) — `20261013000001_categoria_comisariato.sql`
  y `20261013000002_comisariato_reclasificacion.sql`** (invariante 63,
  Comisariato; NO aplicadas: las aplica el orquestador por el MCP). 000001
  lleva SOLO `alter type public.categoria_gasto add value if not exists
  'COMISARIATO'` (AL FINAL: 21 ⇒ 22; sola en su archivo, el valor nuevo no
  se puede usar en la transacción que lo crea —55P04—). Dry-run de su
  cabecera por `execute_sql` (UN bloque `do … raise exception
  'DRYRUN_OK 20261013000001 · A–C4'`: conteo RELATIVO, COMISARIATO al
  final, idempotente, INSERT+UPDATE REALES de un COMIDA en el #164 después
  del DDL con bitácora +2, 55P04 al usar el valor antes del commit) ⇒
  comprobar que no quedó nada ⇒ `apply_migration` (name
  `20261013000001_categoria_comisariato`, SOLO el cuerpo) ⇒ `pg_enum` (22,
  último COMISARIATO) ⇒ `get_advisors`. **ANTES del push del API 0.0.75**
  (`select 1 from pg_enum … enumlabel = 'COMISARIATO'` ⇒ 1 fila). 000002 =
  datos (función `pg_temp` + `select`), SOLO con la 000001 confirmada Y el
  API 0.0.75 YA desplegado: dry-run = la sección 1) del archivo TAL CUAL +
  el bloque `do $dry$` de su cabecera en UNA llamada ⇒ `DRYRUN_OK
  20261013000002 · A–C5` (4 reclasificados = 1,291.00 MXN, bitácora +4
  actor Sistema, huella de dinero intacta, 671d350a/b54126d5 intactos,
  segunda corrida YA_APLICADA, guarda ABORTADA) ⇒ COMISARIATO entre los 4
  ids = 0 ⇒ `apply_migration` (name
  `20261013000002_comisariato_reclasificacion`) ⇒ los 4 ids COMISARIATO
  (1,291.00) ⇒ `get_advisors` ⇒ (revisión del lote 2, 14-oct-2026: el
  chequeo A, la comprobación tras el dry-run y la verificación cuentan SOLO
  los 4 ids — con el API 0.0.75 y el panel ya desplegados la oficina puede
  capturar COMISARIATO nuevos antes de correrla y eso NO es «migración
  aplicada»; el cuerpo del dry-run se volvió a compilar en prod el 14-oct
  como función `pg_temp` dentro de un bloque que termina en `raise
  exception 'SINTAXIS_OK'`, sin ejecutar nada) ⇒
  regenerar los libros de AGOSTO (N58BT, XA-VGV, N990GG, N621TX y el
  general) y avisar al cliente. Ninguna de las dos lleva palabras
  destructivas (el MCP las acepta). Los tres cuerpos plpgsql (los dos
  dry-run y la función) se compilaron en prod el 13-oct-2026 dentro de un
  bloque que termina en `raise exception` (sin ejecutar nada).
- **ORDEN DE DESPLIEGUE DEL LOTE 0.0.74 (13-oct-2026: decisiones 1–6, D3
  con el ajuste de dos categorías y la revisión adversaria).** Nada tiene
  push todavía (API sobre `e18e0fb0`, pyservices sobre `4d206ab`, panel
  sobre `a2918be`). Prod = `bjesduasnzbzywofukbf` (existen DOS proyectos:
  confirmar con SELECT antes —el vuelo #251 con su gasto de $4,080.00 y la
  última migración `20261012000002`—). Cada paso SOLO con el anterior
  verificado:
  1. **Migraciones** (las aplica el orquestador por MCP; detalle en el
     bullet «PENDIENTES (13-oct-2026)» de abajo): `20261013000003`
     (dry-run por `execute_sql` ⇒ `DRYRUN_OK 20261013000003 …` ⇒ comprobar
     que no quedó nada ⇒ `apply_migration` con SOLO el cuerpo ⇒ `pg_enum`:
     el valor justo después de COMISION_VENDEDOR ⇒ `get_advisors`) →
     `20261013000004` (solo con la 000003 YA confirmada, en horario
     tranquilo: dry-run ⇒ `DRYRUN_OK 20261013000004 · A–C8` ⇒
     comprobaciones ⇒ `apply_migration` ⇒ `pg_get_constraintdef` ⇒
     `get_advisors`). Si el MCP declina: paquete en `docs/` para el SQL
     Editor + insert en `supabase_migrations.schema_migrations`.
  2. **pyservices** (push a `main`, Railway; confirmar el deployment
     ACTIVO): `3e4fc1d` (COSTO UNITARIO) · `12b5e86` (T.C. en «permisos») ·
     `11dcaae` (nota FACTURA VUELATOUR) · `982488d` (D3, textos) ·
     `8a16349` (AFAC en filas) · `62a10e4` (dos categorías) · `47e67a9`
     (revisión: permisos AFAC pagados $0.00). Nunca `982488d` sin
     `62a10e4`. Con el API de prod (0.0.73) no llega ninguna bandera nueva:
     libros byte a byte.
  3. **API 0.0.74** (push a `main`, Railway). Justo antes: `select 1 from
     pg_enum e join pg_type t on t.oid = e.enumtypid where t.typname =
     'categoria_gasto' and e.enumlabel = 'COMISION_VENDEDOR_AVION'` ⇒ 1
     fila. Commits: `bbdf411a` (post-mortem del 12-oct, docs) · `9e3a381c`
     (quotes desde/hasta) · `458bbecd` (COSTO UNITARIO) · `4b61db75` (T.C.
     «permisos», invariante 59) · `c942996e` (factura por cuenta,
     invariante 60) · `dd431583` (D3) · `c9ac1022` (AFAC en filas,
     invariante 62) · `47d4b76a` (dos categorías, invariante 61) ·
     `c726d642` (revisión) · «Versión 0.0.74» (este). Nunca `dd431583` sin
     `47d4b76a`. Después: `GET /v1/version` = `0.0.74` (nunca un health) y
     el humo de la invariante 61 (`GET /v1/expenses?pendientes=1` ⇒ 200;
     `?categoria=COMISION_VENDEDOR_AVION&limit=1` ⇒ 200 vacío;
     `GET /v1/dashboards/gastos` ⇒ 200 con el renglón nuevo).
  4. **Panel** (push a `main`, Vercel) SIEMPRE después del API: `4eefb3b`
     (dos categorías; el 0.0.73 rechaza la categoría nueva por IsEnum).
     Verificar el commit desplegado con la API pública de GitHub (curl).
  5. **Flutter**: `66e8036` (+81 Comisariato) y `3b121e7` (+82 dos
     categorías) son commits LOCALES; push y APK los hace el usuario y
     **NO se publica el APK hasta la migración 20261013000001 y el API
     0.0.75** (Comisariato).
  Después del deploy y ANTES de regenerar: avisar al cliente de las dos
  categorías (#251 y #332 se quedan «(VuelaTour)»; comisiones cotizadas
  sin pago: #233, #237, #260, #317, #404, #417 y #442), de la compuerta
  AFAC de la invariante 62 (bullet siguiente; CERRADA el 14-oct-2026: el
  permiso pagado lo carga el avión) y de lo de la invariante 60
  (solicitud viva aunque el cobro sea BillPocket/Paywise/efectivo, avisos
  por anticipos aplicados, sin backfill); SOLO entonces regenerar
  septiembre y octubre (balance, reparto, cuenta corriente y Libro
  Dinero). **ROLLBACK del API a ≤ 0.0.73 PROHIBIDO con gastos «(avión)»
  capturados.** Verificado en local el 13-oct-2026: `tsc --noEmit` limpio;
  eslint de los 72 `.ts` cambiados desde `e18e0fb0`: 92 errores y 12
  avisos, TODOS de `e18e0fb0` (aircraft-balance 5, expenses 5, flights
  64 + 5, inventory 2, dinero-report 2, quotes 14 + 7; 0 nuevos); jest
  263 suites / 4,433 pruebas; pyservices `pytest -q` 1,036 passed, 2
  skipped, 7 failed = los mismos 7 de `4d206ab` (entorno local: IA/PDF);
  `ruff check app tests` 19 = los mismos 19 de `4d206ab`.
- **13-oct-2026 — SIN migración** para los permisos AFAC como filas que
  SUMAN en «otros movimientos» (invariante 62): solo payload API→pyservices
  (`seccion: 'AFAC'` por fila y la bandera ADITIVA `afac_en_filas`; el API
  deja de mandar `afac`). Orden RECOMENDADO pyservices → API; los dos
  órdenes son numéricamente seguros (con el API nuevo y un pyservices
  previo las filas se pintan y SUMAN sin encabezado ni leyendas; al revés,
  el bloque informativo de siempre). Revisión del 13-oct-2026 (antes del
  deploy): el permiso PAGADO va en la fila con egreso $0.00 «a cargo del
  avión» (ya resta en la cascada: sin doble conteo). **Compuerta del
  verificador final — CERRADA el 14-oct-2026**: se avisó al cliente que la
  vista en pantalla y la descarga del Balance general muestran la
  provisión AFAC de cada avión como INGRESO de VuelaTour y los permisos
  pagados como filas informativas $0.00; respondió «el AFAC lo cargan al
  Avión»: se queda así (invariante 62), sin cambio de regla.
- **PENDIENTES (13-oct-2026) — `20261013000003_categoria_comision_vendedor_avion.sql`
  y `20261013000004_gasto_comision_vendedor_avion_exige_vuelo.sql`**
  (invariante 61, comisión del vendedor en DOS categorías; NO aplicadas: las
  aplica el orquestador por el MCP ANTES del push del API). 000003 lleva
  SOLO `alter type public.categoria_gasto add value if not exists
  'COMISION_VENDEDOR_AVION' after 'COMISION_VENDEDOR'` (sola en su archivo:
  un valor nuevo no se puede usar —ni escribir ni leer con el literal,
  55P04— en la transacción que lo crea). 000004 = CHECK SEPARADO
  `gasto_comision_vendedor_avion_exige_vuelo` (`categoria::text <>
  'COMISION_VENDEDOR_AVION' or vuelo_id is not null`; convive con el del
  28-sep, que no se toca: ampliarlo exigiría quitarlo y recrearlo, y el MCP
  lo declina), cuerpo idempotente (DO que consulta `pg_constraint` + COMMENT)
  sin palabras destructivas; el rollback va solo como comentario y solo por
  el SQL Editor. Proceso por cada una: dry-run de su cabecera por MCP
  `execute_sql` (UN bloque `do … raise exception 'DRYRUN_OK …'`, escrituras
  REALES, DDL antes de las filas de prueba; el de 000004 reclasifica ida y
  vuelta las comisiones REALES de #251 y #332 —conciliada— por folio) ⇒
  comprobar que no quedó nada ⇒ `apply_migration` con SOLO el CUERPO
  (names `20261013000003_categoria_comision_vendedor_avion` y
  `20261013000004_gasto_comision_vendedor_avion_exige_vuelo`) ⇒ verificar
  (`pg_enum`: el valor justo después de COMISION_VENDEDOR; lectura con el
  literal sin 22P02; `pg_get_constraintdef`) ⇒ `get_advisors`. 000004 solo
  con 000003 YA confirmada (su dry-run escribe el valor) y en horario
  tranquilo (candado breve sobre `gasto`). Si el MCP declinara: paquete en
  `docs/` para el SQL Editor + insert en `supabase_migrations.
  schema_migrations`. Orden: migraciones → pyservices → API 0.0.74 (justo
  antes del push, `select 1 from pg_enum … enumlabel =
  'COMISION_VENDEDOR_AVION'` ⇒ 1 fila) → panel (SIEMPRE después del API:
  el 0.0.73 rechaza la categoría por IsEnum) → Flutter: commit local +82 —
  **NO publicar el APK hasta la migración 20261013000001 y el API 0.0.75**
  (la +82 incluye Comisariato +81: el 0.0.74 rechaza `COMISARIATO` con 400
  por IsEnum y el outbox deja la captura del piloto en FALLIDO al primer
  intento). La especificación decía «no hay dependencia dura»: es falso.
  **ROLLBACK del API a ≤ 0.0.73 PROHIBIDO con gastos «(avión)» capturados**
  (reclasificarlos antes a «(VuelaTour)»); el valor del enum se queda
  (inofensivo). **Aviso a Comisariato** (20261013000001/2, reservadas): su
  dry-run exigía «20 valores ⇒ 21, COMISARIATO al final»; con 000003
  aplicada antes el enum ya tiene 21 ⇒ debe contar RELATIVO (21 ⇒ 22) y su
  spec del enum pasa a 22 (el nuestro a 21); con el AFTER, el orden final
  del enum es el mismo en cualquier orden de aplicación.
- **13-oct-2026 — payload** de la comisión del vendedor solo como gasto
  real (invariante 61): bandera ADITIVA `comision_vendedor_solo_gasto_real`
  (desde el ajuste: «en dos categorías», sin bandera nueva), llaves
  `comision_vendedor_real_*` y, en el Dinero,
  `utilidades_comision_vendedor_avion_mxn`. Deploy: pyservices → API (al
  revés: números correctos y leyendas viejas un rato). Después: avisar al
  cliente de las dos categorías, decidir #251/#332, capturar las comisiones
  reales pendientes en la categoría correcta (el pendiente de captura las
  lista por vuelo) y SOLO entonces regenerar septiembre y octubre.
- **13-oct-2026 — SIN migración** para la factura obligatoria por cuenta de
  cobro (invariante 60): las 4 columnas de solicitud de `vuelo` existen
  desde `20260924000003` (aplicada); solo la bandera ADITIVA
  `factura_vuelatour_segun_cobros` hacia pyservices. Orden de deploy:
  pyservices → API (con el API nuevo y un pyservices previo solo la nota al
  pie de la hoja maestra queda desfasada; al revés, libro byte-idéntico).
- **13-oct-2026 — SIN migración** para el T.C. por fila y MONTO MXN como
  fórmula de la hoja «permisos» (invariante 59): solo payload API→pyservices
  (campos ADITIVOS `tc_aplicado` / `tc_por_fila`); deploy en cualquier
  orden (de preferencia pyservices primero).

- **APLICADA en prod la noche del 12-oct-2026** —
  `20261012000002_conciliacion_abono_cobros.sql` (invariante 56): tabla
  puente `movimiento_bancario_cobro` + `movimiento_bancario.cobros_n` +
  CHECK de ingresos con `cobros_n = 0` + backfill de las 29 ligas `cobro_id`
  (29 partes, `updated_at` intacto) + 7 triggers (A/B×3/C/D/K) + 2 RPC.
  Se aplicó desde el SQL Editor (el MCP de Supabase rechaza sentencias con
  DROP/DELETE/REVOKE: ver el CLAUDE.md del workspace) y se registró en
  `supabase_migrations.schema_migrations`. **El DRY-RUN de su cabecera, tal
  cual, falla con `55006 pending trigger events`** (sección A inserta en
  `movimiento_bancario` antes del `alter table`; post-mortem en el propio
  archivo). La cobertura se obtuvo con un POSTCHECK sin DDL sobre el esquema
  aplicado (C1 estructura, C2 backfill, C3 dos cobros que cuadran, C4
  ABONO_NO_CUADRA sin escribir, C5 LOTE_MONEDA_DISTINTA, C6
  COBRO_YA_CONCILIADO, C7 espejo legado y LOTE_SOLO_API_NUEVO, C8 candados
  D, C9 desligar, C11 un solo cobro ⇒ `POSTCHECK_OK`). `get_advisors`: solo
  el INFO de RLS sin policies de la tabla nueva y la FK `created_by` sin
  índice (como sus hermanas). Rollback al pie del archivo (un lote vivo se
  pierde: desvincularlo antes; reiniciar el API después).
- **Dry-run de una migración con escrituras de prueba: PRIMERO el DDL,
  DESPUÉS las filas de prueba.** Una tabla con constraint triggers
  DIFERIDOS (`movimiento_bancario`: partes/cobros coherentes) deja eventos
  pendientes tras un INSERT/UPDATE y cualquier `alter table` posterior en la
  misma transacción revienta con 55006. Orden: cuerpo → filas de prueba →
  pruebas → `raise exception 'DRYRUN_OK'`.

- **APLICADA en prod la noche del 12-oct-2026** (dry-run por MCP
  `DRYRUN_OK`: columna + CHECK con 1 aceptado y 0 rechazado + índice) —
  `20261012000001_movimiento_bancario_orden_archivo.sql` (invariante 55):
  `movimiento_bancario.orden_archivo integer` (CHECK ≥ 1) + índice
  `(estado_cuenta_id, orden_archivo)`. Aditiva, sin triggers ni backfill.
  La sonda se enciende sola en ≤ 10 min; desde entonces cada importación
  guarda la posición y el reporte Excel sale en el orden del archivo.

- Migración = archivo en `supabase/migrations/` **y** aplicada vía MCP al
  proyecto prod `bjesduasnzbzywofukbf` (existen dos proyectos; verificar).
  Tras DDL correr `get_advisors`. RLS habilitado en todas las tablas y, desde
  el 8-oct-2026, SIN políticas de lectura para usuarios finales (la API usa
  service key; app y panel nunca leen tablas con el token del usuario —
  invariante 51). El INFO `rls_enabled_no_policy` del advisor es el estado
  deseado.
- **`movimiento_bancario` tiene un constraint trigger DIFERIDO**
  (`trg_mov_bancario_partes_coherentes`, 20261002000002): una transacción
  que escriba en esa tabla (conciliado, gasto_id, gastos_n, monto,
  clasificacion_id, cobro_id, cobro_grupo_id, ingreso_id) y DESPUÉS haga
  `ALTER TABLE` sobre ella falla con 55006 «pending trigger events»: toda
  migración o dry-run que mezcle DML y DDL corre `set constraints all
  immediate;` antes del ALTER. Una limpieza SQL que BORRE movimientos con
  partes fija antes `select set_config('vt.actor_id', '<uuid>', true);` o
  la bitácora atribuye la desconciliación al `created_by` de la parte. Con
  un lote vivo (`gastos_n >= 2`) el API NO se regresa al 0.0.51
  (`LOTE_SOLO_API_NUEVO`/`LOTE_INVALIDO` no se traducen ⇒ 500).
- **APLICADA (8-oct-2026 vía MCP, tras DRYRUN_OK en prod simulando a un
  PILOTO autenticado —`set local role authenticated` + `request.jwt.claims`—:
  ANTES todas las tablas con política daban 42P17 salvo `aeronave_imagen`=52;
  DESPUÉS vuelo/escala/cobro_vuelo/gasto/cliente/cuenta_bancaria/
  movimiento_bancario/tarjeta_corporativa/aeronave_imagen/aeropuerto = 0
  filas; advisors: solo el INFO `rls_enabled_no_policy`, que es el estado
  deseado)** — `20261008000001_rls_sin_lectura_global_usuarios.sql`
  (invariante 51): `drop policy` de las 32 `<tabla>_read_active_user` +
  `aeronave_imagen_read_public`. Sin DML, sin residuos; reversión = recrear
  la política (plantilla en la cabecera del archivo).
- **APLICADA (6-oct-2026 vía MCP, tras DRYRUN_OK A–C8 en prod: 476 con foto
  y sin folio, 118 en la cola; sin residuos; advisors sin hallazgos nuevos)** —
  `20261006000001_gasto_folio_releido.sql`
  (invariante 46): `gasto.folio_releido_at timestamptz null` (sin default:
  todas las filas existentes quedan pendientes) + COMMENT + índice parcial
  `gasto_folio_releer_idx (fecha_gasto desc) where foto_url is not null and
  folio_ticket is null and factura_recibida_id is null and folio_releido_at
  is null` + siembra en `configuracion_sistema` de `folios_releer_activo`
  (activa) y `folios_releer_lote` (15) con `on conflict do nothing` (el
  panel puede pausar y cambiar el lote; sin fila el PATCH da 404) +
  verificación `do $ver$` que aborta si la columna, el índice o las dos
  claves no quedaron. Sin triggers, funciones ni backfill; los UPDATE del cron
  disparan los 4 triggers EXISTENTES de `gasto` (`updated_at`, bitácora con
  `updated_by = null` ⇒ «Sistema», sync de facturación y personal del
  dueño, que no cambian nada). **Antes de aplicar**: el DRY-RUN de su
  cabecera (UNA sentencia `do $dry$`, se ejecuta quitando el prefijo «-- »):
  A contexto (sin la columna; cola del cron con ≥ 3 gastos), B cuerpo real,
  C1 tipo/nulabilidad/sin default, índice con su predicado y 0 filas
  selladas, C2 (a) UPDATE REAL del cron con un folio `DRYRUN-…` (índice
  único, bitácora con actor null y el folio, `updated_by` null, llave
  `folio` en la lectura, `folio_ticket_norm`, `updated_at` movido), C3 el
  CAS no deja pisar, C4 (b) el MISMO folio en otro gasto ⇒ 23505 y el sello
  del duplicado con nota y actor null, C5 (c) solo el sello: sin renglón de
  bitácora y `updated_by` intacto, C6 la cola baja en 3, C7 re-aplicar =
  no-op, C8 las dos claves sembradas, pausables con el UPDATE del panel y
  re-aplicar no pisa el lote ⇒ `DRYRUN_OK`; después la columna NO existe,
  no queda ningún `DRYRUN-20261006000001-%` ni las dos claves. Probado en PGlite (6-oct) con el esquema de
  `gasto` de prod y sus 4 triggers REALES (texto de `pg_get_functiondef`):
  `DRYRUN_OK` sin residuos (huella md5 idéntica), aplicar dos veces
  idempotente, dry-run sobre la aplicada ⇒ `DRYRUN_FALLA A`, verificación
  que aborta con la columna de otro tipo, cola corta ⇒ `DRYRUN_FALLA A` y
  rollback; re-probado tras la revisión (6-oct) con `configuracion_sistema`
  y sus CHECK de prod: `DRYRUN_OK` A–C8 sin residuos, aplicar dos veces
  idempotente, rollback borra las dos claves, un lote previo (30) se
  respeta. Tras aplicar: `get_advisors` y, con el API 0.0.58 desplegado,
  la cola (SQL al pie de la cabecera; 118 el 6-oct) baja ~15 por corrida
  (cada 10–15 min: 1–2 h en total). El
  API 0.0.58 es desplegable ANTES (sin la columna el cron no hace nada).
  Rollback al pie del archivo (reiniciar el API después).
- **APLICADA (5-oct-2026 vía MCP, tras DRYRUN_OK de la cabecera en prod con 62
  recibidas y 59 por releer; sin residuos; advisors sin hallazgos nuevos)** —
  `20261005000002_factura_recibida_serie_folio.sql`
  (invariante 44): `factura_recibida.serie text null`, `.folio text null`,
  `.folio_releido_at timestamptz null` en UN `ALTER` (idempotente) +
  COMMENTs + verificación `do $ver$` que aborta si alguna no quedó con su
  tipo. Sin triggers, funciones, índices ni backfill (los UPDATE del cron
  disparan el `trg_factura_recibida_set_updated_at` existente). **Antes de
  aplicar**: el DRY-RUN de su cabecera (UNA sentencia `do $dry$`, se
  ejecuta quitando el prefijo «-- »): A contexto (sin las 3 columnas; cuenta
  recibidas y con XML), B cuerpo real, C1 tipos/nulabilidad/sin default y
  TODAS las existentes con XML pendientes, C2 alta REAL como el 0.0.57
  (serie/folio sellados), C3 alta REAL como el 0.0.56 (pendiente) y
  solo-PDF fuera del lote del cron, C4 UPDATE REAL del cron con CAS (la
  segunda escritura no pisa), C5 ilegible REAL como el cron (notas
  releídas, texto literal y CAS sobre ellas: tras una edición de la oficina
  el sello con las notas viejas escribe 0 filas y el de las vigentes deja
  «Proveedor X · pagar el viernes\nFolio no legible del XML»; sin notas,
  CAS `notas is null`) y PATCH del panel, C6
  re-aplicar = no-op ⇒ `DRYRUN_OK`; después las columnas NO existen y no
  queda ningún `DRYRUN-20261005000002-%`. Probado en PGlite (5-oct; C5
  re-probado tras la revisión):
  `DRYRUN_OK · 62 recibidas, 59 por releer` sin residuos, aplicar dos veces
  idempotente, dry-run sobre la aplicada ⇒ `DRYRUN_FALLA A`, verificación
  que aborta con una columna de otro tipo y rollback. Tras aplicar:
  `get_advisors` y, con el API 0.0.57 y pyservices con serie/folio
  desplegados, `select count(*) from factura_recibida where xml_url is not
  null and folio_releido_at is null` baja de 59 a 0 en ≤ 2 corridas del
  cron (la sonda re-sondea en ≤ 10 min). El API 0.0.57 es desplegable
  ANTES (sin la columna: recibidas como el 0.0.56, cron inactivo, folio de
  ticket/IA/UUID en conciliación). Rollback al pie del archivo (reiniciar
  el API después). El orquestador marca aquí la aplicación.
- **APLICADA (5-oct-2026 vía MCP, tras DRYRUN_OK de la cabecera en prod; sin
  residuos; advisors sin hallazgos nuevos; 82 cargas GAS con tipo null
  rellenadas con el combustible de su avión, ids en el scratchpad de la
  sesión)** — `20261005000001_aeronave_combustible.sql` (invariante 43): `aeronave.combustible` text NOT NULL default 'AVGAS' +
  CHECK `aeronave_combustible_chk` (AVGAS | TURBOSINA) + UPDATE de las dos
  turbinas (N58BT, N621TX) + COMMENT + verificación `do $ver$` que aborta si
  no quedaron o si alguna de las dos no existe con esa matrícula exacta
  (`v_ok <> 2`). Sin triggers nuevos; el UPDATE dispara
  `trg_aeronave_set_updated_at` (mueve `updated_at` de las 2 turbinas) y NO
  el fan-out de Google (solo escucha matrícula/color). **Antes de aplicar**:
  el DRY-RUN de su cabecera (UNA sentencia `do $dry$`, se ejecuta quitando
  el prefijo «-- »): A contexto (sin columna, N58BT/N621TX/XB-PEV existen),
  B cuerpo real, C1 valores y default, C2 CHECK con UPDATE REAL (DIESEL y
  minúsculas ⇒ 23514), C3 NOT NULL ⇒ 23502, C4 PATCH real y alta REAL sin el
  campo ⇒ AVGAS, C5 cola de Google sin cambios, C6 re-aplicar = no-op ⇒
  `DRYRUN_OK`; después la columna NO existe y no queda `XX-DRY1`. Probado en
  PGlite (5-oct): `DRYRUN_OK`, aplicar dos veces idempotente, dry-run sobre la
  aplicada ⇒ `DRYRUN_FALLA A`, verificación que aborta si una turbina no
  quedó o si la matrícula viene escrita distinto («N-58BT» ⇒ «1 de 2
  turbinas en TURBOSINA») y rollback. Tras aplicar: `get_advisors` y `GET /v1/aircraft` con
  `combustible` por fila (la sonda re-sondea en ≤ 10 min). El API 0.0.56 es
  desplegable ANTES (sin la columna, todo como el 0.0.55). Rollback al pie
  del archivo (reiniciar el API después).
- **APLICADA el 2-oct-2026** (dry-run previo en prod revertido: DRYRUN_OK, huella
  fc41134798faddb5afc628f6f99d2ec8; tras aplicar: 375 partes = 375 ligas
  `gasto_id`, 0 cargos incoherentes, 1 gasto con bandera ≠ regla (ASUR
  0e8ead24, esperado), advisors sin hallazgos nuevos salvo el INFO de la FK
  `created_by` sin índice) — `20261002000002_conciliacion_partes.sql`
  (invariante 40, 1 cargo ↔ N gastos): tabla puente
  `movimiento_bancario_gasto`, `movimiento_bancario.gastos_n`, vista
  `v_gasto_conciliacion`, RPC `conciliacion_ligar_cargo_gastos` /
  `conciliacion_desligar_cargo_gastos`, `recalcular_gasto_conciliado`,
  triggers de la puente y de compatibilidad, `tg_mov_bancario_gasto_suma` y
  `tg_mov_bancario_reverso` reescritos e `inventario_eliminar_movimiento`
  con la puente; backfill de las ligas `gasto_id` existentes. **Antes de
  aplicar**: el DRY-RUN de su cabecera (escrituras REALES que terminan en
  `raise exception 'DRYRUN_OK …'`) en prod; después `get_advisors` y la
  verificación del backfill. El API 0.0.52 es desplegable ANTES (sonda:
  todo como el 0.0.51 y 503 en lo nuevo). El orquestador marca aquí la
  aplicación.
- **APLICADA en prod el 1-oct-2026 (noche; dry-run corrido en prod: `DRYRUN_OK · N4142R · socio Mauricio Roque · C1–C7`, sin residuos; después tablas, función con search_path fijo, triggers e índices verificados; `get_advisors` solo el INFO de RLS sin policies)** —
  `20261002000001_reparto_cuenta_socio.sql` (invariante 38 v2, cuenta
  corriente del socio). Requiere `20261001000001` aplicada. (1)
  `reparto_pago`: `periodo`, `aeronave_id` y `utilidad_snapshot_usd` pasan a
  NULL-ables; el CHECK de `periodo` se recrea como `periodo is null or
  extract(day from periodo) = 1`; columnas nuevas `saldo_snapshot_usd
  numeric(12,2)` (la SONDA del API) y `updated_by uuid` (FK usuario `on
  delete set null`, constraint aparte del ADD COLUMN para que re-aplicar no
  la duplique); índice nuevo `(socio_id, fecha_pago) where deleted_at is
  null` y se retira `idx_reparto_pago_periodo` (solo lo usaba la v1; el de
  `(aeronave_id, socio_id, periodo)` se queda: cubre la FK de avión);
  COMMENTs. (2) Tabla nueva `reparto_cuenta_socio` (`socio_id` PK FK usuario
  `on delete restrict`, `cuenta_desde date` CHECK día 1, `saldo_inicial_usd
  numeric(12,2)` default 0, `notas` ≤ 500, `created_by/updated_by` FK `on
  delete set null`, `created_at/updated_at`, RLS sin policies,
  `trg_reparto_cuenta_socio_set_updated_at` con `public.tg_set_updated_at()`).
  (3) BITÁCORA: tabla `reparto_bitacora` (sin FK a propósito, CHECK de
  `tabla`/`accion`, 2 índices, RLS sin policies) + función
  `public.tg_reparto_bitacora()` (`search_path = ''`, solo copia jsonb: no
  compara el enum `moneda`) + triggers `trg_reparto_pago_bitacora` y
  `trg_reparto_cuenta_socio_bitacora` AFTER INSERT/UPDATE/DELETE. Sin enums
  ni backfill (0 filas en `reparto_pago` el 1-oct). **Antes de aplicar**: el
  DRY-RUN de su cabecera, UNA sentencia `do $dry$` AUTOCONTENIDA — la
  sección B ya trae la sección 1 (la genera el mismo script; se ejecuta
  quitando el prefijo «--   » de las líneas entre `--   do $dry$` y
  `--   end $dry$;` y dejando vacías las «--», sin pegar nada): A contexto
  (v1 aplicada, v2 no —tampoco la bitácora ni `updated_by`—; existe
  `tg_set_updated_at`; socio vigente en sep-2026 —de preferencia N4142R— y
  ADMIN activo; cuenta las filas de `reparto_pago`), C1 estructura (RLS sin
  policies en las 2 tablas, PK, FKs `socio = r` / `created_by, updated_by =
  n` y `reparto_pago_updated_by_fkey = n`, los 4 triggers, `search_path`
  fijo, nulabilidad de las 6 columnas, escala 2, índices), C2 INSERTs REALES
  como los escribe el API (el ADELANTO del audio: $70,000 MXN a 18.5 sin mes
  ni avión ⇒ `monto_usd` 3,783.78; con mes y avión; con mes sin avión) y sus
  3 renglones INSERT en la bitácora con actor = created_by, C3 rechazos
  (periodo día 15, MXN sin T.C., USD con `monto_usd` ≠ monto, socio null, FK
  de avión y de `updated_by`, llave repetida, tabla ajena en la bitácora; los
  rechazos no dejan bitácora), C4 cuenta REAL (INSERT, trigger `updated_at`
  con un UPDATE REAL, saldo inicial negativo, PK duplicada, día 15, notas de
  501, NOT NULL, FK de socio; historial INSERT + UPDATE con el saldo inicial
  ANTERIOR 0 ⇒ −1,500.25 y actor), C5 lecturas del API (entregado 3,933.78 ⇒
  saldo −4,038.09 ADELANTADO), C6 soft delete con `updated_by` (fila
  conservada, llave reservada, baja en la bitácora con motivo y actor) y C7
  corrección de dinero REAL 100 ⇒ 10 USD (antes/después y actor; un UPDATE
  solo de sellos/llave no deja renglón; 7 renglones en total) ⇒ `DRYRUN_OK`;
  después `to_regclass('public.reparto_cuenta_socio')` y
  `to_regclass('public.reparto_bitacora')` ⇒ NULL,
  `to_regprocedure('public.tg_reparto_bitacora()')` ⇒ NULL, las columnas
  `saldo_snapshot_usd`/`updated_by` no existen y `periodo` vuelve a
  `is_nullable = NO` ⇒ `apply_migration` ⇒ `get_advisors` (esperado el INFO
  de RLS sin policies de las 2 tablas y FKs sin índice hacia `usuario`). El
  dry-run se corrió en PGlite (2-oct): DRYRUN_OK sin residuos, aplicar dos
  veces idempotente, dry-run sobre la aplicada ⇒ `DRYRUN_FALLA A`, bitácora
  con las escrituras del API y rollback probado. El API 0.0.50 es
  desplegable ANTES (lecturas `disponible:false`, escrituras 503
  `CUENTA_SOCIO_NO_DISPONIBLE`, pre-cierre con `lectura_fallida`). Tras
  aplicar: `GET /v1/profit-sharing/socios` ⇒ `disponible: true` (la sonda
  re-sondea en ≤ 10 min o reiniciar el API). Rollback al pie del archivo, en
  UNA transacción (`begin … commit`, jamás línea por línea): su paso 0
  ABORTA si existe CUALQUIER entrega v2 (`utilidad_snapshot_usd`, `periodo`
  o `aeronave_id` null — la v2 SIEMPRE deja `utilidad_snapshot_usd` null,
  también con avión y mes); exportar la cuenta y la bitácora antes.
- **APLICADA en prod el 1-oct-2026 (dry-run corrido en prod: `DRYRUN_OK · N4142R · socio Mauricio Roque · C1–C6`, sin residuos; después tabla, bucket privado, trigger e índices verificados y `get_advisors` solo con el INFO de RLS sin policies)** —
  `20261001000001_reparto_pago.sql` (invariante 38; la v2
  `20261002000001` la reforma a ENTREGAS de la cuenta corriente): tabla `reparto_pago`
  (RLS sin policies; índices parciales `(aeronave_id, socio_id, periodo)` y
  `(periodo)` con `deleted_at is null` + único parcial de
  `client_request_id`), `trg_reparto_pago_set_updated_at` y el bucket
  privado `reparto-comprobantes`. Sin enums, sin funciones, sin backfill, sin
  tocar tablas existentes. **Antes de aplicar**: el DRY-RUN de su cabecera
  (UNA sentencia `do $dry$`, la sección 1 pegada en B): A contexto (socio
  vigente en sep-2026 —de preferencia N4142R, el de mayor %— y un ADMIN
  activo; tabla y bucket NO existen), C1 estructura (RLS sin policies,
  índices, único, trigger, FKs `aeronave/socio/entregado_por = r`,
  `created_by/deleted_by = n`, `moneda` = text, T.C. con escala 6, bucket
  privado), C2 alta USD REAL, C3 alta MXN REAL (T.C. 18.234567 sin truncar,
  `monto_usd` 548.41, pagado vivo 1,944.35), C4 rechazos (MXN sin T.C., USD
  con T.C., T.C. 0, periodo día 15, monto 0, `monto_usd` 0, USD con
  `monto_usd` ≠ monto, método/moneda inválidos, largos, motivo/quién sin
  baja, FKs, NOT NULL, llave repetida), C5 UPDATE real (`updated_at`,
  corregir, MXN ↔ USD) y C6 soft delete (fila conservada, lectores sin
  borradas, llave reservada) ⇒ `DRYRUN_OK`; después
  `to_regclass('public.reparto_pago')` ⇒ NULL y 0 filas en `storage.buckets`
  para el bucket ⇒ `apply_migration` ⇒ `get_advisors` (esperado el INFO de
  RLS sin policies y FKs sin índice hacia `usuario`). El API 0.0.49 es
  desplegable ANTES (GET `disponible:false`, escrituras 503
  `PAGOS_SOCIOS_NO_DISPONIBLE`, pre-cierre con `lectura_fallida`). Tras
  aplicar: `GET /v1/profit-sharing/pagos?mes=2026-09` ⇒ `disponible: true`
  (la sonda re-sondea en ≤ 10 min o reiniciar el API) — registro de la v1:
  desde el 0.0.50 esa ruta con `?mes=` responde 410. Rollback al pie del
  archivo (el BUCKET se vacía y se borra con la Storage API: un `delete from
  storage.buckets` directo lo bloquea `protect_buckets_delete` con 42501).
- **APLICADA en prod el 30-sep-2026 (DRY-RUN corrido en prod: `DRYRUN_OK · par REAL`; verificado el 1-oct: columna, índice único y trigger existen)** —
  `20260930000001_movimiento_bancario_reverso.sql` (invariante 33):
  columna `movimiento_bancario.reverso_de_id` (FK a sí misma `on delete set
  null`) + índice ÚNICO parcial `uq_mov_bancario_reverso_de` + trigger
  `trg_mov_bancario_reverso` (función INVOKER con `search_path ''`, `tipo`
  comparado `::text`, `revoke execute` a public/anon/authenticated). Sin
  backfill ni cambios a triggers existentes. **Antes de aplicar**: el
  DRY-RUN de su cabecera (UNA sentencia `do $dry$`, la sección 1 pegada en
  B) — A contexto con el par REAL de GASTOS GNRAL (abono «CARGO INDEBIDO» +
  cargo pendiente de la misma cuenta y monto), C1 estructura (FK
  `confdeltype = 'n'`, índice único parcial, trigger), C2 UPDATE REALES del
  abono y del cargo como los escribe el API, C3 rechazos con
  `REVERSO_INVALIDO` (doble devolución, CARGO como devolución, destino
  ABONO, propia, otra cuenta, otro monto, cargo con gasto, cobro/monto/tipo/
  gasto sobre el par —el gasto pasa ANTES por `tg_mov_bancario_gasto_suma`
  sin rechazar—), C4 desemparejar deja los dos pendientes y el cargo acepta
  otra devolución, C5 tolerancia ±0.005 y ON DELETE SET NULL, C6 «Por
  conciliar» excluye la devolución ⇒ `DRYRUN_OK`; después la columna, la
  función y el índice NO existen. Corrido el 30-sep: `DRYRUN_OK · par REAL
  (abono 35d5c5eb…, cargo 2baee742…) · cobro libre t · gasto libre t ·
  pendientes 271`, sin residuos. Tras aplicar: `get_advisors` y sondear
  `GET /v1/conciliacion/movimientos/<abono>/reverso-candidatos` (200). El
  API 0.0.44 es desplegable ANTES (503 `REVERSOS_NO_DISPONIBLE` en lo nuevo;
  todo lo demás como el 0.0.43). Rollback al pie del archivo.
- **APLICADA en prod el 29-sep-2026 (DRYRUN_OK A–C6 en prod; antes probada en PGlite, idempotente)** — `20260929000002_vuelo_seguimiento.sql`
  (invariante 32): tabla `vuelo_seguimiento` + índice parcial por vuelo
  (`deleted_at is null`) + RLS + `trg_vuelo_seguimiento_updated_at`. Sin
  funciones nuevas, sin `moneda`, sin backfill. **Antes de aplicar**: el
  DRY-RUN de su cabecera (UNA sentencia `do $dry$`, la sección 1 pegada en
  B): C1 estructura y FK `confdeltype = 'c'`; C2 INSERT REAL con defaults
  PENDIENTE/true que **no mueve `vuelo.updated_at` ni encola Google**; C3
  CHECKs/FK (texto vacío/en blanco/1001/null, estado inventado, RESUELTA
  sin fecha, PENDIENTE con sello o resolución, resolución de 501,
  `deleted_by` sin `deleted_at`, vuelo/usuario inexistentes); C4 UPDATE real
  (updated_at, resolver, editar, reabrir); C5 las lecturas del API
  (contadores sin borradas ni no-cotización); C6 cascada REAL borrando un
  vuelo sin dinero ni ligas RESTRICT (en prod hay 66 candidatos; si otra
  liga lo impide, se salta con aviso) ⇒ `DRYRUN_OK`; después
  `to_regclass('public.vuelo_seguimiento')` ⇒ NULL ⇒ `apply_migration` ⇒
  `get_advisors` (esperado el INFO de RLS sin policies y FK sin índice a
  `usuario`, como las demás tablas). El API 0.0.43 es desplegable ANTES
  (lista `[]`, contadores 0, escrituras 503 `SEGUIMIENTO_NO_DISPONIBLE`).
  Rollback: `drop table public.vuelo_seguimiento;`.
- **APLICADA (28-sep-2026, DRYRUN_OK A–C; enum 19 → 20 con COMISION_VENDEDOR al final; aplicada ANTES del push del API 0.0.39)** — `20260928000001_categoria_comision_vendedor.sql`
  (invariante 31): `alter type public.categoria_gasto add value if not exists
  'COMISION_VENDEDOR'`, SOLA en su archivo (un valor nuevo de enum no se
  puede USAR en la transacción que lo crea). **Antes de aplicar**: el
  DRY-RUN 1 de su cabecera (UNA sentencia `do $dry$`: contexto 19 valores
  sin el nuevo, el cuerpo real, 20 valores con el nuevo AL FINAL, re-ejecución
  no-op ⇒ `DRYRUN_OK`); después `count(*)` del enum ⇒ 19 (nada quedó) ⇒
  `apply_migration` ⇒ 20 ⇒ `get_advisors`. Justo antes del push del API:
  `select 1 from pg_enum e join pg_type t on t.oid=e.enumtypid where
  t.typname='categoria_gasto' and e.enumlabel='COMISION_VENDEDOR'` ⇒ 1 fila
  (sin ella el 0.0.39 da 500 en la bandeja de pendientes, la alerta
  `gastos_sin_avion` y el alta de gastos).
- **APLICADA (28-sep-2026, DRYRUN_OK A–C7 con escrituras reales; `pg_get_constraintdef` verificado; advisors sin hallazgos nuevos)** —
  `20260928000002_gasto_comision_vendedor_exige_vuelo.sql` (invariante 31):
  CHECK `gasto_comision_vendedor_exige_vuelo` (`categoria::text <>
  'COMISION_VENDEDOR' or vuelo_id is not null`) + COMMENT. **Antes de
  aplicar** (con 000001 YA aplicada): el DRY-RUN 2 de su cabecera — INSERT
  REAL con vuelo (bitácora INSERT, `estatus_facturacion` PENDIENTE), UPDATE
  real (bitácora UPDATE), desligar el vuelo y alta sin vuelo ⇒ 23514 de ESTE
  CHECK y de ningún otro (un OTRO sin vuelo sigue pasando), reparto ⇒
  `gasto_reparto:` del trigger, conciliación ligar/desligar un cargo MXN
  libre JUNTO con `conciliado` (`movimiento_bancario_check`) y un cargo
  MAYOR ⇒ `GASTO_YA_CUBIERTO`, DELETE real (bitácora DELETE) ⇒ `DRYRUN_OK`;
  después: 0 gastos COMISION_VENDEDOR, 0 CHECK, el cargo de C6 libre, las 2
  PRUEBAS de #317 intactas ⇒ aplicar ⇒ `pg_get_constraintdef` ⇒
  `get_advisors`. Rollback: `alter table public.gasto drop constraint
  gasto_comision_vendedor_exige_vuelo;` (el valor del enum se queda,
  inofensivo). **Los dos guiones se probaron en PGlite (28-sep-2026)** con el
  esquema de prod de `gasto`/`gasto_bitacora`/`gasto_reparto`/
  `movimiento_bancario`/`cuenta_bancaria` y los 6 triggers REALES (textos
  copiados con SELECT de `pg_get_functiondef`), extraídos TAL CUAL de los
  comentarios de los archivos: DRY-RUN 2 antes de 000001 ⇒ `DRYRUN_FALLA A`;
  DRY-RUN 1 ⇒ `DRYRUN_OK` y el enum sigue en 19; 000001 dos veces ⇒ 20;
  DRY-RUN 2 ⇒ `DRYRUN_OK` con foto idéntica antes/después (C6 recorrido con un
  cargo MXN de 3,500.00); 000002 dos veces ⇒ 1 CHECK; los dos dry-runs sobre
  una base aplicada ⇒ `DRYRUN_FALLA A`; con el CHECK puesto, un INSERT real
  sin vuelo y el borrado de un vuelo con comisión (FK `on delete set null`)
  rebotan con 23514. NO aplicadas en esta ronda.
- **APLICADA (26-sep-2026, DRYRUN_OK A–C6; editores = [Alejandro Canales, Pablo Canales]; API 0.0.37; migración de DATOS, sin
  DDL ni triggers)** — `20260926000001_editores_cotizacion_cobrada.sql`
  (invariante 30): siembra la fila `editores_cotizacion_cobrada` con
  Alejandro Canales y Pablo Canales **solo si los dos son oficina ACTIVA**
  (si no, la sección 2 aborta con `EDITORES_ABORTADO`: una lista vacía no
  la podría cambiar nadie); `on conflict do nothing` (re-aplicar no pisa la
  lista editada desde Configuración). **Antes de aplicar**: el DRY-RUN de su
  cabecera (UNA sentencia `do $dry$ … $dry$` con la sección 1 pegada en B,
  C2, C3 y C6; INSERT/UPDATE/DELETE REALES —incluido el PUT con CAS y un
  UPDATE real de `usuario` que deja a Pablo INACTIVO para ejercer la
  guarda—) ⇒ `DRYRUN_OK`. Probado en PGlite con el esquema y las filas
  reales de prod: `DRYRUN_OK`, idempotente, guarda ⇒ `EDITORES_ABORTADO`.
  Tras aplicar: `select valor_json from configuracion_sistema where clave =
  'editores_cotizacion_cobrada'` (los dos uuids) y `GET /v1/me` con la
  sesión de Alejandro ⇒ `permisos.editar_cotizacion_cobrada: true` (caché
  60 s). El API 0.0.37 es desplegable ANTES (sin la fila nadie tiene el
  permiso: todo como el 0.0.36). Rollback: borrar la fila.
- **APLICADA (25-sep-2026, con el API 0.0.36 ya en prod; migración de DATOS, sin DDL; DRYRUN_OK C0–C7; resultado TC_OK: 77 — 63 entradas 29-ago × 17.0115, 4 entradas + 10 salidas 01-sep × 17.0077; utilidad de las 10 salidas 9,105.07 MXN; 0 movimientos USD sin T.C.)** — `20260925000003_inventario_tc_oficial_movimientos.sql`
  (invariante 8, «ÚLTIMO PRECIO DE COMPRA + T.C. DEL DÍA»): pone el T.C.
  oficial de su día (tabla `tipo_cambio_oficial`, ventana de 7 días del
  cotizador) a los 77 movimientos USD sin T.C. REGISTRADOS antes del 23-sep
  Cancún: 63 entradas del 29-ago a 17.0115; 4 entradas y 10 salidas del
  01-sep a 17.0077 (compras $1,351,908.88 + $18,196.87 MXN; ventas
  $45,524.17 / costo $36,419.10 / utilidad $9,105.07 MXN). NO toca `gasto`
  (ni `monto` ni `tc_gasto`). Guarda POR FILA (3 grupos, T.C. de su día;
  tolera un subconjunto ≤ 63/4/10; una fila ajena ⇒ `TC_ABORTADO` sin
  escribir), idempotente (`TC_YA_APLICADO`), informa lo posterior al corte
  sin tocarlo; sección 3 cambia la descripción de
  `inventario_margen_venta_pct` («último precio de compra»). **Antes de
  aplicar**: el DRY-RUN de su cabecera (sección 1 + `do $dry$`: DELETE de
  T.C. para ejercer el aborto, INSERT real de un movimiento posterior, la
  migración dos veces, huellas `to_jsonb` de `gasto` y del cardex, UPDATE
  real de la sección 3) ⇒ `DRYRUN_OK`. Probado en PGlite con los 81
  movimientos, las 40 filas de T.C. y la fila de configuración REALES de
  prod: `DRYRUN_OK`, `TC_OK: 77`, segunda vez `TC_YA_APLICADO (77 de los
  77)`, subconjunto ⇒ `TC_OK: 76`, fila ajena ⇒ `TC_ABORTADO` sin escribir.
  **Nunca antes del API 0.0.36** (con el 0.0.35 las ventas quedarían a
  17.0077 contra un costo FIFO a 17.0115). Tras aplicar:
  `GET /v1/inventory/tienda/resumen` ⇒ `utilidad_mxn 9105.07`,
  `utilidad_usd null`, `utilidad_usd_original 535.35`. El spec
  `inventario-tc-oficial.spec.ts` ata sus literales y la tabla de las 10
  salidas al util.
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

- **Hueco del libro (13-oct-2026, invariante 72)**: el gasto 12f38801
  (OPERACIONES $283.15, vuelo #255 de XA-VGV, sellado a N4142R SIN tramo,
  conciliado) no cuenta en NINGÚN balance: el libro de XA-VGV lo filtra por
  `avionDelGasto` (= N4142R) y el de N4142R no contiene el vuelo (sin tramo
  vivo suyo). Conciliación le da `balance: null` (sin enlace). Decide el
  cliente: corregir el avión del gasto o que el pre-cierre lo grite;
  verificar además el reparto y el Libro Dinero de ese mes.

- **Conciliación al revés (13-oct-2026, invariante 71)**: (a)
  `?conciliado=false` (filtro «Sin conciliar» de Gastos) también devuelve
  efectivo y bodega (NO_APLICA): comportamiento previo; (b) abrir el detalle
  del banco (hoja y columnas del Excel) a COORDINADOR/ANALISTA es decisión
  del cliente (hoy no leen movimientos, cuentas ni el bucket
  `estados-cuenta`); (c) la hoja no compara el T.C. guardado contra el
  oficial del día: ese aviso vive en el pre-cierre (invariante 70); (d)
  RESUELTO en la revisión del lote 2 (14-oct-2026): `ConciliacionService.
  resumen()` leía `movimiento_bancario` SIN paginar (999 filas en prod el
  13-oct; PostgREST corta en 1000) y la vista por default de Conciliación
  (sin fechas) habría contado de menos en silencio con la próxima
  importación. Hoy va con `leerPaginado` ordenado por la PK (`id` siempre
  en el select) y tope `RESUMEN_MOVIMIENTOS_TOPE` = 20,000: llegar a él ⇒
  400 `RESUMEN_MUY_GRANDE` («El periodo trae más de 20,000 movimientos del
  banco: elige un rango de fechas más corto para ver el resumen por
  cuenta.», `MENSAJE_RESUMEN_MUY_GRANDE`), jamás un total recortado; el
  panel lo dice con un aviso de degradación. Spec: bloque «resumen» de
  `conciliacion.service.lote.spec` (1,050 movimientos con max-rows 1000 ⇒
  cuenta los 1,050; 20,000 ⇒ 400).

- **Cruce USD ↔ pesos (13-oct-2026, invariante 70)**: (1) el aviso del
  pre-cierre `gastos_usd_tc_fuera_de_lugar` no tiene «descartar»: una compra
  legítima con sobreprecio del banco > 2 % saldrá cada mes (marcarla exige
  una columna nueva); (2) el margen ±2 % es estrecho (las correctas de prod
  llegan a +1.5 %): si se mueve, es la constante ÚNICA
  `TOLERANCIA_TC_OFICIAL_PCT` y se re-corre el spec con las ligas reales;
  (3) camino inverso (`intentarCruzarGasto`) diferido; (4) afinar el prompt
  de pyservices (sigue hablando de la banda 15–25) es otro contrato; (5) si
  julio o septiembre ya se cerraron, la corrección del 13-oct movió sus
  pesos (tubo −$1,725.25, bujías +$234.01, 516.35 USD a 17.550770): la
  oficina decide si se regeneran.

- **Concepto del SPEI (13-oct-2026, invariante 69)**: (1) **candado de
  reglas por texto** — el concepto que teclea un tercero se ve con
  `patronDevolucion`/`patronTraspaso` («devolución», «traspaso entre
  cuentas») en el re-cruce: una fila PENDIENTE completada podría salir en
  «Emparejar devoluciones» (confirma) o clasificarse como traspaso; la
  importación NO re-cruza. Revisión tras re-subir: `select fecha, tipo,
  monto, descripcion from public.movimiento_bancario where not conciliado and
  upper(descripcion) ~ '(DEVOLUCION|REVERSO|CONTRACARGO|RECLAMACION|TRASPASO
  ENTRE CUENTAS)' and fecha >= '2026-09-01'`; decide el cliente. (2)
  Persistir `saldo_posterior` (la columna existe y pyservices la lee) para
  emparejar gemelos EXACTOS a futuro. (3) Que `parse` reenvíe
  `banco`/`cuenta_moneda`. (4) El formato «… F A0422 …, SPID» de HSBC USD,
  que `facturaDeConcepto` no detecta (falso negativo aceptado).

- **TUA sistémica (13-oct-2026, invariante 66) — decisiones del cliente**:
  (a) el renglón del pre-cierre `tua_cobrada_sin_pagada` no tiene
  «descartar»: una TUA pagada en ventanilla sin factura deja el aviso vivo
  (marcarla exigiría una columna nueva, como `vuelos_sin_gasto_operaciones`);
  (b) no existe candado de mes cerrado para gastos: capturar la TUA incluida
  (o reanalizar + guardar) en un gasto viejo mueve el balance y el reparto de
  ESE mes (septiembre incluido) — avisar antes de regenerar un cierre;
  (c) un `tua_monto` con renglones que no cuadran NO separa (paso manual en
  «Verificar / editar»); separar con la señal sola se descartó a propósito
  (repararía lecturas rotas, caso #118).

- **Comisión del vendedor en DOS categorías (13-oct-2026, invariante 61)**
  — lo que el ajuste NO resuelve (decírselo al cliente): (1) **Libro Dinero
  frente a CHARTERS**: el Dinero resta las dos categorías (caja de
  VuelaTour); cuando CHARTERS/UTILIDAD tengan regla por avión, la «(avión)»
  que carga un avión debe dejar de restarse ahí (si no, se contaría dos
  veces). (2) `aircraft.metrics.finanzas`, `groups.gastosPorHijo` (por
  fecha_gasto, no ven la columna COMISIONES); el reporte por vuelo restaba
  el pago COTIZADO (RESUELTO el 13-oct-2026, invariante 73: resta el pago
  REAL, y desde la revisión del lote 2 con el K de los libros). (3)
  **Avión inactivo** que voló: absorbe la
  «(avión)» en el balance y no en el reparto (`compute()` solo trae
  activos); «otros movimientos» la marcaría «ningún libro de avión la
  cargó». (4) **No se puede cargar la «(avión)» a UN solo avión de un vuelo
  multi-avión**: se reparte por participación como la venta; si el cliente
  lo pide, es otra decisión. (5) **La «(avión)» de un vuelo sin avión de la
  flota aparece en la bandeja «sin avión»**, la alerta y el pre-cierre
  (`CATEGORIAS_GASTO_SIN_AVION` no puede llevar el literal); asignarle avión
  al gasto no cambia quién paga: reclasificarla a «(VuelaTour)».

- **Anticipo devuelto sin factura (14-oct-2026, invariante 60) — preguntas
  al cliente** (la regla del 0.0.77 asume lo que va entre paréntesis; 0
  casos en prod): (a) si se devuelve solo una parte (penalización por no
  show), ¿lo retenido lleva CFDI? (sí, cuando quedó en HSBC/Scotiabank;
  conservador con mezcla de cuentas en la misma moneda); (b) pesos de HSBC
  devueltos completos y dólares retenidos en efectivo (no exige: excepción
  consciente entre monedas; si en realidad se retuvieron los pesos y se
  devolvió en pesos el equivalente de los dólares, se perdería un CFDI);
  (c) la DIFERENCIA CAMBIARIA de un cancelado cuyo dinero se devolvió
  completo a otro T.C. sigue contando como venta en el reparto
  (`retieneCobros`; el pre-cierre la marca «diferencia cambiaria»);
  (d) al usuario: que el diálogo de reembolso del panel prellene moneda,
  método, cuenta y T.C. del cobro que se devuelve (evita el residuo
  cambiario y el 400 del candado de `createReembolso`).
- **Permiso AFAC pagado — RESUELTO el 14-oct-2026 (invariante 62)**: el
  cliente respondió «el AFAC lo cargan al Avión». Se queda lo del 0.0.74
  (cascada del avión + grupo PERMISO del reparto; fila «AFAC · matrícula»
  con egreso $0.00); el cambio alterno queda DESCARTADO. Candado nuevo del
  0.0.77: pre-cierre `permisos_sin_avion` (bloqueante). Prod al 14-oct-2026
  (9 PERMISO, MXN, todos con avión; solo #280 con vuelo): sep-2026 XA-VGV
  $5,000 · XB-PEV $1,000 (#280) · N4142R $2,680; oct-2026 XB-ANU $5,518 ·
  XA-VGV $18,278 (uno de 7,139 con `duplicado_sospechado`) · XB-PEV $381.
- **Aportación AFAC por hora (columna T) solo en el balance (14-oct-2026;
  NO implementar sin decisión del cliente)**: el balance la carga al avión
  dentro de `Y` (réplica del Excel del cliente: `X16 = 100*Z16*D16` en
  `Y16`) y la abona a VuelaTour en «AFAC · matrícula»; reparto, cuenta
  corriente, tablero, reporte por vuelo y Libro Dinero NO (DF §4.8 solo
  «(−) PERMISOS»). Así, además de reserva y fijos, «Reparto a socios» del
  balance y el reparto difieren ≈ 100 USD × horas cobradas × % (N4142R
  sep-2026 ≈ US$4,950; flota ≈ US$14,843, aprox.). Antecedente:
  AUDITORIA_DINERO P-P4. Pregunta: «¿La aportación AFAC de 100 USD/hr
  también se descuenta en el reparto a socios?».
- **Permiso de un vuelo EXTERNO sin avión**: no vive en ningún libro (el
  general no pinta su hoja «permisos»; ningún reparto); 0 casos; el
  candado `permisos_sin_avion` no lo cubre; decide el cliente quién lo
  carga.
- **Todo PERMISO se rotula «permiso AFAC pagado» (13-oct-2026, invariante
  62)**: la fila AFAC cita TODA la hoja «permisos» del avión (internación,
  nocturno, «mochada al comandante de AFAC MMCT»…), no solo los de AFAC;
  con egreso $0.00 no mueve TOTALES ni el bloque VUELATOUR (y no los
  moverá: el 14-oct-2026 el cliente decidió que el permiso lo carga el
  avión). Mitigación: concepto y
  nota llevan el detalle de cada gasto y la leyenda de pyservices lo dice
  («sean o no de AFAC»). Pendiente del cliente: subcategoría o proveedor AFAC
  para separarlos.

- **Comisiones a cargo del avión (pedido del cliente, 6-oct-2026)**:
  IMPLEMENTADO en el 0.0.65 (invariante 50: cobrado neto, columna
  COMISIONES, ganancia, «otros movimientos» y reparto después de comisiones
  desde septiembre de 2026; la provisión del vendedor solo en vuelos
  COMPLETADOS). Pendientes: (a) la decisión del cliente sobre la comisión
  bancaria ya cobrada al cliente como EXTRA (#293; detalle en la invariante
  50); (b) RESUELTO el 13-oct-2026 (panel 4eefb3b, invariante 61): el
  sublabel de «Comisiones (banco + vendedor)» de `avion-reparto-card.tsx`
  es `SUBLABEL_COMISIONES_REPARTO` («parte del avión de la comisión
  bancaria (regla sep-2026) + pagos «Comisión del vendedor (avión)»», sin
  «provisión»; lo vigila `categorias-gasto.test.ts`), el comentario de
  `kpi-strip.tsx` habla de los pagos «(avión)» y el PDF/XLSX del reparto
  dicen «pago real» con la bandera. (Historia: hasta el 0.0.73 el panel
  rotulaba «Comisiones de venta · regla anterior» y luego «+ provisión del
  vendedor»; ajuste 0.0.66 del 7-oct-2026: sin ingreso duplicado en «otros
  movimientos» y `comisiones_usd` en la cascada del general, invariante
  50.) (c) RESUELTO el 13-oct-2026 (invariante 61): ya
  no hay provisión que un pago menor pueda no cubrir — el avión carga lo
  pagado y el «parcial: faltan» solo informa contra lo cobrado. (d) Avisar al
  cliente con el deploy: «(−) COMISIONES» del general no es al centavo la
  fila del reparto cuando hay anticipos con comisión bancaria de vuelos aún
  no realizados (#314 de N4142R en septiembre, $5,000; #375 y #376 de XA-VGV
  en octubre). (e) Cambiar `comisiones_al_avion_desde` exige mandar antes
  `regla_comisiones` en los tres payloads (invariante 50, revisión del
  0.0.66). (f) SUPERSEDIDO el 12-oct-2026 (invariante 58): con el API 0.0.73
  ninguna fila de «otros movimientos» lleva la marca de PROVISIÓN ni el
  amarillo; el test `_FILA_CUBIERTA` de pyservices se adapta en su propio
  contrato (bandera `sin_provision_vendedor`). (g) RESUELTO el 13-oct-2026
  (invariante 61, dos categorías): el Libro Dinero ya no provisiona (sin
  gasto real no resta nada). Queda la diferencia ESPERADA con el bloque
  VUELATOUR == Σ de los pagos «Comisión del vendedor (avión)» que CARGA un
  avión (vuelo COMPLETADO, o CANCELADO con cobros retenidos, en CUALQUIER
  fecha —también antes de la vigencia—; llave informativa
  `utilidades_comision_vendedor_avion_mxn`): el Dinero, caja de VuelaTour,
  resta el pago; el Balance lo carga al avión en su columna COMISIONES. La
  «Comisión del vendedor (VuelaTour)» resta IGUAL en los dos libros (no
  abre diferencia). Unificarla exige columna por avión en 'dinero-vlos',
  decisión aparte. (h) HECHO en la revisión del 12-oct-2026:
  la `nota` del bloque VUELATOUR dice «pago al vendedor (solo el gasto real
  «Comisión del vendedor» capturado; …)» (invariante 47) y pyservices
  cambia con la bandera la base del pie del bloque («lo pagado (el pago al
  vendedor solo cuando se captura el gasto real …)»). (i) RESUELTO el
  13-oct-2026 (panel 4eefb3b, invariante 61): `AYUDA_COMISION_VENDEDOR`
  dice «La paga VuelaTour… No es costo del avión. Si el pago le toca al
  avión, usa «Comisión del vendedor (avión)»…» (sin «reemplaza la
  PROVISIÓN»; su test lo prohíbe), nace `AYUDA_COMISION_VENDEDOR_AVION` y
  ningún comentario de `categorias-gasto.ts` ni de
  `app/admin/expenses/schema.ts` habla de provisión. OJO a quien toque esa
  ayuda: la «Comisión del vendedor (VuelaTour)» NUNCA resta en la columna
  COMISIONES (tampoco en los vuelos de la vigencia); solo la «(avión)».

- **Conciliación por lotes (2-oct-2026, invariante 40)**: 1 cargo ↔ N
  gastos **HECHO** (API 0.0.52). Pendientes: 1 abono ↔ N cobros (depósito
  agrupado); motivo `SUMA_DE_VARIOS` en `anotarMotivoPendiente` y la IA de
  lotes (hoy ninguno propone un lote); qué hacer con los 35,536.33 de SAESA
  sin cargo importado (la oficina dice cómo se pagaron).

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
  el reparto a socios (fuera); ingreso con avión (desde el 13-oct-2026
  cuenta para ESE avión: invariante 67); reembolso
  de proveedor ligado a un gasto (ingreso de VuelaTour); venta de activos
  (resultado; la salida de bodega aparte); efectivo recibido y caja chica
  (no entra al fondo); devolución o retención de un anticipo sin vuelo
  (reclasificar / aplicar a un cancelado); avisos de pre-cierre para
  anticipos con saldo e ingresos sin conciliar (no se agregan); reversos
  (desde el 30-sep-2026 se EMPAREJA el abono con su cargo: invariante 33);
  depósito BillPocket agrupado 1 ↔ N (no);
  roles (COORDINADOR registra y aplica pero no concilia ni desaplica);
  préstamos con saldo de deuda (no); **auto-cruce de la cuenta Paywise con
  cobros por TRANSFERENCIA** (no: se ven como «1 con el monto exacto» y se
  ligan a mano o con la IA — caso #235); CFDI de anticipo (fuera; un
  anticipo DEVUELTO no lleva CFDI: decisión del cliente del 14-oct-2026,
  invariante 60); vuelo en
  un ingreso solo para reembolsos recibidos; líneas duplicadas del banco
  (se avisan, no se borran).
- **Hueco PREEXISTENTE (anotado el 24-sep-2026, no se tocó)**:
  `ConciliacionService.cargarCobrosPorMetodo` pide `.limit(2000)` a
  `cobro_vuelo` y PostgREST corta en 1000 sin avisar: con más de 1,000
  cobros bancarios en la ventana, «cobros sin banco», la auditoría Paywise
  y el pre-cierre verían una foto recortada (hoy hay 225 cobros en total).
  Lo nuevo de ingresos ya pagina.
- **Hueco PREEXISTENTE (anotado en la revisión adversaria del 24-sep-2026,
  no se tocó para cobros normales SIN abonos)**: `FlightsService.updateCobro`
  recalcula `comision_banco_monto` desde `comision_banco_pct` (4 decimales)
  siempre que el PATCH trae `monto`, aunque sea el MISMO: en montos grandes
  mueve centavos (98,765.43 con comisión 8,747.21 ⇒ 8,747.26). Para cobros
  de ANTICIPO ya se congela y, desde el 0.0.78 (invariante 77), también para
  los cobros CON abonos (directos o vía su sobre): el dinero reenviado sin
  cambio se congela y un cambio real ⇒ 409 `COBRO_CONCILIADO`. Queda abierto
  solo para los cobros normales sin abonos: decisión aparte.
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
