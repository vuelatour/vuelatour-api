-- 15-sep-2026 · HOTFIX de 20260914000001: `moneda` es un ENUM (public.moneda)
-- en gasto y cuenta_bancaria, y el trigger tg_mov_bancario_gasto_suma
-- comparaba `c.moneda = v_moneda_gasto` (enum = text): Postgres no tiene ese
-- operador y CADA liga de un cargo a un gasto reventaba con
-- «operator does not exist: public.moneda = text» — la importación del
-- estado de cuenta del 15-sep se cayó al 37 % (job 4f9545e3) y el vínculo
-- manual del panel también fallaba. Desde ayer NADA se conciliaba.
--
-- Corrección: toda comparación de moneda va como TEXTO (`::text`). Regla
-- para el futuro: `moneda` (gasto, cuenta_bancaria, cobro_vuelo) es ENUM;
-- en plpgsql se compara `::text`, nunca contra una variable text a secas.
-- Probada en seco sobre prod (begin: liga real de un cargo + rechazo del
-- segundo que rebasa; rollback) antes de aplicar.

create or replace function public.tg_mov_bancario_gasto_suma()
returns trigger
language plpgsql
security definer
set search_path = ''
as $function$
declare
  v_monto_gasto numeric;
  v_moneda_gasto text;
  v_moneda_cuenta text;
  v_suma numeric := 0;
  v_otros integer := 0;
  v_cruzados integer := 0;
begin
  if new.gasto_id is null then
    return new;
  end if;
  if tg_op = 'UPDATE'
     and new.gasto_id is not distinct from old.gasto_id
     and new.monto is not distinct from old.monto
     and new.cuenta_bancaria_id is not distinct from old.cuenta_bancaria_id then
    return new;
  end if;
  -- `moneda` es un ENUM (public.moneda) en gasto y cuenta_bancaria: se compara
  -- SIEMPRE como texto (enum = text no tiene operador: 15-sep-2026).
  select g.monto, g.moneda::text
    into v_monto_gasto, v_moneda_gasto
    from public.gasto g
   where g.id = new.gasto_id
     for update;
  if not found then
    return new;
  end if;
  select c.moneda::text
    into v_moneda_cuenta
    from public.cuenta_bancaria c
   where c.id = new.cuenta_bancaria_id;
  select
      coalesce(sum(abs(m.monto)) filter (
        where c.moneda is null
           or v_moneda_gasto is null
           or c.moneda::text = v_moneda_gasto), 0),
      count(*),
      count(*) filter (
        where c.moneda is not null
          and v_moneda_gasto is not null
          and c.moneda::text <> v_moneda_gasto)
    into v_suma, v_otros, v_cruzados
    from public.movimiento_bancario m
    left join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
   where m.gasto_id = new.gasto_id
     and m.id <> new.id;
  if v_moneda_cuenta is not null
     and v_moneda_gasto is not null
     and v_moneda_cuenta <> v_moneda_gasto then
    if v_otros > 0 then
      raise exception
        'GASTO_YA_CUBIERTO: el gasto % (%) ya tiene % cargo(s) ligado(s); un cargo en otra MONEDA (%) solo se concilia 1 a 1',
        new.gasto_id, v_moneda_gasto, v_otros, v_moneda_cuenta
        using errcode = '23514';
    end if;
    return new;
  end if;
  if v_cruzados > 0 then
    raise exception
      'GASTO_YA_CUBIERTO: el gasto % ya está conciliado contra un cargo de otra MONEDA (1 a 1)',
      new.gasto_id
      using errcode = '23514';
  end if;
  if v_suma + abs(new.monto) > coalesce(v_monto_gasto, 0) + 1.00 + 0.000001 then
    raise exception
      'GASTO_YA_CUBIERTO: los cargos ligados al gasto % suman % y con este (%) rebasan su monto (%)',
      new.gasto_id, round(v_suma, 2), round(abs(new.monto), 2),
      round(coalesce(v_monto_gasto, 0), 2)
      using errcode = '23514';
  end if;
  return new;
end $function$;

revoke execute on function public.tg_mov_bancario_gasto_suma() from public, anon, authenticated;
