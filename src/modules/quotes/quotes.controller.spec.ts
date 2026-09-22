// Solo se prueba el cableado HTTP de las rutas de la HOJA (form-as-document,
// 8-sep-2026): los servicios se stubbean para no arrastrar la cadena de
// imports del cotizador (notifications/jose, calendar-sync/googleapis).
jest.mock('./quotes.service', () => ({ QuotesService: class {} }));
jest.mock('./quotes-pdf.service', () => ({ QuotesPdfService: class {} }));
jest.mock('./quotes-pdf-interno.service', () => ({
  QuotesPdfInternoService: class {},
}));

import type { Response } from 'express';
import { QuotesController, ROLES_PDF_INTERNO } from './quotes.controller';
import { ROLES_KEY } from '../../common/decorators/roles.decorator';
import { Rol } from '../../common/types/auth.types';
import type { AuthenticatedUser } from '../../common/types/auth.types';
import type { QuotesPdfService } from './quotes-pdf.service';
import type { QuotesPdfInternoService } from './quotes-pdf-interno.service';
import type { QuotesService } from './quotes.service';

interface ResMock {
  headers: Record<string, string>;
  statusCode: number;
  body: unknown;
  ended: boolean;
  set: jest.Mock;
  status: jest.Mock;
  send: jest.Mock;
  end: jest.Mock;
}

function resMock(): ResMock {
  const res: ResMock = {
    headers: {},
    statusCode: 200,
    body: undefined,
    ended: false,
    set: jest.fn((h: Record<string, string>) => {
      Object.assign(res.headers, h);
      return res;
    }),
    status: jest.fn((code: number) => {
      res.statusCode = code;
      return res;
    }),
    send: jest.fn((b: unknown) => {
      res.body = b;
      return res;
    }),
    end: jest.fn(() => {
      res.ended = true;
      return res;
    }),
  };
  return res;
}

function controller(
  pdf: Partial<QuotesPdfService>,
  interno: Partial<QuotesPdfInternoService> = {},
) {
  return new QuotesController(
    {} as QuotesService,
    pdf as QuotesPdfService,
    interno as QuotesPdfInternoService,
  );
}

describe('QuotesController — hoja.css / mapa-svg', () => {
  it('GET hoja.css: text/css + Cache-Control public max-age=3600 con el CSS de pyservices', async () => {
    const hojaCss = jest.fn().mockResolvedValue('.cot-hoja{x:1}');
    const res = resMock();
    await controller({ hojaCss }).hojaCss(res as unknown as Response);
    expect(hojaCss).toHaveBeenCalledTimes(1);
    expect(res.headers).toEqual({
      'Content-Type': 'text/css; charset=utf-8',
      'Cache-Control': 'public, max-age=3600',
    });
    expect(res.body).toBe('.cot-hoja{x:1}');
  });

  it('POST mapa-svg: 200 image/svg+xml + no-store con el svg; sin mapa → 204 sin cuerpo', async () => {
    const dto = { escalas: [{ origen_iata: 'CUN', destino_iata: 'HOL' }] };
    const mapaSvg = jest
      .fn()
      .mockResolvedValueOnce('<svg/>')
      .mockResolvedValueOnce(null);
    const c = controller({ mapaSvg });

    const ok = resMock();
    await c.mapaSvg(dto, ok as unknown as Response);
    expect(mapaSvg).toHaveBeenCalledWith(dto);
    expect(ok.headers).toEqual({
      'Content-Type': 'image/svg+xml; charset=utf-8',
      'Cache-Control': 'no-store',
    });
    expect(ok.body).toBe('<svg/>');
    expect(ok.statusCode).toBe(200);

    const vacio = resMock();
    await c.mapaSvg({ escalas: [] }, vacio as unknown as Response);
    expect(vacio.statusCode).toBe(204);
    expect(vacio.ended).toBe(true);
    expect(vacio.send).not.toHaveBeenCalled();
    expect(vacio.headers).toEqual({});
  });
});

/**
 * HOJA INTERNA EN JSON (22-sep-2026): la pantalla del cotizador pasa a
 * parecerse al PDF interno, así que necesita EXACTAMENTE su payload sin
 * generar un PDF. Dos cosas se congelan: que sea el MISMO `payload()` del PDF
 * (no una réplica) y que lleve el MISMO gate de rol — sin SOCIO.
 */
describe('QuotesController — GET :id/interno', () => {
  const ID = 'vvvvvvvv-0000-4000-8000-000000000329';
  const USUARIO = { userId: 'u-1', nombre: 'Itzi' } as AuthenticatedUser;

  it('devuelve el payload del PDF interno tal cual, SIN renderizar PDF', async () => {
    const payload = jest.fn().mockResolvedValue({ folio: '329' });
    const render = jest.fn();
    const r = await controller({}, { payload, render }).interno(ID, USUARIO);
    expect(payload).toHaveBeenCalledWith(ID, USUARIO);
    expect(render).not.toHaveBeenCalled();
    expect(r).toEqual({ folio: '329' });
  });

  it('mismos roles que POST :id/pdf-interno: ADMIN/COORDINADOR/FACTURACION/ANALISTA, sin SOCIO ni PILOTO', () => {
    const esperados = [
      Rol.ADMIN,
      Rol.COORDINADOR,
      Rol.FACTURACION,
      Rol.ANALISTA,
    ];
    const roles = (m: string): Rol[] =>
      Reflect.getMetadata(
        ROLES_KEY,
        (QuotesController.prototype as unknown as Record<string, object>)[m],
      ) as Rol[];
    expect(roles('interno')).toEqual(esperados);
    // El PDF es la referencia: si alguien le abre la puerta a SOCIO, tiene
    // que ser en los dos a la vez y a propósito.
    expect(roles('interno')).toEqual(roles('pdfInterno'));
    expect(roles('interno')).not.toContain(Rol.SOCIO);
    expect(roles('interno')).not.toContain(Rol.PILOTO);
    // Y las dos salen de la MISMA constante exportada (`ROLES_PDF_INTERNO`,
    // la que cita el invariante 12): con dos listas escritas a mano, abrir un
    // rol en una y olvidar la otra deja la pantalla enseñando lo que el PDF
    // niega. Si esto falla, alguien volvió a escribir los roles a mano.
    expect([...ROLES_PDF_INTERNO]).toEqual(esperados);
    expect(roles('interno')).toEqual([...ROLES_PDF_INTERNO]);
    expect(roles('pdfInterno')).toEqual([...ROLES_PDF_INTERNO]);
  });
});
