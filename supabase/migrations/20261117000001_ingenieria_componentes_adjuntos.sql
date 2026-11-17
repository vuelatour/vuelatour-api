-- 20261117000001_ingenieria_componentes_adjuntos.sql
--
-- MANTENIMIENTO UNIFICADO: COMPONENTES DEL AVIÓN CON VIDA LÍMITE Y ARCHIVOS
-- DE INGENIERÍA (17-nov-2026, API 0.0.140, invariante 135).
--
-- Pedido del cliente con las capturas del expediente del N990GG: «en
-- mantenimientos la opción para subir una foto o pdf […] porque cada que se
-- le da un mantenimiento el taller te entrega un sticker, como evidencia de
-- que sí se le hizo el mantenimiento […] poder descargarlas una vez que ya
-- las hayan subido», «se incluya en ese apartado de mantenimiento también la
-- lista de componentes del avión y su seguimiento […] saber cuánto tiempo le
-- queda a un foco, a una llanta» y «poder subir uno o varios documentos por
-- componente para comprobar el cambio de componente, a lo mejor una factura
-- de la compra».
--
-- QUÉ HACE (ADITIVA: dos tablas nuevas, ninguna existente cambia):
--   1. `componente_aeronave`: los componentes del avión que se siguen por
--      horas y/o por calendario (llantas, focos, batería del ELT, extintor…).
--      El «cuánto le queda» NO se guarda: lo calcula el API con el Hobbs del
--      avión (tacómetros) y el día de hoy en hora Cancún.
--   2. `adjunto_ingenieria`: los archivos (foto o PDF) de UN mantenimiento,
--      UN componente, UN motor o UNA hélice. Guarda la llave del objeto en el
--      bucket privado `documentos-flota`; el archivo se ve y se baja con una
--      URL firmada que entrega el API.
--
-- Baja = sello (`eliminado_at` / `eliminado_por`): la fila se conserva y el
-- archivo sigue en el bucket. Un componente reemplazado tampoco se pierde:
-- pasa a RETIRADO y el nuevo lo señala con `reemplaza_a_id`.
--
-- Sin disparadores: `updated_at` lo sella el API en cada cambio.
-- Las llaves foráneas van sin cláusula de cascada (se quedan en NO ACTION):
-- antes de quitar un motor o una hélice, el API retira por código sus filas
-- de `adjunto_ingenieria`.
--
-- El API 0.0.140 funciona con y sin estas tablas: sin ellas las lecturas
-- responden `disponible: false` y las escrituras 503 MIGRACION_PENDIENTE; se
-- enciende solo en ≤ 10 min al aplicarla, sin reiniciar.
--
-- REVERSA (solo si el API vuelve a ≤ 0.0.139): quitar las dos tablas desde
-- el SQL Editor, primero `adjunto_ingenieria` y después
-- `componente_aeronave`. Nada más depende de ellas.
--
-- Se puede aplicar por MCP (no lleva sentencias destructivas); después,
-- `get_advisors`. Prueba en seco: `_dryrun/20261117000001_…dryrun.sql`.

-- >>> CUERPO
create table if not exists public.componente_aeronave (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid not null references public.aeronave(id),
  nombre text not null,
  categoria text,
  posicion text,
  numero_parte text,
  numero_serie text,
  fabricante text,
  fecha_instalacion date,
  horas_aeronave_instalacion numeric(10,2),
  horas_previas numeric(10,2) not null default 0,
  limite_horas numeric(10,2),
  limite_meses integer,
  fecha_vencimiento date,
  aviso_horas numeric(10,2) not null default 10,
  aviso_dias integer not null default 30,
  notas text,
  estado text not null default 'INSTALADO',
  fecha_retiro date,
  horas_aeronave_retiro numeric(10,2),
  motivo_retiro text,
  reemplaza_a_id uuid references public.componente_aeronave(id),
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id),
  updated_by uuid references public.usuario(id),
  eliminado_at timestamptz,
  eliminado_por uuid references public.usuario(id),
  constraint componente_aeronave_nombre_chk
    check (char_length(btrim(nombre)) between 2 and 120),
  constraint componente_aeronave_estado_chk
    check (estado in ('INSTALADO', 'RETIRADO')),
  constraint componente_aeronave_limite_horas_chk
    check (limite_horas is null or limite_horas > 0),
  constraint componente_aeronave_limite_meses_chk
    check (limite_meses is null or limite_meses between 1 and 600),
  constraint componente_aeronave_horas_chk
    check (
      horas_previas >= 0
      and (horas_aeronave_instalacion is null or horas_aeronave_instalacion >= 0)
      and (horas_aeronave_retiro is null or horas_aeronave_retiro >= 0)
    ),
  constraint componente_aeronave_avisos_chk
    check (aviso_horas >= 0 and aviso_dias >= 0),
  constraint componente_aeronave_retiro_chk
    check (
      estado = 'RETIRADO'
      or (
        fecha_retiro is null
        and horas_aeronave_retiro is null
        and motivo_retiro is null
      )
    )
);

comment on table public.componente_aeronave is
  'Componentes del avión con seguimiento de vida (17-nov-2026, invariante 135 del API): llantas, focos, baterías, extintor… Lo que le queda (horas y días) lo calcula el API con el Hobbs del avión y el día de hoy en Cancún; aquí solo viven los datos capturados. Baja = eliminado_at; un componente cambiado pasa a RETIRADO y el nuevo lo señala con reemplaza_a_id.';
comment on column public.componente_aeronave.horas_aeronave_instalacion is
  'Hobbs del AVIÓN el día que se instaló el componente. Horas en servicio = horas_previas + (Hobbs de hoy − este valor).';
comment on column public.componente_aeronave.horas_previas is
  'Horas que el componente ya traía al instalarse (usado). 0 = nuevo.';
comment on column public.componente_aeronave.limite_horas is
  'Vida límite en horas del componente. Null = no se sigue por horas.';
comment on column public.componente_aeronave.limite_meses is
  'Vida límite de calendario, en meses desde fecha_instalacion. Null = no se sigue por tiempo.';
comment on column public.componente_aeronave.fecha_vencimiento is
  'Fecha EXACTA de vencimiento (la de la etiqueta del fabricante). Si existe, manda sobre fecha_instalacion + limite_meses.';
comment on column public.componente_aeronave.aviso_horas is
  'Con cuántas horas de anticipación se marca «por vencer».';
comment on column public.componente_aeronave.aviso_dias is
  'Con cuántos días de anticipación se marca «por vencer».';
comment on column public.componente_aeronave.reemplaza_a_id is
  'Componente (ya RETIRADO) al que este sustituyó. Null = no entró por reemplazo.';
comment on column public.componente_aeronave.eliminado_at is
  'Baja con sello (captura por error): la fila se conserva y deja de listarse.';

create index if not exists idx_componente_aeronave_avion
  on public.componente_aeronave (aeronave_id)
  where eliminado_at is null;

create index if not exists idx_componente_aeronave_reemplaza
  on public.componente_aeronave (reemplaza_a_id)
  where reemplaza_a_id is not null;

alter table public.componente_aeronave enable row level security;

create table if not exists public.adjunto_ingenieria (
  id uuid primary key default gen_random_uuid(),
  aeronave_id uuid references public.aeronave(id),
  mantenimiento_id uuid references public.mantenimiento(id),
  componente_id uuid references public.componente_aeronave(id),
  motor_id uuid references public.motor(id),
  helice_id uuid references public.helice(id),
  storage_path text not null,
  nombre text not null,
  mime text not null,
  bytes integer not null,
  etiqueta text,
  nota text,
  subido_por uuid references public.usuario(id),
  created_at timestamptz not null default now(),
  eliminado_at timestamptz,
  eliminado_por uuid references public.usuario(id),
  constraint adjunto_ingenieria_destino_chk
    check (num_nonnulls(mantenimiento_id, componente_id, motor_id, helice_id) = 1),
  constraint adjunto_ingenieria_bytes_chk
    check (bytes between 1 and 10485760),
  constraint adjunto_ingenieria_nombre_chk
    check (char_length(btrim(nombre)) between 1 and 200),
  constraint adjunto_ingenieria_path_chk
    check (
      storage_path ~ '^oficina/[A-Za-z0-9._/-]+$'
      and position('..' in storage_path) = 0
    )
);

comment on table public.adjunto_ingenieria is
  'Archivos de ingeniería (17-nov-2026, invariante 135 del API): la foto o el PDF del sticker de un mantenimiento, la factura o el certificado de un componente, de un motor o de una hélice. Exactamente UN destino por fila. Guarda la llave del objeto en el bucket privado documentos-flota; se ve y se baja con URL firmada del API. Baja = eliminado_at (el archivo se conserva en el bucket).';
comment on column public.adjunto_ingenieria.aeronave_id is
  'Avión donde se subió. Un motor o una hélice pueden trasladarse: sus archivos los sigue motor_id / helice_id, no este campo.';
comment on column public.adjunto_ingenieria.storage_path is
  'Llave dentro del bucket documentos-flota (oficina/…). Nunca sale en las respuestas del API.';
comment on column public.adjunto_ingenieria.etiqueta is
  'Qué es el archivo: STICKER, FACTURA, CERTIFICADO, ORDEN_TRABAJO, BITACORA u OTRO (lo valida el API).';

create unique index if not exists uq_adjunto_ingenieria_path
  on public.adjunto_ingenieria (storage_path);

create index if not exists idx_adjunto_ingenieria_avion
  on public.adjunto_ingenieria (aeronave_id)
  where eliminado_at is null;

create index if not exists idx_adjunto_ingenieria_mantenimiento
  on public.adjunto_ingenieria (mantenimiento_id)
  where eliminado_at is null and mantenimiento_id is not null;

create index if not exists idx_adjunto_ingenieria_componente
  on public.adjunto_ingenieria (componente_id)
  where eliminado_at is null and componente_id is not null;

create index if not exists idx_adjunto_ingenieria_motor
  on public.adjunto_ingenieria (motor_id)
  where eliminado_at is null and motor_id is not null;

create index if not exists idx_adjunto_ingenieria_helice
  on public.adjunto_ingenieria (helice_id)
  where eliminado_at is null and helice_id is not null;

alter table public.adjunto_ingenieria enable row level security;
-- <<< CUERPO
