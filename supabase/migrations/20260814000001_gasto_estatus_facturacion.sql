-- Estatus de facturación del gasto (seguimiento de OFICINA):
--   PENDIENTE  → aún no se pide la factura al proveedor
--   SOLICITADA → factura pedida, esperando que llegue
--   FACTURADA  → factura en mano
-- Es INDEPENDIENTE de estatus_comprobante (qué entregó el piloto): la app
-- marca FACTURA con CUALQUIER foto (aunque sea un ticket) y el toggle viejo
-- del panel también mutaba el comprobante — esa señal está contaminada y NO
-- sirve para afirmar "ya se facturó". Jamás afirmar facturado en falso.

alter table public.gasto
  add column if not exists estatus_facturacion text not null default 'PENDIENTE'
    check (estatus_facturacion in ('PENDIENTE', 'SOLICITADA', 'FACTURADA'));

comment on column public.gasto.estatus_facturacion is
  'Seguimiento de oficina: PENDIENTE/SOLICITADA/FACTURADA. Independiente de estatus_comprobante (la app marca FACTURA con cualquier foto). Solo el amarre de factura_recibida auto-marca FACTURADA (trigger).';

-- Amarres LEGACY 1:1 (jun–jul 2026): el buzón de recibidas escribía SOLO
-- factura_recibida.gasto_id (gasto.factura_recibida_id nació el 9-jul sin
-- backfill). Rellenar el FK inverso primero, para que el backfill de abajo
-- y el trigger de desamarre también cubran esos gastos.
update public.gasto g
   set factura_recibida_id = fr.id
  from public.factura_recibida fr
 where fr.gasto_id = g.id
   and g.factura_recibida_id is null;

-- Backfill CONSERVADOR: solo lo que tiene factura recibida amarrada es
-- seguro FACTURADA. El resto queda PENDIENTE aunque comprobante = FACTURA
-- (puede ser foto de ticket); la oficina marca al revisar — mismo flujo que
-- ya hace hoy a mano, pero ahora queda registrado.
update public.gasto
   set estatus_facturacion = 'FACTURADA'
 where factura_recibida_id is not null;

-- Sincronía con el amarre "1 factura recibida → N gastos": amarrar auto-marca
-- FACTURADA; desamarrar regresa a PENDIENTE. Nunca pisa un estatus que la
-- oficina haya fijado a mano EN ESA MISMA escritura.
create or replace function public.gasto_sync_facturacion()
returns trigger
language plpgsql
set search_path = ''
as $$
begin
  if tg_op = 'INSERT' then
    if new.factura_recibida_id is not null
       and new.estatus_facturacion = 'PENDIENTE' then
      new.estatus_facturacion := 'FACTURADA';
    end if;
  elsif new.estatus_facturacion = old.estatus_facturacion then
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
