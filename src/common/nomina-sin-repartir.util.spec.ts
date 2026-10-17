import {
  CLAVE_PRECIERRE_NOMINA_SIN_REPARTIR,
  TITULO_PRECIERRE_NOMINA_SIN_REPARTIR,
  detallePrecierreNominaSinRepartir,
  pendienteBalanceNominaSinRepartir,
  resumenNominaSinRepartir,
  textoMontosNomina,
} from './nomina-sin-repartir.util';

/**
 * NÓMINA SIN REPARTIR (16-oct-2026, API 0.0.90, invariante 91): sumas por
 * moneda en centavos y los textos del aviso del Balance general y del
 * renglón BLOQUEANTE del pre-cierre. Montos reales de septiembre 2026 (7
 * pagos, $25,757.80 MXN).
 */
const SEPTIEMBRE = [1500, 4725.6, 3566, 6830, 4725.6, 1910.6, 2500].map(
  (monto) => ({ monto: String(monto), moneda: 'MXN' }),
);

describe('resumenNominaSinRepartir', () => {
  it('septiembre real: 7 pagos, $25,757.80 MXN, en centavos (sin arrastre de floats)', () => {
    expect(resumenNominaSinRepartir(SEPTIEMBRE)).toEqual({
      n: 7,
      mxn: 25757.8,
      usd: 0,
    });
  });

  it('jamás suma monedas; un monto ilegible suma 0 pero cuenta como pago', () => {
    expect(
      resumenNominaSinRepartir([
        { monto: 100.1, moneda: 'MXN' },
        { monto: '50.25', moneda: 'USD' },
        { monto: null, moneda: 'MXN' },
        { monto: 0.2, moneda: null },
      ]),
    ).toEqual({ n: 4, mxn: 100.3, usd: 50.25 });
    expect(resumenNominaSinRepartir([])).toEqual({ n: 0, mxn: 0, usd: 0 });
  });
});

describe('textos', () => {
  it('montos: MXN, MXN y USD, solo USD (regla de dinero del API: sin decimales si es entero)', () => {
    expect(textoMontosNomina({ n: 7, mxn: 25757.8, usd: 0 })).toBe(
      '$25,757.80 MXN',
    );
    expect(textoMontosNomina({ n: 2, mxn: 2000, usd: 100 })).toBe(
      '$2,000 MXN y $100 USD',
    );
    expect(textoMontosNomina({ n: 1, mxn: 0, usd: 99.5 })).toBe('$99.50 USD');
  });

  it('aviso del Balance general (solo con pagos)', () => {
    expect(
      pendienteBalanceNominaSinRepartir(resumenNominaSinRepartir(SEPTIEMBRE)),
    ).toBe(
      'Nómina sin repartir: 7 pagos por $25,757.80 MXN — no entra a ningún balance hasta repartirla entre aviones (módulo Nómina).',
    );
    expect(pendienteBalanceNominaSinRepartir({ n: 1, mxn: 1500, usd: 0 })).toBe(
      'Nómina sin repartir: 1 pago por $1,500 MXN — no entra a ningún balance hasta repartirla entre aviones (módulo Nómina).',
    );
    expect(
      pendienteBalanceNominaSinRepartir({ n: 0, mxn: 0, usd: 0 }),
    ).toBeNull();
  });

  it('detalle del pre-cierre: plural, singular, 0 y lectura caída', () => {
    expect(CLAVE_PRECIERRE_NOMINA_SIN_REPARTIR).toBe('nomina_sin_repartir');
    expect(TITULO_PRECIERRE_NOMINA_SIN_REPARTIR).toBe(
      'Nómina sin repartir entre aviones',
    );
    expect(
      detallePrecierreNominaSinRepartir(resumenNominaSinRepartir(SEPTIEMBRE)),
    ).toBe(
      '7 pagos de nómina por $25,757.80 MXN no se han repartido entre aviones: no entran a ningún balance ni al reparto. Repártelos en Nómina.',
    );
    expect(detallePrecierreNominaSinRepartir({ n: 1, mxn: 0, usd: 100 })).toBe(
      '1 pago de nómina por $100 USD no se ha repartido entre aviones: no entra a ningún balance ni al reparto. Repártelo en Nómina.',
    );
    expect(detallePrecierreNominaSinRepartir({ n: 0, mxn: 0, usd: 0 })).toBe(
      'Toda la nómina del periodo está repartida.',
    );
    expect(detallePrecierreNominaSinRepartir(null)).toBe(
      'No se pudo verificar la nómina del periodo.',
    );
  });
});
