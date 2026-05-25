-- Tarea 13: módulo de facturas (CFDI 4.0 vía FEL).

-- Datos fiscales del receptor (requeridos por CFDI 4.0).
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS regimen_fiscal_receptor varchar(5);
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS uso_cfdi varchar(5);
ALTER TABLE cliente ADD COLUMN IF NOT EXISTS codigo_postal varchar(5);
COMMENT ON COLUMN cliente.regimen_fiscal_receptor IS 'Clave c_RegimenFiscal del SAT para el receptor (CFDI 4.0).';
COMMENT ON COLUMN cliente.uso_cfdi IS 'Clave c_UsoCFDI del SAT (ej. G03).';
COMMENT ON COLUMN cliente.codigo_postal IS 'DomicilioFiscalReceptor (CP) del receptor.';

-- CSD del emisor (archivos en bucket privado csd; la contraseña va en env de pyservices/api).
ALTER TABLE entidad_fiscal_emisora ADD COLUMN IF NOT EXISTS csd_cer_url text;
ALTER TABLE entidad_fiscal_emisora ADD COLUMN IF NOT EXISTS csd_key_url text;
COMMENT ON COLUMN entidad_fiscal_emisora.csd_cer_url IS 'Path en bucket csd del certificado .cer del CSD.';
COMMENT ON COLUMN entidad_fiscal_emisora.csd_key_url IS 'Path en bucket csd de la llave .key del CSD.';

-- Facturas emitidas (CFDI timbrados).
CREATE TABLE IF NOT EXISTS factura (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  vuelo_id uuid NOT NULL REFERENCES vuelo(id),
  cliente_id uuid REFERENCES cliente(id),
  entidad_fiscal_emisora_id uuid NOT NULL REFERENCES entidad_fiscal_emisora(id),
  estado varchar(12) NOT NULL DEFAULT 'TIMBRADA',
  serie varchar(25),
  folio varchar(40),
  uuid_fiscal varchar(36),
  total numeric NOT NULL DEFAULT 0,
  moneda varchar(3) NOT NULL DEFAULT 'MXN',
  fel_referencia varchar(60) UNIQUE,
  xml_url text,
  pdf_url text,
  fecha_timbrado timestamptz,
  error_mensaje text,
  created_by uuid,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);
COMMENT ON TABLE factura IS 'Tarea 13. CFDI 4.0 emitidos por vuelo, timbrados con FEL.';
CREATE INDEX IF NOT EXISTS idx_factura_vuelo ON factura (vuelo_id);
CREATE INDEX IF NOT EXISTS idx_factura_estado ON factura (estado, created_at DESC);
ALTER TABLE factura ENABLE ROW LEVEL SECURITY;

INSERT INTO storage.buckets (id, name, public) VALUES ('facturas', 'facturas', false) ON CONFLICT (id) DO NOTHING;
INSERT INTO storage.buckets (id, name, public) VALUES ('csd', 'csd', false) ON CONFLICT (id) DO NOTHING;
