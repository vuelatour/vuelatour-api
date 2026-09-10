-- 10-sep-2026 · Lote 2 Ola B (B1) — control de versión «gana el servidor +
-- aviso» (doc funcional 6.1) para las ediciones que la app encolará sin red.
--
-- El API compara `if_updated_at` (el updated_at que la app leyó) contra el
-- de la fila (CAS) y responde 409 CONFLICTO_VERSION si alguien la modificó
-- en medio. Eso exige que `updated_at` SE MUEVA en cada UPDATE. `vuelo`,
-- `escala`, `gasto`, `cobro_vuelo`, `inventario_movimiento` y
-- `aeronave_discrepancia` ya tienen `tg_set_updated_at`; estas tres tablas
-- solo traían `default now()` (la columna se quedaba en la fecha de alta):
--   - mantenimiento      (20260524000002:15)
--   - piloto_descanso    (20260703000002:13)
--   - evento_flota       (20260821000001:16; calendar.service lo escribía a mano)
--
-- ORDEN: puede aplicarse ANTES o DESPUÉS del deploy del API. Mientras no
-- exista el trigger, el API SALTA el CAS en esas tablas (comportamiento de
-- hoy, last-writer-wins) y lo avisa UNA vez en el log; la sonda
-- `updated_at_trigger_activo` (abajo) es la que se lo dice — se creó en esta
-- misma migración para que «función existe» ⇔ «migración aplicada». El API
-- re-sondea cada ≤ 10 min y se activa solo, sin reiniciar
-- (src/common/updated-at-trigger.util.ts).

drop trigger if exists trg_mantenimiento_set_updated_at on public.mantenimiento;
create trigger trg_mantenimiento_set_updated_at
  before update on public.mantenimiento
  for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_piloto_descanso_set_updated_at on public.piloto_descanso;
create trigger trg_piloto_descanso_set_updated_at
  before update on public.piloto_descanso
  for each row execute function public.tg_set_updated_at();

drop trigger if exists trg_evento_flota_set_updated_at on public.evento_flota;
create trigger trg_evento_flota_set_updated_at
  before update on public.evento_flota
  for each row execute function public.tg_set_updated_at();

-- Sonda para el API: ¿la tabla tiene un trigger BEFORE UPDATE que ejecuta
-- tg_set_updated_at? (true/false). Solo lectura de catálogo; sin
-- security definer (pg_trigger es legible por cualquier rol). Solo la usa la
-- service key del API.
create or replace function public.updated_at_trigger_activo(p_tabla text)
returns boolean
language sql
stable
set search_path = ''
as $$
  select exists (
    select 1
    from pg_catalog.pg_trigger t
    join pg_catalog.pg_class c on c.oid = t.tgrelid
    join pg_catalog.pg_namespace n on n.oid = c.relnamespace
    join pg_catalog.pg_proc p on p.oid = t.tgfoid
    where n.nspname = 'public'
      and c.relname = p_tabla
      and p.proname = 'tg_set_updated_at'
      and not t.tgisinternal
  );
$$;

comment on function public.updated_at_trigger_activo(text) is
  'Sonda del API (control de versión if_updated_at): true si la tabla pública tiene trigger tg_set_updated_at. Creada junto con los triggers de mantenimiento/piloto_descanso/evento_flota (20260910000001).';

revoke execute on function public.updated_at_trigger_activo(text) from public, anon, authenticated;
grant execute on function public.updated_at_trigger_activo(text) to service_role;
