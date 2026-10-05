import {
  CAMPOS_FOLIO_CRUDOS,
  conFolioComprobante,
  embedFolioGasto,
  etiquetaFacturasReporte,
  folioComprobanteDeFila,
  folioComprobanteDeGasto,
  notasReporteConFactura,
} from './folio-comprobante.util';

/**
 * NÚMERO DE FACTURA DEL GASTO (5-oct-2026, API 0.0.57). Pedido del cliente:
 * «al momento de la conciliación me apoyan a poner el número de la factura
 * con la que se enlaza el movimiento. Aquí en notas estaría perfecto».
 * Casos reales de prod: «FEACZM 72128» (ASUR, folio_ticket) y «AB1144717».
 */
describe('folioComprobanteDeGasto', () => {
  it('1) la factura con folio GANA: «serie-folio»', () => {
    expect(
      folioComprobanteDeGasto({
        folio_ticket: 'FEACZM 72128',
        ia_folio: 'X-1',
        factura: { serie: 'A', folio: '0411', uuid_fiscal: 'u-1' },
      }),
    ).toBe('A-0411');
    expect(
      folioComprobanteDeGasto({
        factura: { serie: 'FEACZM', folio: '72128', uuid_fiscal: null },
      }),
    ).toBe('FEACZM-72128');
  });

  it('1b) factura con folio y SIN serie (o serie vacía) ⇒ solo el folio', () => {
    expect(
      folioComprobanteDeGasto({ factura: { serie: null, folio: '72128' } }),
    ).toBe('72128');
    expect(
      folioComprobanteDeGasto({ factura: { serie: '  ', folio: ' 72128 ' } }),
    ).toBe('72128');
  });

  it('2) sin folio de factura ⇒ folio_ticket recortado', () => {
    expect(
      folioComprobanteDeGasto({
        folio_ticket: '  FEACZM 72128 ',
        ia_folio: 'otro',
        factura: { serie: 'A', folio: null, uuid_fiscal: 'u-1' },
      }),
    ).toBe('FEACZM 72128');
  });

  it('3) sin folio_ticket (o vacío) ⇒ el folio que leyó la IA', () => {
    expect(
      folioComprobanteDeGasto({ folio_ticket: '   ', ia_folio: 'AB1144717' }),
    ).toBe('AB1144717');
  });

  it('4) solo la factura con UUID ⇒ «CFDI <uuid>»', () => {
    expect(
      folioComprobanteDeGasto({
        folio_ticket: null,
        ia_folio: '',
        factura: { uuid_fiscal: '11111111-2222-3333-4444-555555555555' },
      }),
    ).toBe('CFDI 11111111-2222-3333-4444-555555555555');
  });

  it('5) nada ⇒ null', () => {
    expect(folioComprobanteDeGasto({})).toBeNull();
    expect(
      folioComprobanteDeGasto({
        folio_ticket: '',
        ia_folio: ' ',
        factura: { serie: 'A', folio: '', uuid_fiscal: '' },
      }),
    ).toBeNull();
  });
});

describe('folioComprobanteDeFila (fila cruda de PostgREST)', () => {
  it('embed factura como objeto o como arreglo de uno', () => {
    expect(
      folioComprobanteDeFila({
        factura: { serie: 'A', folio: '0411', uuid_fiscal: 'u' },
      }),
    ).toBe('A-0411');
    expect(
      folioComprobanteDeFila({
        factura: [{ serie: 'B', folio: '9', uuid_fiscal: 'u' }],
      }),
    ).toBe('B-9');
  });

  it('sin la migración la factura solo trae uuid_fiscal', () => {
    expect(
      folioComprobanteDeFila({
        folio_ticket: null,
        ia_folio: null,
        factura: { uuid_fiscal: 'abc' },
      }),
    ).toBe('CFDI abc');
  });

  it('folio IA numérico (JSON viejo) se acepta como texto', () => {
    expect(folioComprobanteDeFila({ ia_folio: 72128 })).toBe('72128');
  });

  it('fila nula / sin campos ⇒ null', () => {
    expect(folioComprobanteDeFila(null)).toBeNull();
    expect(folioComprobanteDeFila({ id: 'g-1' })).toBeNull();
    expect(folioComprobanteDeFila({ factura: [] })).toBeNull();
  });
});

describe('embedFolioGasto', () => {
  it('con la migración pide serie y folio de la factura', () => {
    expect(embedFolioGasto(true)).toBe(
      'folio_ticket, ia_folio:valor_ia_extraido->>folio, factura:factura_recibida!factura_recibida_id(serie, folio, uuid_fiscal)',
    );
  });

  it('sin la migración NO nombra serie/folio (42703 tumbaría la consulta)', () => {
    expect(embedFolioGasto(false)).toBe(
      'folio_ticket, ia_folio:valor_ia_extraido->>folio, factura:factura_recibida!factura_recibida_id(uuid_fiscal)',
    );
  });
});

describe('conFolioComprobante', () => {
  it('agrega folio_comprobante y retira los campos crudos', () => {
    const g = {
      id: 'g-1',
      monto: 100,
      folio_ticket: 'T-1',
      ia_folio: 'X',
      factura: { serie: 'A', folio: '1', uuid_fiscal: 'u' },
    };
    const out = conFolioComprobante(g);
    expect(out).toEqual({ id: 'g-1', monto: 100, folio_comprobante: 'A-1' });
    for (const k of CAMPOS_FOLIO_CRUDOS) expect(out).not.toHaveProperty(k);
    // No muta la entrada.
    expect(g.folio_ticket).toBe('T-1');
  });

  it('sin folio ⇒ folio_comprobante null (el campo siempre viaja)', () => {
    expect(conFolioComprobante({ id: 'g-2' })).toEqual({
      id: 'g-2',
      folio_comprobante: null,
    });
  });
});

describe('etiquetaFacturasReporte', () => {
  it('una factura ⇒ «Factura X»', () => {
    expect(etiquetaFacturasReporte(['FEACZM-72128'])).toBe(
      'Factura FEACZM-72128',
    );
  });

  it('varias ⇒ «Facturas X · Y», sin nulls ni duplicados, en orden', () => {
    expect(
      etiquetaFacturasReporte([
        'FEACZM-72128',
        null,
        'A-0411',
        ' FEACZM-72128 ',
        '',
        undefined,
      ]),
    ).toBe('Facturas FEACZM-72128 · A-0411');
  });

  it('un lote con la MISMA factura en todos sus gastos ⇒ singular', () => {
    expect(etiquetaFacturasReporte(['A-1', 'A-1', 'A-1'])).toBe('Factura A-1');
  });

  it('ninguna ⇒ null', () => {
    expect(etiquetaFacturasReporte([])).toBeNull();
    expect(etiquetaFacturasReporte([null, '  '])).toBeNull();
  });
});

describe('notasReporteConFactura', () => {
  it('factura + nota del banco ⇒ «Factura X · nota»', () => {
    expect(
      notasReporteConFactura('Factura FEACZM-72128', 'pago VIP SAESA'),
    ).toBe('Factura FEACZM-72128 · pago VIP SAESA');
  });

  it('solo factura ⇒ la etiqueta', () => {
    expect(notasReporteConFactura('Factura A-0411', null)).toBe(
      'Factura A-0411',
    );
    expect(notasReporteConFactura('Factura A-0411', '   ')).toBe(
      'Factura A-0411',
    );
  });

  it('sin factura ⇒ la nota del banco TAL CUAL (como el 0.0.56)', () => {
    expect(notasReporteConFactura(null, ' nota con espacios ')).toBe(
      ' nota con espacios ',
    );
    expect(notasReporteConFactura(null, null)).toBe('');
    expect(notasReporteConFactura('', 'x')).toBe('x');
  });
});
