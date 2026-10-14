-- 20261013000006 · ID de vuelo por cliente junto al folio (API 0.0.75, invariante 68 del API)
--
-- Decisión 6 del lote del 13-oct-2026: cada vuelo muestra, JUNTO a su folio,
-- un ID por cliente «diego01-131026» = alias del cliente + número de vuelo
-- de ESE cliente (2 dígitos mínimo) + DDMMAA de la fecha del vuelo en día
-- Cancún. El ID lo ARMA el API al leer (common/clave-cliente.util.ts); aquí
-- solo viven sus dos insumos:
--   · cliente.alias — editable, NO único, solo a-z (1 a 24). Vacío o null ⇒
--     el trigger pone la regla decidida: primera palabra del nombre sin
--     acentos (cliente_alias_default). Cambiar el nombre NO cambia el alias.
--   · vuelo.consecutivo_cliente — fijo al crear, desde el contador
--     cliente_consecutivo_vuelo (nunca se reutiliza un número; editarlo da
--     23514 CONSECUTIVO_CLIENTE_INMUTABLE; cambiar el cliente da el siguiente
--     del cliente nuevo). Histórico: por (fecha_vuelo asc nulls last, folio).
-- El folio sigue siendo la llave del dinero; ningún importe cambia.
--
-- Efectos del llenado: vuelo.updated_at NO se mueve (el trigger
-- vuelo_consecutivo_cliente corre DESPUÉS de trg_vuelo_set_updated_at —los
-- BEFORE van en orden alfabético de nombre— y conserva el sello mientras
-- numera un vuelo sin número: cero 409 CONFLICTO_VERSION falsos en la app).
-- cliente.updated_at SÍ se mueve en los clientes existentes (inocuo: nadie
-- hace CAS ni deltas sobre cliente). Google Calendar no se entera: ninguna
-- columna nueva está en trg_vuelo_calendar_sync ni en
-- trg_cliente_calendar_fanout. Sin constraint triggers diferidos en vuelo ni
-- en cliente (sin riesgo de 55006).
--
-- Redacción: este archivo no lleva ninguna palabra de las sentencias que el
-- MCP de Supabase declina (ni en comentarios). La reversa vive en el
-- CLAUDE.md del API («Migraciones y despliegue»), por el SQL Editor.
--
-- DRY-RUN — una sola sentencia por execute_sql: copiar desde «do $dry$» hasta
-- «$dry$;» quitando el prefijo «-- » de cada línea, y pegar §1, §2 y §3 de
-- este archivo TAL CUAL en las dos marcas (B y C12). Escrituras REALES; el
-- DDL va ANTES de las filas de prueba; los vuelos de prueba llevan folio
-- NEGATIVO explícito (nextval no se revierte). Debe terminar en DRYRUN_OK.
--
-- do $dry$
-- declare
--   v_cli bigint;
--   v_vue bigint;
--   v_con bigint;
--   v_cola bigint;
--   v_seq bigint;
--   v_huella text;
--   v_n bigint;
--   v_txt text;
--   v_r record;
--   v_cli_max uuid;
--   v_ult integer;
--   v_c1 uuid;
--   v_c2 uuid;
--   v_v1 uuid;
--   v_v2 uuid;
--   v_v3 uuid;
--   v_distintos bigint;
--   v_grupos bigint;
--   v_md5 text;
-- begin
--   -- A) CONTEXTO
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public'
--                 and ((table_name = 'cliente' and column_name = 'alias')
--                   or (table_name = 'vuelo' and column_name = 'consecutivo_cliente')))
--      or to_regclass('public.cliente_consecutivo_vuelo') is not null then
--     raise exception 'DRYRUN_FALLA A: la migración ya está aplicada';
--   end if;
--   select count(*) into v_cli from public.cliente;
--   select count(*), count(distinct cliente_id) into v_vue, v_con from public.vuelo;
--   if v_vue < 380 then
--     raise exception 'DRYRUN_FALLA A: solo % vuelos (¿proyecto equivocado?)', v_vue;
--   end if;
--   select md5(string_agg(id::text || '|' || updated_at::text, ',' order by id)) into v_huella from public.vuelo;
--   select count(*) into v_cola from public.calendar_sync_cola;
--   select last_value into v_seq from public.vuelo_folio_seq;
--
--   -- B) CUERPO: pegar aquí §1, §2 y §3 de este archivo TAL CUAL (§4 no: C1 la cubre).
--
--   -- C1) ESTRUCTURA
--   if (select format_type(atttypid, atttypmod) || ' ' || attnotnull::text from pg_attribute
--        where attrelid = 'public.cliente'::regclass and attname = 'alias') is distinct from 'text true' then
--     raise exception 'DRYRUN_FALLA C1: cliente.alias no es text NOT NULL';
--   end if;
--   if (select format_type(atttypid, atttypmod) || ' ' || attnotnull::text from pg_attribute
--        where attrelid = 'public.vuelo'::regclass and attname = 'consecutivo_cliente') is distinct from 'integer true' then
--     raise exception 'DRYRUN_FALLA C1: vuelo.consecutivo_cliente no es integer NOT NULL';
--   end if;
--   if position('^[a-z]{1,24}$' in pg_get_constraintdef((select oid from pg_constraint
--        where conname = 'cliente_alias_chk' and conrelid = 'public.cliente'::regclass))) = 0 then
--     raise exception 'DRYRUN_FALLA C1: CHECK cliente_alias_chk';
--   end if;
--   if position('>= 1' in pg_get_constraintdef((select oid from pg_constraint
--        where conname = 'vuelo_consecutivo_cliente_chk' and conrelid = 'public.vuelo'::regclass))) = 0 then
--     raise exception 'DRYRUN_FALLA C1: CHECK vuelo_consecutivo_cliente_chk';
--   end if;
--   if position('BEFORE INSERT OR UPDATE OF alias ON public.cliente' in pg_get_triggerdef((select oid from pg_trigger
--        where tgname = 'trg_cliente_alias_default' and tgrelid = 'public.cliente'::regclass))) = 0 then
--     raise exception 'DRYRUN_FALLA C1: trigger trg_cliente_alias_default';
--   end if;
--   if position('BEFORE INSERT OR UPDATE OF cliente_id, consecutivo_cliente ON public.vuelo' in pg_get_triggerdef((select oid from pg_trigger
--        where tgname = 'vuelo_consecutivo_cliente' and tgrelid = 'public.vuelo'::regclass))) = 0 then
--     raise exception 'DRYRUN_FALLA C1: trigger vuelo_consecutivo_cliente';
--   end if;
--   -- Los BEFORE de vuelo se disparan por orden de nombre: el sello de
--   -- trg_vuelo_set_updated_at tiene que correr ANTES del trigger nuevo.
--   select string_agg(tgname::text, ',' order by tgname) into v_txt from pg_trigger
--    where tgrelid = 'public.vuelo'::regclass and not tgisinternal and (tgtype & 2) = 2;
--   if v_txt is distinct from 'trg_vuelo_set_updated_at,vuelo_consecutivo_cliente,vuelo_fecha_fin' then
--     raise exception 'DRYRUN_FALLA C1: orden de los BEFORE de vuelo = %', v_txt;
--   end if;
--   if not coalesce((select indisunique from pg_index
--        where indexrelid = 'public.uq_vuelo_cliente_consecutivo'::regclass), false) then
--     raise exception 'DRYRUN_FALLA C1: uq_vuelo_cliente_consecutivo no es único';
--   end if;
--   if not coalesce((select relrowsecurity from pg_class
--        where oid = 'public.cliente_consecutivo_vuelo'::regclass), false) then
--     raise exception 'DRYRUN_FALLA C1: cliente_consecutivo_vuelo sin RLS';
--   end if;
--   if (select provolatile from pg_proc where oid = 'public.cliente_alias_default(text)'::regprocedure) <> 'i' then
--     raise exception 'DRYRUN_FALLA C1: cliente_alias_default no es immutable';
--   end if;
--   select count(*) into v_n from pg_proc p
--    where p.oid in ('public.cliente_alias_default(text)'::regprocedure,
--                    'public.tg_cliente_alias_default()'::regprocedure,
--                    'public.tg_vuelo_consecutivo_cliente()'::regprocedure)
--      and p.proconfig = array['search_path=""']
--      and p.prosecdef = (p.proname = 'tg_vuelo_consecutivo_cliente');
--   if v_n <> 3 then
--     raise exception 'DRYRUN_FALLA C1: search_path o SECURITY inesperados (% de 3)', v_n;
--   end if;
--
--   -- C2) REGLA DEL ALIAS: los 24 casos (MISMA tabla que el vitest del panel)
--   for v_r in
--     select * from (values
--       ('Diego Ramírez', 'diego'), ('Beh Kay ', 'beh'), ('January Davila', 'january'),
--       ('Eduardo Núñez', 'eduardo'), ('Núñez Pérez', 'nunez'), ('Ñoño', 'nono'),
--       ('J&B Charters', 'jb'), ('  JUAN   PABLO', 'juan'), ('3M Company', 'm'),
--       ('Cliente 2024', 'cliente'), ('Abc1 Ltd', 'abc'), ('2024', 'cliente'),
--       ('***', 'cliente'), ('', 'cliente'), ('José María', 'jose'),
--       ('Ángel Álvarez', 'angel'), ('Lic. Pedro', 'lic'), ('VIP SAESA', 'vip'),
--       ('Vuelos de reposicionamiento', 'vuelos'), ('Ærøskøbing Air', 'rskbing'),
--       ('Åsa Berg', 'asa'), ('Çelik', 'celik'),
--       ('Supercalifragilisticoespialidoso Inc', 'supercalifragilisticoesp')
--     ) as t(nombre, esperado)
--   loop
--     if public.cliente_alias_default(v_r.nombre) is distinct from v_r.esperado then
--       raise exception 'DRYRUN_FALLA C2: «%» ⇒ «%» (se esperaba «%»)',
--         v_r.nombre, public.cliente_alias_default(v_r.nombre), v_r.esperado;
--     end if;
--   end loop;
--   if public.cliente_alias_default(null) is distinct from 'cliente' then
--     raise exception 'DRYRUN_FALLA C2: null';
--   end if;
--
--   -- C3) LLENADO DE ALIAS
--   if exists (select 1 from public.cliente where alias is null) then
--     raise exception 'DRYRUN_FALLA C3: clientes sin alias';
--   end if;
--   if exists (select 1 from public.cliente where alias is distinct from public.cliente_alias_default(nombre)) then
--     raise exception 'DRYRUN_FALLA C3: alias distinto de la regla';
--   end if;
--   if (select string_agg(distinct alias, ',' order by alias) from public.cliente
--        where btrim(nombre) in ('Beh Kay', 'January Davila')) is distinct from 'beh,january' then
--     raise exception 'DRYRUN_FALLA C3: Beh Kay / January Davila';
--   end if;
--   select count(distinct alias) into v_distintos from public.cliente;
--   select count(*) into v_grupos from (select alias from public.cliente group by alias having count(*) > 1) g;
--
--   -- C4) ALIAS COMO LOS ESCRIBE EL API (clientes de prueba, notas 'DRYRUN-ID-CLIENTE')
--   insert into public.cliente (nombre, notas) values ('Diego Ramírez', 'DRYRUN-ID-CLIENTE')
--   returning id into v_c1;
--   if (select alias from public.cliente where id = v_c1) is distinct from 'diego' then
--     raise exception 'DRYRUN_FALLA C4: alta sin alias';
--   end if;
--   insert into public.cliente (nombre, alias, notas) values ('Diego Ramírez Dos', ' DIEGO ', 'DRYRUN-ID-CLIENTE')
--   returning id into v_c2;
--   if (select alias from public.cliente where id = v_c2) is distinct from 'diego' then
--     raise exception 'DRYRUN_FALLA C4: alta con alias (repetido permitido)';
--   end if;
--   foreach v_txt in array array['diego2', 'ñandu', 'abcdefghijklmnopqrstuvwxy'] loop
--     begin
--       update public.cliente set alias = v_txt where id = v_c1;
--       raise exception 'DRYRUN_FALLA C4: el CHECK aceptó «%»', v_txt;
--     exception when check_violation then
--       null;
--     end;
--   end loop;
--   update public.cliente set nombre = 'Pedro Pérez' where id = v_c1;
--   if (select alias from public.cliente where id = v_c1) is distinct from 'diego' then
--     raise exception 'DRYRUN_FALLA C4: cambiar el nombre tocó el alias';
--   end if;
--   update public.cliente set alias = null where id = v_c1;
--   if (select alias from public.cliente where id = v_c1) is distinct from 'pedro' then
--     raise exception 'DRYRUN_FALLA C4: alias null no volvió al sugerido';
--   end if;
--   update public.cliente set alias = '' where id = v_c2;
--   if (select alias from public.cliente where id = v_c2) is distinct from 'diego' then
--     raise exception 'DRYRUN_FALLA C4: alias vacío no volvió al sugerido';
--   end if;
--   if (select count(*) from public.calendar_sync_cola) <> v_cola then
--     raise exception 'DRYRUN_FALLA C4: la cola de Google cambió';
--   end if;
--
--   -- C5) LLENADO DE CONSECUTIVOS (antes de cualquier vuelo de prueba)
--   if exists (select 1 from public.vuelo where consecutivo_cliente is null) then
--     raise exception 'DRYRUN_FALLA C5: vuelos sin número';
--   end if;
--   if exists (select 1 from (select consecutivo_cliente,
--                                    row_number() over (partition by cliente_id
--                                      order by fecha_vuelo asc nulls last, folio asc) as rn
--                               from public.vuelo) s
--               where s.rn <> s.consecutivo_cliente) then
--     raise exception 'DRYRUN_FALLA C5: numeración distinta de (fecha_vuelo, folio)';
--   end if;
--   select string_agg(folio::text || '=' || consecutivo_cliente::text, ',' order by folio) into v_txt
--     from public.vuelo where folio in (364, 375, 376);
--   if v_txt is distinct from '364=5,375=1,376=2' then
--     raise exception 'DRYRUN_FALLA C5: esperados de prod = %', v_txt;
--   end if;
--   if (select md5(string_agg(id::text || '|' || updated_at::text, ',' order by id)) from public.vuelo)
--      is distinct from v_huella then
--     raise exception 'DRYRUN_FALLA C5: el llenado movió vuelo.updated_at';
--   end if;
--   if (select count(*) from public.calendar_sync_cola) <> v_cola then
--     raise exception 'DRYRUN_FALLA C5: el llenado encoló a Google';
--   end if;
--
--   -- C6) CONTADOR
--   if (select count(*) from public.cliente_consecutivo_vuelo) <> v_con then
--     raise exception 'DRYRUN_FALLA C6: contadores <> clientes con vuelos (%)', v_con;
--   end if;
--   if exists (select 1
--                from (select cliente_id, max(consecutivo_cliente) as m from public.vuelo group by cliente_id) x
--                join public.cliente_consecutivo_vuelo c using (cliente_id)
--               where c.ultimo <> x.m) then
--     raise exception 'DRYRUN_FALLA C6: contador distinto del máximo';
--   end if;
--
--   -- C7) ALTAS REALES COMO EL API (folio NEGATIVO explícito: nextval no se revierte)
--   select cliente_id into v_cli_max from public.vuelo group by cliente_id order by count(*) desc, cliente_id limit 1;
--   select ultimo into v_ult from public.cliente_consecutivo_vuelo where cliente_id = v_cli_max;
--   insert into public.vuelo (folio, cliente_id, es_externo, operador_externo, origen_iata, destino_iata,
--                             pasajeros, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd,
--                             subtotal_vuelo_usd, monto_total_usd, estado, fecha_vuelo, notas_internas)
--   values (-20261013, v_cli_max, true, 'DRYRUN-ID-CLIENTE', 'CUN', 'CZM', 1, 1, 'PUBLICO', 0, 0, 0,
--           'RESERVA', '2026-10-14T03:30:00Z', 'DRYRUN-ID-CLIENTE')
--   returning id into v_v1;
--   if (select consecutivo_cliente from public.vuelo where id = v_v1) <> v_ult + 1 then
--     raise exception 'DRYRUN_FALLA C7: alta 1';
--   end if;
--   insert into public.vuelo (folio, cliente_id, es_externo, operador_externo, origen_iata, destino_iata,
--                             pasajeros, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd,
--                             subtotal_vuelo_usd, monto_total_usd, estado, fecha_vuelo, notas_internas,
--                             consecutivo_cliente)
--   values (-20261014, v_cli_max, true, 'DRYRUN-ID-CLIENTE', 'CUN', 'CZM', 1, 1, 'PUBLICO', 0, 0, 0,
--           'RESERVA', '2026-10-14T03:30:00Z', 'DRYRUN-ID-CLIENTE', 999)
--   returning id into v_v2;
--   if (select consecutivo_cliente from public.vuelo where id = v_v2) <> v_ult + 2 then
--     raise exception 'DRYRUN_FALLA C7: alta 2 (el 999 del payload debía ignorarse)';
--   end if;
--   insert into public.vuelo (folio, cliente_id, es_externo, operador_externo, origen_iata, destino_iata,
--                             pasajeros, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd,
--                             subtotal_vuelo_usd, monto_total_usd, estado, fecha_vuelo, notas_internas)
--   values (-20261015, v_c1, true, 'DRYRUN-ID-CLIENTE', 'CUN', 'CZM', 1, 1, 'PUBLICO', 0, 0, 0,
--           'RESERVA', null, 'DRYRUN-ID-CLIENTE')
--   returning id into v_v3;
--   if (select consecutivo_cliente from public.vuelo where id = v_v3) <> 1
--      or (select ultimo from public.cliente_consecutivo_vuelo where cliente_id = v_c1) <> 1 then
--     raise exception 'DRYRUN_FALLA C7: primer vuelo de un cliente sin vuelos';
--   end if;
--   if (select last_value from public.vuelo_folio_seq) <> v_seq then
--     raise exception 'DRYRUN_FALLA C7: se gastó un folio de la secuencia';
--   end if;
--
--   -- C8) UPDATE COMO revise (cliente_id = cliente_id + otra columna): el número no se mueve
--   update public.vuelo set cliente_id = cliente_id, notas = 'DRYRUN' where id = v_v1;
--   if (select consecutivo_cliente from public.vuelo where id = v_v1) <> v_ult + 1
--      or (select ultimo from public.cliente_consecutivo_vuelo where cliente_id = v_cli_max) <> v_ult + 2 then
--     raise exception 'DRYRUN_FALLA C8: revise movió el número';
--   end if;
--
--   -- C9) CAMBIO DE CLIENTE ⇒ siguiente del cliente nuevo; el contador anterior NO baja (hueco)
--   update public.vuelo set cliente_id = v_c1 where id = v_v2;
--   if (select consecutivo_cliente from public.vuelo where id = v_v2) <> 2
--      or (select ultimo from public.cliente_consecutivo_vuelo where cliente_id = v_cli_max) <> v_ult + 2 then
--     raise exception 'DRYRUN_FALLA C9: cambio de cliente';
--   end if;
--
--   -- C10) EDITAR EL NÚMERO ⇒ 23514 CONSECUTIVO_CLIENTE_INMUTABLE
--   begin
--     update public.vuelo set consecutivo_cliente = 1 where id = v_v1;
--     raise exception 'DRYRUN_FALLA C10: se pudo editar el número';
--   exception when check_violation then
--     if sqlerrm not like 'CONSECUTIVO_CLIENTE_INMUTABLE%' then
--       raise exception 'DRYRUN_FALLA C10: otro 23514: %', sqlerrm;
--     end if;
--   end;
--
--   -- C11) UN ALTA RECHAZADA NO GASTA NÚMERO (su +1 se revierte con ella)
--   begin
--     insert into public.vuelo (folio, cliente_id, es_externo, operador_externo, origen_iata, destino_iata,
--                               pasajeros, tiempo_cobrable_hr, tarifa_tipo, tarifa_hora_usd,
--                               subtotal_vuelo_usd, monto_total_usd, estado, notas_internas)
--     values (-20261016, v_c1, true, 'DRYRUN-ID-CLIENTE', 'CUN', 'CZM', 0, 1, 'PUBLICO', 0, 0, 0,
--             'RESERVA', 'DRYRUN-ID-CLIENTE');
--     raise exception 'DRYRUN_FALLA C11: se aceptó un vuelo con 0 pasajeros';
--   exception when check_violation then
--     null;
--   end;
--   if (select ultimo from public.cliente_consecutivo_vuelo where cliente_id = v_c1) <> 2 then
--     raise exception 'DRYRUN_FALLA C11: el alta rechazada gastó un número';
--   end if;
--
--   -- C12) RE-APLICAR EL CUERPO = no-op
--   select md5(coalesce((select string_agg(id::text || ':' || alias, ',' order by id) from public.cliente), '')
--         || coalesce((select string_agg(folio::text || ':' || consecutivo_cliente::text, ',' order by folio) from public.vuelo), '')
--         || coalesce((select string_agg(cliente_id::text || ':' || ultimo::text, ',' order by cliente_id)
--                        from public.cliente_consecutivo_vuelo), ''))
--     into v_md5;
--   -- C12) pegar aquí OTRA VEZ §1, §2 y §3 de este archivo TAL CUAL.
--   if md5(coalesce((select string_agg(id::text || ':' || alias, ',' order by id) from public.cliente), '')
--         || coalesce((select string_agg(folio::text || ':' || consecutivo_cliente::text, ',' order by folio) from public.vuelo), '')
--         || coalesce((select string_agg(cliente_id::text || ':' || ultimo::text, ',' order by cliente_id)
--                        from public.cliente_consecutivo_vuelo), ''))
--      is distinct from v_md5 then
--     raise exception 'DRYRUN_FALLA C12: re-aplicar el cuerpo cambió datos';
--   end if;
--   if (select count(*) from pg_trigger
--        where (tgrelid = 'public.vuelo'::regclass and tgname = 'vuelo_consecutivo_cliente')
--           or (tgrelid = 'public.cliente'::regclass and tgname = 'trg_cliente_alias_default')) <> 2 then
--     raise exception 'DRYRUN_FALLA C12: triggers duplicados o faltantes';
--   end if;
--
--   raise exception 'DRYRUN_OK · clientes % · alias distintos % · grupos repetidos % · vuelos % · clientes con vuelos % · C1–C12',
--     v_cli, v_distintos, v_grupos, v_vue, v_con;
-- end
-- $dry$;
--
-- Después del dry-run (consultas aparte, deben dar «nada quedó»): las dos
-- columnas no existen en information_schema.columns;
-- to_regclass('public.cliente_consecutivo_vuelo') y
-- to_regprocedure('public.cliente_alias_default(text)') son NULL; 0 clientes
-- y 0 vuelos con la marca DRYRUN-ID-CLIENTE; last_value de
-- vuelo_folio_seq y count(*) de calendar_sync_cola iguales a los de antes.

-- §1 · cliente.alias ---------------------------------------------------------
alter table public.cliente
  add column if not exists alias text
    constraint cliente_alias_chk check (alias ~ '^[a-z]{1,24}$');

comment on column public.cliente.alias is
  'Alias para el ID de vuelo por cliente: alias + número de vuelo del cliente (2 dígitos mínimo) + DDMMAA de la fecha del vuelo en día Cancún, p. ej. diego01-131026 (lo arma el API al leer; no se guarda). Solo a-z, de 1 a 24 letras. Vacío o null: lo pone trg_cliente_alias_default con la primera palabra del nombre sin acentos. Editable en Clientes; NO es único (el panel avisa). Cambiarlo re-etiqueta todos sus vuelos; la llave del dinero sigue siendo el folio (13-oct-2026).';

create or replace function public.cliente_alias_default(p_nombre text)
returns text
language sql
immutable
parallel safe
set search_path = ''
as $fn$
  select coalesce(
    nullif(
      left(
        regexp_replace(
          lower(
            translate(
              split_part(btrim(regexp_replace(coalesce(p_nombre, ''), '\s+', ' ', 'g')), ' ', 1),
              'áàäâãåéèëêíìïîóòöôõúùüûñçÁÀÄÂÃÅÉÈËÊÍÌÏÎÓÒÖÔÕÚÙÜÛÑÇ',
              'aaaaaaeeeeiiiiooooouuuuncAAAAAAEEEEIIIIOOOOOUUUUNC'
            )
          ),
          '[^a-z]', '', 'g'
        ),
        24
      ),
      ''
    ),
    'cliente'
  )
$fn$;

comment on function public.cliente_alias_default(text) is
  'Alias sugerido (regla decidida el 13-oct-2026): primera palabra del nombre, sin acentos, en minúsculas, solo a-z, máximo 24; si no queda nada, cliente. Espejo EXACTO de aliasSugerido() del panel (src/lib/admin/clave-cliente.ts): si cambia uno, cambia el otro y sus 24 casos.';

create or replace function public.tg_cliente_alias_default()
returns trigger
language plpgsql
set search_path = ''
as $fn$
begin
  if new.alias is null or btrim(new.alias) = '' then
    new.alias := public.cliente_alias_default(new.nombre);
  else
    new.alias := lower(btrim(new.alias));
  end if;
  return new;
end
$fn$;

create or replace trigger trg_cliente_alias_default
  before insert or update of alias on public.cliente
  for each row execute function public.tg_cliente_alias_default();

update public.cliente
   set alias = public.cliente_alias_default(nombre)
 where alias is null;

alter table public.cliente alter column alias set not null;

-- §2 · contador por cliente ------------------------------------------------
create table if not exists public.cliente_consecutivo_vuelo (
  cliente_id uuid primary key references public.cliente (id),
  ultimo integer not null default 0 check (ultimo >= 0),
  updated_at timestamptz not null default now()
);

alter table public.cliente_consecutivo_vuelo enable row level security;

comment on table public.cliente_consecutivo_vuelo is
  'Contador del número de vuelo por cliente (ID de vuelo por cliente, 13-oct-2026). Solo lo escribe el trigger vuelo_consecutivo_cliente; el API nunca lo lee ni lo escribe. Invariante: ultimo >= max(vuelo.consecutivo_cliente) del cliente; nunca baja (un número usado no se reutiliza). RLS sin políticas (invariante 51).';

-- §3 · vuelo.consecutivo_cliente ---------------------------------------------
alter table public.vuelo
  add column if not exists consecutivo_cliente integer
    constraint vuelo_consecutivo_cliente_chk check (consecutivo_cliente >= 1);

comment on column public.vuelo.consecutivo_cliente is
  'Número de vuelo DEL CLIENTE (1, 2, 3…) para el ID visible alias + NN + -DDMMAA (lo arma el API). Lo asigna el trigger vuelo_consecutivo_cliente al crear, desde cliente_consecutivo_vuelo; nunca se reutiliza; inmutable (23514 CONSECUTIVO_CLIENTE_INMUTABLE); si cambia cliente_id toma el siguiente del cliente nuevo. Cotizaciones, reservas, cancelados y el clon de un cambio de avión también consumen número. Histórico (13-oct-2026) por fecha_vuelo y folio.';

create unique index if not exists uq_vuelo_cliente_consecutivo
  on public.vuelo (cliente_id, consecutivo_cliente);

-- SECURITY DEFINER (patrón de calendar_sync_encolar): escribe el contador,
-- que tiene RLS sin políticas, aunque algún día escriba en vuelo un rol que
-- no sea service_role. Solo toca cliente_consecutivo_vuelo y NEW.
create or replace function public.tg_vuelo_consecutivo_cliente()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn$
declare
  v_n integer;
begin
  -- Sin cliente: que falle el NOT NULL de vuelo.cliente_id como siempre.
  if new.cliente_id is null then
    return new;
  end if;
  -- Alta (o cambio de cliente): SIEMPRE el siguiente del contador, aunque
  -- el payload traiga un número (el clon de reassignAircraft, un 999…). El
  -- candado de fila del ON CONFLICT serializa dos altas del mismo cliente;
  -- un alta rechazada revierte su +1 con ella.
  if tg_op = 'INSERT' or new.cliente_id is distinct from old.cliente_id then
    insert into public.cliente_consecutivo_vuelo as c (cliente_id, ultimo)
    values (new.cliente_id, 1)
    on conflict (cliente_id) do update
      set ultimo = c.ultimo + 1,
          updated_at = now()
    returning c.ultimo into v_n;
    new.consecutivo_cliente := v_n;
    return new;
  end if;
  if new.consecutivo_cliente is not distinct from old.consecutivo_cliente then
    return new;
  end if;
  -- Solo durante el llenado de esta migración (después la columna es NOT
  -- NULL): numerar no es una edición de negocio y el sello updated_at (CAS
  -- de la app sin internet, deltas) se conserva. Funciona porque este
  -- trigger corre DESPUÉS de trg_vuelo_set_updated_at: los BEFORE van en
  -- orden alfabético de nombre. NO renombrarlo a «trg_…».
  if old.consecutivo_cliente is null then
    new.updated_at := old.updated_at;
    return new;
  end if;
  raise exception using
    errcode = '23514',
    message = format(
      'CONSECUTIVO_CLIENTE_INMUTABLE: el número del vuelo #%s dentro de su cliente se asigna al crear y no se edita',
      old.folio
    );
end
$fn$;

create or replace trigger vuelo_consecutivo_cliente
  before insert or update of cliente_id, consecutivo_cliente on public.vuelo
  for each row execute function public.tg_vuelo_consecutivo_cliente();

with n as (
  select v.id,
         row_number() over (
           partition by v.cliente_id
           order by v.fecha_vuelo asc nulls last, v.folio asc
         ) as rn
    from public.vuelo v
)
update public.vuelo v
   set consecutivo_cliente = n.rn
  from n
 where n.id = v.id
   and v.consecutivo_cliente is null;

insert into public.cliente_consecutivo_vuelo as c (cliente_id, ultimo)
select v.cliente_id, max(v.consecutivo_cliente)
  from public.vuelo v
 group by v.cliente_id
on conflict (cliente_id) do update
  set ultimo = excluded.ultimo,
      updated_at = now()
  where c.ultimo < excluded.ultimo;

alter table public.vuelo alter column consecutivo_cliente set not null;

-- §4 · verificación: aborta TODA la migración si algo no quedó ----------------
do $ver$
declare
  v_n bigint;
begin
  if not exists (select 1 from pg_catalog.pg_attribute
                  where attrelid = 'public.cliente'::regclass and attname = 'alias'
                    and not attisdropped and attnotnull
                    and atttypid = 'pg_catalog.text'::pg_catalog.regtype) then
    raise exception 'VERIFICACION_FALLA: cliente.alias no es text NOT NULL';
  end if;
  if not exists (select 1 from pg_catalog.pg_attribute
                  where attrelid = 'public.vuelo'::regclass and attname = 'consecutivo_cliente'
                    and not attisdropped and attnotnull
                    and atttypid = 'pg_catalog.int4'::pg_catalog.regtype) then
    raise exception 'VERIFICACION_FALLA: vuelo.consecutivo_cliente no es integer NOT NULL';
  end if;
  if not exists (select 1 from pg_catalog.pg_constraint
                  where conname = 'cliente_alias_chk' and conrelid = 'public.cliente'::regclass)
     or not exists (select 1 from pg_catalog.pg_constraint
                     where conname = 'vuelo_consecutivo_cliente_chk' and conrelid = 'public.vuelo'::regclass) then
    raise exception 'VERIFICACION_FALLA: faltan cliente_alias_chk o vuelo_consecutivo_cliente_chk';
  end if;
  if not exists (select 1 from pg_catalog.pg_index
                  where indexrelid = pg_catalog.to_regclass('public.uq_vuelo_cliente_consecutivo') and indisunique) then
    raise exception 'VERIFICACION_FALLA: falta el índice único uq_vuelo_cliente_consecutivo';
  end if;
  if not exists (select 1 from pg_catalog.pg_class
                  where oid = pg_catalog.to_regclass('public.cliente_consecutivo_vuelo') and relrowsecurity) then
    raise exception 'VERIFICACION_FALLA: falta cliente_consecutivo_vuelo con RLS';
  end if;
  if not exists (select 1 from pg_catalog.pg_trigger
                  where tgname = 'trg_cliente_alias_default' and tgrelid = 'public.cliente'::regclass)
     or not exists (select 1 from pg_catalog.pg_trigger
                     where tgname = 'vuelo_consecutivo_cliente' and tgrelid = 'public.vuelo'::regclass) then
    raise exception 'VERIFICACION_FALLA: faltan trg_cliente_alias_default o vuelo_consecutivo_cliente';
  end if;
  select count(*) into v_n from pg_catalog.pg_proc p
   where p.oid in (pg_catalog.to_regprocedure('public.cliente_alias_default(text)'),
                   pg_catalog.to_regprocedure('public.tg_cliente_alias_default()'),
                   pg_catalog.to_regprocedure('public.tg_vuelo_consecutivo_cliente()'))
     and p.proconfig = array['search_path=""']
     and p.prosecdef = (p.proname = 'tg_vuelo_consecutivo_cliente');
  if v_n <> 3 then
    raise exception 'VERIFICACION_FALLA: funciones con search_path o SECURITY inesperados (% de 3)', v_n;
  end if;
  select count(*) into v_n from public.cliente where alias !~ '^[a-z]{1,24}$';
  if v_n > 0 then
    raise exception 'VERIFICACION_FALLA: % clientes con alias inválido', v_n;
  end if;
  select count(*) into v_n
    from public.vuelo v
    left join public.cliente_consecutivo_vuelo c on c.cliente_id = v.cliente_id
   where c.cliente_id is null or v.consecutivo_cliente > c.ultimo;
  if v_n > 0 then
    raise exception 'VERIFICACION_FALLA: % vuelos sin contador o con número mayor que su contador', v_n;
  end if;
end
$ver$;
