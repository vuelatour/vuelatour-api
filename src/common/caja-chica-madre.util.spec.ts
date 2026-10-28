import {
  historialConSaldo,
  type EntradaConSaldo,
  type EntradaTramoLike,
} from './caja-chica-saldo.util';
import {
  gastosPendientesDe,
  montoFondoDe,
  resumenCajaMadre,
  type HijaResumen,
} from './caja-chica-madre.util';

/**
 * FONDO CONSOLIDADO de la caja madre (27-oct-2026). Caso real: la caja de
 * Mary Cruz (fondo fijo de $40,000) fondea seis cajas (Σ asignado $22,500).
 * El 27-oct su libro tenía, desde la reposición del 13-oct: 11 gastos propios
 * por $7,127.50 y dos entregas (Gregorio $5,000 el 15-oct, Alexander $1,100 el
 * 19-oct). Aquí se congela la aritmética; los libros de las hijas entran ya
 * resueltos (saldo, por reponer, pendientes), como los carga `cajasFondeadas`.
 */

type E = EntradaTramoLike;

const g = (id: string, fecha: string, monto: number, hora = '12'): E => ({
  id,
  tipo: 'GASTO',
  origen: 'gasto',
  fecha,
  monto: -monto,
  created_at: `${fecha}T${hora}:00:00+00:00`,
});
const mov = (
  id: string,
  tipo: 'REPOSICION' | 'REINTEGRO' | 'AJUSTE',
  fecha: string,
  efecto: number,
  hora = '15',
): E => ({
  id,
  tipo,
  origen: 'caja',
  fecha,
  monto: efecto,
  created_at: `${fecha}T${hora}:00:00+00:00`,
});

/** Los espejos (entregas a colaboradores) del libro de Mary. */
const ESPEJOS = new Set(['e-greg', 'e-alex']);
const esEspejo = (id: string) => ESPEJOS.has(id);

const LIBRO_MARY: E[] = [
  mov('ini', 'REPOSICION', '2026-10-01', 20000),
  g('g-oct5', '2026-10-05', 3000),
  // La reposición del 13-oct se registró el 14-oct a las 15:25; los dos
  // gastos del 13-oct se capturaron DESPUÉS (orden de captura).
  mov('r-13', 'REPOSICION', '2026-10-13', 11528, '15'),
  g('g-telcel', '2026-10-13', 1434, '16'),
  g('g-taxi', '2026-10-13', 100, '17'),
  g('g-cfe', '2026-10-14', 2763),
  mov('e-greg', 'REINTEGRO', '2026-10-15', -5000),
  g('g-16', '2026-10-16', 220),
  g('g-18', '2026-10-18', 500),
  mov('e-alex', 'REINTEGRO', '2026-10-19', -1100),
  g('g-20a', '2026-10-20', 622),
  g('g-20b', '2026-10-20', 223.5),
  g('g-22', '2026-10-22', 80),
  g('g-23a', '2026-10-23', 500),
  g('g-23b', '2026-10-23', 65),
  g('g-26', '2026-10-26', 620),
];

const HIJAS: HijaResumen[] = [
  {
    monto_fondo: 4000,
    saldo_libro: 4000,
    por_reponer: 0,
    gastos_pendientes: { n: 0, total: 0 },
  },
  {
    monto_fondo: 5000,
    saldo_libro: 1800.09,
    por_reponer: 3199.91,
    gastos_pendientes: { n: 4, total: 3199.91 },
  },
  {
    monto_fondo: 1000,
    saldo_libro: 925,
    por_reponer: 75,
    gastos_pendientes: { n: 1, total: 75 },
  },
  {
    monto_fondo: 1500,
    saldo_libro: 1512.01,
    por_reponer: 0,
    gastos_pendientes: { n: 0, total: 0 },
  },
  {
    monto_fondo: 8000,
    saldo_libro: 8000,
    por_reponer: 0,
    gastos_pendientes: { n: 0, total: 0 },
  },
  {
    monto_fondo: 3000,
    saldo_libro: 2050,
    por_reponer: 950,
    gastos_pendientes: { n: 3, total: 950 },
  },
];

const historial = (libro: E[]): EntradaConSaldo<E>[] =>
  historialConSaldo(libro, { esAcumulada: false, montoFondo: 40000 });

describe('resumenCajaMadre — la caja de Mary (27-oct-2026)', () => {
  const r = resumenCajaMadre({
    montoFondo: '40000.00',
    historial: historial(LIBRO_MARY),
    esEspejo,
    hijas: HIJAS,
  });

  it('fondo total, lo asignado a los colaboradores y lo que debe estar en la caja madre', () => {
    expect(r.fondo_total).toBe(40000);
    expect(r.cajas).toBe(6);
    expect(r.asignado_colaboradores).toBe(22500);
    expect(r.fondo_propio).toBe(17500);
  });

  it('lo de los colaboradores se SUMA de sus libros (efectivo que conservan, por reponer, gastos pendientes)', () => {
    expect(r.efectivo_colaboradores).toBe(18287.1);
    expect(r.pendiente_colaboradores).toBe(4224.91);
    expect(r.gastos_pendientes_colaboradores).toEqual({ n: 8, total: 4224.91 });
  });

  it('el tramo pendiente de la madre: 11 gastos propios (los dos del 13-oct incluidos) y 2 entregas', () => {
    expect(r.gastos_pendientes).toEqual({ n: 11, total: 7127.5 });
    expect(r.entregas_pendientes).toEqual({ n: 2, total: 6100 });
    expect(r.otros_pendientes).toBe(0);
    // Lo que salió de la caja en el tramo: gastos + entregas.
    expect(r.salidas_pendientes).toBe(13227.5);
  });

  it('para solicitar a la empresa (regla de Mary, 28-oct-2026) = lo que debe estar en la caja − el saldo del libro', () => {
    // 17,500 − 15,300.5: lo que falta para volver a lo que debe tener.
    expect(r.por_solicitar).toBe(2199.5);
  });

  it('efectivo esperado vs el libro, y la diferencia', () => {
    // Libro: 20,000 − 3,000 + 11,528 − 1,534 − 2,763 − 5,000 − 720 − 1,100 − 2,110.5 = 15,300.5.
    expect(r.efectivo_libro).toBe(15300.5);
    expect(r.efectivo_esperado).toBe(4272.5); // 17,500 − 13,227.5
    expect(r.diferencia).toBe(11028); // el libro trae MÁS de lo esperado
  });
});

describe('resumenCajaMadre — casos de borde', () => {
  it('otros movimientos del tramo: un reintegro a mano SUBE lo que salió y un ajuste positivo lo BAJA; por solicitar = propio − libro', () => {
    const r = resumenCajaMadre({
      montoFondo: 10000,
      historial: historial([
        mov('ini', 'REPOSICION', '2026-10-01', 10000),
        g('g1', '2026-10-02', 300),
        mov('reint', 'REINTEGRO', '2026-10-03', -1000),
        mov('aj', 'AJUSTE', '2026-10-04', 50),
        mov('e1', 'REINTEGRO', '2026-10-05', -400),
      ]),
      esEspejo: (id) => id === 'e1',
      hijas: [],
    });
    expect(r.gastos_pendientes).toEqual({ n: 1, total: 300 });
    expect(r.entregas_pendientes).toEqual({ n: 1, total: 400 });
    expect(r.otros_pendientes).toBe(-950);
    expect(r.salidas_pendientes).toBe(1650); // 300 + 400 + 1,000 − 50
    expect(r.efectivo_libro).toBe(8350);
    expect(r.fondo_propio).toBe(10000);
    expect(r.efectivo_esperado).toBe(8350);
    expect(r.diferencia).toBe(0); // cuadra
    expect(r.por_solicitar).toBe(1650); // 10,000 − 8,350 (cuadra ⇒ coincide con lo que salió)
  });

  it('sin fondo total (acumulada o sin fijar): lo propio, lo esperado, lo por solicitar y la diferencia van en null; lo demás sí', () => {
    const r = resumenCajaMadre({
      montoFondo: null,
      historial: historial([
        mov('ini', 'REPOSICION', '2026-10-01', 500),
        g('g1', '2026-10-02', 120),
      ]),
      esEspejo: () => false,
      hijas: [
        {
          monto_fondo: null,
          saldo_libro: -80,
          por_reponer: 80,
          gastos_pendientes: { n: 1, total: 80 },
        },
      ],
    });
    expect(r.fondo_total).toBeNull();
    expect(r.fondo_propio).toBeNull();
    expect(r.efectivo_esperado).toBeNull();
    expect(r.diferencia).toBeNull();
    expect(r.asignado_colaboradores).toBe(0);
    expect(r.efectivo_colaboradores).toBe(-80);
    expect(r.salidas_pendientes).toBe(120);
    expect(r.por_solicitar).toBeNull();
    expect(r.efectivo_libro).toBe(380);
    expect(montoFondoDe('0')).toBeNull();
    expect(montoFondoDe('abc')).toBeNull();
    expect(montoFondoDe('40000.00')).toBe(40000);
  });

  it('sin hijas y libro vacío: todo en cero, sin inventar', () => {
    const r = resumenCajaMadre({
      montoFondo: 1000,
      historial: [],
      esEspejo: () => false,
      hijas: [],
    });
    expect(r).toEqual({
      fondo_total: 1000,
      cajas: 0,
      asignado_colaboradores: 0,
      fondo_propio: 1000,
      efectivo_colaboradores: 0,
      pendiente_colaboradores: 0,
      gastos_pendientes_colaboradores: { n: 0, total: 0 },
      gastos_pendientes: { n: 0, total: 0 },
      entregas_pendientes: { n: 0, total: 0 },
      otros_pendientes: 0,
      salidas_pendientes: 0,
      por_solicitar: 1000, // todo el fondo propio falta en la caja
      efectivo_libro: 0,
      efectivo_esperado: 1000,
      diferencia: -1000, // el fondo nunca se entregó: el libro trae 1,000 menos
    });
  });

  it('gastosPendientesDe: solo lo posterior a la última reposición; sin reposición, todo', () => {
    expect(gastosPendientesDe(historial(LIBRO_MARY))).toEqual({
      n: 11,
      total: 7127.5,
    });
    expect(
      gastosPendientesDe(
        historial([g('a', '2026-10-01', 10), g('b', '2026-10-02', 5.5)]),
      ),
    ).toEqual({
      n: 2,
      total: 15.5,
    });
    expect(gastosPendientesDe([])).toEqual({ n: 0, total: 0 });
  });
});
