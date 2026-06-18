-- Copiloto a nivel viaje: un segundo piloto que ve TODO el vuelo igual que el
-- piloto principal (cuando se mandan 2 pilotos). No cambia la asignación por
-- tramo del piloto principal; el copiloto aplica al vuelo completo.
alter table public.vuelo
  add column if not exists copiloto_id uuid references public.usuario(id) on delete set null;

create index if not exists idx_vuelo_copiloto on public.vuelo (copiloto_id);

comment on column public.vuelo.copiloto_id is
  'Segundo piloto (copiloto) del viaje; ve todo el vuelo igual que piloto_id.';
