-- 9-sep-2026 · Conciliación/auditoría Paywise (segunda parte de
-- 20260909000001, que solo agrega el valor del enum).
--
-- 1) Comisión default de Paywise (≈ 8.857 % sobre el bruto): al registrar un
--    cobro PAYWISE sin comisión capturada, la API la provisiona con este %
--    (monto BRUTO en `monto`, neto por diferencia — regla intacta). El estado
--    de cuenta de Paywise la corrige con la comisión REAL al conciliar.
insert into configuracion_sistema (clave, activa, valor_numerico, descripcion)
values (
  'paywise_comision_pct', true, 8.857,
  'Comisión (%) que Paywise retiene por cobro. Se provisiona por default en los cobros con método Paywise sin comisión capturada; el estado de cuenta de Paywise la sustituye por la real al conciliar.'
)
on conflict (clave) do nothing;

-- 2) Tipo de cuenta: BANCO (estado de cuenta clásico) o PASARELA (Paywise:
--    cada abono trae bruto/comisión/neto y liquida con días de retraso).
--    El auto-cruce de abonos usa ±5 días y el cotejo bruto/neto/referencia
--    cuando la cuenta es PASARELA.
alter table public.cuenta_bancaria
  add column if not exists tipo text not null default 'BANCO';
alter table public.cuenta_bancaria
  drop constraint if exists cuenta_bancaria_tipo_check;
alter table public.cuenta_bancaria
  add constraint cuenta_bancaria_tipo_check check (tipo in ('BANCO', 'PASARELA'));
comment on column public.cuenta_bancaria.tipo is
  'BANCO = estado de cuenta bancario; PASARELA = Paywise (abonos con bruto/comisión/neto, liquidación diferida).';

-- 3) Bruto y comisión por movimiento (solo los abonos de PASARELA los traen;
--    `monto` sigue siendo lo DEPOSITADO, el neto).
alter table public.movimiento_bancario
  add column if not exists monto_bruto numeric(14,2),
  add column if not exists comision_monto numeric(14,2);
comment on column public.movimiento_bancario.monto_bruto is
  'Solo pasarela (Paywise): lo que pagó el cliente antes de la comisión. monto = neto depositado.';
comment on column public.movimiento_bancario.comision_monto is
  'Solo pasarela (Paywise): comisión retenida en este movimiento (monto_bruto - monto).';

-- 4) El % de comisión del sobre de grupo estaba en numeric(5,2): 8.857 se
--    redondeaba a 8.86. Misma precisión de referencia que cobro_vuelo.
alter table public.cobro_grupo
  alter column comision_banco_pct type numeric(7,4);

-- 5) Semilla de la cuenta Paywise (MXN, PASARELA). Si la oficina ya la había
--    dado de alta (alias/banco con "paywise"), solo se marca como PASARELA.
update public.cuenta_bancaria
   set tipo = 'PASARELA'
 where tipo = 'BANCO'
   and (alias ilike '%paywise%' or banco ilike '%paywise%');
insert into public.cuenta_bancaria (alias, banco, moneda, razon_social, tipo, notas)
select 'Paywise', 'Paywise', 'MXN', 'AEROCHARTER', 'PASARELA',
       'Pasarela de cobro (link). Importa aquí el estado de cuenta de Paywise para auditar los cobros con método Paywise.'
 where not exists (
   select 1 from public.cuenta_bancaria
    where alias ilike '%paywise%' or banco ilike '%paywise%'
 );

-- 6) Lecturas de "cobros bancarios sin conciliar" y de la auditoría por
--    método y fecha.
create index if not exists idx_cobro_vuelo_metodo_fecha
  on public.cobro_vuelo (metodo_cobro, fecha_cobro);
create index if not exists idx_cobro_grupo_metodo_fecha
  on public.cobro_grupo (metodo_cobro, fecha_cobro);
