-- 20261117000001_ingenieria_componentes_adjuntos — dry-run (CUERPO copiado de la migración; pruebas a mano).
-- Proyecto PROD: bjesduasnzbzywofukbf (confirmar el ref antes de correrlo).
-- DRY-RUN: corre la migración y pruebas con escrituras REALES y lo revierte
-- TODO. Debe terminar en ERROR con el texto «DRYRUN_OK: …». Cualquier otro
-- error ⇒ NO aplicar y avisar.
-- No lleva sentencias destructivas: se puede correr por MCP o en el SQL
-- Editor.

begin;

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

-- ───────────── PRUEBAS (escrituras REALES; todo se revierte al final) ─────────────
-- Las filas de prueba se insertan DESPUÉS del DDL (regla del workspace).
do $t$
declare
  v_avion uuid;
  v_usuario uuid;
  v_mant uuid;
  v_motor uuid;
  v_helice uuid;
  v_comp uuid;
  v_viejo uuid;
  v_nuevo uuid;
  v_adj uuid;
  v_destinos integer := 0;
  v_rechazo boolean;
  v_sql text;
  v_estado text;
  v_previas numeric;
  v_aviso_h numeric;
  v_aviso_d integer;
  v_limite numeric;
  v_rls integer;
  v_trg integer;
  v_n integer;
begin
  -- Datos reales para colgar las pruebas (solo lectura de las tablas base).
  select id into v_avion from public.aeronave order by matricula limit 1;
  if v_avion is null then
    raise exception 'DRYRUN: no hay aviones para probar';
  end if;
  select id into v_usuario from public.usuario order by id limit 1;
  select id into v_mant
    from public.mantenimiento where aeronave_id = v_avion order by id limit 1;
  if v_mant is null then
    select id into v_mant from public.mantenimiento order by id limit 1;
  end if;
  select id into v_motor from public.motor order by id limit 1;
  select id into v_helice from public.helice order by id limit 1;

  -- T1: alta con lo mínimo (INSERT real) ⇒ valores por omisión.
  insert into public.componente_aeronave (aeronave_id, nombre)
  values (v_avion, 'Foco de aterrizaje (dry-run)')
  returning id into v_comp;
  select estado, horas_previas, aviso_horas, aviso_dias
    into v_estado, v_previas, v_aviso_h, v_aviso_d
    from public.componente_aeronave where id = v_comp;
  if v_estado <> 'INSTALADO' or v_previas <> 0 or v_aviso_h <> 10 or v_aviso_d <> 30 then
    raise exception 'DRYRUN T1: valores por omisión inesperados (% · % · % · %)',
      v_estado, v_previas, v_aviso_h, v_aviso_d;
  end if;

  -- T2: alta completa y su edición (UPDATE real con el sello de updated_at
  -- que escribe el API; un opcional se limpia con null).
  insert into public.componente_aeronave (
    aeronave_id, nombre, categoria, posicion, numero_parte, numero_serie,
    fabricante, fecha_instalacion, horas_aeronave_instalacion, horas_previas,
    limite_horas, limite_meses, fecha_vencimiento, aviso_horas, aviso_dias,
    notas, created_by, updated_by
  ) values (
    v_avion, 'Llanta principal izquierda (dry-run)', 'Tren de aterrizaje',
    'Principal izquierda', 'PN-DRYRUN', 'SN-DRYRUN-1', 'Fabricante de prueba',
    date '2026-11-01', 5500.5, 12.25, 500, 24, date '2028-11-01', 15, 45,
    'prueba dry-run', v_usuario, v_usuario
  )
  returning id into v_viejo;
  update public.componente_aeronave
     set limite_horas = 600, notas = null, updated_at = now(), updated_by = v_usuario
   where id = v_viejo;
  select limite_horas into v_limite from public.componente_aeronave where id = v_viejo;
  if v_limite <> 600 then
    raise exception 'DRYRUN T2: la edición no guardó el límite (%)', v_limite;
  end if;

  -- T3: reemplazo — el nuevo entra señalando al viejo y el viejo pasa a
  -- RETIRADO con sus datos de retiro (mismo orden que el API).
  insert into public.componente_aeronave (
    aeronave_id, nombre, categoria, posicion, fecha_instalacion,
    horas_aeronave_instalacion, limite_horas, limite_meses, reemplaza_a_id,
    created_by, updated_by
  ) values (
    v_avion, 'Llanta principal izquierda (dry-run)', 'Tren de aterrizaje',
    'Principal izquierda', date '2026-11-17', 5599.4, 600, 24, v_viejo,
    v_usuario, v_usuario
  )
  returning id into v_nuevo;
  update public.componente_aeronave
     set estado = 'RETIRADO', fecha_retiro = date '2026-11-17',
         horas_aeronave_retiro = 5599.4, motivo_retiro = 'Desgaste (dry-run)',
         updated_at = now(), updated_by = v_usuario
   where id = v_viejo and estado = 'INSTALADO' and eliminado_at is null;
  select count(*) into v_n
    from public.componente_aeronave
   where reemplaza_a_id = v_viejo and estado = 'INSTALADO';
  if v_n <> 1 then
    raise exception 'DRYRUN T3: el reemplazo no quedó ligado (%)', v_n;
  end if;

  -- T4: lo que los candados de `componente_aeronave` deben RECHAZAR.
  foreach v_sql in array array[
    format('insert into public.componente_aeronave (aeronave_id, nombre) values (%L, %L)', v_avion, '  a  '),
    format('insert into public.componente_aeronave (aeronave_id, nombre) values (%L, %L)', v_avion, repeat('x', 121)),
    format('insert into public.componente_aeronave (aeronave_id, nombre, estado) values (%L, %L, %L)', v_avion, 'Estado inválido', 'ROTO'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, limite_horas) values (%L, %L, 0)', v_avion, 'Límite en cero'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, limite_meses) values (%L, %L, 0)', v_avion, 'Meses en cero'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, limite_meses) values (%L, %L, 601)', v_avion, 'Meses de más'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, horas_previas) values (%L, %L, -1)', v_avion, 'Previas negativas'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, horas_aeronave_instalacion) values (%L, %L, -1)', v_avion, 'Hobbs negativo'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, estado, horas_aeronave_retiro) values (%L, %L, %L, -1)', v_avion, 'Retiro negativo', 'RETIRADO'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, aviso_horas) values (%L, %L, -1)', v_avion, 'Aviso de horas negativo'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, aviso_dias) values (%L, %L, -1)', v_avion, 'Aviso de días negativo'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, fecha_retiro) values (%L, %L, date %L)', v_avion, 'Retiro sin retirar', '2026-11-17'),
    format('insert into public.componente_aeronave (aeronave_id, nombre, motivo_retiro) values (%L, %L, %L)', v_avion, 'Motivo sin retirar', 'x')
  ] loop
    v_rechazo := false;
    begin
      execute v_sql;
    exception when check_violation then
      v_rechazo := true;
    end;
    if not v_rechazo then
      raise exception 'DRYRUN T4: se aceptó lo que debía rechazarse: %', v_sql;
    end if;
  end loop;
  -- Sin avión y con un avión que no existe.
  v_rechazo := false;
  begin
    insert into public.componente_aeronave (nombre) values ('Sin avión');
  exception when not_null_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T4: se aceptó un componente sin avión';
  end if;
  v_rechazo := false;
  begin
    insert into public.componente_aeronave (aeronave_id, nombre)
    values (gen_random_uuid(), 'Avión inexistente');
  exception when foreign_key_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T4: se aceptó un componente de un avión inexistente';
  end if;

  -- T5: un adjunto por cada destino que se pueda armar con datos existentes.
  insert into public.adjunto_ingenieria (
    aeronave_id, componente_id, storage_path, nombre, mime, bytes, etiqueta,
    nota, subido_por
  ) values (
    v_avion, v_nuevo, 'oficina/dryrun-135-factura-llanta.pdf',
    'Factura llanta.pdf', 'application/pdf', 123456, 'FACTURA',
    'prueba dry-run', v_usuario
  )
  returning id into v_adj;
  v_destinos := v_destinos + 1;
  if v_mant is not null then
    insert into public.adjunto_ingenieria (
      aeronave_id, mantenimiento_id, storage_path, nombre, mime, bytes, etiqueta
    ) values (
      v_avion, v_mant, 'oficina/dryrun-135-sticker.jpg', 'sticker.jpg',
      'image/jpeg', 2048, 'STICKER'
    );
    v_destinos := v_destinos + 1;
  end if;
  if v_motor is not null then
    insert into public.adjunto_ingenieria (
      aeronave_id, motor_id, storage_path, nombre, mime, bytes
    ) values (
      v_avion, v_motor, 'oficina/dryrun-135-motor.png', 'motor.png',
      'image/png', 1
    );
    v_destinos := v_destinos + 1;
  end if;
  if v_helice is not null then
    insert into public.adjunto_ingenieria (
      aeronave_id, helice_id, storage_path, nombre, mime, bytes
    ) values (
      v_avion, v_helice, 'oficina/dryrun-135-helice.webp', 'helice.webp',
      'image/webp', 10485760
    );
    v_destinos := v_destinos + 1;
  end if;

  -- T6: lo que los candados de `adjunto_ingenieria` deben RECHAZAR. El
  -- candado del destino se evalúa ANTES que las llaves foráneas: por eso el
  -- segundo destino puede ser un id inventado.
  foreach v_sql in array array[
    format('insert into public.adjunto_ingenieria (aeronave_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, 10)', v_avion, 'oficina/dryrun-135-sin-destino.pdf', 'a.pdf', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, motor_id, storage_path, nombre, mime, bytes) values (%L, %L, gen_random_uuid(), %L, %L, %L, 10)', v_avion, v_nuevo, 'oficina/dryrun-135-dos-destinos.pdf', 'a.pdf', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, %L, 0)', v_avion, v_nuevo, 'oficina/dryrun-135-vacio.pdf', 'a.pdf', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, %L, 10485761)', v_avion, v_nuevo, 'oficina/dryrun-135-pesado.pdf', 'a.pdf', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, %L, 10)', v_avion, v_nuevo, 'oficina/dryrun-135-sin-nombre.pdf', '   ', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, %L, 10)', v_avion, v_nuevo, 'gastos/dryrun-135-otro-prefijo.pdf', 'a.pdf', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, %L, 10)', v_avion, v_nuevo, 'oficina/../dryrun-135-sube.pdf', 'a.pdf', 'application/pdf'),
    format('insert into public.adjunto_ingenieria (aeronave_id, componente_id, storage_path, nombre, mime, bytes) values (%L, %L, %L, %L, %L, 10)', v_avion, v_nuevo, 'oficina/dryrun 135 con espacio.pdf', 'a.pdf', 'application/pdf')
  ] loop
    v_rechazo := false;
    begin
      execute v_sql;
    exception when check_violation then
      v_rechazo := true;
    end;
    if not v_rechazo then
      raise exception 'DRYRUN T6: se aceptó lo que debía rechazarse: %', v_sql;
    end if;
  end loop;
  -- El mismo archivo no se registra dos veces.
  v_rechazo := false;
  begin
    insert into public.adjunto_ingenieria (
      aeronave_id, componente_id, storage_path, nombre, mime, bytes
    ) values (
      v_avion, v_comp, 'oficina/dryrun-135-factura-llanta.pdf', 'otra.pdf',
      'application/pdf', 10
    );
  exception when unique_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T6: se registró dos veces el mismo archivo';
  end if;
  -- Destino que no existe y archivo sin llave.
  v_rechazo := false;
  begin
    insert into public.adjunto_ingenieria (
      aeronave_id, componente_id, storage_path, nombre, mime, bytes
    ) values (
      v_avion, gen_random_uuid(), 'oficina/dryrun-135-sin-componente.pdf',
      'a.pdf', 'application/pdf', 10
    );
  exception when foreign_key_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T6: se aceptó un adjunto de un componente inexistente';
  end if;
  v_rechazo := false;
  begin
    insert into public.adjunto_ingenieria (
      aeronave_id, componente_id, nombre, mime, bytes
    ) values (v_avion, v_nuevo, 'a.pdf', 'application/pdf', 10);
  exception when not_null_violation then
    v_rechazo := true;
  end;
  if not v_rechazo then
    raise exception 'DRYRUN T6: se aceptó un adjunto sin la llave del archivo';
  end if;

  -- T7: baja con sello (UPDATE real) de un adjunto y de un componente: las
  -- filas se conservan y dejan de contar como vivas.
  update public.adjunto_ingenieria
     set eliminado_at = now(), eliminado_por = v_usuario
   where id = v_adj and eliminado_at is null;
  update public.componente_aeronave
     set eliminado_at = now(), eliminado_por = v_usuario, updated_at = now()
   where id = v_comp and eliminado_at is null;
  select count(*) into v_n
    from public.adjunto_ingenieria where id = v_adj and eliminado_at is not null;
  if v_n <> 1 then
    raise exception 'DRYRUN T7: el adjunto no quedó con su sello de baja';
  end if;
  select count(*) into v_n
    from public.componente_aeronave
   where aeronave_id = v_avion and eliminado_at is null
     and nombre like '%(dry-run)';
  if v_n <> 2 then
    raise exception 'DRYRUN T7: quedaron % componentes vivos de prueba (se esperaban 2)', v_n;
  end if;

  -- T8: RLS encendido en las dos tablas y ningún disparador propio.
  select count(*) into v_rls
    from pg_class
   where oid in (
           'public.componente_aeronave'::regclass,
           'public.adjunto_ingenieria'::regclass
         )
     and relrowsecurity;
  select count(*) into v_trg
    from pg_trigger
   where tgrelid in (
           'public.componente_aeronave'::regclass,
           'public.adjunto_ingenieria'::regclass
         )
     and not tgisinternal;
  if v_rls <> 2 or v_trg <> 0 then
    raise exception 'DRYRUN T8: RLS en % de 2 tablas · % disparador(es) propio(s)', v_rls, v_trg;
  end if;

  raise exception 'DRYRUN_OK: componentes y adjuntos de ingeniería — altas, edición, reemplazo, % destino(s) de adjunto, bajas con sello y candados correctos (todo revertido)', v_destinos;
end $t$;

rollback;
