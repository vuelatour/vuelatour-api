-- Confirmación de la información del gasto en el panel (28-ago, pedido del
-- cliente): al guardar el diálogo "Verificar", oficina queda sellada como
-- quien confirmó. SOLO se muestra en el panel — el API lo recorta para
-- piloto/mecánico/visitante (no debe aparecer en la app).
alter table gasto
  add column if not exists verificado_por uuid references public.usuario(id) on delete set null,
  add column if not exists verificado_at timestamptz;

comment on column gasto.verificado_por is
  'Quién confirmó la información del gasto en el panel (diálogo Verificar). Se limpia si el capturador de campo vuelve a editar. Solo visible para oficina.';
comment on column gasto.verificado_at is
  'Cuándo se confirmó la información del gasto.';
