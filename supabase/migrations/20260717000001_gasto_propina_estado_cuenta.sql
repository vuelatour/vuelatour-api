-- Propina en gastos + archivo del estado de cuenta importado.
--
-- PROPINA: el piloto paga con tarjeta corporativa y agrega propina en la
-- terminal → el cargo bancario (ticket + propina) no cuadraba con el gasto
-- capturado del ticket y la conciliación fallaba (caso real: comida $393 +
-- 10% = $432.30). Regla: gasto.monto = TOTAL PAGADO (incluye propina, es lo
-- que se concilia y lo que cuesta a la empresa); propina = desglose
-- informativo (monto - propina = ticket/factura).
alter table gasto
  add column if not exists propina numeric(14, 2) not null default 0
  check (propina >= 0);

comment on column gasto.propina is
  'Propina incluida en monto (monto = ticket + propina). monto - propina = importe del comprobante.';

-- ESTADO DE CUENTA: el archivo importado se guardaba solo en la memoria del
-- parser y se perdía; ahora queda en el bucket privado estados-cuenta con
-- registro para consultarlo/descargarlo después (auditoría del cierre).
create table if not exists estado_cuenta_archivo (
  id uuid primary key default gen_random_uuid(),
  cuenta_bancaria_id uuid not null references cuenta_bancaria(id),
  filename text not null,
  storage_path text not null,
  formato text,
  movimientos_importados integer not null default 0,
  created_at timestamptz not null default now(),
  created_by uuid references usuario(id)
);

alter table estado_cuenta_archivo enable row level security;

alter table movimiento_bancario
  add column if not exists estado_cuenta_id uuid references estado_cuenta_archivo(id);

create index if not exists idx_movimiento_bancario_estado_cuenta
  on movimiento_bancario (estado_cuenta_id)
  where estado_cuenta_id is not null;

insert into storage.buckets (id, name, public)
values ('estados-cuenta', 'estados-cuenta', false)
on conflict (id) do nothing;
