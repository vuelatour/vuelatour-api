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
  ordenarCruzadosPorTc,
  rangoBandaMxnDeUsd,
  rangoBandaUsd,
  rangosUsdDeBusqueda,
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

describe('coincide_factura (concepto del SPEI, 0.0.75) — señal DENTRO de su nivel', () => {
  // Golden: los 29 «Pago VIP SAESA» (4–28 sep) contra un SPEI de $2,231.38.
  const saesa = Array.from({ length: 29 }, (_, i) => ({
    id: `saesa-${String(i).padStart(2, '0')}`,
    monto: [2231.37, 2231.38, 1118.12, 2801.4][i % 4],
    fecha: `2026-09-${String(4 + (i % 25)).padStart(2, '0')}`,
  }));
  const ref = { montoCargo: 2231.38, fecha: '2026-09-24' };

  it('sin el campo (o en false) el orden es byte a byte el de siempre', () => {
    const sinCampo = ordenarCandidatosGasto(saesa, ref).map((c) => c.id);
    const enFalse = ordenarCandidatosGasto(
      saesa.map((c) => ({ ...c, coincide_factura: false })),
      ref,
    ).map((c) => c.id);
    expect(enFalse).toEqual(sinCampo);
    expect(ordenarCandidatosPorNiveles(saesa, ref).map((c) => c.id)).toEqual(
      sinCampo,
    );
  });

  it('con el campo va primero DENTRO del nivel que cuadra', () => {
    const marcados = saesa.map((c) =>
      c.id === 'saesa-25' ? { ...c, coincide_factura: true } : c,
    );
    const orden = ordenarCandidatosGasto(marcados, ref).map((c) => c.id);
    expect(saesa.find((c) => c.id === 'saesa-25')?.monto).toBe(2231.38);
    expect(orden[0]).toBe('saesa-25');
  });

  it('uno que NO cuadra nunca sube sobre los que cuadran; los cruzados siguen al final', () => {
    const r = ordenarCandidatosGasto(
      [
        { id: 'cuadra', monto: 2231.38, fecha: '2026-09-01' },
        {
          id: 'no-cuadra-con-factura',
          monto: 5000,
          fecha: '2026-09-24',
          coincide_factura: true,
        },
        { id: 'no-cuadra', monto: 4000, fecha: '2026-09-24' },
        {
          id: 'usd-con-factura',
          monto: 120,
          fecha: '2026-09-24',
          cruzado: true,
          coincide_factura: true,
        },
      ],
      ref,
    );
    expect(r.map((c) => c.id)).toEqual([
      'cuadra',
      'no-cuadra-con-factura',
      'no-cuadra',
      'usd-con-factura',
    ]);
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
  it('bancarios: TARJETA_CORP, TRANSFERENCIA, PAYWISE y DOMICILIADO; sin medio ⇒ no', () => {
    // ORDEN EXACTO: el panel lee este arreglo por regex y lo compara con su
    // espejo (`MEDIOS_BANCARIOS_CONCILIACION`); los nuevos van AL FINAL.
    expect(MEDIOS_BANCARIOS).toEqual([
      'TARJETA_CORP',
      'TRANSFERENCIA',
      'PAYWISE',
      'DOMICILIADO',
    ]);
    for (const m of MEDIOS_BANCARIOS) expect(esMedioBancario(m)).toBe(true);
    for (const m of ['EFECTIVO', 'PERSONAL_PABLO', 'BODEGA', null, '']) {
      expect(esMedioBancario(m)).toBe(false);
    }
  });

  it('«Pago domiciliado» (13-oct-2026): bancario, se liga como una transferencia (sin justificación)', () => {
    expect(esMedioBancario('DOMICILIADO')).toBe(true);
    expect(esMedioNoBancarioVinculable('DOMICILIADO')).toBe(false);
    const g = (id: string, medio_pago: string | null) => ({ id, medio_pago });
    expect(
      clasificarMediosVinculo([g('dom', 'DOMICILIADO')], new Set()),
    ).toEqual({ bodega: [], noBancariosNuevos: [] });
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

describe('cruzados USD en 7 niveles (invariante 70)', () => {
  const ref = { montoCargo: 7214.14, fecha: '2026-09-01' };
  const tc = (
    nivel: 'CERCA' | 'LEJOS' | 'SIN_OFICIAL',
    desvio_pct: number | null,
  ) => ({
    nivel,
    desvio_pct,
  });

  it('sin cruzados (o con cruzados sin tc_cruce) el orden es el de siempre (golden)', () => {
    const entrada = [
      { id: 'lejos', monto: 5000, fecha: '2026-09-02' },
      { id: 'usd-a', monto: 420, fecha: '2026-09-01', cruzado: true },
      { id: 'cuadra', monto: 7214.14, fecha: '2026-08-30' },
      { id: 'ef', monto: 7214.14, fecha: '2026-09-01', no_bancario: true },
      { id: 'usd-b', monto: 430, fecha: '2026-09-03', cruzado: true },
      { id: 'ef-lejos', monto: 10, fecha: '2026-09-01', no_bancario: true },
    ];
    expect(ordenarCandidatosPorNiveles(entrada, ref).map((c) => c.id)).toEqual([
      'cuadra',
      'ef',
      'lejos',
      'usd-a',
      'usd-b',
      'ef-lejos',
    ]);
  });

  it('los 7 niveles: cuadran · CERCA · no bancarios que cuadran · resto bancario · SIN_OFICIAL · LEJOS · resto no bancario', () => {
    const r = ordenarCandidatosPorNiveles(
      [
        { id: 'ef-lejos', monto: 10, fecha: '2026-09-01', no_bancario: true },
        {
          id: 'lejos-usd',
          monto: 300,
          fecha: '2026-09-01',
          cruzado: true,
          tc_cruce: tc('LEJOS', 24.3),
        },
        {
          id: 'sin-of',
          monto: 400,
          fecha: '2026-09-01',
          cruzado: true,
          tc_cruce: tc('SIN_OFICIAL', null),
        },
        { id: 'resto', monto: 5000, fecha: '2026-09-01' },
        {
          id: 'ef-cuadra',
          monto: 7214.14,
          fecha: '2026-09-01',
          no_bancario: true,
        },
        {
          id: 'cerca',
          monto: 422.86,
          fecha: '2026-09-01',
          cruzado: true,
          tc_cruce: tc('CERCA', 0.3),
        },
        { id: 'cuadra', monto: 7214.14, fecha: '2026-09-01' },
      ],
      ref,
    );
    expect(r.map((c) => c.id)).toEqual([
      'cuadra',
      'cerca',
      'ef-cuadra',
      'resto',
      'sin-of',
      'lejos-usd',
      'ef-lejos',
    ]);
  });

  it('caso real «220 + tubo»: con 220 bancarios MXN que no cuadran, el tubo CERCA queda en la posición 0 (antes del corte de 100)', () => {
    const bancarios = Array.from({ length: 220 }, (_, i) => ({
      id: `mxn-${String(i).padStart(3, '0')}`,
      monto: 100 + i,
      fecha: '2026-09-02',
    }));
    const tubo = {
      id: 'tubo',
      monto: 422.86,
      fecha: '2026-09-01',
      cruzado: true,
      tc_cruce: tc('CERCA', 0.3),
    };
    const r = ordenarCandidatosPorNiveles([...bancarios, tubo], ref);
    expect(r[0].id).toBe('tubo');
  });

  it('ordenarCruzadosPorTc: |desvío| (null al final), |días al cargo|, fecha desc, id', () => {
    const r = ordenarCruzadosPorTc(
      [
        {
          id: 'sin',
          monto: 1,
          fecha: '2026-09-01',
          cruzado: true,
          tc_cruce: tc('CERCA', null),
        },
        {
          id: 'neg',
          monto: 1,
          fecha: '2026-09-05',
          cruzado: true,
          tc_cruce: tc('CERCA', -0.4),
        },
        {
          id: 'pos',
          monto: 1,
          fecha: '2026-09-05',
          cruzado: true,
          tc_cruce: tc('CERCA', 0.3),
        },
        {
          id: 'pos-cerca',
          monto: 1,
          fecha: '2026-09-02',
          cruzado: true,
          tc_cruce: tc('CERCA', 0.3),
        },
        {
          id: 'b',
          monto: 1,
          fecha: '2026-08-31',
          cruzado: true,
          tc_cruce: tc('CERCA', 1.5),
        },
        {
          id: 'a',
          monto: 1,
          fecha: '2026-09-02',
          cruzado: true,
          tc_cruce: tc('CERCA', 1.5),
        },
      ],
      ref,
    );
    expect(r.map((c) => c.id)).toEqual([
      'pos-cerca',
      'pos',
      'neg',
      'a',
      'b',
      'sin',
    ]);
  });

  it('rangoBandaUsd(7214.14) = [288.56, 480.95]', () => {
    expect(rangoBandaUsd(7214.14)).toEqual({ min: 288.56, max: 480.95 });
    expect(rangoBandaMxnDeUsd(422.86)).toEqual({ min: 6342.9, max: 10571.5 });
  });

  it('rangosUsdDeBusqueda con 17.0077: dólares tal cual + equivalente en pesos ±3 %', () => {
    const of = 17.0077;
    expect(
      rangosUsdDeBusqueda(interpretarBusquedaGasto('7214.14'), of),
    ).toEqual([
      { min: 7214.13, max: 7214.15, maxExclusivo: false },
      { min: 411.81, max: 437.29, maxExclusivo: false },
    ]);
    expect(rangosUsdDeBusqueda(interpretarBusquedaGasto('7214'), of)).toEqual([
      { min: 7214, max: 7215, maxExclusivo: true },
      { min: 411.8, max: 437.34, maxExclusivo: false },
    ]);
    expect(rangosUsdDeBusqueda(interpretarBusquedaGasto('422.86'), of)).toEqual(
      [
        { min: 422.85, max: 422.87, maxExclusivo: false },
        { min: 24.13, max: 25.64, maxExclusivo: false },
      ],
    );
    // Sin oficial: solo el rango en dólares; vacía o texto: nada.
    expect(
      rangosUsdDeBusqueda(interpretarBusquedaGasto('7214.14'), null),
    ).toEqual([{ min: 7214.13, max: 7214.15, maxExclusivo: false }]);
    expect(rangosUsdDeBusqueda(interpretarBusquedaGasto(''), of)).toEqual([]);
    expect(rangosUsdDeBusqueda(interpretarBusquedaGasto('spruce'), of)).toEqual(
      [],
    );
  });
});
