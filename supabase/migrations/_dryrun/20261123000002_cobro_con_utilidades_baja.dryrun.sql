-- DRY-RUN de 20261123000002_cobro_con_utilidades_baja.sql (no deja nada escrito).
-- Termina SIEMPRE con una excepción: «DRYRUN_OK …» = pasó; cualquier otra = falló.
-- Lleva DELETE y REVOKE: SOLO por el SQL Editor (el MCP lo declina).
-- Requiere la 20261123000001 ya aplicada.
do $dry$
declare
  v_cuerpo text := $cuerpo$
-- 23-nov-2026 · QUITAR UN COBRO CON UTILIDADES DA DE BAJA SU ENTREGA, EN LA
-- MISMA SENTENCIA.
--
-- Hermana de `20261123000001_cobro_con_utilidades.sql` (ahí está el modelo).
-- Un cobro con utilidades del socio es un `cobro_vuelo` ligado 1 a 1 a una
-- entrega (`reparto_pago`) por `cobro_vuelo.reparto_pago_id`. Al quitarse el
-- cobro —desde el vuelo o por cualquier otro camino— la entrega tiene que
-- darse de baja: si no, al socio se le seguiría descontando un vuelo que ya
-- no está cobrado.
--
-- El API 0.0.148 ya lo hace (borra el cobro y da de baja la entrega), pero son
-- dos escrituras: si la segunda falla, la entrega queda viva y el API responde
-- con el error que dice qué entrega dar de baja a mano. Este trigger cierra
-- esa ventana: la baja ocurre DENTRO del mismo DELETE del cobro.
--
-- `tg_reparto_pago_de_vuelo` (000001) no lo estorba: mira si EXISTE un cobro
-- que cite la entrega y, en un AFTER DELETE, esa fila ya no existe.
--
-- VA APARTE de la 000001 porque su dry-run necesita un DELETE real, y el MCP
-- de Supabase de este cliente declina toda sentencia con borrados: se prueba y
-- se aplica por el SQL Editor (`docs/sql-aplicar-23-nov-2026-cobro-con-utilidades/`).
--
-- Dry-run: `_dryrun/20261123000002_cobro_con_utilidades_baja.dryrun.sql`.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cobro_vuelo'
       and column_name = 'reparto_pago_id'
  ) then
    raise exception 'Falta la migración 20261123000001 (cobro_vuelo.reparto_pago_id): aplícala primero';
  end if;
end $$;

create or replace function public.tg_cobro_vuelo_utilidades_baja()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if old.reparto_pago_id is null then
    return old;
  end if;
  update public.reparto_pago p
     set deleted_at = now(),
         deleted_by = old.updated_by,
         updated_by = old.updated_by,
         motivo_baja = 'Se quitó el cobro con utilidades del vuelo'
   where p.id = old.reparto_pago_id
     and p.deleted_at is null;
  return old;
end $fn$;

create or replace trigger trg_cobro_vuelo_utilidades_baja
  after delete on public.cobro_vuelo
  for each row execute function public.tg_cobro_vuelo_utilidades_baja();

-- PERMISOS: las funciones de este lote (las de la 000001 y la de aquí) solo
-- las ejecuta el API con la service key. Va en esta migración porque REVOKE
-- también lo declina el MCP (patrón de 20261014000003).
revoke execute on function public.tg_cobro_vuelo_utilidades() from public, anon, authenticated;
grant execute on function public.tg_cobro_vuelo_utilidades() to service_role;
revoke execute on function public.tg_reparto_pago_de_vuelo() from public, anon, authenticated;
grant execute on function public.tg_reparto_pago_de_vuelo() to service_role;
revoke execute on function public.tg_cobro_vuelo_utilidades_baja() from public, anon, authenticated;
grant execute on function public.tg_cobro_vuelo_utilidades_baja() to service_role;
revoke execute on function public.cobro_utilidades_registrar(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.cobro_utilidades_registrar(jsonb, jsonb) to service_role;
$cuerpo$;
  v_vuelo uuid; v_socio uuid; v_avion uuid; v_actor uuid; v_quien uuid;
  v_llave uuid := gen_random_uuid();
  v_r jsonb; v_entrega uuid; v_entrega2 uuid; v_cobro uuid; v_cobro2 uuid;
  v_n integer; v_cobros_antes integer; v_vivas_antes integer;
  v_err text; v_baja timestamptz; v_motivo text;
begin
  execute v_cuerpo;

  -- Filas de prueba DESPUÉS del DDL (regla del workspace). Datos reales de
  -- lectura: el vuelo #498 y el socio Macedo en N621TX.
  select id into v_vuelo from public.vuelo where folio = 498;
  select s.socio_id, s.aeronave_id into v_socio, v_avion
    from public.aeronave_socio s
    join public.usuario u on u.id = s.socio_id
    join public.aeronave a on a.id = s.aeronave_id
   where u.nombre = 'Macedo' and a.matricula = 'N621TX'
   limit 1;
  select id into v_actor from public.usuario where rol::text = 'DIRECCION' order by created_at limit 1;
  if v_vuelo is null or v_socio is null or v_avion is null or v_actor is null then
    raise exception 'DRYRUN sin datos base: vuelo %, socio %, avion %, actor %', v_vuelo, v_socio, v_avion, v_actor;
  end if;

  select count(*) into v_cobros_antes from public.cobro_vuelo where vuelo_id = v_vuelo;
  select count(*) into v_vivas_antes from public.reparto_pago where deleted_at is null;

  v_r := public.cobro_utilidades_registrar(
    jsonb_build_object(
      'socio_id', v_socio, 'aeronave_id', v_avion, 'periodo', '2026-10-01',
      'monto', 44174.30, 'moneda', 'MXN', 'tc_usd_mxn', 18.6673,
      'monto_usd', 2366.40, 'monto_mxn', 44174.30, 'saldo_snapshot_mxn', 81181.23,
      'fecha_pago', '2026-10-28', 'metodo', 'OTRO', 'referencia', 'Vuelo #498',
      'notas', 'DRYRUN', 'entregado_por', v_actor,
      'client_request_id', v_llave, 'created_by', v_actor),
    jsonb_build_object(
      'vuelo_id', v_vuelo, 'monto', 44174.30, 'moneda', 'MXN',
      'metodo_cobro', 'OTRO', 'tc_usd_mxn', 18.6673,
      'fecha_cobro', '2026-10-28T12:00:00-05:00', 'notas', 'DRYRUN',
      'registrado_por', v_actor, 'client_request_id', v_llave,
      'created_by', v_actor, 'updated_by', v_actor));
  v_entrega := (v_r->>'entrega_id')::uuid;
  v_cobro := (v_r->>'cobro_id')::uuid;

  -- T7: quitar el cobro da de baja su entrega en la MISMA sentencia.
  update public.cobro_vuelo set updated_by = v_actor where id = v_cobro;
  delete from public.cobro_vuelo where id = v_cobro;
  select deleted_at, motivo_baja, deleted_by into v_baja, v_motivo, v_quien
    from public.reparto_pago where id = v_entrega;
  if v_baja is null
     or v_motivo is distinct from 'Se quitó el cobro con utilidades del vuelo'
     or v_quien is distinct from v_actor then
    raise exception 'T7 FALLO: la entrega no quedó dada de baja (%, %, %)', v_baja, v_motivo, v_quien;
  end if;
  select count(*) into v_n from public.reparto_bitacora
   where registro_id = v_entrega and accion = 'UPDATE' and diff ? 'deleted_at';
  if v_n <> 1 then raise exception 'T7 FALLO: la bitácora no registró la baja de la entrega (%)', v_n; end if;

  -- T9: un cobro NORMAL (sin liga) entra, se corrige y se borra como siempre.
  insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn)
  values (v_vuelo, 1000, 'MXN', 'TRANSFERENCIA', 18.6673)
  returning id into v_cobro2;
  update public.cobro_vuelo set monto = 1200 where id = v_cobro2;
  delete from public.cobro_vuelo where id = v_cobro2;

  select count(*) into v_n from public.cobro_vuelo where vuelo_id = v_vuelo;
  if v_n <> v_cobros_antes then
    raise exception 'DRYRUN: el vuelo quedó con % cobros (tenía %)', v_n, v_cobros_antes;
  end if;
  select count(*) into v_n from public.reparto_pago where deleted_at is null;
  if v_n <> v_vivas_antes then
    raise exception 'DRYRUN: quedaron % entregas vivas (había %)', v_n, v_vivas_antes;
  end if;

  -- T10: solo el API (service_role) ejecuta las funciones del lote.
  if has_function_privilege('anon', 'public.cobro_utilidades_registrar(jsonb, jsonb)', 'execute')
     or has_function_privilege('authenticated', 'public.cobro_utilidades_registrar(jsonb, jsonb)', 'execute')
     or has_function_privilege('anon', 'public.tg_cobro_vuelo_utilidades()', 'execute')
     or has_function_privilege('anon', 'public.tg_reparto_pago_de_vuelo()', 'execute')
     or has_function_privilege('anon', 'public.tg_cobro_vuelo_utilidades_baja()', 'execute')
     or not has_function_privilege('service_role', 'public.cobro_utilidades_registrar(jsonb, jsonb)', 'execute') then
    raise exception 'T10 FALLO: permisos de las funciones';
  end if;

  raise exception 'DRYRUN_OK 20261123000002: la baja del cobro da de baja su entrega; todo se revierte';
end $dry$;
