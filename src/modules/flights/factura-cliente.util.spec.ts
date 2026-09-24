import {
  ESTATUS_FACTURA_CLIENTE,
  ETIQUETAS_FACTURA_CLIENTE,
  LIMITE_ARCHIVO_FACTURA_BYTES,
  bloqueFacturaCliente,
  bloqueaBajarEstatus,
  estatusFacturaCliente,
  etiquetaEmitidasVigentes,
  etiquetaFacturaVuelo,
  extraerCfdiCompleto,
  nombreArchivoSeguro,
  pathArchivoFactura,
  validarArchivoFactura,
  xmlDeclaraDoctype,
} from './factura-cliente.util';

/**
 * Factura del SERVICIO por vuelo (22-sep-2026). Aquí se congela el contrato
 * que copia el panel: los tres estados, la derivación con CFDI y sin
 * columna (API/BD viejos) y la validación del archivo.
 */
describe('estatusFacturaCliente (derivación)', () => {
  it('los tres estados son los que dijo el cliente, con sus etiquetas', () => {
    expect([...ESTATUS_FACTURA_CLIENTE]).toEqual([
      'SIN_FACTURA',
      'ELABORADA_ENVIADA',
      'FACTURADO',
    ]);
    expect(ETIQUETAS_FACTURA_CLIENTE).toEqual({
      SIN_FACTURA: 'Sin factura',
      ELABORADA_ENVIADA: 'Factura elaborada y enviada',
      FACTURADO: 'Facturado',
    });
  });

  it('CFDI timbrado MANDA: facturado=true ⇒ FACTURADO', () => {
    expect(estatusFacturaCliente({ facturado: true })).toBe('FACTURADO');
    expect(
      estatusFacturaCliente({
        facturado: true,
        factura_estatus: 'SIN_FACTURA',
      }),
    ).toBe('FACTURADO');
  });

  it('sin CFDI vale la columna', () => {
    expect(
      estatusFacturaCliente({
        facturado: false,
        factura_estatus: 'ELABORADA_ENVIADA',
      }),
    ).toBe('ELABORADA_ENVIADA');
    expect(
      estatusFacturaCliente({ facturado: false, factura_estatus: 'FACTURADO' }),
    ).toBe('FACTURADO');
  });

  it('SIN la migración aplicada (columna ausente) ⇒ lo de hoy: facturado o SIN_FACTURA', () => {
    expect(estatusFacturaCliente({ facturado: false })).toBe('SIN_FACTURA');
    expect(estatusFacturaCliente({})).toBe('SIN_FACTURA');
    expect(estatusFacturaCliente(null)).toBe('SIN_FACTURA');
    expect(estatusFacturaCliente(undefined)).toBe('SIN_FACTURA');
  });

  it('un valor basura en la columna NO se propaga (cae a SIN_FACTURA)', () => {
    expect(
      estatusFacturaCliente({
        facturado: false,
        factura_estatus: 'EN_PROCESO',
      }),
    ).toBe('SIN_FACTURA');
    expect(
      estatusFacturaCliente({ facturado: false, factura_estatus: 7 }),
    ).toBe('SIN_FACTURA');
  });

  it('CFDI CANCELADO (facturado=false) NO baja el estatus solo', () => {
    // Al cancelar ante el SAT el API libera `facturado`, pero la factura se
    // elaboró y se envió: el seguimiento se queda donde estaba.
    expect(
      estatusFacturaCliente({ facturado: false, factura_estatus: 'FACTURADO' }),
    ).toBe('FACTURADO');
  });
});

describe('bloqueFacturaCliente (lo que viaja en snapshot y listado)', () => {
  it('sin archivo: estatus + archivo null', () => {
    expect(
      bloqueFacturaCliente({
        facturado: false,
        factura_estatus: 'SIN_FACTURA',
      }),
    ).toEqual({
      estatus: 'SIN_FACTURA',
      archivo: null,
      folio: null,
      uuid: null,
    });
  });

  it('con archivo: path, nombre, cuándo y quién', () => {
    expect(
      bloqueFacturaCliente(
        {
          facturado: false,
          factura_estatus: 'ELABORADA_ENVIADA',
          factura_archivo_path: 'vuelos/v1/abc.pdf',
          factura_archivo_nombre: 'Factura A-123.pdf',
          factura_archivo_subida_at: '2026-09-22T18:00:00.000Z',
          factura_archivo_subida_por: 'u1',
        },
        'Itzy',
      ),
    ).toEqual({
      estatus: 'ELABORADA_ENVIADA',
      archivo: {
        path: 'vuelos/v1/abc.pdf',
        nombre: 'Factura A-123.pdf',
        subida_at: '2026-09-22T18:00:00.000Z',
        subida_por_nombre: 'Itzy',
      },
      folio: null,
      uuid: null,
    });
  });

  it('path vacío = sin archivo (dato viejo con cadena en blanco)', () => {
    expect(
      bloqueFacturaCliente({ factura_archivo_path: '   ' }).archivo,
    ).toBeNull();
  });

  it('quién subió sin resolver ⇒ null, nunca undefined', () => {
    expect(
      bloqueFacturaCliente({ factura_archivo_path: 'vuelos/v1/a.pdf' }).archivo
        ?.subida_por_nombre,
    ).toBeNull();
  });
});

describe('bloqueaBajarEstatus (candado del CFDI)', () => {
  it('con CFDI vivo no se puede bajar', () => {
    expect(bloqueaBajarEstatus({ facturado: true }, 'SIN_FACTURA')).toBe(true);
    expect(bloqueaBajarEstatus({ facturado: true }, 'ELABORADA_ENVIADA')).toBe(
      true,
    );
  });

  it('con CFDI vivo, dejarlo en FACTURADO sí se permite (idempotente)', () => {
    expect(bloqueaBajarEstatus({ facturado: true }, 'FACTURADO')).toBe(false);
  });

  it('sin CFDI se mueve libremente', () => {
    expect(bloqueaBajarEstatus({ facturado: false }, 'SIN_FACTURA')).toBe(
      false,
    );
    expect(bloqueaBajarEstatus({}, 'ELABORADA_ENVIADA')).toBe(false);
  });
});

describe('validarArchivoFactura', () => {
  it('acepta PDF y XML por extensión', () => {
    expect(
      validarArchivoFactura({ nombre: 'Factura A-1.pdf', bytes: 1000 }),
    ).toEqual({ ok: true, extension: 'pdf', nombre: 'Factura A-1.pdf' });
    expect(validarArchivoFactura({ nombre: 'cfdi.XML', bytes: 10 })).toEqual({
      ok: true,
      extension: 'xml',
      nombre: 'cfdi.XML',
    });
  });

  it('acepta por content-type cuando el nombre no trae extensión', () => {
    const r = validarArchivoFactura({
      nombre: 'factura',
      mime: 'application/pdf',
      bytes: 10,
    });
    expect(r).toMatchObject({ ok: true, extension: 'pdf' });
  });

  it('la EXTENSIÓN gana sobre un content-type genérico (XML del SAT)', () => {
    expect(
      validarArchivoFactura({
        nombre: 'cfdi.xml',
        mime: 'application/octet-stream',
        bytes: 10,
      }),
    ).toMatchObject({ ok: true, extension: 'xml' });
  });

  it('rechaza formatos que no son factura (foto, Excel, Word)', () => {
    for (const n of ['factura.jpg', 'factura.xlsx', 'factura.docx']) {
      const r = validarArchivoFactura({ nombre: n, bytes: 10 });
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.mensaje).toContain('PDF o en XML');
    }
  });

  it('rechaza > 10 MB diciendo cuánto pesa', () => {
    const r = validarArchivoFactura({
      nombre: 'f.pdf',
      bytes: LIMITE_ARCHIVO_FACTURA_BYTES + 1,
    });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.mensaje).toContain('10 MB');
  });

  it('acepta EXACTAMENTE 10 MB (el tope es inclusivo)', () => {
    expect(
      validarArchivoFactura({
        nombre: 'f.pdf',
        bytes: LIMITE_ARCHIVO_FACTURA_BYTES,
      }).ok,
    ).toBe(true);
  });

  it('rechaza vacío y sin nombre', () => {
    expect(validarArchivoFactura({ nombre: 'f.pdf', bytes: 0 }).ok).toBe(false);
    expect(validarArchivoFactura({ nombre: '', bytes: 10 }).ok).toBe(false);
    expect(validarArchivoFactura({ bytes: 10 }).ok).toBe(false);
  });

  it('el nombre se sanea: sin rutas ni caracteres raros', () => {
    expect(nombreArchivoSeguro('C:\\Users\\itzy\\Factura #1.pdf')).toBe(
      'Factura _1.pdf',
    );
    expect(nombreArchivoSeguro('../../etc/passwd')).toBe('passwd');
  });
});

describe('pathArchivoFactura', () => {
  it('agrupa por vuelo dentro del bucket privado', () => {
    expect(pathArchivoFactura('v-1', 'id-9', 'pdf')).toBe(
      'vuelos/v-1/id-9.pdf',
    );
  });
});

// ============ Registro de facturas EMITIDAS (24-sep-2026) ============

const CFDI40 = `<?xml version="1.0" encoding="UTF-8"?>
<cfdi:Comprobante xmlns:cfdi="http://www.sat.gob.mx/cfd/4" Version="4.0" Serie="A" Folio="00123" Fecha="2026-09-24T10:15:00" SubTotal="6940.00" Moneda="USD" TipoCambio="17.50" Total="8050.40" TipoDeComprobante="I" MetodoPago="PPD" FormaPago="99" LugarExpedicion="77500">
  <cfdi:Emisor Rfc="ACC150101AB1" Nombre="AERO CHARTER CANCUN" RegimenFiscal="601"/>
  <cfdi:Receptor Rfc="mma150622p83" Nombre="MAQAR  MACHINERY &amp; CO" UsoCFDI="G03"/>
  <cfdi:Conceptos>
    <cfdi:Concepto ClaveProdServ="78111800" Cantidad="1" Importe="6940.00">
      <cfdi:Impuestos>
        <cfdi:Traslados><cfdi:Traslado Base="6940.00" Importe="1110.40"/></cfdi:Traslados>
      </cfdi:Impuestos>
    </cfdi:Concepto>
  </cfdi:Conceptos>
  <cfdi:Impuestos TotalImpuestosTrasladados="1110.40">
    <cfdi:Traslados><cfdi:Traslado Base="6940.00" Importe="1110.40"/></cfdi:Traslados>
  </cfdi:Impuestos>
  <cfdi:Complemento>
    <tfd:TimbreFiscalDigital xmlns:tfd="http://www.sat.gob.mx/TimbreFiscalDigital" UUID="d08b6837-a3b5-45af-96e1-36f07fba8faf"/>
  </cfdi:Complemento>
</cfdi:Comprobante>`;

describe('extraerCfdiCompleto (registro de facturas emitidas)', () => {
  it('CFDI 4.0: serie/folio, uuid, fecha, emisor, receptor, totales, moneda y método', () => {
    const c = extraerCfdiCompleto(CFDI40)!;
    expect(c).toMatchObject({
      serie: 'A',
      folio: '00123',
      etiqueta: 'A-00123',
      uuid: 'D08B6837-A3B5-45AF-96E1-36F07FBA8FAF',
      tipo_comprobante: 'I',
      fecha_emision: '2026-09-24',
      emisor_rfc: 'ACC150101AB1',
      emisor_nombre: 'AERO CHARTER CANCUN',
      receptor_rfc: 'MMA150622P83',
      receptor_nombre: 'MAQAR MACHINERY & CO',
      subtotal: 6940,
      total: 8050.4,
      moneda_raw: 'USD',
      moneda: 'USD',
      metodo_pago: 'PPD',
      forma_pago: '99',
    });
  });

  it('IVA = TotalImpuestosTrasladados del nodo del COMPROBANTE (no el del concepto)', () => {
    // El Impuestos del concepto va primero y no trae el total: se salta.
    expect(extraerCfdiCompleto(CFDI40)!.iva).toBe(1110.4);
    const sinTotal = CFDI40.replace(' TotalImpuestosTrasladados="1110.40"', '');
    expect(extraerCfdiCompleto(sinTotal)!.iva).toBeNull();
  });

  it('CFDI 3.3 en Buffer con BOM y moneda XXX ⇒ MXN', () => {
    const x33 = CFDI40.replace('Version="4.0"', 'Version="3.3"')
      .replace('Moneda="USD"', 'Moneda="XXX"')
      .replace('TipoDeComprobante="I"', 'TipoDeComprobante="P"');
    const buf = Buffer.concat([
      Buffer.from([0xef, 0xbb, 0xbf]),
      Buffer.from(x33, 'utf8'),
    ]);
    const c = extraerCfdiCompleto(buf)!;
    expect(c.moneda_raw).toBe('XXX');
    expect(c.moneda).toBe('MXN');
    expect(c.tipo_comprobante).toBe('P');
  });

  it('CFDI 3.2 con atributos en minúscula y tipo «ingreso»', () => {
    const x32 = `<cfdi:Comprobante version="3.2" serie="B" folio="7" fecha="2016-01-05T09:00:00" subTotal="100.00" total="116.00" tipoDeComprobante="ingreso" Moneda="EUR" metodoDePago="Transferencia"><cfdi:Emisor rfc="AAA010101AAA" nombre="X"/><cfdi:Receptor rfc="XAXX010101000"/></cfdi:Comprobante>`;
    const c = extraerCfdiCompleto(x32)!;
    expect(c).toMatchObject({
      serie: 'B',
      folio: '7',
      tipo_comprobante: 'I',
      fecha_emision: '2016-01-05',
      subtotal: 100,
      total: 116,
      emisor_rfc: 'AAA010101AAA',
      receptor_rfc: 'XAXX010101000',
      receptor_nombre: null,
      moneda_raw: 'EUR',
      moneda: null,
      metodo_pago: null,
      forma_pago: null,
    });
  });

  it('un XML que no es CFDI ⇒ null', () => {
    expect(
      extraerCfdiCompleto('<factura><total>1</total></factura>'),
    ).toBeNull();
    expect(extraerCfdiCompleto('no es xml')).toBeNull();
  });
});

describe('xmlDeclaraDoctype (defensa XXE, igual que pyservices)', () => {
  it('detecta DOCTYPE y ENTITY en el prólogo', () => {
    expect(
      xmlDeclaraDoctype(
        '<?xml version="1.0"?><!DOCTYPE foo [<!ENTITY x SYSTEM "file:///etc/passwd">]><a/>',
      ),
    ).toBe(true);
    expect(xmlDeclaraDoctype(Buffer.from('<!ENTITY x "y"><a/>'))).toBe(true);
  });
  it('un CFDI normal no lo trae', () => {
    expect(xmlDeclaraDoctype(CFDI40)).toBe(false);
  });
});

describe('etiquetaEmitidasVigentes + cascada del Excel', () => {
  it('solo VIGENTES no borradas, por serie → número → folio', () => {
    expect(
      etiquetaEmitidasVigentes([
        { serie: 'A', folio: '130', folio_num: '130', estatus: 'VIGENTE' },
        { serie: 'A', folio: '123', folio_num: 123, estatus: 'VIGENTE' },
        { serie: 'A', folio: '99', folio_num: 99, estatus: 'CANCELADA' },
        {
          serie: 'A',
          folio: '100',
          folio_num: 100,
          estatus: 'VIGENTE',
          deleted_at: '2026-09-24T00:00:00Z',
        },
      ]),
    ).toBe('A-123, A-130');
    expect(etiquetaEmitidasVigentes([])).toBeNull();
  });

  it('etiquetaFacturaVuelo: CFDI > emitidas > folio legado > estatus', () => {
    const vuelo = { factura_estatus: 'FACTURADO', factura_folio: 'LEG-1' };
    expect(etiquetaFacturaVuelo({ cfdi: 'VT-1', emitidas: 'A-1', vuelo })).toBe(
      'VT-1',
    );
    expect(etiquetaFacturaVuelo({ emitidas: 'A-1', vuelo })).toBe('A-1');
    expect(etiquetaFacturaVuelo({ emitidas: null, vuelo })).toBe('LEG-1');
    // Sin el parámetro nuevo: idéntico a antes.
    expect(
      etiquetaFacturaVuelo({ vuelo: { factura_estatus: 'FACTURADO' } }),
    ).toBe('Facturado');
  });
});
