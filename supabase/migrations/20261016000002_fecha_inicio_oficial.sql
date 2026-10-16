-- =====================================================================
-- 20261016000002_fecha_inicio_oficial.sql — INICIO OFICIAL DEL SISTEMA
-- (16-oct-2026, API 0.0.84, invariante 86 del CLAUDE.md del API).
--
-- PEDIDO DEL CLIENTE: «Quitemos todo lo de Agosto ... para que iniciemos en
-- septiembre 2026 de forma oficial y no causar confusión, porque agosto ya
-- lo cerraron en el sistema antiguo».
--
-- QUÉ HACE: siembra UNA fila de configuracion_sistema, clave
-- fecha_inicio_oficial, valor_json ["2026-09-01"] (día de pared Cancún),
-- activa = true. NO modifica ningún dato: el API (0.0.84+) solo OCULTA lo
-- anterior en listados, filtros, pendientes y reportes por periodo. Nada
-- se pierde; el detalle por id sigue abriendo todo. No toca inventario ni
-- horas.
--
-- SIN DDL. Idempotente (on conflict do nothing). Sin ninguna sentencia
-- destructiva de las que el MCP de Supabase declina.
--
-- ORDEN DE DESPLIEGUE (esta fila es el interruptor): (1) API 0.0.84
-- (GET /v1/version = 0.0.84); (2) panel; (3) esta migración. Con un API
-- anterior la fila saldría en Configuración como un switch apagable.
--
-- REVERSIBLE con UPDATE (el MCP lo acepta), efecto en <= 60 s por instancia:
--   apagar:   update public.configuracion_sistema set activa = false,
--             updated_at = now() where clave = 'fecha_inicio_oficial';
--   prender:  ... set activa = true ...
--   cambiar:  ... set valor_json = '["2026-10-01"]'::jsonb ...
--
-- Dry-run (ANTES de aplicar, por execute_sql): bloque do ... raise
-- exception 'DRYRUN_OK ...' del paquete del 16-oct (dryrun-mcp.sql).
-- =====================================================================

insert into public.configuracion_sistema (clave, activa, descripcion, valor_json)
values (
  'fecha_inicio_oficial',
  true,
  'Inicio oficial del sistema (día Cancún). Lo anterior se conserva pero no aparece en listados, filtros, pendientes ni reportes por periodo. Se cambia por SQL; activa=false lo apaga (invariante 86 del API).',
  '["2026-09-01"]'::jsonb
)
on conflict (clave) do nothing;

-- Verificación: la fila existe (la sembrada aquí o una previa). Si una fila
-- previa trae otro valor, se respeta (on conflict do nothing) y se avisa.
do $$
declare
  v_activa boolean;
  v_valor jsonb;
begin
  select activa, valor_json into v_activa, v_valor
    from public.configuracion_sistema
   where clave = 'fecha_inicio_oficial';
  if not found then
    raise exception 'fecha_inicio_oficial: la fila no quedó';
  end if;
  if v_valor is distinct from '["2026-09-01"]'::jsonb or not v_activa then
    raise notice 'fecha_inicio_oficial ya existía con activa=% valor_json=% (se respeta)', v_activa, v_valor;
  end if;
end $$;
