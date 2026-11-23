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
