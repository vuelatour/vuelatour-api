-- Volcada desde prod (ya aplicada como 20260703213102_piloto_descanso_gcal):
-- este archivo solo versiona el SQL para poder reconstruir el esquema desde el repo.

alter table public.piloto_descanso
  add column if not exists google_calendar_id text;
