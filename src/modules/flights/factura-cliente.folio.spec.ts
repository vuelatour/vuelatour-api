import {
  LIMITE_FOLIO_FACTURA,
  bloqueFacturaCliente,
  etiquetaCfdiVivo,
  etiquetaFacturaVuelo,
  etiquetaSerieFolio,
  extraerDatosCfdi,
  normalizarFolioFactura,
  normalizarUuidFiscal,
  textoDeXml,
  validarArchivoFactura,
} from './factura-cliente.util';

/**
 * FOLIO de la factura del servicio (24-sep-2026). Pedido del cliente: «subí
 * la factura de un vuelo … al descargar el reporte en Excel sí aparece la
 * columna de factura (del vuelo) pero no aparece el folio». Se congela:
 *  - el parser TOLERANTE del CFDI (Serie/Folio/UUID) con la ESTRUCTURA de un
 *    XML real (el huérfano de `facturas/recibidas/`: BOM UTF-8, prefijo
 *    `cfdi:`, CFDI 4.0 con `Certificado` enorme antes y después de Folio);
 *  - la cascada ÚNICA de lo que imprime la columna del Excel.
 */

/**
 * CFDI 4.0 con la estructura del XML real (AEROPUERTO DE MERIDA,
 * FECMID-90255): BOM, declaración, `cfdi:Comprobante` con decenas de
 * atributos (Serie/Folio en medio de NoCertificado y Certificado), nodos
 * Emisor/Receptor/Conceptos y el `tfd:TimbreFiscalDigital` dentro de
 * `cfdi:Complemento`. Sellos y certificado recortados.
 */
const CFDI_40 =
  '\uFEFF<?xml version="1.0" encoding="utf-8"?>' +
  '<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  'xsi:schemaLocation="http://www.sat.gob.mx/cfd/4 http://www.sat.gob.mx/sitio_internet/cfd/4/cfdv40.xsd" ' +
  'Version="4.0" Fecha="2026-06-03T09:47:41" Moneda="MXN" TipoCambio="1" ' +
  'SubTotal="215.30" Total="249.75" FormaPago="28" TipoDeComprobante="I" ' +
  'MetodoPago="PUE" LugarExpedicion="97295" Exportacion="01" ' +
  'NoCertificado="00001000000704178991" Serie="FECMID" Folio="90255" ' +
  'Certificado="MIIGITCCBAmgAwIBAgIUMDAwMDEwMDAwMDA3MDQxNzg5OTEwDQYJKoZIhvcNAQELBQAw" ' +
  'Sello="U7DK/58P3ybSzHadJ6C3gzqFD50641FB5LEjdw==">' +
  '<cfdi:Emisor Rfc="AME980401BI7" Nombre="AEROPUERTO DE MERIDA" RegimenFiscal="601"/>' +
  '<cfdi:Receptor Rfc="ACC000000XX0" Nombre="AERO CHARTER CANCUN" UsoCFDI="G03" ' +
  'DomicilioFiscalReceptor="77500" RegimenFiscalReceptor="601"/>' +
  '<cfdi:Conceptos><cfdi:Concepto ClaveProdServ="78111800" Cantidad="1" ' +
  'ClaveUnidad="E48" Descripcion="TUA" ValorUnitario="215.30" Importe="215.30" ' +
  'ObjetoImp="02"/></cfdi:Conceptos>' +
  '<cfdi:Complemento><tfd:TimbreFiscalDigital ' +
  'xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" Version="1.1" ' +
  'UUID="DF1BFB5F-4D88-4F51-AC50-A7B72299128E" FechaTimbrado="2026-06-03T10:48:06" ' +
  'RfcProvCertif="SST060807KU0" SelloCFD="U7DK/58P3yb==" ' +
  'NoCertificadoSAT="00001000000705250068" SelloSAT="abc=="/>' +
  '</cfdi:Complemento></cfdi:Comprobante>';

describe('extraerDatosCfdi (parser tolerante, sin dependencias)', () => {
  it('CFDI 4.0 real (con BOM): SERIE-FOLIO y UUID', () => {
    expect(extraerDatosCfdi(Buffer.from(CFDI_40, 'utf8'))).toEqual({
      serie: 'FECMID',
      folio: '90255',
      etiqueta: 'FECMID-90255',
      uuid: 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E',
    });
  });

  it('no confunde `NoCertificado`/`FolioFiscal` con `Folio`', () => {
    const xml =
      '<cfdi:Comprobante NoCertificado="999" Serie="A" Folio="12" ' +
      'FolioFiscalOrig="X-1"/>';
    expect(extraerDatosCfdi(xml)?.etiqueta).toBe('A-12');
  });

  it('solo Folio (sin Serie) ⇒ el Folio', () => {
    const xml = '<cfdi:Comprobante Version="4.0" Folio="1234"/>';
    expect(extraerDatosCfdi(xml)).toMatchObject({
      serie: null,
      folio: '1234',
      etiqueta: '1234',
      uuid: null,
    });
  });

  it('solo Serie (sin Folio) ⇒ SIN etiqueta: la serie sola no identifica', () => {
    const xml = '<cfdi:Comprobante Serie="A" Version="4.0"/>';
    expect(extraerDatosCfdi(xml)?.etiqueta).toBeNull();
  });

  it('CFDI 3.2 (atributos en minúscula) y comillas simples', () => {
    const xml =
      "<cfdi:Comprobante version='3.2' serie='B' folio='77'>" +
      "<tfd:TimbreFiscalDigital UUID='ab12cd34-0000-4000-8000-00000000abcd'/>" +
      '</cfdi:Comprobante>';
    expect(extraerDatosCfdi(xml)).toEqual({
      serie: 'B',
      folio: '77',
      etiqueta: 'B-77',
      // El SAT lo imprime en mayúsculas: se normaliza.
      uuid: 'AB12CD34-0000-4000-8000-00000000ABCD',
    });
  });

  it('sin prefijo `cfdi:` y con entidades XML en el valor', () => {
    const xml = '<Comprobante Serie="A&amp;B" Folio="&#49;0"/>';
    expect(extraerDatosCfdi(xml)?.etiqueta).toBe('A&B-10');
  });

  it('XML que NO es CFDI ⇒ null (la subida sigue, sin folio)', () => {
    expect(extraerDatosCfdi('<factura><folio>1</folio></factura>')).toBeNull();
    expect(extraerDatosCfdi('no es xml')).toBeNull();
    expect(extraerDatosCfdi(Buffer.alloc(0))).toBeNull();
  });

  it('UUID mal formado ⇒ null (jamás basura en la columna)', () => {
    const xml =
      '<cfdi:Comprobante Folio="1"><tfd:TimbreFiscalDigital UUID="no-es"/>' +
      '</cfdi:Comprobante>';
    expect(extraerDatosCfdi(xml)?.uuid).toBeNull();
  });

  it('SERIE-FOLIO de más de 40 ⇒ queda solo el Folio', () => {
    const serie = 'S'.repeat(25);
    const folio = 'F'.repeat(20);
    const xml = `<cfdi:Comprobante Serie="${serie}" Folio="${folio}"/>`;
    expect(extraerDatosCfdi(xml)?.etiqueta).toBe(folio);
  });

  it('XML en UTF-16 con BOM también se lee', () => {
    const le = Buffer.concat([
      Buffer.from([0xff, 0xfe]),
      Buffer.from('<cfdi:Comprobante Serie="C" Folio="5"/>', 'utf16le'),
    ]);
    expect(textoDeXml(le)).toContain('Folio="5"');
    expect(extraerDatosCfdi(le)?.etiqueta).toBe('C-5');
  });
});

describe('normalizarFolioFactura / normalizarUuidFiscal', () => {
  it('recorta, colapsa espacios y quita caracteres de control', () => {
    expect(normalizarFolioFactura('  A-1234  ')).toBe('A-1234');
    expect(normalizarFolioFactura('FAC\t  00\n12')).toBe('FAC 00 12');
  });

  it('vacío / null / no-texto ⇒ null (así se BORRA desde el PATCH)', () => {
    expect(normalizarFolioFactura('')).toBeNull();
    expect(normalizarFolioFactura('   ')).toBeNull();
    expect(normalizarFolioFactura(null)).toBeNull();
    expect(normalizarFolioFactura(undefined)).toBeNull();
    expect(normalizarFolioFactura({})).toBeNull();
  });

  it('un número se guarda como texto', () => {
    expect(normalizarFolioFactura(1234)).toBe('1234');
  });

  it('nunca pasa de 40 ni termina en espacio (CHECK de la BD)', () => {
    const r = normalizarFolioFactura(`${'A'.repeat(39)} ${'B'.repeat(10)}`);
    expect(r).toBe('A'.repeat(39));
    expect(r!.length).toBeLessThanOrEqual(LIMITE_FOLIO_FACTURA);
  });

  it('UUID en mayúsculas; lo que no es UUID ⇒ null', () => {
    expect(normalizarUuidFiscal(' df1bfb5f-4d88-4f51-ac50-a7b72299128e ')).toBe(
      'DF1BFB5F-4D88-4F51-AC50-A7B72299128E',
    );
    expect(normalizarUuidFiscal('123')).toBeNull();
    expect(normalizarUuidFiscal(null)).toBeNull();
  });
});

describe('etiquetaFacturaVuelo — la columna del Excel (FUENTE ÚNICA)', () => {
  it('1) el CFDI timbrado VIVO manda sobre todo', () => {
    expect(
      etiquetaFacturaVuelo({
        cfdi: 'VT-501',
        vuelo: { factura_folio: 'A-1', factura_estatus: 'FACTURADO' },
      }),
    ).toBe('VT-501');
  });

  it('2) sin CFDI: el folio que capturó/subió la oficina', () => {
    expect(
      etiquetaFacturaVuelo({
        cfdi: null,
        vuelo: { factura_folio: ' A-1234 ', factura_estatus: 'FACTURADO' },
      }),
    ).toBe('A-1234');
  });

  it('2b) el folio vale aunque el estatus siga en SIN_FACTURA', () => {
    expect(
      etiquetaFacturaVuelo({
        vuelo: { factura_folio: 'B-9', factura_estatus: 'SIN_FACTURA' },
      }),
    ).toBe('B-9');
  });

  it('3) sin folio pero con seguimiento: la etiqueta del estatus (caso #297)', () => {
    expect(
      etiquetaFacturaVuelo({
        vuelo: { facturado: false, factura_estatus: 'FACTURADO' },
      }),
    ).toBe('Facturado');
    expect(
      etiquetaFacturaVuelo({
        vuelo: { factura_estatus: 'ELABORADA_ENVIADA', factura_folio: '' },
      }),
    ).toBe('Factura elaborada y enviada');
  });

  it('3b) `facturado = true` sin fila de CFDI legible ⇒ «Facturado»', () => {
    expect(etiquetaFacturaVuelo({ vuelo: { facturado: true } })).toBe(
      'Facturado',
    );
  });

  it('4) sin nada ⇒ null (celda vacía, como antes)', () => {
    expect(
      etiquetaFacturaVuelo({ vuelo: { factura_estatus: 'SIN_FACTURA' } }),
    ).toBeNull();
    expect(etiquetaFacturaVuelo({ vuelo: null })).toBeNull();
    expect(etiquetaFacturaVuelo({})).toBeNull();
  });
});

describe('etiquetaCfdiVivo / etiquetaSerieFolio', () => {
  it('misma regla de siempre: serie-folio; ignora las CANCELADAS', () => {
    expect(
      etiquetaCfdiVivo([
        { serie: 'A', folio: '1', estado: 'CANCELADA' },
        { serie: 'A', folio: '2', estado: 'TIMBRADA' },
      ]),
    ).toBe('A-2');
    expect(etiquetaCfdiVivo([])).toBeNull();
    expect(etiquetaSerieFolio(null, '7')).toBe('7');
    expect(etiquetaSerieFolio('', '')).toBeNull();
  });
});

describe('bloque y validación (aditivos del 24-sep)', () => {
  it('el bloque trae folio y uuid normalizados', () => {
    expect(
      bloqueFacturaCliente({
        factura_estatus: 'FACTURADO',
        factura_folio: 'FECMID-90255',
        factura_uuid: 'df1bfb5f-4d88-4f51-ac50-a7b72299128e',
      }),
    ).toMatchObject({
      folio: 'FECMID-90255',
      uuid: 'DF1BFB5F-4D88-4F51-AC50-A7B72299128E',
    });
  });

  it('cada rechazo del archivo trae su código', () => {
    const grande = validarArchivoFactura({
      nombre: 'f.pdf',
      bytes: 12 * 1024 * 1024,
    });
    expect(grande).toMatchObject({
      ok: false,
      codigo: 'ARCHIVO_MUY_GRANDE',
      mensaje: 'El archivo pesa 12.0 MB y el máximo son 10 MB.',
    });
    expect(validarArchivoFactura({ nombre: 'x.jpg', bytes: 5 })).toMatchObject({
      ok: false,
      codigo: 'ARCHIVO_TIPO_INVALIDO',
    });
    expect(validarArchivoFactura({ nombre: 'x.pdf', bytes: 0 })).toMatchObject({
      ok: false,
      codigo: 'ARCHIVO_VACIO',
    });
  });
});
