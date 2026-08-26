-- Ficha comercial de la aeronave para el PDF de cotización (26-ago v2):
-- la hoja del avión ahora lleva tarjeta "De un vistazo" (pasajeros,
-- velocidad, tiempo por tramo, motor) + tira de características. HP y
-- características no existían en el esquema.
alter table aeronave
  add column if not exists motor_hp int check (motor_hp > 0),
  add column if not exists caracteristicas text[] not null default '{}';
comment on column aeronave.motor_hp is
  'Potencia por motor (HP) para la ficha comercial del PDF de cotización.';
comment on column aeronave.caracteristicas is
  'Características comerciales (tira del PDF de cotización), es-MX.';

-- Semilla del XA-VGV con el material comercial del cliente (mockup 26-ago).
update aeronave
   set motor_hp = 310,
       caracteristicas = array[
         'Ala alta con visibilidad panorámica',
         'Puerta doble de carga',
         'Amplia capacidad de equipaje',
         'Aire acondicionado'
       ]
 where matricula = 'XA-VGV';
