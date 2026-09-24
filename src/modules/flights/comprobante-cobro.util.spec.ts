import {
  MENSAJE_TIPO_COMPROBANTE,
  pathComprobanteCobro,
  tipoComprobantePath,
  validarComprobanteCobro,
} from './comprobante-cobro.util';

/** Comprobante del cobro (24-sep-2026): foto o PDF, ≤ 10 MB, extensión manda. */
describe('validarComprobanteCobro', () => {
  it('acepta fotos y PDF por extensión (mayúsculas incluidas)', () => {
    for (const [nombre, ext, tipo] of [
      ['voucher.JPG', 'jpg', 'imagen'],
      ['foto.heic', 'heic', 'imagen'],
      ['x.webp', 'webp', 'imagen'],
      ['comprobante.pdf', 'pdf', 'pdf'],
    ] as const) {
      expect(validarComprobanteCobro({ nombre, bytes: 10 })).toMatchObject({
        ok: true,
        extension: ext,
        tipo,
      });
    }
  });

  it('sin extensión usa el content-type de respaldo', () => {
    expect(
      validarComprobanteCobro({ nombre: 'blob', mime: 'image/png', bytes: 10 }),
    ).toMatchObject({ ok: true, extension: 'png', contentType: 'image/png' });
  });

  it('rechaza otros tipos, vacío y > 10 MB', () => {
    expect(
      validarComprobanteCobro({
        nombre: 'hoja.xlsx',
        mime: 'application/vnd.ms-excel',
        bytes: 10,
      }),
    ).toEqual({
      ok: false,
      codigo: 'ARCHIVO_TIPO_INVALIDO',
      mensaje: MENSAJE_TIPO_COMPROBANTE,
    });
    expect(
      validarComprobanteCobro({ nombre: 'a.jpg', bytes: 0 }),
    ).toMatchObject({
      codigo: 'ARCHIVO_VACIO',
    });
    expect(
      validarComprobanteCobro({ nombre: 'a.jpg', bytes: 10 * 1024 * 1024 + 1 }),
    ).toMatchObject({ codigo: 'ARCHIVO_MUY_GRANDE' });
  });

  it('path y tipo por extensión', () => {
    expect(pathComprobanteCobro('v', 'c', 'u', 'pdf')).toBe(
      'oficina/v/c/u.pdf',
    );
    expect(tipoComprobantePath('oficina/v/c/u.PDF')).toBe('pdf');
    expect(tipoComprobantePath('uid/2026-09/x.jpg')).toBe('imagen');
  });
});
