-- Comprobantes de gasto: además de fotos y PDF, la oficina/admin sube la
-- factura en Excel/CSV (la IA la lee convertida a texto). Límite a 10 MB
-- (fotos de celular sin comprimir del panel).
update storage.buckets
set allowed_mime_types = array[
      'image/jpeg',
      'image/png',
      'image/webp',
      'application/pdf',
      'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      'text/csv'
    ],
    file_size_limit = 10485760
where id = 'gasto-fotos';
