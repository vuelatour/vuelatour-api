import {
  ESTATUS_FACTURA_CLIENTE,
  ETIQUETAS_FACTURA_CLIENTE,
  LIMITE_ARCHIVO_FACTURA_BYTES,
  bloqueFacturaCliente,
  bloqueaBajarEstatus,
  estatusFacturaCliente,
  nombreArchivoSeguro,
  pathArchivoFactura,
  validarArchivoFactura,
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
