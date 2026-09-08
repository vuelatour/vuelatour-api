-- 7-sep-2026 · Gastos: momento REAL de captura, aparte de la fecha del consumo.
-- created_at es cuando el registro llegó al servidor; con capturas sin señal
-- (outbox de la app) eso puede ser horas después de que el piloto lo guardó.
-- capturado_en lo manda la app al guardar (hora local con offset); el panel y
-- las cargas masivas lo dejan igual a created_at. Solo lectura/auditoría: no
-- participa en ningún cálculo de dinero ni en las ventanas de edición.

alter table public.gasto
  add column if not exists capturado_en timestamptz;

comment on column public.gasto.capturado_en is
  'Fecha y hora en que se capturó el gasto (app: al guardar, aunque fuera sin señal; panel/masivo: = created_at). Distinto de fecha_gasto (consumo) y de created_at (llegada al servidor).';

update public.gasto set capturado_en = created_at where capturado_en is null;

create index if not exists idx_gasto_capturado_en on public.gasto (capturado_en desc);
