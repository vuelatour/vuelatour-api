-- 24-sep-2026 · SEMÁFORO DE 6 COLORES: `cobrado` ENTRA AL TRIGGER DEL ESPEJO.
--
-- Pedido del cliente (24-sep-2026): «Ale quiere cambiar el color del descanso
-- y agregar el de cobrado (este me imagino se cambiaría en automático cuando
-- ya esté cobrado)». Lista del cliente: Tentativo gris · Pendiente (permiso)
-- amarillo · Confirmado verde · Pagado AZUL · Cancelado rojo · Descanso
-- MORADO. El API (`calendar/colores-calendario.util.ts`) pinta de azul el
-- vuelo cobrado completo (`vuelo.cobrado`, la bandera que mantiene
-- `FlightsService.refreshCobradoFlag`) — en el panel, en la app y en el
-- Google Calendar de la oficina (azul → colorId 7 Pavo real).
--
-- EL HUECO QUE CIERRA: con la cola activa (20260912000002) los hooks del API
-- ya NO escriben directo a Google; solo el TRIGGER encola. Y
-- `trg_vuelo_calendar_sync` es `AFTER … UPDATE OF <lista>` — `cobrado` NO
-- está en esa lista. Registrar el cobro que LIQUIDA el vuelo solo escribe
-- `vuelo.cobrado` (+ `updated_by`), así que NO se encolaba nada y el evento de
-- Google se quedaba VERDE hasta el reconcile nocturno (00:15 Cancún). Lo mismo
-- al revés: borrar o reembolsar el cobro regresaba el vuelo a verde en el
-- sistema y Google seguía azul. El panel y la app no tienen este problema
-- (leen `GET /v1/calendar` al momento).
--
-- QUÉ HACE: recrea `trg_vuelo_calendar_sync` con la MISMA lista vigente —la de
-- `20260917000001_usuario_apodo.sql`, verificada contra prod el 24-sep-2026
-- con `pg_get_triggerdef`— MÁS `cobrado`. Misma forma (lista filtrada contra
-- information_schema) y el MISMO cuerpo de función,
-- `public.calendar_sync_encolar()`, que NO se toca: compara `to_jsonb(OLD)` vs
-- `to_jsonb(NEW)` sin los ids de Google ni `updated_at`, así que un cambio
-- real de `cobrado` SÍ pasa el anti-loop (y no menciona columnas por nombre).
--
-- Volumen: `refreshCobradoFlag` solo escribe cuando la bandera CAMBIA (un
-- cobro parcial no toca `vuelo`), así que esto encola UNA vez por vuelo al
-- liquidarse y otra si deja de estarlo. En prod hoy: 185 de 300 vuelos
-- cobrados, 12 dentro de la ventana de Google.
--
-- NO crea tablas, NO escribe filas, NO toca funciones. Pero TOCA UN TRIGGER
-- ⇒ DRY-RUN OBLIGATORIO con UPDATEs REALES (regla del repo: un trigger roto
-- es invisible para un `select`). Guion, todo dentro de una transacción que
-- se revierte (el paso C termina con `raise exception 'DRYRUN_OK …'`, así que
-- aunque se olvide el `rollback` no queda nada escrito):
--
--   begin;
--   create temp table _dry_cobrado (vuelo_a uuid, vuelo_b uuid) on commit drop;
--
--   -- A) EL BUG, reproducido con la lista VIGENTE: cambiar `cobrado` de un
--   --    vuelo que NO tiene item en la cola NO encola nada.
--   do $a$
--   declare v1 uuid; v2 uuid;
--   begin
--     if to_regclass('public.calendar_sync_cola') is null then
--       raise exception 'DRYRUN_FALLA: calendar_sync_cola no existe';
--     end if;
--     -- Dos vuelos SIN item pendiente (si ya tuvieran uno, el upsert de la
--     -- cola lo refresca y no se notaría la diferencia).
--     select v.id into v1 from public.vuelo v
--      where not exists (select 1 from public.calendar_sync_cola c
--                         where c.entidad = 'vuelo' and c.entidad_id = v.id)
--      order by v.fecha_vuelo desc nulls last limit 1;
--     select v.id into v2 from public.vuelo v
--      where v.id <> v1
--        and not exists (select 1 from public.calendar_sync_cola c
--                         where c.entidad = 'vuelo' and c.entidad_id = v.id)
--      order by v.fecha_vuelo desc nulls last limit 1;
--     if v1 is null or v2 is null then
--       raise exception 'DRYRUN_FALLA: no hay dos vuelos fuera de la cola';
--     end if;
--     insert into _dry_cobrado values (v1, v2);
--     update public.vuelo set cobrado = not cobrado where id = v1;
--     if exists (select 1 from public.calendar_sync_cola c
--                 where c.entidad = 'vuelo' and c.entidad_id = v1) then
--       raise exception 'DRYRUN_FALLA A: cobrado YA encolaba (¿migración ya aplicada?)';
--     end if;
--     update public.vuelo set cobrado = not cobrado where id = v1; -- se regresa
--     raise notice 'okA · el bug existe: cambiar cobrado no encola';
--   end $a$;
--
--   -- B) CUERPO REAL DE LA MIGRACIÓN: pegar aquí, TAL CUAL, el bloque
--   --    `do $$ … $$;` de la sección 1) de abajo (no una copia a mano: un
--   --    error de plpgsql dentro de un `do` es INVISIBLE para un `select`).
--
--   -- C) Verificación con UPDATEs REALES.
--   do $c$
--   declare v1 uuid; v2 uuid; v_def text; v_cola_v2 int;
--   begin
--     select d.vuelo_a, d.vuelo_b into v1, v2 from _dry_cobrado d;
--     select pg_get_triggerdef(t.oid) into v_def
--       from pg_trigger t
--       join pg_class c on c.oid = t.tgrelid
--       join pg_namespace n on n.oid = c.relnamespace
--      where n.nspname = 'public' and c.relname = 'vuelo'
--        and t.tgname = 'trg_vuelo_calendar_sync';
--     if v_def is null or v_def not like '%cobrado%' then
--       raise exception 'DRYRUN_FALLA C1: el trigger no escucha cobrado: %', v_def;
--     end if;
--     -- La lista vieja COMPLETA sigue ahí (no se perdió ninguna columna).
--     if v_def not like '%fecha_vuelo, fecha_traslado_final, estado, estado_permiso, aeronave_id, piloto_id, es_externo, operador_externo, avion_externo_matricula, origen_iata, destino_iata, pasajeros, notas, monto_total_usd, cobrado, tipo, folio, cliente_id%' then
--       raise exception 'DRYRUN_FALLA C2: la lista cambió más de la cuenta: %', v_def;
--     end if;
--     -- C3) cambiar `cobrado` ⇒ la cola SUBE 1 (el item del vuelo v1).
--     update public.vuelo set cobrado = not cobrado where id = v1;
--     if not exists (select 1 from public.calendar_sync_cola c
--                     where c.entidad = 'vuelo' and c.entidad_id = v1
--                       and c.motivo = 'vuelo update') then
--       raise exception 'DRYRUN_FALLA C3: cambiar cobrado NO encoló el vuelo';
--     end if;
--     -- C4) una columna FUERA de la lista ⇒ la cola NO sube.
--     update public.vuelo
--        set notas_internas = coalesce(notas_internas, '') || ' [dry-run]'
--      where id = v2;
--     select count(*) into v_cola_v2 from public.calendar_sync_cola c
--      where c.entidad = 'vuelo' and c.entidad_id = v2;
--     if v_cola_v2 <> 0 then
--       raise exception 'DRYRUN_FALLA C4: notas_internas encoló (% items)', v_cola_v2;
--     end if;
--     -- C5) reescribir `cobrado` con el MISMO valor no inventa trabajo:
--     --     el anti-loop compara filas y no hay item nuevo para v2.
--     update public.vuelo set cobrado = cobrado where id = v2;
--     select count(*) into v_cola_v2 from public.calendar_sync_cola c
--      where c.entidad = 'vuelo' and c.entidad_id = v2;
--     if v_cola_v2 <> 0 then
--       raise exception 'DRYRUN_FALLA C5: cobrado sin cambio encoló (% items)', v_cola_v2;
--     end if;
--     raise exception 'DRYRUN_OK · C1 trigger con cobrado · C2 lista intacta · C3 cobrado encola · C4 notas_internas no encola · C5 sin cambio no encola · todo se revierte';
--   end $c$;
--   rollback;
--
-- Resultado esperado: `okA …` en los avisos y el error final
-- `DRYRUN_OK · …` (es el que revierte). Cualquier `DRYRUN_FALLA …` = NO
-- aplicar. Después del `rollback`, `pg_get_triggerdef` del trigger debe seguir
-- SIN `cobrado` (la lista de 17 columnas de hoy).
--
-- TRAS APLICAR: `get_advisors`; `pg_get_triggerdef` con `cobrado`; y —como
-- con cualquier cambio de COLOR— `POST /v1/calendar/resync` (ADMIN) para
-- RE-PINTAR lo ya publicado: los descansos pasan de 7 Pavo real a 3 Uva y los
-- vuelos ya cobrados de 2 Salvia a 7 Pavo real. La cola no se entera sola de
-- un color que cambió en el código (si no, lo hace el reconcile de las 00:15).
--
-- ORDEN DE DESPLIEGUE: indiferente. El API nuevo sin esta migración ya pinta
-- el azul en el panel, la app y en cada evento de Google que se reescriba por
-- cualquier otro motivo; solo falta el disparo AL COBRAR. Esta migración con
-- el API viejo encola de más (una vez por liquidación) y republica el evento
-- con el mismo color: inofensivo.
--
-- ROLLBACK (volver a la lista de 17): correr el bloque `do $$` de
-- `20260917000001_usuario_apodo.sql` (sección «TRIGGER DEL VUELO»).

-- ---------------------------------------------------------------------------
-- 1) TRIGGER DEL VUELO: la lista de `20260917000001` + `cobrado`.
-- ---------------------------------------------------------------------------
do $$
declare
  v_cols text;
  v_lista text[] := array[
    'fecha_vuelo', 'fecha_traslado_final', 'estado', 'estado_permiso',
    'aeronave_id', 'piloto_id', 'es_externo', 'operador_externo',
    'avion_externo_matricula',
    'origen_iata', 'destino_iata', 'pasajeros', 'notas',
    'monto_total_usd',
    -- 24-sep-2026: el AZUL «Pagado» del semáforo (vuelo cobrado completo).
    'cobrado',
    'tipo', 'folio', 'cliente_id'
  ];
begin
  -- Sin la cola (migración 20260912000002 sin aplicar) no hay trigger que
  -- reemplazar: el API sigue con hooks directos y este bloque no aplica.
  if to_regclass('public.calendar_sync_cola') is null then
    raise notice 'calendar_sync: cola ausente, trigger de vuelo sin cambios';
    return;
  end if;

  select string_agg(quote_ident(candidata.nombre), ', ' order by candidata.pos)
    into v_cols
    from unnest(v_lista) with ordinality as candidata(nombre, pos)
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
