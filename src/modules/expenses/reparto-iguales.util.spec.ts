import {
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import {
  CODIGO_REPARTO_IGUALES,
  MENSAJE_ERROR_REPARTO_IGUALES,
  centavosDe,
  compararAvionesPorMatricula,
  compararPagosPorFecha,
  errorRepartoDeExcepcion,
  mensajeCategoriaNoRepartible,
  mensajeMontoMuyChico,
  planRepartoIguales,
  repartirIgualesCents,
  totalesRepartoIguales,
} from './reparto-iguales.util';
import { NOMINA_OCTUBRE_2026 } from './reparto-iguales.fixture-spec';

/**
 * NÓMINA: reparto en PARTES IGUALES (16-oct-2026, API 0.0.90, invariante
 * 91). Aritmética en centavos enteros: Σ exacta, rotación justa del residuo
 * a lo largo del lote (por moneda), bordes. Montos REALES de la nómina de
 * octubre 2026 (`reparto-iguales.fixture-spec.ts`).
 */
const suma = (xs: ReadonlyArray<number>) => xs.reduce((a, x) => a + x, 0);

describe('repartirIgualesCents — partes iguales en centavos', () => {
  it('Σ partes == total EXACTO; base = floor(T/n) y el residuo a partir del cursor', () => {
    expect(repartirIgualesCents(10000, 3)).toEqual({
      cents: [3334, 3333, 3333],
      cursor: 1,
    });
    expect(repartirIgualesCents(10000, 3, 1)).toEqual({
      cents: [3333, 3334, 3333],
      cursor: 2,
    });
    expect(repartirIgualesCents(10000, 3, 2)).toEqual({
      cents: [3333, 3333, 3334],
      cursor: 0,
    });
    // Residuo 2 desde el cursor 2 de 3: índices 2 y 0 (da la vuelta).
    expect(repartirIgualesCents(566386, 4, 3)).toEqual({
      cents: [141597, 141596, 141596, 141597],
      cursor: 1,
    });
    for (const [t, n] of [
      [566386, 4],
      [1, 7],
      [999, 5],
      [2750000, 6],
      [12345678, 7],
    ]) {
      expect(suma(repartirIgualesCents(t, n).cents)).toBe(t);
    }
  });

  it('sin residuo el cursor no se mueve', () => {
    expect(repartirIgualesCents(2750000, 4, 3)).toEqual({
      cents: [687500, 687500, 687500, 687500],
      cursor: 3,
    });
  });

  it('n = 1 ⇒ todo al único avión; cursor 0', () => {
    expect(repartirIgualesCents(191060, 1, 5)).toEqual({
      cents: [191060],
      cursor: 0,
    });
  });

  it('T < n ⇒ alguna parte en 0 (quien llama lo rechaza: MONTO_MUY_CHICO); T = 0 ⇒ puros ceros', () => {
    const r = repartirIgualesCents(3, 4);
    expect(r.cents).toEqual([1, 1, 1, 0]);
    expect(r.cents.some((c) => c === 0)).toBe(true);
    expect(repartirIgualesCents(0, 3).cents).toEqual([0, 0, 0]);
  });

  it('cursor raro (negativo, mayor que n o no entero) se normaliza', () => {
    expect(repartirIgualesCents(5, 3, -1).cents).toEqual([2, 1, 2]);
    expect(repartirIgualesCents(5, 3, 7).cents).toEqual([1, 2, 2]);
    expect(repartirIgualesCents(5, 3, 1.5).cents).toEqual([2, 2, 1]);
  });

  it('entradas inválidas ⇒ RangeError (n < 1, n no entero, T negativo o con decimales)', () => {
    expect(() => repartirIgualesCents(100, 0)).toThrow(RangeError);
    expect(() => repartirIgualesCents(100, 2.5)).toThrow(RangeError);
    expect(() => repartirIgualesCents(-1, 2)).toThrow(RangeError);
    expect(() => repartirIgualesCents(10.5, 2)).toThrow(RangeError);
  });
});

describe('planRepartoIguales — rotación JUSTA a lo largo del lote', () => {
  it('nómina REAL de octubre 2026 entre 4 aviones: Σ = $109,921.46 y por avión difiere ≤ 1 ¢', () => {
    const pagos = [...NOMINA_OCTUBRE_2026]
      .sort((a, b) => compararPagosPorFecha(a, b))
      .map((g) => ({
        id: g.id,
        moneda: 'MXN',
        totalCents: centavosDe(g.monto)!,
      }));
    const plan = planRepartoIguales(pagos, 4);
    const porAvion = [0, 0, 0, 0];
    for (const p of pagos) {
      const c = plan.get(p.id)!;
      expect(suma(c)).toBe(p.totalCents);
      c.forEach((x, i) => (porAvion[i] += x));
    }
    expect(suma(porAvion)).toBe(10992146);
    expect(Math.max(...porAvion) - Math.min(...porAvion)).toBeLessThanOrEqual(
      1,
    );
    // 10,992,146 ¢ / 4 = 2,748,036.5 ⇒ dos aviones con $27,480.37 y dos con
    // $27,480.36.
    expect([...porAvion].sort()).toEqual([2748036, 2748036, 2748037, 2748037]);
  });

  it('cualquier lote y n: por avión difiere ≤ 1 ¢ (residuos siempre distintos de 0)', () => {
    for (const n of [2, 3, 4, 5, 6, 7]) {
      const pagos = Array.from({ length: 23 }, (_, i) => ({
        id: `g-${i}`,
        moneda: 'MXN',
        totalCents: 100 * (i + 1) * 7 + (i % n) + 1,
      }));
      const plan = planRepartoIguales(pagos, n);
      const porAvion = new Array<number>(n).fill(0);
      for (const p of pagos) {
        plan.get(p.id)!.forEach((x, i) => (porAvion[i] += x));
      }
      expect(suma(porAvion)).toBe(suma(pagos.map((p) => p.totalCents)));
      expect(Math.max(...porAvion) - Math.min(...porAvion)).toBeLessThanOrEqual(
        1,
      );
    }
  });

  it('el cursor es POR MONEDA: un pago en dólares no mueve el residuo de los pesos', () => {
    const plan = planRepartoIguales(
      [
        { id: 'mxn-1', moneda: 'MXN', totalCents: 100 }, // residuo 1 → índice 0
        { id: 'usd-1', moneda: 'USD', totalCents: 100 }, // su propio cursor → índice 0
        { id: 'mxn-2', moneda: 'MXN', totalCents: 100 }, // índice 1
      ],
      3,
    );
    expect(plan.get('mxn-1')).toEqual([34, 33, 33]);
    expect(plan.get('usd-1')).toEqual([34, 33, 33]);
    expect(plan.get('mxn-2')).toEqual([33, 34, 33]);
  });
});

describe('orden determinista', () => {
  it('aviones por matrícula ascendente (desempate por id); pagos por fecha y luego id', () => {
    const aviones = [
      { id: 'b', matricula: 'XA-VGV' },
      { id: 'a', matricula: 'N4142R' },
      { id: 'c', matricula: 'N621TX' },
      { id: 'z', matricula: null },
    ].sort(compararAvionesPorMatricula);
    expect(aviones.map((a) => a.matricula)).toEqual([
      null,
      'N4142R',
      'N621TX',
      'XA-VGV',
    ]);
    const pagos = [
      { id: 'g-2', fecha_gasto: '2026-10-15' },
      { id: 'g-1', fecha_gasto: '2026-10-15' },
      { id: 'g-0', fecha_gasto: '2026-10-07' },
    ].sort(compararPagosPorFecha);
    expect(pagos.map((p) => p.id)).toEqual(['g-0', 'g-1', 'g-2']);
  });
});

describe('totalesRepartoIguales — por moneda, jamás mezcladas', () => {
  const aviones = [
    { id: 'a1', matricula: 'N4142R' },
    { id: 'a2', matricula: 'XA-VGV' },
  ];

  it('Σ por moneda y por avión (MXN antes que USD); quitar ⇒ por_avion vacío', () => {
    expect(
      totalesRepartoIguales(
        [
          { moneda: 'USD', totalCents: 1001, partesCents: [501, 500] },
          { moneda: 'MXN', totalCents: 300000, partesCents: [150000, 150000] },
          { moneda: 'MXN', totalCents: 1, partesCents: [0, 1] },
        ],
        aviones,
      ),
    ).toEqual([
      {
        moneda: 'MXN',
        monto: 3000.01,
        gastos_n: 2,
        por_avion: [
          { aeronave_id: 'a1', matricula: 'N4142R', monto: 1500 },
          { aeronave_id: 'a2', matricula: 'XA-VGV', monto: 1500.01 },
        ],
      },
      {
        moneda: 'USD',
        monto: 10.01,
        gastos_n: 1,
        por_avion: [
          { aeronave_id: 'a1', matricula: 'N4142R', monto: 5.01 },
          { aeronave_id: 'a2', matricula: 'XA-VGV', monto: 5 },
        ],
      },
    ]);
    expect(
      totalesRepartoIguales(
        [{ moneda: 'MXN', totalCents: 500, partesCents: [] }],
        [],
      ),
    ).toEqual([{ moneda: 'MXN', monto: 5, gastos_n: 1, por_avion: [] }]);
    expect(totalesRepartoIguales([], aviones)).toEqual([]);
  });
});

describe('errores por pago — códigos y textos es-MX', () => {
  it('HttpException con `error` ⇒ ese código y su mensaje (MES_CERRADO tal cual)', () => {
    const e = errorRepartoDeExcepcion(
      new ConflictException({
        message:
          'Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
        error: 'MES_CERRADO',
      }),
    );
    expect(e).toEqual({
      code: 'MES_CERRADO',
      message:
        'Septiembre 2026 ya está cerrado (Ale, 16-oct). Reábrelo en Reportes para corregir.',
      esHttp: true,
    });
  });

  it('BadRequestException de texto ⇒ BAD_REQUEST (como el AllExceptionsFilter); texto crudo y arreglo', () => {
    expect(
      errorRepartoDeExcepcion(
        new BadRequestException('Hay un avión repetido.'),
      ),
    ).toEqual({
      code: 'BAD_REQUEST',
      message: 'Hay un avión repetido.',
      esHttp: true,
    });
    expect(
      errorRepartoDeExcepcion(new HttpException('Sin permiso', 403)),
    ).toEqual({ code: 'HTTPEXCEPTION', message: 'Sin permiso', esHttp: true });
    expect(
      errorRepartoDeExcepcion(
        new BadRequestException({ message: ['uno', 'dos'], error: 'X Y' }),
      ),
    ).toEqual({ code: 'X_Y', message: 'uno; dos', esHttp: true });
  });

  it('cualquier otra cosa ⇒ ERROR con texto genérico (lo técnico va al log)', () => {
    expect(errorRepartoDeExcepcion(new Error('fetch failed'))).toEqual({
      code: CODIGO_REPARTO_IGUALES.ERROR,
      message: MENSAJE_ERROR_REPARTO_IGUALES,
      esHttp: false,
    });
    expect(errorRepartoDeExcepcion('raro').code).toBe('ERROR');
  });

  it('textos de categoría y monto', () => {
    expect(mensajeCategoriaNoRepartible('COMIDA')).toBe(
      '«Comida» no se reparte entre aviones: solo los gastos generales (Gasto fijo, Gastos indirectos de avión, Nómina, Gasolina (vehículos), Visita, Otros gastos VuelaTour).',
    );
    expect(mensajeMontoMuyChico(3, 'MXN', 4)).toBe(
      '$0.03 MXN no alcanza para repartir entre 4 aviones: cada avión necesita al menos un centavo.',
    );
  });

  it('centavosDe: number o numeric en texto; ilegible ⇒ null', () => {
    expect(centavosDe('5663.86')).toBe(566386);
    expect(centavosDe(1910.6)).toBe(191060);
    expect(centavosDe(null)).toBeNull();
    expect(centavosDe('')).toBeNull();
    expect(centavosDe('abc')).toBeNull();
  });
});
