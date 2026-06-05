-- Módulo 5.4: cancelación CFDI, notas de crédito y receptor alterno ("SE FACTURÓ A").

-- Receptor alterno: cuando se factura a un tercero distinto del cliente del vuelo
-- (caso 9.7 "SE FACTURÓ A"). Si estos campos están NULL, el receptor del CFDI es el
-- cliente del vuelo; si vienen, sobreescriben al receptor en el CFDI timbrado.
ALTER TABLE factura ADD COLUMN IF NOT EXISTS facturado_a_rfc varchar(13);
ALTER TABLE factura ADD COLUMN IF NOT EXISTS facturado_a_nombre varchar(200);
ALTER TABLE factura ADD COLUMN IF NOT EXISTS facturado_a_regimen varchar(5);
ALTER TABLE factura ADD COLUMN IF NOT EXISTS facturado_a_cp varchar(5);
ALTER TABLE factura ADD COLUMN IF NOT EXISTS facturado_a_uso_cfdi varchar(5);
COMMENT ON COLUMN factura.facturado_a_rfc IS 'Receptor distinto del cliente del vuelo (caso 9.7 "SE FACTURÓ A"): RFC del receptor real del CFDI. NULL = se usó el cliente del vuelo.';
COMMENT ON COLUMN factura.facturado_a_nombre IS 'Receptor "SE FACTURÓ A": razón social / nombre del receptor real del CFDI.';
COMMENT ON COLUMN factura.facturado_a_regimen IS 'Receptor "SE FACTURÓ A": clave c_RegimenFiscal del SAT del receptor real.';
COMMENT ON COLUMN factura.facturado_a_cp IS 'Receptor "SE FACTURÓ A": DomicilioFiscalReceptor (CP) del receptor real.';
COMMENT ON COLUMN factura.facturado_a_uso_cfdi IS 'Receptor "SE FACTURÓ A": clave c_UsoCFDI del SAT del receptor real.';

-- Cancelación CFDI (SAT 4.0).
ALTER TABLE factura ADD COLUMN IF NOT EXISTS motivo_cancelacion varchar(2);
ALTER TABLE factura ADD COLUMN IF NOT EXISTS cancelada_at timestamptz;
COMMENT ON COLUMN factura.motivo_cancelacion IS 'Clave del motivo de cancelación SAT (01 comprobante con relación, 02 errores sin relación, 03 no se llevó a cabo, 04 nominativa).';
COMMENT ON COLUMN factura.cancelada_at IS 'Fecha/hora en que el CFDI fue cancelado ante el SAT.';

-- Notas de crédito (CFDI tipo Egreso) relacionadas a una factura original (Ingreso).
ALTER TABLE factura ADD COLUMN IF NOT EXISTS factura_relacionada_id uuid REFERENCES factura(id);
ALTER TABLE factura ADD COLUMN IF NOT EXISTS tipo_comprobante varchar(1) NOT NULL DEFAULT 'I';
COMMENT ON COLUMN factura.factura_relacionada_id IS 'Factura original (Ingreso) a la que esta nota de crédito (Egreso) está relacionada. NULL en facturas normales.';
COMMENT ON COLUMN factura.tipo_comprobante IS 'TipoDeComprobante CFDI 4.0: I = Ingreso (factura), E = Egreso (nota de crédito).';

CREATE INDEX IF NOT EXISTS idx_factura_relacionada ON factura (factura_relacionada_id);
