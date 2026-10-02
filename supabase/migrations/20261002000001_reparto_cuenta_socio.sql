-- 2-oct-2026 · CUENTA CORRIENTE DEL SOCIO (pagos de utilidades v2).
--
-- Aclaración del cliente (1-oct-2026, audio): «cuando el socio dice:
-- necesito que me adelanten 70,000 pesos de mis utilidades, necesitamos
-- poder grabarlo en algún lado y que se lleve el HISTÓRICO de cuánto se le
-- ha ido repartiendo a los socios, cuánto falta por repartir, cómo se le
-- repartió (transferencia o efectivo), la fecha de la entrega y algún
-- comprobante escaneado». Es una CUENTA CORRIENTE por socio, no un estatus
-- por mes y por avión (v1, migración 20261001000001, 0 filas en prod).
--
-- MODELO (invariante 38 v2):
--   saldo del socio (por entregar) = saldo_inicial_usd
--                                  + Σ utilidades generadas (compute() mes a
--                                    mes desde cuenta_desde hasta el mes en
--                                    curso, por avión — NO se guardan aquí)
--                                  − Σ entregas vivas (reparto_pago, todas,
--                                    con o sin «corresponde a»).
--   |saldo| ≤ 1.00 ⇒ AL_CORRIENTE; > 1.00 ⇒ POR_ENTREGAR; < −1.00 ⇒
--   ADELANTADO (se le entregó más de lo generado: un adelanto es legítimo).
--   El candado del ADELANTO (409 del API) y el aviso «adelantados» del
--   pre-cierre miden lo por entregar SIN el mes en curso (meses cerrados).
--
-- QUÉ CAMBIA (sin enums ni backfill; UNA función nueva: la de la bitácora):
--   1) public.reparto_pago pasa a ser la ENTREGA al socio:
--      - `periodo` y `aeronave_id` pasan a NULL-ables: son «corresponde a»
--        (mes / avión) INFORMATIVOS; un adelanto a cuenta no trae ninguno.
--        Sin relación obligatoria entre los dos (un mes sin avión es válido).
--      - el CHECK de `periodo` (día 1) aplica SOLO si no es null.
--      - `utilidad_snapshot_usd` NULL-able (foto de la v1; la v2 SIEMPRE la
--        deja null, también con avión y mes).
--      - columna nueva `saldo_snapshot_usd numeric(12,2)`: lo POR ENTREGAR
--        del socio de meses cerrados ANTES de la entrega (informativo; puede
--        ser negativo). Es además la SONDA del API 0.0.50 (columna ausente ⇒
--        «la migración no está aplicada»).
--      - columna nueva `updated_by` (FK usuario, on delete set null): quién
--        corrigió por última vez; el API la sella en TODA escritura.
--      - índice `(socio_id, fecha_pago) where deleted_at is null` (la v2 lee
--        por socio y por fecha); se retira `idx_reparto_pago_periodo` (solo
--        lo usaba el pre-cierre por mes de la v1). El índice
--        `(aeronave_id, socio_id, periodo)` se QUEDA: cubre la FK de avión.
--   2) public.reparto_cuenta_socio (una fila por socio, opcional): desde qué
--      MES cuenta la cuenta (`cuenta_desde`, día 1) y con qué saldo arranca
--      (`saldo_inicial_usd`: positivo = se le debía al arrancar; negativo =
--      ya se le había adelantado). SIN fila ⇒ el API usa el default
--      2026-09-01 con saldo 0 y responde `configurada:false` (el panel
--      invita a ajustarla). RLS sin policies (la API usa service key);
--      `trg_reparto_cuenta_socio_set_updated_at` con public.tg_set_updated_at().
--   3) public.reparto_bitacora + public.tg_reparto_bitacora() (patrón
--      tg_gasto_bitacora) con triggers AFTER INSERT/UPDATE/DELETE en las DOS
--      tablas: cada alta, corrección de dinero, cambio de comprobante o baja
--      de una entrega, y cada cambio del arranque/saldo inicial de una
--      cuenta, guarda el ANTES y el DESPUÉS de las columnas de negocio, quién
--      (updated_by; deleted_by en la baja; created_by en el alta) y cuándo.
--      Atómico con la escritura (mismo statement). RLS sin policies.
--
-- LO QUE NO CAMBIA: el cálculo del reparto (compute), el PDF/Excel, el
-- Libro Dinero y el balance. Una entrega NO es gasto ni toca otra tabla.
-- `moneda`/`metodo` siguen siendo TEXTO + CHECK (no el enum public.moneda):
-- la función de la bitácora no compara monedas (solo copia jsonb).
--
-- EL API 0.0.50 ES DESPLEGABLE SIN ESTA MIGRACIÓN (sonda ÚNICA
-- `profit-sharing/reparto-cuenta.lector.ts` sobre
-- `reparto_pago.saldo_snapshot_usd`, re-sondeo ≤ 10 min): las LECTURAS
-- nuevas (`GET socios`, `GET socios/:id/estado-cuenta`, `GET pagos`)
-- responden `disponible:false`, las ESCRITURAS 503
-- CUENTA_SOCIO_NO_DISPONIBLE y el pre-cierre marca `socios_por_entregar`
-- con `lectura_fallida`. Al aplicarla se enciende sola.
--
-- ---------------------------------------------------------------------------
-- DRY-RUN OBLIGATORIO ANTES DE APLICAR (escrituras REALES que se revierten).
-- Es UNA sola sentencia `do $dry$ … $dry$;` AUTOCONTENIDA: la sección B ya
-- trae el cuerpo de la migración (la sección 1 de abajo, generada por el
-- mismo script: no se pega nada). Para ejecutarla, quitar el prefijo
-- «--   » (dos guiones y tres espacios) de cada línea entre `--   do $dry$`
-- y `--   end $dry$;` inclusive; las líneas que son solo «--» quedan
-- vacías. TERMINA con `raise exception 'DRYRUN_OK …'` ⇒ Postgres revierte
-- TODO (DDL, función, triggers y filas) aunque la herramienta haga
-- autocommit. Cualquier 'DRYRUN_FALLA …' o CUALQUIER otro error (42883
-- «operator does not exist», un not_null_violation inesperado…) = NO
-- aplicar. Prueba los TRIGGERS con INSERT/UPDATE REALES (regla del repo).
-- Tras el error DRYRUN_OK:
--   select to_regclass('public.reparto_cuenta_socio');            ⇒ NULL
--   select to_regclass('public.reparto_bitacora');                ⇒ NULL
--   select to_regprocedure('public.tg_reparto_bitacora()');       ⇒ NULL
--   select count(*) from information_schema.columns
--    where table_schema = 'public' and table_name = 'reparto_pago'
--      and column_name in ('saldo_snapshot_usd', 'updated_by');  ⇒ 0
--   select is_nullable from information_schema.columns
--    where table_schema = 'public' and table_name = 'reparto_pago'
--      and column_name = 'periodo';                               ⇒ NO
--   select count(*) from public.reparto_pago;                     ⇒ el mismo de antes (0 el 1-oct)
--
--   do $dry$
--   declare
--     v_avion uuid; v_matricula text; v_socio uuid; v_socio_nombre text;
--     v_admin uuid; v_adelanto uuid; v_entrega uuid; v_mes uuid; v_key uuid;
--     v_n int; v_n0 int; v_txt text; v_num numeric; v_upd timestamptz;
--     v_created_by uuid; v_bit jsonb; v_actor uuid;
--   begin
--     -- A) CONTEXTO: la v1 aplicada, la v2 NO; un socio VIGENTE en
--     --    septiembre 2026 (de preferencia N4142R, Mauricio Roque 69 %) y un
--     --    ADMIN activo.
--     if to_regclass('public.reparto_pago') is null then
--       raise exception 'DRYRUN_FALLA A: falta reparto_pago (aplicar antes 20261001000001)';
--     end if;
--     if to_regclass('public.reparto_cuenta_socio') is not null then
--       raise exception 'DRYRUN_FALLA A: reparto_cuenta_socio YA existe (¿migración aplicada?)';
--     end if;
--     if to_regclass('public.reparto_bitacora') is not null
--        or to_regprocedure('public.tg_reparto_bitacora()') is not null then
--       raise exception 'DRYRUN_FALLA A: la bitácora (tabla o función) YA existe';
--     end if;
--     if exists (select 1 from information_schema.columns
--                 where table_schema = 'public' and table_name = 'reparto_pago'
--                   and column_name in ('saldo_snapshot_usd', 'updated_by')) then
--       raise exception 'DRYRUN_FALLA A: reparto_pago.saldo_snapshot_usd/updated_by YA existe';
--     end if;
--     if to_regprocedure('public.tg_set_updated_at()') is null then
--       raise exception 'DRYRUN_FALLA A: falta public.tg_set_updated_at()';
--     end if;
--     select count(*) into v_n0 from public.reparto_pago;
--     select a.id, a.matricula, s.socio_id into v_avion, v_matricula, v_socio
--       from public.aeronave_socio s
--       join public.aeronave a on a.id = s.aeronave_id
--      where s.vigente_desde <= date '2026-09-30'
--        and (s.vigente_hasta is null or s.vigente_hasta >= date '2026-09-01')
--      order by (a.matricula = 'N4142R') desc, s.porcentaje desc, s.id
--      limit 1;
--     select u.nombre into v_socio_nombre from public.usuario u where u.id = v_socio;
--     select u.id into v_admin from public.usuario u
--      where u.rol::text = 'ADMIN' and u.estado::text = 'ACTIVO'
--      order by u.created_at, u.id limit 1;
--     if v_avion is null or v_socio is null or v_admin is null then
--       raise exception 'DRYRUN_FALLA A: sin contexto (avión/socio/admin)';
--     end if;
--     raise notice 'okA · % · socio % (%) · admin % · reparto_pago con % fila(s)',
--       v_matricula, v_socio_nombre, v_socio, v_admin, v_n0;
--
--     -- B) CUERPO REAL DE LA MIGRACIÓN: la sección 1) de abajo, TAL CUAL
--     --    (idéntica byte a byte salvo el prefijo de comentario; la genera el
--     --    mismo script y la revisión lo compara). Ya viene incluida: el
--     --    dry-run se ejecuta sin pegar nada.
--     -- 1.a) reparto_pago = ENTREGA al socio; «corresponde a» mes/avión opcional.
--     alter table public.reparto_pago alter column periodo drop not null;
--     alter table public.reparto_pago alter column aeronave_id drop not null;
--     alter table public.reparto_pago alter column utilidad_snapshot_usd drop not null;
--     alter table public.reparto_pago drop constraint if exists reparto_pago_periodo_chk;
--     alter table public.reparto_pago add constraint reparto_pago_periodo_chk
--       check (periodo is null or extract(day from periodo) = 1);
--     alter table public.reparto_pago add column if not exists saldo_snapshot_usd numeric(12,2);
--     -- Quién corrigió por última vez (el API lo sella en TODA escritura; la
--     -- bitácora lo toma como actor). FK aparte del ADD COLUMN: re-aplicar no
--     -- duplica la constraint.
--     alter table public.reparto_pago add column if not exists updated_by uuid;
--     alter table public.reparto_pago drop constraint if exists reparto_pago_updated_by_fkey;
--     alter table public.reparto_pago add constraint reparto_pago_updated_by_fkey
--       foreign key (updated_by) references public.usuario(id) on delete set null;
--
--     drop index if exists public.idx_reparto_pago_periodo;
--     create index if not exists idx_reparto_pago_socio_fecha
--       on public.reparto_pago (socio_id, fecha_pago)
--       where deleted_at is null;
--
--     comment on table public.reparto_pago is
--       'Entregas de utilidades a socios (cuenta corriente, v2 2-oct-2026): una fila por entrega (transferencia, efectivo, cheque u otro). El saldo del socio = saldo inicial (reparto_cuenta_socio) + utilidades generadas (profit-sharing compute mes a mes, NO se guardan) − entregas vivas. Soft delete: todo lector filtra deleted_at is null. Historial de cambios en reparto_bitacora (trigger). Sin enums: moneda/metodo son texto + CHECK.';
--     comment on column public.reparto_pago.periodo is
--       'Informativo: mes al que «corresponde» la entrega (día 1, CHECK solo si no es null). NULL = adelanto a cuenta.';
--     comment on column public.reparto_pago.aeronave_id is
--       'Informativo: avión al que «corresponde» la entrega (el socio debe serlo de ese avión). NULL = de toda su cuenta.';
--     comment on column public.reparto_pago.utilidad_snapshot_usd is
--       'Legado de la v1 (utilidad del socio en el avión y mes al registrar). La v2 no lo escribe (null).';
--     comment on column public.reparto_pago.saldo_snapshot_usd is
--       'Lo por entregar del socio de MESES CERRADOS (sin el mes en curso) ANTES de esta entrega, al registrarla (o al corregir su dinero): el número contra el que se decidió si era adelanto. Informativo; negativo = ya estaba adelantado.';
--     comment on column public.reparto_pago.monto_usd is
--       'Lo que la entrega descuenta del saldo del socio. USD = monto (CHECK); MXN = round(monto / tc_usd_mxn, 2), calculado por el API.';
--     comment on column public.reparto_pago.updated_by is
--       'Quién corrigió la entrega por última vez (el API lo sella en cada escritura: corrección, comprobante, baja). Actor de reparto_bitacora.';
--
--     -- 1.b) Configuración de la cuenta por socio (opcional: sin fila = default).
--     create table if not exists public.reparto_cuenta_socio (
--       socio_id uuid primary key references public.usuario(id) on delete restrict,
--       cuenta_desde date not null,
--       saldo_inicial_usd numeric(12,2) not null default 0,
--       notas text,
--       created_by uuid references public.usuario(id) on delete set null,
--       created_at timestamptz not null default now(),
--       updated_by uuid references public.usuario(id) on delete set null,
--       updated_at timestamptz not null default now(),
--       constraint reparto_cuenta_socio_desde_chk check (extract(day from cuenta_desde) = 1),
--       constraint reparto_cuenta_socio_notas_chk check (
--         notas is null or char_length(notas) <= 500)
--     );
--
--     comment on table public.reparto_cuenta_socio is
--       'Cuenta corriente del socio (2-oct-2026): desde qué mes cuenta y con qué saldo arranca. Sin fila ⇒ el API usa 2026-09-01 con saldo 0 (configurada:false). Las utilidades NO se guardan: salen de profit-sharing compute mes a mes. Cada cambio del arranque/saldo inicial queda en reparto_bitacora (trigger).';
--     comment on column public.reparto_cuenta_socio.cuenta_desde is
--       'Primer mes que suma utilidades a la cuenta: SIEMPRE el día 1 (CHECK).';
--     comment on column public.reparto_cuenta_socio.saldo_inicial_usd is
--       'Saldo al arrancar la cuenta, en USD: positivo = se le debía al socio; negativo = ya se le había adelantado.';
--
--     alter table public.reparto_cuenta_socio enable row level security;
--
--     drop trigger if exists trg_reparto_cuenta_socio_set_updated_at on public.reparto_cuenta_socio;
--     create trigger trg_reparto_cuenta_socio_set_updated_at
--       before update on public.reparto_cuenta_socio
--       for each row execute function public.tg_set_updated_at();
--
--     -- 1.c) BITÁCORA del dinero entregado a socios (patrón tg_gasto_bitacora):
--     --      cada alta, corrección, baja o cambio de comprobante de una entrega y
--     --      cada cambio del arranque/saldo inicial de una cuenta deja el ANTES y
--     --      el DESPUÉS de las columnas de negocio, quién y cuándo. Sin FK a
--     --      propósito: sobrevive a un DELETE físico (que el API nunca hace).
--     create table if not exists public.reparto_bitacora (
--       id uuid primary key default gen_random_uuid(),
--       tabla text not null,
--       registro_id uuid not null,
--       socio_id uuid,
--       accion text not null,
--       actor_id uuid,
--       diff jsonb not null default '{}'::jsonb,
--       snapshot jsonb,
--       created_at timestamptz not null default now(),
--       constraint reparto_bitacora_tabla_chk check (
--         tabla in ('reparto_pago', 'reparto_cuenta_socio')),
--       constraint reparto_bitacora_accion_chk check (
--         accion in ('INSERT', 'UPDATE', 'DELETE'))
--     );
--     create index if not exists idx_reparto_bitacora_registro
--       on public.reparto_bitacora (tabla, registro_id, created_at);
--     create index if not exists idx_reparto_bitacora_socio
--       on public.reparto_bitacora (socio_id, created_at);
--     alter table public.reparto_bitacora enable row level security;
--
--     comment on table public.reparto_bitacora is
--       'Historial (trigger tg_reparto_bitacora) de las entregas a socios (reparto_pago) y de la configuración de sus cuentas (reparto_cuenta_socio): diff {columna: {antes, despues}} de las columnas de negocio, actor = updated_by (o deleted_by en la baja; created_by en el alta). registro_id = reparto_pago.id o reparto_cuenta_socio.socio_id. Sin FK a propósito.';
--
--     create or replace function public.tg_reparto_bitacora()
--     returns trigger language plpgsql
--     set search_path = ''
--     as $fn$
--     declare
--       -- Solo columnas de NEGOCIO: los sellos (updated_at/updated_by) y la llave
--       -- de idempotencia no inundan la bitácora.
--       cols text[];
--       v_old jsonb;
--       v_new jsonb;
--       v_diff jsonb := '{}'::jsonb;
--       v_actor uuid;
--       c text;
--     begin
--       if tg_table_name = 'reparto_pago' then
--         cols := array[
--           'socio_id','aeronave_id','periodo','monto','moneda','tc_usd_mxn',
--           'monto_usd','saldo_snapshot_usd','fecha_pago','metodo','referencia',
--           'entregado_por','recibido_por','factura_folio','comprobante_path',
--           'notas','deleted_at','deleted_by','motivo_baja'
--         ];
--       else
--         cols := array['cuenta_desde','saldo_inicial_usd','notas'];
--       end if;
--
--       if tg_op = 'DELETE' then
--         v_old := to_jsonb(old);
--         insert into public.reparto_bitacora
--           (tabla, registro_id, socio_id, accion, actor_id, diff, snapshot)
--         values (
--           tg_table_name,
--           coalesce((v_old->>'id')::uuid, (v_old->>'socio_id')::uuid),
--           (v_old->>'socio_id')::uuid,
--           'DELETE',
--           (v_old->>'updated_by')::uuid,
--           '{}'::jsonb,
--           v_old);
--         return old;
--       end if;
--
--       v_new := to_jsonb(new);
--       if tg_op = 'INSERT' then
--         foreach c in array cols loop
--           if v_new->c is not null and v_new->c <> 'null'::jsonb then
--             v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', null, 'despues', v_new->c));
--           end if;
--         end loop;
--         v_actor := coalesce((v_new->>'created_by')::uuid, (v_new->>'updated_by')::uuid);
--       else
--         v_old := to_jsonb(old);
--         foreach c in array cols loop
--           if v_old->c is distinct from v_new->c then
--             v_diff := v_diff || jsonb_build_object(c, jsonb_build_object('antes', v_old->c, 'despues', v_new->c));
--           end if;
--         end loop;
--         -- Sin cambio de negocio (solo sellos): sin fila.
--         if v_diff = '{}'::jsonb then
--           return new;
--         end if;
--         -- Baja (soft delete): quien la dio de baja; si no, quien corrigió.
--         if (v_old->>'deleted_at') is null and (v_new->>'deleted_at') is not null then
--           v_actor := coalesce((v_new->>'deleted_by')::uuid, (v_new->>'updated_by')::uuid);
--         else
--           v_actor := (v_new->>'updated_by')::uuid;
--         end if;
--       end if;
--
--       insert into public.reparto_bitacora
--         (tabla, registro_id, socio_id, accion, actor_id, diff)
--       values (
--         tg_table_name,
--         coalesce((v_new->>'id')::uuid, (v_new->>'socio_id')::uuid),
--         (v_new->>'socio_id')::uuid,
--         tg_op,
--         v_actor,
--         v_diff);
--       return new;
--     end $fn$;
--
--     comment on function public.tg_reparto_bitacora() is
--       'Bitácora de reparto_pago y reparto_cuenta_socio (2-oct-2026): AFTER INSERT/UPDATE/DELETE ⇒ public.reparto_bitacora con el antes/después de las columnas de negocio.';
--
--     drop trigger if exists trg_reparto_pago_bitacora on public.reparto_pago;
--     create trigger trg_reparto_pago_bitacora
--       after insert or update or delete on public.reparto_pago
--       for each row execute function public.tg_reparto_bitacora();
--
--     drop trigger if exists trg_reparto_cuenta_socio_bitacora on public.reparto_cuenta_socio;
--     create trigger trg_reparto_cuenta_socio_bitacora
--       after insert or update or delete on public.reparto_cuenta_socio
--       for each row execute function public.tg_reparto_bitacora();
--     -- C1) ESTRUCTURA: tablas nuevas con RLS sin policies, PK, FKs, triggers;
--     --     reparto_pago con las 3 columnas NULL-ables, las 2 columnas nuevas,
--     --     el índice nuevo y el viejo de periodo retirado; función con
--     --     search_path fijo.
--     if to_regclass('public.reparto_cuenta_socio') is null
--        or to_regclass('public.reparto_bitacora') is null then
--       raise exception 'DRYRUN_FALLA C1: faltan reparto_cuenta_socio o reparto_bitacora';
--     end if;
--     if not (select relrowsecurity from pg_class where oid = 'public.reparto_cuenta_socio'::regclass)
--        or not (select relrowsecurity from pg_class where oid = 'public.reparto_bitacora'::regclass) then
--       raise exception 'DRYRUN_FALLA C1: RLS apagado';
--     end if;
--     if exists (select 1 from pg_policies where schemaname = 'public'
--                 and tablename in ('reparto_cuenta_socio', 'reparto_bitacora')) then
--       raise exception 'DRYRUN_FALLA C1: las tablas traen policies (la API usa service key)';
--     end if;
--     select string_agg(conname || '=' || confdeltype::text, ',' order by conname) into v_txt
--       from pg_constraint
--      where conrelid = 'public.reparto_cuenta_socio'::regclass and contype = 'f';
--     if v_txt is distinct from
--        'reparto_cuenta_socio_created_by_fkey=n,reparto_cuenta_socio_socio_id_fkey=r,reparto_cuenta_socio_updated_by_fkey=n' then
--       raise exception 'DRYRUN_FALLA C1: FKs inesperadas: %', v_txt;
--     end if;
--     select string_agg(conname || '=' || confdeltype::text, ',' order by conname) into v_txt
--       from pg_constraint
--      where conrelid = 'public.reparto_pago'::regclass and contype = 'f'
--        and conname = 'reparto_pago_updated_by_fkey';
--     if v_txt is distinct from 'reparto_pago_updated_by_fkey=n' then
--       raise exception 'DRYRUN_FALLA C1: FK de reparto_pago.updated_by: %', v_txt;
--     end if;
--     if not exists (select 1 from pg_constraint
--                     where conrelid = 'public.reparto_cuenta_socio'::regclass and contype = 'p') then
--       raise exception 'DRYRUN_FALLA C1: falta la PK (socio_id)';
--     end if;
--     select string_agg(tgname, ',' order by tgname) into v_txt
--       from pg_trigger
--      where not tgisinternal
--        and tgrelid in ('public.reparto_cuenta_socio'::regclass, 'public.reparto_pago'::regclass)
--        and tgname in ('trg_reparto_cuenta_socio_set_updated_at', 'trg_reparto_cuenta_socio_bitacora',
--                       'trg_reparto_pago_bitacora', 'trg_reparto_pago_set_updated_at');
--     if v_txt is distinct from
--        'trg_reparto_cuenta_socio_bitacora,trg_reparto_cuenta_socio_set_updated_at,trg_reparto_pago_bitacora,trg_reparto_pago_set_updated_at' then
--       raise exception 'DRYRUN_FALLA C1: triggers inesperados: %', v_txt;
--     end if;
--     select array_to_string(proconfig, ',') into v_txt
--       from pg_proc where oid = 'public.tg_reparto_bitacora()'::regprocedure;
--     if v_txt is null or v_txt not like 'search_path=%' then
--       raise exception 'DRYRUN_FALLA C1: tg_reparto_bitacora sin search_path fijo (%)', v_txt;
--     end if;
--     select string_agg(column_name || '=' || is_nullable, ',' order by column_name) into v_txt
--       from information_schema.columns
--      where table_schema = 'public' and table_name = 'reparto_pago'
--        and column_name in ('aeronave_id', 'periodo', 'saldo_snapshot_usd', 'utilidad_snapshot_usd',
--                            'socio_id', 'updated_by');
--     if v_txt is distinct from
--        'aeronave_id=YES,periodo=YES,saldo_snapshot_usd=YES,socio_id=NO,updated_by=YES,utilidad_snapshot_usd=YES' then
--       raise exception 'DRYRUN_FALLA C1: nulabilidad inesperada en reparto_pago: %', v_txt;
--     end if;
--     select numeric_scale into v_n from information_schema.columns
--      where table_schema = 'public' and table_name = 'reparto_pago' and column_name = 'saldo_snapshot_usd';
--     if v_n is distinct from 2 then
--       raise exception 'DRYRUN_FALLA C1: saldo_snapshot_usd con escala % (esperado 2)', v_n;
--     end if;
--     select numeric_scale into v_n from information_schema.columns
--      where table_schema = 'public' and table_name = 'reparto_cuenta_socio' and column_name = 'saldo_inicial_usd';
--     if v_n is distinct from 2 then
--       raise exception 'DRYRUN_FALLA C1: saldo_inicial_usd con escala % (esperado 2)', v_n;
--     end if;
--     if to_regclass('public.idx_reparto_pago_socio_fecha') is null
--        or to_regclass('public.idx_reparto_pago_periodo') is not null
--        or to_regclass('public.idx_reparto_pago_aeronave_socio_periodo') is null
--        or to_regclass('public.uq_reparto_pago_client_request') is null
--        or to_regclass('public.idx_reparto_bitacora_registro') is null
--        or to_regclass('public.idx_reparto_bitacora_socio') is null then
--       raise exception 'DRYRUN_FALLA C1: índices inesperados';
--     end if;
--     raise notice 'okC1 · tablas, RLS, PK, FKs, triggers, search_path, nulabilidad, escala 2, índices';
--
--     -- C2) ENTREGAS REALES como las escribe el API 0.0.50 (el alta no sella
--     --     updated_by) y su renglón INSERT en la bitácora (actor = created_by):
--     --     (a) el caso del audio: ADELANTO A CUENTA de $70,000 MXN a 18.5 en
--     --         efectivo, sin mes ni avión: monto_usd = round(70000/18.5, 2)
--     --         = 3,783.78; por entregar ANTES = 1,395.94 (69 % de $2,023.10);
--     --     (b) entrega que «corresponde a» septiembre y al avión (como la v1);
--     --     (c) entrega que corresponde a septiembre SIN avión.
--     v_key := gen_random_uuid();
--     insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda,
--            tc_usd_mxn, monto_usd, utilidad_snapshot_usd, saldo_snapshot_usd, fecha_pago,
--            metodo, entregado_por, recibido_por, client_request_id, created_by)
--     values (null, v_socio, null, 70000.00, 'MXN', 18.5, round(70000.00 / 18.5, 2), null,
--             1395.94, date '2026-10-01', 'EFECTIVO', v_admin, 'El socio en persona', v_key, v_admin)
--     returning id into v_adelanto;
--     select monto_usd into v_num from public.reparto_pago where id = v_adelanto;
--     if v_num <> 3783.78 then
--       raise exception 'DRYRUN_FALLA C2: monto_usd del adelanto = % (esperado 3783.78)', v_num;
--     end if;
--     insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda,
--            monto_usd, saldo_snapshot_usd, fecha_pago, metodo, referencia, entregado_por, created_by)
--     values (v_avion, v_socio, date '2026-09-01', 100.00, 'USD', 100.00, -2387.84,
--             date '2026-10-01', 'TRANSFERENCIA', 'SPEI 0012345', v_admin, v_admin)
--     returning id into v_entrega;
--     insert into public.reparto_pago (aeronave_id, socio_id, periodo, monto, moneda,
--            monto_usd, saldo_snapshot_usd, fecha_pago, metodo, entregado_por, created_by)
--     values (null, v_socio, date '2026-09-01', 50.00, 'USD', 50.00, -2487.84,
--             date '2026-10-01', 'CHEQUE', v_admin, v_admin)
--     returning id into v_mes;
--     if exists (select 1 from public.reparto_pago where id in (v_adelanto, v_entrega, v_mes)
--                 and (deleted_at is not null or created_at is null or updated_at is null
--                      or updated_by is not null)) then
--       raise exception 'DRYRUN_FALLA C2: defaults de sellos/baja';
--     end if;
--     select count(*) into v_n from public.reparto_bitacora
--      where tabla = 'reparto_pago' and registro_id in (v_adelanto, v_entrega, v_mes)
--        and accion = 'INSERT' and actor_id = v_admin and socio_id = v_socio;
--     if v_n <> 3 then
--       raise exception 'DRYRUN_FALLA C2: bitácora de altas = % (esperado 3)', v_n;
--     end if;
--     select diff into v_bit from public.reparto_bitacora
--      where registro_id = v_adelanto and accion = 'INSERT';
--     if (v_bit->'monto'->>'despues')::numeric <> 70000
--        or v_bit->'moneda'->>'despues' <> 'MXN'
--        or (v_bit->'monto_usd'->>'despues')::numeric <> 3783.78
--        or (v_bit -> 'aeronave_id') is not null or (v_bit -> 'referencia') is not null then
--       raise exception 'DRYRUN_FALLA C2: diff del alta inesperado: %', v_bit;
--     end if;
--     raise notice 'okC2 · adelanto a cuenta 70,000 MXN = 3,783.78 USD · con mes y avión · con mes sin avión · 3 altas en la bitácora';
--
--     -- C3) CHECKs / FKs que DEBEN seguir reventando (y el de periodo nuevo).
--     begin insert into public.reparto_pago (socio_id, periodo, monto, moneda, monto_usd, fecha_pago, metodo, entregado_por)
--       values (v_socio, date '2026-09-15', 10, 'USD', 10, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C3: periodo con día 15'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (socio_id, monto, moneda, monto_usd, fecha_pago, metodo, entregado_por)
--       values (v_socio, 100, 'MXN', 5.48, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C3: MXN sin TC'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (socio_id, monto, moneda, monto_usd, fecha_pago, metodo, entregado_por)
--       values (v_socio, 100, 'USD', 99, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C3: USD con monto_usd ≠ monto'; exception when check_violation then null; end;
--     begin insert into public.reparto_pago (socio_id, monto, moneda, monto_usd, fecha_pago, metodo, entregado_por)
--       values (null, 100, 'USD', 100, date '2026-10-01', 'EFECTIVO', v_admin);
--       raise exception 'DRYRUN_FALLA C3: socio null'; exception when not_null_violation then null; end;
--     begin update public.reparto_pago set aeronave_id = gen_random_uuid() where id = v_adelanto;
--       raise exception 'DRYRUN_FALLA C3: avión inexistente'; exception when foreign_key_violation then null; end;
--     begin update public.reparto_pago set updated_by = gen_random_uuid() where id = v_adelanto;
--       raise exception 'DRYRUN_FALLA C3: updated_by inexistente'; exception when foreign_key_violation then null; end;
--     begin update public.reparto_pago set client_request_id = v_key where id = v_mes;
--       raise exception 'DRYRUN_FALLA C3: client_request_id repetido'; exception when unique_violation then null; end;
--     begin insert into public.reparto_bitacora (tabla, registro_id, accion) values ('gasto', v_socio, 'UPDATE');
--       raise exception 'DRYRUN_FALLA C3: bitácora con tabla ajena'; exception when check_violation then null; end;
--     select count(*) into v_n from public.reparto_bitacora
--      where registro_id in (v_adelanto, v_entrega, v_mes);
--     if v_n <> 3 then
--       raise exception 'DRYRUN_FALLA C3: los rechazos dejaron % renglones en la bitácora (esperado 3)', v_n;
--     end if;
--     raise notice 'okC3 · periodo día 1 solo si no es null; CHECKs, FKs y único de siempre; los rechazos no dejan bitácora';
--
--     -- C4) CUENTA DEL SOCIO: alta REAL (como el PUT del API: INSERT si no
--     --     hay fila, UPDATE si la hay — jamás un upsert que pise created_by),
--     --     trigger de updated_at con un UPDATE REAL, saldo inicial negativo
--     --     válido, rechazos y su HISTORIAL en la bitácora (antes/después).
--     insert into public.reparto_cuenta_socio (socio_id, cuenta_desde, saldo_inicial_usd, notas, created_by, updated_by)
--     values (v_socio, date '2026-09-01', 0, null, v_admin, v_admin);
--     select created_by into v_created_by from public.reparto_cuenta_socio where socio_id = v_socio;
--     if v_created_by is distinct from v_admin then
--       raise exception 'DRYRUN_FALLA C4: created_by no quedó';
--     end if;
--     update public.reparto_cuenta_socio set updated_at = '2000-01-01' where socio_id = v_socio;
--     select updated_at into v_upd from public.reparto_cuenta_socio where socio_id = v_socio;
--     if v_upd < '2001-01-01' then
--       raise exception 'DRYRUN_FALLA C4: tg_set_updated_at no corre en reparto_cuenta_socio';
--     end if;
--     update public.reparto_cuenta_socio
--        set cuenta_desde = date '2026-08-01', saldo_inicial_usd = -1500.25,
--            notas = 'Ya se le habían adelantado $1,500.25 USD antes de agosto', updated_by = v_admin
--      where socio_id = v_socio;
--     select saldo_inicial_usd into v_num from public.reparto_cuenta_socio where socio_id = v_socio;
--     if v_num <> -1500.25 then
--       raise exception 'DRYRUN_FALLA C4: saldo inicial negativo = % (esperado -1500.25)', v_num;
--     end if;
--     begin insert into public.reparto_cuenta_socio (socio_id, cuenta_desde) values (v_socio, date '2026-09-01');
--       raise exception 'DRYRUN_FALLA C4: dos cuentas para el mismo socio'; exception when unique_violation then null; end;
--     begin update public.reparto_cuenta_socio set cuenta_desde = date '2026-09-15' where socio_id = v_socio;
--       raise exception 'DRYRUN_FALLA C4: cuenta_desde con día 15'; exception when check_violation then null; end;
--     begin update public.reparto_cuenta_socio set notas = repeat('n', 501) where socio_id = v_socio;
--       raise exception 'DRYRUN_FALLA C4: notas de 501'; exception when check_violation then null; end;
--     begin update public.reparto_cuenta_socio set saldo_inicial_usd = null where socio_id = v_socio;
--       raise exception 'DRYRUN_FALLA C4: saldo inicial null'; exception when not_null_violation then null; end;
--     begin update public.reparto_cuenta_socio set cuenta_desde = null where socio_id = v_socio;
--       raise exception 'DRYRUN_FALLA C4: cuenta_desde null'; exception when not_null_violation then null; end;
--     begin insert into public.reparto_cuenta_socio (socio_id, cuenta_desde) values (gen_random_uuid(), date '2026-09-01');
--       raise exception 'DRYRUN_FALLA C4: socio inexistente'; exception when foreign_key_violation then null; end;
--     if (select count(*) from public.reparto_cuenta_socio where socio_id = v_socio) <> 1 then
--       raise exception 'DRYRUN_FALLA C4: filas de cuenta inesperadas';
--     end if;
--     -- Historial: el alta + UNA corrección (el UPDATE que solo tocó
--     -- updated_at no deja renglón); la corrección guarda el saldo ANTERIOR.
--     select string_agg(accion, ',' order by created_at, accion) into v_txt
--       from public.reparto_bitacora
--      where tabla = 'reparto_cuenta_socio' and registro_id = v_socio;
--     if v_txt is distinct from 'INSERT,UPDATE' then
--       raise exception 'DRYRUN_FALLA C4: historial de la cuenta = % (esperado INSERT,UPDATE)', v_txt;
--     end if;
--     select diff, actor_id into v_bit, v_actor from public.reparto_bitacora
--      where tabla = 'reparto_cuenta_socio' and registro_id = v_socio and accion = 'UPDATE';
--     if (v_bit->'saldo_inicial_usd'->>'antes')::numeric <> 0
--        or (v_bit->'saldo_inicial_usd'->>'despues')::numeric <> -1500.25
--        or v_bit->'cuenta_desde'->>'antes' <> '2026-09-01'
--        or v_bit->'cuenta_desde'->>'despues' <> '2026-08-01'
--        or v_actor is distinct from v_admin then
--       raise exception 'DRYRUN_FALLA C4: diff del saldo inicial inesperado: % (actor %)', v_bit, v_actor;
--     end if;
--     raise notice 'okC4 · cuenta: alta, trigger updated_at, saldo negativo, PK/CHECK/NOT NULL/FK, historial antes/después';
--
--     -- C5) LECTURAS DEL API: Σ entregas vivas del socio (todas, con o sin
--     --     mes); saldo = inicial + utilidad − entregas ⇒ ADELANTADO.
--     select coalesce(sum(monto_usd), 0) into v_num from public.reparto_pago
--      where socio_id = v_socio and deleted_at is null and id in (v_adelanto, v_entrega, v_mes);
--     if v_num <> 3933.78 then
--       raise exception 'DRYRUN_FALLA C5: entregado vivo = % (esperado 3933.78)', v_num;
--     end if;
--     -- -1500.25 + 1395.94 − 3933.78 = −4038.09 (< −1.00 ⇒ ADELANTADO)
--     if (-1500.25 + 1395.94 - v_num) <> -4038.09 then
--       raise exception 'DRYRUN_FALLA C5: aritmética del saldo';
--     end if;
--     select count(*) into v_n from public.reparto_pago
--      where socio_id = v_socio and deleted_at is null and fecha_pago between date '2026-10-01' and date '2026-10-31'
--        and id in (v_adelanto, v_entrega, v_mes);
--     if v_n <> 3 then
--       raise exception 'DRYRUN_FALLA C5: entregas del rango = % (esperado 3)', v_n;
--     end if;
--     raise notice 'okC5 · entregado 3,933.78 · saldo −4,038.09 (ADELANTADO)';
--
--     -- C6) SOFT DELETE del adelanto (como el API: sella updated_by): la fila
--     --     se conserva, los lectores (deleted_at is null) ya no la cuentan, su
--     --     llave sigue reservada y la bitácora guarda quién y por qué.
--     update public.reparto_pago
--        set deleted_at = now(), deleted_by = v_admin, motivo_baja = 'Capturado dos veces',
--            updated_by = v_admin
--      where id = v_adelanto and deleted_at is null;
--     get diagnostics v_n = row_count;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C6: el soft delete tocó % filas', v_n;
--     end if;
--     select coalesce(sum(monto_usd), 0) into v_num from public.reparto_pago
--      where socio_id = v_socio and deleted_at is null and id in (v_adelanto, v_entrega, v_mes);
--     if v_num <> 150.00 then
--       raise exception 'DRYRUN_FALLA C6: entregado vivo tras la baja = % (esperado 150.00)', v_num;
--     end if;
--     begin
--       insert into public.reparto_pago (socio_id, monto, moneda, monto_usd, fecha_pago, metodo, entregado_por, client_request_id)
--       values (v_socio, 1, 'USD', 1, date '2026-10-01', 'EFECTIVO', v_admin, v_key);
--       raise exception 'DRYRUN_FALLA C6: la llave de una entrega borrada se recicló';
--     exception when unique_violation then null; end;
--     select diff, actor_id into v_bit, v_actor from public.reparto_bitacora
--      where registro_id = v_adelanto and accion = 'UPDATE';
--     if v_bit->'motivo_baja'->>'despues' <> 'Capturado dos veces'
--        or v_bit->'deleted_at'->'antes' <> 'null'::jsonb
--        or v_actor is distinct from v_admin then
--       raise exception 'DRYRUN_FALLA C6: bitácora de la baja inesperada: % (actor %)', v_bit, v_actor;
--     end if;
--     select count(*) into v_n from public.reparto_pago;
--     if v_n <> v_n0 + 3 then
--       raise exception 'DRYRUN_FALLA C6: filas de reparto_pago = % (esperado %)', v_n, v_n0 + 3;
--     end if;
--     raise notice 'okC6 · soft delete conserva la fila; lectores sin borradas; llave reservada; baja en la bitácora';
--
--     -- C7) CORREGIR EL DINERO de una entrega (como el PATCH del API: CAS +
--     --     updated_by) deja el valor ANTERIOR y quién lo cambió; un UPDATE que
--     --     solo toca sellos o la llave no deja renglón.
--     update public.reparto_pago
--        set monto = 10.00, monto_usd = 10.00, saldo_snapshot_usd = 1395.94, updated_by = v_admin
--      where id = v_entrega and deleted_at is null;
--     select diff, actor_id into v_bit, v_actor from public.reparto_bitacora
--      where registro_id = v_entrega and accion = 'UPDATE';
--     if (v_bit->'monto'->>'antes')::numeric <> 100
--        or (v_bit->'monto'->>'despues')::numeric <> 10
--        or (v_bit->'monto_usd'->>'antes')::numeric <> 100
--        or (v_bit->'saldo_snapshot_usd'->>'antes')::numeric <> -2387.84
--        or (v_bit -> 'updated_by') is not null or (v_bit -> 'updated_at') is not null
--        or v_actor is distinct from v_admin then
--       raise exception 'DRYRUN_FALLA C7: diff de la corrección inesperado: % (actor %)', v_bit, v_actor;
--     end if;
--     update public.reparto_pago set client_request_id = gen_random_uuid(), updated_at = now() where id = v_mes;
--     select count(*) into v_n from public.reparto_bitacora where registro_id = v_mes;
--     if v_n <> 1 then
--       raise exception 'DRYRUN_FALLA C7: un cambio solo de sellos/llave dejó bitácora (% renglones)', v_n;
--     end if;
--     select count(*) into v_n from public.reparto_bitacora
--      where registro_id in (v_adelanto, v_entrega, v_mes, v_socio);
--     if v_n <> 7 then
--       raise exception 'DRYRUN_FALLA C7: renglones de bitácora = % (esperado 7: 3 altas, baja, corrección, cuenta alta + cambio)', v_n;
--     end if;
--     raise notice 'okC7 · corrección 100 → 10 USD con antes/después y actor; sellos no ensucian';
--
--     raise exception 'DRYRUN_OK · % · socio % · C1 estructura · C2 adelanto 70,000 MXN = 3,783.78 USD · C3 checks · C4 cuenta + trigger + historial · C5 saldo ADELANTADO · C6 soft delete · C7 bitácora de correcciones · todo se revierte', v_matricula, v_socio_nombre;
--   end $dry$;
--
-- TRAS APLICAR: `get_advisors` (esperado solo el INFO de «RLS sin policies»
-- de reparto_cuenta_socio y reparto_bitacora, y los de FK sin índice hacia
-- usuario —created_by/updated_by de la cuenta y updated_by de
-- reparto_pago—, patrón del repo; la función trae search_path fijo);
-- `select to_regclass('public.reparto_cuenta_socio')` no nulo; sondear
-- `GET /v1/profit-sharing/socios` (200 con `disponible: true`; la sonda
-- re-sondea en ≤ 10 min o reiniciar el API).
-- ORDEN DE DESPLIEGUE: tolerante en cualquier orden; RECOMENDADO API 0.0.50
-- → migración → panel (el panel tolera 404/503 con `disponible:false`).
-- PROHIBIDO regresar el API a 0.0.49 con CUALQUIER entrega v2 ya capturada
-- (la v1 asume avión, mes y utilidad_snapshot_usd en cada fila).

-- ---------------------------------------------------------------------------
-- 1) CUENTA CORRIENTE DEL SOCIO
-- ---------------------------------------------------------------------------

-- 1.a) reparto_pago = ENTREGA al socio; «corresponde a» mes/avión opcional.
alter table public.reparto_pago alter column periodo drop not null;
alter table public.reparto_pago alter column aeronave_id drop not null;
alter table public.reparto_pago alter column utilidad_snapshot_usd drop not null;
alter table public.reparto_pago drop constraint if exists reparto_pago_periodo_chk;
alter table public.reparto_pago add constraint reparto_pago_periodo_chk
  check (periodo is null or extract(day from periodo) = 1);
alter table public.reparto_pago add column if not exists saldo_snapshot_usd numeric(12,2);
-- Quién corrigió por última vez (el API lo sella en TODA escritura; la
-- bitácora lo toma como actor). FK aparte del ADD COLUMN: re-aplicar no
-- duplica la constraint.
alter table public.reparto_pago add column if not exists updated_by uuid;
alter table public.reparto_pago drop constraint if exists reparto_pago_updated_by_fkey;
alter table public.reparto_pago add constraint reparto_pago_updated_by_fkey
  foreign key (updated_by) references public.usuario(id) on delete set null;

drop index if exists public.idx_reparto_pago_periodo;
create index if not exists idx_reparto_pago_socio_fecha
  on public.reparto_pago (socio_id, fecha_pago)
  where deleted_at is null;

comment on table public.reparto_pago is
  'Entregas de utilidades a socios (cuenta corriente, v2 2-oct-2026): una fila por entrega (transferencia, efectivo, cheque u otro). El saldo del socio = saldo inicial (reparto_cuenta_socio) + utilidades generadas (profit-sharing compute mes a mes, NO se guardan) − entregas vivas. Soft delete: todo lector filtra deleted_at is null. Historial de cambios en reparto_bitacora (trigger). Sin enums: moneda/metodo son texto + CHECK.';
comment on column public.reparto_pago.periodo is
  'Informativo: mes al que «corresponde» la entrega (día 1, CHECK solo si no es null). NULL = adelanto a cuenta.';
comment on column public.reparto_pago.aeronave_id is
  'Informativo: avión al que «corresponde» la entrega (el socio debe serlo de ese avión). NULL = de toda su cuenta.';
comment on column public.reparto_pago.utilidad_snapshot_usd is
  'Legado de la v1 (utilidad del socio en el avión y mes al registrar). La v2 no lo escribe (null).';
comment on column public.reparto_pago.saldo_snapshot_usd is
  'Lo por entregar del socio de MESES CERRADOS (sin el mes en curso) ANTES de esta entrega, al registrarla (o al corregir su dinero): el número contra el que se decidió si era adelanto. Informativo; negativo = ya estaba adelantado.';
comment on column public.reparto_pago.monto_usd is
  'Lo que la entrega descuenta del saldo del socio. USD = monto (CHECK); MXN = round(monto / tc_usd_mxn, 2), calculado por el API.';
comment on column public.reparto_pago.updated_by is
  'Quién corrigió la entrega por última vez (el API lo sella en cada escritura: corrección, comprobante, baja). Actor de reparto_bitacora.';

-- 1.b) Configuración de la cuenta por socio (opcional: sin fila = default).
create table if not exists public.reparto_cuenta_socio (
  socio_id uuid primary key references public.usuario(id) on delete restrict,
  cuenta_desde date not null,
  saldo_inicial_usd numeric(12,2) not null default 0,
  notas text,
  created_by uuid references public.usuario(id) on delete set null,
  created_at timestamptz not null default now(),
  updated_by uuid references public.usuario(id) on delete set null,
  updated_at timestamptz not null default now(),
  constraint reparto_cuenta_socio_desde_chk check (extract(day from cuenta_desde) = 1),
  constraint reparto_cuenta_socio_notas_chk check (
    notas is null or char_length(notas) <= 500)
);

comment on table public.reparto_cuenta_socio is
  'Cuenta corriente del socio (2-oct-2026): desde qué mes cuenta y con qué saldo arranca. Sin fila ⇒ el API usa 2026-09-01 con saldo 0 (configurada:false). Las utilidades NO se guardan: salen de profit-sharing compute mes a mes. Cada cambio del arranque/saldo inicial queda en reparto_bitacora (trigger).';
comment on column public.reparto_cuenta_socio.cuenta_desde is
  'Primer mes que suma utilidades a la cuenta: SIEMPRE el día 1 (CHECK).';
comment on column public.reparto_cuenta_socio.saldo_inicial_usd is
  'Saldo al arrancar la cuenta, en USD: positivo = se le debía al socio; negativo = ya se le había adelantado.';

alter table public.reparto_cuenta_socio enable row level security;

drop trigger if exists trg_reparto_cuenta_socio_set_updated_at on public.reparto_cuenta_socio;
create trigger trg_reparto_cuenta_socio_set_updated_at
  before update on public.reparto_cuenta_socio
  for each row execute function public.tg_set_updated_at();

-- 1.c) BITÁCORA del dinero entregado a socios (patrón tg_gasto_bitacora):
--      cada alta, corrección, baja o cambio de comprobante de una entrega y
--      cada cambio del arranque/saldo inicial de una cuenta deja el ANTES y
--      el DESPUÉS de las columnas de negocio, quién y cuándo. Sin FK a
--      propósito: sobrevive a un DELETE físico (que el API nunca hace).
create table if not exists public.reparto_bitacora (
  id uuid primary key default gen_random_uuid(),
  tabla text not null,
  registro_id uuid not null,
  socio_id uuid,
  accion text not null,
  actor_id uuid,
  diff jsonb not null default '{}'::jsonb,
  snapshot jsonb,
  created_at timestamptz not null default now(),
  constraint reparto_bitacora_tabla_chk check (
    tabla in ('reparto_pago', 'reparto_cuenta_socio')),
  constraint reparto_bitacora_accion_chk check (
    accion in ('INSERT', 'UPDATE', 'DELETE'))
);
create index if not exists idx_reparto_bitacora_registro
  on public.reparto_bitacora (tabla, registro_id, created_at);
create index if not exists idx_reparto_bitacora_socio
  on public.reparto_bitacora (socio_id, created_at);
alter table public.reparto_bitacora enable row level security;

comment on table public.reparto_bitacora is
  'Historial (trigger tg_reparto_bitacora) de las entregas a socios (reparto_pago) y de la configuración de sus cuentas (reparto_cuenta_socio): diff {columna: {antes, despues}} de las columnas de negocio, actor = updated_by (o deleted_by en la baja; created_by en el alta). registro_id = reparto_pago.id o reparto_cuenta_socio.socio_id. Sin FK a propósito.';

create or replace function public.tg_reparto_bitacora()
returns trigger language plpgsql
set search_path = ''
as $fn$
declare
  -- Solo columnas de NEGOCIO: los sellos (updated_at/updated_by) y la llave
  -- de idempotencia no inundan la bitácora.
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
      'notas','deleted_at','deleted_by','motivo_baja'
    ];
  else
    cols := array['cuenta_desde','saldo_inicial_usd','notas'];
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
    -- Sin cambio de negocio (solo sellos): sin fila.
    if v_diff = '{}'::jsonb then
      return new;
    end if;
    -- Baja (soft delete): quien la dio de baja; si no, quien corrigió.
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
end $fn$;

comment on function public.tg_reparto_bitacora() is
  'Bitácora de reparto_pago y reparto_cuenta_socio (2-oct-2026): AFTER INSERT/UPDATE/DELETE ⇒ public.reparto_bitacora con el antes/después de las columnas de negocio.';

drop trigger if exists trg_reparto_pago_bitacora on public.reparto_pago;
create trigger trg_reparto_pago_bitacora
  after insert or update or delete on public.reparto_pago
  for each row execute function public.tg_reparto_bitacora();

drop trigger if exists trg_reparto_cuenta_socio_bitacora on public.reparto_cuenta_socio;
create trigger trg_reparto_cuenta_socio_bitacora
  after insert or update or delete on public.reparto_cuenta_socio
  for each row execute function public.tg_reparto_bitacora();

-- ---------------------------------------------------------------------------
-- ROLLBACK — SIEMPRE en UNA transacción (begin … commit): si un paso falla
-- no queda nada a medias (jamás línea por línea). Pierde la configuración
-- de las cuentas y la bitácora: exportarlas antes
-- (select * from public.reparto_cuenta_socio; select * from public.reparto_bitacora;).
-- BLOQUEADO si existe CUALQUIER entrega v2: la v2 SIEMPRE escribe
-- utilidad_snapshot_usd = null (también las que traen avión y mes) y la v1
-- exige avión, mes y snapshot. El paso 0 lo revisa y aborta TODO; si hay
-- entregas v2, exportarlas y decidir con la oficina (borrarlas o no
-- regresar a la v1) ANTES de correrlo.
--   begin;
--   do $chk$ begin
--     if exists (select 1 from public.reparto_pago
--                 where utilidad_snapshot_usd is null or periodo is null or aeronave_id is null) then
--       raise exception 'ROLLBACK_BLOQUEADO: hay entregas v2 en reparto_pago (exportarlas y decidir antes)';
--     end if;
--   end $chk$;
--   drop trigger if exists trg_reparto_pago_bitacora on public.reparto_pago;
--   drop table if exists public.reparto_cuenta_socio;
--   drop function if exists public.tg_reparto_bitacora();
--   drop table if exists public.reparto_bitacora;
--   drop index if exists public.idx_reparto_pago_socio_fecha;
--   create index if not exists idx_reparto_pago_periodo
--     on public.reparto_pago (periodo) where deleted_at is null;
--   alter table public.reparto_pago drop constraint if exists reparto_pago_updated_by_fkey;
--   alter table public.reparto_pago drop column if exists updated_by;
--   alter table public.reparto_pago drop column if exists saldo_snapshot_usd;
--   alter table public.reparto_pago drop constraint if exists reparto_pago_periodo_chk;
--   alter table public.reparto_pago add constraint reparto_pago_periodo_chk
--     check (extract(day from periodo) = 1);
--   alter table public.reparto_pago alter column periodo set not null;
--   alter table public.reparto_pago alter column aeronave_id set not null;
--   alter table public.reparto_pago alter column utilidad_snapshot_usd set not null;
--   commit;
-- El API 0.0.50 sigue funcionando sin la columna (sonda ⇒ disponible:false /
-- 503 CUENTA_SOCIO_NO_DISPONIBLE).
-- ---------------------------------------------------------------------------
