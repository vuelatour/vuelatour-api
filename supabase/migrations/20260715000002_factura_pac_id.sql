-- Id del CFDI en el PAC (Facturama api-lite): la cancelación por REST usa el
-- Id de su plataforma, no el UUID fiscal. NULL en facturas timbradas con FEL.
alter table factura add column if not exists pac_id text;
