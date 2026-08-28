-- TC oficial USD→MXN por día (Banxico FIX = el que publica el DOF). Lo llena
-- el API (cron diario + bajo demanda) para autocompletar el TC de venta en el
-- Balance por avión cuando la cotización no lo capturó (pedido 27-ago: "por
-- defecto el TC del diario oficial del día de la cotización, marcado en un
-- color sutil").
create table if not exists tipo_cambio_oficial (
  fecha date primary key,
  tc numeric(10,4) not null check (tc > 0),
  fuente text not null default 'BANXICO_FIX',
  created_at timestamptz not null default now()
);
alter table tipo_cambio_oficial enable row level security;
comment on table tipo_cambio_oficial is
  'Tipo de cambio oficial USD→MXN por día (Banxico FIX, el que publica el DOF). Lo llena el API (cron diario + bajo demanda) para autocompletar el TC de venta en el Balance por avión cuando la cotización no lo capturó.';
