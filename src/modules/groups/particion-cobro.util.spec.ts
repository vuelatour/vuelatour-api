import {
  cuadreSobre,
  diagnosticoSobres,
  ParticionCobroError,
  particionCobroGrupo,
  semaforoCobroGrupo,
  type HijoParticionCobro,
  type ParticionCobroInput,
} from './particion-cobro.util';

/**
 * Sobre de cobro de grupo — caso real del diseño (4-sep-2026): 44 pax
 * CUN→CZA→CUN, 7 aviones, total $21,601.52 USD; anticipo 50 % = $10,800.76.
 */
const TOTALES = [4120.32, 2894.2, 2424.4, 2424.4, 2308.4, 2163.4, 5266.4];
const MATRICULAS = [
  'N621TX',
  'N58BT',
  'N4142R',
  'N990GG',
  'XA-VGV',
  'XB-PEV',
  'XB-ANU',
];

function hijos(
  cobrados: number[] = TOTALES.map(() => 0),
  opts: { ancla?: number; cancelados?: number[] } = {},
): HijoParticionCobro[] {
  return TOTALES.map((t, i) => ({
    vuelo_id: `v${i + 1}`,
    folio: 240 + i + 1,
    posicion: i + 1,
    matricula: MATRICULAS[i],
    total_usd: t,
    cobrado_usd: cobrados[i] ?? 0,
    es_ancla: i === (opts.ancla ?? 0),
    cancelado: (opts.cancelados ?? []).includes(i),
  }));
}

function suma(xs: number[]): number {
  return Math.round(xs.reduce((a, b) => a + b, 0) * 100) / 100;
}

function partir(extra: Partial<ParticionCobroInput> & { monto: number }) {
  return particionCobroGrupo({ moneda: 'USD', hijos: hijos(), ...extra });
}

describe('particionCobroGrupo — AUTO positivo', () => {
  it('anticipo 50 % → PROPORCIONAL con las partes exactas del diseño (Σ 10,800.76)', () => {
    const r = partir({ monto: 10800.76 });
    expect(r.modo_particion).toBe('PROPORCIONAL');
    expect(r.partes.map((p) => p.monto)).toEqual([
      2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2,
    ]);
    expect(r.verificacion.cuadra).toBe(true);
    expect(r.verificacion.suma_partes).toBe(10800.76);
    expect(suma(r.partes.map((p) => p.factor))).toBeCloseTo(1, 4);
    // saldo antes/después por avión
    expect(r.partes[0].saldo_antes_usd).toBe(4120.32);
    expect(r.partes[0].saldo_despues_usd).toBe(2060.16);
    expect(r.partes.map((p) => p.posicion)).toEqual([1, 2, 3, 4, 5, 6, 7]);
    expect(r.partes[0].matricula).toBe('N621TX');
  });

  it('el segundo pago de 10,800.76 (Σ saldos exacto) → LIQUIDACION: cada hijo su saldo', () => {
    const r = partir({
      monto: 10800.76,
      hijos: hijos([2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2]),
    });
    expect(r.modo_particion).toBe('LIQUIDACION');
    expect(r.partes.map((p) => p.monto)).toEqual([
      2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2,
    ]);
    expect(r.partes.every((p) => p.saldo_despues_usd === 0)).toBe(true);
    expect(r.verificacion.cuadra).toBe(true);
  });

  it('LIQUIDACION dentro de la tolerancia (±1 USD): el residuo cae en el ANCLA y Σ == monto exacto', () => {
    const cobrados = [2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2];
    const r = partir({ monto: 10800.0, hijos: hijos(cobrados, { ancla: 2 }) });
    expect(r.modo_particion).toBe('LIQUIDACION');
    expect(r.verificacion.suma_partes).toBe(10800.0);
    expect(r.verificacion.cuadra).toBe(true);
    // ancla = v3 (saldo 1,212.20) absorbe −0.76
    const ancla = r.partes.find((p) => p.vuelo_id === 'v3')!;
    expect(ancla.monto).toBe(1211.44);
    expect(
      r.partes.filter((p) => p.vuelo_id !== 'v3').map((p) => p.monto),
    ).toEqual([2060.16, 1447.1, 1212.2, 1154.2, 1081.7, 2633.2]);
  });

  it('LIQUIDACION: solo los hijos con saldo > 0 reciben parte (un hijo ya liquidado queda fuera)', () => {
    const cobrados = [4120.32, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2];
    const monto = suma(TOTALES) - suma(cobrados); // = 8,740.60
    const r = partir({ monto, hijos: hijos(cobrados) });
    expect(r.modo_particion).toBe('LIQUIDACION');
    expect(r.partes.find((p) => p.vuelo_id === 'v1')).toBeUndefined();
    expect(r.partes).toHaveLength(6);
    expect(r.verificacion.cuadra).toBe(true);
  });

  it('LIQUIDACION sin el ancla entre los pendientes: el residuo va al de mayor saldo', () => {
    const cobrados = [4120.32, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2];
    const monto = suma(TOTALES) - suma(cobrados) + 0.5;
    const r = partir({ monto, hijos: hijos(cobrados, { ancla: 0 }) });
    expect(r.modo_particion).toBe('LIQUIDACION');
    const mayor = r.partes.find((p) => p.vuelo_id === 'v7')!; // saldo 2,633.20
    expect(mayor.monto).toBe(2633.7);
    expect(r.verificacion.cuadra).toBe(true);
  });

  it('fuera de la tolerancia → PROPORCIONAL por precio (no por saldo)', () => {
    const cobrados = [4120.32, 0, 0, 0, 0, 0, 0];
    const r = partir({ monto: 5000, hijos: hijos(cobrados) });
    expect(r.modo_particion).toBe('PROPORCIONAL');
    // el hijo 1 (ya liquidado) sigue recibiendo por precio: regla del diseño
    expect(r.partes.find((p) => p.vuelo_id === 'v1')!.monto).toBe(953.71);
    expect(r.verificacion.cuadra).toBe(true);
  });

  it('PROPORCIONAL: Σ partes == monto exacto con centavos por residuo mayor', () => {
    for (const monto of [0.01, 0.05, 1, 100, 1234.56, 21601.51, 99999.99]) {
      const r = partir({ monto });
      expect(r.verificacion.suma_partes).toBe(monto);
      expect(r.verificacion.cuadra).toBe(true);
      for (const p of r.partes) expect(p.monto).toBeGreaterThan(0);
    }
  });

  it('partes con monto 0 se omiten (cobro de un centavo → una sola parte)', () => {
    const r = partir({ monto: 0.01 });
    expect(r.partes).toHaveLength(1);
    expect(r.partes[0].monto).toBe(0.01);
  });

  it('hijos CANCELADOS nunca reciben partes ni cuentan en los saldos', () => {
    const r = partir({
      monto: 10800.76,
      hijos: hijos(undefined, { cancelados: [6] }),
    });
    expect(r.partes.find((p) => p.vuelo_id === 'v7')).toBeUndefined();
    expect(r.partes).toHaveLength(6);
    expect(r.verificacion.cuadra).toBe(true);
    // LIQUIDACION contra los 6 vivos
    const r2 = partir({
      monto: suma(TOTALES.slice(0, 6)),
      hijos: hijos(undefined, { cancelados: [6] }),
    });
    expect(r2.modo_particion).toBe('LIQUIDACION');
    expect(r2.partes.map((p) => p.monto)).toEqual(TOTALES.slice(0, 6));
  });

  it('todos los aviones con precio $0 → todo al ancla con aviso', () => {
    const r = particionCobroGrupo({
      monto: 500,
      moneda: 'USD',
      hijos: hijos().map((h) => ({ ...h, total_usd: 0 })),
    });
    expect(r.modo_particion).toBe('PROPORCIONAL');
    expect(r.partes).toHaveLength(1);
    expect(r.partes[0].vuelo_id).toBe('v1');
    expect(r.partes[0].monto).toBe(500);
    expect(r.avisos[0]).toMatch(/ancla/);
  });
});

describe('particionCobroGrupo — MXN con tipo de cambio', () => {
  it('PROPORCIONAL en pesos: Σ exacta en MXN y monto_usd = monto / tc', () => {
    const r = partir({ monto: 200000, moneda: 'MXN', tc: 18.5 });
    expect(r.moneda).toBe('MXN');
    expect(r.monto_usd).toBe(10810.81);
    expect(r.modo_particion).toBe('PROPORCIONAL');
    expect(r.verificacion.suma_partes).toBe(200000);
    expect(r.verificacion.cuadra).toBe(true);
    expect(r.partes[0].monto_usd).toBe(
      Math.round((r.partes[0].monto / 18.5) * 100) / 100,
    );
  });

  it('LIQUIDACION en pesos: saldo_i × tc, residuo de la conversión al ancla, Σ == monto exacto', () => {
    const cobrados = [2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2];
    const tc = 18.5;
    const monto = Math.round(10800.76 * tc * 100) / 100; // 199,814.06
    const r = partir({ monto, moneda: 'MXN', tc, hijos: hijos(cobrados) });
    expect(r.modo_particion).toBe('LIQUIDACION');
    expect(r.verificacion.suma_partes).toBe(monto);
    expect(r.verificacion.cuadra).toBe(true);
    // el no-ancla recibe exactamente saldo × tc
    expect(r.partes.find((p) => p.vuelo_id === 'v2')!.monto).toBe(
      Math.round(1447.1 * tc * 100) / 100,
    );
  });

  it('MXN sin TC → SIN_TC', () => {
    expect(() => partir({ monto: 1000, moneda: 'MXN' })).toThrow(
      ParticionCobroError,
    );
    try {
      partir({ monto: 1000, moneda: 'MXN', tc: 0 });
    } catch (e) {
      expect((e as ParticionCobroError).code).toBe('SIN_TC');
    }
  });
});

describe('particionCobroGrupo — reembolso (monto < 0)', () => {
  const cobrados = [2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2];

  it('PROPORCIONAL por neto cobrado, partes negativas, Σ exacta', () => {
    const r = partir({ monto: -1000, hijos: hijos(cobrados) });
    expect(r.modo_particion).toBe('PROPORCIONAL');
    expect(r.partes.every((p) => p.monto < 0)).toBe(true);
    expect(r.verificacion.suma_partes).toBe(-1000);
    expect(r.verificacion.cuadra).toBe(true);
    // pesos = cobrado_i / Σ cobrado (10,800.76) — hijo 1 ≈ 19.07 %
    expect(r.partes[0].factor).toBeCloseTo(2060.16 / 10800.76, 5);
    expect(r.partes[0].monto).toBe(-190.74);
    expect(r.partes[0].saldo_despues_usd).toBe(
      Math.round((2060.16 + 190.74) * 100) / 100,
    );
  });

  it('un hijo sin cobros no recibe reembolso', () => {
    const r = partir({
      monto: -100,
      hijos: hijos([500, 0, 0, 0, 0, 0, 500]),
    });
    expect(r.partes.map((p) => p.vuelo_id)).toEqual(['v1', 'v7']);
    expect(r.partes.map((p) => p.monto)).toEqual([-50, -50]);
  });

  it('candado: |parte_i| ≤ cobrado_i → REEMBOLSO_EXCEDE con detalle por avión', () => {
    expect.assertions(4);
    try {
      partir({ monto: -20000, hijos: hijos(cobrados) });
    } catch (e) {
      const err = e as ParticionCobroError;
      expect(err.code).toBe('REEMBOLSO_EXCEDE');
      const det = err.details as Array<{
        vuelo_id: string;
        cobrado_usd: number;
      }>;
      expect(det).toHaveLength(7);
      expect(det[0].vuelo_id).toBe('v1');
      expect(err.message).toMatch(/supera lo cobrado/);
    }
  });

  it('candado en MXN: la parte se compara en USD con el tc del sobre', () => {
    // cobrado 100 USD en v1; reembolso 1,900 MXN a 18.5 = 102.70 USD → excede
    expect(() =>
      partir({
        monto: -1900,
        moneda: 'MXN',
        tc: 18.5,
        hijos: hijos([100, 0, 0, 0, 0, 0, 0]),
      }),
    ).toThrow(/supera lo cobrado/);
    // 1,850 MXN = 100.00 USD → pasa
    const ok = partir({
      monto: -1850,
      moneda: 'MXN',
      tc: 18.5,
      hijos: hijos([100, 0, 0, 0, 0, 0, 0]),
    });
    expect(ok.partes[0].monto).toBe(-1850);
  });

  it('sin nada cobrado → REEMBOLSO_EXCEDE', () => {
    try {
      partir({ monto: -10 });
    } catch (e) {
      expect((e as ParticionCobroError).code).toBe('REEMBOLSO_EXCEDE');
    }
  });

  it('un reembolso no acepta comisión bancaria', () => {
    try {
      partir({ monto: -10, comision_banco_monto: 1, hijos: hijos(cobrados) });
    } catch (e) {
      expect((e as ParticionCobroError).code).toBe('COMISION_INVALIDA');
    }
  });
});

describe('particionCobroGrupo — MANUAL', () => {
  it('acepta montos dados cuya Σ == monto exacto; factor = parte / monto', () => {
    const r = partir({
      monto: 1000,
      modo: 'MANUAL',
      particion_manual: [
        { vuelo_id: 'v1', monto: 600 },
        { vuelo_id: 'v7', monto: 400 },
        { vuelo_id: 'v2', monto: 0 },
      ],
    });
    expect(r.modo_particion).toBe('MANUAL');
    expect(r.partes.map((p) => [p.vuelo_id, p.monto])).toEqual([
      ['v1', 600],
      ['v7', 400],
    ]);
    expect(r.partes[0].factor).toBe(0.6);
    expect(r.verificacion.cuadra).toBe(true);
  });

  it('no cuadra → PARTICION_NO_CUADRA con la diferencia', () => {
    try {
      partir({
        monto: 1000,
        modo: 'MANUAL',
        particion_manual: [
          { vuelo_id: 'v1', monto: 600 },
          { vuelo_id: 'v2', monto: 300 },
        ],
      });
    } catch (e) {
      const err = e as ParticionCobroError;
      expect(err.code).toBe('PARTICION_NO_CUADRA');
      expect(err.details).toEqual({ suma: 900, monto: 1000, diferencia: 100 });
    }
  });

  it('hijo ajeno / cancelado / repetido / signo distinto → error claro', () => {
    const codigo = (p: ParticionCobroInput['particion_manual'], extra = {}) => {
      try {
        partir({ monto: 100, modo: 'MANUAL', particion_manual: p, ...extra });
        return null;
      } catch (e) {
        return (e as ParticionCobroError).code;
      }
    };
    expect(codigo([{ vuelo_id: 'ajeno', monto: 100 }])).toBe('HIJO_INVALIDO');
    expect(
      codigo([{ vuelo_id: 'v7', monto: 100 }], {
        hijos: hijos(undefined, { cancelados: [6] }),
      }),
    ).toBe('HIJO_INVALIDO');
    expect(
      codigo([
        { vuelo_id: 'v1', monto: 50 },
        { vuelo_id: 'v1', monto: 50 },
      ]),
    ).toBe('HIJO_INVALIDO');
    expect(
      codigo([
        { vuelo_id: 'v1', monto: 150 },
        { vuelo_id: 'v2', monto: -50 },
      ]),
    ).toBe('PARTICION_NO_CUADRA');
    expect(codigo([])).toBe('HIJO_INVALIDO');
  });

  it('MANUAL negativo respeta el candado del reembolso por hijo', () => {
    try {
      partir({
        monto: -300,
        modo: 'MANUAL',
        hijos: hijos([100, 500, 0, 0, 0, 0, 0]),
        particion_manual: [
          { vuelo_id: 'v1', monto: -200 },
          { vuelo_id: 'v2', monto: -100 },
        ],
      });
    } catch (e) {
      const err = e as ParticionCobroError;
      expect(err.code).toBe('REEMBOLSO_EXCEDE');
      expect((err.details as Array<{ vuelo_id: string }>)[0].vuelo_id).toBe(
        'v1',
      );
    }
  });
});

describe('particionCobroGrupo — comisión bancaria', () => {
  it('se parte con los mismos pesos, Σ exacta y residuo al ancla', () => {
    const r = partir({ monto: 10800.76, comision_banco_monto: 123.45 });
    const partesCom = r.partes.map((p) => p.comision_banco_monto ?? 0);
    expect(suma(partesCom)).toBe(123.45);
    expect(r.verificacion.suma_comision).toBe(123.45);
    expect(r.verificacion.cuadra_comision).toBe(true);
    // proporcional al precio: hijo 1 ≈ 19.07 % de 123.45
    expect(partesCom[0]).toBeCloseTo(123.45 * (4120.32 / 21601.52), 1);
    for (const p of r.partes) {
      expect(p.comision_banco_monto!).toBeLessThan(p.monto);
    }
  });

  it('en LIQUIDACION la comisión sigue las partes (no el precio)', () => {
    const cobrados = [4120.32, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2];
    const monto = suma(TOTALES) - suma(cobrados);
    const r = partir({
      monto,
      comision_banco_monto: 50,
      hijos: hijos(cobrados),
    });
    expect(r.modo_particion).toBe('LIQUIDACION');
    expect(r.partes.find((p) => p.vuelo_id === 'v1')).toBeUndefined();
    expect(suma(r.partes.map((p) => p.comision_banco_monto ?? 0))).toBe(50);
  });

  it('comisión ≥ monto → COMISION_INVALIDA', () => {
    try {
      partir({ monto: 100, comision_banco_monto: 100 });
    } catch (e) {
      expect((e as ParticionCobroError).code).toBe('COMISION_INVALIDA');
    }
  });

  it('sin comisión → comision_banco_monto null en cada parte', () => {
    const r = partir({ monto: 100 });
    expect(r.partes.every((p) => p.comision_banco_monto === null)).toBe(true);
    expect(r.verificacion.suma_comision).toBeNull();
    expect(r.verificacion.cuadra_comision).toBe(true);
  });
});

describe('particionCobroGrupo — entradas inválidas', () => {
  it('monto 0 → MONTO_CERO; sin hijos vivos → SIN_HIJOS', () => {
    const codigoDe = (fn: () => unknown): string | null => {
      try {
        fn();
        return null;
      } catch (e) {
        return (e as ParticionCobroError).code ?? null;
      }
    };
    expect(codigoDe(() => partir({ monto: 0 }))).toBe('MONTO_CERO');
    expect(
      codigoDe(() =>
        partir({
          monto: 10,
          hijos: hijos(undefined, { cancelados: [0, 1, 2, 3, 4, 5, 6] }),
        }),
      ),
    ).toBe('SIN_HIJOS');
  });

  it('particion_manual con modo AUTO → error claro (no se ignora en silencio)', () => {
    expect(() =>
      partir({
        monto: 100,
        modo: 'AUTO',
        particion_manual: [{ vuelo_id: 'v1', monto: 100 }],
      }),
    ).toThrow(/modo MANUAL/);
  });
});

describe('particionCobroGrupo — avisos de sobrepago (reparto por precio)', () => {
  it('pago mayor al saldo del grupo → aviso, Σ exacta', () => {
    const r = partir({
      monto: 30000,
      hijos: hijos(TOTALES.map((t) => t / 2)),
    });
    expect(r.modo_particion).toBe('PROPORCIONAL');
    expect(suma(r.partes.map((p) => p.monto))).toBe(30000);
    expect(r.avisos.some((a) => a.includes('supera el saldo del grupo'))).toBe(
      true,
    );
  });

  it('un avión ya liquidado por su cuenta recibe parte por precio → aviso con su etiqueta', () => {
    const cobrados = TOTALES.map(() => 0);
    cobrados[1] = TOTALES[1]; // N58BT pagó completo por su vuelo
    const r = partir({ monto: 5000, hijos: hijos(cobrados) });
    expect(r.modo_particion).toBe('PROPORCIONAL');
    expect(suma(r.partes.map((p) => p.monto))).toBe(5000);
    expect(
      r.partes.find((p) => p.vuelo_id === 'v2')!.saldo_despues_usd,
    ).toBeLessThan(0);
    expect(r.avisos.some((a) => a.includes('N58BT'))).toBe(true);
  });

  it('pago dentro de los saldos sin liquidar a nadie → sin aviso', () => {
    const r = partir({ monto: 5000 });
    expect(r.avisos).toEqual([]);
  });
});

describe('semaforoCobroGrupo', () => {
  it('compone los semáforos de los hijos vivos', () => {
    expect(semaforoCobroGrupo([])).toBe('gris');
    expect(semaforoCobroGrupo(['gris', 'gris'])).toBe('gris');
    expect(semaforoCobroGrupo(['verde', 'verde', 'gris'])).toBe('verde');
    expect(semaforoCobroGrupo(['rojo', 'rojo'])).toBe('rojo');
    expect(semaforoCobroGrupo(['verde', 'rojo'])).toBe('ambar');
    expect(semaforoCobroGrupo(['ambar'])).toBe('ambar');
    expect(semaforoCobroGrupo(['verde', 'ambar'])).toBe('ambar');
  });
});

describe('cuadreSobre / diagnosticoSobres (invariante Σ partes == sobre)', () => {
  const partes = (montos: number[], cancelados: number[] = []) =>
    montos.map((m, i) => ({ monto: m, cancelado: cancelados.includes(i) }));

  it('cuadra: Σ exacta y sin cancelados → no hay problema', () => {
    const c = cuadreSobre({
      monto: 10800.76,
      partes: partes([2060.16, 1447.1, 1212.2, 1212.2, 1154.2, 1081.7, 2633.2]),
    });
    expect(c).toEqual({
      suma_partes: 10800.76,
      cuadra: true,
      partes_en_cancelados: 0,
      descuadrado: false,
    });
    expect(
      diagnosticoSobres(12, [
        {
          id: 's1',
          monto: 10800.76,
          moneda: 'USD',
          partes: partes([10800.76]),
        },
      ]),
    ).toEqual([]);
  });

  it('Σ partes ≠ sobre → SOBRE descuadrado con sumas', () => {
    const out = diagnosticoSobres(12, [
      {
        id: 's1',
        monto: 1000,
        moneda: 'USD',
        fecha_cobro: '2026-09-04T15:00:00Z',
        partes: partes([600, 300]),
      },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tipo: 'SOBRE',
      sobre_id: 's1',
      monto: 1000,
      suma_partes: 900,
      partes_en_cancelados: 0,
    });
    expect(out[0].detalle).toContain('Sobre de $1,000.00 USD del 2026-09-04');
    expect(out[0].detalle).toContain('grupo G-12 descuadrado');
    expect(out[0].detalle).toContain('suman $900.00');
    expect(out[0].detalle).toContain('re-parte desde Cobros del grupo');
  });

  it('parte en un hijo cancelado → descuadrado aunque la suma cuadre', () => {
    const out = diagnosticoSobres(7, [
      { id: 's2', monto: 500, moneda: 'MXN', partes: partes([250, 250], [1]) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      tipo: 'SOBRE',
      suma_partes: 500,
      partes_en_cancelados: 1,
    });
    expect(out[0].detalle).toContain('1 parte(s) en aviones cancelados');
    expect(out[0].detalle).toContain('G-7');
  });

  it('reembolso (negativo) se etiqueta como reembolso y compara en valor exacto', () => {
    const out = diagnosticoSobres(3, [
      { id: 's3', monto: -300, moneda: 'USD', partes: partes([-100, -100]) },
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].detalle).toMatch(/^Reembolso de grupo de \$300\.00 USD/);
    expect(out[0].suma_partes).toBe(-200);
  });

  it('sobre sin partes (todas borradas) → descuadrado', () => {
    const c = cuadreSobre({ monto: 100, partes: [] });
    expect(c.cuadra).toBe(false);
    expect(c.descuadrado).toBe(true);
  });

  it('centavos de float no descuadran (0.1 + 0.2)', () => {
    const c = cuadreSobre({ monto: 0.3, partes: partes([0.1, 0.2]) });
    expect(c.cuadra).toBe(true);
  });
});
