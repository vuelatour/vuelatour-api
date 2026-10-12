-- 12-oct-2026 · CONCILIACIÓN 1 ABONO ↔ N COBROS («un pago para varios
-- vuelos») — PUENTE movimiento_bancario_cobro como FUENTE ÚNICA de la liga
-- abono ↔ cobro de vuelo. Invariante 56 del CLAUDE.md del API (0.0.71).
--
-- PEDIDO DEL CLIENTE (12-oct-2026): «al momento de vincular un cobro o
-- ingreso puedas seleccionar 2 para un solo cobro, porque por ejemplo
-- hicieron un pago para el vuelo 379 y 380». Hasta hoy un abono del banco
-- solo se ligaba a UN cobro (`movimiento_bancario.cobro_id`, índice único
-- `uq_mov_bancario_cobro`) y un depósito que paga dos vuelos se quedaba
-- pendiente para siempre (o se ligaba a uno solo y el otro cobro salía en
-- «Cobros sin banco»).
--
-- MISMO PATRÓN que 20261002000002 (1 cargo ↔ N gastos), más chico: aquí no
-- hay «gasto.conciliado» que recalcular (un cobro se concilia o no: la
-- fuente única `cobro-conciliado.util` decide leyendo las ligas) y no hay
-- pagos parciales (un cobro entra COMPLETO por su NETO).
--
-- QUÉ CREA / CAMBIA:
--   0) Aserciones previas (abortan): ninguna liga `cobro_id` en un
--      movimiento que no sea ABONO, con gasto/sobre/ingreso/clasificación,
--      emparejado por reverso o sin conciliar (hoy: 0 en todas).
--   1) public.movimiento_bancario_cobro (movimiento_id, cobro_id,
--      monto_parte, created_at, created_by), PK (movimiento_id, cobro_id),
--      ÍNDICE ÚNICO por cobro_id (un cobro se concilia UNA vez, la misma
--      regla de uq_mov_bancario_cobro), RLS sin políticas. Movimiento ON
--      DELETE CASCADE; cobro ON DELETE RESTRICT (un cobro con liga no se
--      borra: candado del API + BD, como hoy).
--   2) movimiento_bancario.cobros_n (espejo, default 0) y el CHECK de
--      ingresos gana `and cobros_n = 0`. `cobro_id` queda como ESPEJO
--      DERIVADO (= la parte cuando cobros_n = 1; NULL con 0 o ≥ 2): es lo que
--      leen el panel/app previos y el embed `cobro:cobro_vuelo!cobro_id(...)`.
--      El CHECK `movimiento_bancario_cobro_excluyente` (cobro_id ⊕
--      cobro_grupo_id) NO cambia.
--   3) BACKFILL: cada liga de hoy (cobro_id) ⇒ UNA parte por |monto| (el
--      abono completo: regla de hoy, sin cuadre de monto), created_at /
--      created_by = updated_at / updated_by del movimiento; cobros_n = 1.
--      updated_at NO se mueve (trigger apagado durante el backfill).
--   4) Triggers de la puente: A tg_mov_cobro_parte_valida (BEFORE ROW:
--      ABONO sin otras ligas ni reverso; cobro positivo, sin sobre, sin
--      anticipo y libre) y B tg_mov_cobro_parte_sync (AFTER STATEMENT con
--      tablas de transición: espejos cobros_n / cobro_id / conciliado /
--      clasificacion_id / updated_by del abono tocado; 3 triggers sobre la
--      misma función, uno por evento).
--   5) Triggers de movimiento_bancario: C tg_mov_bancario_cobro_id_sync
--      (espejo LEGADO: una escritura directa de cobro_id —API ≤ 0.0.70 o SQL
--      a mano— se traduce a la puente; con un lote ⇒ LOTE_SOLO_API_NUEVO;
--      `when (pg_trigger_depth() = 0)` como C de gastos), D
--      tg_mov_bancario_cobros_candados (BEFORE UPDATE OF tipo, monto,
--      cuenta_bancaria_id, gasto_id, gastos_n, cobro_grupo_id, ingreso_id,
--      reverso_de_id, conciliado: con cobros ligados no entra otra liga —
--      MOVIMIENTO_YA_LIGADO— y con un LOTE no cambian tipo/monto/cuenta ni
--      se desconcilia —ABONO_LIGADO—; con UNA parte el espejo cobro_id ya
--      lo custodian los CHECK y el trigger de reversos de siempre) y K
--      trg_mov_bancario_cobros_coherentes (CONSTRAINT TRIGGER DIFERIDO: al
--      commit, espejos = puente; si no, COBROS_INCOHERENTES).
--   6) RPC del API 0.0.71: G conciliacion_ligar_abono_cobros(movimiento,
--      cobro_ids[], actor) — UNA transacción: valida, escribe la puente como
--      DIFF (B recalcula los espejos) y devuelve {movimiento_id, partes,
--      salientes, anteriores}; H conciliacion_desligar_abono_cobros
--      (movimiento, actor) — borra las partes.
--      REGLAS de G: 1 cobro ⇒ parte = |monto| del abono (la regla de hoy:
--      sin cuadre, misma moneda NO exigida). N ≥ 2 ⇒ cada cobro en la MONEDA
--      DE LA CUENTA (LOTE_MONEDA_DISTINTA), parte = NETO del cobro (monto −
--      comisión bancaria capturada) y |Σ netos − |abono|| ≤
--      tolerancia_lote(N) = least(1.00, greatest(0.02, 0.01 × N))
--      (ABONO_NO_CUADRA con details). Errores 23514 con message «CODIGO: …»,
--      hint = CODIGO, detail = jsonb (misma convención que G de gastos).
--   7) Permisos: todo revoke a public/anon/authenticated y grant a
--      service_role (el API usa la service key). pg_notify reload schema.
--
-- DEPENDE de 20261002000002 (vt_actor_id(), tolerancia_lote(n), gastos_n) y
-- de 20260924000004 (ingreso_id) y 20260930000001 (reverso_de_id): las tres
-- están APLICADAS en prod (verificado 2-oct, 24-sep y 30-sep-2026).
--
-- `moneda` (cobro_vuelo, cuenta_bancaria) y `tipo` (movimiento_bancario)
-- son ENUM: en plpgsql se comparan SIEMPRE `::text` (incidente 15-sep-2026).
--
-- TOLERANCIA DEL API: sonda única `common/cobros-lote-disponible.util.ts`
-- (columna `movimiento_bancario.cobros_n`). Sin la migración: TODO como el
-- 0.0.70 (la liga de UN cobro por el camino directo; un lote responde 503
-- CONCILIACION_COBROS_NO_DISPONIBLE). El «sí» se memoriza: tras el ROLLBACK
-- hay que reiniciar el API.
--
-- ===========================================================================
-- DRY-RUN (correr ANTES de aplicar; UNA sentencia `do $dry$`, quitando el
-- prefijo «-- » de cada línea). Secciones: A contexto (sin la columna; un
-- abono PENDIENTE con dos cobros libres de la misma cuenta/moneda: si no
-- hay, se CREAN filas de prueba DRYRUN-20261012000002 que el rollback
-- borra), B cuerpo real (secciones 1–7 pegadas tal cual), C pruebas con
-- escrituras REALES: C1 estructura (tabla, PK, único por cobro, columna
-- cobros_n, CHECK de ingresos, 4+3 triggers, 2 RPC, permisos), C2 backfill
-- (cada cobro_id de hoy tiene su parte; cobros_n = 1; updated_at intacto),
-- C3 RPC G con DOS cobros que cuadran ⇒ cobros_n = 2, cobro_id NULL,
-- conciliado, partes = netos; C4 G con dos que NO cuadran ⇒ ABONO_NO_CUADRA
-- y nada escrito; C5 un cobro de OTRA moneda en un lote ⇒
-- LOTE_MONEDA_DISTINTA; C6 el mismo cobro en OTRO abono ⇒
-- COBRO_YA_CONCILIADO; C7 escritura LEGADA (update cobro_id directo sobre
-- un abono sin partes) ⇒ parte creada por C; sobre un LOTE ⇒
-- LOTE_SOLO_API_NUEVO; C8 D: ligar un gasto / sobre / ingreso / reverso a
-- un abono con lote ⇒ MOVIMIENTO_YA_LIGADO; cambiar el monto ⇒
-- ABONO_LIGADO; C9 H desliga: cobros_n = 0, cobro_id NULL, conciliado
-- false; C10 re-aplicar las secciones 1–2 = no-op (idempotente) ⇒ raise
-- exception 'DRYRUN_OK …' (todo se revierte). Cualquier otro error ⇒ NO
-- aplicar. Después: ninguna fila DRYRUN-20261012000002, la tabla y la
-- columna NO existen.
--
-- do $dry$
-- declare
--   v_mov uuid; v_cuenta uuid; v_moneda text; v_vuelo uuid;
--   v_c1 uuid; v_c2 uuid; v_c3 uuid; v_mov2 uuid;
--   v_n integer; v_txt text; v_j jsonb; v_upd timestamptz;
--   v_actor uuid;
-- begin
--   -- A) CONTEXTO
--   if exists (select 1 from information_schema.columns
--               where table_schema = 'public' and table_name = 'movimiento_bancario'
--                 and column_name = 'cobros_n') then
--     raise exception 'DRYRUN_FALLA A: cobros_n ya existe (migración aplicada)';
--   end if;
--   select u.id into v_actor from public.usuario u where u.rol = 'ADMIN' and u.estado = 'ACTIVO' limit 1;
--   select cb.id, cb.moneda::text into v_cuenta, v_moneda
--     from public.cuenta_bancaria cb where cb.tipo = 'BANCO' order by cb.created_at limit 1;
--   if v_cuenta is null then raise exception 'DRYRUN_FALLA A: sin cuenta BANCO'; end if;
--   select v.id into v_vuelo from public.vuelo v where v.estado <> 'CANCELADO' order by v.created_at desc limit 1;
--   if v_vuelo is null then raise exception 'DRYRUN_FALLA A: sin vuelo'; end if;
--   -- Dos cobros libres de prueba (netos 1,000.00 y 2,500.00) y un abono
--   -- PENDIENTE de 3,500.00 en esa cuenta/moneda.
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_vuelo, 1000, v_moneda::public.moneda, 'TRANSFERENCIA', now(), 'DRYRUN-20261012000002-1', v_actor)
--   returning id into v_c1;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_vuelo, 2500, v_moneda::public.moneda, 'TRANSFERENCIA', now(), 'DRYRUN-20261012000002-2', v_actor)
--   returning id into v_c2;
--   insert into public.cobro_vuelo (vuelo_id, monto, moneda, metodo_cobro, fecha_cobro, referencia, registrado_por)
--   values (v_vuelo, 100, (case when v_moneda = 'MXN' then 'USD' else 'MXN' end)::public.moneda, 'TRANSFERENCIA', now(), 'DRYRUN-20261012000002-3', v_actor)
--   returning id into v_c3;
--   insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, origen, created_by)
--   values (v_cuenta, current_date, 'ABONO', 3500, 'DRYRUN-20261012000002 pago de dos vuelos', 'DRYRUN', 'MANUAL', v_actor)
--   returning id into v_mov;
--   insert into public.movimiento_bancario (cuenta_bancaria_id, fecha, tipo, monto, descripcion, referencia, origen, created_by)
--   values (v_cuenta, current_date, 'ABONO', 1000, 'DRYRUN-20261012000002 otro abono', 'DRYRUN', 'MANUAL', v_actor)
--   returning id into v_mov2;
--   raise notice 'okA cuenta % moneda % abono % cobros %/%/%', v_cuenta, v_moneda, v_mov, v_c1, v_c2, v_c3;
--
--   -- B) CUERPO REAL: pegar aquí las secciones 1–7 del archivo (desde
--   --    «1) TABLA PUENTE» hasta el pg_notify), SIN los bloques de rollback.
--
--   -- C1) ESTRUCTURA
--   if to_regclass('public.movimiento_bancario_cobro') is null then raise exception 'DRYRUN_FALLA C1 tabla'; end if;
--   if not exists (select 1 from pg_indexes where schemaname = 'public' and indexname = 'uq_mov_cobro_parte_cobro') then
--     raise exception 'DRYRUN_FALLA C1 índice único por cobro';
--   end if;
--   select count(*) into v_n from pg_trigger t join pg_class c on c.oid = t.tgrelid
--    where c.relname in ('movimiento_bancario_cobro', 'movimiento_bancario')
--      and t.tgname in ('trg_mov_cobro_parte_valida', 'trg_mov_cobro_parte_sync_ins',
--                       'trg_mov_cobro_parte_sync_upd', 'trg_mov_cobro_parte_sync_del',
--                       'trg_mov_bancario_cobro_id_sync', 'trg_mov_bancario_cobros_candados',
--                       'trg_mov_bancario_cobros_coherentes');
--   if v_n <> 7 then raise exception 'DRYRUN_FALLA C1 triggers (%/7)', v_n; end if;
--   if to_regprocedure('public.conciliacion_ligar_abono_cobros(uuid, uuid[], uuid)') is null
--      or to_regprocedure('public.conciliacion_desligar_abono_cobros(uuid, uuid)') is null then
--     raise exception 'DRYRUN_FALLA C1 RPC';
--   end if;
--   if has_function_privilege('anon', 'public.conciliacion_ligar_abono_cobros(uuid,uuid[],uuid)', 'execute')
--      or has_function_privilege('authenticated', 'public.conciliacion_ligar_abono_cobros(uuid,uuid[],uuid)', 'execute') then
--     raise exception 'DRYRUN_FALLA C1 permisos';
--   end if;
--   raise notice 'okC1';
--
--   -- C2) BACKFILL: toda liga cobro_id de hoy tiene su parte y cobros_n = 1.
--   select count(*) into v_n from public.movimiento_bancario m
--    where m.cobro_id is not null
--      and (m.cobros_n <> 1 or not exists (select 1 from public.movimiento_bancario_cobro p
--                                            where p.movimiento_id = m.id and p.cobro_id = m.cobro_id));
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C2 backfill (% ligas sin parte)', v_n; end if;
--   select count(*) into v_n from public.movimiento_bancario_cobro p
--    where not exists (select 1 from public.movimiento_bancario m where m.id = p.movimiento_id and m.cobro_id = p.cobro_id);
--   if v_n <> 0 then raise exception 'DRYRUN_FALLA C2 partes sin espejo (%)', v_n; end if;
--   raise notice 'okC2';
--
--   -- C3) G con DOS cobros que cuadran: 1,000 + 2,500 = 3,500.
--   v_j := public.conciliacion_ligar_abono_cobros(v_mov, array[v_c1, v_c2], v_actor);
--   select m.cobros_n into v_n from public.movimiento_bancario m where m.id = v_mov;
--   if v_n <> 2 then raise exception 'DRYRUN_FALLA C3 cobros_n = % (esperado 2)', v_n; end if;
--   if exists (select 1 from public.movimiento_bancario m where m.id = v_mov and (m.cobro_id is not null or not m.conciliado)) then
--     raise exception 'DRYRUN_FALLA C3 espejo: cobro_id debe ser NULL y conciliado true';
--   end if;
--   if (select sum(p.monto_parte) from public.movimiento_bancario_cobro p where p.movimiento_id = v_mov) <> 3500 then
--     raise exception 'DRYRUN_FALLA C3 partes no suman 3,500';
--   end if;
--   if (select count(*) from public.movimiento_bancario_cobro p where p.movimiento_id = v_mov) <> 2 then
--     raise exception 'DRYRUN_FALLA C3 partes <> 2';
--   end if;
--   raise notice 'okC3 %', v_j;
--
--   -- C4) G que NO cuadra: 1,000 solo contra 3,500 con otro cobro de 100 en OTRA moneda ⇒ primero LOTE_MONEDA_DISTINTA (C5);
--   --     para C4 se usa un lote de la misma moneda que no cuadra: c1 + c1? no (repetido ⇒ LOTE_INVALIDO). Se crea un 4.º cobro.
--   begin
--     perform public.conciliacion_ligar_abono_cobros(v_mov2, array[v_c1, v_c2], v_actor);
--     raise exception 'DRYRUN_FALLA C4: debió rechazar (cobros ya ligados a otro abono)';
--   exception when check_violation then
--     if position('COBRO_YA_CONCILIADO' in sqlerrm) = 0 then raise exception 'DRYRUN_FALLA C4/C6 código: %', sqlerrm; end if;
--   end;
--   raise notice 'okC6 (cobro en otro abono ⇒ COBRO_YA_CONCILIADO)';
--   -- Desliga para probar el cuadre y la moneda con los mismos cobros.
--   perform public.conciliacion_desligar_abono_cobros(v_mov, v_actor);
--   begin
--     perform public.conciliacion_ligar_abono_cobros(v_mov2, array[v_c1, v_c2], v_actor);
--     raise exception 'DRYRUN_FALLA C4: debió rechazar (3,500 contra un abono de 1,000)';
--   exception when check_violation then
--     if position('ABONO_NO_CUADRA' in sqlerrm) = 0 then raise exception 'DRYRUN_FALLA C4 código: %', sqlerrm; end if;
--   end;
--   if exists (select 1 from public.movimiento_bancario_cobro p where p.movimiento_id = v_mov2) then
--     raise exception 'DRYRUN_FALLA C4: escribió partes pese al rechazo';
--   end if;
--   raise notice 'okC4';
--
--   -- C5) Otra moneda dentro de un lote.
--   begin
--     perform public.conciliacion_ligar_abono_cobros(v_mov, array[v_c1, v_c3], v_actor);
--     raise exception 'DRYRUN_FALLA C5: debió rechazar la moneda';
--   exception when check_violation then
--     if position('LOTE_MONEDA_DISTINTA' in sqlerrm) = 0 then raise exception 'DRYRUN_FALLA C5 código: %', sqlerrm; end if;
--   end;
--   raise notice 'okC5';
--
--   -- C7) Escritura LEGADA (API ≤ 0.0.70): update directo de cobro_id.
--   update public.movimiento_bancario set cobro_id = v_c1, conciliado = true, updated_by = v_actor where id = v_mov2;
--   if (select count(*) from public.movimiento_bancario_cobro p where p.movimiento_id = v_mov2 and p.cobro_id = v_c1) <> 1
--      or (select m.cobros_n from public.movimiento_bancario m where m.id = v_mov2) <> 1 then
--     raise exception 'DRYRUN_FALLA C7: el espejo legado no creó la parte';
--   end if;
--   update public.movimiento_bancario set cobro_id = null, conciliado = false, updated_by = v_actor where id = v_mov2;
--   if exists (select 1 from public.movimiento_bancario_cobro p where p.movimiento_id = v_mov2)
--      or (select m.cobros_n from public.movimiento_bancario m where m.id = v_mov2) <> 0 then
--     raise exception 'DRYRUN_FALLA C7: desligar por el espejo no borró la parte';
--   end if;
--   v_j := public.conciliacion_ligar_abono_cobros(v_mov, array[v_c1, v_c2], v_actor);
--   begin
--     update public.movimiento_bancario set cobro_id = v_c1 where id = v_mov;
--     raise exception 'DRYRUN_FALLA C7: un lote aceptó cobro_id directo';
--   exception when check_violation then
--     if position('LOTE_SOLO_API_NUEVO' in sqlerrm) = 0 then raise exception 'DRYRUN_FALLA C7 código: %', sqlerrm; end if;
--   end;
--   raise notice 'okC7';
--
--   -- C8) D: otras ligas sobre un lote y cambio de monto.
--   begin
--     update public.movimiento_bancario set monto = 3600 where id = v_mov;
--     raise exception 'DRYRUN_FALLA C8: cambió el monto de un abono con lote';
--   exception when check_violation then
--     if position('ABONO_LIGADO' in sqlerrm) = 0 then raise exception 'DRYRUN_FALLA C8 monto código: %', sqlerrm; end if;
--   end;
--   begin
--     update public.movimiento_bancario set clasificacion_id = (select id from public.conciliacion_clasificacion limit 1), ingreso_id = null where id = v_mov;
--     -- la clasificación no es liga de dinero: la quita B al siguiente cambio; aquí solo se prueba que ingreso/gasto rebotan
--   exception when others then null; end;
--   begin
--     update public.movimiento_bancario set gasto_id = (select id from public.gasto limit 1) where id = v_mov;
--     raise exception 'DRYRUN_FALLA C8: aceptó gasto_id en un abono con lote';
--   exception when check_violation then
--     if position('MOVIMIENTO_YA_LIGADO' in sqlerrm) = 0 and position('SOLO_CARGOS' in sqlerrm) = 0
--        and position('LOTE_INVALIDO' in sqlerrm) = 0 then raise exception 'DRYRUN_FALLA C8 gasto código: %', sqlerrm; end if;
--   end;
--   raise notice 'okC8';
--
--   -- C9) H desliga.
--   v_j := public.conciliacion_desligar_abono_cobros(v_mov, v_actor);
--   if exists (select 1 from public.movimiento_bancario m where m.id = v_mov and (m.cobros_n <> 0 or m.cobro_id is not null or m.conciliado)) then
--     raise exception 'DRYRUN_FALLA C9: el abono no quedó pendiente';
--   end if;
--   raise notice 'okC9 %', v_j;
--
--   -- C10) Re-aplicar 1–2 = no-op: pegar de nuevo SOLO las sentencias
--   --      «create table if not exists» y «add column if not exists» y
--   --      comprobar que no hay error. (Opcional.)
--
--   raise exception 'DRYRUN_OK · abono % · cobros %/% · C1–C9 · todo se revierte', v_mov, v_c1, v_c2;
-- end $dry$;
--
-- ===========================================================================

-- ===========================================================================
-- 0) ASERCIONES PREVIAS — hoy toda liga cobro_id vive en un ABONO
--    conciliado sin otras ligas. Si no, se aborta (no se adivina).
-- ===========================================================================
do $pre$
declare
  v_n integer;
begin
  if to_regclass('public.movimiento_bancario_gasto') is null then
    raise exception 'ABORTADO: falta la migración 20261002000002 (puente de gastos, vt_actor_id, tolerancia_lote)';
  end if;
  select count(*) into v_n
    from public.movimiento_bancario m
   where m.cobro_id is not null
     and (m.tipo::text <> 'ABONO'
          or m.gasto_id is not null or m.gastos_n > 0
          or m.cobro_grupo_id is not null
          or m.ingreso_id is not null
          or m.reverso_de_id is not null
          or m.conciliado = false);
  if v_n > 0 then
    raise exception 'ABORTADO: % liga(s) cobro_id en un movimiento que no es un ABONO conciliado sin otras ligas; revisar antes de migrar', v_n;
  end if;
  select count(*) into v_n
    from public.movimiento_bancario m
   where m.cobro_id is not null
     and not exists (select 1 from public.cobro_vuelo c where c.id = m.cobro_id);
  if v_n > 0 then
    raise exception 'ABORTADO: % liga(s) cobro_id apuntan a un cobro que no existe', v_n;
  end if;
end $pre$;

-- ===========================================================================
-- 1) TABLA PUENTE
-- ===========================================================================
create table if not exists public.movimiento_bancario_cobro (
  movimiento_id uuid not null references public.movimiento_bancario(id) on delete cascade,
  cobro_id uuid not null references public.cobro_vuelo(id) on delete restrict,
  monto_parte numeric(14,2) not null check (monto_parte > 0),
  created_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  primary key (movimiento_id, cobro_id)
);

comment on table public.movimiento_bancario_cobro is
  'FUENTE ÚNICA de la liga abono ↔ cobro de vuelo (20261012000002): un ABONO del banco paga 1..N cobros. monto_parte = NETO del cobro (monto − comisión) en un lote; con UNA parte vale el abono completo (regla de siempre). movimiento_bancario.cobro_id y cobros_n son ESPEJOS derivados (triggers B/C). Un cobro se concilia UNA vez (uq_mov_cobro_parte_cobro).';

-- Un cobro se concilia UNA sola vez (misma regla que uq_mov_bancario_cobro).
create unique index if not exists uq_mov_cobro_parte_cobro
  on public.movimiento_bancario_cobro (cobro_id);

alter table public.movimiento_bancario_cobro enable row level security;

-- ===========================================================================
-- 2) ESPEJO cobros_n + CHECK de ingresos
-- ===========================================================================
alter table public.movimiento_bancario
  add column if not exists cobros_n integer not null default 0
    check (cobros_n >= 0);

comment on column public.movimiento_bancario.cobros_n is
  'Cobros de vuelo que paga este ABONO (espejo de movimiento_bancario_cobro, 20261012000002). cobro_id = la única parte cuando cobros_n = 1; NULL con 0 o ≥ 2.';

-- Un abono conciliado con un INGRESO no puede además pagar cobros.
alter table public.movimiento_bancario
  drop constraint if exists movimiento_bancario_ingreso_excluyente_chk,
  add constraint movimiento_bancario_ingreso_excluyente_chk
    check (ingreso_id is null
           or (num_nonnulls(gasto_id, cobro_id, cobro_grupo_id, clasificacion_id) = 0
               and gastos_n = 0 and cobros_n = 0));

-- ===========================================================================
-- 3) BACKFILL — cada liga cobro_id de hoy pasa a ser UNA parte por |monto|.
--    Sin los triggers nuevos todavía (se crean después) y sin mover
--    updated_at: no es un cambio de negocio.
-- ===========================================================================
alter table public.movimiento_bancario disable trigger trg_movimiento_bancario_set_updated_at;

insert into public.movimiento_bancario_cobro (movimiento_id, cobro_id, monto_parte, created_at, created_by)
select m.id, m.cobro_id, abs(m.monto), coalesce(m.updated_at, m.created_at, now()), m.updated_by
  from public.movimiento_bancario m
 where m.cobro_id is not null
on conflict (movimiento_id, cobro_id) do nothing;

update public.movimiento_bancario m
   set cobros_n = 1
 where m.cobro_id is not null
   and m.cobros_n <> 1;

alter table public.movimiento_bancario enable trigger trg_movimiento_bancario_set_updated_at;

-- ===========================================================================
-- 4) TRIGGERS DE LA PUENTE
-- ===========================================================================

-- A) Candados por fila (BEFORE INSERT/UPDATE): el abono admite partes y el
--    cobro es ligable. La UNICIDAD por cobro la da el índice.
create or replace function public.tg_mov_cobro_parte_valida()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_parte_valida$
declare
  v_mov record;
  v_cobro record;
  v_otro uuid;
begin
  select m.id, m.tipo::text as tipo, m.gasto_id, m.gastos_n, m.cobro_grupo_id,
         m.ingreso_id, m.reverso_de_id
    into v_mov
    from public.movimiento_bancario m
   where m.id = new.movimiento_id;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: el movimiento %s no existe', new.movimiento_id),
      detail = jsonb_build_object('movimiento_id', new.movimiento_id)::text;
  end if;
  if v_mov.tipo <> 'ABONO' then
    raise exception using
      errcode = '23514',
      hint = 'SOLO_ABONOS',
      message = format('SOLO_ABONOS: solo un ABONO del banco se concilia con cobros de vuelo (este movimiento es un %s)', v_mov.tipo),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'tipo', v_mov.tipo)::text;
  end if;
  if v_mov.gasto_id is not null or coalesce(v_mov.gastos_n, 0) > 0
     or v_mov.cobro_grupo_id is not null or v_mov.ingreso_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_YA_LIGADO',
      message = 'MOVIMIENTO_YA_LIGADO: el abono ya está conciliado con un gasto, un sobre de grupo o un ingreso; desvincúlalo antes de ligarle cobros',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gasto_id', v_mov.gasto_id,
                                  'gastos_n', v_mov.gastos_n, 'cobro_grupo_id', v_mov.cobro_grupo_id,
                                  'ingreso_id', v_mov.ingreso_id)::text;
  end if;
  if v_mov.reverso_de_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'REVERSO_INVALIDO',
      message = 'REVERSO_INVALIDO: este abono es la devolución de un cargo: no se liga a cobros',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'reverso_de_id', v_mov.reverso_de_id)::text;
  end if;

  select c.id, c.monto, c.cobro_grupo_id, c.ingreso_anticipo_id
    into v_cobro
    from public.cobro_vuelo c
   where c.id = new.cobro_id;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_NO_EXISTE',
      message = format('COBRO_NO_EXISTE: el cobro %s no existe', new.cobro_id),
      detail = jsonb_build_object('cobro_id', new.cobro_id)::text;
  end if;
  if v_cobro.monto <= 0 then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_INVALIDO',
      message = format('COBRO_INVALIDO: el cobro %s es un reembolso (monto negativo): sale como CARGO en el banco, no como abono', new.cobro_id),
      detail = jsonb_build_object('cobro_id', new.cobro_id, 'monto', v_cobro.monto)::text;
  end if;
  if v_cobro.cobro_grupo_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_DE_GRUPO',
      message = format('COBRO_DE_GRUPO: el cobro %s es parte del sobre de un grupo: se concilia el sobre, no sus partes', new.cobro_id),
      detail = jsonb_build_object('cobro_id', new.cobro_id, 'cobro_grupo_id', v_cobro.cobro_grupo_id)::text;
  end if;
  if v_cobro.ingreso_anticipo_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_DE_ANTICIPO',
      message = format('COBRO_DE_ANTICIPO: el cobro %s salió de un anticipo: su dinero se concilia una vez, como anticipo', new.cobro_id),
      detail = jsonb_build_object('cobro_id', new.cobro_id, 'ingreso_anticipo_id', v_cobro.ingreso_anticipo_id)::text;
  end if;
  -- El espejo legado de OTRO movimiento (cobro_id directo) también ocupa.
  select m.id into v_otro
    from public.movimiento_bancario m
   where m.cobro_id = new.cobro_id
     and m.id <> new.movimiento_id
   limit 1;
  if v_otro is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_YA_CONCILIADO',
      message = format('COBRO_YA_CONCILIADO: el cobro %s ya está conciliado con el movimiento %s', new.cobro_id, v_otro),
      detail = jsonb_build_object('cobro_id', new.cobro_id, 'movimiento_id', v_otro)::text;
  end if;
  return new;
end $fn_parte_valida$;

comment on function public.tg_mov_cobro_parte_valida() is
  'Trigger A (BEFORE INSERT/UPDATE por fila en movimiento_bancario_cobro, 20261012000002): el movimiento es un ABONO sin gasto/sobre/ingreso ni reverso; el cobro existe, es positivo, no es parte de sobre ni de anticipo y no está ligado a otro movimiento. Errores 23514 con hint = CODIGO.';

drop trigger if exists trg_mov_cobro_parte_valida on public.movimiento_bancario_cobro;
create trigger trg_mov_cobro_parte_valida
  before insert or update on public.movimiento_bancario_cobro
  for each row execute function public.tg_mov_cobro_parte_valida();

-- B) Espejos del ABONO (AFTER STATEMENT, tablas de transición): UN update
--    por movimiento tocado. `updated_by` NUNCA se pisa con NULL.
create or replace function public.tg_mov_cobro_parte_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_parte_sync$
declare
  v_ctx uuid := public.vt_actor_id();
  v_filas jsonb := '[]'::jsonb;
begin
  if tg_op = 'INSERT' then
    select coalesce(jsonb_agg(jsonb_build_object('m', i.movimiento_id, 'por', i.created_by, 'lado', 'I')), '[]'::jsonb)
      into v_filas from ins i;
  elsif tg_op = 'DELETE' then
    select coalesce(jsonb_agg(jsonb_build_object('m', d.movimiento_id, 'por', d.created_by, 'lado', 'D')), '[]'::jsonb)
      into v_filas from del d;
  else
    select coalesce(jsonb_agg(t.fila), '[]'::jsonb)
      into v_filas
      from (
        select jsonb_build_object('m', i.movimiento_id, 'por', i.created_by, 'lado', 'I') as fila from ins i
        union all
        select jsonb_build_object('m', d.movimiento_id, 'por', d.created_by, 'lado', 'D') from del d
      ) t;
  end if;
  if jsonb_array_length(v_filas) = 0 then
    return null;
  end if;

  update public.movimiento_bancario mb
     set cobros_n = s.n,
         cobro_id = case when s.n = 1 then s.unico else null end,
         conciliado = (s.n > 0
                       or mb.gasto_id is not null
                       or coalesce(mb.gastos_n, 0) > 0
                       or mb.cobro_grupo_id is not null
                       or mb.ingreso_id is not null
                       or mb.clasificacion_id is not null
                       or mb.reverso_de_id is not null),
         clasificacion_id = case when s.n > 0 then null else mb.clasificacion_id end,
         updated_by = coalesce(s.actor, mb.updated_by)
    from (
      select x.m,
             coalesce(v_ctx,
                      (array_agg(x.por order by x.lado desc) filter (where x.por is not null))[1]) as actor,
             (select count(*)::integer from public.movimiento_bancario_cobro p where p.movimiento_id = x.m) as n,
             (select (array_agg(p.cobro_id))[1] from public.movimiento_bancario_cobro p where p.movimiento_id = x.m) as unico
        from jsonb_to_recordset(v_filas) as x(m uuid, por uuid, lado text)
       group by x.m
    ) s
   where mb.id = s.m;
  return null;
end $fn_parte_sync$;

comment on function public.tg_mov_cobro_parte_sync() is
  'Trigger B (AFTER INSERT/UPDATE/DELETE por SENTENCIA en movimiento_bancario_cobro, tablas de transición ins/del, 20261012000002): por cada abono tocado UN update de cobros_n, cobro_id (la única parte o NULL), conciliado, clasificacion_id (NULL con partes) y updated_by = coalesce(vt_actor_id() o created_by de la parte, updated_by).';

drop trigger if exists trg_mov_cobro_parte_sync_ins on public.movimiento_bancario_cobro;
create trigger trg_mov_cobro_parte_sync_ins
  after insert on public.movimiento_bancario_cobro
  referencing new table as ins
  for each statement execute function public.tg_mov_cobro_parte_sync();
drop trigger if exists trg_mov_cobro_parte_sync_upd on public.movimiento_bancario_cobro;
create trigger trg_mov_cobro_parte_sync_upd
  after update on public.movimiento_bancario_cobro
  referencing new table as ins old table as del
  for each statement execute function public.tg_mov_cobro_parte_sync();
drop trigger if exists trg_mov_cobro_parte_sync_del on public.movimiento_bancario_cobro;
create trigger trg_mov_cobro_parte_sync_del
  after delete on public.movimiento_bancario_cobro
  referencing old table as del
  for each statement execute function public.tg_mov_cobro_parte_sync();

-- ===========================================================================
-- 5) TRIGGERS DE movimiento_bancario
-- ===========================================================================

-- C) ESPEJO LEGADO: el API ≤ 0.0.70 (y cualquier SQL a mano) escribe
--    `movimiento_bancario.cobro_id` directo. Se traduce a la puente SOLO ante
--    una escritura DIRECTA (profundidad 0; las de B van a profundidad ≥ 1).
create or replace function public.tg_mov_bancario_cobro_id_sync()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_cobro_id_sync$
declare
  v_n integer;
  v_coincide boolean;
begin
  if pg_trigger_depth() > 1 then
    return null;
  end if;
  if tg_op = 'UPDATE' then
    if old.cobros_n >= 2 then
      raise exception using
        errcode = '23514',
        hint = 'LOTE_SOLO_API_NUEVO',
        message = format('LOTE_SOLO_API_NUEVO: este abono paga %s cobros; desligarlo o cambiarlo exige la conciliación actualizada', old.cobros_n),
        detail = jsonb_build_object('movimiento_id', new.id, 'cobros_n', old.cobros_n,
                                    'cobro_id_pedido', new.cobro_id)::text;
    end if;
    if new.cobro_id is not distinct from old.cobro_id then
      return null;
    end if;
  end if;
  select count(*)::integer, coalesce(bool_and(p.cobro_id = new.cobro_id), false)
    into v_n, v_coincide
    from public.movimiento_bancario_cobro p
   where p.movimiento_id = new.id;
  if (new.cobro_id is null and v_n = 0)
     or (new.cobro_id is not null and v_n = 1 and v_coincide) then
    return null;
  end if;
  perform set_config('vt.actor_id', coalesce(new.updated_by::text, ''), true);
  delete from public.movimiento_bancario_cobro where movimiento_id = new.id;
  if new.cobro_id is not null then
    insert into public.movimiento_bancario_cobro (movimiento_id, cobro_id, monto_parte, created_by)
    values (new.id, new.cobro_id, abs(new.monto), new.updated_by);
  end if;
  return null;
end $fn_cobro_id_sync$;

comment on function public.tg_mov_bancario_cobro_id_sync() is
  'Trigger C (AFTER INSERT/UPDATE OF cobro_id en movimiento_bancario, solo escritura DIRECTA, 20261012000002): traduce el espejo legado cobro_id a la puente (borra las partes y crea UNA por |monto| con created_by = updated_by). Lote (cobros_n ≥ 2) ⇒ LOTE_SOLO_API_NUEVO.';

drop trigger if exists trg_mov_bancario_cobro_id_sync on public.movimiento_bancario;
create trigger trg_mov_bancario_cobro_id_sync
  after insert or update of cobro_id on public.movimiento_bancario
  for each row
  when (pg_trigger_depth() = 0)
  execute function public.tg_mov_bancario_cobro_id_sync();

-- D) CANDADOS del abono con cobros ligados: no entra otra liga de dinero y
--    un LOTE no cambia tipo/monto/cuenta ni se desconcilia. Con UNA parte el
--    espejo cobro_id ya lo custodian los CHECK de siempre.
create or replace function public.tg_mov_bancario_cobros_candados()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn_candados$
begin
  if coalesce(old.cobros_n, 0) = 0 then
    return new;
  end if;
  if new.cobros_n = 0 and new.cobros_n is distinct from old.cobros_n then
    -- B acaba de vaciar las partes: ya no hay cobros que custodiar.
    return new;
  end if;
  if new.gasto_id is not null or coalesce(new.gastos_n, 0) > 0
     or new.cobro_grupo_id is not null or new.ingreso_id is not null
     or new.reverso_de_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_YA_LIGADO',
      message = format('MOVIMIENTO_YA_LIGADO: el abono ya paga %s cobro(s) de vuelo; desvincúlalos antes de ligarle un gasto, un sobre, un ingreso o una devolución', old.cobros_n),
      detail = jsonb_build_object('movimiento_id', new.id, 'cobros_n', old.cobros_n)::text;
  end if;
  if old.cobros_n >= 2 then
    if new.tipo::text is distinct from old.tipo::text
       or new.monto is distinct from old.monto
       or new.cuenta_bancaria_id is distinct from old.cuenta_bancaria_id then
      raise exception using
        errcode = '23514',
        hint = 'ABONO_LIGADO',
        message = format('ABONO_LIGADO: el abono paga %s cobros; no cambia de tipo, monto ni cuenta mientras los tenga ligados', old.cobros_n),
        detail = jsonb_build_object('movimiento_id', new.id, 'cobros_n', old.cobros_n)::text;
    end if;
    if new.conciliado = false then
      raise exception using
        errcode = '23514',
        hint = 'ABONO_LIGADO',
        message = format('ABONO_LIGADO: el abono paga %s cobros; para dejarlo pendiente desvincúlalos (conciliacion_desligar_abono_cobros)', old.cobros_n),
        detail = jsonb_build_object('movimiento_id', new.id, 'cobros_n', old.cobros_n)::text;
    end if;
  end if;
  return new;
end $fn_candados$;

comment on function public.tg_mov_bancario_cobros_candados() is
  'Trigger D (BEFORE UPDATE OF tipo, monto, cuenta_bancaria_id, gasto_id, gastos_n, cobro_grupo_id, ingreso_id, reverso_de_id, conciliado en movimiento_bancario, 20261012000002): con cobros ligados no entra gasto/sobre/ingreso/reverso (MOVIMIENTO_YA_LIGADO); con un LOTE (≥ 2) no cambian tipo/monto/cuenta ni se desconcilia (ABONO_LIGADO).';

drop trigger if exists trg_mov_bancario_cobros_candados on public.movimiento_bancario;
create trigger trg_mov_bancario_cobros_candados
  before update of tipo, monto, cuenta_bancaria_id, gasto_id, gastos_n,
    cobro_grupo_id, ingreso_id, reverso_de_id, conciliado
  on public.movimiento_bancario
  for each row execute function public.tg_mov_bancario_cobros_candados();

-- K) COHERENCIA (constraint trigger DIFERIDO): al commit, espejos = puente.
create or replace function public.motivo_cobros_incoherentes(p_movimiento_id uuid)
returns text
language plpgsql
stable
security definer
set search_path = ''
as $fn_motivo$
declare
  v record;
  v_n integer;
  v_unico uuid;
begin
  select m.cobros_n, m.cobro_id, m.conciliado, m.tipo::text as tipo,
         num_nonnulls(m.gasto_id, m.cobro_grupo_id, m.ingreso_id, m.reverso_de_id)
           + case when coalesce(m.gastos_n, 0) > 0 then 1 else 0 end as otras_ligas
    into v
    from public.movimiento_bancario m
   where m.id = p_movimiento_id;
  if not found then
    return null;
  end if;
  select count(*)::integer, (array_agg(p.cobro_id))[1]
    into v_n, v_unico
    from public.movimiento_bancario_cobro p
   where p.movimiento_id = p_movimiento_id;
  return case
    when v.cobros_n is distinct from v_n then
      format('cobros_n = %s pero tiene %s parte(s)', v.cobros_n, v_n)
    when v_n > 0 and v.tipo <> 'ABONO' then
      format('tiene cobros ligados y es un %s', v.tipo)
    when v_n > 0 and not v.conciliado then
      'tiene cobros ligados y no está conciliado'
    when v_n > 0 and v.otras_ligas > 0 then
      'tiene cobros ligados y además un gasto, un sobre, un ingreso o una devolución'
    when v_n = 1 and v.cobro_id is distinct from v_unico then
      'el espejo cobro_id no es su única parte'
    when v_n <> 1 and v.cobro_id is not null then
      format('cobro_id debe quedar vacío con %s parte(s)', v_n)
  end;
end $fn_motivo$;

comment on function public.motivo_cobros_incoherentes(uuid) is
  'NULL si los espejos del abono cuadran con la puente de cobros; si no, el motivo (20261012000002).';

create or replace function public.tg_mov_bancario_cobros_coherentes()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_coherentes$
declare
  v_motivo text;
begin
  v_motivo := public.motivo_cobros_incoherentes(new.id);
  if v_motivo is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBROS_INCOHERENTES',
      message = format('COBROS_INCOHERENTES: el abono %s quedó con sus cobros a medias (%s); liga o desliga sus cobros desde Conciliación, nunca a mano en la tabla', new.id, v_motivo),
      detail = jsonb_build_object('movimiento_id', new.id, 'motivo', v_motivo)::text;
  end if;
  return null;
end $fn_coherentes$;

drop trigger if exists trg_mov_bancario_cobros_coherentes on public.movimiento_bancario;
create constraint trigger trg_mov_bancario_cobros_coherentes
  after insert or update of cobros_n, conciliado, cobro_id, tipo,
    gasto_id, gastos_n, cobro_grupo_id, ingreso_id, reverso_de_id
  on public.movimiento_bancario
  deferrable initially deferred
  for each row execute function public.tg_mov_bancario_cobros_coherentes();

-- ===========================================================================
-- 6) RPC DEL API 0.0.71
-- ===========================================================================

-- G) Ligar un ABONO con 1..N cobros de vuelo, en UNA transacción.
create or replace function public.conciliacion_ligar_abono_cobros(
  p_movimiento_id uuid,
  p_cobro_ids uuid[],
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn_ligar$
declare
  v_mov record;
  v_moneda_cuenta text;
  v_monto_abono numeric;
  v_n integer;
  v_distintos integer;
  v_c record;
  v_otro uuid;
  v_neto numeric;
  v_suma numeric := 0;
  v_diferencia numeric;
  v_tolerancia numeric;
  v_cobros jsonb := '[]'::jsonb;
  v_nuevas jsonb := '[]'::jsonb;
  v_anteriores jsonb;
  v_salientes jsonb;
  v_partes jsonb;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);

  -- (1) El abono, BLOQUEADO: dos ligas del mismo abono se serializan.
  select m.id, m.tipo::text as tipo, m.monto, m.cuenta_bancaria_id,
         m.gasto_id, m.gastos_n, m.cobro_grupo_id, m.ingreso_id, m.reverso_de_id, m.cobros_n
    into v_mov
    from public.movimiento_bancario m
   where m.id = p_movimiento_id
     for update;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: el movimiento %s no existe', coalesce(p_movimiento_id::text, 'null')),
      detail = jsonb_build_object('movimiento_id', p_movimiento_id)::text;
  end if;
  if v_mov.tipo <> 'ABONO' then
    raise exception using
      errcode = '23514',
      hint = 'SOLO_ABONOS',
      message = format('SOLO_ABONOS: solo un ABONO del banco se concilia con cobros de vuelo (este movimiento es un %s)', v_mov.tipo),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'tipo', v_mov.tipo)::text;
  end if;
  if v_mov.gasto_id is not null or coalesce(v_mov.gastos_n, 0) > 0
     or v_mov.cobro_grupo_id is not null or v_mov.ingreso_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_YA_LIGADO',
      message = 'MOVIMIENTO_YA_LIGADO: el abono ya está conciliado con un gasto, un sobre de grupo o un ingreso; desvincúlalo antes de ligarle cobros',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'gasto_id', v_mov.gasto_id,
                                  'gastos_n', v_mov.gastos_n, 'cobro_grupo_id', v_mov.cobro_grupo_id,
                                  'ingreso_id', v_mov.ingreso_id)::text;
  end if;
  if v_mov.reverso_de_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'REVERSO_INVALIDO',
      message = 'REVERSO_INVALIDO: este abono es la devolución de un cargo: no se liga a cobros',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'reverso_de_id', v_mov.reverso_de_id)::text;
  end if;

  -- (2) La lista: ids presentes, sin nulos ni repetidos, ≤ 50.
  v_n := coalesce(array_length(p_cobro_ids, 1), 0);
  if v_n = 0 then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: manda al menos un cobro (para desvincular todos usa conciliacion_desligar_abono_cobros)',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'cobro_ids', '[]'::jsonb)::text;
  end if;
  if v_n > 50 then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: un abono paga a lo más 50 cobros (llegaron %s)', v_n),
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'n', v_n)::text;
  end if;
  if array_position(p_cobro_ids, null) is not null then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae un cobro vacío',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'cobro_ids', to_jsonb(p_cobro_ids))::text;
  end if;
  select count(distinct x) into v_distintos from unnest(p_cobro_ids) as x;
  if v_distintos <> v_n then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae el mismo cobro repetido',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'cobro_ids', to_jsonb(p_cobro_ids))::text;
  end if;

  -- (3) Lo que el abono paga HOY (para el diff y la respuesta).
  select coalesce(jsonb_agg(jsonb_build_object('cobro_id', p.cobro_id, 'monto_parte', p.monto_parte)
                            order by p.created_at, p.cobro_id), '[]'::jsonb)
    into v_anteriores
    from public.movimiento_bancario_cobro p
   where p.movimiento_id = p_movimiento_id;

  select cb.moneda::text into v_moneda_cuenta
    from public.cuenta_bancaria cb
   where cb.id = v_mov.cuenta_bancaria_id;
  v_monto_abono := round(abs(v_mov.monto), 2);

  -- (4) Cada cobro, BLOQUEADO y validado (A repite los candados por fila al
  --     escribir; aquí se responde con el detalle completo).
  for v_c in
    select c.id, c.monto, c.moneda::text as moneda, c.comision_banco_monto,
           c.cobro_grupo_id, c.ingreso_anticipo_id, c.vuelo_id,
           (select v.folio from public.vuelo v where v.id = c.vuelo_id) as folio,
           array_position(p_cobro_ids, c.id) as pos
      from public.cobro_vuelo c
     where c.id = any(p_cobro_ids)
     order by c.id
       for update of c
  loop
    if v_c.monto <= 0 then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_INVALIDO',
        message = format('COBRO_INVALIDO: el cobro del vuelo #%s es un reembolso (monto negativo): sale como CARGO en el banco', coalesce(v_c.folio::text, '?')),
        detail = jsonb_build_object('cobro_id', v_c.id, 'folio', v_c.folio, 'monto', v_c.monto)::text;
    end if;
    if v_c.cobro_grupo_id is not null then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_DE_GRUPO',
        message = format('COBRO_DE_GRUPO: el cobro del vuelo #%s es parte del sobre de un grupo: concilia el abono contra el sobre del grupo, no contra sus partes', coalesce(v_c.folio::text, '?')),
        detail = jsonb_build_object('cobro_id', v_c.id, 'cobro_grupo_id', v_c.cobro_grupo_id, 'folio', v_c.folio)::text;
    end if;
    if v_c.ingreso_anticipo_id is not null then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_DE_ANTICIPO',
        message = format('COBRO_DE_ANTICIPO: el cobro del vuelo #%s salió de un anticipo: su dinero se concilia una vez, como anticipo', coalesce(v_c.folio::text, '?')),
        detail = jsonb_build_object('cobro_id', v_c.id, 'ingreso_anticipo_id', v_c.ingreso_anticipo_id, 'folio', v_c.folio)::text;
    end if;
    -- Ocupado por OTRO movimiento (puente o espejo legado).
    select x.movimiento_id into v_otro
      from public.movimiento_bancario_cobro x
     where x.cobro_id = v_c.id and x.movimiento_id <> p_movimiento_id
     limit 1;
    if v_otro is null then
      select m.id into v_otro
        from public.movimiento_bancario m
       where m.cobro_id = v_c.id and m.id <> p_movimiento_id
       limit 1;
    end if;
    if v_otro is not null then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_YA_CONCILIADO',
        message = format('COBRO_YA_CONCILIADO: el cobro del vuelo #%s ya está conciliado con otro movimiento bancario', coalesce(v_c.folio::text, '?')),
        detail = jsonb_build_object('cobro_id', v_c.id, 'folio', v_c.folio, 'movimiento_id', v_otro)::text;
    end if;
    if v_n >= 2 and v_moneda_cuenta is not null and v_c.moneda <> v_moneda_cuenta then
      raise exception using
        errcode = '23514',
        hint = 'LOTE_MONEDA_DISTINTA',
        message = format('LOTE_MONEDA_DISTINTA: el cobro del vuelo #%s está en %s y la cuenta en %s: en un abono con varios cobros todos van en la moneda de la cuenta', coalesce(v_c.folio::text, '?'), v_c.moneda, v_moneda_cuenta),
        detail = jsonb_build_object('cobro_id', v_c.id, 'folio', v_c.folio, 'moneda_cobro', v_c.moneda, 'moneda_cuenta', v_moneda_cuenta)::text;
    end if;
    -- NETO = lo que depositó el banco (monto − comisión capturada).
    v_neto := round(v_c.monto - case when coalesce(v_c.comision_banco_monto, 0) > 0 then v_c.comision_banco_monto else 0 end, 2);
    if v_neto <= 0 then
      v_neto := round(v_c.monto, 2);
    end if;
    v_suma := v_suma + v_neto;
    v_cobros := v_cobros || jsonb_build_object('id', v_c.id, 'folio', v_c.folio, 'vuelo_id', v_c.vuelo_id,
                                               'monto', round(v_c.monto, 2), 'neto', v_neto, 'pos', v_c.pos);
    v_nuevas := v_nuevas || jsonb_build_object('cobro_id', v_c.id,
                                               'monto_parte', case when v_n = 1 then v_monto_abono else v_neto end);
  end loop;
  -- Un id que no existe no entra al bucle: se dice cuál.
  if jsonb_array_length(v_cobros) <> v_n then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_NO_EXISTE',
      message = 'COBRO_NO_EXISTE: alguno de los cobros ya no existe (lo borraron mientras conciliabas)',
      detail = jsonb_build_object('movimiento_id', v_mov.id, 'cobro_ids', to_jsonb(p_cobro_ids),
                                  'encontrados', jsonb_array_length(v_cobros))::text;
  end if;

  -- (5) Cuadre del LOTE: |Σ netos − |abono|| ≤ tolerancia_lote(N). Con UN
  --     cobro no se exige (regla de siempre: el operador decide).
  if v_n >= 2 then
    v_tolerancia := public.tolerancia_lote(v_n);
    v_diferencia := round(v_monto_abono - v_suma, 2);
    if abs(v_diferencia) > v_tolerancia + 0.000001 then
      raise exception using
        errcode = '23514',
        hint = 'ABONO_NO_CUADRA',
        message = format('ABONO_NO_CUADRA: los %s cobros suman %s y el abono es de %s (diferencia %s, tolerancia %s)',
                         v_n, round(v_suma, 2), v_monto_abono, v_diferencia, v_tolerancia),
        detail = jsonb_build_object('movimiento_id', v_mov.id,
                                    'monto_abono', v_monto_abono,
                                    'suma_cobros', round(v_suma, 2),
                                    'diferencia', v_diferencia,
                                    'tolerancia', v_tolerancia,
                                    'moneda', v_moneda_cuenta,
                                    'cobros', v_cobros)::text;
    end if;
  end if;

  -- (6) ESCRITURA como DIFF: salen los que ya no van, entran/cambian los
  --     demás (B recalcula los espejos del abono).
  with d as (
    delete from public.movimiento_bancario_cobro p
     where p.movimiento_id = p_movimiento_id
       and p.cobro_id <> all(p_cobro_ids)
    returning p.cobro_id, p.monto_parte, p.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('cobro_id', d.cobro_id, 'monto_parte', d.monto_parte)
                            order by d.created_at, d.cobro_id), '[]'::jsonb)
    into v_salientes
    from d;

  insert into public.movimiento_bancario_cobro as p (movimiento_id, cobro_id, monto_parte, created_by)
  select p_movimiento_id, x.cobro_id, x.monto_parte, p_actor
    from jsonb_to_recordset(v_nuevas) as x(cobro_id uuid, monto_parte numeric)
   order by x.cobro_id
  on conflict (movimiento_id, cobro_id) do update
     set monto_parte = excluded.monto_parte
   where p.monto_parte is distinct from excluded.monto_parte;

  select coalesce(jsonb_agg(jsonb_build_object('cobro_id', p.cobro_id, 'monto_parte', p.monto_parte)
                            order by array_position(p_cobro_ids, p.cobro_id)), '[]'::jsonb)
    into v_partes
    from public.movimiento_bancario_cobro p
   where p.movimiento_id = p_movimiento_id;

  return jsonb_build_object(
    'movimiento_id', p_movimiento_id,
    'partes', v_partes,
    'salientes', v_salientes,
    'anteriores', v_anteriores,
    'cobros', v_cobros
  );
end $fn_ligar$;

comment on function public.conciliacion_ligar_abono_cobros(uuid, uuid[], uuid) is
  'RPC G (API 0.0.71, 20261012000002): liga un ABONO con 1..N cobros de vuelo en UNA transacción. 1 cobro ⇒ parte = |monto| del abono (regla de hoy, sin cuadre). N ≥ 2 ⇒ misma moneda que la cuenta (LOTE_MONEDA_DISTINTA), parte = NETO de cada cobro y |Σ − |abono|| ≤ tolerancia_lote(N) (ABONO_NO_CUADRA). Otros 23514: SOLO_ABONOS, MOVIMIENTO_YA_LIGADO, REVERSO_INVALIDO, LOTE_INVALIDO, COBRO_NO_EXISTE, COBRO_INVALIDO, COBRO_DE_GRUPO, COBRO_DE_ANTICIPO, COBRO_YA_CONCILIADO. message «CODIGO: …», hint = CODIGO, detail = jsonb. Devuelve {movimiento_id, partes, salientes, anteriores, cobros}.';

-- H) Desligar TODOS los cobros de un abono (= `cobro_id: null` del API).
create or replace function public.conciliacion_desligar_abono_cobros(
  p_movimiento_id uuid,
  p_actor uuid
)
returns jsonb
language plpgsql
security definer
set search_path = ''
as $fn_desligar$
declare
  v_salientes jsonb;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);
  perform 1
     from public.movimiento_bancario m
    where m.id = p_movimiento_id
      for update;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: el movimiento %s no existe', coalesce(p_movimiento_id::text, 'null')),
      detail = jsonb_build_object('movimiento_id', p_movimiento_id)::text;
  end if;
  with d as (
    delete from public.movimiento_bancario_cobro p
     where p.movimiento_id = p_movimiento_id
    returning p.cobro_id, p.monto_parte, p.created_at
  )
  select coalesce(jsonb_agg(jsonb_build_object('cobro_id', d.cobro_id, 'monto_parte', d.monto_parte)
                            order by d.created_at, d.cobro_id), '[]'::jsonb)
    into v_salientes
    from d;
  return jsonb_build_object('movimiento_id', p_movimiento_id, 'salientes', v_salientes);
end $fn_desligar$;

comment on function public.conciliacion_desligar_abono_cobros(uuid, uuid) is
  'RPC H (API 0.0.71, 20261012000002): borra TODAS las partes del abono (B recalcula cobros_n, cobro_id y conciliado) y devuelve {movimiento_id, salientes:[{cobro_id, monto_parte}]}.';

-- ===========================================================================
-- 7) PERMISOS — nada se expone a anon/authenticated; el API usa la service
--    key. (Las funciones de trigger las invoca el motor.)
-- ===========================================================================
revoke all on table public.movimiento_bancario_cobro from public, anon, authenticated;
grant select, insert, update, delete on table public.movimiento_bancario_cobro to service_role;
revoke execute on function public.tg_mov_cobro_parte_valida() from public, anon, authenticated;
grant execute on function public.tg_mov_cobro_parte_valida() to service_role;
revoke execute on function public.tg_mov_cobro_parte_sync() from public, anon, authenticated;
grant execute on function public.tg_mov_cobro_parte_sync() to service_role;
revoke execute on function public.tg_mov_bancario_cobro_id_sync() from public, anon, authenticated;
grant execute on function public.tg_mov_bancario_cobro_id_sync() to service_role;
revoke execute on function public.tg_mov_bancario_cobros_candados() from public, anon, authenticated;
grant execute on function public.tg_mov_bancario_cobros_candados() to service_role;
revoke execute on function public.motivo_cobros_incoherentes(uuid) from public, anon, authenticated;
grant execute on function public.motivo_cobros_incoherentes(uuid) to service_role;
revoke execute on function public.tg_mov_bancario_cobros_coherentes() from public, anon, authenticated;
grant execute on function public.tg_mov_bancario_cobros_coherentes() to service_role;
revoke execute on function public.conciliacion_ligar_abono_cobros(uuid, uuid[], uuid) from public, anon, authenticated;
grant execute on function public.conciliacion_ligar_abono_cobros(uuid, uuid[], uuid) to service_role;
revoke execute on function public.conciliacion_desligar_abono_cobros(uuid, uuid) from public, anon, authenticated;
grant execute on function public.conciliacion_desligar_abono_cobros(uuid, uuid) to service_role;

-- Verificación final (aborta si algo no quedó).
do $ver$
declare
  v_n integer;
begin
  if to_regclass('public.movimiento_bancario_cobro') is null then
    raise exception 'VERIFICACIÓN: falta la tabla movimiento_bancario_cobro';
  end if;
  if not exists (select 1 from information_schema.columns
                  where table_schema = 'public' and table_name = 'movimiento_bancario'
                    and column_name = 'cobros_n') then
    raise exception 'VERIFICACIÓN: falta movimiento_bancario.cobros_n';
  end if;
  select count(*) into v_n
    from public.movimiento_bancario m
   where m.cobro_id is not null
     and (m.cobros_n <> 1 or not exists (select 1 from public.movimiento_bancario_cobro p
                                           where p.movimiento_id = m.id and p.cobro_id = m.cobro_id));
  if v_n > 0 then
    raise exception 'VERIFICACIÓN: % liga(s) cobro_id sin su parte en la puente', v_n;
  end if;
  select count(*) into v_n from public.movimiento_bancario m
   where public.motivo_cobros_incoherentes(m.id) is not null;
  if v_n > 0 then
    raise exception 'VERIFICACIÓN: % movimiento(s) con espejos de cobros incoherentes', v_n;
  end if;
end $ver$;

select pg_notify('pgrst', 'reload schema');

-- ===========================================================================
-- ROLLBACK (en UNA transacción; el API 0.0.71 sigue funcionando con el
-- camino directo tras REINICIARLO — la sonda memoriza el «sí»). Un lote
-- vivo (cobros_n ≥ 2) se pierde: el abono queda ligado SOLO al primer cobro
-- por el espejo; desligar esos lotes desde Conciliación ANTES.
--
--   begin;
--   drop trigger if exists trg_mov_bancario_cobros_coherentes on public.movimiento_bancario;
--   drop trigger if exists trg_mov_bancario_cobros_candados on public.movimiento_bancario;
--   drop trigger if exists trg_mov_bancario_cobro_id_sync on public.movimiento_bancario;
--   drop trigger if exists trg_mov_cobro_parte_sync_ins on public.movimiento_bancario_cobro;
--   drop trigger if exists trg_mov_cobro_parte_sync_upd on public.movimiento_bancario_cobro;
--   drop trigger if exists trg_mov_cobro_parte_sync_del on public.movimiento_bancario_cobro;
--   drop trigger if exists trg_mov_cobro_parte_valida on public.movimiento_bancario_cobro;
--   drop function if exists public.conciliacion_ligar_abono_cobros(uuid, uuid[], uuid);
--   drop function if exists public.conciliacion_desligar_abono_cobros(uuid, uuid);
--   drop function if exists public.tg_mov_bancario_cobros_coherentes();
--   drop function if exists public.motivo_cobros_incoherentes(uuid);
--   drop function if exists public.tg_mov_bancario_cobros_candados();
--   drop function if exists public.tg_mov_bancario_cobro_id_sync();
--   drop function if exists public.tg_mov_cobro_parte_sync();
--   drop function if exists public.tg_mov_cobro_parte_valida();
--   drop table if exists public.movimiento_bancario_cobro;
--   alter table public.movimiento_bancario
--     drop constraint if exists movimiento_bancario_ingreso_excluyente_chk,
--     add constraint movimiento_bancario_ingreso_excluyente_chk
--       check (ingreso_id is null
--              or (num_nonnulls(gasto_id, cobro_id, cobro_grupo_id, clasificacion_id) = 0
--                  and gastos_n = 0));
--   alter table public.movimiento_bancario drop column if exists cobros_n;
--   select pg_notify('pgrst', 'reload schema');
--   commit;
