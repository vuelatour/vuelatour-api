-- Migration: 20260515000003_vencimientos_seed
-- Lista maestra inicial de tipos de documento (doc 5.7). Configurable despues
-- desde admin. Idempotente: bail-out si ya hay tipos.

do $$
begin
  if exists (select 1 from public.tipo_documento) then
    raise notice 'vencimientos_seed: ya poblada, skipping';
    return;
  end if;

  insert into public.tipo_documento (nombre, ambito, forma_default, umbral_alerta_dias, es_critico, notas)
  values
    ('Tarjeta de aeronavegabilidad', 'AERONAVE', 'FECHA', 60, true,  'Documento critico: su vencimiento bloquea vuelos.'),
    ('Seguro',                       'AERONAVE', 'FECHA', 30, true,  'Poliza de seguro de la aeronave.'),
    ('Bianual',                      'AERONAVE', 'FECHA', 45, true,  'Inspeccion bianual.'),
    ('Homologacion de Ruido',        'AERONAVE', 'PERMANENTE', 0, false, 'No vence; se registra para tenerla a la mano.'),
    ('Peso y balance',               'AERONAVE', 'FECHA', 30, false, null),
    ('Internacion',                  'AERONAVE', 'FECHA', 30, false, 'Permiso de internacion (aeronaves N operando en MX).'),
    ('NDT',                          'AERONAVE', 'FECHA', 30, false, 'Non-destructive testing.'),
    ('DART',                         'AERONAVE', 'FECHA', 30, false, null),
    ('Licencia MX',                  'PILOTO',   'FECHA', 45, true,  'Licencia AFAC.'),
    ('Licencia USA',                 'PILOTO',   'FECHA', 45, true,  'Licencia FAA.'),
    ('Certificado medico',           'PILOTO',   'FECHA', 30, true,  'Certificado medico vigente.'),
    ('Curso recurrente',             'PILOTO',   'FECHA', 30, false, 'Cursos y practicas recurrentes.'),
    ('TBO motor',                    'MOTOR',    'HORAS',  0, true,  'Time Between Overhauls; vence por horas de motor.');

  raise notice 'vencimientos_seed: 13 tipos de documento sembrados';
end $$;
