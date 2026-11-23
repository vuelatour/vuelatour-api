-- 23-nov-2026 · QUITAR UN COBRO CON UTILIDADES DA DE BAJA SU ENTREGA, EN LA
-- MISMA SENTENCIA.
--
-- Hermana de `20261123000001_cobro_con_utilidades.sql` (ahí está el modelo).
-- Un cobro con utilidades del socio es un `cobro_vuelo` ligado 1 a 1 a una
-- entrega (`reparto_pago`) por `cobro_vuelo.reparto_pago_id`. Al quitarse el
-- cobro —desde el vuelo o por cualquier otro camino— la entrega tiene que
-- darse de baja: si no, al socio se le seguiría descontando un vuelo que ya
-- no está cobrado.
--
-- El API 0.0.148 ya lo hace (borra el cobro y da de baja la entrega), pero son
-- dos escrituras: si la segunda falla, la entrega queda viva y el API responde
-- con el error que dice qué entrega dar de baja a mano. Este trigger cierra
-- esa ventana: la baja ocurre DENTRO del mismo DELETE del cobro.
--
-- `tg_reparto_pago_de_vuelo` (000001) no lo estorba: mira si EXISTE un cobro
-- que cite la entrega y, en un AFTER DELETE, esa fila ya no existe.
--
-- VA APARTE de la 000001 porque su dry-run necesita un DELETE real, y el MCP
-- de Supabase de este cliente declina toda sentencia con borrados: se prueba y
-- se aplica por el SQL Editor (`docs/sql-aplicar-23-nov-2026-cobro-con-utilidades/`).
--
-- Dry-run: `_dryrun/20261123000002_cobro_con_utilidades_baja.dryrun.sql`.

do $$
begin
  if not exists (
    select 1 from information_schema.columns
     where table_schema = 'public' and table_name = 'cobro_vuelo'
       and column_name = 'reparto_pago_id'
  ) then
    raise exception 'Falta la migración 20261123000001 (cobro_vuelo.reparto_pago_id): aplícala primero';
  end if;
end $$;

create or replace function public.tg_cobro_vuelo_utilidades_baja()
returns trigger language plpgsql security definer set search_path to '' as $fn$
begin
  if old.reparto_pago_id is null then
    return old;
  end if;
  update public.reparto_pago p
     set deleted_at = now(),
         deleted_by = old.updated_by,
         updated_by = old.updated_by,
         motivo_baja = 'Se quitó el cobro con utilidades del vuelo'
   where p.id = old.reparto_pago_id
     and p.deleted_at is null;
  return old;
end $fn$;

create or replace trigger trg_cobro_vuelo_utilidades_baja
  after delete on public.cobro_vuelo
  for each row execute function public.tg_cobro_vuelo_utilidades_baja();

-- PERMISOS: las funciones de este lote (las de la 000001 y la de aquí) solo
-- las ejecuta el API con la service key. Va en esta migración porque REVOKE
-- también lo declina el MCP (patrón de 20261014000003).
revoke execute on function public.tg_cobro_vuelo_utilidades() from public, anon, authenticated;
grant execute on function public.tg_cobro_vuelo_utilidades() to service_role;
revoke execute on function public.tg_reparto_pago_de_vuelo() from public, anon, authenticated;
grant execute on function public.tg_reparto_pago_de_vuelo() to service_role;
revoke execute on function public.tg_cobro_vuelo_utilidades_baja() from public, anon, authenticated;
grant execute on function public.tg_cobro_vuelo_utilidades_baja() to service_role;
revoke execute on function public.cobro_utilidades_registrar(jsonb, jsonb) from public, anon, authenticated;
grant execute on function public.cobro_utilidades_registrar(jsonb, jsonb) to service_role;
