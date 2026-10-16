import { BadRequestException, ConflictException } from '@nestjs/common';
import {
  CODIGOS_COBRO_FACTURA,
  errorCobroFactura,
  leerErrorCobroFactura,
  validarFacturaParaCobro,
} from './cobro-factura.util';

/**
 * FACTURAS POR COBRO (16-oct-2026, invariante 84): `validarFacturaParaCobro`
 * es el espejo del trigger A de 20261016000001 — mismos códigos, mismo
 * orden — y la carrera 23514 vuelve como el MISMO 400/409.
 */
const F = { id: 'f-0420', serie: 'A', folio: '0420', estatus: 'VIGENTE' };
const LIGA = [{ factura_id: 'f-0420', vuelo_id: 'v332' }];
const cobro = (extra: Record<string, unknown> = {}) => ({
  id: 'c1',
  vuelo_id: 'v332',
  monto: 68208,
  cobro_grupo_id: null,
  ...extra,
});

describe('validarFacturaParaCobro (espejo del trigger A)', () => {
  it('la tabla de paridad con el trigger: 4 códigos en este orden', () => {
    expect([...CODIGOS_COBRO_FACTURA]).toEqual([
      'REEMBOLSO_SIN_FACTURA',
      'COBRO_DE_GRUPO',
      'FACTURA_NO_VIGENTE',
      'FACTURA_NO_LIGADA_AL_VUELO',
    ]);
  });

  it('cobro positivo, sin sobre, factura VIGENTE ligada al vuelo ⇒ pasa', () => {
    expect(validarFacturaParaCobro(cobro(), F, LIGA)).toBeNull();
  });

  it('reembolso (monto ≤ 0 o no numérico) ⇒ REEMBOLSO_SIN_FACTURA, antes que todo', () => {
    expect(validarFacturaParaCobro(cobro({ monto: -500 }), null, [])).toEqual({
      codigo: 'REEMBOLSO_SIN_FACTURA',
      details: { cobro_id: 'c1' },
    });
    expect(
      validarFacturaParaCobro(cobro({ monto: 'x' }), F, LIGA)?.codigo,
    ).toBe('REEMBOLSO_SIN_FACTURA');
  });

  it('parte de un sobre ⇒ COBRO_DE_GRUPO (gana sobre una factura inexistente)', () => {
    expect(
      validarFacturaParaCobro(cobro({ cobro_grupo_id: 'sobre-1' }), null, []),
    ).toEqual({
      codigo: 'COBRO_DE_GRUPO',
      details: { cobro_id: 'c1', cobro_grupo_id: 'sobre-1' },
    });
  });

  it('factura inexistente, CANCELADA o borrada ⇒ FACTURA_NO_VIGENTE con el detalle', () => {
    expect(validarFacturaParaCobro(cobro(), null, LIGA, 'f-x')).toEqual({
      codigo: 'FACTURA_NO_VIGENTE',
      details: { factura_id: 'f-x', estatus: null, borrada: false },
    });
    expect(
      validarFacturaParaCobro(cobro(), { ...F, estatus: 'CANCELADA' }, LIGA),
    ).toMatchObject({
      codigo: 'FACTURA_NO_VIGENTE',
      details: { estatus: 'CANCELADA', borrada: false },
    });
    expect(
      validarFacturaParaCobro(
        cobro(),
        { ...F, deleted_at: '2026-10-16T10:00:00Z' },
        LIGA,
      ),
    ).toMatchObject({
      codigo: 'FACTURA_NO_VIGENTE',
      details: { borrada: true },
    });
  });

  it('factura de OTRO vuelo ⇒ FACTURA_NO_LIGADA_AL_VUELO; la del HERMANO de grupo también rebota (sin excepción de grupo)', () => {
    const r = validarFacturaParaCobro(cobro(), F, [
      { factura_id: 'f-0420', vuelo_id: 'v333-hermano' },
    ]);
    expect(r).toEqual({
      codigo: 'FACTURA_NO_LIGADA_AL_VUELO',
      details: { factura_id: 'f-0420', vuelo_id: 'v332' },
    });
    // Tras agregar el vuelo a la factura (vuelo_ids), pasa.
    expect(
      validarFacturaParaCobro(cobro(), F, [
        { factura_id: 'f-0420', vuelo_id: 'v333-hermano' },
        ...LIGA,
      ]),
    ).toBeNull();
  });
});

describe('errorCobroFactura (400/409 del contrato §3.1)', () => {
  it('REEMBOLSO_SIN_FACTURA ⇒ 400; los demás ⇒ 409 con etiqueta y folio en el texto', () => {
    const e400 = errorCobroFactura({
      codigo: 'REEMBOLSO_SIN_FACTURA',
      details: { cobro_id: 'c1' },
    });
    expect(e400).toBeInstanceOf(BadRequestException);
    expect(e400.getResponse()).toEqual({
      message: 'Un reembolso no se liga a una factura.',
      error: 'REEMBOLSO_SIN_FACTURA',
      details: { cobro_id: 'c1' },
    });
    const e409 = errorCobroFactura(
      {
        codigo: 'FACTURA_NO_LIGADA_AL_VUELO',
        details: { factura_id: 'f-0420', vuelo_id: 'v332' },
      },
      { etiqueta: 'A-0420', folio: 332 },
    );
    expect(e409).toBeInstanceOf(ConflictException);
    expect(e409.getResponse()).toEqual({
      message:
        'La factura A-0420 no está ligada al vuelo #332. Agrégale el vuelo en Facturas emitidas → Editar → Vuelos y vuelve a intentar.',
      error: 'FACTURA_NO_LIGADA_AL_VUELO',
      details: { factura_id: 'f-0420', vuelo_id: 'v332', folio: 332 },
    });
    expect(
      (
        errorCobroFactura(
          {
            codigo: 'FACTURA_NO_VIGENTE',
            details: { factura_id: 'f', estatus: 'CANCELADA', borrada: false },
          },
          { etiqueta: 'A-0420' },
        ).getResponse() as { message: string }
      ).message,
    ).toBe(
      'La factura A-0420 ya no está vigente (o no existe): recarga la página y elige otra.',
    );
  });
});

describe('leerErrorCobroFactura (carrera: el 23514 del trigger A)', () => {
  it('lee el código del hint y el detail JSON', () => {
    expect(
      leerErrorCobroFactura({
        code: '23514',
        message:
          'FACTURA_NO_LIGADA_AL_VUELO: la factura no está ligada al vuelo',
        hint: 'FACTURA_NO_LIGADA_AL_VUELO',
        details: '{"factura_id":"f-0420","vuelo_id":"v332"}',
      }),
    ).toEqual({
      codigo: 'FACTURA_NO_LIGADA_AL_VUELO',
      details: { factura_id: 'f-0420', vuelo_id: 'v332' },
    });
  });

  it('sin hint toma el prefijo del mensaje; otro 23514 (COBRO_CONCILIADO) o detail roto ⇒ null / {}', () => {
    expect(
      leerErrorCobroFactura({
        code: '23514',
        message: 'FACTURA_NO_VIGENTE: cancelada',
        details: 'no-json',
      }),
    ).toEqual({ codigo: 'FACTURA_NO_VIGENTE', details: {} });
    expect(
      leerErrorCobroFactura({
        code: '23514',
        message: 'COBRO_CONCILIADO: …',
        hint: 'COBRO_CONCILIADO',
      }),
    ).toBeNull();
    expect(
      leerErrorCobroFactura({
        code: '23505',
        message: 'FACTURA_NO_VIGENTE: x',
      }),
    ).toBeNull();
    expect(leerErrorCobroFactura(null)).toBeNull();
  });
});
