import { detalleSinPreciosDeBodega } from './detalle-salida-bodega.util';

/**
 * Notas REALES de los gastos BODEGA de prod (SELECT del 19-oct-2026) y las
 * formas que genera hoy `inventory.service`. Lo que el socio lee en el
 * balance: QUÉ se cargó, nunca a cuánto se compró ni con qué margen.
 */
describe('detalleSinPreciosDeBodega', () => {
  const casos: Array<[string, string]> = [
    // La captura del cliente (XA-VGV, septiembre, hoja «refacciones»).
    [
      'Salida de bodega: 1 × Llanta 6.00-6 (precio de venta) · ref 0 · Re-preciado 25-sep-2026: costo FIFO + 25 % (utilidad de la tienda VuelaTour, autorizado por la oficina); antes $373.75 USD',
      'Salida de bodega: 1 × Llanta 6.00-6',
    ],
    // Presentación entre paréntesis: se queda; sin «ref».
    [
      'Salida de bodega: 4 × Balata de freno 66-105 (2 barrenos) (precio de venta) · Re-preciado 25-sep-2026: costo FIFO + 25 % (utilidad de la tienda VuelaTour, autorizado por la oficina); antes $92.52 USD',
      'Salida de bodega: 4 × Balata de freno 66-105 (2 barrenos)',
    ],
    [
      'Salida de bodega: 12 × Aceite multigrado semisintético 15W-50 (precio de venta)',
      'Salida de bodega: 12 × Aceite multigrado semisintético 15W-50',
    ],
    [
      'Salida de bodega: 2 × Rejex Cera Sintetica (último precio + 25 %)',
      'Salida de bodega: 2 × Rejex Cera Sintetica',
    ],
    ['Salida de bodega: 3 × Trapo (a costo)', 'Salida de bodega: 3 × Trapo'],
    // Jul/ago (antes de la tienda): etiqueta FIFO y la corrección de moneda.
    [
      'Salida de bodega: 4 × Aceites 15w 50 (costo FIFO) · Corrección 28-ago-2026: costo en PESOS (se había registrado como USD)',
      'Salida de bodega: 4 × Aceites 15w 50',
    ],
    [
      'Salida de bodega: 1 × Filtro (costo FIFO + 25 %)',
      'Salida de bodega: 1 × Filtro',
    ],
    // Toda la flota: sin «del precio de venta» ni el monto entre paréntesis.
    [
      'Salida de bodega (toda la flota, 1/7 del precio de venta): 12 × Aceite (Galón) (precio de venta $36.42 USD)',
      'Salida de bodega (toda la flota, 1/7): 12 × Aceite (Galón)',
    ],
    [
      'Salida de bodega (toda la flota, 1/7 del costo): 12 × Aceite (último precio + 25 % $45.53 USD) · ref OT-77',
      'Salida de bodega (toda la flota, 1/7): 12 × Aceite · ref OT-77',
    ],
    // Una referencia real y lo que agregó la oficina se quedan.
    [
      'Salida de bodega: 1 × Funda Starlink (precio de venta) · ref OT-123 · para el servicio de 50 h',
      'Salida de bodega: 1 × Funda Starlink · ref OT-123 · para el servicio de 50 h',
    ],
  ];

  it.each(casos)('%s', (entrada, esperado) => {
    expect(detalleSinPreciosDeBodega(entrada)).toBe(esperado);
  });

  it('ningún texto de salida conserva precio, costo ni margen', () => {
    for (const [entrada] of casos) {
      const r = detalleSinPreciosDeBodega(entrada);
      expect(r).not.toMatch(/precio|costo|FIFO|%|antes \$|Re-preciad|ref 0\b/i);
    }
  });

  it('un renglón que no es salida de bodega pasa tal cual', () => {
    const otro =
      'Servicio 50 hrs Toledo (precio de venta) · ref 0 · Re-preciado 1-ene';
    expect(detalleSinPreciosDeBodega(otro)).toBe(otro);
    expect(detalleSinPreciosDeBodega('Pago VIP SAESA')).toBe('Pago VIP SAESA');
  });

  it('solo limpia los renglones de salida; los demás de la nota se quedan', () => {
    expect(
      detalleSinPreciosDeBodega(
        'Salida de bodega: 1 × Llanta 6.00-6 (precio de venta) · ref 0\nRevisado por Luis (costo ok)',
      ),
    ).toBe('Salida de bodega: 1 × Llanta 6.00-6\nRevisado por Luis (costo ok)');
  });

  it('el reparto manual conserva su tramo', () => {
    expect(
      detalleSinPreciosDeBodega(
        'Salida de bodega: 2 × Filtro (precio de venta) · reparto manual: $50.00 de $100.00 USD',
      ),
    ).toBe(
      'Salida de bodega: 2 × Filtro · reparto manual: $50.00 de $100.00 USD',
    );
  });

  it('vacío, null y undefined pasan tal cual', () => {
    expect(detalleSinPreciosDeBodega('')).toBe('');
    expect(detalleSinPreciosDeBodega(null)).toBeNull();
    expect(detalleSinPreciosDeBodega(undefined)).toBeUndefined();
  });
});
