-- 20-oct-2026 · CUENTA CORRIENTE DE LOS SOCIOS EN PESOS (MXN).
-- API 0.0.101, invariante 99 del CLAUDE.md del API.
--
-- PEDIDO DEL CLIENTE (20-oct-2026, captura de «Pagos a socios»): «todo ponlo
-- en pesos, porque aquí en pagos a socios dice en dólares y pagamos
-- realmente en pesos, entonces que todo sea en pesos y diga MXN». Caso real:
-- a Mauricio Roque se le entregaron $238,265.53 MXN (el 69 % del balance de
-- N4142R de septiembre) y la cuenta, en dólares al T.C. del día (18.4465),
-- decía que faltaban $5,462.68 USD.
--
-- QUÉ HACE:
--   1. `reparto_pago.monto_mxn numeric(14,2) NOT NULL`: lo que la entrega
--      descuenta del saldo EN PESOS. MXN = `monto` tal cual; USD = `monto` ×
--      T.C. de la entrega (el API lo calcula; el T.C. de una entrega en
--      dólares NO se guarda en `tc_usd_mxn` —el CHECK `reparto_pago_tc_moneda_chk`
--      lo prohíbe y no se toca— y queda implícito: monto_mxn ÷ monto).
--      Backfill: MXN ⇒ monto; USD ⇒ round(monto_usd × T.C. oficial del día de
--      la entrega, 2) (o 18.00 si no hay oficial; hoy solo hay UNA entrega
--      USD y está dada de baja).
--   2. `reparto_pago.saldo_snapshot_mxn numeric(14,2)`: lo por entregar de
--      meses cerrados ANTES de la entrega, en pesos (el candado del
--      adelanto). NULL en las entregas previas (el `_usd` se conserva).
--   3. `reparto_cuenta_socio.saldo_inicial_mxn numeric(14,2) NOT NULL DEFAULT 0`:
--      el saldo inicial en pesos. Backfill: `saldo_inicial_usd` × T.C. oficial
--      del último día antes de `cuenta_desde` (hoy UNA cuenta: −6,193.70 USD
--      del 31-ago-2026 ⇒ × 17.0308 = −105,483.67 MXN). LA OFICINA DEBE
--      REVISARLO en «Pagos a socios → Configurar cuenta» (el valor viejo en
--      USD queda en la columna de siempre, informativa).
--   4. La bitácora `tg_reparto_bitacora` audita las tres columnas nuevas
--      (mismo cuerpo, columnas al final de cada lista).
--   5. CHECKs ADITIVOS: `monto_mxn > 0` y, en MXN, `monto_mxn = monto`.
--
-- DEPENDENCIA DURA DEL API 0.0.101: el alta de entregas escribe `monto_mxn`
-- (NOT NULL) y la cuenta lee `saldo_inicial_mxn` ⇒ ESTA MIGRACIÓN VA ANTES
-- DEL PUSH DEL API, inmediatamente antes: con el API 0.0.100 arriba y la
-- migración aplicada, registrar una entrega rebota (NOT NULL de monto_mxn).
-- No registrar entregas en esa ventana.
--
-- ROLLBACK (solo SQL Editor): alter table public.reparto_pago drop column
-- monto_mxn, drop column saldo_snapshot_mxn; alter table
-- public.reparto_cuenta_socio drop column saldo_inicial_mxn; y volver a
-- correr el cuerpo anterior de `tg_reparto_bitacora` (20261002000001).
--
-- Por MCP se aplica SOLO el CUERPO (apply_migration, name
-- '20261020000006_reparto_cuenta_en_pesos'). Sin palabras destructivas.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (ANTES de aplicar). UNA sentencia por MCP `execute_sql`; el `raise
-- exception` final revierte todo. Orden: cuerpo → filas de prueba → pruebas.
--
-- do $dry$
-- declare
--   v_usr uuid; v_socio uuid; v_p uuid; v_mxn numeric; v_d jsonb; v_n int;
-- begin
--   if exists (select 1 from information_schema.columns where table_schema = 'public'
--              and table_name = 'reparto_pago' and column_name = 'monto_mxn') then
--     raise exception 'DRYRUN_FALLA A: la columna ya existe';
--   end if;
--   <CUERPO pegado tal cual>
--   -- Backfill: la entrega MXN viva de Mauricio (238,265.53) queda tal cual.
--   select monto_mxn into v_mxn from public.reparto_pago where id = '05f5cf4c-a251-4885-ae15-992c456a4c68';
--   if v_mxn is distinct from 238265.53 then raise exception 'DRYRUN_FALLA B1: backfill MXN = %', v_mxn; end if;
--   select count(*) into v_n from public.reparto_pago where monto_mxn is null or monto_mxn <= 0;
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA B2: % entregas sin pesos', v_n; end if;
--   select saldo_inicial_mxn into v_mxn from public.reparto_cuenta_socio where socio_id = 'f0250661-1f2f-4c7e-822f-369def62f121';
--   if v_mxn is distinct from -105483.67 then raise exception 'DRYRUN_FALLA B3: saldo inicial MXN = %', v_mxn; end if;
--   -- Escritura REAL: alta con pesos, bitácora con la columna nueva.
--   select u.id into v_usr from public.usuario u where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' order by u.created_at limit 1;
--   select s.socio_id into v_socio from public.aeronave_socio s order by s.created_at limit 1;
--   insert into public.reparto_pago (socio_id, monto, moneda, tc_usd_mxn, monto_usd, monto_mxn, saldo_snapshot_mxn, fecha_pago, metodo, entregado_por, created_by, updated_by)
--   values (v_socio, 1850.00, 'MXN', 18.5, 100.00, 1850.00, 5000.00, date '2026-10-20', 'EFECTIVO', v_usr, v_usr, v_usr)
--   returning id into v_p;
--   select diff into v_d from public.reparto_bitacora where registro_id = v_p and accion = 'INSERT';
--   if v_d->'monto_mxn' is null or v_d->'saldo_snapshot_mxn' is null then raise exception 'DRYRUN_FALLA C: la bitácora no trae los pesos'; end if;
--   begin
--     update public.reparto_pago set monto_mxn = 1900.00, updated_by = v_usr where id = v_p;
--     raise exception 'DRYRUN_FALLA D: aceptó monto_mxn <> monto en MXN';
--   exception when check_violation then null;
--   end;
--   update public.reparto_cuenta_socio set saldo_inicial_mxn = -100000.00, updated_by = v_usr where socio_id = 'f0250661-1f2f-4c7e-822f-369def62f121';
--   select diff into v_d from public.reparto_bitacora where registro_id = 'f0250661-1f2f-4c7e-822f-369def62f121' and tabla = 'reparto_cuenta_socio' order by created_at desc limit 1;
--   if v_d->'saldo_inicial_mxn' is null then raise exception 'DRYRUN_FALLA E: la bitácora de la cuenta no trae los pesos'; end if;
--   raise exception 'DRYRUN_OK 20261020000006 · pesos en entregas y cuenta + bitácora + CHECKs';
-- end $dry$;
-- ---------------------------------------------------------------------------

-- 1 y 2. Entregas en pesos.
alter table public.reparto_pago
  add column if not exists monto_mxn numeric(14,2),
  add column if not exists saldo_snapshot_mxn numeric(14,2);

update public.reparto_pago p
set monto_mxn = case
  when p.moneda = 'MXN' then p.monto
  else round(
    p.monto_usd * coalesce(
      (select t.tc from public.tipo_cambio_oficial t
        where t.fecha <= p.fecha_pago order by t.fecha desc limit 1),
      18.00),
    2)
end
where p.monto_mxn is null;

alter table public.reparto_pago
  alter column monto_mxn set not null;

alter table public.reparto_pago
  add constraint reparto_pago_monto_mxn_chk check (monto_mxn > 0),
  add constraint reparto_pago_monto_mxn_mxn_chk check (moneda <> 'MXN' or monto_mxn = monto);

comment on column public.reparto_pago.monto_mxn is
  'Lo que la entrega descuenta del saldo EN PESOS (20-oct-2026, invariante 99): MXN = monto; USD = monto × T.C. de la entrega (implícito: monto_mxn ÷ monto).';
comment on column public.reparto_pago.saldo_snapshot_mxn is
  'Lo por entregar de meses cerrados ANTES de esta entrega, en pesos (el candado del adelanto). NULL en entregas previas al 0.0.101.';

-- 3. Saldo inicial en pesos.
alter table public.reparto_cuenta_socio
  add column if not exists saldo_inicial_mxn numeric(14,2);

update public.reparto_cuenta_socio c
set saldo_inicial_mxn = round(
  c.saldo_inicial_usd * coalesce(
    (select t.tc from public.tipo_cambio_oficial t
      where t.fecha < c.cuenta_desde order by t.fecha desc limit 1),
    18.00),
  2)
where c.saldo_inicial_mxn is null;

alter table public.reparto_cuenta_socio
  alter column saldo_inicial_mxn set not null,
  alter column saldo_inicial_mxn set default 0;

comment on column public.reparto_cuenta_socio.saldo_inicial_mxn is
  'Saldo al arrancar la cuenta EN PESOS (20-oct-2026, invariante 99): positivo = se le debía al socio; negativo = ya se le había adelantado. El _usd queda informativo.';

-- 4. Bitácora: las tres columnas nuevas (mismo cuerpo de 20261002000001).
create or replace function public.tg_reparto_bitacora()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  cols text[];
  v_old jsonb;
  v_new jsonb;
  v_diff jsonb := '{}'::jsonb;
  v_actor uuid;
  c text;
begin
  if tg_table_name = 'reparto_pago' then
    cols := array[
      'socio_id','aeronave_id','periodo','monto','moneda','tc_usd_mxn',
      'monto_usd','saldo_snapshot_usd','fecha_pago','metodo','referencia',
      'entregado_por','recibido_por','factura_folio','comprobante_path',
      'notas','deleted_at','deleted_by','motivo_baja',
      'monto_mxn','saldo_snapshot_mxn'
    ];
  else
    cols := array['cuenta_desde','saldo_inicial_usd','notas','saldo_inicial_mxn'];
  end if;

  if tg_op = 'DELETE' then
    v_old := to_jsonb(old);
    insert into public.reparto_bitacora
      (tabla, registro_id, socio_id, accion, actor_id, diff, snapshot)
    values (
      tg_table_name,
      coalesce((v_old->>'id')::uuid, (v_old->>'socio_id')::uuid),
      (v_old->>'socio_id')::uuid,
      'DELETE',
      (v_old->>'updated_by')::uuid,
      '{}'::jsonb,
      v_old);
    return old;
  end if;

  v_new := to_jsonb(new);
  if tg_op = 'INSERT' then
    foreach c in array cols loop
      if v_new->c is not null and v_new->c <> 'null'::jsonb then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
      end if;
    end loop;
    v_actor := coalesce((v_new->>'created_by')::uuid, (v_new->>'updated_by')::uuid);
  else
    v_old := to_jsonb(old);
    foreach c in array cols loop
      if v_old->c is distinct from v_new->c then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      return new;
    end if;
    if (v_old->>'deleted_at') is null and (v_new->>'deleted_at') is not null then
      v_actor := coalesce((v_new->>'deleted_by')::uuid, (v_new->>'updated_by')::uuid);
    else
      v_actor := (v_new->>'updated_by')::uuid;
    end if;
  end if;

  insert into public.reparto_bitacora
    (tabla, registro_id, socio_id, accion, actor_id, diff)
  values (
    tg_table_name,
    coalesce((v_new->>'id')::uuid, (v_new->>'socio_id')::uuid),
    (v_new->>'socio_id')::uuid,
    tg_op,
    v_actor,
    v_diff);
  return new;
end $function$;
