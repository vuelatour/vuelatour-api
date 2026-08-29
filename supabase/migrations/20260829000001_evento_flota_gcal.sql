-- Espejo en Google Calendar para eventos no-vuelo (evento_flota), igual que
-- vuelo/escala/piloto_descanso. Lo escribe solo calendar-sync.service.
alter table evento_flota add column if not exists google_calendar_id text;
