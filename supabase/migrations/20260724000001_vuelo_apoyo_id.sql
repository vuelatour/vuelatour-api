-- APOYO por vuelo (caso Jimmy): personal rol PILOTO que va de apoyo en tierra
-- (maletas, pagar facturas, cobros, gastos). Ve y opera el vuelo IGUAL que el
-- piloto asignado, EXCEPTO tacómetros (no captura ni corrige — esos son del
-- piloto que vuela). Mismo patrón que vuelo.copiloto_id, con candado de tacos
-- en la API (assertPuedeCapturarTaco).
-- NOTA: ya aplicada a mano en prod (bjesduasnzbzywofukbf); este archivo la
-- versiona. Idempotente (if not exists).
alter table public.vuelo
  add column if not exists apoyo_id uuid references public.usuario(id);

comment on column public.vuelo.apoyo_id is
  'Usuario de APOYO del vuelo (rol PILOTO en tierra): ve y opera el vuelo igual que piloto_id/copiloto_id EXCEPTO tacómetros.';

-- Parcial: la mayoría de los vuelos no llevan apoyo.
create index if not exists idx_vuelo_apoyo on public.vuelo (apoyo_id)
  where apoyo_id is not null;
