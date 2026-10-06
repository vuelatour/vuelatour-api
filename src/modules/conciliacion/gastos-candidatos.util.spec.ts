import {
  clasificarMediosVinculo,
  cuadraConCargo,
  errorSinMonedaCuenta,
  esMedioBancario,
  esMedioNoBancarioVinculable,
  interpretarBusquedaGasto,
  MEDIO_BODEGA,
  MEDIOS_BANCARIOS,
  MENSAJE_SIN_MONEDA_CUENTA,
  ordenarCandidatosGasto,
  ordenarCandidatosPorNiveles,
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

describe('ordenarCandidatosPorNiveles — con gastos en efectivo (revisión 6-oct-2026)', () => {
  const ref = { montoCargo: 212, fecha: '2026-09-07' };

  it('niveles: bancarios que cuadran, no bancarios que cuadran, resto de bancarios (cruzados al final), resto de no bancarios', () => {
    const r = ordenarCandidatosPorNiveles(
      [
        { id: 'ef-lejos', monto: 500, fecha: '2026-09-07', no_bancario: true },
        {
          id: 'tdc-lejos',
          monto: 900,
          fecha: '2026-09-07',
          no_bancario: false,
        },
        { id: 'ef-212', monto: 212, fecha: '2026-09-28', no_bancario: true },
        {
          id: 'usd',
          monto: 11,
          fecha: '2026-09-07',
          cruzado: true,
          no_bancario: false,
        },
        {
          id: 'tdc-212',
          monto: 212.5,
          fecha: '2026-09-30',
          no_bancario: false,
        },
        { id: 'ef-211', monto: 211.4, fecha: '2026-09-27', no_bancario: true },
        { id: 'tdc-300', monto: 300, fecha: '2026-09-08', no_bancario: false },
      ],
      ref,
    );
    expect(r.map((c) => c.id)).toEqual([
      'tdc-212',
      'ef-212',
      'ef-211',
      'tdc-300',
      'tdc-lejos',
      'usd',
      'ef-lejos',
    ]);
  });

  it('caso real (prod): 254 bancarios que no cuadran y el efectivo exacto ⇒ el efectivo entra en los primeros 100', () => {
    const bancarios = Array.from({ length: 254 }, (_, i) => ({
      id: `tdc-${String(i).padStart(3, '0')}`,
      monto: 300 + i,
      fecha: '2026-09-10',
      no_bancario: false,
    }));
    const efectivo = ['2026-09-24', '2026-09-27', '2026-09-28'].map((f) => ({
      id: `ef-${f.slice(8)}`,
      monto: 212,
      fecha: f,
      no_bancario: true,
    }));
    const primeros = ordenarCandidatosPorNiveles(
      [...bancarios, ...efectivo],
      ref,
    ).slice(0, 100);
    expect(primeros.slice(0, 3).map((c) => c.id)).toEqual([
      'ef-24',
      'ef-27',
      'ef-28',
    ]);
    expect(primeros.filter((c) => c.no_bancario)).toHaveLength(3);
  });

  it('sin no bancarios es EXACTAMENTE ordenarCandidatosGasto (el orden del 0.0.62)', () => {
    const entrada = [
      { id: 'lejos', monto: 5000, fecha: '2026-09-24' },
      { id: 'usd', monto: 120, fecha: '2026-09-24', cruzado: true },
      { id: 'g318', monto: 2231.37, fecha: '2026-09-20', no_bancario: false },
      { id: 'g321', monto: 2231.38, fecha: '2026-09-20' },
      { id: 'parcial', monto: 9000, faltante: 2231.38, fecha: '2026-09-10' },
      { id: 'cerca', monto: 2300, fecha: '2026-09-24' },
    ];
    const r2 = { montoCargo: 2231.38, fecha: '2026-09-24' };
    expect(ordenarCandidatosPorNiveles(entrada, r2)).toEqual(
      ordenarCandidatosGasto(entrada, r2),
    );
  });
});

describe('errorSinMonedaCuenta (candidatos y liga de un lote)', () => {
  it('503 CUENTA_SIN_MONEDA con el texto legible (un Error suelto lo perdía en el filtro global)', () => {
    const e = errorSinMonedaCuenta();
    expect(e.getStatus()).toBe(503);
    expect(e.getResponse()).toEqual({
      message: MENSAJE_SIN_MONEDA_CUENTA,
      error: 'CUENTA_SIN_MONEDA',
    });
    expect(MENSAJE_SIN_MONEDA_CUENTA).toBe(
      'No se pudo leer la moneda de la cuenta bancaria del cargo: vuelve a intentarlo en unos minutos.',
    );
  });
});

/**
 * Gasto NO bancario con justificación (6-oct-2026, API 0.0.63): qué medio
 * entra al universo con `incluir_no_bancarios` y qué pide el PATCH.
 */
describe('medios del vínculo', () => {
  it('bancarios: TARJETA_CORP, TRANSFERENCIA y PAYWISE; sin medio ⇒ no', () => {
    for (const m of MEDIOS_BANCARIOS) expect(esMedioBancario(m)).toBe(true);
    for (const m of ['EFECTIVO', 'PERSONAL_PABLO', 'BODEGA', null, '']) {
      expect(esMedioBancario(m)).toBe(false);
    }
  });

  it('vinculables con justificación: todo lo NO bancario menos BODEGA (y sin medio)', () => {
    expect(esMedioNoBancarioVinculable('EFECTIVO')).toBe(true);
    expect(esMedioNoBancarioVinculable('PERSONAL_PABLO')).toBe(true);
    expect(esMedioNoBancarioVinculable('PERSONAL_ALE')).toBe(true);
    expect(esMedioNoBancarioVinculable(MEDIO_BODEGA)).toBe(false);
    expect(esMedioNoBancarioVinculable('TARJETA_CORP')).toBe(false);
    expect(esMedioNoBancarioVinculable(null)).toBe(false);
  });

  it('clasificarMediosVinculo: BODEGA siempre; no bancarios solo si ENTRAN; sin medio pide razón', () => {
    const g = (id: string, medio_pago: string | null) => ({ id, medio_pago });
    const r = clasificarMediosVinculo(
      [
        g('tdc', 'TARJETA_CORP'),
        g('efe', 'EFECTIVO'),
        g('efe-ya', 'EFECTIVO'),
        g('pablo', 'PERSONAL_PABLO'),
        g('bod', 'BODEGA'),
        g('bod-ya', 'BODEGA'),
        g('nulo', null),
      ],
      new Set(['efe-ya', 'bod-ya']),
    );
    expect(r.bodega.map((x) => x.id)).toEqual(['bod', 'bod-ya']);
    expect(r.noBancariosNuevos.map((x) => x.id)).toEqual([
      'efe',
      'pablo',
      'nulo',
    ]);
    expect(
      clasificarMediosVinculo([g('tdc', 'TRANSFERENCIA')], new Set()),
    ).toEqual({ bodega: [], noBancariosNuevos: [] });
  });
});
