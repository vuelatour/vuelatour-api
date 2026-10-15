-- 14-oct-2026 · CONCILIACIÓN: «OMITIR LA CONCILIACIÓN» y «VARIOS CARGOS →
-- UN GASTO» (API 0.0.77, invariantes 75 y 76 del CLAUDE.md del API).
--
-- PEDIDO (usuario, 14-oct-2026, captura de /admin/conciliacion):
--   «Necesitamos una opción de pendientes de conciliar venga una opción de
--   Omitir la conciliación.» y «necesitamos poder seleccionar varias filas de
--   conciliaciones pendientes para todo eso ponerlas a un solo gasto, si no
--   existe el gasto que permita crearlo por la cantidad de la suma».
--
-- QUÉ CREA (SOLO funciones nuevas + DOS triggers nuevos; ninguna tabla,
-- columna, CHECK, índice, vista ni función existente cambia, y NO siembra
-- datos: la clasificación canónica la crea la función 1 en la PRIMERA
-- omisión):
--   1) conciliacion_clasificacion_omitido(actor) → uuid: busca «Omitido de la
--      conciliación» sin distinguir mayúsculas, la crea si falta y la
--      REACTIVA si está de baja.
--   2) conciliacion_omitir_movimientos(ids[], linea, actor): 1..200
--      movimientos PENDIENTES y LIBRES ⇒ clasificación canónica + conciliado +
--      la línea «Omitido de la conciliación: …» ANTEPUESTA a sus notas. TODO O
--      NADA: uno que ya no está pendiente aborta el lote entero.
--   3) conciliacion_quitar_omision(ids[], actor): 1..200 OMITIDOS ⇒
--      pendientes otra vez; quita SOLO la primera línea canónica (el resto de
--      las notas queda byte a byte). TODO O NADA. Es el ÚNICO camino que le
--      quita la omisión a un movimiento (abre el paso del trigger 5 con
--      `vt.quitar_omision` local a su transacción) y no restaura un cargo al
--      que apunta una devolución (estado REVERSO).
--   4) conciliacion_ligar_cargos_a_gasto(gasto, ids[], actor): 2..50 CARGOS
--      pendientes y libres, de cuentas en la MONEDA del gasto, con un gasto
--      BANCARIO ⇒ UNA parte por cargo (|monto|) en la puente, en UNA
--      sentencia: el trigger A valida fila por fila, B recalcula espejos y
--      `recalcular_gasto_conciliado` el gasto (único escritor de
--      gasto.conciliado). Re-envío idéntico = no-op (idempotente).
--   5) tg_mov_bancario_omitido_sin_ligas() + trg_mov_bancario_omitido_sin_ligas
--      (BEFORE UPDATE OF gasto_id, gastos_n, cobro_id, cobros_n,
--      cobro_grupo_id, ingreso_id, reverso_de_id, clasificacion_id,
--      conciliado WHEN old.clasificacion_id is not null): un movimiento con la
--      clasificación canónica NO recibe ninguna liga por ningún camino (RPC G
--      de gastos, RPC de cobros —por su UPDATE de sincronía—, cobro_id
--      directo, sobre, ingreso, gasto_id legado, reverso) y —revisión del
--      14-oct-2026— tampoco PIERDE la omisión por fuera de la función 3
--      (el «desvincular» de linkCobro, una reclasificación o conciliado =
--      false) ⇒ 23514 MOVIMIENTO_OMITIDO. Una clasificación que NO es la
--      canónica se sigue pisando al ligar, como siempre. No modifica NEW.
--   5b) tg_mov_bancario_reverso_omitido() + trg_mov_bancario_reverso_omitido
--      (BEFORE INSERT OR UPDATE OF reverso_de_id WHEN new.reverso_de_id is
--      not null; revisión del 14-oct-2026): una devolución NO se empareja con
--      un CARGO omitido (el trigger 5 solo mira la fila que se actualiza, el
--      abono) ⇒ 23514 MOVIMIENTO_OMITIDO. Lee el cargo FOR SHARE y, por su
--      nombre, corre DESPUÉS de trg_mov_bancario_reverso (que ya lo bloqueó
--      FOR UPDATE).
--
-- SEGURIDAD (ajuste del 14-oct-2026): las 6 funciones son SECURITY INVOKER
-- con search_path vacío y este archivo NO toca permisos (ni quita ni otorga
-- EXECUTE), por eso se aplica completo por el MCP (`apply_migration`), sin
-- paso manual en el SQL Editor:
--   - el API las llama con la service key (rol service_role, BYPASSRLS): ve
--     y escribe todo, como en cualquier otra lectura o escritura suya;
--   - anon / authenticated conservan el EXECUTE por default de Supabase,
--     pero la función corre con SUS privilegios: RLS está habilitado SIN
--     políticas en movimiento_bancario, movimiento_bancario_gasto,
--     conciliacion_clasificacion, gasto y cuenta_bancaria (invariante 51), así
--     que no ven ninguna fila (MOVIMIENTO_NO_EXISTE) ni pueden insertar
--     (42501); además no tienen SELECT en v_gasto_conciliacion ni EXECUTE en
--     sus funciones auxiliares. El dry-run lo prueba con `set local role`
--     authenticated y anon (T28) y la sección 7 aborta si esa premisa no se
--     cumple al aplicar;
--   - las funciones de los triggers leen conciliacion_clasificacion (y la 5b
--     el cargo) con los privilegios de quien actualiza movimiento_bancario:
--     service_role (API) o el dueño de los triggers/RPC SECURITY DEFINER de
--     siempre (postgres): los dos saltan RLS;
--   - el advisor 0028/0029 solo marca SECURITY DEFINER: no hay WARN nuevos.
--
-- CONVENCIONES (las de 20261002000002): errores 23514 con message «CODIGO: …»,
-- hint = CODIGO, detail = jsonb::text. ENUMs (moneda, tipo, medio_pago)
-- SIEMPRE ::text (incidente del 15-sep-2026). Orden de candados: los
-- MOVIMIENTOS por id y DESPUÉS el gasto — el mismo orden global que la RPC G
-- (conciliacion_ligar_cargo_gastos) y el trigger A: dos operaciones que
-- comparten filas se serializan sin interbloqueo.
--
-- ESPEJOS EN EL API (los congela `omision-cargos.paridad.spec.ts`, que lee
-- ESTE archivo):
--   'Omitido de la conciliación'            = CLASIFICACION_OMITIDO (omision.util.ts)
--   'Omitido de la conciliación: '          = PREFIJO_LINEA_OMISION
--   500                                     = LINEA_OMISION_MAX
--   array['TARJETA_CORP','TRANSFERENCIA',…] = MEDIOS_BANCARIOS (gastos-candidatos.util.ts), MISMO orden
--   200 / 2..50                             = OMITIR_MAX / CARGOS_A_GASTO_MIN..MAX
--   1.00                                    = TOLERANCIA_CONCILIACION (por gasto)
--   las 9 columnas del trigger 5            = COLUMNAS_TRIGGER_OMITIDO
--
-- LO QUE NO CAMBIA: los triggers A/B/K de la puente, las RPC G y H, el
-- trigger del par (reverso), los de cobros, `recalcular_gasto_conciliado`, la
-- vista y todo número del dinero (los movimientos bancarios no entran al
-- Libro Dinero, al balance ni al reparto: invariante 33).
--
-- TOLERANCIA DEL API: sonda única `common/omision-cargos-disponible.util.ts`
-- (llama `conciliacion_omitir_movimientos` con la lista VACÍA y espera 23514
-- LOTE_INVALIDO; PGRST202 ⇒ no está). Sin esta migración: lo nuevo de
-- Conciliación responde 503 con code estable y TODO lo demás como hoy. La
-- migración puede ir antes o después del API 0.0.77: con un API viejo nadie
-- llama las RPC y, sin omitidos, el trigger nunca actúa.
--
-- DRY-RUN (correr ANTES de aplicar, por el MCP `execute_sql`): el bloque
-- `do $dry$ … $dry$` completo vive en el paquete del workspace
-- `docs/sql-20261014000002/01-dryrun-20261014000002.sql` (lo arma un script a
-- partir de las secciones 1–5 de ESTE archivo, entre las marcas «>>> CUERPO»
-- y «<<< CUERPO»). Orden (CLAUDE.md del workspace): A0 contexto → CUERPO →
-- verificación → FILAS DE PRUEBA (después del DDL: lección 55006 del
-- 12-oct-2026) → pruebas T1–T28 y T30–T31 con escrituras REALES → T29 `set
-- constraints all immediate` → raise exception 'DRYRUN_OK 20261014000002 …'.
-- Esperado: ERROR «DRYRUN_OK …» (ese error ES el éxito: nada persiste).
-- Cualquier otro ⇒ NO aplicar. Después, por SELECT: las 6 funciones y los 2
-- triggers NO existen,
-- 0 clasificaciones «Omitido de la conciliación» / «DRYRUN-20261014000002 …»,
-- 0 movimientos con referencia 'DRYRUN' y 0 gastos con notas 'DRYRUN%'.
--
-- APLICAR: `apply_migration` con este archivo COMPLETO (no lleva sentencias
-- que el MCP decline) ⇒ POSTCHECK con escrituras reales
-- (`docs/sql-20261014000002/02-postcheck-20261014000002.sql`, termina en
-- ERROR «POSTCHECK_OK …») ⇒ `get_advisors` (security y performance) sin WARN
-- nuevos.
--
-- REVERSA (SOLO por el SQL Editor y con confirmación del usuario): 1) deshacer
-- TODAS las omisiones (pestaña «Omitidos» o `conciliacion_quitar_omision` por
-- lotes de 200); 2) quitar los 2 triggers y las 6 funciones con el texto de
-- `docs/sql-20261014000002/03-reversa-20261014000002.sql` (vive fuera de este
-- archivo para que el MCP lo acepte entero); 3) quitar el renglón del
-- historial —aplicada por el MCP, su `version` es la marca de tiempo del
-- momento de aplicar: se busca por `name`—; 4) REINICIAR el API (la sonda
-- memoriza el «sí»). La fila canónica se deja inactiva (`activo = false`).

-- >>> CUERPO

-- ===========================================================================
-- 1) BUSCAR / CREAR / REACTIVAR LA CANÓNICA
-- ===========================================================================
create or replace function public.conciliacion_clasificacion_omitido(p_actor uuid)
returns uuid
language plpgsql
security invoker
set search_path = ''
as $fn_omitido$
declare
  v_id uuid;
begin
  select c.id into v_id
    from public.conciliacion_clasificacion c
   where lower(c.nombre) = lower('Omitido de la conciliación')
   limit 1;
  if v_id is null then
    insert into public.conciliacion_clasificacion (nombre, created_by)
    values ('Omitido de la conciliación', p_actor)
    on conflict ((lower(nombre))) do nothing
    returning id into v_id;
    if v_id is null then
      -- Carrera con otra transacción que la creó: se toma la ganadora.
      select c.id into v_id
        from public.conciliacion_clasificacion c
       where lower(c.nombre) = lower('Omitido de la conciliación')
       limit 1;
    end if;
  end if;
  -- La tabla no tiene trigger de updated_at: se mueve a mano.
  update public.conciliacion_clasificacion
     set activo = true, updated_at = now()
   where id = v_id and activo = false;
  return v_id;
end $fn_omitido$;

comment on function public.conciliacion_clasificacion_omitido(uuid) is
  'Id de la clasificación canónica «Omitido de la conciliación» (20261014000002, SECURITY INVOKER): la busca sin distinguir mayúsculas, la crea si falta y la reactiva si está de baja.';

-- ===========================================================================
-- 2) OMITIR 1..200 MOVIMIENTOS (todo o nada)
-- ===========================================================================
create or replace function public.conciliacion_omitir_movimientos(
  p_movimiento_ids uuid[],
  p_linea text,
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn_omitir$
declare
  v_n integer := coalesce(array_length(p_movimiento_ids, 1), 0);
  v_distintos integer;
  v_clasif uuid;
  v_faltan jsonb;
  v_ocupados jsonb;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);

  -- (1) La lista: 1..200, sin nulos ni repetidos.
  if v_n < 1 or v_n > 200 or array_position(p_movimiento_ids, null) is not null then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: manda de 1 a 200 movimientos sin vacíos (llegaron %s)', v_n),
      detail = jsonb_build_object('n', v_n)::text;
  end if;
  select count(distinct x) into v_distintos from unnest(p_movimiento_ids) as x;
  if v_distintos <> v_n then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae el mismo movimiento repetido',
      detail = jsonb_build_object('n', v_n, 'distintos', v_distintos)::text;
  end if;

  -- (2) La línea la arma el API (motivo, quién, día Cancún): aquí solo se
  --     exige la forma canónica, UNA línea y ≤ 500 caracteres.
  if p_linea is null
     or not starts_with(p_linea, 'Omitido de la conciliación: ')
     or position(chr(10) in p_linea) > 0
     or position(chr(13) in p_linea) > 0
     or char_length(p_linea) > 500 then
    raise exception using
      errcode = '23514',
      hint = 'OMISION_INVALIDA',
      message = 'OMISION_INVALIDA: la línea de la omisión no tiene la forma canónica',
      detail = jsonb_build_object('largo', char_length(coalesce(p_linea, '')))::text;
  end if;

  -- (3) Movimientos BLOQUEADOS en orden estable de id.
  perform 1
     from public.movimiento_bancario m
    where m.id = any(p_movimiento_ids)
    order by m.id
      for update;
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
    into v_faltan
    from unnest(p_movimiento_ids) as x
   where not exists (select 1 from public.movimiento_bancario m where m.id = x);
  if jsonb_array_length(v_faltan) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_NO_EXISTE',
      message = format('MOVIMIENTO_NO_EXISTE: %s movimiento(s) ya no existen', jsonb_array_length(v_faltan)),
      detail = jsonb_build_object('ids', v_faltan)::text;
  end if;

  v_clasif := public.conciliacion_clasificacion_omitido(p_actor);

  -- (4) TODO O NADA: cada uno PENDIENTE y LIBRE (sin gasto, cobro, sobre,
  --     ingreso, clasificación ni par de devolución). El estado es el espejo
  --     de `estadoMovimientoParaOmitir` (omision.util.ts).
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'fecha', m.fecha,
           'tipo', m.tipo::text,
           'monto', m.monto,
           'descripcion', left(coalesce(m.descripcion, ''), 80),
           'estado', case
             when m.gastos_n > 0 or m.gasto_id is not null then 'CON_GASTO'
             when m.cobros_n > 0 or m.cobro_id is not null then 'CON_COBRO'
             when m.cobro_grupo_id is not null then 'CON_SOBRE'
             when m.ingreso_id is not null then 'CON_INGRESO'
             when m.reverso_de_id is not null
                  or exists (select 1 from public.movimiento_bancario r
                              where r.reverso_de_id = m.id) then 'REVERSO'
             when m.clasificacion_id = v_clasif then 'OMITIDO'
             when m.clasificacion_id is not null then 'CLASIFICADO'
             else 'CONCILIADO'
           end) order by m.fecha, m.id), '[]'::jsonb)
    into v_ocupados
    from public.movimiento_bancario m
   where m.id = any(p_movimiento_ids)
     and (m.conciliado
          or m.gastos_n > 0
          or m.cobros_n > 0
          or num_nonnulls(m.gasto_id, m.cobro_id, m.cobro_grupo_id, m.ingreso_id,
                          m.clasificacion_id, m.reverso_de_id) > 0
          or exists (select 1 from public.movimiento_bancario r
                      where r.reverso_de_id = m.id));
  if jsonb_array_length(v_ocupados) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_NO_PENDIENTE',
      message = format('MOVIMIENTO_NO_PENDIENTE: %s de %s movimientos ya no están pendientes; no se omitió ninguno',
                       jsonb_array_length(v_ocupados), v_n),
      detail = jsonb_build_object('movimientos', v_ocupados)::text;
  end if;

  -- (5) UNA sentencia. Ninguna de sus columnas despierta el trigger del par
  --     (reverso) ni el de la sección 5; el de cobros solo actúa con
  --     cobros_n > 0; los constraint triggers diferidos (partes y cobros
  --     coherentes) juzgan al commit: 0 partes ⇒ coherente. Notas: la línea
  --     va ARRIBA; lo que había queda debajo, byte a byte (también solo
  --     espacios).
  update public.movimiento_bancario m
     set clasificacion_id = v_clasif,
         conciliado = true,
         notas = case when m.notas is null or m.notas = '' then p_linea
                      else p_linea || chr(10) || m.notas end,
         updated_by = coalesce(p_actor, m.updated_by)
   where m.id = any(p_movimiento_ids);

  return jsonb_build_object(
    'omitidos', v_n,
    'clasificacion_id', v_clasif,
    'movimiento_ids', to_jsonb(p_movimiento_ids)
  );
end $fn_omitir$;

comment on function public.conciliacion_omitir_movimientos(uuid[], text, uuid) is
  'RPC (API 0.0.77, 20261014000002, SECURITY INVOKER): omite 1..200 movimientos PENDIENTES y LIBRES en UNA transacción (todo o nada): clasificación canónica «Omitido de la conciliación», conciliado = true y la línea canónica antepuesta a las notas. 23514 LOTE_INVALIDO | OMISION_INVALIDA | MOVIMIENTO_NO_EXISTE {ids} | MOVIMIENTO_NO_PENDIENTE {movimientos[{id, fecha, tipo, monto, descripcion, estado}]}.';

-- ===========================================================================
-- 3) DESHACER LA OMISIÓN DE 1..200 MOVIMIENTOS (todo o nada)
-- ===========================================================================
create or replace function public.conciliacion_quitar_omision(
  p_movimiento_ids uuid[],
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn_quitar$
declare
  v_n integer := coalesce(array_length(p_movimiento_ids, 1), 0);
  v_distintos integer;
  v_clasif uuid;
  v_faltan jsonb;
  v_otros jsonb;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);

  if v_n < 1 or v_n > 200 or array_position(p_movimiento_ids, null) is not null then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: manda de 1 a 200 movimientos sin vacíos (llegaron %s)', v_n),
      detail = jsonb_build_object('n', v_n)::text;
  end if;
  select count(distinct x) into v_distintos from unnest(p_movimiento_ids) as x;
  if v_distintos <> v_n then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae el mismo movimiento repetido',
      detail = jsonb_build_object('n', v_n, 'distintos', v_distintos)::text;
  end if;

  perform 1
     from public.movimiento_bancario m
    where m.id = any(p_movimiento_ids)
    order by m.id
      for update;
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
    into v_faltan
    from unnest(p_movimiento_ids) as x
   where not exists (select 1 from public.movimiento_bancario m where m.id = x);
  if jsonb_array_length(v_faltan) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_NO_EXISTE',
      message = format('MOVIMIENTO_NO_EXISTE: %s movimiento(s) ya no existen', jsonb_array_length(v_faltan)),
      detail = jsonb_build_object('ids', v_faltan)::text;
  end if;

  select c.id into v_clasif
    from public.conciliacion_clasificacion c
   where lower(c.nombre) = lower('Omitido de la conciliación')
   limit 1;

  -- Un omitido al que APUNTA una devolución (revisión del 14-oct-2026: el
  -- trigger 5b lo impide; esto cuida lo que llegara por otra vía) no se
  -- restaura: quedaría un par a medias. Sale con estado REVERSO.
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'fecha', m.fecha,
           'tipo', m.tipo::text,
           'monto', m.monto,
           'descripcion', left(coalesce(m.descripcion, ''), 80),
           'estado', case
             when m.clasificacion_id = v_clasif
                  and exists (select 1 from public.movimiento_bancario r
                               where r.reverso_de_id = m.id) then 'REVERSO'
             when not m.conciliado then 'PENDIENTE'
             when m.clasificacion_id is not null then 'CLASIFICADO'
             else 'CONCILIADO'
           end) order by m.fecha, m.id), '[]'::jsonb)
    into v_otros
    from public.movimiento_bancario m
   where m.id = any(p_movimiento_ids)
     and (v_clasif is null
          or m.clasificacion_id is distinct from v_clasif
          or exists (select 1 from public.movimiento_bancario r
                      where r.reverso_de_id = m.id));
  if jsonb_array_length(v_otros) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_NO_OMITIDO',
      message = format('MOVIMIENTO_NO_OMITIDO: %s de %s movimientos ya no están omitidos; no se restauró ninguno',
                       jsonb_array_length(v_otros), v_n),
      detail = jsonb_build_object('movimientos', v_otros)::text;
  end if;

  -- Un omitido nunca tiene ligas (todos los caminos de liga lo rechazan);
  -- si alguna apareciera, conciliado = false con partes revienta al commit
  -- (PARTES_INCOHERENTES / COBROS_INCOHERENTES) y no se escribe nada.
  -- Notas: espejo EXACTO de `quitarLineaOmision` (omision.util.ts).
  -- El trigger 5 SOLO deja quitar la omisión con este paso, local a la
  -- transacción y cerrado en cuanto termina el UPDATE.
  perform set_config('vt.quitar_omision', '1', true);
  update public.movimiento_bancario m
     set clasificacion_id = null,
         conciliado = false,
         notas = case
           when m.notas is null
                or not starts_with(m.notas, 'Omitido de la conciliación: ') then m.notas
           when position(chr(10) in m.notas) = 0 then null
           else nullif(substr(m.notas, position(chr(10) in m.notas) + 1), '')
         end,
         updated_by = coalesce(p_actor, m.updated_by)
   where m.id = any(p_movimiento_ids);
  perform set_config('vt.quitar_omision', '', true);

  return jsonb_build_object(
    'restaurados', v_n,
    'movimiento_ids', to_jsonb(p_movimiento_ids)
  );
end $fn_quitar$;

comment on function public.conciliacion_quitar_omision(uuid[], uuid) is
  'RPC (API 0.0.77, 20261014000002, SECURITY INVOKER): deshace la omisión de 1..200 movimientos en UNA transacción (todo o nada): sin clasificación, conciliado = false y sin la PRIMERA línea canónica de sus notas (el resto queda byte a byte). ÚNICO camino que le quita la omisión a un movimiento (paso `vt.quitar_omision` del trigger trg_mov_bancario_omitido_sin_ligas). 23514 LOTE_INVALIDO | MOVIMIENTO_NO_EXISTE {ids} | MOVIMIENTO_NO_OMITIDO {movimientos[] con estado PENDIENTE | CLASIFICADO | CONCILIADO | REVERSO}.';

-- ===========================================================================
-- 4) 2..50 CARGOS → UN GASTO (todo o nada)
-- ===========================================================================
create or replace function public.conciliacion_ligar_cargos_a_gasto(
  p_gasto_id uuid,
  p_movimiento_ids uuid[],
  p_actor uuid
)
returns jsonb
language plpgsql
security invoker
set search_path = ''
as $fn_cargos$
declare
  v_n integer := coalesce(array_length(p_movimiento_ids, 1), 0);
  v_distintos integer;
  v_faltan jsonb;
  v_no_cargos jsonb;
  v_ya uuid[];
  v_nuevos uuid[];
  v_ocupados jsonb;
  v_monedas text[];
  v_moneda text;
  v_g record;
  v_cruzadas integer;
  v_vinculado numeric;
  v_suma numeric;
  v_e record;
  v_partes jsonb;
begin
  perform set_config('vt.actor_id', coalesce(p_actor::text, ''), true);

  -- (1) La lista: 2..50, sin nulos ni repetidos (con UN cargo: la RPC G de
  --     siempre, que además admite el 1↔1 de otra moneda).
  if v_n < 2 or v_n > 50 or array_position(p_movimiento_ids, null) is not null then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = format('LOTE_INVALIDO: manda de 2 a 50 cargos sin vacíos (llegaron %s)', v_n),
      detail = jsonb_build_object('n', v_n, 'gasto_id', p_gasto_id)::text;
  end if;
  select count(distinct x) into v_distintos from unnest(p_movimiento_ids) as x;
  if v_distintos <> v_n then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_INVALIDO',
      message = 'LOTE_INVALIDO: la lista trae el mismo cargo repetido',
      detail = jsonb_build_object('n', v_n, 'distintos', v_distintos)::text;
  end if;

  -- (2) Cargos BLOQUEADOS en orden de id (ANTES que el gasto).
  perform 1
     from public.movimiento_bancario m
    where m.id = any(p_movimiento_ids)
    order by m.id
      for update;
  select coalesce(jsonb_agg(x order by x), '[]'::jsonb)
    into v_faltan
    from unnest(p_movimiento_ids) as x
   where not exists (select 1 from public.movimiento_bancario m where m.id = x);
  if jsonb_array_length(v_faltan) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_NO_EXISTE',
      message = format('MOVIMIENTO_NO_EXISTE: %s cargo(s) ya no existen', jsonb_array_length(v_faltan)),
      detail = jsonb_build_object('ids', v_faltan)::text;
  end if;

  -- (3) Solo CARGOS.
  select coalesce(jsonb_agg(jsonb_build_object('id', m.id, 'fecha', m.fecha, 'monto', m.monto,
                                               'descripcion', left(coalesce(m.descripcion, ''), 80))
                            order by m.fecha, m.id), '[]'::jsonb)
    into v_no_cargos
    from public.movimiento_bancario m
   where m.id = any(p_movimiento_ids)
     and m.tipo::text <> 'CARGO';
  if jsonb_array_length(v_no_cargos) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'SOLO_CARGOS',
      message = format('SOLO_CARGOS: %s de los movimientos son abonos; un gasto solo se paga con cargos', jsonb_array_length(v_no_cargos)),
      detail = jsonb_build_object('abonos', v_no_cargos)::text;
  end if;

  -- (4) Ya ligados a ESTE gasto como su única parte: re-envío (idempotente).
  select coalesce(array_agg(m.id order by m.id), '{}'::uuid[])
    into v_ya
    from public.movimiento_bancario m
   where m.id = any(p_movimiento_ids)
     and m.gastos_n = 1
     and m.gasto_id = p_gasto_id;
  v_nuevos := array(select x from unnest(p_movimiento_ids) as x
                     where not (x = any(v_ya)) order by x);

  -- (5) Los demás: PENDIENTES y LIBRES (todo o nada).
  select coalesce(jsonb_agg(jsonb_build_object(
           'id', m.id,
           'fecha', m.fecha,
           'tipo', m.tipo::text,
           'monto', m.monto,
           'descripcion', left(coalesce(m.descripcion, ''), 80),
           'estado', case
             when m.gastos_n > 0 or m.gasto_id is not null then 'CON_GASTO'
             when m.cobros_n > 0 or m.cobro_id is not null then 'CON_COBRO'
             when m.cobro_grupo_id is not null then 'CON_SOBRE'
             when m.ingreso_id is not null then 'CON_INGRESO'
             when m.reverso_de_id is not null
                  or exists (select 1 from public.movimiento_bancario r
                              where r.reverso_de_id = m.id) then 'REVERSO'
             when m.clasificacion_id is not null
                  and exists (select 1 from public.conciliacion_clasificacion c
                               where c.id = m.clasificacion_id
                                 and lower(c.nombre) = lower('Omitido de la conciliación')) then 'OMITIDO'
             when m.clasificacion_id is not null then 'CLASIFICADO'
             else 'CONCILIADO'
           end) order by m.fecha, m.id), '[]'::jsonb)
    into v_ocupados
    from public.movimiento_bancario m
   where m.id = any(v_nuevos)
     and (m.conciliado
          or m.gastos_n > 0
          or m.cobros_n > 0
          or num_nonnulls(m.gasto_id, m.cobro_id, m.cobro_grupo_id, m.ingreso_id,
                          m.clasificacion_id, m.reverso_de_id) > 0
          or exists (select 1 from public.movimiento_bancario r
                      where r.reverso_de_id = m.id));
  if jsonb_array_length(v_ocupados) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_NO_PENDIENTE',
      message = format('MOVIMIENTO_NO_PENDIENTE: %s de %s cargos ya no están pendientes; no se vinculó ninguno',
                       jsonb_array_length(v_ocupados), v_n),
      detail = jsonb_build_object('gasto_id', p_gasto_id, 'movimientos', v_ocupados)::text;
  end if;

  -- (6) Una sola moneda de cuenta para todos los cargos.
  select array_agg(distinct c.moneda::text order by c.moneda::text)
    into v_monedas
    from public.movimiento_bancario m
    join public.cuenta_bancaria c on c.id = m.cuenta_bancaria_id
   where m.id = any(p_movimiento_ids);
  if coalesce(array_length(v_monedas, 1), 0) <> 1 then
    raise exception using
      errcode = '23514',
      hint = 'CARGOS_MONEDA_DISTINTA',
      message = format('CARGOS_MONEDA_DISTINTA: los cargos son de cuentas en %s', array_to_string(v_monedas, ' y ')),
      detail = jsonb_build_object('monedas', to_jsonb(v_monedas))::text;
  end if;
  v_moneda := v_monedas[1];

  -- (7) El gasto, BLOQUEADO (después de los cargos).
  select g.id, round(abs(g.monto), 2) as monto, g.moneda::text as moneda,
         g.medio_pago::text as medio_pago
    into v_g
    from public.gasto g
   where g.id = p_gasto_id
     for update;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'GASTO_NO_EXISTE',
      message = 'GASTO_NO_EXISTE: el gasto ya no existe',
      detail = jsonb_build_object('gasto_id', p_gasto_id)::text;
  end if;
  if v_g.moneda <> v_moneda then
    raise exception using
      errcode = '23514',
      hint = 'LOTE_MONEDA_DISTINTA',
      message = format('LOTE_MONEDA_DISTINTA: el gasto %s está en %s y los cargos en %s', p_gasto_id, v_g.moneda, v_moneda),
      detail = jsonb_build_object('gasto_id', p_gasto_id, 'moneda_gasto', v_g.moneda,
                                  'moneda_cuenta', v_moneda)::text;
  end if;
  -- Espejo de MEDIOS_BANCARIOS (gastos-candidatos.util.ts; spec de paridad).
  -- Un gasto en efectivo o PERSONAL_* se liga cargo por cargo con su
  -- justificación (invariante 48); BODEGA nunca.
  if not (v_g.medio_pago = any (array['TARJETA_CORP', 'TRANSFERENCIA', 'PAYWISE', 'DOMICILIADO'])) then
    raise exception using
      errcode = '23514',
      hint = 'GASTO_NO_BANCARIO',
      message = format('GASTO_NO_BANCARIO: el gasto %s se pagó con %s, que no pasa por el banco', p_gasto_id, v_g.medio_pago),
      detail = jsonb_build_object('gasto_id', p_gasto_id, 'medio_pago', v_g.medio_pago)::text;
  end if;

  -- (8) Lo que el gasto YA tiene de otros cargos. Una parte CRUZADA (1↔1 de
  --     otra moneda) lo deja cubierto y cerrado.
  select count(*) filter (where p.moneda::text <> v_g.moneda)::integer,
         round(coalesce(sum(p.monto_parte) filter (where p.moneda::text = v_g.moneda), 0), 2)
    into v_cruzadas, v_vinculado
    from public.movimiento_bancario_gasto p
   where p.gasto_id = p_gasto_id
     and not (p.movimiento_id = any(v_nuevos));
  if v_cruzadas > 0 then
    raise exception using
      errcode = '23514',
      hint = 'GASTO_YA_CUBIERTO',
      message = format('GASTO_YA_CUBIERTO: el gasto %s ya está conciliado 1 a 1 con un cargo de otra moneda', p_gasto_id),
      detail = jsonb_build_object('motivo', 'MONEDA_DISTINTA', 'gasto_id', p_gasto_id,
                                  'moneda', v_g.moneda, 'monto_gasto', v_g.monto)::text;
  end if;

  -- (9) Re-envío idéntico: nada que escribir (la respuesta trae las mismas
  --     llaves que la escritura, `partes` incluidas).
  if coalesce(array_length(v_nuevos, 1), 0) = 0 then
    select v.n_partes, v.suma, v.monto_vinculado, v.faltante, v.cubierto
      into v_e
      from public.v_gasto_conciliacion v
     where v.gasto_id = p_gasto_id;
    select coalesce(jsonb_agg(jsonb_build_object('movimiento_id', p.movimiento_id,
                                                 'monto_parte', p.monto_parte,
                                                 'moneda', p.moneda::text)
                              order by p.movimiento_id), '[]'::jsonb)
      into v_partes
      from public.movimiento_bancario_gasto p
     where p.gasto_id = p_gasto_id
       and p.movimiento_id = any(p_movimiento_ids);
    return jsonb_build_object(
      'gasto_id', p_gasto_id,
      'idempotente', true,
      'nuevos', '[]'::jsonb,
      'partes', v_partes,
      'gasto_estado', jsonb_build_object(
        'monto', v_g.monto, 'moneda', v_g.moneda, 'n_partes', v_e.n_partes,
        'monto_vinculado', v_e.monto_vinculado, 'faltante', v_e.faltante,
        'cubierto', v_e.cubierto)
    );
  end if;

  -- (10) La regla POR GASTO del trigger A (Σ ≤ monto + 1.00), dicha antes y
  --      con los N cargos en el texto: el trigger sigue siendo el candado.
  select round(sum(abs(m.monto)), 2)
    into v_suma
    from public.movimiento_bancario m
   where m.id = any(v_nuevos);
  if v_vinculado + v_suma > v_g.monto + 1.00 + 0.000001 then
    raise exception using
      errcode = '23514',
      hint = 'CARGOS_EXCEDEN_GASTO',
      message = format('CARGOS_EXCEDEN_GASTO: los %s cargos suman %s y al gasto le faltan %s de %s',
                       array_length(v_nuevos, 1), v_suma, greatest(v_g.monto - v_vinculado, 0), v_g.monto),
      detail = jsonb_build_object(
        'gasto_id', p_gasto_id, 'moneda', v_g.moneda,
        'monto_gasto', v_g.monto, 'suma_ligada', v_vinculado,
        'faltante', greatest(round(v_g.monto - v_vinculado, 2), 0),
        'suma_cargos', v_suma,
        'excedente', round(v_vinculado + v_suma - v_g.monto, 2),
        'tolerancia', 1.00)::text;
  end if;

  -- (11) ESCRITURA: UNA sentencia, una parte por cargo por su |monto|
  --      (exacto: el constraint diferido exige parte = |monto| con UNA parte).
  --      A valida fila por fila (acumulado) y fija la moneda de la cuenta;
  --      B pone gastos_n = 1, gasto_id, conciliado y limpia la clasificación
  --      (aquí no hay: se exigió libre) y llama recalcular_gasto_conciliado.
  insert into public.movimiento_bancario_gasto
    (movimiento_id, gasto_id, monto_parte, moneda, created_by)
  select m.id, p_gasto_id, abs(m.monto), v_moneda::public.moneda, p_actor
    from public.movimiento_bancario m
   where m.id = any(v_nuevos)
   order by m.id;

  select v.n_partes, v.suma, v.monto_vinculado, v.faltante, v.cubierto
    into v_e
    from public.v_gasto_conciliacion v
   where v.gasto_id = p_gasto_id;
  select coalesce(jsonb_agg(jsonb_build_object('movimiento_id', p.movimiento_id,
                                               'monto_parte', p.monto_parte,
                                               'moneda', p.moneda::text)
                            order by p.movimiento_id), '[]'::jsonb)
    into v_partes
    from public.movimiento_bancario_gasto p
   where p.gasto_id = p_gasto_id
     and p.movimiento_id = any(p_movimiento_ids);

  return jsonb_build_object(
    'gasto_id', p_gasto_id,
    'idempotente', false,
    'nuevos', to_jsonb(v_nuevos),
    'partes', v_partes,
    'gasto_estado', jsonb_build_object(
      'monto', v_g.monto, 'moneda', v_g.moneda, 'n_partes', v_e.n_partes,
      'monto_vinculado', v_e.monto_vinculado, 'faltante', v_e.faltante,
      'cubierto', v_e.cubierto)
  );
end $fn_cargos$;

comment on function public.conciliacion_ligar_cargos_a_gasto(uuid, uuid[], uuid) is
  'RPC (API 0.0.77, 20261014000002, SECURITY INVOKER): liga 2..50 CARGOS pendientes y libres (misma moneda de cuenta que el gasto, gasto bancario) con UN gasto en UNA transacción: una parte por cargo (|monto|) en la puente; Σ ligado + Σ nuevos ≤ monto + 1.00. Re-envío idéntico = idempotente. 23514 LOTE_INVALIDO | MOVIMIENTO_NO_EXISTE | SOLO_CARGOS | MOVIMIENTO_NO_PENDIENTE | CARGOS_MONEDA_DISTINTA | GASTO_NO_EXISTE | LOTE_MONEDA_DISTINTA | GASTO_NO_BANCARIO | GASTO_YA_CUBIERTO | CARGOS_EXCEDEN_GASTO (+ los de los triggers A/K).';

-- ===========================================================================
-- 5) CANDADO EN BD: un movimiento OMITIDO no recibe ninguna liga
--    (cubre la RPC G y la de cobros —por su UPDATE de sincronía—, el
--    cobro_id directo de linkCobro, el sobre, el ingreso, el gasto_id
--    legado y el reverso) ni pierde la omisión fuera de la función 3
--    (revisión del 14-oct-2026: el «desvincular» de linkCobro pasaba)
-- ===========================================================================
create or replace function public.tg_mov_bancario_omitido_sin_ligas()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn_omitido_ligas$
begin
  -- El WHEN del trigger ya exigió old.clasificacion_id no nula.
  if not exists (
    select 1
      from public.conciliacion_clasificacion c
     where c.id = old.clasificacion_id
       and lower(c.nombre) = lower('Omitido de la conciliación')
  ) then
    return new;
  end if;
  if coalesce(new.gastos_n, 0) > 0
     or coalesce(new.cobros_n, 0) > 0
     or num_nonnulls(new.gasto_id, new.cobro_id, new.cobro_grupo_id,
                     new.ingreso_id, new.reverso_de_id) > 0 then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_OMITIDO',
      message = 'MOVIMIENTO_OMITIDO: el movimiento se omitió de la conciliación; deshaz la omisión antes de vincularlo',
      detail = jsonb_build_object('movimiento_id', old.id)::text;
  end if;
  -- Quitarle la clasificación canónica o regresarlo a pendiente SOLO por
  -- conciliacion_quitar_omision (su paso local `vt.quitar_omision`): el
  -- UPDATE de «desvincular» de linkCobro (cobro_id null, conciliado false,
  -- clasificacion_id null) borraba la omisión firmada en silencio y dejaba
  -- su línea en las notas.
  if (new.clasificacion_id is distinct from old.clasificacion_id
      or new.conciliado is distinct from old.conciliado)
     and current_setting('vt.quitar_omision', true) is distinct from '1' then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_OMITIDO',
      message = 'MOVIMIENTO_OMITIDO: el movimiento se omitió de la conciliación; solo «Deshacer la omisión» lo regresa a pendiente o le quita la clasificación',
      detail = jsonb_build_object('movimiento_id', old.id)::text;
  end if;
  return new;
end $fn_omitido_ligas$;

comment on function public.tg_mov_bancario_omitido_sin_ligas() is
  'Trigger (20261014000002, invariante 75, SECURITY INVOKER): sobre un movimiento con la clasificación canónica «Omitido de la conciliación» rechaza con 23514 MOVIMIENTO_OMITIDO cualquier liga (gasto, lote, cobro, lote de cobros, sobre, ingreso, reverso) y que pierda la omisión (otra clasificación, sin clasificación o conciliado = false) fuera de conciliacion_quitar_omision. Una clasificación que NO es la canónica se sigue pisando como siempre.';

-- Por orden alfabético corre después de trg_mov_bancario_cobros_candados y
-- trg_mov_bancario_gasto_suma y antes de trg_mov_bancario_reverso y
-- trg_movimiento_bancario_set_updated_at; no modifica NEW.
create or replace trigger trg_mov_bancario_omitido_sin_ligas
  before update of gasto_id, gastos_n, cobro_id, cobros_n, cobro_grupo_id, ingreso_id, reverso_de_id, clasificacion_id, conciliado
  on public.movimiento_bancario
  for each row
  when (old.clasificacion_id is not null)
  execute function public.tg_mov_bancario_omitido_sin_ligas();

-- ===========================================================================
-- 5b) CANDADO EN BD: una devolución NO se empareja con un CARGO omitido
--     (revisión del 14-oct-2026: el trigger 5 mira la fila que se actualiza
--     —el abono—; este mira el cargo al que apunta `reverso_de_id`)
-- ===========================================================================
create or replace function public.tg_mov_bancario_reverso_omitido()
returns trigger
language plpgsql
security invoker
set search_path = ''
as $fn_reverso_omitido$
declare
  v_clasif uuid;
begin
  -- El WHEN del trigger ya exigió new.reverso_de_id no nulo. Un UPDATE que
  -- repite el MISMO cargo no empareja nada nuevo (como tg_mov_bancario_reverso).
  if tg_op = 'UPDATE' and new.reverso_de_id is not distinct from old.reverso_de_id then
    return new;
  end if;
  -- El cargo bajo candado: una omisión que ya lo tomó FOR UPDATE se espera y
  -- se ve confirmada. (trg_mov_bancario_reverso, que corre antes por su
  -- nombre, ya lo bloqueó FOR UPDATE en esta misma transacción.)
  select m.clasificacion_id
    into v_clasif
    from public.movimiento_bancario m
   where m.id = new.reverso_de_id
     for share;
  if v_clasif is not null and exists (
    select 1
      from public.conciliacion_clasificacion c
     where c.id = v_clasif
       and lower(c.nombre) = lower('Omitido de la conciliación')
  ) then
    raise exception using
      errcode = '23514',
      hint = 'MOVIMIENTO_OMITIDO',
      message = 'MOVIMIENTO_OMITIDO: el cargo se omitió de la conciliación; deshaz la omisión antes de emparejarlo con su devolución',
      detail = jsonb_build_object('movimiento_id', new.reverso_de_id, 'abono_id', new.id)::text;
  end if;
  return new;
end $fn_reverso_omitido$;

comment on function public.tg_mov_bancario_reverso_omitido() is
  'Trigger (20261014000002, invariante 75, SECURITY INVOKER): rechaza con 23514 MOVIMIENTO_OMITIDO emparejar una devolución (reverso_de_id) con un CARGO que tiene la clasificación canónica «Omitido de la conciliación». Lee el cargo FOR SHARE; corre después de trg_mov_bancario_reverso.';

-- «trg_mov_bancario_reverso_omitido» ordena DESPUÉS de «trg_mov_bancario_reverso»
-- (mismo momento y evento: Postgres los dispara por nombre); no modifica NEW.
create or replace trigger trg_mov_bancario_reverso_omitido
  before insert or update of reverso_de_id
  on public.movimiento_bancario
  for each row
  when (new.reverso_de_id is not null)
  execute function public.tg_mov_bancario_reverso_omitido();

-- <<< CUERPO

-- ===========================================================================
-- 6) PERMISOS: ninguno a propósito (ver «SEGURIDAD» en la cabecera). Las 6
--    funciones son SECURITY INVOKER: quien no salta RLS no ve ni escribe nada.
-- ===========================================================================

select pg_notify('pgrst', 'reload schema');

-- ===========================================================================
-- 7) VERIFICACIÓN: aborta (y con ella toda la migración) si falta una
--    función o un trigger, si alguna quedó SECURITY DEFINER o sin search_path
--    vacío, o si la premisa de la seguridad (RLS habilitado SIN políticas en
--    las tablas que tocan) no se cumple.
-- ===========================================================================
do $ver$
declare
  v_falta text[] := '{}';
begin
  if to_regprocedure('public.conciliacion_clasificacion_omitido(uuid)') is null then v_falta := v_falta || 'conciliacion_clasificacion_omitido'::text; end if;
  if to_regprocedure('public.conciliacion_omitir_movimientos(uuid[],text,uuid)') is null then v_falta := v_falta || 'conciliacion_omitir_movimientos'::text; end if;
  if to_regprocedure('public.conciliacion_quitar_omision(uuid[],uuid)') is null then v_falta := v_falta || 'conciliacion_quitar_omision'::text; end if;
  if to_regprocedure('public.conciliacion_ligar_cargos_a_gasto(uuid,uuid[],uuid)') is null then v_falta := v_falta || 'conciliacion_ligar_cargos_a_gasto'::text; end if;
  if to_regprocedure('public.tg_mov_bancario_omitido_sin_ligas()') is null then v_falta := v_falta || 'tg_mov_bancario_omitido_sin_ligas'::text; end if;
  if to_regprocedure('public.tg_mov_bancario_reverso_omitido()') is null then v_falta := v_falta || 'tg_mov_bancario_reverso_omitido'::text; end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'trg_mov_bancario_omitido_sin_ligas'
                    and tgrelid = 'public.movimiento_bancario'::regclass) then
    v_falta := v_falta || 'trg_mov_bancario_omitido_sin_ligas'::text;
  end if;
  if not exists (select 1 from pg_trigger
                  where tgname = 'trg_mov_bancario_reverso_omitido'
                    and tgrelid = 'public.movimiento_bancario'::regclass) then
    v_falta := v_falta || 'trg_mov_bancario_reverso_omitido'::text;
  end if;
  if exists (select 1 from pg_proc p join pg_namespace n on n.oid = p.pronamespace
              where n.nspname = 'public'
                and p.proname in ('conciliacion_clasificacion_omitido', 'conciliacion_omitir_movimientos',
                                  'conciliacion_quitar_omision', 'conciliacion_ligar_cargos_a_gasto',
                                  'tg_mov_bancario_omitido_sin_ligas', 'tg_mov_bancario_reverso_omitido')
                and (p.prosecdef or p.proconfig is null
                     or not ('search_path=""' = any (p.proconfig)))) then
    v_falta := v_falta || 'security invoker / search_path'::text;
  end if;
  if exists (select 1 from pg_class c
              where c.oid in ('public.movimiento_bancario'::regclass,
                              'public.movimiento_bancario_gasto'::regclass,
                              'public.conciliacion_clasificacion'::regclass,
                              'public.gasto'::regclass,
                              'public.cuenta_bancaria'::regclass)
                and not c.relrowsecurity) then
    v_falta := v_falta || 'RLS deshabilitado en una tabla que tocan las RPC'::text;
  end if;
  if exists (select 1 from pg_policies pol
              where pol.schemaname = 'public'
                and pol.tablename in ('movimiento_bancario', 'movimiento_bancario_gasto',
                                      'conciliacion_clasificacion', 'gasto', 'cuenta_bancaria')) then
    v_falta := v_falta || 'política RLS en una tabla que tocan las RPC (revisar antes de dejarlas SECURITY INVOKER)'::text;
  end if;
  if exists (select 1 from public.conciliacion_clasificacion c
              where lower(c.nombre) = lower('Omitido de la conciliación')) then
    raise notice 'La canónica ya existía (la creó alguien a mano): la función la reutiliza y la reactiva.';
  end if;
  if cardinality(v_falta) > 0 then
    raise exception 'VERIFICACION_FALLA 20261014000002: %', array_to_string(v_falta, ', ');
  end if;
end $ver$;
