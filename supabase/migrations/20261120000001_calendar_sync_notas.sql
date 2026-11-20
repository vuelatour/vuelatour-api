-- 20-nov-2026 · LAS NOTAS DEL VUELO LLEGAN A GOOGLE CALENDAR: UN CAMBIO DE NOTA
-- VUELVE A PUBLICAR EL EVENTO.
--
-- Pedido de la oficina (20-nov-2026): «las notas que sí salgan en el google
-- calendar por favor porque ese es el que ve nuestro mecánico». El API 0.0.147
-- (`calendar/google-evento.util.ts#notasEventoVuelo`) pone en la descripción
-- del evento un bloque NOTAS con `vuelo.notas`, `vuelo.notas_internas`, la
-- nota de cada tramo (`escala.notas`) y la de su parada de servicio
-- (`escala.servicio_notas`). Hasta hoy solo salía `vuelo.notas` (7 de los 169
-- vuelos de los últimos 45 días); la oficina escribe casi todo en la nota del
-- tramo (33 vuelos: «QUITAR DOS ASIENTOS! SUPER IMPORTANTE») y en las notas
-- internas de la operación (14: «Dejar solo asiento del capi y copi»).
--
-- EL HUECO QUE CIERRA: con la cola activa (20260912000002) solo los TRIGGERS
-- encolan, y los dos del espejo son `AFTER … UPDATE OF <lista>`. Verificado
-- contra prod el 20-nov-2026 con `pg_get_triggerdef`:
--   · `trg_vuelo_calendar_sync`  trae `notas` pero NO `notas_internas`;
--   · `trg_escala_calendar_sync` NO trae `notas` NI `servicio_notas`.
-- Escribir o corregir una de esas notas en un vuelo que ya existe no encolaba
-- nada: el evento de Google se quedaba con el texto viejo hasta el reconcile
-- nocturno (00:15 Cancún). El alta (INSERT) y la baja de un tramo sí encolan
-- desde siempre (los triggers vigentes los cubren sin lista de columnas).
--
-- QUÉ HACE: agrega DOS triggers, SOLO de `UPDATE OF` esas columnas, con el
-- MISMO cuerpo de función (`public.calendar_sync_encolar()`, que NO se toca):
--   · `trg_vuelo_calendar_sync_notas`  → `vuelo.notas_internas`;
--   · `trg_escala_calendar_sync_notas` → `escala.notas`, `escala.servicio_notas`.
-- Los dos triggers vigentes NO se recrean: así este cambio no puede romper lo
-- que ya sincroniza (fechas, estado, avión, piloto, pasajeros, color). Si un
-- UPDATE toca a la vez una columna de las dos listas, la función corre dos
-- veces y su `insert … on conflict do update` deja UN solo item en la cola
-- (es idempotente). El anti-loop tampoco cambia: la función compara
-- `to_jsonb(OLD)` contra `to_jsonb(NEW)` sin los ids de Google ni
-- `updated_at`, así que solo encola cuando la nota cambió de verdad.
--
-- Volumen: `notas_internas` también recibe sellos del sistema (cancelación,
-- discrepancia aceptada, grupo): cada uno encola UNA vez su vuelo, y esas
-- operaciones ya encolaban por otra columna (`estado`, `aeronave_id`).
--
-- NO crea tablas, NO escribe filas, NO toca funciones ni los triggers
-- vigentes. Pero AGREGA TRIGGERS ⇒ DRY-RUN OBLIGATORIO con UPDATEs REALES
-- (regla del repo): `_dryrun/20261120000001_calendar_sync_notas.dryrun.sql`.
--
-- Orden de deploy: indistinto. Sin esta migración el API 0.0.147 ya publica
-- las notas (al crear el vuelo, al cambiarle cualquier otro dato y en el
-- reconcile nocturno); con ella, además, al momento de escribirlas.

do $$
begin
  -- Sin la cola (20260912000002 sin aplicar) no hay función que llamar: el
  -- API sigue con hooks directos y este bloque no aplica.
  if to_regprocedure('public.calendar_sync_encolar()') is null then
    raise notice 'calendar_sync: sin la función de la cola, triggers de notas omitidos';
    return;
  end if;

  create or replace trigger trg_vuelo_calendar_sync_notas
    after update of notas_internas on public.vuelo
    for each row execute function public.calendar_sync_encolar();

  create or replace trigger trg_escala_calendar_sync_notas
    after update of notas, servicio_notas on public.escala
    for each row execute function public.calendar_sync_encolar();

  comment on trigger trg_vuelo_calendar_sync_notas on public.vuelo is
    '20-nov-2026: las notas internas del vuelo salen en el evento de Google Calendar; al cambiar, se vuelve a publicar.';
  comment on trigger trg_escala_calendar_sync_notas on public.escala is
    '20-nov-2026: la nota del tramo y la de su parada de servicio salen en el evento de Google Calendar; al cambiar, se vuelve a publicar.';
end $$;
