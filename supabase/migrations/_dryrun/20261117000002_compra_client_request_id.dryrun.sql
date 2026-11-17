-- 20261117000002_compra_client_request_id — dry-run (CUERPO copiado de la migración; pruebas a mano).
-- Proyecto PROD: bjesduasnzbzywofukbf (confirmar el ref antes de correrlo).
-- DRY-RUN: corre la migración y pruebas con escrituras REALES y lo revierte
-- TODO. Debe terminar en ERROR con el texto «DRYRUN_OK: …». Cualquier otro
-- error ⇒ NO aplicar y avisar.
-- No lleva sentencias destructivas: se puede correr por MCP o en el SQL
-- Editor.
--
-- Las filas de prueba van DESPUÉS del cuerpo y con `folio` EXPLÍCITO
-- (negativo): el folio sale de una secuencia y `nextval` NO se revierte con
-- la transacción — un INSERT de prueba sin folio dejaría un hueco en la
-- numeración de las compras de la oficina.

begin;

-- >>> CUERPO
alter table public.compra
  add column if not exists client_request_id uuid;

create unique index if not exists uq_compra_client_request
  on public.compra (client_request_id)
  where client_request_id is not null;

comment on column public.compra.client_request_id is
  'Llave de idempotencia (uuid v4) que la app genera por alta de compra; única. Un reintento con la misma llave devuelve la compra YA creada (200, idempotente: true) sin duplicarla. El panel da de alta sin llave (null).';
-- <<< CUERPO

do $t$
declare
  k1 constant uuid := '00000000-0000-4000-8000-0000000d0001';
  k2 constant uuid := '00000000-0000-4000-8000-0000000d0002';
  v_n integer;
  v_txt text;
  v_def text;
  v_seq_antes bigint;
  v_seq_despues bigint;
  v_id1 uuid;
  v_id_sin uuid;
  v_upd_antes timestamptz;
  v_upd_despues timestamptz;
  v_estado text;
  v_constraint text;
  v_mensaje text;
  v_choco boolean;
begin
  select last_value into v_seq_antes from public.compra_folio_seq;

  -- T1: la columna existe, es uuid, admite null y no tiene valor por omisión.
  select data_type || '|' || is_nullable || '|' || coalesce(column_default, '')
    into v_txt
    from information_schema.columns
   where table_schema = 'public' and table_name = 'compra'
     and column_name = 'client_request_id';
  if v_txt is distinct from 'uuid|YES|' then
    raise exception 'DRYRUN T1: columna inesperada: %', coalesce(v_txt, '(no existe)');
  end if;

  -- T2: el índice es ÚNICO y PARCIAL (solo llaves no nulas).
  select indexdef into v_def from pg_indexes
   where schemaname = 'public' and tablename = 'compra'
     and indexname = 'uq_compra_client_request';
  if v_def is null
     or v_def not ilike 'create unique index%'
     or v_def not ilike '%(client_request_id)%'
     or v_def not ilike '%where (client_request_id is not null)%' then
    raise exception 'DRYRUN T2: índice inesperado: %', coalesce(v_def, '(no existe)');
  end if;

  -- T3: ninguna compra existente quedó con llave (la migración no toca filas).
  select count(*) into v_n from public.compra where client_request_id is not null;
  if v_n <> 0 then
    raise exception 'DRYRUN T3: % compra(s) existentes con llave', v_n;
  end if;

  -- T4: alta CON llave (lo que manda la app).
  insert into public.compra (folio, notas, client_request_id)
  values (-900001, 'DRYRUN 20261117000002', k1)
  returning id into v_id1;

  -- T5: la MISMA llave otra vez ⇒ 23505 sobre el índice, y el texto del
  -- error nombra el índice (el API decide por ese nombre).
  v_choco := false;
  begin
    insert into public.compra (folio, notas, client_request_id)
    values (-900002, 'DRYRUN duplicada', k1);
  exception when unique_violation then
    get stacked diagnostics v_constraint = constraint_name,
                            v_mensaje = message_text;
    v_choco := true;
  end;
  if not v_choco then
    raise exception 'DRYRUN T5: la llave repetida NO chocó';
  end if;
  if v_constraint is distinct from 'uq_compra_client_request'
     or position('uq_compra_client_request' in coalesce(v_mensaje, '')) = 0 then
    raise exception 'DRYRUN T5: choque inesperado: % · %', v_constraint, v_mensaje;
  end if;
  select count(*) into v_n from public.compra where client_request_id = k1;
  if v_n <> 1 then
    raise exception 'DRYRUN T5: % compra(s) con la llave (esperaba 1)', v_n;
  end if;

  -- T6: SIN llave (el panel) entran las que sean: el índice es parcial.
  insert into public.compra (folio, notas) values (-900003, 'DRYRUN sin llave A')
  returning id into v_id_sin;
  insert into public.compra (folio, notas) values (-900004, 'DRYRUN sin llave B');
  select count(*) into v_n from public.compra
   where folio in (-900003, -900004) and client_request_id is null;
  if v_n <> 2 then
    raise exception 'DRYRUN T6: % compra(s) sin llave (esperaba 2)', v_n;
  end if;

  -- T7: otra llave ⇒ otra compra.
  insert into public.compra (folio, notas, client_request_id)
  values (-900005, 'DRYRUN otra llave', k2);

  -- T8: editar la compra con llave (lo que hace el panel después) conserva
  -- la llave y el disparador de `updated_at` sigue vivo.
  select updated_at into v_upd_antes from public.compra where id = v_id1;
  update public.compra
     set notas = 'DRYRUN editada', updated_at = '2000-01-01T00:00:00Z'
   where id = v_id1;
  select updated_at, estado into v_upd_despues, v_estado
    from public.compra where id = v_id1 and client_request_id = k1;
  if v_estado is distinct from 'ABIERTA' then
    raise exception 'DRYRUN T8: la compra editada perdió su llave o su estado (%)', v_estado;
  end if;
  if v_upd_despues is null or v_upd_despues < v_upd_antes then
    raise exception 'DRYRUN T8: updated_at no lo selló el disparador (% → %)', v_upd_antes, v_upd_despues;
  end if;

  -- T9: ponerle a OTRA compra una llave ya usada también choca (el índice
  -- cubre los UPDATE).
  v_choco := false;
  begin
    update public.compra set client_request_id = k1 where id = v_id_sin;
  exception when unique_violation then
    v_choco := true;
  end;
  if not v_choco then
    raise exception 'DRYRUN T9: el UPDATE con llave repetida NO chocó';
  end if;

  -- T10: la lectura del replay (por llave) devuelve exactamente una.
  select count(*) into v_n from public.compra where client_request_id = k2;
  if v_n <> 1 then
    raise exception 'DRYRUN T10: % compra(s) con la segunda llave', v_n;
  end if;

  -- T11: RLS sigue encendido y la tabla conserva su único disparador.
  select count(*) into v_n from pg_class
   where oid = 'public.compra'::regclass and relrowsecurity;
  if v_n <> 1 then
    raise exception 'DRYRUN T11: RLS apagado en compra';
  end if;
  select count(*) into v_n from pg_trigger
   where tgrelid = 'public.compra'::regclass and not tgisinternal;
  if v_n <> 1 then
    raise exception 'DRYRUN T11: % disparador(es) en compra (esperaba 1)', v_n;
  end if;

  -- T12: las pruebas no gastaron ningún folio de la secuencia.
  select last_value into v_seq_despues from public.compra_folio_seq;
  if v_seq_despues <> v_seq_antes then
    raise exception 'DRYRUN T12: la secuencia de folios se movió (% → %)', v_seq_antes, v_seq_despues;
  end if;

  raise exception 'DRYRUN_OK: compra.client_request_id — alta con llave, llave repetida rechazada (23505 %), altas sin llave, edición y lectura por llave correctas; folios intactos (todo revertido)', v_constraint;
end $t$;

rollback;
