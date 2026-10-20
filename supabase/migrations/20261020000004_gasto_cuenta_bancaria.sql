-- 20-oct-2026 · CUENTA DE DONDE SALIÓ EL PAGO DE UN GASTO. API 0.0.100,
-- invariante 98 del CLAUDE.md del API.
--
-- PEDIDO DEL CLIENTE (20-oct-2026, punto 2 de la lista): «cuando registramos
-- un gasto y eliges transferencia que se pueda elegir de cuál banco o cuenta
-- bancaria de las que ya están registradas salió la transferencia, y si no
-- existe alguna que se pueda agregar desde esa parte sin salir a otra
-- pantalla … la cuenta de paywise entraría en estas opciones de bancos.»
--
-- QUÉ HACE:
--   1. `gasto.cuenta_bancaria_id` (uuid, NULL, FK a `cuenta_bancaria`) +
--      índice parcial. Lo escribe SOLO el API y solo con medio
--      TRANSFERENCIA, DOMICILIADO o PAYWISE (`MEDIOS_CON_CUENTA`); con
--      cualquier otro medio el API lo deja en NULL. Sin CHECK a propósito: el
--      acoplamiento medio↔cuenta lo normaliza el API en alta y PATCH (un
--      CHECK convertiría en 500 cualquier otro escritor del medio).
--   2. La bitácora del gasto (`tg_gasto_bitacora`) audita la columna nueva:
--      el mismo cuerpo de siempre con `cuenta_bancaria_id` al final de la
--      lista de columnas.
--
-- DEPENDENCIA DURA DEL API 0.0.100: `COLS`/`LIST_EMBEDS` de gastos y el cruce
-- nombran la columna ⇒ ESTA MIGRACIÓN VA ANTES DEL PUSH DEL API.
--
-- ROLLBACK: el API ≤ 0.0.99 no nombra la columna (inofensiva). Revertir la
-- bitácora = volver a correr su cuerpo anterior (sin la columna).
--
-- Por MCP se aplica SOLO el CUERPO (apply_migration, name
-- '20261020000004_gasto_cuenta_bancaria'). Sin palabras destructivas.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN (ANTES de aplicar). UNA sentencia por MCP `execute_sql`; el `raise
-- exception` final revierte todo. Orden: cuerpo → filas de prueba → pruebas.
--
-- do $dry$
-- declare
--   v_usr uuid; v_avion uuid; v_cta uuid; v_g uuid; v_d jsonb; v_b int;
-- begin
--   if exists (select 1 from information_schema.columns where table_schema = 'public'
--              and table_name = 'gasto' and column_name = 'cuenta_bancaria_id') then
--     raise exception 'DRYRUN_FALLA A: la columna ya existe';
--   end if;
--   <CUERPO pegado tal cual>
--   select u.id into v_usr from public.usuario u where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO' order by u.created_at limit 1;
--   select a.id into v_avion from public.aeronave a order by a.matricula limit 1;
--   select c.id into v_cta from public.cuenta_bancaria c where c.activa order by c.alias limit 1;
--   insert into public.gasto (usuario_captura_id, categoria, monto, moneda, fecha_gasto, medio_pago, aeronave_id, cuenta_bancaria_id, notas, origen, created_by, updated_by)
--   values (v_usr, 'SERVICIOS', 1499.00, 'MXN', date '2026-10-20', 'TRANSFERENCIA', v_avion, v_cta, 'DRYRUN 20261020000004', 'OFICINA', v_usr, v_usr)
--   returning id into v_g;
--   select diff into v_d from public.gasto_bitacora where gasto_id = v_g and accion = 'INSERT';
--   if v_d->'cuenta_bancaria_id' is null then raise exception 'DRYRUN_FALLA B1: la bitácora del alta no trae la cuenta'; end if;
--   update public.gasto set cuenta_bancaria_id = null, updated_by = v_usr where id = v_g;
--   select diff into v_d from public.gasto_bitacora where gasto_id = v_g and accion = 'UPDATE' order by created_at desc limit 1;
--   if v_d->'cuenta_bancaria_id'->>'antes' is distinct from v_cta::text then raise exception 'DRYRUN_FALLA B2: la bitácora del cambio no trae la cuenta'; end if;
--   update public.gasto set monto = 1500.00, updated_by = v_usr where id = v_g;
--   select count(*) into v_b from public.gasto_bitacora where gasto_id = v_g;
--   if v_b <> 3 then raise exception 'DRYRUN_FALLA B3: bitácora = % (esperado 3)', v_b; end if;
--   begin
--     update public.gasto set cuenta_bancaria_id = gen_random_uuid() where id = v_g;
--     raise exception 'DRYRUN_FALLA C: la FK no rechazó una cuenta inexistente';
--   exception when foreign_key_violation then null;
--   end;
--   raise exception 'DRYRUN_OK 20261020000004 · columna + índice + bitácora + FK';
-- end $dry$;
-- ---------------------------------------------------------------------------

alter table public.gasto
  add column if not exists cuenta_bancaria_id uuid
  references public.cuenta_bancaria (id);

create index if not exists idx_gasto_cuenta_bancaria
  on public.gasto (cuenta_bancaria_id)
  where cuenta_bancaria_id is not null;

comment on column public.gasto.cuenta_bancaria_id is
  'Cuenta de donde salió el pago (20-oct-2026, invariante 98): solo con medio TRANSFERENCIA, DOMICILIADO o PAYWISE; la normaliza el API.';

create or replace function public.tg_gasto_bitacora()
 returns trigger
 language plpgsql
 set search_path to ''
as $function$
declare
  cols text[] := array[
    'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
    'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
    'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
    'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
    'folio_ticket','conciliado','tua_incluida','es_pago_afac','por_pagar',
    'cuenta_bancaria_id'
  ];
  v_diff jsonb := '{}'::jsonb;
  v_old jsonb;
  v_new jsonb;
  c text;
begin
  if tg_op = 'INSERT' then
    v_new := to_jsonb(new);
    foreach c in array cols loop
      if v_new->c is not null and v_new->c <> 'null'::jsonb then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
      end if;
    end loop;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, new.vuelo_id, 'INSERT', new.created_by, v_diff);
    return new;
  elsif tg_op = 'UPDATE' then
    v_old := to_jsonb(old);
    v_new := to_jsonb(new);
    foreach c in array cols loop
      if v_old->c is distinct from v_new->c then
        v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
      end if;
    end loop;
    if v_diff = '{}'::jsonb then
      return new;
    end if;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
    return new;
  else
    -- Baja del gasto: tg_op vale el mismo texto de siempre.
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
    values (old.id, old.vuelo_id, tg_op, old.updated_by, '{}'::jsonb, to_jsonb(old));
    return old;
  end if;
end
$function$;
