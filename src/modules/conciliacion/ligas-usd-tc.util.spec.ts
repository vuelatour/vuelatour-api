import { evaluarTcCruce, tcCruceUsdPublico } from './auto-cruce.util';
import {
  descripcionGastoUsd,
  ordenarLigasUsdTc,
  textoLigaUsdTc,
  type LigaUsdTcFueraDeLugar,
} from './ligas-usd-tc.util';

/**
 * Línea del aviso de ligas USD ↔ MXN fuera de lugar (13-oct-2026, invariante
 * 70). Fixture: el estado de prod ANTES de la corrección del 13-oct 21:40.
 */
const TUBO =
  'Aircraft Spruce & Specialty Co. · Michelin Tube 7.00-6/8.00-6 Straight Valve Stem (x2)';
const BUJIAS =
  '1 Caja bujías Tempest Seneca, 1 filtro de aceite Champion 108, 1 llanta Goodyear 6.00-6';
const NOTA_516 =
  'Champion Spark Plug RHB32E (bujías) · Proveedor: Aircraft Spruce & Specialty Co.';

function liga(
  args: Partial<Omit<LigaUsdTcFueraDeLugar, 'texto' | 'tc_cruce'>> & {
    mxn: number;
    usd: number;
    oficial: number;
    fecha_oficial: string;
  },
): Omit<LigaUsdTcFueraDeLugar, 'texto'> {
  const { mxn, usd, oficial, fecha_oficial, ...resto } = args;
  const ev = evaluarTcCruce(mxn, usd, {
    tc: oficial,
    fecha_dato: fecha_oficial,
    fuente: 'open.er-api',
  })!;
  return {
    gasto_id: 'g',
    fecha_gasto: null,
    monto_usd: usd,
    tc_gasto: null,
    categoria: 'REFACCION',
    descripcion_gasto: 'gasto en USD',
    vuelo_id: null,
    vuelo_folio: null,
    movimiento_id: 'm',
    fecha_cargo: null,
    monto_cargo: mxn,
    cuenta_bancaria_id: 'cta',
    cuenta: 'COMBUSTIBLE',
    descripcion_cargo: null,
    tc_cruce: tcCruceUsdPublico(ev),
    ...resto,
  };
}

describe('descripcionGastoUsd — 1.ª línea de la nota, recortada a 59 + «…»', () => {
  it('las 3 notas reales', () => {
    expect(descripcionGastoUsd({ notas: TUBO })).toBe(
      'Aircraft Spruce & Specialty Co. · Michelin Tube 7.00-6/8.00…',
    );
    expect(descripcionGastoUsd({ notas: BUJIAS })).toBe(
      '1 Caja bujías Tempest Seneca, 1 filtro de aceite Champion 1…',
    );
    expect(descripcionGastoUsd({ notas: NOTA_516 })).toBe(
      'Champion Spark Plug RHB32E (bujías) · Proveedor: Aircraft S…',
    );
  });

  it('respaldo: nota → lugar → proveedor → «gasto en USD»; corta solo con más de 60', () => {
    expect(descripcionGastoUsd({ notas: 'Garmin\nsegunda línea' })).toBe(
      'Garmin',
    );
    expect(descripcionGastoUsd({ notas: '', lugar: 'Wichita' })).toBe(
      'Wichita',
    );
    expect(
      descripcionGastoUsd({ notas: null, lugar: ' ', proveedor: 'Garmin' }),
    ).toBe('Garmin');
    expect(descripcionGastoUsd({})).toBe('gasto en USD');
    const sesenta = 'x'.repeat(60);
    expect(descripcionGastoUsd({ notas: sesenta })).toBe(sesenta);
    expect(descripcionGastoUsd({ notas: `${sesenta}y` })).toBe(
      `${'x'.repeat(59)}…`,
    );
  });
});

describe('textoLigaUsdTc — los 2 casos reales (antes de la corrección)', () => {
  it('tubo ↔ «ASA CANCUN» $8,939.38 (+24.3 %)', () => {
    expect(
      textoLigaUsdTc(
        liga({
          mxn: 8939.38,
          usd: 422.86,
          oficial: 17.0077,
          fecha_oficial: '2026-09-01',
          fecha_gasto: '2026-09-01',
          fecha_cargo: '2026-09-01',
          descripcion_gasto: descripcionGastoUsd({ notas: TUBO }),
          descripcion_cargo: 'ASA CANCUN',
        }),
      ),
    ).toBe(
      '$422.86 USD · Aircraft Spruce & Specialty Co. · Michelin Tube 7.00-6/8.00… (01 sep) ↔ cargo «ASA CANCUN» de $8,939.38 del 01 sep (COMBUSTIBLE): T.C. 21.14 · oficial 17.01 (+24.3 %): lejos del oficial',
    );
  });

  it('bujías ↔ «ASA CANCUN I\\CARR CANC» $14,197.17 (+2.3 %)', () => {
    expect(
      textoLigaUsdTc(
        liga({
          mxn: 14197.17,
          usd: 794.61,
          oficial: 17.4691,
          fecha_oficial: '2026-09-24',
          fecha_gasto: '2026-09-24',
          fecha_cargo: '2026-09-24',
          descripcion_gasto: descripcionGastoUsd({ notas: BUJIAS }),
          descripcion_cargo: 'ASA CANCUN I\\CARR CANC',
        }),
      ),
    ).toBe(
      '$794.61 USD · 1 Caja bujías Tempest Seneca, 1 filtro de aceite Champion 1… (24 sep) ↔ cargo «ASA CANCUN I\\CARR CANC» de $14,197.17 del 24 sep (COMBUSTIBLE): T.C. 17.87 · oficial 17.47 (+2.3 %): lejos del oficial',
    );
  });
});

describe('ordenarLigasUsdTc', () => {
  it('fecha del cargo, fecha del gasto e id del gasto', () => {
    const base = { fecha_cargo: '2026-09-24', fecha_gasto: '2026-09-24' };
    const r = ordenarLigasUsdTc([
      { ...base, gasto_id: 'b' },
      { fecha_cargo: '2026-09-01', fecha_gasto: '2026-09-01', gasto_id: 'z' },
      { ...base, gasto_id: 'a' },
      { fecha_cargo: '2026-09-24', fecha_gasto: '2026-09-20', gasto_id: 'c' },
    ]);
    expect(r.map((l) => l.gasto_id)).toEqual(['z', 'c', 'a', 'b']);
  });
});
