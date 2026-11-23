-- DRY-RUN de 20261123000001_cobro_con_utilidades.sql (no deja nada escrito).
-- Termina SIEMPRE con una excepción: «DRYRUN_OK …» = pasó; cualquier otra = falló.
-- Sin borrados: corrió por el MCP de Supabase el 23-nov-2026 ⇒ DRYRUN_OK.
do $dry$
declare
  v_cuerpo text := $cuerpo$
-- 23-nov-2026 · EL SOCIO PAGA SU VUELO CON SUS UTILIDADES.
--
-- Pedido del dueño (Ale Canales, 23-nov-2026): los socios (dueños de los
-- aviones) usan sus aviones con una cotización a precio especial y «algunos
-- socios dicen que se pague esa cotización de ese vuelo descontándolo de las
-- utilidades del mes; necesitamos una forma para que se cobre de las
-- utilidades y les salga en su balance por avión y en el balance general».
-- Caso real: los $76,384.73 de «pendiente de pago» de N621TX en octubre son
-- dos vuelos de socios sin cobrar (#496 Carlos Moreno $32,210.43 y #498 Macedo
-- $44,174.30).
--
-- EL MODELO: no se crea una contabilidad nueva. Pagar un vuelo con utilidades
-- son DOS filas de las tablas de siempre, ligadas 1 a 1:
--   · un COBRO del vuelo (`cobro_vuelo`, método OTRO) — el vuelo queda cobrado
--     para todos los libros (fuente única `cobrosEnUsd`);
--   · una ENTREGA al socio (`reparto_pago`, método OTRO) — su cuenta corriente
--     y el «entregado / por entregar» del balance la restan como cualquier
--     entrega (fuente única `movimientosDeCuenta` / `entregasPorSocioDelAvion`).
-- Es exactamente «VuelaTour le entrega sus utilidades y el socio paga su vuelo
-- con ellas», sin que el dinero se mueva. La liga vive en UNA columna:
-- `cobro_vuelo.reparto_pago_id`. «Esta entrega es de un vuelo» = existe un
-- cobro que la cita (por eso `reparto_pago` no gana columnas: el avión de un
-- vuelo reasignado se clona y el cobro viaja al clon con su liga).
--
-- LO QUE GARANTIZA LA BD (el API repite cada candado con su 409 legible):
--   1) ALTA ATÓMICA: `cobro_utilidades_registrar(p_entrega, p_cobro)` inserta
--      las dos filas en UNA transacción (PostgREST no tiene transacciones de
--      varias sentencias). Nunca queda un vuelo cobrado sin su descuento al
--      socio, ni un socio descontado sin su vuelo cobrado.
--   2) `tg_cobro_vuelo_utilidades` (cobro): la liga solo nace en el INSERT y
--      es inmutable; la entrega citada debe existir, estar viva y valer lo
--      mismo (monto y moneda); con liga no cambian monto, moneda, T.C. ni
--      fecha (se quita el cobro y se registra de nuevo).
--   3) `tg_reparto_pago_de_vuelo` (entrega): mientras su cobro exista no
--      cambian su dinero, su socio ni su fecha, y no se da de baja desde
--      «Pagos a socios» (se quita el cobro en el vuelo).
--   4) BAJA: al quitarse el cobro, su entrega se da de baja. Eso lo hace el
--      trigger de la migración HERMANA `20261123000002` (AFTER DELETE, en la
--      misma sentencia) y, además, el API (borra el cobro y da de baja la
--      entrega, idempotente): funciona igual con o sin la 000002. Va aparte
--      porque su dry-run necesita borrados reales, que el MCP de Supabase de
--      este cliente declina (se aplica por el SQL Editor).
--
-- ADITIVA: una columna NULL-able, un índice parcial, un CHECK que solo mira
-- filas con liga (0 en prod), tres funciones y dos triggers nuevos. Ningún
-- trigger vigente se recrea. Sin la columna, el API 0.0.148 responde 503
-- `COBRO_UTILIDADES_NO_DISPONIBLE` SOLO a esta captura; todo lo demás, igual.
--
-- Dry-run con INSERT/UPDATE reales:
-- `_dryrun/20261123000001_cobro_con_utilidades.dryrun.sql`.

-- 1) LA LIGA ------------------------------------------------------------------
alter table public.cobro_vuelo
  add column if not exists reparto_pago_id uuid references public.reparto_pago(id);

comment on column public.cobro_vuelo.reparto_pago_id is
  'Cobro CON UTILIDADES DEL SOCIO (23-nov-2026): la entrega (reparto_pago) que descuenta este cobro de la cuenta del socio. 1 a 1, solo nace en el INSERT (cobro_utilidades_registrar) y es inmutable.';

create unique index if not exists uq_cobro_vuelo_reparto_pago
  on public.cobro_vuelo (reparto_pago_id) where reparto_pago_id is not null;

do $$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'public.cobro_vuelo'::regclass
       and conname = 'cobro_vuelo_utilidades_chk'
  ) then
    alter table public.cobro_vuelo add constraint cobro_vuelo_utilidades_chk
      check (
        reparto_pago_id is null
        or (monto > 0
            and cobro_grupo_id is null
            and ingreso_anticipo_id is null
            and comision_banco_monto is null)
      );
  end if;
end $$;

-- 2) CANDADO DEL COBRO --------------------------------------------------------
create or replace function public.tg_cobro_vuelo_utilidades()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare
  v_monto numeric;
  v_moneda text;
  v_baja timestamptz;
begin
  if tg_op = 'UPDATE' then
    if new.reparto_pago_id is distinct from old.reparto_pago_id then
      raise exception using
        errcode = '23514',
        hint = 'UTILIDADES_LIGA_INMUTABLE',
        message = 'UTILIDADES_LIGA_INMUTABLE: la liga del cobro con la entrega al socio no se cambia; quita el cobro y regístralo de nuevo';
    end if;
    if old.reparto_pago_id is null then
      return new;
    end if;
    if new.monto is distinct from old.monto
       or new.moneda::text is distinct from old.moneda::text
       or new.tc_usd_mxn is distinct from old.tc_usd_mxn
       or new.fecha_cobro is distinct from old.fecha_cobro then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_CON_UTILIDADES',
        message = 'COBRO_CON_UTILIDADES: este cobro se pagó con utilidades del socio: su monto, moneda, tipo de cambio y fecha no se corrigen; quita el cobro y regístralo de nuevo';
    end if;
    return new;
  end if;

  if new.reparto_pago_id is null then
    return new;
  end if;
  select p.monto, p.moneda, p.deleted_at
    into v_monto, v_moneda, v_baja
    from public.reparto_pago p
   where p.id = new.reparto_pago_id
     for update;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'UTILIDADES_ENTREGA_NO_EXISTE',
      message = format('UTILIDADES_ENTREGA_NO_EXISTE: la entrega %s no existe', new.reparto_pago_id);
  end if;
  if v_baja is not null then
    raise exception using
      errcode = '23514',
      hint = 'UTILIDADES_ENTREGA_DADA_DE_BAJA',
      message = 'UTILIDADES_ENTREGA_DADA_DE_BAJA: la entrega al socio está dada de baja';
  end if;
  if new.moneda::text <> v_moneda or new.monto <> v_monto then
    raise exception using
      errcode = '23514',
      hint = 'UTILIDADES_MONTO_DISTINTO',
      message = format('UTILIDADES_MONTO_DISTINTO: el cobro (%s %s) y la entrega al socio (%s %s) deben valer lo mismo',
                       round(new.monto, 2), new.moneda::text, round(v_monto, 2), v_moneda);
  end if;
  return new;
end $fn$;

create or replace trigger trg_cobro_vuelo_utilidades
  before insert or update of reparto_pago_id, monto, moneda, tc_usd_mxn, fecha_cobro
  on public.cobro_vuelo
  for each row execute function public.tg_cobro_vuelo_utilidades();

-- 3) CANDADO DE LA ENTREGA DE UN VUELO ---------------------------------------
create or replace function public.tg_reparto_pago_de_vuelo()
returns trigger language plpgsql security definer set search_path to '' as $fn$
declare
  v_folio integer;
begin
  select v.folio
    into v_folio
    from public.cobro_vuelo c
    join public.vuelo v on v.id = c.vuelo_id
   where c.reparto_pago_id = old.id
   limit 1;
  if not found then
    return new;
  end if;
  if new.monto is distinct from old.monto
     or new.moneda is distinct from old.moneda
     or new.monto_mxn is distinct from old.monto_mxn
     or new.monto_usd is distinct from old.monto_usd
     or new.tc_usd_mxn is distinct from old.tc_usd_mxn
     or new.socio_id is distinct from old.socio_id
     or new.fecha_pago is distinct from old.fecha_pago then
    raise exception using
      errcode = '23514',
      hint = 'ENTREGA_DE_VUELO',
      message = format('ENTREGA_DE_VUELO: esta entrega es el pago del vuelo #%s con utilidades: su dinero, su socio y su fecha no se corrigen aquí; quita el cobro en el vuelo y regístralo de nuevo', v_folio),
      detail = jsonb_build_object('folio', v_folio)::text;
  end if;
  if old.deleted_at is null and new.deleted_at is not null then
    raise exception using
      errcode = '23514',
      hint = 'ENTREGA_DE_VUELO',
      message = format('ENTREGA_DE_VUELO: esta entrega es el pago del vuelo #%s con utilidades: no se da de baja aquí; quita el cobro en el vuelo', v_folio),
      detail = jsonb_build_object('folio', v_folio)::text;
  end if;
  return new;
end $fn$;

create or replace trigger trg_reparto_pago_de_vuelo
  before update of monto, moneda, monto_mxn, monto_usd, tc_usd_mxn, socio_id, fecha_pago, deleted_at
  on public.reparto_pago
  for each row execute function public.tg_reparto_pago_de_vuelo();

-- 4) ALTA ATÓMICA -------------------------------------------------------------
-- El API arma las dos filas con sus fuentes únicas (`validarDineroPago` para
-- la entrega, `createCobro` para el cobro) y aquí solo se insertan juntas.
create or replace function public.cobro_utilidades_registrar(p_entrega jsonb, p_cobro jsonb)
returns jsonb language plpgsql set search_path to '' as $fn$
declare
  v_entrega uuid;
  v_cobro uuid;
begin
  insert into public.reparto_pago (
    socio_id, aeronave_id, periodo, monto, moneda, tc_usd_mxn, monto_usd,
    monto_mxn, saldo_snapshot_mxn, fecha_pago, metodo, referencia, notas,
    entregado_por, client_request_id, created_by
  ) values (
    (p_entrega->>'socio_id')::uuid,
    (p_entrega->>'aeronave_id')::uuid,
    (p_entrega->>'periodo')::date,
    (p_entrega->>'monto')::numeric,
    p_entrega->>'moneda',
    (p_entrega->>'tc_usd_mxn')::numeric,
    (p_entrega->>'monto_usd')::numeric,
    (p_entrega->>'monto_mxn')::numeric,
    (p_entrega->>'saldo_snapshot_mxn')::numeric,
    (p_entrega->>'fecha_pago')::date,
    p_entrega->>'metodo',
    p_entrega->>'referencia',
    p_entrega->>'notas',
    (p_entrega->>'entregado_por')::uuid,
    (p_entrega->>'client_request_id')::uuid,
    (p_entrega->>'created_by')::uuid
  )
  returning id into v_entrega;

  insert into public.cobro_vuelo (
    vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, fecha_cobro,
    referencia, notas, registrado_por, client_request_id, created_by,
    updated_by, reparto_pago_id
  ) values (
    (p_cobro->>'vuelo_id')::uuid,
    (p_cobro->>'monto')::numeric,
    (p_cobro->>'moneda')::public.moneda,
    (p_cobro->>'metodo_cobro')::public.metodo_cobro,
    (p_cobro->>'tc_usd_mxn')::numeric,
    coalesce((p_cobro->>'fecha_cobro')::timestamptz, now()),
    p_cobro->>'referencia',
    p_cobro->>'notas',
    (p_cobro->>'registrado_por')::uuid,
    (p_cobro->>'client_request_id')::uuid,
    (p_cobro->>'created_by')::uuid,
    (p_cobro->>'updated_by')::uuid,
    v_entrega
  )
  returning id into v_cobro;

  return jsonb_build_object('entrega_id', v_entrega, 'cobro_id', v_cobro);
end $fn$;

comment on function public.cobro_utilidades_registrar(jsonb, jsonb) is
  'Cobro de un vuelo CON UTILIDADES DEL SOCIO (23-nov-2026): inserta la entrega (reparto_pago) y el cobro (cobro_vuelo) ligados, en una sola transacción.';
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

  -- T1: alta atómica (entrega + cobro ligados) y su bitácora.

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
  select count(*) into v_n from public.cobro_vuelo c
    join public.reparto_pago p on p.id = c.reparto_pago_id
   where c.id = v_cobro and p.id = v_entrega and p.deleted_at is null
     and c.metodo_cobro::text = 'OTRO' and c.monto = p.monto and c.moneda::text = p.moneda
     and p.monto_mxn = 44174.30 and p.monto_usd = 2366.40 and p.periodo = date '2026-10-01';
  if v_n <> 1 then raise exception 'T1 FALLO: el alta no dejó las dos filas ligadas'; end if;
  select count(*) into v_n from public.reparto_bitacora where registro_id = v_entrega and accion = 'INSERT';
  if v_n <> 1 then raise exception 'T1 FALLO: la bitácora no registró el alta de la entrega (%)', v_n; end if;

  -- T1b: la misma llave no entra dos veces (y no deja media alta).
  begin
    perform public.cobro_utilidades_registrar(
      jsonb_build_object(
        'socio_id', v_socio, 'aeronave_id', v_avion, 'periodo', '2026-10-01',
        'monto', 1, 'moneda', 'MXN', 'tc_usd_mxn', 18.6673, 'monto_usd', 0.05, 'monto_mxn', 1,
        'fecha_pago', '2026-10-28', 'metodo', 'OTRO', 'entregado_por', v_actor,
        'client_request_id', v_llave, 'created_by', v_actor),
      jsonb_build_object('vuelo_id', v_vuelo, 'monto', 1, 'moneda', 'MXN', 'metodo_cobro', 'OTRO',
        'tc_usd_mxn', 18.6673, 'client_request_id', v_llave));
    raise exception 'T1b FALLO: la misma llave entró dos veces';
  exception when unique_violation then null;
  end;
  -- T1c: si el cobro no entra (vuelo inexistente), la entrega tampoco queda.
  select count(*) into v_n from public.reparto_pago where socio_id = v_socio;
  begin
    perform public.cobro_utilidades_registrar(
      jsonb_build_object(
        'socio_id', v_socio, 'aeronave_id', v_avion, 'periodo', '2026-10-01',
        'monto', 2, 'moneda', 'MXN', 'tc_usd_mxn', 18.6673, 'monto_usd', 0.11, 'monto_mxn', 2,
        'fecha_pago', '2026-10-28', 'metodo', 'OTRO', 'entregado_por', v_actor, 'created_by', v_actor),
      jsonb_build_object('vuelo_id', gen_random_uuid(), 'monto', 2, 'moneda', 'MXN', 'metodo_cobro', 'OTRO',
        'tc_usd_mxn', 18.6673));
    raise exception 'T1c FALLO: entró un cobro de un vuelo inexistente';
  exception when foreign_key_violation then null;
  end;
  if (select count(*) from public.reparto_pago where socio_id = v_socio) <> v_n then
    raise exception 'T1c FALLO: quedó una entrega sin su cobro';
  end if;

  -- T2: el cobro ligado no cambia de monto, moneda, T.C. ni fecha, ni suelta la liga.
  begin
    update public.cobro_vuelo set monto = 100 where id = v_cobro;
    raise exception 'T2 FALLO: se pudo cambiar el monto';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'COBRO_CON_UTILIDADES' then raise exception 'T2 hint inesperado: %', v_err; end if;
  end;
  begin
    update public.cobro_vuelo set fecha_cobro = now() where id = v_cobro;
    raise exception 'T2b FALLO: se pudo cambiar la fecha';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'COBRO_CON_UTILIDADES' then raise exception 'T2b hint inesperado: %', v_err; end if;
  end;
  begin
    update public.cobro_vuelo set reparto_pago_id = null where id = v_cobro;
    raise exception 'T2c FALLO: se pudo soltar la liga';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'UTILIDADES_LIGA_INMUTABLE' then raise exception 'T2c hint inesperado: %', v_err; end if;
  end;

  -- T3: lo que no es dinero sí se corrige (notas, y el mismo monto reenviado).
  update public.cobro_vuelo set notas = 'DRYRUN nota', monto = 44174.30 where id = v_cobro;

  -- T4: la entrega de un vuelo no cambia su dinero ni se da de baja sola.
  begin
    update public.reparto_pago set monto = 10, monto_mxn = 10 where id = v_entrega;
    raise exception 'T4 FALLO: se pudo cambiar el monto de la entrega';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'ENTREGA_DE_VUELO' then raise exception 'T4 hint inesperado: %', v_err; end if;
  end;
  begin
    update public.reparto_pago set deleted_at = now(), deleted_by = v_actor, motivo_baja = 'DRYRUN'
     where id = v_entrega;
    raise exception 'T4b FALLO: se pudo dar de baja la entrega con su cobro vivo';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'ENTREGA_DE_VUELO' then raise exception 'T4b hint inesperado: %', v_err; end if;
  end;

  -- T5: las notas de la entrega sí se corrigen.
  update public.reparto_pago set notas = 'DRYRUN nota entrega', updated_by = v_actor where id = v_entrega;

  -- T6: una segunda liga a la MISMA entrega no entra (1 a 1).
  begin
    insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, reparto_pago_id)
    values (v_vuelo, 44174.30, 'MXN', 'OTRO', 18.6673, v_entrega);
    raise exception 'T6 FALLO: dos cobros citan la misma entrega';
  exception when unique_violation then null;
  end;

  -- T8: una entrega de otro monto, con comisión bancaria o dada de baja no se cita.
  insert into public.reparto_pago (socio_id, aeronave_id, periodo, monto, moneda, tc_usd_mxn, monto_usd,
                                   monto_mxn, fecha_pago, metodo, entregado_por, created_by)
  values (v_socio, v_avion, '2026-10-01', 500, 'MXN', 18.6673, 26.78, 500, '2026-10-28', 'OTRO', v_actor, v_actor)
  returning id into v_entrega2;
  begin
    insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, reparto_pago_id)
    values (v_vuelo, 499, 'MXN', 'OTRO', 18.6673, v_entrega2);
    raise exception 'T8b FALLO: el cobro y la entrega valen distinto';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'UTILIDADES_MONTO_DISTINTO' then raise exception 'T8b hint inesperado: %', v_err; end if;
  end;
  begin
    insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, reparto_pago_id, comision_banco_monto)
    values (v_vuelo, 500, 'MXN', 'OTRO', 18.6673, v_entrega2, 10);
    raise exception 'T8c FALLO: cobro con utilidades y comisión bancaria';
  exception when check_violation then null;
  end;
  -- Una entrega NORMAL (sin cobro que la cite) se corrige y se da de baja como siempre.
  update public.reparto_pago set monto = 600, monto_mxn = 600 where id = v_entrega2;
  update public.reparto_pago set deleted_at = now(), deleted_by = v_actor, motivo_baja = 'DRYRUN'
   where id = v_entrega2;
  begin
    insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn, reparto_pago_id)
    values (v_vuelo, 600, 'MXN', 'OTRO', 18.6673, v_entrega2);
    raise exception 'T8 FALLO: se citó una entrega dada de baja';
  exception when check_violation then
    get stacked diagnostics v_err = pg_exception_hint;
    if v_err <> 'UTILIDADES_ENTREGA_DADA_DE_BAJA' then raise exception 'T8 hint inesperado: %', v_err; end if;
  end;

  -- T9: un cobro NORMAL (sin liga) entra y se corrige como siempre; uno que ya
  -- existía en producción también se puede tocar.
  insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, tc_usd_mxn)
  values (v_vuelo, 1000, 'MXN', 'TRANSFERENCIA', 18.6673)
  returning id into v_cobro2;
  update public.cobro_vuelo set monto = 1200, fecha_cobro = now(), tc_usd_mxn = 18.7 where id = v_cobro2;
  update public.cobro_vuelo c set notas = c.notas
   where c.id = (select id from public.cobro_vuelo where reparto_pago_id is null order by created_at limit 1);

  raise exception 'DRYRUN_OK 20261123000001: alta atómica y candados pasaron; todo se revierte';
end $dry$;
