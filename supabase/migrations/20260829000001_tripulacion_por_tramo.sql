-- 29-ago-2026 · Tripulación POR TRAMO y apoyos como LISTA.
--
-- Pedido del cliente: además del piloto, poder cambiar por tramo al copiloto
-- y a la tripulación de apoyo, y el apoyo puede ser 0, 1 o varios.
--
--  · `escala.copiloto_id`: copiloto de ESE tramo (rotación). null = hereda
--    `vuelo.copiloto_id` (misma regla de herencia que el piloto del tramo).
--  · `vuelo_apoyo`: FUENTE ÚNICA de los apoyos. `escala_id` null = apoyo de
--    TODO el vuelo; con valor = apoyo solo de ese tramo. Apoyos efectivos de
--    un tramo = los del vuelo ∪ los del tramo.
--  · `vuelo.apoyo_id` se conserva como ESPEJO del primer apoyo de nivel
--    vuelo (lectores legados y app vieja); el API lo mantiene en sync al
--    escribir en `vuelo_apoyo`. Nunca escribirlo por separado.

alter table public.escala
  add column if not exists copiloto_id uuid references public.usuario(id) on delete set null;
create index if not exists idx_escala_copiloto
  on public.escala (copiloto_id) where copiloto_id is not null;
comment on column public.escala.copiloto_id is
  'Copiloto de ESTE tramo (rotación). null = hereda vuelo.copiloto_id.';

create table if not exists public.vuelo_apoyo (
  id uuid primary key default gen_random_uuid(),
  vuelo_id uuid not null references public.vuelo(id) on delete cascade,
  -- null = apoyo de todo el vuelo; con valor = solo ese tramo.
  escala_id uuid references public.escala(id) on delete cascade,
  usuario_id uuid not null references public.usuario(id) on delete cascade,
  created_at timestamptz not null default now(),
  created_by uuid
);
create unique index if not exists uq_vuelo_apoyo_vuelo_usuario
  on public.vuelo_apoyo (vuelo_id, usuario_id) where escala_id is null;
create unique index if not exists uq_vuelo_apoyo_escala_usuario
  on public.vuelo_apoyo (escala_id, usuario_id) where escala_id is not null;
create index if not exists idx_vuelo_apoyo_vuelo on public.vuelo_apoyo (vuelo_id);
create index if not exists idx_vuelo_apoyo_escala
  on public.vuelo_apoyo (escala_id) where escala_id is not null;
create index if not exists idx_vuelo_apoyo_usuario on public.vuelo_apoyo (usuario_id);
alter table public.vuelo_apoyo enable row level security;
comment on table public.vuelo_apoyo is
  'Tripulación de APOYO (0..N por vuelo y por tramo). escala_id null = apoyo de todo el vuelo; con valor = solo ese tramo. Fuente única; vuelo.apoyo_id es solo el espejo del primer apoyo de nivel vuelo.';

-- Backfill: el apoyo único de hoy pasa a la lista (nivel vuelo).
insert into public.vuelo_apoyo (vuelo_id, usuario_id)
select v.id, v.apoyo_id
  from public.vuelo v
 where v.apoyo_id is not null
on conflict (vuelo_id, usuario_id) where escala_id is null do nothing;

comment on column public.vuelo.apoyo_id is
  'LEGADO (29-ago-2026): espejo del PRIMER apoyo de nivel vuelo en vuelo_apoyo (escala_id null). La fuente única es vuelo_apoyo; lo sincroniza el API.';
