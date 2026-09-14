-- «No requiere factura» en el semáforo de facturación del gasto
-- (pedido del cliente, 14-sep-2026: «en Facturación (oficina) agregar la
-- opción No requiere factura / No facturable»).
--
-- Cuarto valor de `gasto.estatus_facturacion` (text + CHECK, NO es enum):
--   PENDIENTE 🔴 · SOLICITADA 🟡 · FACTURADA 🟢 · NO_FACTURABLE ⚪
--
-- NO_FACTURABLE no es «ya se facturó» ni «falta facturar»: es un tercer
-- cubo (propinas, cuotas sin comprobante fiscal, gastos que nadie va a
-- facturar) que sale del filtro «por facturar» y del pendiente del
-- pre-cierre sin mentir en ninguno de los dos.
--
-- Sin backfill: ninguna fila cambia de estatus. Lo marca la oficina.

-- 1) Fuera el CHECK viejo. El nombre NO se adivina: se busca por su
--    DEFINICIÓN (podría llamarse gasto_estatus_facturacion_check o traer
--    el sufijo que le tocó al crearse) entre los CHECK de public.gasto.
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
  loop
    raise notice 'drop check % de public.gasto', c.conname;
    execute format('alter table public.gasto drop constraint %I', c.conname);
  end loop;
end $$;

-- 2) El CHECK nuevo, ya con nombre estable.
alter table public.gasto
  add constraint gasto_estatus_facturacion_check
  check (estatus_facturacion in ('PENDIENTE', 'SOLICITADA', 'FACTURADA', 'NO_FACTURABLE'));

comment on column public.gasto.estatus_facturacion is
  'Seguimiento de oficina: PENDIENTE/SOLICITADA/FACTURADA/NO_FACTURABLE (14-sep-2026: NO_FACTURABLE = no requiere factura). Independiente de estatus_comprobante. Solo el amarre de factura_recibida auto-marca FACTURADA (trigger).';

-- 3) El comprobante del piloto se lee en DOS opciones desde el 14-sep-2026
--    (pedido del cliente). El enum NO cambia y nadie reescribe filas: el
--    API traduce con src/common/comprobante.util.ts.
comment on column public.gasto.estatus_comprobante is
  'Qué papel entregó quien capturó: FACTURA = con comprobante (valor que guardan app y panel), VALE = con comprobante (LEGADO: cargas masivas con TICKET, capturas viejas; se lee, no se reescribe), SIN_COMPROBANTE = sin comprobante. NO dice si ya se facturó (eso es estatus_facturacion).';

-- 4) Trigger del amarre 1 factura → N gastos: si LLEGA una factura
--    recibida, el gasto está facturado aunque la oficina lo hubiera
--    marcado NO_FACTURABLE (hay factura ⇒ está facturado). El DESAMARRE no
--    cambia: solo un FACTURADA regresa a PENDIENTE — nunca resucita un
--    NO_FACTURABLE que la oficina no puso.
create or replace function public.gasto_sync_facturacion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.factura_recibida_id is not null
       and new.estatus_facturacion in ('PENDIENTE', 'NO_FACTURABLE') then
      new.estatus_facturacion := 'FACTURADA';
    end if;
  elsif new.estatus_facturacion = old.estatus_facturacion then
    -- Amarre: cualquier estatus previo (incluido NO_FACTURABLE) pasa a
    -- FACTURADA. Ya lo hacía: la rama no mira el valor viejo.
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
