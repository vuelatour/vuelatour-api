import {
  cuadraConCargo,
  interpretarBusquedaGasto,
  ordenarCandidatosGasto,
} from './gastos-candidatos.util';

/**
 * Candidatos de un CARGO (2-oct-2026). Caso real: los 29 «Pago VIP SAESA»
 * casi iguales; el buscador del panel manda el monto ya normalizado.
 */
describe('interpretarBusquedaGasto', () => {
  it('vacía (o solo espacios) ⇒ sin filtro', () => {
    expect(interpretarBusquedaGasto(undefined)).toEqual({ tipo: 'vacia' });
    expect(interpretarBusquedaGasto('   ')).toEqual({ tipo: 'vacia' });
  });

  it('entero sin decimales ⇒ [q, q+1)', () => {
    expect(interpretarBusquedaGasto('2801')).toEqual({
      tipo: 'monto',
      min: 2801,
      max: 2802,
      maxExclusivo: true,
    });
  });

  it('con decimales ⇒ ±0.01', () => {
    expect(interpretarBusquedaGasto('2801.40')).toEqual({
      tipo: 'monto',
      min: 2801.39,
      max: 2801.41,
      maxExclusivo: false,
    });
    expect(interpretarBusquedaGasto('2231.4')).toMatchObject({
      min: 2231.39,
      max: 2231.41,
    });
  });

  it('tolera «$», espacios y comas de miles', () => {
    expect(interpretarBusquedaGasto('$ 2,801.40')).toMatchObject({
      tipo: 'monto',
      min: 2801.39,
    });
    expect(interpretarBusquedaGasto('$2801')).toMatchObject({
      tipo: 'monto',
      min: 2801,
      max: 2802,
    });
  });

  it('texto ⇒ búsqueda por proveedor/nota/lugar/folio', () => {
    expect(interpretarBusquedaGasto('SAESA')).toEqual({
      tipo: 'texto',
      texto: 'SAESA',
    });
    expect(interpretarBusquedaGasto('vuelo 315')).toEqual({
      tipo: 'texto',
      texto: 'vuelo 315',
    });
    // Un «1,2» no es un monto con miles: se busca como texto.
    expect(interpretarBusquedaGasto('1,2').tipo).toBe('texto');
  });
});

describe('cuadraConCargo — |monto o faltante − |cargo|| ≤ 1.00', () => {
  it('por monto o por faltante; los cruzados nunca', () => {
    expect(cuadraConCargo({ id: 'a', monto: 2231.37 }, 2231.38)).toBe(true);
    expect(cuadraConCargo({ id: 'a', monto: 2801.4 }, 8404.2)).toBe(false);
    expect(
      cuadraConCargo({ id: 'a', monto: 2801.4, faltante: 1000 }, 1000.5),
    ).toBe(true);
    expect(
      cuadraConCargo({ id: 'a', monto: 2231.37, cruzado: true }, 2231.37),
    ).toBe(false);
  });
});

describe('ordenarCandidatosGasto — orden por defecto', () => {
  const ref = { montoCargo: 2231.38, fecha: '2026-09-24' };

  it('cuadran primero, luego monto, luego fecha cercana, luego fecha desc; cruzados al final', () => {
    const r = ordenarCandidatosGasto(
      [
        { id: 'lejos', monto: 5000, fecha: '2026-09-24' },
        { id: 'usd', monto: 120, fecha: '2026-09-24', cruzado: true },
        { id: 'g318', monto: 2231.37, fecha: '2026-09-20' },
        { id: 'g321', monto: 2231.38, fecha: '2026-09-20' },
        { id: 'parcial', monto: 9000, faltante: 2231.38, fecha: '2026-09-10' },
        { id: 'cerca', monto: 2300, fecha: '2026-09-24' },
      ],
      ref,
    );
    expect(r.map((c) => c.id)).toEqual([
      'g321',
      'parcial',
      'g318',
      'cerca',
      'lejos',
      'usd',
    ]);
  });

  it('mismo monto: la fecha más cercana gana; empate de distancia ⇒ la más reciente', () => {
    const r = ordenarCandidatosGasto(
      [
        { id: 'antes', monto: 2801.4, fecha: '2026-09-22' },
        { id: 'despues', monto: 2801.4, fecha: '2026-09-26' },
        { id: 'mismo', monto: 2801.4, fecha: '2026-09-24' },
      ],
      { montoCargo: 8404.2, fecha: '2026-09-24' },
    );
    expect(r.map((c) => c.id)).toEqual(['mismo', 'despues', 'antes']);
  });

  it('no muta la entrada', () => {
    const entrada = [
      { id: 'b', monto: 2 },
      { id: 'a', monto: 1 },
    ];
    ordenarCandidatosGasto(entrada, { montoCargo: 1, fecha: '2026-09-24' });
    expect(entrada.map((c) => c.id)).toEqual(['b', 'a']);
  });
});
