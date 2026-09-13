-- 12-sep-2026 · COLA PERSISTENTE DE SINCRONIZACIÓN A GOOGLE CALENDAR (D1).
--
-- PEDIDO DEL CLIENTE: «el calendario debe sincronizarse de forma AUTOMÁTICA
-- cada que se realizan cambios, sin sincronización manual; cualquier cambio
-- en un evento del calendario desde la app o el portal web debe sincronizar
-- también el Google Calendar; analiza a profundidad para que NUNCA falle;
-- contempla los ajustes que se hacen offline en la app y suben al
-- reconectar».
--
-- POR QUÉ UNA COLA EN LA BD Y NO MÁS HOOKS EN EL CÓDIGO (auditoría 12-sep):
--   * Los ~30 hooks `void this.calendar.syncFlight(id)` son best-effort: si
--     Google contesta 403 de cuota / 429 / 5xx / se cae la red, el cambio
--     queda DESINCRONIZADO hasta la reconciliación nocturna, y un vuelo
--     fuera de la ventana [-7d,+60d] podía quedar mal DÍAS.
--   * Hay caminos de escritura SIN hook (H1 `refreshPermisosDeVuelo` escribe
--     `estado_permiso` hasta +90 d; H2 `sincronizarEspejoIda` mueve
--     `aeronave_id`; H3 `updateEscala` solo espejaba ruta/fecha, no
--     pasajeros/es_ferry/orden; H4 fan-out de `aeronave.matricula`,
--     `aeronave.color_calendario`, `usuario.nombre`, `cliente.nombre`), más
--     los borrados en CASCADE y cualquier UPDATE hecho por SQL/MCP.
--   * Un TRIGGER no se puede olvidar: encola por CONSTRUCCIÓN, venga el
--     cambio del panel, de la app (online o desde su outbox al reconectar),
--     de un cron del API o de un UPDATE a mano en la BD.
--
-- 12-sep-2026 (D12, mismo archivo porque esta migración AÚN NO SE APLICÓ): se
-- agregan al final el ESTADO PERSISTIDO de la sync (`calendar_sync_estado`,
-- §7) y el CANDADO multi-réplica del barrido/drenado (`calendar_sync_candado`
-- + `calendar_sync_lock`/`calendar_sync_unlock`, §8), con su propia sonda
-- `calendar_sync_estado_activa()`. Las dos piezas son TOLERANTES: sin ellas el
-- API guarda los «últimos» solo en memoria y se excluye solo con sus banderas.
--
-- APLICARLA **ENCIENDE** LA COLA SIN REDEPLOY: el API sondea
-- `public.calendar_sync_cola_activa()` (1 vez, re-sondea cada ≤ 10 min,
-- `src/modules/calendar/calendar-sync-cola.util.ts`). Mientras no exista, el
-- worker no hace nada y los hooks siguen escribiendo DIRECTO a Google como
-- hoy: el deploy del API y esta migración pueden ir en cualquier orden.
--
-- PRUEBA MANUAL (no hay prueba pura de SQL en jest; correr en el SQL editor):
--   1) select public.calendar_sync_cola_activa();              -- true
--   2) update vuelo set notas = coalesce(notas,'') || ' x' where id = '<v>';
--      select * from calendar_sync_cola;                        -- 1 fila ('vuelo', <v>)
--   3) update vuelo set notas = notas where id = '<v>';         -- sin cambio real
--      → la fila NO se duplica y `siguiente_intento_at` se refresca.
--   4) update vuelo set google_calendar_id = 'x' where id = '<v>';
--      → NO encola (columna fuera del `update of`) y `updated_at` NO se mueve
--        (tg_set_updated_at redefinido abajo: sin deltas falsos ni 409
--        CONFLICTO_VERSION espurios contra el `if_updated_at` de la app).
--   4b) update gasto set monto_usd = monto_usd where id = '<g>';
--      → `updated_at` SÍ se mueve (como siempre). La excepción de arriba solo
--        aplica cuando cambia un id de Google: 23 tablas comparten este
--        trigger y ninguna otra cambia de comportamiento.
--   5) update vuelo set taco_salida … / captura de tacómetro en escala
--      → NO encola (esas columnas no salen en Google).
--   6) delete from escala where id = '<e>';
--      → 2 filas: ('vuelo', vuelo_id) y ('borrar_evento', <google_calendar_id>).
--   7) update aeronave set color_calendario = '#111111' where id = '<a>';
--      → encola sus vuelos/eventos/mantenimientos de los últimos 7 días y
--        los futuros (fan-out acotado, nunca la tabla entera).
--   8) Apagar la red del API y editar un vuelo: la fila se queda con
--      `intentos > 0`, `ultimo_error` y `siguiente_intento_at` en el futuro
--      (backoff). Al volver Google, el worker la sube y la BORRA.
--
-- ROLLBACK (si hiciera falta volver al comportamiento de hoy sin redeploy):
--   drop trigger trg_vuelo_calendar_sync on public.vuelo;  (y los demás)
--   → `calendar_sync_cola_activa()` responde false y el API vuelve a los
--     hooks directos en ≤ 10 min.

-- ===== 1) LA COLA =====

create table if not exists public.calendar_sync_cola (
  id bigserial primary key,
  entidad text not null check (
    entidad in ('vuelo', 'descanso', 'evento', 'mantenimiento', 'borrar_evento')
  ),
  -- Qué fila hay que volver a espejar (null solo en 'borrar_evento').
  entidad_id uuid,
  -- Id del evento de Google que quedó HUÉRFANO (capturado de OLD en el
  -- DELETE: es la única forma de matarlo, la fila ya no existe).
  google_event_id text,
  motivo text,
  intentos int not null default 0,
  siguiente_intento_at timestamptz not null default now(),
  -- Reclamo del worker (single-flight); > 5 min = el proceso murió y otro
  -- lo puede retomar.
  tomado_at timestamptz,
  ultimo_error text,
  creado_at timestamptz not null default now()
);

comment on table public.calendar_sync_cola is
  'Cola persistente del espejo sistema → Google Calendar (12-sep-2026). La alimentan TRIGGERS (vuelo, escala, piloto_descanso, evento_flota, mantenimiento + fan-out de aeronave/usuario/cliente) y la drena el worker del API cada 20 s con backoff exponencial. Un item vive hasta que Google lo acepta: si Google falla, el cambio NO se pierde.';
comment on column public.calendar_sync_cola.entidad is
  'vuelo | descanso | evento | mantenimiento (upsert por id) | borrar_evento (mata el evento de Google de una fila que ya no existe).';
comment on column public.calendar_sync_cola.intentos is
  'Fallos acumulados. El worker reprograma con min(30 s * 2^intentos, 1 h) y avisa a ADMIN al pasar de 12.';

-- Una sola fila pendiente por entidad: una ráfaga de 20 ediciones del mismo
-- vuelo se COLAPSA en un único trabajo (y refresca su turno).
create unique index if not exists uq_calendar_sync_cola_entidad
  on public.calendar_sync_cola (entidad, entidad_id)
  where entidad_id is not null;

-- Un solo borrado pendiente por evento de Google.
create unique index if not exists uq_calendar_sync_cola_borrar
  on public.calendar_sync_cola (google_event_id)
  where entidad = 'borrar_evento';

create index if not exists idx_calendar_sync_cola_listos
  on public.calendar_sync_cola (siguiente_intento_at, id);

-- El API escribe con service key; RLS sin políticas cierra anon/authenticated.
alter table public.calendar_sync_cola enable row level security;

-- ===== 2) ENCOLAR UN BORRADO DE EVENTO (ids capturados de OLD) =====

create or replace function public.calendar_sync_encolar_borrado(p_event_id text)
returns void
language plpgsql
security definer
set search_path = ''
as $$
begin
  if p_event_id is null or btrim(p_event_id) = '' then
    return;
  end if;
  insert into public.calendar_sync_cola (entidad, google_event_id, motivo)
  values ('borrar_evento', p_event_id, 'fila borrada en la BD')
  on conflict (google_event_id) where entidad = 'borrar_evento'
  do update set
    siguiente_intento_at = now(),
    intentos = 0,
    tomado_at = null,
    ultimo_error = null;
end;
$$;

comment on function public.calendar_sync_encolar_borrado(text) is
  'Encola el borrado en Google de un evento cuyo dueño (vuelo/tramo/descanso/evento/mantenimiento) ya no existe. Cierra los huérfanos: replaceEscalas, deleteEscala, DELETE por SQL y los ON DELETE CASCADE (aeronave → mantenimiento, usuario → piloto_descanso, vuelo → escala).';

-- ===== 3) EL TRIGGER QUE ENCOLA =====

create or replace function public.calendar_sync_encolar()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_fila jsonb;
  v_entidad text;
  v_id uuid;
  v_motivo text;
begin
  -- ANTI-LOOP (obligatorio): el propio worker escribe el id del evento en la
  -- fila al terminar. Si eso volviera a encolar, la sync se llamaría a sí
  -- misma para siempre y quemaría la cuota de Google. Se comparan OLD y NEW
  -- con las llaves de Google y `updated_at` NEUTRALIZADAS: si no cambió nada
  -- más, no hay nada que espejar.
  if tg_op = 'UPDATE' then
    if (to_jsonb(old) - 'google_calendar_id' - 'google_calendar_regreso_id' - 'updated_at')
       = (to_jsonb(new) - 'google_calendar_id' - 'google_calendar_regreso_id' - 'updated_at')
    then
      return null;
    end if;
  end if;

  if tg_op = 'DELETE' then
    v_fila := to_jsonb(old);
  else
    v_fila := to_jsonb(new);
  end if;
  v_motivo := tg_table_name || ' ' || lower(tg_op);

  -- Qué trabajo representa esta fila. El tramo NO tiene trabajo propio: se
  -- espeja junto con su vuelo (`syncFlight` publica un evento por tramo).
  if tg_table_name = 'vuelo' then
    v_entidad := 'vuelo';
    v_id := (v_fila ->> 'id')::uuid;
  elsif tg_table_name = 'escala' then
    v_entidad := 'vuelo';
    v_id := (v_fila ->> 'vuelo_id')::uuid;
  elsif tg_table_name = 'piloto_descanso' then
    v_entidad := 'descanso';
    v_id := (v_fila ->> 'id')::uuid;
  elsif tg_table_name = 'evento_flota' then
    v_entidad := 'evento';
    v_id := (v_fila ->> 'id')::uuid;
  elsif tg_table_name = 'mantenimiento' then
    v_entidad := 'mantenimiento';
    v_id := (v_fila ->> 'id')::uuid;
  end if;

  -- En el DELETE del propio vuelo no hay nada que volver a publicar (el
  -- worker lo resolvería como «no existe ⇒ hecho»), pero sí hay que matar
  -- sus eventos: eso lo hace el bloque de abajo con los ids de OLD.
  if v_entidad is not null and v_id is not null
     and not (tg_op = 'DELETE' and tg_table_name in ('vuelo', 'piloto_descanso', 'evento_flota', 'mantenimiento'))
  then
    insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
    values (v_entidad, v_id, v_motivo)
    on conflict (entidad, entidad_id) where entidad_id is not null
    do update set
      siguiente_intento_at = now(),
      motivo = excluded.motivo,
      intentos = 0,
      -- Libera el reclamo: si el worker estaba procesando la versión ANTERIOR
      -- de esta fila, su borrado del item fallará (compara `tomado_at`) y el
      -- cambio nuevo se vuelve a procesar en lugar de perderse.
      tomado_at = null,
      ultimo_error = null;
  end if;

  -- BORRADOS: capturar los ids de Google de OLD antes de que desaparezcan.
  if tg_op = 'DELETE' then
    perform public.calendar_sync_encolar_borrado(v_fila ->> 'google_calendar_id');
    perform public.calendar_sync_encolar_borrado(v_fila ->> 'google_calendar_regreso_id');
  end if;

  return null; -- AFTER … FOR EACH ROW: el valor de retorno se ignora.
end;
$$;

comment on function public.calendar_sync_encolar() is
  'Trigger que alimenta calendar_sync_cola desde vuelo/escala/piloto_descanso/evento_flota/mantenimiento. Ignora los updates que solo tocan los ids de Google o updated_at (anti-loop) y en DELETE captura los ids de OLD para borrar el evento huérfano.';

-- Triggers de las 5 tablas. En `vuelo` y `escala` se listan SOLO las columnas
-- que Google pinta (`AFTER UPDATE OF …`): así una captura de tacómetro, una
-- foto o un flag interno NO encolan nada. La lista se arma contra
-- information_schema para que la migración no falle si una columna cambia de
-- nombre en el futuro.
do $$
declare
  v_cols text;
  v_tabla text;
  v_lista text[];
begin
  foreach v_tabla in array array['vuelo', 'escala']
  loop
    if v_tabla = 'vuelo' then
      -- Todo lo que aparece en el título, la descripción o el color del
      -- evento (buildEvent/buildLegEvent + colores-calendario.util).
      v_lista := array[
        'fecha_vuelo', 'fecha_traslado_final', 'estado', 'estado_permiso',
        'aeronave_id', 'piloto_id', 'es_externo', 'operador_externo',
        'origen_iata', 'destino_iata', 'pasajeros', 'notas',
        'monto_total_usd', 'tipo', 'folio', 'cliente_id'
      ];
    else
      v_lista := array[
        'orden', 'origen_iata', 'destino_iata', 'fecha_salida_plan',
        'es_ferry', 'pasajeros', 'cancelada_at', 'estado_permiso',
        'aeronave_id', 'piloto_id', 'vuelo_id'
      ];
    end if;

    select string_agg(quote_ident(candidata.nombre), ', ')
      into v_cols
      from unnest(v_lista) as candidata(nombre)
     where exists (
       select 1 from information_schema.columns ic
        where ic.table_schema = 'public'
          and ic.table_name = v_tabla
          and ic.column_name = candidata.nombre
     );

    -- Ninguna columna de la lista existe: la tabla no es la que creemos.
    -- Mejor no poner trigger (la sonda dirá false y el API sigue con hooks)
    -- que crear uno que no encole lo correcto.
    if v_cols is null then
      raise warning 'calendar_sync: % sin columnas conocidas, trigger omitido', v_tabla;
      continue;
    end if;

    execute format('drop trigger if exists trg_%s_calendar_sync on public.%I', v_tabla, v_tabla);
    execute format(
      'create trigger trg_%s_calendar_sync after insert or update of %s or delete on public.%I for each row execute function public.calendar_sync_encolar()',
      v_tabla, v_cols, v_tabla
    );
  end loop;
end $$;

-- Descanso, evento de flota y mantenimiento: todas sus columnas importan
-- (son eventos pequeños) y el anti-loop ya filtra la escritura del id.
drop trigger if exists trg_piloto_descanso_calendar_sync on public.piloto_descanso;
create trigger trg_piloto_descanso_calendar_sync
  after insert or update or delete on public.piloto_descanso
  for each row execute function public.calendar_sync_encolar();

drop trigger if exists trg_evento_flota_calendar_sync on public.evento_flota;
create trigger trg_evento_flota_calendar_sync
  after insert or update or delete on public.evento_flota
  for each row execute function public.calendar_sync_encolar();

drop trigger if exists trg_mantenimiento_calendar_sync on public.mantenimiento;
create trigger trg_mantenimiento_calendar_sync
  after insert or update or delete on public.mantenimiento
  for each row execute function public.calendar_sync_encolar();

-- ===== 4) FAN-OUT: una fila satélite ⇒ N eventos (hueco H4) =====

-- `aeronave.matricula` y `aeronave.color_calendario` salen en el TÍTULO y el
-- COLOR de todos los eventos de ese avión. Acotado a la ventana operativa
-- (últimos 7 días y futuro): nunca la tabla entera.
create or replace function public.calendar_sync_fanout_aeronave()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.matricula is not distinct from old.matricula
     and new.color_calendario is not distinct from old.color_calendario then
    return null;
  end if;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'vuelo', v.id, 'aeronave actualizada'
    from public.vuelo v
   where v.fecha_vuelo >= now() - interval '7 days'
     and (
       v.aeronave_id = new.id
       or exists (
         select 1 from public.escala e
          where e.vuelo_id = v.id and e.aeronave_id = new.id
       )
     )
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'evento', ef.id, 'aeronave actualizada'
    from public.evento_flota ef
   where ef.aeronave_id = new.id
     and coalesce(ef.fecha_fin, ef.fecha) >= now() - interval '7 days'
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'mantenimiento', m.id, 'aeronave actualizada'
    from public.mantenimiento m
   where m.aeronave_id = new.id
     and m.fecha_programada >= (now() - interval '7 days')::date
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  return null;
end;
$$;

drop trigger if exists trg_aeronave_calendar_fanout on public.aeronave;
create trigger trg_aeronave_calendar_fanout
  after update of matricula, color_calendario on public.aeronave
  for each row execute function public.calendar_sync_fanout_aeronave();

-- `usuario.nombre`: el nombre corto del piloto va en el TÍTULO de cada vuelo
-- y tramo, y en «😴 Descansa · <nombre>»; el responsable, en el evento de
-- flota. Lo mueve `PATCH /v1/me` (también desde la app) y el admin.
create or replace function public.calendar_sync_fanout_usuario()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.nombre is not distinct from old.nombre then
    return null;
  end if;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'vuelo', v.id, 'nombre de usuario actualizado'
    from public.vuelo v
   where v.fecha_vuelo >= now() - interval '7 days'
     and (
       v.piloto_id = new.id
       or exists (
         select 1 from public.escala e
          where e.vuelo_id = v.id and e.piloto_id = new.id
       )
     )
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'descanso', d.id, 'nombre de usuario actualizado'
    from public.piloto_descanso d
   where d.piloto_id = new.id
     and d.fecha_fin >= (now() - interval '7 days')::date
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'evento', ef.id, 'nombre de usuario actualizado'
    from public.evento_flota ef
   where ef.responsable_id = new.id
     and coalesce(ef.fecha_fin, ef.fecha) >= now() - interval '7 days'
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  return null;
end;
$$;

drop trigger if exists trg_usuario_calendar_fanout on public.usuario;
create trigger trg_usuario_calendar_fanout
  after update of nombre on public.usuario
  for each row execute function public.calendar_sync_fanout_usuario();

-- `cliente.nombre`: línea «Cliente:» de la descripción del evento.
create or replace function public.calendar_sync_fanout_cliente()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.nombre is not distinct from old.nombre then
    return null;
  end if;

  insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
  select distinct 'vuelo', v.id, 'nombre de cliente actualizado'
    from public.vuelo v
   where v.cliente_id = new.id
     and v.fecha_vuelo >= now() - interval '7 days'
  on conflict (entidad, entidad_id) where entidad_id is not null
  do update set siguiente_intento_at = now(), intentos = 0, tomado_at = null;

  return null;
end;
$$;

drop trigger if exists trg_cliente_calendar_fanout on public.cliente;
create trigger trg_cliente_calendar_fanout
  after update of nombre on public.cliente
  for each row execute function public.calendar_sync_fanout_cliente();

-- ===== 5) SONDA PARA EL API (misma idea que updated_at_trigger_activo) =====

create or replace function public.calendar_sync_cola_activa()
returns boolean
language sql
stable
set search_path = ''
as $$
  select pg_catalog.to_regclass('public.calendar_sync_cola') is not null
     and (
       select count(distinct c.relname)
         from pg_catalog.pg_trigger t
         join pg_catalog.pg_class c on c.oid = t.tgrelid
         join pg_catalog.pg_namespace n on n.oid = c.relnamespace
         join pg_catalog.pg_proc p on p.oid = t.tgfoid
        where n.nspname = 'public'
          and p.proname = 'calendar_sync_encolar'
          and not t.tgisinternal
          and c.relname in ('vuelo', 'escala', 'piloto_descanso', 'evento_flota', 'mantenimiento')
     ) = 5;
$$;

comment on function public.calendar_sync_cola_activa() is
  'Sonda del API: true si la cola de sincronización a Google existe Y los 5 triggers que la alimentan están puestos. «La función responde true» ⇔ «la migración 20260912000002 ya se aplicó»: el API la consulta cada ≤ 10 min y enciende el modo automático sin reiniciar.';

-- Internas: nadie las invoca por PostgREST; el API escribe con service key.
revoke execute on function public.calendar_sync_cola_activa() from public, anon, authenticated;
grant execute on function public.calendar_sync_cola_activa() to service_role;
revoke execute on function public.calendar_sync_encolar() from public, anon, authenticated;
revoke execute on function public.calendar_sync_encolar_borrado(text) from public, anon, authenticated;
revoke execute on function public.calendar_sync_fanout_aeronave() from public, anon, authenticated;
revoke execute on function public.calendar_sync_fanout_usuario() from public, anon, authenticated;
revoke execute on function public.calendar_sync_fanout_cliente() from public, anon, authenticated;

-- ===== 6) EL ID DE GOOGLE NO MUEVE `updated_at` (D10) =====
--
-- `saveEventId`/`saveLegEventId`/`saveEventoFlotaEventId`/
-- `saveMantenimientoEventId` hacen un UPDATE de UNA columna (el id del
-- evento). Con el trigger de siempre eso movía `updated_at` SIN cambio de
-- negocio, y eso produce dos daños reales:
--   * deltas falsos en `GET /flights?updated_since` y `GET /calendar`
--     (la app se baja vuelos que no cambiaron), y
--   * 409 CONFLICTO_VERSION ESPURIOS contra el `if_updated_at` que manda la
--     cola offline de la app (invariante 13): el operador editó un vuelo sin
--     internet, la sync le movió el sello y al reconectar el API le dice
--     «alguien modificó este vuelo» cuando nadie lo tocó.
-- Ahora, si lo ÚNICO que cambió son los ids de Google, se conserva el
-- `updated_at` anterior. Cualquier cambio real sigue sellando `now()`.
--
-- RADIO DE ACCIÓN ACOTADO A PROPÓSITO (revisión adversaria 12-sep-2026): esta
-- función la comparten **37 triggers en 23 tablas** (gasto, cobro_vuelo,
-- inventario_movimiento, aeronave…), así que la excepción exige DOS
-- condiciones y no una:
--   1) que alguno de los dos ids de Google haya cambiado DE VERDAD, y
--   2) que el resto de la fila (sin `updated_at`) sea idéntica.
-- Sin la condición (1), un UPDATE que no cambia NADA —un PATCH que reenvía los
-- mismos valores, un upsert idempotente— dejaría de mover `updated_at` en
-- TODAS esas tablas: un cambio de semántica que nadie pidió y que este lote no
-- puede probar tabla por tabla. En las tablas que no tienen columnas
-- `google_calendar_*` ambos lados de (1) son NULL ⇒ la excepción NUNCA aplica
-- y el comportamiento es BYTE A BYTE el de hoy.
create or replace function public.tg_set_updated_at()
returns trigger
language plpgsql
set search_path = ''
as $$
declare
  v_old jsonb;
  v_new jsonb;
begin
  if tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    -- (1) ¿cambió un id de evento de Google? `->` da SQL NULL si la columna no
    -- existe en esta tabla, y `is distinct from` lo trata como «no cambió».
    if (v_old -> 'google_calendar_id') is distinct from (v_new -> 'google_calendar_id')
       or (v_old -> 'google_calendar_regreso_id') is distinct from (v_new -> 'google_calendar_regreso_id')
    then
      -- (2) …y NADA MÁS cambió: entonces no hubo cambio de negocio.
      if (v_old - 'google_calendar_id' - 'google_calendar_regreso_id' - 'updated_at')
         = (v_new - 'google_calendar_id' - 'google_calendar_regreso_id' - 'updated_at')
      then
        new.updated_at := old.updated_at;
        return new;
      end if;
    end if;
  end if;
  new.updated_at := now();
  return new;
end;
$$;

comment on function public.tg_set_updated_at() is
  'Sella updated_at en cada UPDATE real. EXCEPCIÓN (12-sep-2026): si lo único que cambió son google_calendar_id / google_calendar_regreso_id (la sync guardando el id del evento), conserva el updated_at anterior — así el espejo a Google no genera deltas falsos ni 409 CONFLICTO_VERSION contra el if_updated_at de la app offline.';

-- ===== 7) ESTADO PERSISTIDO DE LA SYNC (D12, 12-sep-2026) =====
--
-- `GET /v1/calendar/sync-estado` mostraba `ultimo_reconcile_at`,
-- `ultimo_resync_at`, `ultimo_resumen`, `ultimo_drenado_at` y `pausada_hasta`
-- desde la MEMORIA del proceso: un redeploy de Railway los dejaba en `null` y
-- el panel decía «nunca corrió» aunque el reconcile hubiera corrido esa
-- madrugada. Ahora se persisten acá y la memoria queda como CACHÉ.
--
-- POR QUÉ UNA TABLA NUEVA Y NO `configuracion_sistema`: esa tabla está
-- modelada como `clave varchar(60) / activa boolean / descripcion text`
-- (banderas de comportamiento), no tiene columna de valor JSON y la lee
-- `/me`; meterle documentos JSON sería desviarla de su contrato.
create table if not exists public.calendar_sync_estado (
  clave text primary key,
  valor jsonb not null default '{}'::jsonb,
  actualizado_at timestamptz not null default now()
);

comment on table public.calendar_sync_estado is
  'Estado VISIBLE del espejo sistema → Google Calendar que debe sobrevivir a un redeploy (D12, 12-sep-2026). Filas: «sync» = {ultimo_reconcile_at, ultimo_resync_at, ultimo_resumen} del barrido; «worker» = {ultimo_drenado_at, pausada_hasta} del drenado de la cola. Es DIAGNÓSTICO (lo pinta GET /v1/calendar/sync-estado), no un dato de negocio: borrarla solo pone los «últimos» en null otra vez.';

-- El API escribe con service key; RLS sin políticas cierra anon/authenticated.
alter table public.calendar_sync_estado enable row level security;

-- ===== 8) CANDADO MULTI-RÉPLICA DEL BARRIDO Y DEL DRENADO (D12) =====
--
-- El reconcile nocturno y el worker escriben DIRECTO a Google. Las banderas
-- `barriendo` / `drenando` del servicio son de MEMORIA: excluyen dos pasadas
-- del MISMO proceso, no dos réplicas. **Railway corre 1 réplica hoy**, así que
-- esto es PREVENTIVO: con 2 réplicas, dos reconciles simultáneos sobre un
-- vuelo sin `google_calendar_id` harían los dos `events.insert` y Google se
-- quedaría con un evento DUPLICADO cuyo id no vive en ninguna fila (fantasma
-- imborrable).
--
-- POR QUÉ **NO** ES `pg_try_advisory_lock` (de SESIÓN) — decisión deliberada:
-- el API habla con Postgres por PostgREST/pooler y NO controla en qué conexión
-- cae cada llamada. Un candado de sesión tomado en la conexión A no se puede
-- soltar desde la conexión B: `calendar_sync_unlock` fallaría en silencio y el
-- candado se quedaría tomado hasta que esa conexión muriera — es decir, la RED
-- DE SEGURIDAD nocturna dejaría de correr «para siempre», justo lo contrario
-- de lo que pidió el cliente. Por eso el candado es un ARRENDAMIENTO CON
-- VENCIMIENTO (fila + TTL), que se cura solo si el proceso muere, más
-- `pg_try_advisory_xact_lock` como serializador instantáneo de los que llegan
-- en el mismo milisegundo (ese sí se libera al terminar la transacción de la
-- función, no puede quedarse pegado).
create table if not exists public.calendar_sync_candado (
  clave int primary key,
  tomado_at timestamptz not null default now(),
  dueno text
);

comment on table public.calendar_sync_candado is
  'Arrendamiento (lease) del barrido/drenado de Google Calendar entre réplicas del API. 912001 = barrido (reconcile nocturno y POST /resync), 912002 = drenado de la cola. Vence por TTL: si el proceso muere a mitad, el siguiente lo toma y la red de seguridad NO se queda muerta.';

alter table public.calendar_sync_candado enable row level security;

create or replace function public.calendar_sync_lock(
  p_clave int,
  p_ttl_seg int default 7200,
  p_dueno text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_ok boolean;
  v_ttl int := greatest(coalesce(p_ttl_seg, 300), 30);
begin
  if p_clave is null then
    return false;
  end if;
  -- (a) Serializador instantáneo: dos réplicas que llegan juntas no pueden
  --     pasar las dos. Es de TRANSACCIÓN: se libera al terminar esta función.
  if not pg_catalog.pg_try_advisory_xact_lock(p_clave) then
    return false;
  end if;
  -- (b) Arrendamiento: lo que de verdad excluye durante los MINUTOS que dura
  --     el barrido. Se concede si no hay dueño o si el que había ya venció.
  insert into public.calendar_sync_candado as c (clave, tomado_at, dueno)
  values (p_clave, pg_catalog.now(), p_dueno)
  on conflict (clave) do update
     set tomado_at = pg_catalog.now(),
         dueno = p_dueno
   where c.tomado_at < pg_catalog.now() - pg_catalog.make_interval(secs => v_ttl)
  returning true into v_ok;
  return coalesce(v_ok, false);
end;
$$;

comment on function public.calendar_sync_lock(int, int, text) is
  'Toma el candado del barrido (912001) o del drenado (912002) de Google Calendar. true = concedido (hay que soltarlo con calendar_sync_unlock al terminar); false = otra réplica lo tiene y su arrendamiento NO ha vencido. NO usa pg_try_advisory_lock de sesión a propósito: por el pooler el unlock podría caer en otra conexión y el candado se quedaría tomado para siempre, matando la red de seguridad nocturna.';

-- Una versión ANTERIOR de 1 argumento dejaría dos sobrecargas y PostgREST no
-- sabría cuál llamar (la migración nunca se aplicó, pero si alguien corrió una
-- copia a mano, esto lo limpia).
drop function if exists public.calendar_sync_unlock(int);

-- `p_dueno` (revisión adversaria 12-sep-2026): el unlock se ACOTA al dueño.
-- Sin eso, una réplica que termina TARDÍSIMO (su arrendamiento ya venció y otra
-- lo tomó legítimamente) borraba el candado de la que sí está trabajando, y una
-- tercera podía entrar a escribir a Google en paralelo — el duplicado fantasma
-- que todo esto existe para evitar. Con `p_dueno` null se comporta como antes
-- (borra igual), así que una llamada vieja de 1 argumento sigue siendo válida.
create or replace function public.calendar_sync_unlock(
  p_clave int,
  p_dueno text default null
)
returns boolean
language plpgsql
security definer
set search_path = ''
as $$
declare
  v_borradas int;
begin
  delete from public.calendar_sync_candado
   where clave = p_clave
     and (p_dueno is null or dueno is not distinct from p_dueno);
  get diagnostics v_borradas = row_count;
  return v_borradas > 0;
end;
$$;

comment on function public.calendar_sync_unlock(int, text) is
  'Suelta el candado del barrido/drenado de Google Calendar; con p_dueno solo si ese proceso es el dueño (así una réplica atrasada no borra el arrendamiento de otra). Best-effort: si esta llamada se pierde, el arrendamiento vence solo por TTL.';

-- Sonda de ESTA parte (misma idea que calendar_sync_cola_activa): «la función
-- responde true» ⇔ «la tabla de estado y el candado ya están». Mientras
-- responda false, el API guarda los «últimos» SOLO en memoria y se excluye
-- solo con sus banderas — exactamente como antes de este lote.
create or replace function public.calendar_sync_estado_activa()
returns boolean
language sql
stable
set search_path = ''
as $$
  select pg_catalog.to_regclass('public.calendar_sync_estado') is not null
     and pg_catalog.to_regclass('public.calendar_sync_candado') is not null
     and exists (
       select 1
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'calendar_sync_lock'
     )
     and exists (
       select 1
         from pg_catalog.pg_proc p
         join pg_catalog.pg_namespace n on n.oid = p.pronamespace
        where n.nspname = 'public' and p.proname = 'calendar_sync_unlock'
     );
$$;

comment on function public.calendar_sync_estado_activa() is
  'Sonda del API (D12): true si la tabla calendar_sync_estado, la tabla calendar_sync_candado y las funciones calendar_sync_lock/unlock ya existen. El API la consulta 1 vez (re-sondea cada ≤ 10 min): aplicar la migración enciende el estado persistido y el candado sin redeploy.';

-- Internas: nadie las invoca por PostgREST; el API escribe con service key.
revoke execute on function public.calendar_sync_estado_activa() from public, anon, authenticated;
grant execute on function public.calendar_sync_estado_activa() to service_role;
revoke execute on function public.calendar_sync_lock(int, int, text) from public, anon, authenticated;
grant execute on function public.calendar_sync_lock(int, int, text) to service_role;
revoke execute on function public.calendar_sync_unlock(int, text) from public, anon, authenticated;
grant execute on function public.calendar_sync_unlock(int, text) to service_role;

-- PRUEBA MANUAL del candado (SQL editor):
--   select public.calendar_sync_estado_activa();            -- true
--   select public.calendar_sync_lock(912001, 7200);         -- true  (lo toma)
--   -- en OTRA sesión (la misma no puede: el xact lock ya se soltó, pero el
--   -- arrendamiento sigue vigente):
--   select public.calendar_sync_lock(912001, 7200);         -- false (ocupado)
--   select public.calendar_sync_unlock(912001);             -- true  (lo suelta)
--   -- acotado al dueño: con OTRO dueño no lo suelta
--   select public.calendar_sync_lock(912001, 7200, 'api:1');
--   select public.calendar_sync_unlock(912001, 'api:2');     -- false (no es suyo)
--   select public.calendar_sync_unlock(912001, 'api:1');     -- true
--   select public.calendar_sync_lock(912001, 7200);         -- true  (ya no hay dueño)
--   -- vencimiento: con el candado tomado, forzar TTL vencido y reintentar
--   update public.calendar_sync_candado set tomado_at = now() - interval '3 h'
--    where clave = 912001;
--   select public.calendar_sync_lock(912001, 7200);         -- true  (se curó solo)
