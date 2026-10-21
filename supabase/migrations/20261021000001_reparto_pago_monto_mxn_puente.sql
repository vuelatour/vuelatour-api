-- 21-oct-2026 · PUENTE: `reparto_pago.monto_mxn` lo llena la BD si el API no lo manda.
-- API 0.0.102, invariante 99 del CLAUDE.md del API.
--
-- POR QUÉ: la migración 20261020000006 dejó `monto_mxn` NOT NULL y el CHECK
-- «en MXN, monto_mxn = monto» (la cuenta corriente en pesos). Se aplicó el
-- 21-oct-2026 a las 13:10 UTC, inmediatamente antes del push del API 0.0.102,
-- pero Railway estaba caído (incidente QH8L8B3E: «builds paused» en todas las
-- regiones) y prod se quedó con el API 0.0.99, que al registrar o corregir una
-- entrega NO manda `monto_mxn` ⇒ 23502/23514 ⇒ 500 en «Registrar entrega».
--
-- QUÉ HACE: un trigger BEFORE INSERT OR UPDATE OF monto, moneda, monto_mxn
-- que, SOLO cuando hace falta, completa los pesos con la MISMA regla del API:
--   - MXN: monto_mxn = monto (si viene null o distinto).
--   - USD sin pesos: alta ⇒ monto × (tc_usd_mxn ?? T.C. oficial ≤ fecha_pago
--     ?? 18.00); corrección ⇒ conserva el T.C. implícito (monto_mxn ÷ monto
--     de la fila anterior).
--   - USD con pesos y el monto cambia sin tocar los pesos ⇒ conserva el T.C.
--     implícito (lo que hace `tcDePago` en el API 0.0.102).
-- Con el API 0.0.102 (que siempre manda `monto_mxn` coherente) el trigger no
-- cambia nada: es un cinturón, no una regla nueva. Se queda para siempre.
--
-- ROLLBACK (solo SQL Editor): drop trigger trg_reparto_pago_monto_mxn_puente
-- on public.reparto_pago; drop function public.tg_reparto_pago_monto_mxn_puente();
--
-- Por MCP se aplica SOLO el CUERPO (apply_migration, name
-- '20261021000001_reparto_pago_monto_mxn_puente'). Sin palabras destructivas.
-- Dry-run (21-oct-2026, prod, en `begin … raise exception`): alta MXN sin
-- pesos ⇒ 1,850; corrección a 2,000 ⇒ 2,000; alta USD 100 sin T.C. ⇒ 1,844.66
-- (oficial 18.4466 del 20-oct); bajar a 50 USD ⇒ 922.33. DRYRUN_OK.

create or replace function public.tg_reparto_pago_monto_mxn_puente()
 returns trigger
 language plpgsql
 set search_path to ''
as $fn$
declare
  v_tc numeric;
begin
  if new.moneda = 'MXN' then
    if new.monto_mxn is null or new.monto_mxn <> new.monto then
      new.monto_mxn := new.monto;
    end if;
    return new;
  end if;
  -- USD: pesos implícitos. Alta sin pesos ⇒ T.C. capturado ?? oficial del día ?? 18.
  if new.monto_mxn is null then
    if tg_op = 'UPDATE' and old.monto_mxn is not null and old.monto > 0 then
      new.monto_mxn := round(new.monto * old.monto_mxn / old.monto, 2);
    else
      select t.tc into v_tc from public.tipo_cambio_oficial t
        where t.fecha <= new.fecha_pago order by t.fecha desc limit 1;
      new.monto_mxn := round(new.monto * coalesce(new.tc_usd_mxn, v_tc, 18.00), 2);
    end if;
  elsif tg_op = 'UPDATE' and new.monto <> old.monto and new.monto_mxn = old.monto_mxn and old.monto > 0 then
    -- Cambió el monto en USD sin tocar los pesos: conservar el T.C. implícito.
    new.monto_mxn := round(new.monto * old.monto_mxn / old.monto, 2);
  end if;
  return new;
end $fn$;

create trigger trg_reparto_pago_monto_mxn_puente
  before insert or update of monto, moneda, monto_mxn on public.reparto_pago
  for each row execute function public.tg_reparto_pago_monto_mxn_puente();

comment on function public.tg_reparto_pago_monto_mxn_puente() is
  'Puente (21-oct-2026): completa reparto_pago.monto_mxn con la regla del API cuando una escritura no lo manda (API ≤ 0.0.101 en prod durante la caída de Railway). Con el API 0.0.102 no cambia nada.';
