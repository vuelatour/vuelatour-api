import { bloqueAfacOtrosMovimientos } from './afac-otros-movimientos.util';

type Libro = Parameters<typeof bloqueAfacOtrosMovimientos>[0][number];

function libro(
  matricula: string,
  tarifa: number | null,
  afacFilas: (number | null)[],
  permisos: Array<{
    fecha: string | null;
    detalle: string;
    monto_mxn: number | null;
  }> = [],
): Libro {
  return {
    matricula,
    permiso_afac_usd_hr: tarifa,
    vuelos: afacFilas.map((x) => ({
      permiso_afac_mxn: x,
    })) as unknown as Libro['vuelos'],
    totales: {
      permiso_afac_mxn: afacFilas.reduce<number>((a, x) => a + (x ?? 0), 0),
    } as unknown as Libro['totales'],
    permisos: {
      filas: permisos,
      total_mxn: permisos.reduce((a, f) => a + (f.monto_mxn ?? 0), 0),
      usd: null,
      usd_hr: null,
    } as unknown as Libro['permisos'],
  };
}

describe('bloqueAfacOtrosMovimientos (invariante 53)', () => {
  it('sin provisión ni permisos pagados NO viaja (payload byte-idéntico)', () => {
    expect(
      bloqueAfacOtrosMovimientos([libro('XB-DOS', null, [null, null])]),
    ).toBeUndefined();
    expect(bloqueAfacOtrosMovimientos([])).toBeUndefined();
  });

  it('provisión por avión (Σ de PERMISO AFAC de sus filas), permisos pagados y remanente', () => {
    const bloque = bloqueAfacOtrosMovimientos([
      libro(
        'XA-TST',
        25,
        [1082.5, 866, null, 1516.5],
        [{ fecha: '2026-09-05', detalle: 'AFAC anual', monto_mxn: 2500 }],
      ),
      libro('XB-DOS', null, [null]),
      libro('EXTERNOS', null, []),
    ]);
    expect(bloque).toEqual({
      provision: [
        { matricula: 'XA-TST', tarifa_usd_hr: 25, vuelos: 3, monto_mxn: 3465 },
      ],
      provision_total_mxn: 3465,
      pagados: [
        {
          matricula: 'XA-TST',
          fecha: '2026-09-05',
          detalle: 'AFAC anual',
          monto_mxn: 2500,
        },
      ],
      pagados_total_mxn: 2500,
      remanente_mxn: 965,
    });
  });

  it('un avión con permisos pagados pero sin provisión también sale (negativo = se pagó más)', () => {
    const bloque = bloqueAfacOtrosMovimientos([
      libro(
        'XB-DOS',
        null,
        [null],
        [{ fecha: null, detalle: 'Permiso', monto_mxn: 1200.004 }],
      ),
    ]);
    expect(bloque?.provision).toEqual([]);
    expect(bloque?.pagados_total_mxn).toBe(1200);
    expect(bloque?.remanente_mxn).toBe(-1200);
  });

  it('suma en centavos sin arrastrar flotantes', () => {
    const bloque = bloqueAfacOtrosMovimientos([
      libro('A', 10, [0.1, 0.2]),
      libro('B', 10, [0.3]),
    ]);
    expect(bloque?.provision_total_mxn).toBe(0.6);
    expect(bloque?.remanente_mxn).toBe(0.6);
  });
});
