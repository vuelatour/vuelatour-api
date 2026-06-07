-- Buzón de facturas RECIBIDAS (CFDI de proveedores). Doc 5.4: se suben los XML,
-- se extraen sus datos (pyservices) y se amarran a un gasto/avión. El XML se
-- guarda en el bucket privado `facturas` bajo el prefijo `recibidas/`.

create table public.factura_recibida (
  id uuid primary key default gen_random_uuid(),
  uuid_fiscal varchar(36) unique,
  emisor_rfc varchar(13),
  emisor_nombre varchar(255),
  receptor_rfc varchar(13),
  receptor_nombre varchar(255),
  tipo_comprobante varchar(4),
  subtotal numeric(14, 2),
  total numeric(14, 2),
  moneda varchar(4),
  fecha_emision timestamptz,
  conceptos_resumen text,
  xml_url text,
  estado varchar(16) not null default 'SIN_CLASIFICAR'
    check (estado in ('SIN_CLASIFICAR', 'CLASIFICADA', 'DESCARTADA')),
  gasto_id uuid references public.gasto(id) on delete set null,
  aeronave_id uuid references public.aeronave(id) on delete set null,
  categoria_sugerida varchar(50),
  notas text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  created_by uuid references public.usuario(id) on delete set null,
  updated_by uuid references public.usuario(id) on delete set null
);

comment on table public.factura_recibida is
  'CFDI recibidos de proveedores (buzón). uuid_fiscal único evita duplicados.';

create index idx_factura_recibida_estado
  on public.factura_recibida (estado, created_at desc);
create index idx_factura_recibida_gasto on public.factura_recibida (gasto_id);

create trigger trg_factura_recibida_set_updated_at
  before update on public.factura_recibida
  for each row execute function public.tg_set_updated_at();

alter table public.factura_recibida enable row level security;
create policy "factura_recibida_read_active_user" on public.factura_recibida for select using (
  exists (
    select 1 from public.usuario u
    where u.supabase_auth_id = auth.uid() and u.estado = 'ACTIVO'
  )
);
