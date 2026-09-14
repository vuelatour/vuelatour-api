-- 14-sep-2026 · Dos piezas del caso real del cliente (vuelo #260 N4142R):
--
-- (A) HISTORIAL DE GASTOS MOVIDOS ENTRE VUELOS. `tg_gasto_bitacora` escribe
--     el UPDATE bajo `coalesce(new.vuelo_id, old.vuelo_id)` = el vuelo
--     DESTINO, así que el vuelo de ORIGEN se quedaba con una captura MUDA
--     («Gasto capturado» sin descripción ni acción). `gastosHistorial` ahora
--     lee TAMBIÉN las filas cuyo `diff->'vuelo_id'->>'antes'` es este vuelo:
--     este índice es el que hace barata esa consulta.
--
-- (B) CONCILIACIÓN CON PAGOS PARCIALES: «1 factura se hizo en 2 pagos y al
--     conciliar solo me deja asociar 1». El modelo era 1 gasto ↔ 1
--     movimiento (índice ÚNICO `uq_mov_bancario_gasto`, 20260720000002).
--     Desde hoy un gasto admite N cargos de SU MISMA moneda mientras la
--     suma de |monto| no rebase `gasto.monto + 1.00` (tolerancia). Un gasto
--     conciliado contra otra moneda (USD ↔ cuenta MXN, de donde sale su
--     `tc_gasto`) sigue siendo 1 ↔ 1. `gasto.conciliado` = true SOLO cuando
--     la suma CUBRE el monto (el API lo recalcula en cada liga/desliga:
--     `conciliacion-parcial.util.ts`, fuente única).
--
-- El índice único cerraba el TOCTOU de dos ligas simultáneas al mismo gasto
-- (dos operadores a la vez): al retirarlo, ese candado pasa al trigger
-- `tg_mov_bancario_gasto_suma`, que toma `for update` sobre el gasto y
-- revalida la suma DENTRO de la transacción.
--
-- ORDEN: aplicar ANTES o DESPUÉS del deploy del API es indistinto. Con el
-- API nuevo y la migración SIN aplicar, la segunda liga rebota con el 409
-- viejo del índice único («Ese gasto ya está vinculado…») — nada se
-- corrompe, solo sigue sin poderse partir el pago.

-- ---------------------------------------------------------------- (A)
-- Gastos que SALIERON de un vuelo. Índice de EXPRESIÓN, a propósito NO
-- parcial: con `where diff ? 'vuelo_id'` el planeador no puede demostrar
-- que el filtro `diff->'vuelo_id'->>'antes' = $1` implique el predicado, y
-- el índice no se usaría (seq scan de toda la bitácora en cada detalle de
-- vuelo). Las filas sin ese campo indexan NULL y no estorban.
create index if not exists idx_gasto_bitacora_movido_desde
  on public.gasto_bitacora ((diff->'vuelo_id'->>'antes'));

comment on index public.idx_gasto_bitacora_movido_desde is
  'Historial del vuelo ORIGEN: filas UPDATE cuyo diff movió el gasto a otro vuelo (la fila vive bajo el vuelo destino). 20260914000001.';

-- ---------------------------------------------------------------- (B)
-- 1 gasto ↔ N movimientos (misma moneda). El índice único se cambia por uno
-- normal: seguimos buscando por gasto_id (bandeja, candados, reportes).
drop index if exists public.uq_mov_bancario_gasto;

create index if not exists idx_mov_bancario_gasto
  on public.movimiento_bancario (gasto_id)
  where gasto_id is not null;

comment on index public.idx_mov_bancario_gasto is
  'Cargos del banco por gasto (pagos parciales, 14-sep-2026). Sustituye al índice ÚNICO uq_mov_bancario_gasto: la unicidad la reemplaza el trigger tg_mov_bancario_gasto_suma.';

-- El candado de verdad: la MISMA regla que `puedeLigar`
-- (src/modules/conciliacion/conciliacion-parcial.util.ts), en la BD, para
-- que ningún camino (API, carga masiva, SQL a mano) pueda sobre-ligar un
-- gasto ni ganarle una carrera a otro operador.
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
  -- UPDATE que no toca la liga, el monto ni la CUENTA (clasificación,
  -- notas, flags): nada que revalidar. La cuenta entra porque de ella sale
  -- la MONEDA del cargo: moverlo a una cuenta de otra moneda cambiaría la
  -- regla que se validó al ligarlo.
  if tg_op = 'UPDATE'
     and new.gasto_id is not distinct from old.gasto_id
     and new.monto is not distinct from old.monto
     and new.cuenta_bancaria_id is not distinct from old.cuenta_bancaria_id then
    return new;
  end if;

  -- `for update` = el candado anti-carrera que antes daba el índice único:
  -- dos ligas simultáneas al mismo gasto se serializan y la segunda ve ya
  -- comprometida a la primera.
  select g.monto, g.moneda
    into v_monto_gasto, v_moneda_gasto
    from public.gasto g
   where g.id = new.gasto_id
     for update;
  if not found then
    -- Gasto inexistente: lo rechaza la FK, no este trigger.
    return new;
  end if;

  select c.moneda
    into v_moneda_cuenta
    from public.cuenta_bancaria c
   where c.id = new.cuenta_bancaria_id;

  select
      coalesce(sum(abs(m.monto)) filter (
        where c.moneda is null
           or v_moneda_gasto is null
           or c.moneda = v_moneda_gasto), 0),
      count(*),
      count(*) filter (
        where c.moneda is not null
          and v_moneda_gasto is not null
          and c.moneda <> v_moneda_gasto)
    into v_suma, v_otros, v_cruzados
    from public.movimiento_bancario m
    left join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
   where m.gasto_id = new.gasto_id
     and m.id <> new.id;

  -- Cargo de OTRA moneda que el gasto (compra USD pagada en pesos): 1 ↔ 1,
  -- porque de ESE cargo se deriva el tipo de cambio del gasto.
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

  -- Ya conciliado contra un cargo de otra moneda: no admite ninguno más.
  if v_cruzados > 0 then
    raise exception
      'GASTO_YA_CUBIERTO: el gasto % ya está conciliado contra un cargo de otra MONEDA (1 a 1)',
      new.gasto_id
      using errcode = '23514';
  end if;

  -- Misma moneda: la suma no puede rebasar el ticket (+1.00 de tolerancia).
  if v_suma + abs(new.monto) > coalesce(v_monto_gasto, 0) + 1.00 + 0.000001 then
    raise exception
      'GASTO_YA_CUBIERTO: los cargos ligados al gasto % suman % y con este (%) rebasan su monto (%)',
      new.gasto_id, round(v_suma, 2), round(abs(new.monto), 2),
      round(coalesce(v_monto_gasto, 0), 2)
      using errcode = '23514';
  end if;

  return new;
end $function$;

comment on function public.tg_mov_bancario_gasto_suma() is
  'Regla 1 gasto ↔ N cargos (14-sep-2026): misma moneda y suma <= monto + 1.00; moneda distinta = 1 a 1. Espejo del util puro conciliacion-parcial.util.ts. Lanza 23514 con prefijo GASTO_YA_CUBIERTO (el API lo traduce a 409 GASTO_YA_CUBIERTO).';

-- Interna: nadie la invoca por PostgREST (solo el trigger). Sin este revoke el
-- advisor de Supabase (0028/0029) la marca como SECURITY DEFINER ejecutable
-- por anon/authenticated. (Aplicado en prod como follow-up el 14-sep-2026.)
revoke execute on function public.tg_mov_bancario_gasto_suma() from public, anon, authenticated;

drop trigger if exists trg_mov_bancario_gasto_suma on public.movimiento_bancario;
create trigger trg_mov_bancario_gasto_suma
  before insert or update of gasto_id, monto, cuenta_bancaria_id
  on public.movimiento_bancario
  for each row execute function public.tg_mov_bancario_gasto_suma();

-- ------------------------------------------------------------ PRUEBA MANUAL
-- (en un vuelo/gasto de prueba; `rollback;` al final para no ensuciar prod)
--
-- begin;
--   -- gasto de 277.79 MXN y dos cargos de la misma cuenta MXN
--   select id, monto, moneda, conciliado from public.gasto where id = '<GASTO>';
--   update public.movimiento_bancario set gasto_id = '<GASTO>' where id = '<MOV_1>'; -- 152.00  → OK (parcial)
--   update public.movimiento_bancario set gasto_id = '<GASTO>' where id = '<MOV_2>'; -- 125.79  → OK (cubre)
--   update public.movimiento_bancario set gasto_id = '<GASTO>' where id = '<MOV_3>'; -- 50.00   → ERROR 23514 GASTO_YA_CUBIERTO
--   -- moneda distinta: gasto USD + cargo MXN ligado ⇒ el segundo rebota
--   update public.movimiento_bancario set gasto_id = '<GASTO_USD>' where id = '<MOV_MXN_2>'; -- ERROR 23514
-- rollback;
--
-- Comprobación del índice (A):
--   explain analyze select * from public.gasto_bitacora
--     where diff->'vuelo_id'->>'antes' = '<VUELO>';   -- Index Scan
--
-- ---------------------------------------------------------------- ROLLBACK
-- (vuelve al modelo 1 ↔ 1; primero hay que dejar UN solo movimiento por
--  gasto o el índice único no se puede crear)
--
-- drop trigger if exists trg_mov_bancario_gasto_suma on public.movimiento_bancario;
-- drop function if exists public.tg_mov_bancario_gasto_suma();
-- drop index if exists public.idx_mov_bancario_gasto;
-- create unique index if not exists uq_mov_bancario_gasto
--   on public.movimiento_bancario (gasto_id) where gasto_id is not null;
-- drop index if exists public.idx_gasto_bitacora_movido_desde;
