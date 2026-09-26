-- 26-sep-2026 · EDITORES DE COTIZACIONES COBRADAS (API 0.0.37).
--
-- Pedido de Alejandro y Pablo Canales por WhatsApp (cotizaciones #305 y
-- #317, chip «Bloqueada · vuelo cobrado»): «ya pude editar el cobro, pero lo
-- que no se ha podido editar es en sí la cotización … me aparece ese
-- letrerito que dice que está bloqueado» / «un vuelo que se cobró en
-- efectivo pero estaba cotizado como para transferencia, entonces tenía IVA:
-- decía 754 dólares, pero entró el cobro en efectivo por 600 dólares … Yo
-- necesito que eso se desbloquee para mí, no para todos. Entiendo que para
-- todos está bien que no le metan mano. Pero yo o Pablo sí necesitamos
-- poder entrar y hacer modificaciones.»
--
-- QUÉ HACE (solo DATOS: sin DDL, sin funciones, sin triggers):
--   Siembra la fila 'editores_cotizacion_cobrada' de configuracion_sistema
--   (valor_json = arreglo de uuids de usuario, MISMO patrón que
--   'responsables_facturacion' de 20260924000003) con los DOS usuarios del
--   pedido, en orden por nombre:
--     c691cc8b-3034-4f04-a383-d0b25c1971ec  Alejandro Canales (ADMIN)
--     e5aa04a8-ac24-446a-b41d-9af5917cd4f1  Pablo Canales («Pab», ADMIN)
--   Es un permiso POR PERSONA, no por rol: en prod TODA la oficina es ADMIN
--   (Alejandro Villalobos ee3c5690-… también) y nadie más lo recibe.
--   Verificado en prod (SELECT, 26-sep-2026): los dos existen, ACTIVOS,
--   ADMIN, no pilotos externos; la fila no existe; `valor_json` ya existe
--   con su CHECK de arreglo (20260924000003, aplicada).
--
-- GUARDAS:
--   - Solo se siembra si LOS DOS existen, están ACTIVOS y son de oficina
--     (ADMIN/COORDINADOR/FACTURACION, no piloto externo) — la misma
--     definición que valida el API en el PUT. Si falta uno, la sección 2
--     ABORTA la migración (EDITORES_ABORTADO): una lista a medias o vacía
--     dejaría la lista sin nadie que pudiera cambiarla (el API solo deja
--     cambiarla a quien YA está en ella).
--   - IDEMPOTENTE: `on conflict (clave) do nothing`. Re-aplicarla no pisa la
--     lista que la oficina haya editado después desde Configuración.
--
-- QUÉ HACE EL API 0.0.37 CON ELLA (invariante 12 del CLAUDE.md del API):
--   `revise`/`quickAdjust` dejan pasar el candado COTIZACION_COBRADA a los
--   usuarios de esta lista (CFDI, mes cerrado, servicio y grupo siguen
--   bloqueando; los cobros NO se tocan; `cobrado` se recalcula; motivo con
--   «[Con cobros · permiso especial] »). `GET /v1/me` ⇒
--   `permisos.editar_cotizacion_cobrada`. `GET|PUT
--   /v1/config/editores-cotizacion-cobrada`.
--
-- EL API 0.0.37 ES DESPLEGABLE SIN ESTA MIGRACIÓN: sin la fila la lista es
-- vacía ⇒ nadie tiene el permiso ⇒ todo se comporta como el 0.0.36 (409
-- COTIZACION_COBRADA para todos, sin nombres) y el PUT responde 403
-- SOLO_EDITORES_COTIZACION_COBRADA. El 0.0.36 convive con la fila (no la
-- lee: su `GET /v1/config` la listaría como una bandera más, inofensiva).
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` que TERMINA con
-- `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte TODO aunque la
-- herramienta haga autocommit. Cualquier 'DRYRUN_FALLA …' = NO aplicar.
-- Tras el error DRYRUN_OK, comprobar `select count(*) from
-- configuracion_sistema where clave = 'editores_cotizacion_cobrada'` ⇒ 0 y
-- `select estado from usuario where id = 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1'`
-- ⇒ ACTIVO (nada quedó escrito).
-- PROBADO EN PGlite (26-sep-2026) con el esquema de prod de `usuario` y
-- `configuracion_sistema` (enums, FK, CHECK, trigger de updated_at) y sus 9
-- usuarios de oficina + 5 filas de configuración REALES: el guion de abajo
-- con la sección 1 pegada en B, C2, C3 y C6 ⇒ `DRYRUN_OK` y 0 filas tras el
-- error; aplicar ⇒ [Ale, Pablo]; re-aplicar ⇒ 1 fila; lista editada +
-- re-aplicar ⇒ se conserva la editada; Pablo INACTIVO ⇒ `EDITORES_ABORTADO`
-- y 0 filas; el dry-run sobre una base ya aplicada ⇒ `DRYRUN_FALLA A`. NO se
-- ha corrido en prod (solo SELECT).
--
--   do $dry$
--   declare
--     c_clave constant text := 'editores_cotizacion_cobrada';
--     c_ale   constant uuid := 'c691cc8b-3034-4f04-a383-d0b25c1971ec';
--     c_pablo constant uuid := 'e5aa04a8-ac24-446a-b41d-9af5917cd4f1';
--     c_villa constant uuid := 'ee3c5690-467c-481d-940f-f4c06010155f';
--     v_filas_antes int; v_resp_antes jsonb; v_n int; v_val jsonb;
--   begin
--     -- A) CONTEXTO
--     if exists (select 1 from public.configuracion_sistema where clave = c_clave) then
--       raise exception 'DRYRUN_FALLA A: la fila % ya existe (¿migración aplicada?)', c_clave;
--     end if;
--     if (select count(*) from public.usuario u
--          where u.id in (c_ale, c_pablo)
--            and u.estado::text = 'ACTIVO'
--            and u.rol::text in ('ADMIN', 'COORDINADOR', 'FACTURACION')
--            and not coalesce(u.es_piloto_externo, false)) <> 2 then
--       raise exception 'DRYRUN_FALLA A: Alejandro o Pablo Canales no son oficina ACTIVA';
--     end if;
--     if not exists (select 1 from public.usuario where id = c_villa and rol::text = 'ADMIN') then
--       raise notice 'avisoA · Alejandro Villalobos no está como ADMIN (el control C1 sigue valiendo)';
--     end if;
--     select count(*) into v_filas_antes from public.configuracion_sistema;
--     select valor_json into v_resp_antes from public.configuracion_sistema
--      where clave = 'responsables_facturacion';
--     raise notice 'okA · contexto (% filas de configuración)', v_filas_antes;
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN: pegar AQUÍ, TAL CUAL, la sección 1)
--     --    de abajo (es UNA sentencia SQL plana, válida dentro de plpgsql).
--     --    NO una copia a mano. La sección 2) es la guarda: su condición la
--     --    repite C1.
--
--     -- C1) SEMBRADA: exactamente los dos, en orden por nombre, y nadie más
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C1: el insert escribió % filas (esperado 1)', v_n;
--     end if;
--     select valor_json into v_val from public.configuracion_sistema where clave = c_clave;
--     if v_val is distinct from jsonb_build_array(c_ale::text, c_pablo::text) then
--       raise exception 'DRYRUN_FALLA C1: valor_json = % (esperado [Ale, Pablo])', v_val;
--     end if;
--     if v_val @> jsonb_build_array(c_villa::text) then
--       raise exception 'DRYRUN_FALLA C1: Alejandro Villalobos quedó en la lista';
--     end if;
--     if not exists (select 1 from public.configuracion_sistema
--                     where clave = c_clave and activa
--                       and length(trim(descripcion)) > 0
--                       and updated_by is null) then
--       raise exception 'DRYRUN_FALLA C1: activa/descripcion/updated_by inesperados';
--     end if;
--     -- (condición de la sección 2, la guarda)
--     if not exists (select 1 from public.configuracion_sistema
--                     where clave = c_clave
--                       and jsonb_typeof(valor_json) = 'array'
--                       and jsonb_array_length(valor_json) > 0) then
--       raise exception 'DRYRUN_FALLA C1: la guarda de la sección 2 abortaría';
--     end if;
--     raise notice 'okC1 · [Alejandro Canales, Pablo Canales], sin Villalobos';
--
--     -- C2) IDEMPOTENTE: la sección 1 otra vez no escribe nada
--     --     (pegar OTRA VEZ la sección 1 aquí)
--     get diagnostics v_n = row_count;
--     if v_n <> 0 then
--       raise exception 'DRYRUN_FALLA C2: la segunda pasada escribió % filas', v_n;
--     end if;
--     if (select count(*) from public.configuracion_sistema where clave = c_clave) <> 1 then
--       raise exception 'DRYRUN_FALLA C2: fila duplicada';
--     end if;
--     raise notice 'okC2 · segunda pasada: 0 filas';
--
--     -- C3) El PUT del API (UPDATE REAL con CAS sobre updated_at) y que una
--     --     re-aplicación NO pisa lo que la oficina editó
--     update public.configuracion_sistema
--        set valor_json = jsonb_build_array(c_pablo::text),
--            updated_at = now(), updated_by = c_ale
--      where clave = c_clave
--        and updated_at = (select updated_at from public.configuracion_sistema where clave = c_clave);
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C3: el UPDATE con CAS no aplicó (% filas)', v_n;
--     end if;
--     update public.configuracion_sistema
--        set valor_json = '[]'::jsonb
--      where clave = c_clave and updated_at = '1999-01-01T00:00:00Z'::timestamptz;
--     get diagnostics v_n = row_count;
--     if v_n <> 0 then
--       raise exception 'DRYRUN_FALLA C3: un CAS con sello viejo escribió';
--     end if;
--     --     (pegar OTRA VEZ la sección 1 aquí)
--     if (select valor_json from public.configuracion_sistema where clave = c_clave)
--          is distinct from jsonb_build_array(c_pablo::text) then
--       raise exception 'DRYRUN_FALLA C3: re-aplicar pisó la lista editada';
--     end if;
--     raise notice 'okC3 · UPDATE con CAS, CAS viejo 0 filas, re-aplicar no pisa';
--
--     -- C4) CHECK de arreglo (20260924000003) sigue mandando
--     begin
--       update public.configuracion_sistema set valor_json = '{}'::jsonb where clave = c_clave;
--       raise exception 'DRYRUN_FALLA C4: valor_json objeto';
--     exception when check_violation then null;
--     end;
--     raise notice 'okC4 · valor_json solo arreglo';
--
--     -- C5) NADA MÁS CAMBIÓ: +1 fila y responsables_facturacion intacta
--     if (select count(*) from public.configuracion_sistema) <> v_filas_antes + 1 then
--       raise exception 'DRYRUN_FALLA C5: filas de configuración % (esperado %)',
--         (select count(*) from public.configuracion_sistema), v_filas_antes + 1;
--     end if;
--     if (select valor_json from public.configuracion_sistema where clave = 'responsables_facturacion')
--          is distinct from v_resp_antes then
--       raise exception 'DRYRUN_FALLA C5: responsables_facturacion cambió';
--     end if;
--     raise notice 'okC5 · solo la fila nueva';
--
--     -- C6) GUARDA: con Pablo INACTIVO (UPDATE REAL de usuario) la sección 1
--     --     no siembra nada y la guarda de la sección 2 abortaría
--     delete from public.configuracion_sistema where clave = c_clave;
--     update public.usuario set estado = 'INACTIVO' where id = c_pablo;
--     --     (pegar OTRA VEZ la sección 1 aquí)
--     get diagnostics v_n = row_count;
--     if v_n <> 0 then
--       raise exception 'DRYRUN_FALLA C6: sembró con Pablo INACTIVO (% filas)', v_n;
--     end if;
--     if exists (select 1 from public.configuracion_sistema
--                 where clave = c_clave
--                   and jsonb_typeof(valor_json) = 'array'
--                   and jsonb_array_length(valor_json) > 0) then
--       raise exception 'DRYRUN_FALLA C6: la guarda de la sección 2 NO abortaría';
--     end if;
--     raise notice 'okC6 · con un editor inactivo no se siembra y la guarda aborta';
--
--     raise exception 'DRYRUN_OK · A contexto · C1 [Ale, Pablo] sin Villalobos · C2 idempotente · C3 PUT con CAS y re-aplicar no pisa · C4 check · C5 solo la fila nueva · C6 guarda · todo se revierte';
--   end $dry$;
--
-- TRAS APLICAR: `select clave, activa, valor_json from configuracion_sistema
-- where clave = 'editores_cotizacion_cobrada'` ⇒ los dos uuids (Alejandro y
-- Pablo Canales); `get_advisors` sin hallazgos nuevos (no hay DDL). Sondear
-- con la sesión de Alejandro: `GET /v1/me` ⇒ `permisos.editar_cotizacion_cobrada:
-- true` (el caché del API es de 60 s) y abrir la #305 en el panel ⇒ chip
-- «Cobrada · editable con permiso». Con otra sesión ADMIN ⇒ `false` y el
-- 409 dice «Solo pueden editarla: Alejandro Canales, Pablo Canales».
-- ORDEN DE DESPLIEGUE: tolerante en cualquier orden (API → migración →
-- panel recomendado).
-- ROLLBACK: `delete from public.configuracion_sistema where clave =
-- 'editores_cotizacion_cobrada';` (el API vuelve a bloquear a todos, como
-- el 0.0.36).

-- ---------------------------------------------------------------------------
-- 1) SIEMBRA: los dos editores, solo si LOS DOS son oficina ACTIVA.
-- ---------------------------------------------------------------------------
insert into public.configuracion_sistema (clave, activa, descripcion, valor_json)
select
  'editores_cotizacion_cobrada',
  true,
  'Usuarios que pueden editar una cotización que ya tiene cobros registrados (permiso especial por persona, no por rol). Los cobros no se modifican: el saldo se recalcula con lo cobrado. Solo alguien de la lista puede cambiarla y nunca queda vacía.',
  e.ids
from (
  select jsonb_agg(u.id order by u.nombre) as ids, count(*) as n
    from public.usuario u
   where u.id in ('c691cc8b-3034-4f04-a383-d0b25c1971ec',
                  'e5aa04a8-ac24-446a-b41d-9af5917cd4f1')
     and u.estado::text = 'ACTIVO'
     and u.rol::text in ('ADMIN', 'COORDINADOR', 'FACTURACION')
     and not coalesce(u.es_piloto_externo, false)
) e
where e.n = 2
on conflict (clave) do nothing;

-- ---------------------------------------------------------------------------
-- 2) GUARDA: sin la fila (o vacía) la migración ABORTA completa.
-- ---------------------------------------------------------------------------
do $guarda$
begin
  if not exists (select 1 from public.configuracion_sistema
                  where clave = 'editores_cotizacion_cobrada'
                    and jsonb_typeof(valor_json) = 'array'
                    and jsonb_array_length(valor_json) > 0) then
    raise exception 'EDITORES_ABORTADO: Alejandro Canales (c691cc8b-…) o Pablo Canales (e5aa04a8-…) no existe o no es oficina ACTIVA; no se sembró la lista editores_cotizacion_cobrada.';
  end if;
end $guarda$;
