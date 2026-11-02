/**
 * Número de factura en «Pistas por pagar» (2-nov-2026, invariante 114): la
 * primera línea de las notas y que Conciliación la lea.
 */
import { numerosDeGasto } from '../conciliacion/factura-concepto.util';
import {
  FACTURA_PISTAS_MAX,
  lineaFacturaPistas,
  notasConFactura,
} from './pistas-generar.util';

describe('lineaFacturaPistas', () => {
  it('«Factura NNNN»; si ya trae la clave se respeta; vacío ⇒ null', () => {
    expect(lineaFacturaPistas('7360')).toBe('Factura 7360');
    expect(lineaFacturaPistas(' A-7360 ')).toBe('Factura A-7360');
    expect(lineaFacturaPistas('fact vip 7360')).toBe('fact vip 7360');
    expect(lineaFacturaPistas('FACTURA  7360')).toBe('FACTURA 7360');
    expect(lineaFacturaPistas('Prefactura 4409')).toBe('Prefactura 4409');
    // «facturacion» NO es la clave: se antepone «Factura» (Conciliación la
    // salta como palabra pista y toma el número).
    expect(lineaFacturaPistas('facturacion 7360')).toBe(
      'Factura facturacion 7360',
    );
    expect(lineaFacturaPistas('   ')).toBeNull();
    expect(lineaFacturaPistas(null)).toBeNull();
    expect(lineaFacturaPistas(undefined)).toBeNull();
  });

  it('se recorta al largo del DTO', () => {
    expect(lineaFacturaPistas('x'.repeat(60))).toBe(
      `Factura ${'x'.repeat(FACTURA_PISTAS_MAX)}`,
    );
  });
});

describe('notasConFactura', () => {
  it('la factura va en la PRIMERA línea; sin factura, las notas tal cual', () => {
    expect(notasConFactura('7360', 'Cuota de aterrizaje MID')).toBe(
      'Factura 7360\nCuota de aterrizaje MID',
    );
    expect(notasConFactura('', 'Cuota de aterrizaje MID')).toBe(
      'Cuota de aterrizaje MID',
    );
    expect(notasConFactura(undefined, 'x')).toBe('x');
  });

  it('Conciliación lee el número de esa primera línea (misma regla que «fact NNNN» de la oficina)', () => {
    for (const folio of ['7360', 'fact vip 7360', 'A-7360']) {
      const notas = notasConFactura(
        folio,
        'Cuota de aterrizaje MID · vuelo #364',
      );
      const numeros = numerosDeGasto({ notas }).map((n) => n.texto);
      expect(numeros.some((t) => t.includes('7360'))).toBe(true);
    }
    expect(numerosDeGasto({ notas: 'Cuota de aterrizaje MID' })).toEqual([]);
  });
});
