-- 17-sep-2026 · Nombre CORTO del piloto para el Google Calendar del mecánico.
--
-- Pedido del cliente (15-sep-2026): el calendario de Google lo sigue leyendo
-- UNA persona —Luis, el mecánico— y su título debe verse como los eventos que
-- la oficina capturaba a mano: «Saab N621TX cun-pce-ctm-pce-cun 6:50».
-- El primer nombre NO sirve: a «Alexander E. Saab» le dicen «Saab», a
-- «Abraham Zamora» «Zamora» y a «Pablo Canales» «Pab».
--
-- Columna de texto libre, opcional (null = se usa el primer nombre). El API
-- la valida a 20 caracteres en el DTO.
--
-- ATENCIÓN · ESTA MIGRACIÓN TOCA DOS TRIGGERS ⇒ DRY-RUN OBLIGATORIO antes de
-- aplicarla (regla del repo: un trigger roto es invisible para un `select`).
-- Guion de prueba en seco, con escrituras REALES y rollback:
--
--   begin;
--     -- 1) fan-out por apodo: debe encolar los vuelos del piloto
--     update public.usuario set apodo = 'ZZZ-dry-run'
--      where id = (select piloto_id from public.vuelo
--                   where piloto_id is not null
--                     and fecha_vuelo >= now() - interval '7 days' limit 1);
--     select count(*) from public.calendar_sync_cola where entidad = 'vuelo';
--     -- 2) trigger del vuelo con la columna nueva
--     update public.vuelo set avion_externo_matricula = 'XB-DRY'
--      where id = (select id from public.vuelo where es_externo is true limit 1);
--     select entidad, entidad_id, motivo from public.calendar_sync_cola
--      order by id desc limit 5;
--   rollback;
--
-- Tras aplicar: `get_advisors` y `GET /v1/calendar/sync-estado`
-- (`automatica: true`), y luego `POST /v1/calendar/resync` para reescribir
-- los eventos con el formato de UNA SOLA FILA.
alter table public.usuario add column if not exists apodo text;

comment on column public.usuario.apodo is
  'Nombre corto con el que la oficina conoce al usuario («Saab», «Zamora», «Pab»). Lo usa el TÍTULO del evento de Google Calendar del vuelo; null = se usa el primer nombre. Máx. 20 caracteres (validado en el API).';

-- ---------------------------------------------------------------------------
-- FAN-OUT del calendario: `apodo` entra a la lista de columnas que re-encolan
-- los vuelos del piloto (hasta hoy solo `nombre`). Sin esto, cambiar el apodo
-- desde el panel NO re-sincronizaba ningún evento y el título se quedaba con
-- el nombre viejo hasta la reconciliación nocturna.
--
-- Es la MISMA definición de `20260912000002_calendar_sync_cola.sql` con dos
-- cambios: el guard mira las dos columnas y el trigger escucha las dos.
-- ---------------------------------------------------------------------------
create or replace function public.calendar_sync_fanout_usuario()
returns trigger
language plpgsql
security definer
set search_path = ''
as $$
begin
  if new.nombre is not distinct from old.nombre
     and new.apodo is not distinct from old.apodo then
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

-- El trigger SOLO se pone si la cola existe: sin ella, su función insertaría
-- en una tabla inexistente y CUALQUIER cambio de nombre de usuario fallaría
-- (en prod la cola ya está aplicada; esta guarda protege una base nueva o de
-- pruebas donde alguien corra este archivo suelto).
do $$
begin
  if to_regclass('public.calendar_sync_cola') is null then
    raise notice 'calendar_sync: cola ausente, fan-out de usuario sin trigger';
    return;
  end if;
  execute 'drop trigger if exists trg_usuario_calendar_fanout on public.usuario';
  execute 'create trigger trg_usuario_calendar_fanout'
       || ' after update of nombre, apodo on public.usuario'
       || ' for each row execute function public.calendar_sync_fanout_usuario()';
end $$;

revoke execute on function public.calendar_sync_fanout_usuario() from public, anon, authenticated;

-- ---------------------------------------------------------------------------
-- TRIGGER DEL VUELO: `avion_externo_matricula` entra a las columnas que Google
-- pinta (revisión adversaria 17-sep-2026). Desde hoy la casilla «avión» del
-- título de un vuelo EXTERNO es esa matrícula («externo XB-ORN cun-ptu 8:30»)
-- y no el nombre del operador. Con la cola activa, los hooks del API ya NO
-- escriben directo a Google: si la columna no está en la lista del trigger,
-- editarla no encola nada y el título se queda viejo hasta la reconciliación
-- nocturna.
--
-- Misma forma que `20260912000002` (lista filtrada contra
-- information_schema: una columna que no exista se omite sola) y el MISMO
-- cuerpo de función, `public.calendar_sync_encolar()`, que no se toca.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
  v_lista text[] := array[
    'fecha_vuelo', 'fecha_traslado_final', 'estado', 'estado_permiso',
    'aeronave_id', 'piloto_id', 'es_externo', 'operador_externo',
    'avion_externo_matricula',
    'origen_iata', 'destino_iata', 'pasajeros', 'notas',
    'monto_total_usd', 'tipo', 'folio', 'cliente_id'
  ];
begin
  -- Sin la cola (migración 20260912000002 sin aplicar) no hay trigger que
  -- reemplazar: el API sigue con hooks directos y este bloque no aplica.
  if to_regclass('public.calendar_sync_cola') is null then
    raise notice 'calendar_sync: cola ausente, trigger de vuelo sin cambios';
    return;
  end if;

  select string_agg(quote_ident(candidata.nombre), ', ')
    into v_cols
    from unnest(v_lista) as candidata(nombre)
   where exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = 'vuelo'
        and ic.column_name = candidata.nombre
   );

  if v_cols is null then
    raise warning 'calendar_sync: vuelo sin columnas conocidas, trigger omitido';
    return;
  end if;

  execute 'drop trigger if exists trg_vuelo_calendar_sync on public.vuelo';
  execute format(
    'create trigger trg_vuelo_calendar_sync after insert or update of %s or delete on public.vuelo for each row execute function public.calendar_sync_encolar()',
    v_cols
  );
end $$;
