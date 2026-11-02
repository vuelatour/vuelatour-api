-- «No obtenida / no emitida» en el semáforo de facturación del gasto, con el
-- motivo (pedido de la oficina, 2-nov-2026: «agregar la opción "no obtenida
-- o no emitida" y que se pueda agregar una nota o el motivo por el cual no se
-- pudo obtener esa factura»). API 0.0.116, invariante 115.
--
-- Quinto valor de `gasto.estatus_facturacion` (text + CHECK, NO es enum):
--   PENDIENTE 🔴 · SOLICITADA 🟡 · FACTURADA 🟢 · NO_FACTURABLE ⚪ · NO_OBTENIDA 🟣
--
-- NO_OBTENIDA = se pidió y el proveedor no la emitió (o no se pudo obtener).
-- Como NO_FACTURABLE, sale del filtro «por facturar» y del pendiente del
-- pre-cierre (ya no hay nada que perseguir), pero NO es «no requiere»: en el
-- Excel de efectivos es su propio cubo («no obtenida»). Lleva SIEMPRE el
-- motivo en `facturacion_nota` (CHECK). Si después llega la factura, el
-- amarre la pasa a FACTURADA (trigger) y el motivo queda como historial.
--
-- Sin backfill: ninguna fila cambia. Lo marca la oficina desde el panel.

-- >>> CUERPO

-- 1) Fuera el CHECK viejo: se busca por su DEFINICIÓN (mismo patrón que
--    20260914000002: el nombre no se adivina).
do $$
declare
  c record;
begin
  for c in
    select con.conname
      from pg_constraint con
      join pg_class rel on rel.oid = con.conrelid
      join pg_namespace ns on ns.oid = rel.relnamespace
     where ns.nspname = 'public'
       and rel.relname = 'gasto'
       and con.contype = 'c'
       and pg_get_constraintdef(con.oid) ilike '%estatus_facturacion%'
       and pg_get_constraintdef(con.oid) not ilike '%facturacion_nota%'
  loop
    raise notice 'drop check % de public.gasto', c.conname;
    execute format('alter table public.gasto drop constraint %I', c.conname);
  end loop;
end $$;

-- 2) El CHECK nuevo, con nombre estable.
alter table public.gasto
  add constraint gasto_estatus_facturacion_check
  check (estatus_facturacion in ('PENDIENTE', 'SOLICITADA', 'FACTURADA', 'NO_FACTURABLE', 'NO_OBTENIDA'));

-- 3) El motivo. Texto corto (1..500) y OBLIGATORIO con NO_OBTENIDA.
alter table public.gasto
  add column if not exists facturacion_nota text;

alter table public.gasto drop constraint if exists gasto_facturacion_nota_chk;
alter table public.gasto
  add constraint gasto_facturacion_nota_chk
  check (
    (facturacion_nota is null or length(btrim(facturacion_nota)) between 1 and 500)
    and (estatus_facturacion <> 'NO_OBTENIDA' or facturacion_nota is not null)
  );

comment on column public.gasto.estatus_facturacion is
  'Seguimiento de oficina: PENDIENTE/SOLICITADA/FACTURADA/NO_FACTURABLE (no requiere factura)/NO_OBTENIDA (2-nov-2026: el proveedor no la emitió; motivo obligatorio en facturacion_nota). Independiente de estatus_comprobante. Solo el amarre de factura_recibida auto-marca FACTURADA (trigger).';
comment on column public.gasto.facturacion_nota is
  'Motivo por el que la factura NO se obtuvo (estatus NO_OBTENIDA, 2-nov-2026). Lo escribe el API: obligatorio al marcar NO_OBTENIDA, se limpia al cambiar a otro estatus desde el panel; el amarre de una factura (trigger ⇒ FACTURADA) lo deja como historial.';

-- 4) Trigger del amarre 1 factura → N gastos: si LLEGA una factura recibida,
--    el gasto está facturado aunque estuviera NO_OBTENIDA (hay factura ⇒
--    está facturado). El DESAMARRE no cambia: solo un FACTURADA regresa a
--    PENDIENTE — nunca resucita un NO_FACTURABLE/NO_OBTENIDA.
create or replace function public.gasto_sync_facturacion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.factura_recibida_id is not null
       and new.estatus_facturacion in ('PENDIENTE', 'NO_FACTURABLE', 'NO_OBTENIDA') then
      new.estatus_facturacion := 'FACTURADA';
    end if;
  elsif new.estatus_facturacion = old.estatus_facturacion then
    -- Amarre: cualquier estatus previo (incluidos NO_FACTURABLE y
    -- NO_OBTENIDA) pasa a FACTURADA. La rama no mira el valor viejo.
    if old.factura_recibida_id is null
       and new.factura_recibida_id is not null then
      new.estatus_facturacion := 'FACTURADA';
    elsif old.factura_recibida_id is not null
      and new.factura_recibida_id is null
      and old.estatus_facturacion = 'FACTURADA' then
      new.estatus_facturacion := 'PENDIENTE';
    end if;
  end if;
  return new;
end;
$$;

drop trigger if exists trg_gasto_sync_facturacion on public.gasto;
create trigger trg_gasto_sync_facturacion
  before insert or update on public.gasto
  for each row execute function public.gasto_sync_facturacion();

-- <<< CUERPO
