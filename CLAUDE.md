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
