-- 20261120000001_calendar_sync_notas — dry-run (CUERPO copiado de la migración; pruebas a mano).
-- Proyecto PROD: bjesduasnzbzywofukbf (confirmar el ref antes de correrlo).
-- DRY-RUN: corre la migración y pruebas con UPDATEs REALES y lo revierte
-- TODO. Debe terminar en ERROR con el texto «DRYRUN_OK: …». Cualquier otro
-- error ⇒ NO aplicar y avisar.
-- No lleva sentencias destructivas: se puede correr por MCP (el bloque `do`
-- solo) o en el SQL Editor (completo, con su `begin` / `rollback`).
--
-- Las filas de prueba se tocan DESPUÉS del cuerpo (regla del repo: un DDL
-- después de un UPDATE sobre una tabla con triggers diferidos revienta con
-- 55006 «pending trigger events»). Por eso el guion NO reproduce el hueco
-- antes de crear los triggers: eso quedó verificado con `pg_get_triggerdef`
-- (ver el encabezado de la migración).

begin;

do $dry$
declare
  v_e1 uuid; v_v1 uuid;   -- nota del tramo
  v_e2 uuid; v_v2 uuid;   -- nota de la parada de servicio
  v_v3 uuid;              -- notas internas del vuelo
  v_v4 uuid;              -- anti-loop (update que no cambia nada)
  v_n integer;
  v_def text;
begin
  -- >>> CUERPO
  if to_regprocedure('public.calendar_sync_encolar()') is null then
    raise exception 'DRYRUN_FALLA: no existe public.calendar_sync_encolar()';
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
  -- <<< CUERPO

  -- T1: los dos triggers quedaron con la definición esperada y los vigentes
  --     siguen ahí, intactos.
  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgname = 'trg_vuelo_calendar_sync_notas' and t.tgrelid = 'public.vuelo'::regclass;
  if v_def is null or v_def not like '%AFTER UPDATE OF notas_internas ON public.vuelo%calendar_sync_encolar()%' then
    raise exception 'DRYRUN T1: trigger de vuelo inesperado: %', coalesce(v_def, '(no existe)');
  end if;
  select pg_get_triggerdef(t.oid) into v_def from pg_trigger t
   where t.tgname = 'trg_escala_calendar_sync_notas' and t.tgrelid = 'public.escala'::regclass;
  if v_def is null or v_def not like '%AFTER UPDATE OF notas, servicio_notas ON public.escala%calendar_sync_encolar()%' then
    raise exception 'DRYRUN T1: trigger de escala inesperado: %', coalesce(v_def, '(no existe)');
  end if;
  select count(*) into v_n from pg_trigger t
   where not t.tgisinternal and t.tgname in ('trg_vuelo_calendar_sync', 'trg_escala_calendar_sync');
  if v_n <> 2 then
    raise exception 'DRYRUN T1: faltan los triggers vigentes (hay %)', v_n;
  end if;

  -- Cuatro vuelos RECIENTES, distintos, con tramos y SIN item en la cola (si
  -- ya tuvieran uno, el upsert lo refresca y no se notaría la diferencia).
  select e.id, e.vuelo_id into v_e1, v_v1
    from public.escala e join public.vuelo v on v.id = e.vuelo_id
   where v.fecha_vuelo >= now() - interval '10 days' and v.estado::text <> 'CANCELADO'
     and e.cancelada_at is null
     and not exists (select 1 from public.calendar_sync_cola c
                      where c.entidad = 'vuelo' and c.entidad_id = e.vuelo_id)
   order by v.fecha_vuelo desc, e.orden limit 1;
  select e.id, e.vuelo_id into v_e2, v_v2
    from public.escala e join public.vuelo v on v.id = e.vuelo_id
   where v.fecha_vuelo >= now() - interval '10 days' and v.estado::text <> 'CANCELADO'
     and e.cancelada_at is null and e.vuelo_id <> v_v1
     and not exists (select 1 from public.calendar_sync_cola c
                      where c.entidad = 'vuelo' and c.entidad_id = e.vuelo_id)
   order by v.fecha_vuelo desc, e.orden limit 1;
  select v.id into v_v3 from public.vuelo v
   where v.fecha_vuelo >= now() - interval '10 days' and v.estado::text <> 'CANCELADO'
     and v.id not in (v_v1, v_v2)
     and not exists (select 1 from public.calendar_sync_cola c
                      where c.entidad = 'vuelo' and c.entidad_id = v.id)
   order by v.fecha_vuelo desc limit 1;
  select v.id into v_v4 from public.vuelo v
   where v.fecha_vuelo >= now() - interval '10 days' and v.estado::text <> 'CANCELADO'
     and v.id not in (v_v1, v_v2, v_v3)
     and not exists (select 1 from public.calendar_sync_cola c
                      where c.entidad = 'vuelo' and c.entidad_id = v.id)
   order by v.fecha_vuelo desc limit 1;
  if v_e1 is null or v_e2 is null or v_v3 is null or v_v4 is null then
    raise exception 'DRYRUN_FALLA: no hay cuatro vuelos recientes fuera de la cola';
  end if;

  -- T2: corregir la NOTA DE UN TRAMO encola su vuelo.
  update public.escala set notas = coalesce(notas, '') || ' [dryrun]' where id = v_e1;
  select count(*) into v_n from public.calendar_sync_cola c
   where c.entidad = 'vuelo' and c.entidad_id = v_v1 and c.motivo = 'escala update';
  if v_n <> 1 then
    raise exception 'DRYRUN T2: la nota del tramo no encoló su vuelo (items: %)', v_n;
  end if;

  -- T3: corregir la NOTA DE SERVICIO de un tramo encola su vuelo.
  update public.escala set servicio_notas = coalesce(servicio_notas, '') || ' [dryrun]' where id = v_e2;
  select count(*) into v_n from public.calendar_sync_cola c
   where c.entidad = 'vuelo' and c.entidad_id = v_v2 and c.motivo = 'escala update';
  if v_n <> 1 then
    raise exception 'DRYRUN T3: la nota de servicio no encoló su vuelo (items: %)', v_n;
  end if;

  -- T4: corregir las NOTAS INTERNAS del vuelo lo encola.
  update public.vuelo set notas_internas = coalesce(notas_internas, '') || ' [dryrun]' where id = v_v3;
  select count(*) into v_n from public.calendar_sync_cola c
   where c.entidad = 'vuelo' and c.entidad_id = v_v3 and c.motivo = 'vuelo update';
  if v_n <> 1 then
    raise exception 'DRYRUN T4: las notas internas no encolaron el vuelo (items: %)', v_n;
  end if;

  -- T5: ANTI-LOOP intacto — un UPDATE que no cambia nada NO encola.
  update public.vuelo set notas_internas = notas_internas where id = v_v4;
  select count(*) into v_n from public.calendar_sync_cola c
   where c.entidad = 'vuelo' and c.entidad_id = v_v4;
  if v_n <> 0 then
    raise exception 'DRYRUN T5: un update sin cambios encoló el vuelo (items: %)', v_n;
  end if;

  -- T6: un UPDATE que toca columnas de LOS DOS triggers (nota + pasajeros)
  --     deja UN solo item del vuelo en la cola, no dos.
  update public.escala
     set notas = coalesce(notas, '') || ' [dryrun 2]', pasajeros = pasajeros
   where id = v_e1;
  select count(*) into v_n from public.calendar_sync_cola c
   where c.entidad = 'vuelo' and c.entidad_id = v_v1;
  if v_n <> 1 then
    raise exception 'DRYRUN T6: el vuelo quedó % veces en la cola', v_n;
  end if;

  raise exception 'DRYRUN_OK: los dos triggers de notas encolan (tramo, servicio, internas), el anti-loop sigue y no hay items repetidos';
end $dry$;

rollback;
