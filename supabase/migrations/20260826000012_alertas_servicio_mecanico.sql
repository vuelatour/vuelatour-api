-- El aviso de "servicio por horas cerca" y los recordatorios de
-- mantenimiento programado también van al MECÁNICO (pedido 26-ago-2026:
-- él confirma la fecha de entrada al taller desde la app).
update alerta_config
   set roles = array['ADMIN','COORDINADOR','MECANICO']
 where clave in ('servicio_horas', 'mantenimiento_programado');
