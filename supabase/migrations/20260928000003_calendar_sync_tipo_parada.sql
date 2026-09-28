-- 28-sep-2026 · SEMÁFORO DE 7 COLORES: `tipo_parada` ENTRA AL TRIGGER DEL
-- ESPEJO DE LOS TRAMOS.
--
-- Pedido del cliente (28-sep-2026): «los vuelos de Servicio, poner en color
-- Café en el calendario web, app y google calendar». El API
-- (`calendar/colores-calendario.util.ts`, API 0.0.40) pinta de CAFÉ
-- (`#8B5E3C`) el vuelo de SERVICIO —tramos activos, alguno con
-- `tipo_parada = 'SERVICIO'` y ninguno con pasajeros; regla ÚNICA en
-- `common/vuelo-servicio.util.ts`— en el panel, en la app y en el Google
-- Calendar de la oficina (café → colorId 6 Mandarina, FIJO: Google no tiene
-- café).
--
-- EL HUECO QUE CIERRA: con la cola activa (20260912000002) los hooks del API
-- ya NO escriben directo a Google; solo el TRIGGER encola. Y
-- `trg_escala_calendar_sync` es `AFTER … UPDATE OF <lista>` —
-- `tipo_parada` NO está en esa lista (`pasajeros` SÍ, desde el 12-sep).
-- Marcar un tramo como Servicio (o quitarle la marca) desde el cotizador, el
-- detalle del vuelo o la app solo escribe `escala.tipo_parada`, así que NO se
-- encolaba nada y el evento de Google se quedaba con el color viejo hasta el
-- reconcile nocturno (00:15 Cancún). El panel y la app no tienen este problema
-- (leen `GET /v1/calendar` al momento).
--
-- QUÉ HACE: recrea `trg_escala_calendar_sync` con la MISMA lista vigente —la
-- de `20260912000002_calendar_sync_cola.sql`, verificada contra prod el
-- 28-sep-2026 con `pg_get_triggerdef`: `orden, origen_iata, destino_iata,
-- fecha_salida_plan, es_ferry, pasajeros, cancelada_at, estado_permiso,
-- aeronave_id, piloto_id, vuelo_id`— MÁS `tipo_parada`. Misma forma (lista
-- filtrada contra information_schema, en el orden de la lista) y el MISMO
-- cuerpo de función, `public.calendar_sync_encolar()`, que NO se toca:
-- compara `to_jsonb(OLD)` vs `to_jsonb(NEW)` sin los ids de Google ni
-- `updated_at`, así que un cambio real de `tipo_parada` SÍ pasa el anti-loop
-- (y no menciona columnas por nombre, ni compara el ENUM contra texto).
--
-- Volumen: marcar/desmarcar una parada de servicio es raro (7 vuelos de
-- servicio en toda la historia de prod al 28-sep-2026); cada cambio encola
-- UNA vez el vuelo del tramo (la cola colapsa ráfagas por vuelo).
--
-- NO crea tablas, NO escribe filas, NO toca funciones. Pero TOCA UN TRIGGER
-- ⇒ DRY-RUN OBLIGATORIO con UPDATEs REALES (regla del repo: un trigger roto
-- es invisible para un `select`). `tipo_parada` es un ENUM
-- (`public.tipo_parada`): en el guion se compara SIEMPRE `::text` y se
-- escribe con cast explícito (lección del ENUM `moneda`, 15-sep-2026). Guion,
-- todo dentro de una transacción que se revierte (el paso C termina con
-- `raise exception 'DRYRUN_OK …'`, así que aunque se olvide el `rollback` no
-- queda nada escrito):
--
--   begin;
--   create temp table _dry_servicio (
--     escala_a uuid, vuelo_a uuid, escala_b uuid, vuelo_b uuid
--   ) on commit drop;
--
--   -- A) EL BUG, reproducido con la lista VIGENTE: cambiar `tipo_parada` de
--   --    un tramo cuyo vuelo NO tiene item en la cola NO encola nada.
--   do $a$
--   declare e1 uuid; v1 uuid; e2 uuid; v2 uuid;
--   begin
--     if to_regclass('public.calendar_sync_cola') is null then
--       raise exception 'DRYRUN_FALLA: calendar_sync_cola no existe';
--     end if;
--     -- Dos tramos de vuelos DISTINTOS sin item pendiente (si ya tuvieran
--     -- uno, el upsert de la cola lo refresca y no se notaría la diferencia).
--     select e.id, e.vuelo_id into e1, v1 from public.escala e
--      where not exists (select 1 from public.calendar_sync_cola c
--                         where c.entidad = 'vuelo' and c.entidad_id = e.vuelo_id)
--      order by e.updated_at desc nulls last limit 1;
--     select e.id, e.vuelo_id into e2, v2 from public.escala e
--      where e.vuelo_id <> v1
--        and not exists (select 1 from public.calendar_sync_cola c
--                         where c.entidad = 'vuelo' and c.entidad_id = e.vuelo_id)
--      order by e.updated_at desc nulls last limit 1;
--     if e1 is null or e2 is null then
--       raise exception 'DRYRUN_FALLA: no hay dos tramos fuera de la cola';
--     end if;
--     insert into _dry_servicio values (e1, v1, e2, v2);
--     update public.escala
--        set tipo_parada = (case when tipo_parada::text = 'SERVICIO'
--                                then 'NORMAL' else 'SERVICIO' end)::public.tipo_parada
--      where id = e1;
--     if exists (select 1 from public.calendar_sync_cola c
--                 where c.entidad = 'vuelo' and c.entidad_id = v1) then
--       raise exception 'DRYRUN_FALLA A: tipo_parada YA encolaba (¿migración ya aplicada?)';
--     end if;
--     update public.escala  -- se regresa
--        set tipo_parada = (case when tipo_parada::text = 'SERVICIO'
--                                then 'NORMAL' else 'SERVICIO' end)::public.tipo_parada
--      where id = e1;
--     raise notice 'okA · el bug existe: cambiar tipo_parada no encola';
--   end $a$;
--
--   -- B) CUERPO REAL DE LA MIGRACIÓN: pegar aquí, TAL CUAL, el bloque
--   --    `do $$ … $$;` de la sección 1) de abajo (no una copia a mano: un
--   --    error de plpgsql dentro de un `do` es INVISIBLE para un `select`).
--
--   -- C) Verificación con UPDATEs REALES.
--   do $c$
--   declare e1 uuid; v1 uuid; e2 uuid; v2 uuid; v_def text; v_cola_v2 int;
--   begin
--     select d.escala_a, d.vuelo_a, d.escala_b, d.vuelo_b
--       into e1, v1, e2, v2 from _dry_servicio d;
--     select pg_get_triggerdef(t.oid) into v_def
--       from pg_trigger t
--       join pg_class c on c.oid = t.tgrelid
--       join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname = 'public' and c.relname = 'escala'
--        and t.tgname = 'trg_escala_calendar_sync';
--     if v_def is null or v_def not like '%tipo_parada%' then
--       raise exception 'DRYRUN_FALLA C1: el trigger no escucha tipo_parada: %', v_def;
--     end if;
--     -- La lista vieja COMPLETA sigue ahí, en su orden (no se perdió ninguna
--     -- columna) y `tipo_parada` va al final.
--     if v_def not like '%UPDATE OF orden, origen_iata, destino_iata, fecha_salida_plan, es_ferry, pasajeros, cancelada_at, estado_permiso, aeronave_id, piloto_id, vuelo_id, tipo_parada ON public.escala%' then
--       raise exception 'DRYRUN_FALLA C2: la lista cambió más de la cuenta: %', v_def;
--     end if;
--     -- C3) cambiar `tipo_parada` ⇒ la cola SUBE 1 (el item del vuelo v1).
--     update public.escala
--        set tipo_parada = (case when tipo_parada::text = 'SERVICIO'
--                                then 'NORMAL' else 'SERVICIO' end)::public.tipo_parada
--      where id = e1;
--     if not exists (select 1 from public.calendar_sync_cola c
--                     where c.entidad = 'vuelo' and c.entidad_id = v1
--                       and c.motivo = 'escala update') then
--       raise exception 'DRYRUN_FALLA C3: cambiar tipo_parada NO encoló el vuelo';
--     end if;
--     -- C4) una columna FUERA de la lista ⇒ la cola NO sube.
--     update public.escala
--        set servicio_notas = coalesce(servicio_notas, '') || ' [dry-run]'
--      where id = e2;
--     select count(*) into v_cola_v2 from public.calendar_sync_cola c
--      where c.entidad = 'vuelo' and c.entidad_id = v2;
--     if v_cola_v2 <> 0 then
--       raise exception 'DRYRUN_FALLA C4: servicio_notas encoló (% items)', v_cola_v2;
--     end if;
--     -- C5) reescribir `tipo_parada` con el MISMO valor no inventa trabajo:
--     --     el anti-loop compara filas y no hay item nuevo para v2.
--     update public.escala set tipo_parada = tipo_parada where id = e2;
--     select count(*) into v_cola_v2 from public.calendar_sync_cola c
--      where c.entidad = 'vuelo' and c.entidad_id = v2;
--     if v_cola_v2 <> 0 then
--       raise exception 'DRYRUN_FALLA C5: tipo_parada sin cambio encoló (% items)', v_cola_v2;
--     end if;
--     -- C6) `pasajeros` (la otra mitad de la regla) SIGUE encolando.
--     update public.escala set pasajeros = coalesce(pasajeros, 0) + 1 where id = e2;
--     if not exists (select 1 from public.calendar_sync_cola c
--                     where c.entidad = 'vuelo' and c.entidad_id = v2
--                       and c.motivo = 'escala update') then
--       raise exception 'DRYRUN_FALLA C6: cambiar pasajeros ya NO encola';
--     end if;
--     raise exception 'DRYRUN_OK · C1 trigger con tipo_parada · C2 lista intacta · C3 tipo_parada encola · C4 servicio_notas no encola · C5 sin cambio no encola · C6 pasajeros encola · todo se revierte';
--   end $c$;
--   rollback;
--
-- Resultado esperado: `okA …` en los avisos y el error final
-- `DRYRUN_OK · …` (es el que revierte). Cualquier `DRYRUN_FALLA …` = NO
-- aplicar. Después del `rollback`, `pg_get_triggerdef` del trigger debe seguir
-- SIN `tipo_parada` (la lista de 11 columnas de hoy).
--
-- TRAS APLICAR: `get_advisors`; `pg_get_triggerdef` con `tipo_parada`; y
-- —como con cualquier cambio de COLOR— RE-PINTAR lo ya publicado: los vuelos
-- de servicio de la ventana [hoy−30d, hoy+365d] pasan de su color de antes
-- (verde/amarillo/azul) a 6 Mandarina. La cola no se entera sola de un color
-- que cambió en el código. Basta con encolar SOLO esos vuelos (lo hace el
-- worker en ≤ 20 s; no hace falta el resync completo):
--
--   insert into public.calendar_sync_cola (entidad, entidad_id, motivo)
--   select 'vuelo', v.id, 'repintar servicio (café, 28-sep-2026)'
--     from public.vuelo v
--    where v.fecha_vuelo is not null
--      and v.estado::text <> 'CANCELADO'
--      and v.fecha_vuelo <= now() + interval '365 days'
--      and (v.fecha_fin >= now() - interval '30 days'
--           or (v.fecha_fin is null and v.fecha_vuelo >= now() - interval '30 days'))
--      and exists (select 1 from public.escala e
--                   where e.vuelo_id = v.id and e.cancelada_at is null
--                     and e.tipo_parada::text = 'SERVICIO')
--      and not exists (select 1 from public.escala e
--                       where e.vuelo_id = v.id and e.cancelada_at is null
--                         and coalesce(e.pasajeros, 0) > 0)
--   on conflict (entidad, entidad_id) where entidad_id is not null
--   do update set siguiente_intento_at = now(), motivo = excluded.motivo,
--                 intentos = 0, tomado_at = null, ultimo_error = null
--   returning entidad_id;
--
-- (Foto de prod del 28-sep-2026: 3 vuelos — #300, #306 y #350 —, los tres con
-- evento en Google.) O esperar al reconcile de las 00:15.
--
-- ORDEN DE DESPLIEGUE: indiferente. El API nuevo sin esta migración ya pinta
-- el café en el panel, la app y en cada evento de Google que se reescriba por
-- cualquier otro motivo; solo falta el disparo AL MARCAR la parada. Esta
-- migración con el API viejo encola de más (una vez por cambio de parada) y
-- republica el evento con el mismo color: inofensivo.
--
-- ROLLBACK (volver a la lista de 11): correr el bloque `do $$` de
-- `20260912000002_calendar_sync_cola.sql` (sección 3, «Triggers de las 5
-- tablas»); recrea también el de `vuelo`, pero con la lista VIEJA —sin
-- `avion_externo_matricula` ni `cobrado`—, así que después hay que correr el
-- bloque de `20260924000002_calendar_sync_cobrado.sql`.

-- ---------------------------------------------------------------------------
-- 1) TRIGGER DEL TRAMO: la lista de `20260912000002` + `tipo_parada`.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
  v_lista text[] := array[
    'orden', 'origen_iata', 'destino_iata', 'fecha_salida_plan',
    'es_ferry', 'pasajeros', 'cancelada_at', 'estado_permiso',
    'aeronave_id', 'piloto_id', 'vuelo_id',
    -- 28-sep-2026: el CAFÉ del semáforo (vuelo de SERVICIO).
    'tipo_parada'
  ];
begin
  -- Sin la cola (migración 20260912000002 sin aplicar) no hay trigger que
  -- reemplazar: el API sigue con hooks directos y este bloque no aplica.
  if to_regclass('public.calendar_sync_cola') is null then
    raise notice 'calendar_sync: cola ausente, trigger de escala sin cambios';
    return;
  end if;

  select string_agg(quote_ident(candidata.nombre), ', ' order by candidata.pos)
    into v_cols
    from unnest(v_lista) with ordinality as candidata(nombre, pos)
   where exists (
     select 1 from information_schema.columns ic
      where ic.table_schema = 'public'
        and ic.table_name = 'escala'
        and ic.column_name = candidata.nombre
   );

  if v_cols is null then
    raise warning 'calendar_sync: escala sin columnas conocidas, trigger omitido';
    return;
  end if;

  execute 'drop trigger if exists trg_escala_calendar_sync on public.escala';
  execute format(
    'create trigger trg_escala_calendar_sync after insert or update of %s or delete on public.escala for each row execute function public.calendar_sync_encolar()',
    v_cols
  );
end $$;
