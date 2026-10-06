import {
  BadGatewayException,
  ServiceUnavailableException,
} from '@nestjs/common';
import {
  camposSerieFolioInsert,
  clasificarFalloRelectura,
  cortarRelecturaPorPyservices,
  NOTA_FOLIO_NO_LEGIBLE,
  notasConFolioNoLegible,
  RELECTURA_FOLIO_LOTE,
  serieFolioDelCfdi,
} from './recibida-folio.util';

/** Serie/folio de las facturas recibidas (5-oct-2026, API 0.0.57). */
describe('serieFolioDelCfdi', () => {
  it('pyservices nuevo: recorta y deja null lo vacío; leido = true', () => {
    expect(serieFolioDelCfdi({ serie: ' A ', folio: '0411' })).toEqual({
      serie: 'A',
      folio: '0411',
      leido: true,
    });
    expect(serieFolioDelCfdi({ serie: null, folio: '' })).toEqual({
      serie: null,
      folio: null,
      leido: true,
    });
  });

  it('pyservices VIEJO (sin las llaves) ⇒ leido = false', () => {
    expect(serieFolioDelCfdi({ uuid_fiscal: 'u' })).toEqual({
      serie: null,
      folio: null,
      leido: false,
    });
    expect(serieFolioDelCfdi(null).leido).toBe(false);
  });
});

describe('camposSerieFolioInsert', () => {
  const AHORA = '2026-10-05T20:00:00.000Z';

  it('sin la migración ⇒ {} (insert idéntico al 0.0.56)', () => {
    expect(
      camposSerieFolioInsert({ serie: 'A', folio: '1' }, false, AHORA),
    ).toEqual({});
  });

  it('con la migración ⇒ serie, folio y folio_releido_at sellado', () => {
    expect(
      camposSerieFolioInsert({ serie: 'FEACZM', folio: '72128' }, true, AHORA),
    ).toEqual({ serie: 'FEACZM', folio: '72128', folio_releido_at: AHORA });
  });

  it('CFDI sin Serie/Folio ⇒ null pero SELLADO (no hay nada que releer)', () => {
    expect(
      camposSerieFolioInsert({ serie: null, folio: null }, true, AHORA),
    ).toEqual({ serie: null, folio: null, folio_releido_at: AHORA });
  });

  it('pyservices viejo ⇒ SIN sello: el cron la relee después', () => {
    expect(camposSerieFolioInsert({ uuid_fiscal: 'u' }, true, AHORA)).toEqual({
      serie: null,
      folio: null,
      folio_releido_at: null,
    });
  });

  it('sin XML (solo PDF) ⇒ {}', () => {
    expect(camposSerieFolioInsert(null, true, AHORA)).toEqual({});
  });
});

describe('clasificarFalloRelectura', () => {
  it('pyservices 422/400 con `detail` de TEXTO (XML roto) ⇒ ILEGIBLE', () => {
    expect(
      clasificarFalloRelectura(
        new BadGatewayException(
          'pyservices respondio 422: {"detail":"syntax error"}',
        ),
      ),
    ).toBe('ILEGIBLE');
    expect(
      clasificarFalloRelectura(
        new Error('pyservices respondió 400: { "detail" : "base64 inválido" }'),
      ),
    ).toBe('ILEGIBLE');
  });

  it('422 de VALIDACIÓN de FastAPI (`detail` LISTA) o 400/422 sin JSON ⇒ TRANSITORIO (no sella las 59)', () => {
    for (const msg of [
      'pyservices respondio 422: {"detail":[{"type":"missing","loc":["body","xml_b64"],"msg":"Field required"}]}',
      'pyservices respondio 422: ',
      'pyservices respondio 400: x',
    ]) {
      expect(clasificarFalloRelectura(new BadGatewayException(msg))).toBe(
        'TRANSITORIO',
      );
    }
  });

  it('el XML ya no está en Storage ⇒ ILEGIBLE', () => {
    expect(
      clasificarFalloRelectura(
        new Error('No se pudo leer facturas/recibidas/x.xml: Object not found'),
      ),
    ).toBe('ILEGIBLE');
  });

  it('pyservices caído, lento, 5xx, 401 o sin configurar ⇒ TRANSITORIO', () => {
    for (const e of [
      new BadGatewayException(
        'No se pudo contactar a pyservices: ECONNREFUSED',
      ),
      new BadGatewayException(
        'pyservices no respondio en 60s (/facturacion/parse-recibida)',
      ),
      new BadGatewayException('pyservices respondio 502: Bad Gateway'),
      new BadGatewayException('pyservices respondio 401: token'),
      new BadGatewayException('pyservices respondio 4220: raro'),
      new ServiceUnavailableException('pyservices no configurado'),
      new Error('No se pudo leer facturas/recibidas/x.xml: fetch failed'),
      'cadena suelta',
      null,
    ]) {
      expect(clasificarFalloRelectura(e)).toBe('TRANSITORIO');
    }
  });
});

describe('notasConFolioNoLegible', () => {
  it('sin notas ⇒ solo la leyenda', () => {
    expect(notasConFolioNoLegible(null)).toBe(NOTA_FOLIO_NO_LEGIBLE);
    expect(notasConFolioNoLegible('  ')).toBe(NOTA_FOLIO_NO_LEGIBLE);
  });

  it('con notas ⇒ al final, en línea nueva', () => {
    expect(notasConFolioNoLegible('Factura en PDF (sin XML)')).toBe(
      `Factura en PDF (sin XML)\n${NOTA_FOLIO_NO_LEGIBLE}`,
    );
  });

  it('no se duplica', () => {
    const una = notasConFolioNoLegible('x');
    expect(notasConFolioNoLegible(una)).toBe(una);
  });

  it('lote del cron = 50', () => {
    expect(RELECTURA_FOLIO_LOTE).toBe(50);
  });
});

describe('cortarRelecturaPorPyservices', () => {
  it('UN fallo transitorio sigue con la siguiente; DOS seguidos cortan', () => {
    expect(cortarRelecturaPorPyservices(0)).toBe(false);
    expect(cortarRelecturaPorPyservices(1)).toBe(false);
    expect(cortarRelecturaPorPyservices(2)).toBe(true);
    expect(cortarRelecturaPorPyservices(3)).toBe(true);
  });
});
