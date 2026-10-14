-- 13-oct-2026 · RECLASIFICACIÓN de los 4 gastos «Otros gastos VuelaTour»
-- (OTRO) de AGOSTO-2026 que son comisariato de PASAJEROS de un vuelo ⇒
-- «Comisariato» (COMISARIATO). MIGRACIÓN DE DATOS (sin DDL). API 0.0.75,
-- invariante 63 del CLAUDE.md del API.
--
-- PEDIDO DEL CLIENTE (Jimmy, 12-oct-2026): «agregar en la categoría de
-- gastos: Comisariato; entraría en [la columna OTROS de costos directos] en
-- el balance del avión». Las capturas de agosto que ya decían «comisariato»
-- se pasan a la categoría nueva para que el balance de agosto las cargue al
-- avión del vuelo (hoy, como OTRO con vuelo, son gasto de la EMPRESA y viven
-- en «otros gastos» del Balance general).
--
-- TABLA CONGELADA (ids verificados en prod el 13-oct-2026, solo SELECT):
--   gasto_id                              vuelo  avión   fecha       monto MXN  medio         nota
--   30ab4bca-dfbc-4701-98af-f70631f13072  #141   N58BT   2026-08-12     441.50  TARJETA_CORP  «Bebidas, bolsa hielera y hielo (comisariato)» (conciliado, 1 cargo)
--   83da7c99-038f-498a-933d-2e1ebd77706e  #164   XA-VGV  2026-08-18     176.50  TARJETA_CORP  «COMISARIATO DEL VUELO A TULUM HOLBOX» (desglose IA de OXXO)
--   fab45352-4386-44f6-960e-c0953d462f66  #175   N990GG  2026-08-21     120.00  EFECTIVO      «comisariato … Comedor Asur» («Comisariato por demora»)
--   962ecdf4-d2aa-4e0a-b206-fb746917e295  #178   N621TX  2026-08-22     553.00  TARJETA_CORP  «Bebidas, botanas y comisariato»
--   TOTAL 1,291.00 MXN.
--
-- EXCLUIDOS A PROPÓSITO:
--   - 671d350a-e8fb-4672-883e-25d22368d07f (7-ago, 935.50 MXN, Walmart:
--     «Artículos de limpieza, desechables, refrescos y agua (comisariato) …
--     refrescos oficina y artículos de limpieza», SIN vuelo ni avión,
--     conciliado, FACTURADA): es compra de OFICINA, no comisariato de un
--     vuelo. Como COMISARIATO sería un pendiente de avión eterno (bandeja,
--     alerta `gastos_sin_avion`, pre-cierre) que ningún avión puede absorber.
--     Se queda OTRO; si la oficina lo quiere partir, es a mano desde
--     Verificar ligando un vuelo.
--   - b54126d5-30c5-4cab-a1d7-a950b293b381 (COMIDA, 31-jul, «torta para
--     dividir entre 2 pilotos»): es TRIPULACIÓN, se queda COMIDA.
--
-- QUÉ ESCRIBE (por gasto): `categoria` ⇒ COMISARIATO; `notas` + una línea de
-- traza AL FINAL (la celda del balance lee solo la PRIMERA línea); sello de
-- verificación limpio (`verificado_por/at` = null, espejo del API al editar;
-- hoy ninguno lo tiene); `updated_by` = null ⇒ la bitácora
-- (`trg_gasto_bitacora`) registra un UPDATE con diff {categoria: OTRO →
-- COMISARIATO, notas} y `actor_id` null, que el panel pinta «Sistema». NO
-- toca monto/moneda/medio_pago/conciliado/vuelo_id/aeronave_id (el candado
-- GASTO_CONCILIADO del API solo mira dinero: reclasificar siempre fue libre;
-- el cargo ligado de 30ab4bca no se entera). Enums comparados `::text`
-- (categoria, moneda); el literal 'COMISARIATO' del SET se resuelve como enum
-- porque el valor YA existe (20261013000001, OTRA transacción ya confirmada).
--
-- GUARDAS (todas o nada): el valor COMISARIATO existe; los 4 ids siguen
-- siendo OTRO, con vuelo, MXN, con el monto EXACTO de la tabla, de agosto y
-- sin reparto manual. Si las 4 ya son COMISARIATO ⇒ RECLAS_YA_APLICADA (no
-- toca nada); si solo algunas ⇒ RECLAS_ABORTADA (no escribe nada).
--
-- La función vive en `pg_temp` (desaparece con la sesión) para que el
-- DRY-RUN corra el MISMO cuerpo varias veces dentro de UNA llamada (patrón
-- 20260925000002). Sin palabras destructivas: el MCP la acepta.
--
-- ORDEN DE DEPLOY (dependencia dura): DESPUÉS de 20261013000001 (aplicada en
-- otra transacción) Y con el API 0.0.75 YA desplegado — con el API 0.0.74 un
-- gasto COMISARIATO caería a OPERACIONES en la fila del balance y a EXCLUIDO
-- en el reparto mientras dure la ventana.
--
-- EFECTO REAL (avisar al cliente): el balance de AGOSTO de N58BT (+441.50),
-- XA-VGV (+176.50), N990GG (+120.00) y N621TX (+553.00) gana esos pesos en la
-- columna OTROS de la fila del vuelo ⇒ baja su remanente/ganancia y el
-- reparto de agosto (ya entregado) ⇒ la cuenta corriente de los socios puede
-- marcar unos dólares «adelantados»; la hoja «otros gastos» del Balance
-- general de agosto baja 1,291.00 MXN; el Libro Dinero de agosto deja de
-- listarlos en «otros gastos» (su total baja 1,291.00) y NO los acredita a
-- ningún avión: es la regla de todo gasto directo del vuelo (como COMIDA),
-- cuyo costo vive en el balance del avión, no en el Libro Dinero (revisión
-- del lote 2, 14-oct-2026: antes decía «los acredita al avión del vuelo», y
-- no es así). Regenerar los libros de agosto tras aplicar. Un peso, una vez,
-- en el mismo mes (fecha_gasto y vuelo de agosto; nada cambia de mes).
--
-- ROLLBACK (manual, si el cliente lo pide):
--   update public.gasto set categoria = 'OTRO', updated_by = null
--    where id = any (array['30ab4bca-dfbc-4701-98af-f70631f13072',
--      '83da7c99-038f-498a-933d-2e1ebd77706e','fab45352-4386-44f6-960e-c0953d462f66',
--      '962ecdf4-d2aa-4e0a-b206-fb746917e295']::uuid[]);
--   (la línea de traza puede quedarse o quitarse a mano; la bitácora conserva
--   las dos escrituras).
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR — DESPUÉS de aplicar 20261013000001,
-- en UNA llamada de `execute_sql`: la sección 1) de abajo TAL CUAL (el
-- `create or replace function`, SIN la sección 2) + este bloque. Termina en
-- `raise exception 'DRYRUN_OK …'` ⇒ todo se revierte. Cualquier
-- 'DRYRUN_FALLA …', 'RECLAS_ABORTADA …' u otro error ⇒ NO aplicar.
--
--   do $dry$
--   declare
--     v_ids constant uuid[] := array['30ab4bca-dfbc-4701-98af-f70631f13072','83da7c99-038f-498a-933d-2e1ebd77706e',
--       'fab45352-4386-44f6-960e-c0953d462f66','962ecdf4-d2aa-4e0a-b206-fb746917e295']::uuid[];
--     v_fuera constant uuid[] := array['671d350a-e8fb-4672-883e-25d22368d07f','b54126d5-30c5-4cab-a1d7-a950b293b381']::uuid[];
--     v_b0 bigint; v_res text;
--     v_huella0 text; v_huella1 text; v_fuera0 text; v_fuera1 text;
--   begin
--     -- A) CONTEXTO
--     if not exists (select 1 from pg_enum e join pg_type t on t.oid = e.enumtypid join pg_namespace n on n.oid = t.typnamespace
--                    where n.nspname = 'public' and t.typname = 'categoria_gasto' and e.enumlabel = 'COMISARIATO') then
--       raise exception 'DRYRUN_FALLA A: falta aplicar 20261013000001';
--     end if;
--     -- (TODOS los conteos ACOTADOS a los 4 ids: con el API 0.0.75 y el panel ya
--     --  desplegados la oficina puede capturar gastos COMISARIATO nuevos antes de
--     --  correr esto, y eso NO es «migración aplicada»; revisión del lote 2)
--     if (select count(*) from public.gasto g where g.id = any (v_ids) and g.categoria::text = 'COMISARIATO') <> 0 then
--       raise exception 'DRYRUN_FALLA A: alguno de los 4 ya es COMISARIATO (¿migración ya aplicada?)';
--     end if;
--     if (select count(*) from public.gasto g where g.id = any (v_ids) and g.categoria::text = 'OTRO' and g.vuelo_id is not null) <> 4 then
--       raise exception 'DRYRUN_FALLA A: los 4 gastos ya no son OTRO con vuelo';
--     end if;
--     select count(*) into v_b0 from public.gasto_bitacora where gasto_id = any (v_ids);
--     select md5(string_agg((to_jsonb(g) - 'categoria' - 'notas' - 'updated_at' - 'updated_by' - 'verificado_por' - 'verificado_at')::text, '|' order by g.id))
--       into v_huella0 from public.gasto g where g.id = any (v_ids);
--     select md5(string_agg(to_jsonb(g)::text, '|' order by g.id)) into v_fuera0 from public.gasto g where g.id = any (v_fuera);
--     raise notice 'okA · los 4 son OTRO con vuelo (ninguno COMISARIATO)';
--
--     -- B) PRIMERA corrida (cuerpo real)
--     v_res := pg_temp.reclasificar_comisariato_20261013();
--     if v_res not like 'RECLAS_OK%' then raise exception 'DRYRUN_FALLA B: %', v_res; end if;
--
--     -- C1) los 4: COMISARIATO, traza al final, sello limpio, actor null; dinero y ligas intactos (huella)
--     if (select count(*) from public.gasto g where g.id = any (v_ids) and g.categoria::text = 'COMISARIATO'
--           and g.notas like '%[13-oct-2026] reclasificado de OTRO → COMISARIATO (migración 20261013000002%'
--           and g.verificado_por is null and g.verificado_at is null and g.updated_by is null) <> 4 then
--       raise exception 'DRYRUN_FALLA C1: los 4 no quedaron como se esperaba';
--     end if;
--     select md5(string_agg((to_jsonb(g) - 'categoria' - 'notas' - 'updated_at' - 'updated_by' - 'verificado_por' - 'verificado_at')::text, '|' order by g.id))
--       into v_huella1 from public.gasto g where g.id = any (v_ids);
--     if v_huella1 is distinct from v_huella0 then raise exception 'DRYRUN_FALLA C1: cambió algo más que categoria/notas/sello (monto, moneda, medio, conciliado, vuelo…)'; end if;
--     if (select count(*) from public.gasto g where g.id = any (v_ids)) <> 4 then raise exception 'DRYRUN_FALLA C1: falta alguno de los 4 gastos'; end if;
--     if (select sum(g.monto) from public.gasto g where g.id = any (v_ids) and g.categoria::text = 'COMISARIATO') <> 1291.00 then
--       raise exception 'DRYRUN_FALLA C1: el total reclasificado no es 1,291.00 MXN';
--     end if;
--
--     -- C2) bitácora: +4 UPDATE con diff OTRO → COMISARIATO, actor null (Sistema) y el vuelo del gasto
--     if (select count(*) from public.gasto_bitacora where gasto_id = any (v_ids)) <> v_b0 + 4 then raise exception 'DRYRUN_FALLA C2: la bitácora no creció en 4'; end if;
--     if (select count(*) from public.gasto_bitacora b join public.gasto g on g.id = b.gasto_id
--          where b.gasto_id = any (v_ids) and b.accion = 'UPDATE' and b.actor_id is null
--            and b.diff -> 'categoria' ->> 'antes' = 'OTRO' and b.diff -> 'categoria' ->> 'despues' = 'COMISARIATO'
--            and b.vuelo_id = g.vuelo_id) <> 4 then
--       raise exception 'DRYRUN_FALLA C2: bitácora sin las 4 filas OTRO → COMISARIATO con actor Sistema';
--     end if;
--
--     -- C3) los excluidos (Walmart oficina y la torta de pilotos) byte a byte
--     select md5(string_agg(to_jsonb(g)::text, '|' order by g.id)) into v_fuera1 from public.gasto g where g.id = any (v_fuera);
--     if v_fuera1 is distinct from v_fuera0 then raise exception 'DRYRUN_FALLA C3: se tocaron 671d350a o b54126d5'; end if;
--
--     -- C4) SEGUNDA corrida = no-op (idempotente)
--     v_res := pg_temp.reclasificar_comisariato_20261013();
--     if v_res not like 'RECLAS_YA_APLICADA%' then raise exception 'DRYRUN_FALLA C4: %', v_res; end if;
--     if (select count(*) from public.gasto_bitacora where gasto_id = any (v_ids)) <> v_b0 + 4 then raise exception 'DRYRUN_FALLA C4: la bitácora creció en la segunda corrida'; end if;
--
--     -- C5) GUARDA: con uno de los 4 regresado a OTRO, la tercera corrida ABORTA sin escribir (subtransacción)
--     begin
--       update public.gasto set categoria = 'OTRO' where id = 'fab45352-4386-44f6-960e-c0953d462f66';
--       v_res := pg_temp.reclasificar_comisariato_20261013();
--       raise exception 'DRYRUN_FALLA C5: no abortó (%)', v_res;
--     exception when raise_exception then
--       if sqlerrm not like 'RECLAS_ABORTADA: 3 de 4 ya reclasificados%' then raise exception 'DRYRUN_FALLA C5: %', sqlerrm; end if;
--     end;
--     if (select count(*) from public.gasto g where g.id = any (v_ids) and g.categoria::text = 'COMISARIATO') <> 4 then
--       raise exception 'DRYRUN_FALLA C5: la subtransacción no se revirtió';
--     end if;
--     raise notice 'okC5 · la guarda aborta sin escribir';
--
--     raise exception 'DRYRUN_OK 20261013000002 · A–C5 (4 reclasificados = 1,291.00 MXN, bitácora +4 actor Sistema, dinero intacto, excluidos intactos, idempotente, guardas)';
--   end $dry$;
--
-- TRAS EL DRYRUN_OK hay que comprobar que no quedó nada (ACOTADO a los 4 ids:
-- un COMISARIATO capturado por la oficina con el API 0.0.75 no cuenta):
--   select count(*) from public.gasto
--    where id = any (array['30ab4bca-dfbc-4701-98af-f70631f13072','83da7c99-038f-498a-933d-2e1ebd77706e',
--      'fab45352-4386-44f6-960e-c0953d462f66','962ecdf4-d2aa-4e0a-b206-fb746917e295']::uuid[])
--      and categoria::text = 'COMISARIATO';                                       ⇒ 0
-- APLICAR (apply_migration, name '20261013000002_comisariato_reclasificacion')
-- y VERIFICAR con la MISMA consulta (y `sum(monto)`): los 4 ids COMISARIATO
-- (= 1,291.00 MXN), 4 filas nuevas de bitácora con actor null, get_advisors
-- sin hallazgos nuevos. Después:
-- regenerar los balances de AGOSTO (N58BT, XA-VGV, N990GG, N621TX y el
-- general) y avisar al cliente del efecto en el reparto y la cuenta corriente
-- de agosto.
-- ---------------------------------------------------------------------------

-- 1) CUERPO (función temporal: el dry-run la llama varias veces) ------------
create or replace function pg_temp.reclasificar_comisariato_20261013()
returns text
language plpgsql
as $fn$
declare
  v_ids constant uuid[] := array[
    '30ab4bca-dfbc-4701-98af-f70631f13072',
    '83da7c99-038f-498a-933d-2e1ebd77706e',
    'fab45352-4386-44f6-960e-c0953d462f66',
    '962ecdf4-d2aa-4e0a-b206-fb746917e295'
  ]::uuid[];
  v_montos constant numeric[] := array[441.50, 176.50, 120.00, 553.00];
  v_ya int;
  v_ok int;
  v_n int;
begin
  if not exists (
    select 1
      from pg_enum e
      join pg_type t on t.oid = e.enumtypid
      join pg_namespace n on n.oid = t.typnamespace
     where n.nspname = 'public'
       and t.typname = 'categoria_gasto'
       and e.enumlabel = 'COMISARIATO'
  ) then
    raise exception 'RECLAS_ABORTADA: falta aplicar 20261013000001';
  end if;

  select count(*) into v_ya
    from public.gasto g
   where g.id = any (v_ids)
     and g.categoria::text = 'COMISARIATO';
  if v_ya = 4 then
    return 'RECLAS_YA_APLICADA (4 de 4)';
  end if;
  if v_ya > 0 then
    raise exception 'RECLAS_ABORTADA: % de 4 ya reclasificados — revisar a mano', v_ya;
  end if;

  select count(*) into v_ok
    from public.gasto g
    join unnest(v_ids, v_montos) as e(id, monto) on e.id = g.id
   where g.categoria::text = 'OTRO'
     and g.vuelo_id is not null
     and g.moneda::text = 'MXN'
     and g.monto = e.monto
     and g.fecha_gasto between date '2026-08-01' and date '2026-08-31'
     and not exists (
       select 1 from public.gasto_reparto r where r.gasto_id = g.id
     );
  if v_ok <> 4 then
    raise exception 'RECLAS_ABORTADA: % de 4 cumplen las guardas (id, OTRO, con vuelo, MXN, monto exacto, agosto, sin reparto)', v_ok;
  end if;

  update public.gasto g
     set categoria = 'COMISARIATO',
         notas = concat_ws(
           E'\n',
           g.notas,
           '[13-oct-2026] reclasificado de OTRO → COMISARIATO (migración 20261013000002: comisariato de pasajeros = gasto directo del vuelo, columna OTROS del balance del avión)'
         ),
         verificado_por = null,
         verificado_at = null,
         updated_by = null
   where g.id = any (v_ids);
  get diagnostics v_n = row_count;
  if v_n <> 4 then
    raise exception 'RECLAS_ABORTADA: el UPDATE tocó % filas', v_n;
  end if;

  return 'RECLAS_OK: 4 gastos, 1291.00 MXN (#141, #164, #175, #178)';
end
$fn$;

-- 2) EJECUCIÓN ---------------------------------------------------------------
select pg_temp.reclasificar_comisariato_20261013();
