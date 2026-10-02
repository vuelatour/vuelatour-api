import type { UtilidadMesSocios } from './reparto-cuenta.util';
import {
  UTILIDADES_CONCURRENCIA,
  UTILIDADES_TTL_MS,
  UtilidadesMensualesSocios,
} from './reparto-utilidades.memo';

/**
 * Memo de las utilidades por MES (cuenta corriente del socio, v2): meses
 * cerrados 10 min, el mes en curso NUNCA, ≤ 3 computes a la vez, los
 * fallos no se memoizan y el orden de salida es el de entrada.
 */
function utilidad(mes: string, enCurso: boolean): UtilidadMesSocios {
  return { mes, en_curso: enCurso, aviones: [] };
}

describe('UtilidadesMensualesSocios', () => {
  it('meses cerrados se memoizan 10 min; el mes en curso se recalcula SIEMPRE', async () => {
    let ahora = 0;
    const calcular = jest.fn((mes: string, enCurso: boolean) =>
      Promise.resolve(utilidad(mes, enCurso)),
    );
    const memo = new UtilidadesMensualesSocios(calcular, {
      ahoraMs: () => ahora,
    });
    const r1 = await memo.deMeses(['2026-09', '2026-10'], '2026-10');
    expect(r1.map((u) => [u.mes, u.en_curso])).toEqual([
      ['2026-09', false],
      ['2026-10', true],
    ]);
    await memo.deMeses(['2026-09', '2026-10'], '2026-10');
    // Septiembre una vez; octubre (en curso) dos.
    expect(calcular.mock.calls.map((c) => c[0])).toEqual([
      '2026-09',
      '2026-10',
      '2026-10',
    ]);
    ahora = UTILIDADES_TTL_MS + 1;
    await memo.deMeses(['2026-09'], '2026-10');
    expect(calcular).toHaveBeenCalledTimes(4);
    expect(UTILIDADES_TTL_MS).toBe(10 * 60_000);
  });

  it('fresco (escrituras): recalcula los meses cerrados aunque estén memoizados y RENUEVA la memoria', async () => {
    let version = 0;
    const calcular = jest.fn((mes: string, enCurso: boolean) => {
      version += 1;
      return Promise.resolve({
        ...utilidad(mes, enCurso),
        aviones: [
          {
            aeronave: { id: 'n4142r', matricula: 'N4142R' },
            reparto_porcentaje_total: 100,
            socios: [{ socio_id: 'm', porcentaje: 69, monto_usd: version }],
          },
        ],
      });
    });
    const memo = new UtilidadesMensualesSocios(calcular, { ahoraMs: () => 0 });
    const leida = await memo.deMeses(['2026-09'], '2026-10');
    expect(leida[0].aviones[0].socios[0].monto_usd).toBe(1);
    // Un cobro tardío de septiembre: la lectura memoizada no lo ve…
    const vieja = await memo.deMeses(['2026-09'], '2026-10');
    expect(vieja[0].aviones[0].socios[0].monto_usd).toBe(1);
    // …la escritura (candado del adelanto) sí, y deja la memoria al día.
    const fresca = await memo.deMeses(['2026-09'], '2026-10', {
      fresco: true,
    });
    expect(fresca[0].aviones[0].socios[0].monto_usd).toBe(2);
    const despues = await memo.deMeses(['2026-09'], '2026-10');
    expect(despues[0].aviones[0].socios[0].monto_usd).toBe(2);
    expect(calcular).toHaveBeenCalledTimes(2);
  });

  it('a lo más 3 computes a la vez y el orden de salida es el de entrada', async () => {
    let activos = 0;
    let pico = 0;
    const calcular = jest.fn(async (mes: string, enCurso: boolean) => {
      activos += 1;
      pico = Math.max(pico, activos);
      await new Promise((r) => setTimeout(r, 5));
      activos -= 1;
      return utilidad(mes, enCurso);
    });
    const memo = new UtilidadesMensualesSocios(calcular);
    const meses = [
      '2026-03',
      '2026-04',
      '2026-05',
      '2026-06',
      '2026-07',
      '2026-08',
      '2026-09',
      '2026-10',
    ];
    const r = await memo.deMeses(meses, '2026-10');
    expect(r.map((u) => u.mes)).toEqual(meses);
    expect(pico).toBe(UTILIDADES_CONCURRENCIA);
    expect(UTILIDADES_CONCURRENCIA).toBe(3);
  });

  it('un fallo NO se memoiza y sube (nunca un número parcial)', async () => {
    let falla = true;
    const calcular = jest.fn((mes: string, enCurso: boolean) =>
      falla
        ? Promise.reject(new Error('timeout'))
        : Promise.resolve(utilidad(mes, enCurso)),
    );
    const memo = new UtilidadesMensualesSocios(calcular);
    await expect(memo.deMeses(['2026-09'], '2026-10')).rejects.toThrow(
      'timeout',
    );
    falla = false;
    await expect(memo.deMeses(['2026-09'], '2026-10')).resolves.toHaveLength(1);
    expect(calcular).toHaveBeenCalledTimes(2);
  });

  it('un mes futuro o inválido es un error de programación', async () => {
    const memo = new UtilidadesMensualesSocios(() =>
      Promise.resolve(utilidad('x', false)),
    );
    await expect(memo.deMeses(['2026-11'], '2026-10')).rejects.toThrow();
    await expect(memo.deMeses(['2026-9'], '2026-10')).rejects.toThrow();
    await expect(memo.deMeses([], '2026-10')).resolves.toEqual([]);
  });
});
