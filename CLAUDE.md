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
   - La salida se llena sola: tramo 1 ← último taco del avión (en `start()` y
     en `captureTaco`); tramos 2+ ← propagación de la llegada anterior;
     huecos ← `fillTacoGaps` (nightly) / `deduceTacosEnVivo` (cada 10 min).
   - EXCEPCIÓN (jul 2026): en el TRAMO 1 el piloto sí puede fotografiar la
     salida (arranque del vuelo); su captura PILOTO puede corregir hacia abajo
     una salida DEDUCIDO (la foto es evidencia; PILOTO/OFICINA no se bajan).
   - `taco_salida_origen`/`taco_llegada_origen` ∈ {PILOTO, IA, DEDUCIDO,
     OFICINA} se setean en TODOS los caminos de escritura. No perderlos.
   - `start()` NUNCA bloquea por tacómetro; `complete()` solo exige LLEGADAS
     (`faltanLlegadas`) — las salidas son del sistema.
   - La lectura IA de sync offline queda amarilla (`revision_requerida`) y no
     se propaga sin confirmación; `confirmTaco` notifica al piloto.

6. **Cotización vs operación**: si `vuelo.itinerario_operativo = true`,
   `quotes.replaceEscalas` hace early-return (la cotización JAMÁS pisa las
   escalas del piloto). `replaceEscalas` es UPSERT: no destruye tacos.

7. **Conciliación**: auto-match solo `medio_pago IN (TARJETA_CORP,
   TRANSFERENCIA)` + moneda de la cuenta. `BODEGA` (cargo contable de
   inventario), `EFECTIVO` (caja chica) y `PERSONAL_*` (reintegros) nunca se
   cruzan con el banco. ABONOS se cruzan con `cobro_vuelo` vía
   `movimiento_bancario.cobro_id`.

8. **Inventario→gastos**: una SALIDA de cardex genera gasto `REFACCION` medio
   `BODEGA` (moneda USD, costo FIFO) ligado por `inventario_movimiento_id`;
   la devolución lo revierte. No duplicar ese costo en otro lado.

9. **Candados de rol**: el PILOTO solo registra cobros con método ∈
   {EFECTIVO, DOLARES, BILLPOCKET, HSBC_LINK} (se valida el del vuelo Y el del
   DTO); piloto/mecánico solo editan/borran SU gasto y SOLO el mismo día
   Cancún (`assertOwnSameDay`). Squawk severidad ALTA sin resolver bloquea
   asignar el avión.

## Convenciones NestJS

- **Orden de rutas**: las rutas literales (`taco-live`, `descansos`,
  `pre-cierre`, `resumen`) se declaran ANTES de las rutas `':id'` del mismo
  segmento, o Nest las captura como id.
- Crones: deducción taco-live `*/10 * * * *`; cierre de tacos `45 4 * * *`
  UTC (23:45 Cancún); vuelos zombi `55 4 * * *`; alertas diarias
  `0 8 * * *` con `timeZone: America/Cancun`. Nuevas alertas necesitan fila
  en `alerta_config` (migración) o `safe()` las salta.
- Notificaciones: `notifications.notifyUser/notifyRole`; dedupe de alertas vía
  `alerta_emitida` (`markIfNew`). Los tipos que la app Flutter sabe pintar:
  `vuelo_asignado, taco_capturado, cobro_registrado, gasto_registrado,
  permiso_emitido, mantenimiento_programado, recordatorio_taco,
  alerta_sistema`. Links `/flights/<id>` redirigen al vuelo en la app.
- Espejo vuelo↔tramo 1: `aeronave_id/piloto_id/fecha` del vuelo se reflejan en
  la escala orden=1 (`mirrorVueloToIdaEscala`) y viceversa. Reagendar
  `fecha_vuelo` con el mismo piloto → push al piloto (doc 4.3).

## Migraciones y despliegue

- Migración = archivo en `supabase/migrations/` **y** aplicada vía MCP al
  proyecto prod `bjesduasnzbzywofukbf` (existen dos proyectos; verificar).
  Tras DDL correr `get_advisors`. RLS habilitado en todas las tablas (la API
  usa service key).
- Push a `main` = deploy automático en Railway. El usuario autorizó push
  directo de este repo sin preguntar.
- Build/typecheck requiere `NODE_OPTIONS=--max-old-space-size=4096`.

## Pendientes conocidos (no implementar sin decisión del cliente)

- Candado de cobro anticipado (origen ≠ CUN), regla TUAS por tramo, monto de
  pernocta al piloto, costo de PILOTO como categoría del reparto (doc 4.8) —
  esperan reunión con el cliente.
- Complementos de pago REP (A2), Calendar bidireccional (Fase C), clasificación
  IA de facturas recibidas, `factura_recibida.gasto_id` no actualiza
  `gasto.estatus_comprobante` al amarrar.
