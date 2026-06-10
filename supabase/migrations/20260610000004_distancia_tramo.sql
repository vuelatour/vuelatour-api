-- Catálogo de distancias punto a punto (reunión 10 jun): las millas náuticas
-- deben calcularse SOBRE AEROVÍAS, no en línea recta (si el día del vuelo no
-- está visual hay que ir por aerovía; cotizar la directa te deja corto).
-- Alejandro tiene el archivo con las distancias correctas de los tramos
-- principales; este catálogo lo recibe (import) y es editable en el admin.
-- El cotizador/rutas autocompletan millas con esta prioridad:
--   catálogo de distancias > tramos de rutas guardadas > ortodrómica (aprox).

create table if not exists public.distancia_tramo (
  id uuid primary key default gen_random_uuid(),
  origen_iata varchar(4) not null,
  destino_iata varchar(4) not null,
  millas_nauticas decimal(8,2) not null check (millas_nauticas > 0),
  fuente text not null default 'AEROVIA',
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint distancia_tramo_par_unico unique (origen_iata, destino_iata),
  constraint distancia_tramo_distintos check (origen_iata <> destino_iata)
);

comment on table public.distancia_tramo is
  'Millas náuticas por aerovía entre pares de aeropuertos. Fuente del autollenado del cotizador.';

alter table public.distancia_tramo enable row level security;
