-- 20261109000001_correo_cliente.sql
--
-- BITÁCORA de los correos que se le mandan a un CLIENTE (9-nov-2026, API
-- 0.0.133, invariante 128).
--
-- Pedido de la oficina: «que se cancele el envío automático a los clientes…
-- que solo hasta que ellos le den en enviar de forma manual, solo si se
-- requiere, y saber si se mandó o no y con qué contenido».
--
-- Hasta el API 0.0.132 confirmar una cotización mandaba SOLO el correo
-- «Vuelo confirmado» y no quedaba rastro en la base. Desde el 0.0.133 el
-- correo solo sale con un clic en el panel y CADA intento se guarda aquí con
-- el contenido EXACTO, a quién, desde qué dirección, quién lo mandó y si
-- salió (ENVIADO) o no (FALLIDO + error).
--
-- SIN llave foránea a `vuelo`/`cliente`/`usuario` A PROPÓSITO (patrón
-- `vuelo_eliminado` / `gasto_bitacora`): la bitácora sobrevive a la baja del
-- vuelo; `folio` y `cliente_nombre` se copian para que la fila se lea sola.
--
-- ADITIVA: solo crea la tabla, sus índices y enciende RLS (la API usa la
-- service key; sin políticas nadie más la lee).

create table if not exists public.correo_cliente (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null,
  folio bigint,
  tipo text not null default 'CONFIRMACION_VUELO',
  cliente_id uuid,
  cliente_nombre text,
  destinatario text not null,
  remitente text,
  asunto text not null,
  html text not null,
  texto text,
  estado text not null,
  error text,
  proveedor_id text,
  enviado_por uuid,
  created_at timestamptz not null default now(),
  constraint correo_cliente_tipo_chk check (tipo in ('CONFIRMACION_VUELO')),
  constraint correo_cliente_estado_chk check (estado in ('ENVIADO', 'FALLIDO')),
  constraint correo_cliente_destinatario_chk check (length(btrim(destinatario)) > 0)
);

comment on table public.correo_cliente is
  'Bitácora de correos enviados a CLIENTES (9-nov-2026, invariante 128 del API). Un renglón por intento (ENVIADO o FALLIDO) con el contenido exacto. Sin FK a propósito. Solo la escribe QuotesCorreoService.enviar.';
comment on column public.correo_cliente.html is 'HTML EXACTO que se mandó (o se intentó mandar).';
comment on column public.correo_cliente.remitente is 'Dirección desde la que salió (RESEND_FROM).';
comment on column public.correo_cliente.proveedor_id is 'Id del mensaje en Resend (null si falló).';
comment on column public.correo_cliente.enviado_por is 'usuario.id de quien pulsó Enviar.';

create index if not exists idx_correo_cliente_vuelo
  on public.correo_cliente (vuelo_id, created_at desc);
create index if not exists idx_correo_cliente_created
  on public.correo_cliente (created_at desc);

alter table public.correo_cliente enable row level security;
