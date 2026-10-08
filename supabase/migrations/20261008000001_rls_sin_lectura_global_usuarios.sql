-- 8-oct-2026 · RLS: se retiran las políticas de LECTURA GLOBAL para usuarios
-- autenticados ("<tabla>_read_active_user" y "aeronave_imagen_read_public").
--
-- Por qué: desde mayo-2026 cualquier usuario con cuenta ACTIVA (piloto,
-- mecánico, visitante) podía leer TODAS las filas de 32 tablas (vuelo, escala,
-- cobro_vuelo, gasto, cliente, cuenta_bancaria, movimiento_bancario,
-- tarjeta_corporativa…) llamando a PostgREST directo con la llave pública de
-- la app y su propio JWT, saltándose los filtros por rol del API
-- (caso 7-oct-2026: «los pilotos ven vuelos que no son de ellos»).
--
-- Impacto: ninguno en app/panel/pyservices. Toda lectura va por el API con
-- la service key (bypass de RLS); ni la app Flutter ni el panel Next leen
-- tablas con el token del usuario (verificado: cero `.from(` fuera de
-- storage, cero realtime/rpc, cero edge functions). No existen políticas de
-- escritura para `authenticated`, así que RLS queda en "denegar todo" para
-- usuarios finales. Se conservan `usuario_self_select` (fila propia) y
-- `usuario_admin_select_all` (solo ADMIN).
--
-- Reversión: recrear la política con
--   create policy "<nombre>" on public.<tabla> for select using (
--     exists (select 1 from public.usuario u
--             where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO'));

drop policy if exists "aeronave_read_active_user" on public.aeronave;
drop policy if exists "aeronave_discrepancia_read_active_user" on public.aeronave_discrepancia;
drop policy if exists "aeronave_imagen_read_public" on public.aeronave_imagen;
drop policy if exists "aeronave_seguro_read_active_user" on public.aeronave_seguro;
drop policy if exists "aeronave_socio_read_active_user" on public.aeronave_socio;
drop policy if exists "aeropuerto_read_active_user" on public.aeropuerto;
drop policy if exists "cliente_read_active_user" on public.cliente;
drop policy if exists "cobro_vuelo_read_active_user" on public.cobro_vuelo;
drop policy if exists "cotizacion_version_history_read_active_user" on public.cotizacion_version_history;
drop policy if exists "cuenta_bancaria_read_active_user" on public.cuenta_bancaria;
drop policy if exists "entidad_fiscal_read_active_user" on public.entidad_fiscal_emisora;
drop policy if exists "escala_read_active_user" on public.escala;
drop policy if exists "factura_recibida_read_active_user" on public.factura_recibida;
drop policy if exists "fondo_caja_read_active_user" on public.fondo_caja;
drop policy if exists "gasto_read_active_user" on public.gasto;
drop policy if exists "helice_read_active_user" on public.helice;
drop policy if exists "inventario_item_read_active_user" on public.inventario_item;
drop policy if exists "inventario_movimiento_read_active_user" on public.inventario_movimiento;
drop policy if exists "motor_read_active_user" on public.motor;
drop policy if exists "motor_traslado_read_active_user" on public.motor_traslado;
drop policy if exists "movimiento_bancario_read_active_user" on public.movimiento_bancario;
drop policy if exists "movimiento_bancario_gasto_read_active_user" on public.movimiento_bancario_gasto;
drop policy if exists "movimiento_fondo_read_active_user" on public.movimiento_fondo;
drop policy if exists "multa_read_active_user" on public.multa;
drop policy if exists "proveedor_read_active_user" on public.proveedor;
drop policy if exists "reserva_overhaul_read_active_user" on public.reserva_overhaul;
drop policy if exists "ruta_read_active_user" on public.ruta_predefinida;
drop policy if exists "ruta_tramo_read_active_user" on public.ruta_predefinida_tramo;
drop policy if exists "tarjeta_read_active_user" on public.tarjeta_corporativa;
drop policy if exists "tipo_documento_read_active_user" on public.tipo_documento;
drop policy if exists "vencimiento_read_active_user" on public.vencimiento;
drop policy if exists "vuelo_read_active_user" on public.vuelo;
