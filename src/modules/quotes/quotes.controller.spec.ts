// Solo se prueba el cableado HTTP de las rutas de la HOJA (form-as-document,
// 8-sep-2026): los servicios se stubbean para no arrastrar la cadena de
// imports del cotizador (notifications/jose, calendar-sync/googleapis).
jest.mock('./quotes.service', () => ({ QuotesService: class {} }));
jest.mock('./quotes-pdf.service', () => ({ QuotesPdfService: class {} }));
jest.mock('./quotes-pdf-interno.service', () => ({
  QuotesPdfInternoService: class {},
}));

import type { Response } from 'express';
import { QuotesController } from './quotes.controller';
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

function controller(pdf: Partial<QuotesPdfService>) {
  return new QuotesController(
    {} as QuotesService,
    pdf as QuotesPdfService,
    {} as QuotesPdfInternoService,
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
