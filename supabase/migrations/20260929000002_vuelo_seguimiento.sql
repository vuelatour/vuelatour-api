-- 29-sep-2026 · SEGUIMIENTO DE LA COTIZACIÓN por vuelo (notas con estado).
--
-- Pedido del cliente (captura del detalle del vuelo #358, columna derecha
-- debajo de «Pasajeros»): «me ayudan agregando un apartado aquí como para
-- poner unas notas que se deben agregar a la cotización. Ejemplo: Pablo ya
-- terminó el vuelito de hoy y los pax pidieron un transporte el cual no está
-- incluido en la cotización pero se necesita cobrar».
--
-- QUÉ CREA (aditivo, sin backfill, sin funciones nuevas):
--   public.vuelo_seguimiento — una fila por AJUSTE PENDIENTE de un vuelo, con
--   SEGUIMIENTO: PENDIENTE → RESUELTA (quién/cuándo/cómo) y reabrir.
--   `afecta_cotizacion` (default true) = «debe reflejarse en la cotización»:
--   esas son las que pinta el banner ámbar del cotizador y las que vigila el
--   PRE-CIERRE (aviso NO bloqueante `seguimiento_cotizacion_pendiente`).
--   Soft delete (deleted_at/deleted_by): TODO lector filtra `deleted_at is
--   null` (patrón de vencimientos). vuelo ON DELETE CASCADE (la nota no
--   tiene vida propia sin su vuelo; el purge ya pide type-to-confirm).
--
-- LO QUE NO CAMBIA: `vuelo.notas` (texto del cliente/operación),
-- `vuelo.notas_internas` y `escala.notas` (piloto) siguen igual: ninguno
-- tiene estado. La nota NO toca la fila `vuelo` (ni updated_at —el CAS de la
-- app sin internet— ni la cola de Google Calendar). Estado en TEXTO + CHECK,
-- no enum (sin el incidente del ENUM del 15-sep); aquí no hay `moneda`.
--
-- EL API 0.0.43 ES DESPLEGABLE SIN ESTA MIGRACIÓN: tabla ausente (42P01 /
-- PGRST205) ⇒ la lista responde [], los contadores 0 (no hay notas) y el
-- pre-cierre omite el aviso; las ESCRITURAS responden 503
-- SEGUIMIENTO_NO_DISPONIBLE. Nada más cambia.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO (DDL incluido)
-- aunque la herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' = NO
-- aplicar. Tras el error DRYRUN_OK, comprobar `select
-- to_regclass('public.vuelo_seguimiento')` ⇒ NULL (nada quedó escrito).
--
--   do $dry$
--   declare
--     v_vuelo    uuid;  -- vuelo vivo cualquiera (notas reales)
--     v_borrable uuid;  -- vuelo SIN dinero ni ligas RESTRICT (cascada real)
--     v_admin    uuid;
--     v_n1 uuid; v_n2 uuid; v_n3 uuid;
--     v_upd timestamptz; v_vuelo_upd timestamptz; v_n int; v_txt text;
--     v_estado text; v_afecta boolean;
--   begin
--     -- A) CONTEXTO
--     select v.id into v_vuelo from public.vuelo v
--      where v.estado::text <> 'CANCELADO'
--      order by v.created_at desc limit 1;
--     select v.id into v_borrable from public.vuelo v
--      where v.id <> v_vuelo
--        and not exists (select 1 from public.cobro_vuelo c where c.vuelo_id = v.id)
--        and not exists (select 1 from public.factura f where f.vuelo_id = v.id)
--        and not exists (select 1 from public.factura_emitida_vuelo fe where fe.vuelo_id = v.id)
--        and not exists (select 1 from public.gasto g where g.vuelo_id = v.id)
--        and not exists (select 1 from public.ingreso i where i.vuelo_id = v.id)
--        and not exists (select 1 from public.vuelo_grupo vg where vg.vuelo_ancla_id = v.id)
--        and not exists (select 1 from public.vuelo v2 where v2.combinado_con_id = v.id)
--      order by v.created_at desc limit 1;
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' limit 1;
--     if v_vuelo is null or v_admin is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto (vuelo/admin)';
--     end if;
--     if to_regclass('public.vuelo_seguimiento') is not null then
--       raise exception 'DRYRUN_FALLA A: vuelo_seguimiento YA existe (¿migración aplicada?)';
--     end if;
--     select updated_at into v_vuelo_upd from public.vuelo where id = v_vuelo;
--     raise notice 'okA · contexto (vuelo %, borrable %, admin %)', v_vuelo, v_borrable, v_admin;
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN: pegar AQUÍ, TAL CUAL, la sección 1)
--     --    de abajo (sentencias SQL planas, válidas dentro de un bloque
--     --    plpgsql). NO una copia a mano.
--
--     -- C1) ESTRUCTURA: tabla, RLS, índice parcial, trigger, FK en cascada
--     if to_regclass('public.vuelo_seguimiento') is null then
--       raise exception 'DRYRUN_FALLA C1: falta la tabla';
--     end if;
--     if not (select relrowsecurity from pg_class where oid = 'public.vuelo_seguimiento'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: RLS apagado';
--     end if;
--     if to_regclass('public.idx_vuelo_seguimiento_vuelo') is null then
--       raise exception 'DRYRUN_FALLA C1: falta el índice por vuelo';
--     end if;
--     if not exists (select 1 from pg_trigger
--                     where tgrelid = 'public.vuelo_seguimiento'::regclass
--                       and tgname = 'trg_vuelo_seguimiento_updated_at') then
--       raise exception 'DRYRUN_FALLA C1: falta el trigger de updated_at';
--     end if;
--     if (select confdeltype::text from pg_constraint
--          where conname = 'vuelo_seguimiento_vuelo_id_fkey') is distinct from 'c' then
--       raise exception 'DRYRUN_FALLA C1: la FK a vuelo no es ON DELETE CASCADE';
--     end if;
--     raise notice 'okC1 · tabla, RLS, índice, trigger y FK en cascada';
--
--     -- C2) INSERT REAL mínimo (lo que manda el API) ⇒ defaults. La cola de
--     --     Google DEDUPLICA: se borra la fila del vuelo (se revierte con todo)
--     --     y se verifica que la nota NO la vuelva a crear ni toque el vuelo.
--     delete from public.calendar_sync_cola where entidad = 'vuelo' and entidad_id = v_vuelo;
--     insert into public.vuelo_seguimiento (vuelo_id, texto, created_by)
--     values (v_vuelo, 'Los pax pidieron transporte terrestre; no está en la cotización, hay que cobrarlo.', v_admin)
--     returning id, estado, afecta_cotizacion into v_n1, v_estado, v_afecta;
--     if v_estado <> 'PENDIENTE' or v_afecta is distinct from true then
--       raise exception 'DRYRUN_FALLA C2: defaults estado=% afecta=%', v_estado, v_afecta;
--     end if;
--     if exists (select 1 from public.vuelo_seguimiento
--                 where id = v_n1 and (resuelta_at is not null or resuelta_por is not null
--                   or resolucion is not null or deleted_at is not null)) then
--       raise exception 'DRYRUN_FALLA C2: una nota nueva nace con sello de resuelta/borrada';
--     end if;
--     if (select updated_at from public.vuelo where id = v_vuelo) is distinct from v_vuelo_upd then
--       raise exception 'DRYRUN_FALLA C2: la nota movió vuelo.updated_at (rompe el CAS de la app)';
--     end if;
--     if exists (select 1 from public.calendar_sync_cola
--                 where entidad = 'vuelo' and entidad_id = v_vuelo) then
--       raise exception 'DRYRUN_FALLA C2: la nota encoló Google Calendar';
--     end if;
--     insert into public.vuelo_seguimiento (vuelo_id, texto, afecta_cotizacion, created_by)
--     values (v_vuelo, 'Nota operativa que no toca el precio', false, v_admin)
--     returning id into v_n2;
--     raise notice 'okC2 · insert real, defaults PENDIENTE/true, vuelo y cola intactos';
--
--     -- C3) CHECKs / FK (cada uno debe reventar)
--     begin insert into public.vuelo_seguimiento (vuelo_id, texto) values (v_vuelo, '');
--       raise exception 'DRYRUN_FALLA C3: texto vacío'; exception when check_violation then null; end;
--     begin insert into public.vuelo_seguimiento (vuelo_id, texto) values (v_vuelo, '   ');
--       raise exception 'DRYRUN_FALLA C3: texto en blanco'; exception when check_violation then null; end;
--     begin insert into public.vuelo_seguimiento (vuelo_id, texto) values (v_vuelo, repeat('x', 1001));
--       raise exception 'DRYRUN_FALLA C3: texto de 1001'; exception when check_violation then null; end;
--     begin insert into public.vuelo_seguimiento (vuelo_id, texto) values (v_vuelo, null);
--       raise exception 'DRYRUN_FALLA C3: texto null'; exception when not_null_violation then null; end;
--     begin update public.vuelo_seguimiento set estado = 'OTRO' where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: estado OTRO'; exception when check_violation then null; end;
--     begin update public.vuelo_seguimiento set estado = 'RESUELTA' where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: RESUELTA sin resuelta_at'; exception when check_violation then null; end;
--     begin update public.vuelo_seguimiento set resuelta_at = now() where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: PENDIENTE con resuelta_at'; exception when check_violation then null; end;
--     begin update public.vuelo_seguimiento set resolucion = 'x' where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: PENDIENTE con resolución'; exception when check_violation then null; end;
--     begin update public.vuelo_seguimiento set resuelta_por = v_admin where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: PENDIENTE con resuelta_por'; exception when check_violation then null; end;
--     begin update public.vuelo_seguimiento
--              set estado = 'RESUELTA', resuelta_at = now(), resolucion = repeat('r', 501) where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: resolución de 501'; exception when check_violation then null; end;
--     begin update public.vuelo_seguimiento set deleted_by = v_admin where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: deleted_by sin deleted_at'; exception when check_violation then null; end;
--     begin insert into public.vuelo_seguimiento (vuelo_id, texto) values (gen_random_uuid(), 'x');
--       raise exception 'DRYRUN_FALLA C3: vuelo inexistente'; exception when foreign_key_violation then null; end;
--     begin update public.vuelo_seguimiento set created_by = gen_random_uuid() where id = v_n1;
--       raise exception 'DRYRUN_FALLA C3: usuario inexistente'; exception when foreign_key_violation then null; end;
--     raise notice 'okC3 · CHECKs/FK rechazan lo inválido';
--
--     -- C4) UPDATE REAL: updated_at, resolver con sello, reabrir limpiando
--     update public.vuelo_seguimiento set updated_at = '2000-01-01' where id = v_n1;
--     select updated_at into v_upd from public.vuelo_seguimiento where id = v_n1;
--     if v_upd < '2001-01-01' then
--       raise exception 'DRYRUN_FALLA C4: tg_set_updated_at no corre en vuelo_seguimiento';
--     end if;
--     update public.vuelo_seguimiento
--        set estado = 'RESUELTA', resuelta_at = now(), resuelta_por = v_admin,
--            resolucion = 'Se agregó como extra en la cotización (v3).'
--      where id = v_n1;
--     update public.vuelo_seguimiento set texto = 'Transporte terrestre (editado)' where id = v_n1;
--     update public.vuelo_seguimiento
--        set estado = 'PENDIENTE', resuelta_at = null, resuelta_por = null, resolucion = null
--      where id = v_n1;
--     update public.vuelo_seguimiento
--        set estado = 'RESUELTA', resuelta_at = now(), resuelta_por = null, resolucion = null
--      where id = v_n2;   -- resuelta sin quién (usuario borrado) y sin resolución
--     raise notice 'okC4 · updated_at, resolver, editar resuelta, reabrir';
--
--     -- C5) LECTURAS DEL API: contadores del detalle y aviso del pre-cierre
--     insert into public.vuelo_seguimiento (vuelo_id, texto, created_by)
--     values (v_vuelo, 'Tercera', v_admin) returning id into v_n3;
--     update public.vuelo_seguimiento set deleted_at = now(), deleted_by = v_admin where id = v_n3;
--     select count(*) into v_n from public.vuelo_seguimiento
--      where vuelo_id = v_vuelo and deleted_at is null and estado = 'PENDIENTE';
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C5: pendientes vivas = % (esperado 1: n1)', v_n;
--     end if;
--     select count(*) into v_n from public.vuelo_seguimiento s
--       join public.vuelo v on v.id = s.vuelo_id
--      where s.deleted_at is null and s.estado = 'PENDIENTE' and s.afecta_cotizacion
--        and v.id = v_vuelo;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C5: pendientes de cotización = % (esperado 1)', v_n;
--     end if;
--     select count(*) into v_n from public.vuelo_seguimiento where vuelo_id = v_vuelo;
--     if v_n <> 3 then
--       raise exception 'DRYRUN_FALLA C5: el soft delete no conserva la fila (% filas)', v_n;
--     end if;
--     raise notice 'okC5 · contadores sin borradas ni no-cotización; soft delete conserva';
--
--     -- C6) CASCADA REAL: borrar un vuelo sin dinero se lleva sus notas. Si
--     --     otra liga ajena lo impide, se SALTA con aviso (C1 ya probó 'c').
--     if v_borrable is not null then
--       insert into public.vuelo_seguimiento (vuelo_id, texto) values (v_borrable, 'cascada');
--       begin
--         delete from public.vuelo where id = v_borrable;
--         select count(*) into v_n from public.vuelo_seguimiento where vuelo_id = v_borrable;
--         if v_n <> 0 then
--           raise exception 'DRYRUN_FALLA C6: las notas no cayeron en cascada (%)', v_n;
--         end if;
--         raise notice 'okC6 · borrar el vuelo se lleva sus notas';
--       exception when others then
--         if sqlerrm like 'DRYRUN_FALLA%' then raise; end if;
--         raise notice 'skipC6 · el vuelo % no se pudo borrar por otra liga: %', v_borrable, sqlerrm;
--       end;
--     else
--       raise notice 'skipC6 · no hay vuelo borrable: solo se verificó la FK (C1)';
--     end if;
--
--     raise exception 'DRYRUN_OK · C1 estructura · C2 insert real sin tocar vuelo/cola · C3 checks/FK · C4 resolver/editar/reabrir/updated_at · C5 contadores y soft delete · C6 cascada · todo se revierte';
--   end $dry$;
--
-- TRAS APLICAR: `get_advisors` (esperado solo el INFO de «RLS sin policies»,
-- patrón del repo, y los de FK sin índice hacia usuario, como en las demás
-- tablas); `select to_regclass('public.vuelo_seguimiento')` no nulo; sondear
-- `GET /v1/flights/<id>/seguimiento` (200 con []) y un POST de prueba desde
-- el panel (201, no 503).
-- ORDEN DE DESPLIEGUE: tolerante en cualquier orden; RECOMENDADO migración →
-- API 0.0.43 → panel. Con el panel nuevo y el API viejo la card no carga
-- (404 de la ruta): la ventana debe ser de minutos.
-- ROLLBACK: drop table public.vuelo_seguimiento; (pierde las notas).

-- ---------------------------------------------------------------------------
-- 1) SEGUIMIENTO DE LA COTIZACIÓN
-- ---------------------------------------------------------------------------
create table if not exists public.vuelo_seguimiento (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null references public.vuelo(id) on delete cascade,
  texto text not null,
  afecta_cotizacion boolean not null default true,
  estado text not null default 'PENDIENTE',
  resuelta_at timestamptz,
  resuelta_por uuid references public.usuario(id) on delete set null,
  resolucion text,
  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_at timestamptz not null default now(),
  deleted_at timestamptz,
  deleted_by uuid references public.usuario(id) on delete set null,
  constraint vuelo_seguimiento_texto_chk check (
    char_length(btrim(texto)) between 1 and 1000),
  constraint vuelo_seguimiento_estado_chk check (
    estado in ('PENDIENTE', 'RESUELTA')),
  constraint vuelo_seguimiento_resolucion_chk check (
    resolucion is null or char_length(resolucion) <= 500),
  -- RESUELTA ⇔ trae su sello de fecha; una PENDIENTE no arrastra quién ni
  -- cómo (reabrir LIMPIA). `resuelta_por` puede quedar null si el usuario se
  -- borra (on delete set null).
  constraint vuelo_seguimiento_resuelta_chk check (
    (estado = 'RESUELTA') = (resuelta_at is not null)
    and (estado = 'RESUELTA' or (resuelta_por is null and resolucion is null))),
  constraint vuelo_seguimiento_baja_chk check (
    deleted_by is null or deleted_at is not null)
);

comment on table public.vuelo_seguimiento is
  'Seguimiento de la cotización por vuelo (29-sep-2026): ajustes que se deben cobrar o agregar a la cotización (transporte, extras, cambios) con estado PENDIENTE/RESUELTA. afecta_cotizacion = debe reflejarse en la cotización (banner del cotizador + aviso no bloqueante del pre-cierre). Soft delete: todo lector filtra deleted_at is null. No toca la fila vuelo.';
comment on column public.vuelo_seguimiento.afecta_cotizacion is
  'true (default) = el ajuste debe reflejarse en la cotización: lo vigilan el banner del cotizador y el pre-cierre. false = nota de seguimiento que no mueve el precio.';
comment on column public.vuelo_seguimiento.estado is
  'PENDIENTE | RESUELTA (texto + CHECK, no enum). RESUELTA sella resuelta_at/resuelta_por (+ resolucion opcional); reabrir los limpia.';

create index if not exists idx_vuelo_seguimiento_vuelo
  on public.vuelo_seguimiento (vuelo_id)
  where deleted_at is null;

alter table public.vuelo_seguimiento enable row level security;

drop trigger if exists trg_vuelo_seguimiento_updated_at on public.vuelo_seguimiento;
create trigger trg_vuelo_seguimiento_updated_at
  before update on public.vuelo_seguimiento
  for each row execute function public.tg_set_updated_at();
