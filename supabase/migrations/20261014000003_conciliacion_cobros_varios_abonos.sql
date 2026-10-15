-- 14-oct-2026 · CONCILIACIÓN: UN COBRO ACEPTA VARIOS ABONOS (pago parcial),
-- «CONCILIADO» = CUBIERTO Y CANDADOS DE DINERO DEL COBRO LIGADO — API 0.0.78,
-- invariante 77 del CLAUDE.md del API.
--
-- PEDIDO DEL CLIENTE (14-oct-2026): «haz lo que me propusiste para que no
-- vuelva a pasar: que un cobro acepte varios abonos, el aviso de «Conciliado
-- parcial», la alerta al vincular un abono de otro monto y la de «cobrado de
-- más» en la card». Caso real: el cobro de $3,400 de las camionetas (#315)
-- se pagó con DOS transferencias y la puente solo admitía UN abono por cobro
-- (índice único uq_mov_cobro_parte_cobro): el segundo abono quedaba
-- pendiente para siempre o se ligaba a otro cobro; y un cobro ligado a un
-- abono de $1,700 decía «Conciliado» aunque faltaran $1,700.
--
-- QUÉ CAMBIA (sin columnas nuevas, sin backfill):
--   0) Aserciones previas (abortan): 20261012000002 aplicada y los datos de
--      hoy cumplen la coherencia NUEVA de K (un cobro ⇒ parte = |abono|;
--      lote ⇒ misma moneda y Σ dentro de tolerancia_lote(N)).
--   1) La puente movimiento_bancario_cobro pasa a M:N: se retiran los ÍNDICES
--      ÚNICOS uq_mov_cobro_parte_cobro (puente) y uq_mov_bancario_cobro
--      (espejo cobro_id); nace idx_mov_cobro_parte_cobro (cobro_id,
--      movimiento_id). El índice NO único idx_mov_bancario_cobro se queda.
--   2) Funciones PURAS (SECURITY INVOKER: no leen tablas, nada que elevar;
--      advisors 0028/0029 limpios): neto_de_cobro (monto − comisión bancaria
--      capturada; si no da positivo, monto: espejo de netoDeCobro del API) y
--      regla_cobro_cubierto (CASE ordenado, espejo de regla_gasto_cubierto):
--      cruzado ⇒ true; sin partes ⇒ false; neto ≤ 0 ⇒ true; si no,
--      Σ partes de SU moneda + 1e-6 ≥ neto − 1.00.
--   3) Vista v_cobro_conciliacion (security_invoker): estado de cada cobro
--      desde la puente (n_partes, cruzado, pasarela, suma, monto_vinculado,
--      faltante, sobrante, cubierto, movimiento_ids por antigüedad).
--   4) A (tg_mov_cobro_parte_valida, reemplazo): el cobro se BLOQUEA (for
--      update) y la regla es por COBRO: cubierto por otros abonos ⇒
--      COBRO_YA_CONCILIADO (motivo CUBIERTO); cobro «de un solo abono»
--      (comisión capturada, abono de PASARELA o en otra moneda) con otro abono
--      ⇒ COBRO_YA_CONCILIADO (motivo UN_SOLO_ABONO); otra moneda ⇒ T.C.
--      implícito (pesos ÷ dólares contra el NETO) entre 15 y 25 o
--      COBRO_MONEDA_DISTINTA; un solo abono ⇒ |parte − neto| ≤ 1.00 o
--      COMISION_NO_CUADRA (parte > monto + 1.00 ⇒ ABONO_EXCEDE_COBRO); si no,
--      Σ otros + parte ≤ neto + 1.00 o ABONO_EXCEDE_COBRO. Un abono MENOR
--      deja el cobro PARCIAL (permitido).
--      D (tg_mov_bancario_cobros_candados, reemplazo): con UNO o más cobros
--      ligados el abono no cambia de tipo, monto ni cuenta (antes: solo con
--      un lote).
--      K (motivo_cobros_incoherentes, reemplazo + constraint trigger
--      recreado con monto y cuenta_bancaria_id): además de los espejos, un
--      abono con UN cobro tiene parte = |abono| y un lote tiene todos sus
--      cobros en la moneda de la cuenta y Σ partes dentro de
--      tolerancia_lote(N).
--   5) E NUEVO trg_cobro_vuelo_abonos_candado (BEFORE UPDATE OF monto,
--      moneda, comision_banco_monto, cobro_grupo_id, ingreso_anticipo_id en
--      cobro_vuelo): con abonos ligados ⇒ COBRO_CONCILIADO (el dinero del
--      cobro conciliado no se mueve por debajo de la conciliación).
--   6) G conciliacion_ligar_abono_cobros (reemplazo): sin el candado
--      «ocupado por otro movimiento»; con UN cobro parte = |abono| (A decide);
--      en un LOTE cada cobro entra por su FALTANTE (neto − Σ de sus OTROS
--      abonos), todos en la moneda de la cuenta y Σ faltantes = |abono| ±
--      tolerancia_lote(N) (ABONO_NO_CUADRA con las MISMAS llaves de detail);
--      un cobro ya cubierto o «de un solo abono» con otro abono ⇒
--      COBRO_YA_CONCILIADO. H (desligar) no cambia.
--   7) Permisos: las funciones nuevas y la vista solo para service_role.
--   8) Verificación final (aborta si algo no quedó).
--
-- Errores 23514 con message «CODIGO: …», hint = CODIGO, detail = jsonb. Los
-- códigos NUEVOS (ABONO_EXCEDE_COBRO, COMISION_NO_CUADRA,
-- COBRO_MONEDA_DISTINTA) cierran su message con « [ABONO_NO_CUADRA]» para que
-- un API ≤ 0.0.77 (que no los conoce y busca el código dentro del texto)
-- responda 409 y no 500; el API 0.0.78 lee el hint y retira esa marca.
--
-- `moneda` (cobro_vuelo, cuenta_bancaria) y `tipo` (movimiento_bancario) son
-- ENUM: en plpgsql se comparan SIEMPRE `::text` (incidente 15-sep-2026).
-- cuenta_bancaria.tipo es TEXT (BANCO | PASARELA).
--
-- DEPENDE de 20261002000002 (vt_actor_id, tolerancia_lote) y 20261012000002
-- (puente de cobros), APLICADAS. Se aplica DESPUÉS de 20261014000002 (lote
-- «Omitir»): no hay dependencia de objetos, pero el API 0.0.78 se arma sobre
-- el 0.0.77.
--
-- APLICACIÓN: SOLO por el SQL Editor (lleva DROP INDEX, DROP TRIGGER y REVOKE:
-- el MCP de Supabase lo declina). Paquete en
-- docs/sql-aplicar-<fecha>-cobros-varios-abonos/ (00 prechequeo por MCP · 01
-- dry-run en el SQL Editor ⇒ DRYRUN_OK · 02 aplicar + registrar el historial
-- en el SQL Editor · 03 postcheck por MCP ⇒ POSTCHECK_OK · 03b lecturas por
-- MCP · get_advisors · 99 reversa solo SQL Editor). El CUERPO entre
-- «>>> CUERPO» y «<<< CUERPO» es lo que el dry-run pega TAL CUAL.
--
-- TOLERANCIA DEL API: sonda `common/cobros-parciales-disponible.util.ts`
-- (RPC regla_cobro_cubierto(1,1,false,1) = true). Sin la migración: todo como
-- el 0.0.77 salvo la pre-validación en TS; el segundo abono a un cobro
-- responde 503 CONCILIACION_COBROS_PARCIALES_NO_DISPONIBLE. El «no» se
-- re-sondea cada ≤ 10 min.
--
-- >>> CUERPO

-- ===========================================================================
-- 0) ASERCIONES PREVIAS — abortan ANTES de cambiar nada.
-- ===========================================================================
do $pre$
declare
  v_n integer;
begin
  if to_regclass('public.movimiento_bancario_cobro') is null
     or not exists (select 1 from information_schema.columns
                     where table_schema = 'public' and table_name = 'movimiento_bancario'
                       and column_name = 'cobros_n')
     or to_regprocedure('public.tolerancia_lote(integer)') is null
     or to_regprocedure('public.vt_actor_id()') is null then
    raise exception 'ABORTADO: falta 20261012000002 (puente de cobros) o 20261002000002 (tolerancia_lote, vt_actor_id)';
  end if;
  -- (a) abono con UN cobro cuya parte no es el abono completo
  select count(*) into v_n
    from public.movimiento_bancario m
   where m.cobros_n = 1
     and exists (select 1 from public.movimiento_bancario_cobro p
                  where p.movimiento_id = m.id
                    and abs(p.monto_parte - round(abs(m.monto), 2)) > 0.005);
  if v_n > 0 then
    raise exception 'ABORTADO: % abono(s) con un solo cobro cuya parte no es el abono completo; revisarlos antes de migrar', v_n;
  end if;
  -- (b) lote con algún cobro en otra moneda que la cuenta
  select count(*) into v_n
    from public.movimiento_bancario m
    join public.cuenta_bancaria cb on cb.id = m.cuenta_bancaria_id
   where m.cobros_n >= 2
     and exists (select 1 from public.movimiento_bancario_cobro p
                   join public.cobro_vuelo c on c.id = p.cobro_id
                  where p.movimiento_id = m.id
                    and c.moneda::text <> cb.moneda::text);
  if v_n > 0 then
    raise exception 'ABORTADO: % lote(s) con un cobro en otra moneda que la cuenta; revisarlos antes de migrar', v_n;
  end if;
  -- (c) lote cuya suma no cuadra con el abono
  select count(*) into v_n
    from public.movimiento_bancario m
   where m.cobros_n >= 2
     and abs(round(abs(m.monto), 2)
             - (select coalesce(sum(p.monto_parte), 0)
                  from public.movimiento_bancario_cobro p
                 where p.movimiento_id = m.id))
         > public.tolerancia_lote(m.cobros_n) + 0.000001;
  if v_n > 0 then
    raise exception 'ABORTADO: % lote(s) cuya suma no cuadra con su abono; revisarlos antes de migrar', v_n;
  end if;
end $pre$;

-- ===========================================================================
-- 1) LA PUENTE PASA A M:N
-- ===========================================================================
drop index if exists public.uq_mov_cobro_parte_cobro;
create index if not exists idx_mov_cobro_parte_cobro
  on public.movimiento_bancario_cobro (cobro_id, movimiento_id);
-- El espejo cobro_id de DOS abonos puede apuntar al MISMO cobro (cada uno con
-- su única parte): el índice único del espejo se retira; el NO único
-- idx_mov_bancario_cobro se queda para las búsquedas.
drop index if exists public.uq_mov_bancario_cobro;

comment on table public.movimiento_bancario_cobro is
  'FUENTE ÚNICA de la liga abono ↔ cobro de vuelo (20261012000002; M:N desde 20261014000003). Un ABONO paga 1..N cobros (lote: cada cobro por lo que le FALTABA fuera de ese abono) y un COBRO se paga con 1..N abonos (pago parcial). monto_parte va en la moneda de la cuenta del abono; con UN cobro vale el abono completo. Estado por cobro: v_cobro_conciliacion (regla_cobro_cubierto). movimiento_bancario.cobro_id y cobros_n son ESPEJOS (triggers B/C).';

-- ===========================================================================
-- 2) FUNCIONES PURAS
-- ===========================================================================

-- Lo que deposita el banco por un cobro: monto − comisión bancaria capturada
-- (si no da positivo, el monto). Espejo EXACTO de netoDeCobro del API.
create or replace function public.neto_de_cobro(p_monto numeric, p_comision numeric)
returns numeric
language sql
immutable
security invoker
set search_path = ''
as $fn_neto$
  select case
           when round(coalesce(p_monto, 0)
                      - case when coalesce(p_comision, 0) > 0 then p_comision else 0 end, 2) > 0
             then round(coalesce(p_monto, 0)
                        - case when coalesce(p_comision, 0) > 0 then p_comision else 0 end, 2)
           else round(coalesce(p_monto, 0), 2)
         end;
$fn_neto$;

comment on function public.neto_de_cobro(numeric, numeric) is
  'Neto bancario de un cobro: round(monto − comisión capturada, 2) si la comisión es > 0 y el resultado es positivo; si no, round(monto, 2). Espejo de netoDeCobro del API (20261014000003).';

-- LA regla de «cobro cubierto» (= «Conciliado» de un cobro). CASE ORDENADO,
-- espejo de regla_gasto_cubierto y de cubreCobro del API.
create or replace function public.regla_cobro_cubierto(
  p_neto numeric,
  p_n_partes integer,
  p_cruzado boolean,
  p_suma numeric
)
returns boolean
language sql
immutable
security invoker
set search_path = ''
as $fn_regla_cobro$
  select case
           -- (1) abono en OTRA moneda (1↔1): cubre por definición
           when coalesce(p_cruzado, false) then true
           -- (2) sin abonos: no está conciliado
           when coalesce(p_n_partes, 0) = 0 then false
           -- (3) neto ≤ 0 con algún abono: nunca «pendiente para siempre»
           when round(coalesce(p_neto, 0), 2) <= 0 then true
           -- (4) Σ partes de su moneda ≥ neto − 1.00
           else round(coalesce(p_suma, 0), 2) + 0.000001 >= round(p_neto, 2) - 1.00
         end;
$fn_regla_cobro$;

comment on function public.regla_cobro_cubierto(numeric, integer, boolean, numeric) is
  'Regla única de «cobro conciliado» (CASE ordenado): cruzado ⇒ true; sin partes ⇒ false; neto ≤ 0 ⇒ true; Σ partes de su moneda + 1e-6 ≥ neto − 1.00. Espejo de cubreCobro del API (20261014000003).';

-- ===========================================================================
-- 3) VISTA CANÓNICA POR COBRO
-- ===========================================================================
create or replace view public.v_cobro_conciliacion
with (security_invoker = true)
as
select c.id as cobro_id,
       c.vuelo_id,
       c.moneda::text as moneda,
       round(c.monto, 2) as monto,
       c.comision_banco_monto,
       public.neto_de_cobro(c.monto, c.comision_banco_monto) as neto,
       s.n_partes,
       s.cruzado,
       s.pasarela,
       s.suma,
       case when s.cruzado then public.neto_de_cobro(c.monto, c.comision_banco_monto)
            else s.suma
       end as monto_vinculado,
       case when public.neto_de_cobro(c.monto, c.comision_banco_monto) <= 0 then 0::numeric
            when s.cruzado then 0::numeric
            else greatest(round(public.neto_de_cobro(c.monto, c.comision_banco_monto) - s.suma, 2), 0::numeric)
       end as faltante,
       case when s.n_partes = 0 or s.cruzado then 0::numeric
            else greatest(round(s.suma - public.neto_de_cobro(c.monto, c.comision_banco_monto), 2), 0::numeric)
       end as sobrante,
       public.regla_cobro_cubierto(public.neto_de_cobro(c.monto, c.comision_banco_monto),
                                   s.n_partes, s.cruzado, s.suma) as cubierto,
       s.movimiento_ids
  from public.cobro_vuelo c
  cross join lateral (
    select count(p.cobro_id)::integer as n_partes,
           coalesce(bool_or(cb.moneda::text is distinct from c.moneda::text), false) as cruzado,
           coalesce(bool_or(coalesce(cb.tipo, '') = 'PASARELA'), false) as pasarela,
           round(coalesce(sum(p.monto_parte) filter (where cb.moneda::text = c.moneda::text), 0), 2) as suma,
           coalesce(array_agg(p.movimiento_id order by m.fecha, m.created_at, p.movimiento_id)
                      filter (where p.movimiento_id is not null), array[]::uuid[]) as movimiento_ids
      from public.movimiento_bancario_cobro p
      join public.movimiento_bancario m on m.id = p.movimiento_id
      left join public.cuenta_bancaria cb on cb.id = m.cuenta_bancaria_id
     where p.cobro_id = c.id
  ) s;

comment on view public.v_cobro_conciliacion is
  'Estado de conciliación de cada cobro de vuelo desde la puente (20261014000003): neto (neto_de_cobro), n_partes (abonos), cruzado (algún abono en otra moneda: 1↔1), pasarela (algún abono de PASARELA), suma (Σ partes de SU moneda), monto_vinculado (cruzado ⇒ neto), faltante, sobrante, cubierto (regla_cobro_cubierto) y movimiento_ids por antigüedad. La leen la verificación (postcheck y lecturas por MCP) y el spec de paridad; el API calcula lo MISMO en TS desde la puente (common/cobro-banco.util.ts#coberturaCobro), así sus lecturas no dependen de la migración.';

-- ===========================================================================
-- 4) TRIGGERS DE LA PUENTE Y DEL ABONO (reemplazos)
-- ===========================================================================

-- A) Candados por fila: el abono admite partes y la regla es POR COBRO.
create or replace function public.tg_mov_cobro_parte_valida()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_parte_valida$
declare
  v_mov record;
  v_cobro record;
  v_otras record;
  v_old_mov uuid;
  v_old_cobro uuid;
  v_neto numeric;
  v_cruzada boolean;
  v_pasarela boolean;
  v_comision boolean;
  v_por text;
  v_tc numeric;
  v_folio text;
  v_token constant text := ' [ABONO_NO_CUADRA]';
begin
  select m.id, m.tipo::text as tipo, m.gasto_id, m.gastos_n, m.cobro_grupo_id,
         m.ingreso_id, m.reverso_de_id, m.monto,
         cb.moneda::text as moneda_cuenta, cb.tipo as tipo_cuenta
    into v_mov
    from public.movimiento_bancario m
    left join public.cuenta_bancaria cb on cb.id = m.cuenta_bancaria_id
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

  -- El COBRO se BLOQUEA: dos abonos al mismo cobro se serializan aquí (la
  -- RPC G ya lo bloqueó en orden de id; el espejo legado C llega aquí).
  select c.id, c.monto, c.moneda::text as moneda, c.comision_banco_monto,
         c.cobro_grupo_id, c.ingreso_anticipo_id,
         (select v.folio from public.vuelo v where v.id = c.vuelo_id) as folio
    into v_cobro
    from public.cobro_vuelo c
   where c.id = new.cobro_id
     for update of c;
  if not found then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_NO_EXISTE',
      message = format('COBRO_NO_EXISTE: el cobro %s no existe', new.cobro_id),
      detail = jsonb_build_object('cobro_id', new.cobro_id)::text;
  end if;
  v_folio := coalesce(v_cobro.folio::text, '?');
  if v_cobro.monto <= 0 then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_INVALIDO',
      message = format('COBRO_INVALIDO: el cobro del vuelo #%s es un reembolso (monto negativo): sale como CARGO en el banco, no como abono', v_folio),
      detail = jsonb_build_object('cobro_id', v_cobro.id, 'folio', v_cobro.folio, 'monto', v_cobro.monto)::text;
  end if;
  if v_cobro.cobro_grupo_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_DE_GRUPO',
      message = format('COBRO_DE_GRUPO: el cobro del vuelo #%s es parte del sobre de un grupo: se concilia el sobre, no sus partes', v_folio),
      detail = jsonb_build_object('cobro_id', v_cobro.id, 'folio', v_cobro.folio, 'cobro_grupo_id', v_cobro.cobro_grupo_id)::text;
  end if;
  if v_cobro.ingreso_anticipo_id is not null then
    raise exception using
      errcode = '23514',
      hint = 'COBRO_DE_ANTICIPO',
      message = format('COBRO_DE_ANTICIPO: el cobro del vuelo #%s salió de un anticipo: su dinero se concilia una vez, como anticipo', v_folio),
      detail = jsonb_build_object('cobro_id', v_cobro.id, 'folio', v_cobro.folio, 'ingreso_anticipo_id', v_cobro.ingreso_anticipo_id)::text;
  end if;

  v_neto := public.neto_de_cobro(v_cobro.monto, v_cobro.comision_banco_monto);
  v_comision := coalesce(v_cobro.comision_banco_monto, 0) > 0;
  v_cruzada := v_mov.moneda_cuenta is not null and v_mov.moneda_cuenta <> v_cobro.moneda;
  v_pasarela := coalesce(v_mov.tipo_cuenta, '') = 'PASARELA';
  if tg_op = 'UPDATE' then
    v_old_mov := old.movimiento_id;
    v_old_cobro := old.cobro_id;
  end if;

  -- Los OTROS abonos de este cobro (fuera de este movimiento y de la fila
  -- vieja de un UPDATE).
  select count(*)::integer as n,
         count(*) filter (where cb.moneda::text is distinct from v_cobro.moneda)::integer as cruzadas,
         count(*) filter (where coalesce(cb.tipo, '') = 'PASARELA')::integer as pasarelas,
         round(coalesce(sum(p.monto_parte) filter (where cb.moneda::text = v_cobro.moneda), 0), 2) as suma,
         coalesce(jsonb_agg(p.movimiento_id order by m.fecha, m.created_at, p.movimiento_id), '[]'::jsonb) as movs
    into v_otras
    from public.movimiento_bancario_cobro p
    join public.movimiento_bancario m on m.id = p.movimiento_id
    left join public.cuenta_bancaria cb on cb.id = m.cuenta_bancaria_id
   where p.cobro_id = new.cobro_id
     and p.movimiento_id <> new.movimiento_id
     and not (p.movimiento_id is not distinct from v_old_mov
              and p.cobro_id is not distinct from v_old_cobro);

  if v_otras.n > 0 then
    if v_otras.cruzadas > 0
       or public.regla_cobro_cubierto(v_neto, v_otras.n, false, v_otras.suma) then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_YA_CONCILIADO',
        message = format('COBRO_YA_CONCILIADO: el cobro del vuelo #%s ya está cubierto por %s abono(s) del banco', v_folio, v_otras.n),
        detail = jsonb_build_object('cobro_id', v_cobro.id, 'folio', v_cobro.folio, 'motivo', 'CUBIERTO',
                                    'neto', v_neto, 'suma_ligada', v_otras.suma, 'abonos_otros', v_otras.n,
                                    'movimiento_ids', v_otras.movs, 'movimiento_id', v_otras.movs->>0)::text;
    end if;
    if v_comision or v_pasarela or v_cruzada or v_otras.pasarelas > 0 then
      v_por := case when v_cruzada then 'MONEDA_DISTINTA'
                    when v_pasarela or v_otras.pasarelas > 0 then 'PASARELA'
                    else 'COMISION' end;
      raise exception using
        errcode = '23514',
        hint = 'COBRO_YA_CONCILIADO',
        message = format('COBRO_YA_CONCILIADO: el cobro del vuelo #%s se concilia con UN solo abono (%s) y ya tiene otro ligado', v_folio,
                         case v_por when 'MONEDA_DISTINTA' then 'abono en otra moneda'
                                    when 'PASARELA' then 'abono de la pasarela'
                                    else 'cobro con comisión bancaria' end),
        detail = jsonb_build_object('cobro_id', v_cobro.id, 'folio', v_cobro.folio, 'motivo', 'UN_SOLO_ABONO',
                                    'por', v_por, 'neto', v_neto, 'suma_ligada', v_otras.suma,
                                    'abonos_otros', v_otras.n, 'movimiento_ids', v_otras.movs,
                                    'movimiento_id', v_otras.movs->>0)::text;
    end if;
  end if;

  -- Otra moneda (1↔1): el T.C. implícito contra el NETO, en la banda 15–25.
  if v_cruzada then
    v_tc := case when v_cobro.moneda = 'USD' and v_mov.moneda_cuenta = 'MXN' then new.monto_parte / v_neto
                 when v_cobro.moneda = 'MXN' and v_mov.moneda_cuenta = 'USD' then v_neto / new.monto_parte
            end;
    if v_tc is null or v_tc < 15 or v_tc > 25 then
      raise exception using
        errcode = '23514',
        hint = 'COBRO_MONEDA_DISTINTA',
        message = format('COBRO_MONEDA_DISTINTA: el cobro del vuelo #%s está en %s y el abono en %s; el tipo de cambio que resulta (%s) no está entre 15 y 25%s',
                         v_folio, v_cobro.moneda, coalesce(v_mov.moneda_cuenta, '?'),
                         coalesce(round(v_tc, 6)::text, '?'), v_token),
        detail = jsonb_build_object('movimiento_id', new.movimiento_id, 'cobro_id', v_cobro.id, 'folio', v_cobro.folio,
                                    'motivo', 'TC_FUERA_DE_BANDA', 'moneda_cobro', v_cobro.moneda,
                                    'moneda_cuenta', v_mov.moneda_cuenta, 'neto', v_neto,
                                    'parte', new.monto_parte, 'tc_implicito', round(v_tc, 6),
                                    'tc_min', 15, 'tc_max', 25)::text;
    end if;
    return new;
  end if;

  -- Cobro «de un solo abono» (comisión capturada o abono de la pasarela): el
  -- abono es el NETO ± 1.00.
  if v_comision or v_pasarela then
    if new.monto_parte > round(v_cobro.monto, 2) + 1.00 + 0.000001 then
      raise exception using
        errcode = '23514',
        hint = 'ABONO_EXCEDE_COBRO',
        message = format('ABONO_EXCEDE_COBRO: el abono (%s) es mayor que el cobro del vuelo #%s (%s)%s',
                         new.monto_parte, v_folio, round(v_cobro.monto, 2), v_token),
        detail = jsonb_build_object('movimiento_id', new.movimiento_id, 'cobro_id', v_cobro.id, 'folio', v_cobro.folio,
                                    'moneda', v_cobro.moneda, 'monto_cobro', round(v_cobro.monto, 2),
                                    'neto', v_neto, 'suma_otras', 0, 'abonos_otros', 0,
                                    'parte', new.monto_parte, 'faltante', v_neto,
                                    'excedente', round(new.monto_parte - v_neto, 2), 'un_solo', true)::text;
    end if;
    if abs(new.monto_parte - v_neto) > 1.00 + 0.000001 then
      raise exception using
        errcode = '23514',
        hint = 'COMISION_NO_CUADRA',
        message = format('COMISION_NO_CUADRA: el cobro del vuelo #%s espera %s después de la comisión y el abono es de %s%s',
                         v_folio, v_neto, new.monto_parte, v_token),
        detail = jsonb_build_object('movimiento_id', new.movimiento_id, 'cobro_id', v_cobro.id, 'folio', v_cobro.folio,
                                    'moneda', v_cobro.moneda, 'monto_cobro', round(v_cobro.monto, 2),
                                    'comision_capturada', round(coalesce(v_cobro.comision_banco_monto, 0), 2),
                                    'neto', v_neto, 'parte', new.monto_parte,
                                    'comision_real', greatest(round(v_cobro.monto - new.monto_parte, 2), 0),
                                    'por', case when v_pasarela then 'PASARELA' else 'COMISION' end)::text;
    end if;
    return new;
  end if;

  -- Cobro de BANCO sin comisión: varios abonos, nunca de más.
  if v_otras.suma + new.monto_parte > v_neto + 1.00 + 0.000001 then
    raise exception using
      errcode = '23514',
      hint = 'ABONO_EXCEDE_COBRO',
      message = format('ABONO_EXCEDE_COBRO: con este abono el cobro del vuelo #%s quedaría pagado de más por %s%s',
                       v_folio, round(v_otras.suma + new.monto_parte - v_neto, 2), v_token),
      detail = jsonb_build_object('movimiento_id', new.movimiento_id, 'cobro_id', v_cobro.id, 'folio', v_cobro.folio,
                                  'moneda', v_cobro.moneda, 'monto_cobro', round(v_cobro.monto, 2),
                                  'neto', v_neto, 'suma_otras', v_otras.suma, 'abonos_otros', v_otras.n,
                                  'parte', new.monto_parte,
                                  'faltante', greatest(round(v_neto - v_otras.suma, 2), 0),
                                  'excedente', round(v_otras.suma + new.monto_parte - v_neto, 2),
                                  'un_solo', false)::text;
  end if;
  return new;
end $fn_parte_valida$;

comment on function public.tg_mov_cobro_parte_valida() is
  'Trigger A (BEFORE INSERT/UPDATE por fila en movimiento_bancario_cobro; 20261012000002, regla por COBRO desde 20261014000003): el movimiento es un ABONO sin gasto/sobre/ingreso ni reverso; el cobro (BLOQUEADO) existe, es positivo y no es parte de sobre ni de anticipo; cubierto por otros abonos o «de un solo abono» con otro ⇒ COBRO_YA_CONCILIADO; otra moneda ⇒ T.C. implícito 15–25 o COBRO_MONEDA_DISTINTA; comisión/pasarela ⇒ |parte − neto| ≤ 1.00 o COMISION_NO_CUADRA (parte > monto + 1 ⇒ ABONO_EXCEDE_COBRO); si no, Σ + parte ≤ neto + 1.00 o ABONO_EXCEDE_COBRO. 23514 con hint = CODIGO.';

-- D) CANDADOS del abono con cobros ligados: no entra otra liga de dinero;
--    con UNO o más cobros no cambian tipo/monto/cuenta; un LOTE no se
--    desconcilia a mano.
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
  if new.tipo::text is distinct from old.tipo::text
     or new.monto is distinct from old.monto
     or new.cuenta_bancaria_id is distinct from old.cuenta_bancaria_id then
    raise exception using
      errcode = '23514',
      hint = 'ABONO_LIGADO',
      message = format('ABONO_LIGADO: el abono paga %s cobro(s); no cambia de tipo, monto ni cuenta mientras los tenga ligados', old.cobros_n),
      detail = jsonb_build_object('movimiento_id', new.id, 'cobros_n', old.cobros_n)::text;
  end if;
  if old.cobros_n >= 2 and new.conciliado = false then
    raise exception using
      errcode = '23514',
      hint = 'ABONO_LIGADO',
      message = format('ABONO_LIGADO: el abono paga %s cobros; para dejarlo pendiente desvincúlalos (conciliacion_desligar_abono_cobros)', old.cobros_n),
      detail = jsonb_build_object('movimiento_id', new.id, 'cobros_n', old.cobros_n)::text;
  end if;
  return new;
end $fn_candados$;

comment on function public.tg_mov_bancario_cobros_candados() is
  'Trigger D (BEFORE UPDATE OF tipo, monto, cuenta_bancaria_id, gasto_id, gastos_n, cobro_grupo_id, ingreso_id, reverso_de_id, conciliado en movimiento_bancario; 20261012000002, ampliado en 20261014000003): con cobros ligados no entra gasto/sobre/ingreso/reverso (MOVIMIENTO_YA_LIGADO); con UNO o más cobros no cambian tipo/monto/cuenta y un LOTE no se desconcilia a mano (ABONO_LIGADO).';

-- K) COHERENCIA DEL ABONO (constraint trigger DIFERIDO): espejos = puente,
--    UN cobro ⇒ parte = |abono|; LOTE ⇒ moneda de la cuenta y Σ cuadrada.
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
  v_parte numeric;
  v_suma numeric;
  v_ajenas integer;
begin
  select m.cobros_n, m.cobro_id, m.conciliado, m.tipo::text as tipo,
         round(abs(m.monto), 2) as monto_abono, cb.moneda::text as moneda_cuenta,
         num_nonnulls(m.gasto_id, m.cobro_grupo_id, m.ingreso_id, m.reverso_de_id)
           + case when coalesce(m.gastos_n, 0) > 0 then 1 else 0 end as otras_ligas
    into v
    from public.movimiento_bancario m
    left join public.cuenta_bancaria cb on cb.id = m.cuenta_bancaria_id
   where m.id = p_movimiento_id;
  if not found then
    return null;
  end if;
  select count(*)::integer, (array_agg(p.cobro_id))[1], (array_agg(p.monto_parte))[1],
         round(coalesce(sum(p.monto_parte), 0), 2),
         count(*) filter (where c.moneda::text is distinct from v.moneda_cuenta)::integer
    into v_n, v_unico, v_parte, v_suma, v_ajenas
    from public.movimiento_bancario_cobro p
    join public.cobro_vuelo c on c.id = p.cobro_id
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
    when v_n = 1 and abs(v_parte - v.monto_abono) > 0.005 then
      format('su único cobro vale %s y el abono %s: con un cobro la parte es el abono completo', v_parte, v.monto_abono)
    when v_n >= 2 and v_ajenas > 0 then
      format('paga %s cobros y %s no están en la moneda de la cuenta', v_n, v_ajenas)
    when v_n >= 2 and abs(v.monto_abono - v_suma) > public.tolerancia_lote(v_n) + 0.000001 then
      format('sus %s cobros suman %s y el abono es de %s', v_n, v_suma, v.monto_abono)
  end;
end $fn_motivo$;

comment on function public.motivo_cobros_incoherentes(uuid) is
  'NULL si el abono cuadra con la puente de cobros (espejos; UN cobro ⇒ parte = |abono|; LOTE ⇒ moneda de la cuenta y Σ dentro de tolerancia_lote); si no, el motivo (20261012000002; reglas de monto desde 20261014000003).';

-- El constraint trigger escucha además monto y cuenta (un abono no puede
-- quedar con su parte distinta del abono sin que se note al commit).
drop trigger if exists trg_mov_bancario_cobros_coherentes on public.movimiento_bancario;
create constraint trigger trg_mov_bancario_cobros_coherentes
  after insert or update of cobros_n, conciliado, cobro_id, tipo, monto, cuenta_bancaria_id,
    gasto_id, gastos_n, cobro_grupo_id, ingreso_id, reverso_de_id
  on public.movimiento_bancario
  deferrable initially deferred
  for each row execute function public.tg_mov_bancario_cobros_coherentes();

-- ===========================================================================
-- 5) E — CANDADO DEL DINERO DE UN COBRO LIGADO A ABONOS
-- ===========================================================================
create or replace function public.tg_cobro_vuelo_abonos_candado()
returns trigger
language plpgsql
security definer
set search_path = ''
as $fn_candado_cobro$
declare
  v_campos text[] := array[]::text[];
  v_n integer;
  v_movs jsonb;
begin
  if new.monto is distinct from old.monto then
    v_campos := array_append(v_campos, 'monto');
  end if;
  if new.moneda::text is distinct from old.moneda::text then
    v_campos := array_append(v_campos, 'moneda');
  end if;
  if new.comision_banco_monto is distinct from old.comision_banco_monto then
    v_campos := array_append(v_campos, 'comision_banco_monto');
  end if;
  if new.cobro_grupo_id is distinct from old.cobro_grupo_id then
    v_campos := array_append(v_campos, 'cobro_grupo_id');
  end if;
  if new.ingreso_anticipo_id is distinct from old.ingreso_anticipo_id then
    v_campos := array_append(v_campos, 'ingreso_anticipo_id');
  end if;
  if cardinality(v_campos) = 0 then
    return new;
  end if;
  select count(*)::integer,
         coalesce(jsonb_agg(p.movimiento_id order by p.created_at, p.movimiento_id), '[]'::jsonb)
    into v_n, v_movs
    from public.movimiento_bancario_cobro p
   where p.cobro_id = old.id;
  if v_n = 0 then
    return new;
  end if;
  raise exception using
    errcode = '23514',
    hint = 'COBRO_CONCILIADO',
    message = format('COBRO_CONCILIADO: el cobro tiene %s abono(s) del banco ligados: su %s no cambia mientras esté conciliado; desvincúlalo en Conciliación y vuelve a ligarlo',
                     v_n, array_to_string(v_campos, ', ')),
    detail = jsonb_build_object('cobro_id', old.id, 'abonos', v_n, 'campos', to_jsonb(v_campos),
                                'movimiento_ids', v_movs)::text;
end $fn_candado_cobro$;

comment on function public.tg_cobro_vuelo_abonos_candado() is
  'Trigger E (BEFORE UPDATE OF monto, moneda, comision_banco_monto, cobro_grupo_id, ingreso_anticipo_id en cobro_vuelo, 20261014000003): con abonos del banco ligados en la puente, esos campos no cambian (COBRO_CONCILIADO, hint = CODIGO, detail {cobro_id, abonos, campos, movimiento_ids}). Referencia, notas, fecha y T.C. siguen libres.';

drop trigger if exists trg_cobro_vuelo_abonos_candado on public.cobro_vuelo;
create trigger trg_cobro_vuelo_abonos_candado
  before update of monto, moneda, comision_banco_monto, cobro_grupo_id, ingreso_anticipo_id
  on public.cobro_vuelo
  for each row execute function public.tg_cobro_vuelo_abonos_candado();

-- ===========================================================================
-- 6) G — LIGAR UN ABONO CON 1..N COBROS (reemplazo)
-- ===========================================================================
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
  v_tipo_cuenta text;
  v_monto_abono numeric;
  v_n integer;
  v_distintos integer;
  v_c record;
  v_o record;
  v_neto numeric;
  v_faltante numeric;
  v_parte numeric;
  v_un_solo boolean;
  v_por text;
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

  select cb.moneda::text, cb.tipo into v_moneda_cuenta, v_tipo_cuenta
    from public.cuenta_bancaria cb
   where cb.id = v_mov.cuenta_bancaria_id;
  v_monto_abono := round(abs(v_mov.monto), 2);

  -- (4) Cada cobro, BLOQUEADO en orden de id (A repite la regla por fila al
  --     escribir; aquí se responde el lote completo con su detalle).
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
    if v_n >= 2 and v_moneda_cuenta is not null and v_c.moneda <> v_moneda_cuenta then
      raise exception using
        errcode = '23514',
        hint = 'LOTE_MONEDA_DISTINTA',
        message = format('LOTE_MONEDA_DISTINTA: el cobro del vuelo #%s está en %s y la cuenta en %s: en un abono con varios cobros todos van en la moneda de la cuenta', coalesce(v_c.folio::text, '?'), v_c.moneda, v_moneda_cuenta),
        detail = jsonb_build_object('cobro_id', v_c.id, 'folio', v_c.folio, 'moneda_cobro', v_c.moneda, 'moneda_cuenta', v_moneda_cuenta)::text;
    end if;

    -- Los OTROS abonos de este cobro (fuera de este movimiento).
    select count(*)::integer as n,
           count(*) filter (where cb.moneda::text is distinct from v_c.moneda)::integer as cruzadas,
           count(*) filter (where coalesce(cb.tipo, '') = 'PASARELA')::integer as pasarelas,
           round(coalesce(sum(p.monto_parte) filter (where cb.moneda::text = v_c.moneda), 0), 2) as suma,
           coalesce(jsonb_agg(p.movimiento_id order by m.fecha, m.created_at, p.movimiento_id), '[]'::jsonb) as movs
      into v_o
      from public.movimiento_bancario_cobro p
      join public.movimiento_bancario m on m.id = p.movimiento_id
      left join public.cuenta_bancaria cb on cb.id = m.cuenta_bancaria_id
     where p.cobro_id = v_c.id
       and p.movimiento_id <> p_movimiento_id;

    v_neto := public.neto_de_cobro(v_c.monto, v_c.comision_banco_monto);
    v_un_solo := coalesce(v_c.comision_banco_monto, 0) > 0
                 or coalesce(v_tipo_cuenta, '') = 'PASARELA'
                 or (v_moneda_cuenta is not null and v_c.moneda <> v_moneda_cuenta)
                 or v_o.cruzadas > 0
                 or v_o.pasarelas > 0;
    if v_o.n > 0 then
      if v_o.cruzadas > 0 or public.regla_cobro_cubierto(v_neto, v_o.n, false, v_o.suma) then
        raise exception using
          errcode = '23514',
          hint = 'COBRO_YA_CONCILIADO',
          message = format('COBRO_YA_CONCILIADO: el cobro del vuelo #%s ya está cubierto por %s abono(s) del banco', coalesce(v_c.folio::text, '?'), v_o.n),
          detail = jsonb_build_object('cobro_id', v_c.id, 'folio', v_c.folio, 'motivo', 'CUBIERTO',
                                      'neto', v_neto, 'suma_ligada', v_o.suma, 'abonos_otros', v_o.n,
                                      'movimiento_ids', v_o.movs, 'movimiento_id', v_o.movs->>0)::text;
      end if;
      if v_un_solo then
        v_por := case when (v_moneda_cuenta is not null and v_c.moneda <> v_moneda_cuenta) then 'MONEDA_DISTINTA'
                      when coalesce(v_tipo_cuenta, '') = 'PASARELA' or v_o.pasarelas > 0 then 'PASARELA'
                      else 'COMISION' end;
        raise exception using
          errcode = '23514',
          hint = 'COBRO_YA_CONCILIADO',
          message = format('COBRO_YA_CONCILIADO: el cobro del vuelo #%s se concilia con UN solo abono y ya tiene otro ligado', coalesce(v_c.folio::text, '?')),
          detail = jsonb_build_object('cobro_id', v_c.id, 'folio', v_c.folio, 'motivo', 'UN_SOLO_ABONO',
                                      'por', v_por, 'neto', v_neto, 'suma_ligada', v_o.suma,
                                      'abonos_otros', v_o.n, 'movimiento_ids', v_o.movs,
                                      'movimiento_id', v_o.movs->>0)::text;
      end if;
    end if;
    v_faltante := case when v_o.n = 0 then v_neto
                       else greatest(round(v_neto - v_o.suma, 2), 0) end;
    -- UN cobro ⇒ el abono completo (A decide si cuadra); LOTE ⇒ el faltante.
    v_parte := case when v_n = 1 then v_monto_abono else v_faltante end;
    v_suma := v_suma + v_parte;
    v_cobros := v_cobros || jsonb_build_object('id', v_c.id, 'folio', v_c.folio, 'vuelo_id', v_c.vuelo_id,
                                               'monto', round(v_c.monto, 2), 'neto', v_neto,
                                               'suma_otras', v_o.suma, 'abonos_otros', v_o.n,
                                               'faltante', v_faltante, 'parte', v_parte, 'pos', v_c.pos);
    v_nuevas := v_nuevas || jsonb_build_object('cobro_id', v_c.id, 'monto_parte', v_parte);
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

  -- (5) Cuadre del LOTE: |Σ faltantes − |abono|| ≤ tolerancia_lote(N). Con
  --     UN cobro, A decide (pago parcial, de más o con comisión).
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
  --     demás (A valida cada fila; B recalcula los espejos del abono).
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
  'RPC G (API 0.0.71; M:N desde 20261014000003, API 0.0.78): liga un ABONO con 1..N cobros en UNA transacción. 1 cobro ⇒ parte = |abono| y A decide (parcial, de más, comisión, otra moneda). N ≥ 2 ⇒ moneda de la cuenta (LOTE_MONEDA_DISTINTA), parte = FALTANTE de cada cobro (neto − Σ de sus otros abonos) y |Σ − |abono|| ≤ tolerancia_lote(N) (ABONO_NO_CUADRA). Cobro ya cubierto o «de un solo abono» con otro ⇒ COBRO_YA_CONCILIADO (detail.motivo CUBIERTO | UN_SOLO_ABONO). Devuelve {movimiento_id, partes, salientes, anteriores, cobros[{id, folio, vuelo_id, monto, neto, suma_otras, abonos_otros, faltante, parte, pos}]}.';

-- ===========================================================================
-- 7) PERMISOS — nada se expone a anon/authenticated; el API usa la service
--    key. (Los reemplazos conservan los permisos de 20261012000002.)
-- ===========================================================================
revoke all on table public.v_cobro_conciliacion from public, anon, authenticated;
grant select on table public.v_cobro_conciliacion to service_role;
revoke execute on function public.neto_de_cobro(numeric, numeric) from public, anon, authenticated;
grant execute on function public.neto_de_cobro(numeric, numeric) to service_role;
revoke execute on function public.regla_cobro_cubierto(numeric, integer, boolean, numeric) from public, anon, authenticated;
grant execute on function public.regla_cobro_cubierto(numeric, integer, boolean, numeric) to service_role;
revoke execute on function public.tg_cobro_vuelo_abonos_candado() from public, anon, authenticated;
grant execute on function public.tg_cobro_vuelo_abonos_candado() to service_role;

-- ===========================================================================
-- 8) VERIFICACIÓN FINAL (aborta si algo no quedó)
-- ===========================================================================
do $ver$
declare
  v_n integer;
begin
  if to_regprocedure('public.neto_de_cobro(numeric, numeric)') is null
     or to_regprocedure('public.regla_cobro_cubierto(numeric, integer, boolean, numeric)') is null
     or to_regprocedure('public.tg_cobro_vuelo_abonos_candado()') is null
     or to_regclass('public.v_cobro_conciliacion') is null
     or to_regclass('public.idx_mov_cobro_parte_cobro') is null then
    raise exception 'VERIFICACIÓN: falta una función, la vista o el índice nuevo';
  end if;
  if to_regclass('public.uq_mov_cobro_parte_cobro') is not null
     or to_regclass('public.uq_mov_bancario_cobro') is not null then
    raise exception 'VERIFICACIÓN: sigue un índice único que impide varios abonos por cobro';
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.cobro_vuelo'::regclass
                    and t.tgname = 'trg_cobro_vuelo_abonos_candado' and not t.tgisinternal) then
    raise exception 'VERIFICACIÓN: falta el trigger trg_cobro_vuelo_abonos_candado';
  end if;
  if not exists (select 1 from pg_trigger t
                  where t.tgrelid = 'public.movimiento_bancario'::regclass
                    and t.tgname = 'trg_mov_bancario_cobros_coherentes'
                    and t.tgdeferrable and t.tginitdeferred
                    and pg_get_triggerdef(t.oid) like '%cuenta_bancaria_id%'
                    and pg_get_triggerdef(t.oid) like '%monto%') then
    raise exception 'VERIFICACIÓN: el constraint trigger K no quedó diferido o no escucha monto y cuenta';
  end if;
  if not public.regla_cobro_cubierto(1, 1, false, 1) then
    raise exception 'VERIFICACIÓN: regla_cobro_cubierto(1, 1, false, 1) debe ser true (es la sonda del API)';
  end if;
  select count(*) into v_n
    from public.movimiento_bancario m
   where m.cobros_n > 0
     and public.motivo_cobros_incoherentes(m.id) is not null;
  if v_n > 0 then
    raise exception 'VERIFICACIÓN: % abono(s) con sus cobros incoherentes', v_n;
  end if;
  select count(*) into v_n from public.v_cobro_conciliacion e where e.sobrante > 1.00;
  if v_n > 0 then
    raise notice 'AVISO: % cobro(s) quedan cobrados de MÁS en el banco (sobrante > $1.00): revisarlos en Conciliación', v_n;
  end if;
end $ver$;

-- <<< CUERPO

select pg_notify('pgrst', 'reload schema');
