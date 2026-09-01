-- 1-sep-2026 · Dos piezas pedidas por el equipo (chat 31-ago/1-sep):
--
-- (1) VENTANA DE EDICIÓN de gastos de campo: piloto/mecánico/visitante
--     corrigen/borran SU gasto hasta N días (pared Cancún) tras capturarlo
--     (antes: solo el mismo día). N vive en configuracion_sistema
--     ('dias_edicion_gastos_campo', 14 provisional — el equipo confirmará).
--     configuracion_sistema gana la columna valor_numerico (era solo booleana).
--
-- (2) GASTO_BITACORA: historial de cada gasto (capturado/editado/borrado,
--     con diff de columnas relevantes) escrito por TRIGGER de BD — ningún
--     camino (app, panel, cargas masivas, bodega, conciliación) lo esquiva.
--     Sin FK a gasto/vuelo (patrón vuelo_eliminado: la historia sobrevive
--     al DELETE y al purge). RLS sin políticas (solo service key).

alter table configuracion_sistema
  add column if not exists valor_numerico numeric null
  check (valor_numerico is null or valor_numerico >= 0);
comment on column configuracion_sistema.valor_numerico is
  'Valor numérico opcional de la bandera (p.ej. días de la ventana de edición). null = bandera puramente booleana.';

insert into configuracion_sistema (clave, activa, valor_numerico, descripcion)
values (
  'dias_edicion_gastos_campo', true, 14,
  'Días (pared Cancún, desde la CAPTURA) en que piloto/mecánico/visitante pueden corregir o borrar su propio gasto/combustible. 0 = solo el mismo día.'
)
on conflict (clave) do nothing;

create table if not exists gasto_bitacora (
  id uuid primary key default gen_random_uuid(),
  gasto_id uuid not null,
  vuelo_id uuid,
  accion text not null check (accion in ('INSERT','UPDATE','DELETE')),
  actor_id uuid,
  diff jsonb not null default '{}'::jsonb,
  snapshot jsonb,
  created_at timestamptz not null default now()
);
create index if not exists idx_gasto_bitacora_gasto on gasto_bitacora (gasto_id, created_at);
create index if not exists idx_gasto_bitacora_vuelo on gasto_bitacora (vuelo_id, created_at) where vuelo_id is not null;
alter table gasto_bitacora enable row level security;
comment on table gasto_bitacora is
  'Historial de gastos escrito por trigger (tg_gasto_bitacora). Sin FK a propósito: sobrevive al DELETE del gasto y al purge del vuelo.';

create or replace function public.tg_gasto_bitacora()
returns trigger language plpgsql
set search_path = ''
as $function$
declare
  -- Solo columnas con significado de negocio: los recálculos de flags del
  -- sistema (updated_*, valor_ia_extraido, duplicado_sospechado, etc.) no
  -- inundan la bitácora.
  cols text[] := array[
    'monto','propina','moneda','tc_gasto','categoria','fecha_gasto',
    'vuelo_id','aeronave_id','escala_id','medio_pago','tarjeta_terminacion',
    'proveedor_id','foto_url','notas','lugar','litros','tipo_combustible',
    'fecha_hora_carga','estatus_comprobante','estatus_facturacion',
    'folio_ticket','conciliado'
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
    -- Diff vacío (churn del sistema, sellado pre-delete) = sin fila.
    if v_diff = '{}'::jsonb then
      return new;
    end if;
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff)
    values (new.id, coalesce(new.vuelo_id, old.vuelo_id), 'UPDATE', new.updated_by, v_diff);
    return new;
  else
    insert into public.gasto_bitacora (gasto_id, vuelo_id, accion, actor_id, diff, snapshot)
    values (old.id, old.vuelo_id, 'DELETE', old.updated_by, '{}'::jsonb, to_jsonb(old));
    return old;
  end if;
end $function$;

drop trigger if exists trg_gasto_bitacora on gasto;
create trigger trg_gasto_bitacora
  after insert or update or delete on gasto
  for each row execute function public.tg_gasto_bitacora();
