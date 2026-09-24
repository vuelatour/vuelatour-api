import {
  bloqueFacturaServicio,
  elegirDestinatarios,
  esPorFacturar,
  fechaDiaMes,
  resumenFacturaServicio,
  textoAvisoEmitida,
  textoAvisoSolicitud,
  type FacturaLigadaRow,
} from './factura-solicitud.util';

/**
 * «Necesito factura» (pedido de Itzi, 24-sep-2026): «por facturar» es
 * DERIVADO con UNA definición, los destinatarios se eligen por nivel y los
 * textos del aviso no dicen «Total $0 USD».
 */
const SOLICITADA = {
  estado: 'CONFIRMADO',
  facturado: false,
  factura_solicitada_at: '2026-09-24T15:00:00Z',
  factura_solicitada_por: 'u-itzi',
  factura_solicitud_nota: 'Lo necesita para pagar',
  factura_paga_contra_factura: true,
};

const ligada = (
  id: string,
  estatus: string,
  extra: Partial<FacturaLigadaRow> = {},
): FacturaLigadaRow => ({
  id,
  serie: 'A',
  folio: id,
  folio_num: Number(id),
  uuid: null,
  fecha_emision: '2026-09-24',
  estatus,
  total: '8050.40',
  moneda: 'USD',
  metodo_pago: 'PPD',
  pdf_path: `emitidas/${id}/x.pdf`,
  xml_path: null,
  deleted_at: null,
  ...extra,
});

describe('esPorFacturar (definición ÚNICA §3.8)', () => {
  it('solicitada, no cancelado, sin CFDI y sin vigentes ⇒ por facturar', () => {
    expect(esPorFacturar(SOLICITADA, 0)).toBe(true);
  });
  it('una vigente ligada lo saca', () => {
    expect(esPorFacturar(SOLICITADA, 1)).toBe(false);
  });
  it('CANCELADO, CFDI del PAC o sin solicitud ⇒ no', () => {
    expect(esPorFacturar({ ...SOLICITADA, estado: 'CANCELADO' }, 0)).toBe(
      false,
    );
    expect(esPorFacturar({ ...SOLICITADA, facturado: true }, 0)).toBe(false);
    expect(
      esPorFacturar({ ...SOLICITADA, factura_solicitada_at: null }, 0),
    ).toBe(false);
    expect(esPorFacturar(null, 0)).toBe(false);
  });
});

describe('bloque y resumen', () => {
  it('bloque: solicitud con nombre, vigentes ordenadas, canceladas contadas, borradas fuera', () => {
    const b = bloqueFacturaServicio(
      SOLICITADA,
      [
        ligada('130', 'VIGENTE'),
        ligada('123', 'VIGENTE'),
        ligada('99', 'CANCELADA'),
        ligada('50', 'VIGENTE', { deleted_at: '2026-09-24T00:00:00Z' }),
      ],
      'Itzi',
    );
    expect(b.solicitud).toEqual({
      solicitada_at: '2026-09-24T15:00:00Z',
      solicitada_por: { id: 'u-itzi', nombre: 'Itzi' },
      nota: 'Lo necesita para pagar',
      paga_contra_factura: true,
    });
    expect(b.por_facturar).toBe(false);
    expect(b.facturas.map((f) => f.etiqueta)).toEqual(['A-123', 'A-130']);
    expect(b.facturas[0]).toMatchObject({
      total: 8050.4,
      moneda: 'USD',
      metodo_pago: 'PPD',
      tiene_pdf: true,
      tiene_xml: false,
    });
    expect(b.canceladas).toBe(1);
  });

  it('resumen de la lista', () => {
    expect(
      resumenFacturaServicio(SOLICITADA, [ligada('1', 'CANCELADA')]),
    ).toEqual({
      solicitada: true,
      por_facturar: true,
      paga_contra_factura: true,
      facturas: 0,
    });
    expect(resumenFacturaServicio({ estado: 'CONFIRMADO' }, [])).toEqual({
      solicitada: false,
      por_facturar: false,
      paga_contra_factura: false,
      facturas: 0,
    });
  });
});

describe('elegirDestinatarios (nivel ANTES de excluir)', () => {
  const mary = { id: 'u-mary', nombre: 'Mary Cruz' };
  const ale = { id: 'u-ale', nombre: 'Alejandro' };
  const fact = { id: 'u-fact', nombre: 'Facturista' };

  it('config manda', () => {
    expect(
      elegirDestinatarios(
        { config: [mary], facturacion: [fact], admins: [ale] },
        'u-itzi',
      ),
    ).toEqual({ fuente: 'CONFIG', destinatarios: [mary] });
  });
  it('sin config ⇒ rol FACTURACION; sin él ⇒ ADMIN (menos quien pidió)', () => {
    expect(
      elegirDestinatarios(
        { config: [], facturacion: [fact], admins: [ale] },
        null,
      ),
    ).toEqual({ fuente: 'ROL_FACTURACION', destinatarios: [fact] });
    expect(
      elegirDestinatarios(
        { config: [], facturacion: [], admins: [ale, mary] },
        'u-ale',
      ),
    ).toEqual({ fuente: 'ADMINS', destinatarios: [mary] });
  });
  it('si quien pide ES el único del nivel, nadie recibe aviso (no baja de nivel)', () => {
    expect(
      elegirDestinatarios(
        { config: [mary], facturacion: [fact], admins: [ale] },
        'u-mary',
      ),
    ).toEqual({ fuente: 'CONFIG', destinatarios: [] });
  });
});

describe('textos de los avisos (§5)', () => {
  it('fechaDiaMes en hora Cancún sin día de la semana', () => {
    // 27 sep 04:00 UTC = 26 sep 23:00 Cancún.
    expect(fechaDiaMes('2026-09-27T04:00:00Z')).toBe('26 sep');
    expect(fechaDiaMes(null)).toBe('');
  });

  it('solicitud de un vuelo con total, paga contra factura y nota', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [
          {
            folio: 341,
            fecha_vuelo: '2026-09-27T14:00:00Z',
            monto_total_usd: '8050.4',
          },
        ],
        cliente: 'Maqar',
        pagaContraFactura: true,
        nota: 'Mandó datos por correo',
      }),
    ).toEqual({
      titulo: 'Factura pedida: vuelo #341',
      cuerpo:
        'Itzi pidió factura del vuelo #341 · Maqar · 27 sep · Total $8,050.40 USD. El cliente paga hasta recibir la factura. Nota: Mandó datos por correo',
    });
  });

  it('sin precio ni fecha se omiten (nunca «Total $0 USD»)', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [{ folio: 12, fecha_vuelo: null, monto_total_usd: 0 }],
        cliente: null,
      }).cuerpo,
    ).toBe('Itzi pidió factura del vuelo #12.');
  });

  it('grupo: una sola notificación con todos los folios', () => {
    expect(
      textoAvisoSolicitud({
        actor: 'Itzi',
        vuelos: [
          { folio: 343, fecha_vuelo: '2026-09-27T14:00:00Z' },
          { folio: 341, fecha_vuelo: '2026-09-27T14:00:00Z' },
          { folio: 342, fecha_vuelo: '2026-09-27T14:00:00Z' },
        ],
        cliente: 'Maqar',
        grupoFolio: 12,
      }),
    ).toEqual({
      titulo: 'Factura pedida: grupo G-12',
      cuerpo:
        'Itzi pidió factura de los vuelos #341, #342 y #343 (grupo G-12) · Maqar · 27 sep.',
    });
  });

  it('factura emitida a quien la pidió', () => {
    expect(
      textoAvisoEmitida({
        actor: 'Mary Cruz',
        etiqueta: 'A-123',
        folios: [341],
        cliente: 'Maqar',
      }),
    ).toEqual({
      titulo: 'Ya está la factura A-123',
      cuerpo: 'Mary Cruz registró la factura A-123 del vuelo #341 · Maqar.',
    });
    expect(
      textoAvisoEmitida({
        actor: 'Mary Cruz',
        etiqueta: 'A-123',
        folios: [342, 341],
        cliente: 'Maqar',
      }).cuerpo,
    ).toBe(
      'Mary Cruz registró la factura A-123 de los vuelos #341 y #342 · Maqar.',
    );
  });
});
