-- Un vencimiento POR HORAS (TBO de motor, etc.) también puede vencer por
-- CALENDARIO (pedido del cliente, 4 ago 2026: "TBO 2000 hrs o 12 años, lo
-- que ocurra primero"). Se relaja la coherencia para permitir
-- fecha_vencimiento OPCIONAL cuando vence_por = 'HORAS'; el API calcula el
-- estado con el límite más próximo y la alerta diaria cubre ambos.

-- El CHECK original quedó sin nombre explícito: se localiza por su definición
-- (es el único que menciona vence_por) para no depender del nombre autogenerado.
do $$
declare c record;
begin
  for c in
    select conname from pg_constraint
    where conrelid = 'public.vencimiento'::regclass
      and contype = 'c'
      and pg_get_constraintdef(oid) ilike '%vence_por%'
  loop
    execute format('alter table public.vencimiento drop constraint %I', c.conname);
  end loop;
end $$;

alter table public.vencimiento
  add constraint vencimiento_vence_por_coherencia check (
    (vence_por = 'FECHA' and fecha_vencimiento is not null and horas_limite is null)
    or (vence_por = 'HORAS' and horas_limite is not null)
    or (vence_por = 'PERMANENTE' and fecha_vencimiento is null and horas_limite is null)
  );

comment on column public.vencimiento.fecha_vencimiento is
  'Límite calendario. Obligatoria si vence_por=FECHA; OPCIONAL si vence_por=HORAS (TBO por tiempo además de horas).';
