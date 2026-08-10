-- Banderas globales de comportamiento del sistema (patrón alerta_config:
-- clave PK + columnas tipadas + auditoría; RLS sin políticas = solo la API
-- con service key). Primera bandera: captura de tacómetro con foto e IA en
-- la app del piloto — el cliente quiere poder apagarla (capturar a mano es
-- fácil y ahorra memoria del teléfono y créditos de IA) y compararla.
create table if not exists configuracion_sistema (
  clave varchar(60) primary key,
  activa boolean not null default true,
  descripcion text not null,
  updated_at timestamptz not null default now(),
  updated_by uuid references usuario(id)
);

alter table configuracion_sistema enable row level security;

insert into configuracion_sistema (clave, activa, descripcion) values
  (
    'captura_taco_foto_ia',
    true,
    'La app del piloto pide foto del tacómetro y la lee con IA. Apagada: el piloto solo teclea la lectura (sin foto ni IA; no consume créditos ni memoria). El servidor sigue aceptando fotos de apps con caché vieja.'
  )
on conflict (clave) do nothing;
