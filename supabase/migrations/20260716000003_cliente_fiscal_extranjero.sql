-- Datos fiscales completos del cliente (pedido 16 jul 2026): domicilio
-- fiscal como texto (el CFDI solo usa el CP, pero el equipo lo captura de la
-- constancia) y país de residencia para clientes EXTRANJEROS (se facturan
-- con el RFC genérico XEXX010101000).
alter table cliente
  add column if not exists domicilio_fiscal text,
  add column if not exists pais_residencia varchar(60);

comment on column cliente.domicilio_fiscal is
  'Domicilio fiscal completo (de la constancia de situación fiscal). El CFDI solo usa codigo_postal.';
comment on column cliente.pais_residencia is
  'País de residencia (clientes extranjeros, RFC XEXX010101000).';
