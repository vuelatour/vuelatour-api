-- Habilita RLS en las tablas de tiempo real creadas en la Tarea 7.
-- La API accede con service-role (bypassa RLS) y los clientes nunca las
-- consultan directo, así que RLS sin políticas cierra el acceso por
-- anon/authenticated (PostgREST) sin romper nada.
ALTER TABLE public.notificacion ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.dispositivo_push ENABLE ROW LEVEL SECURITY;
ALTER TABLE public.tramo_tiempo_promedio ENABLE ROW LEVEL SECURITY;
