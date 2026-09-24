import {
  historialConSaldo,
  tramoDeReposicion,
  type EntradaConSaldo,
  type EntradaTramoLike,
} from './caja-chica-saldo.util';

/**
 * QUÉ REPONE CADA REPOSICIÓN (24-sep-2026) — la base del Excel que pidió el
 * cliente («al momento de reembolsar la caja de cada uno … un Excel con la
 * información de lo que estoy reembolsando»). Se congela sobre un libro
 * SINTÉTICO con dos reposiciones, gastos en medio, un AJUSTE y un REINTEGRO:
 *  - qué gastos caen en cada reposición (entre la anterior y ella, en el
 *    orden del historial);
 *  - la regla del MISMO DÍA (un gasto fechado el día de la reposición entra
 *    en ella, aunque se haya capturado después — `compararEntradasCaja`);
 *  - que los saldos se LEEN del historial (no hay un cálculo paralelo);
 *  - el modo PENDIENTE (lo que se va a reponer hoy).
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

/**
 * Caja ACUMULADA (la del piloto): gasta de su bolsa y la oficina le repone.
 *   01-sep  g1 300          05-sep  R1 +500 (repone g1+g2)
 *   03-sep  g2 200          06-sep  g3 100
 *   05-sep  g4 50 ← mismo día que R1 pero capturado DESPUÉS: entra en R1
 *   07-sep  AJUSTE −20      08-sep  g5 400
 *   09-sep  REINTEGRO −30   10-sep  R2 +600
 *   11-sep  g6 70 (pendiente)
 */
const LIBRO: E[] = [
  g('g1', '2026-09-01', 300),
  g('g2', '2026-09-03', 200),
  mov('r1', 'REPOSICION', '2026-09-05', 500, '15'),
  g('g4', '2026-09-05', 50, '22'),
  g('g3', '2026-09-06', 100),
  mov('aj', 'AJUSTE', '2026-09-07', -20),
  g('g5', '2026-09-08', 400),
  mov('ri', 'REINTEGRO', '2026-09-09', -30),
  mov('r2', 'REPOSICION', '2026-09-10', 600),
  g('g6', '2026-09-11', 70),
];

const acumulada = () =>
  historialConSaldo([...LIBRO].reverse(), {
    esAcumulada: true,
    montoFondo: null,
  });

const ids = (xs: Array<EntradaConSaldo<E>>) => xs.map((e) => e.id);

describe('tramoDeReposicion — qué gastos repone cada reposición', () => {
  it('R1 repone g1, g2 y g4 (mismo día, capturado después): la regla del libro', () => {
    const t = tramoDeReposicion(acumulada(), 'r1')!;
    expect(ids(t.entradas)).toEqual(['g1', 'g2', 'g4']);
    expect(ids(t.gastos)).toEqual(['g1', 'g2', 'g4']);
    expect(t.otros).toEqual([]);
    expect(t.anterior).toBeNull();
    expect(t.total_gastos).toBe(550);
    expect(t.periodo_desde).toBe('2026-09-01');
    expect(t.periodo_hasta).toBe('2026-09-05');
  });

  it('R2 repone g3 y g5, con el AJUSTE y el REINTEGRO del periodo aparte', () => {
    const t = tramoDeReposicion(acumulada(), 'r2')!;
    expect(ids(t.entradas)).toEqual(['g3', 'aj', 'g5', 'ri']);
    expect(ids(t.gastos)).toEqual(['g3', 'g5']);
    expect(ids(t.otros)).toEqual(['aj', 'ri']);
    expect(t.anterior?.id).toBe('r1');
    expect(t.total_gastos).toBe(500);
    expect(t.total_otros).toBe(-50);
    expect(t.periodo_desde).toBe('2026-09-06');
    expect(t.periodo_hasta).toBe('2026-09-08');
  });

  it('los saldos se LEEN del historial (antes/después) y la diferencia sale de ahí', () => {
    const h = acumulada();
    const t1 = tramoDeReposicion(h, 'r1')!;
    // Libro: −300 −200 −50 = −550 → +500 = −50 (quedaron 50 por reponer).
    expect(t1.saldo_antes).toBe(-550);
    expect(t1.por_reponer_antes).toBe(550);
    expect(t1.monto_repuesto).toBe(500);
    expect(t1.saldo_despues).toBe(-50);
    expect(t1.por_reponer_despues).toBe(50);
    expect(t1.diferencia).toBe(-50); // quedó pendiente

    const t2 = tramoDeReposicion(h, 'r2')!;
    // −50 −100 −20 −400 −30 = −600 → +600 = 0.
    expect(t2.saldo_inicio).toBe(-50);
    expect(t2.por_reponer_inicio).toBe(50);
    expect(t2.saldo_antes).toBe(-600);
    expect(t2.por_reponer_antes).toBe(600);
    expect(t2.saldo_despues).toBe(0);
    expect(t2.diferencia).toBe(0); // cuadra: cubrió lo pendiente de R1

    // Mismas cifras que la fila del historial (nunca un cálculo paralelo).
    const filaR2 = h.find((e) => e.id === 'r2')!;
    expect(t2.saldo_despues).toBe(filaR2.saldo);
    expect(t2.por_reponer_despues).toBe(filaR2.por_reponer);
  });

  it('PENDIENTE (null): lo que hay desde la última reposición hasta hoy', () => {
    const t = tramoDeReposicion(acumulada(), null)!;
    expect(t.reposicion).toBeNull();
    expect(t.anterior?.id).toBe('r2');
    expect(ids(t.gastos)).toEqual(['g6']);
    expect(t.total_gastos).toBe(70);
    expect(t.saldo_antes).toBe(-70);
    expect(t.por_reponer_antes).toBe(70); // «POR REPONER HOY»
    expect(t.saldo_despues).toBeNull();
    expect(t.monto_repuesto).toBeNull();
    expect(t.diferencia).toBeNull();
  });

  it('una reposición se REPONE DE MÁS ⇒ diferencia positiva', () => {
    const h = historialConSaldo(
      [g('a', '2026-09-01', 100), mov('r', 'REPOSICION', '2026-09-02', 150)],
      { esAcumulada: true, montoFondo: null },
    );
    const t = tramoDeReposicion(h, 'r')!;
    expect(t.diferencia).toBe(50);
    expect(t.por_reponer_despues).toBe(0);
  });

  it('caja CLÁSICA con fondo nominal: el por reponer es fondo − saldo', () => {
    // Fondo 1,000: entrega inicial, gastos 300 + 200, reposición 500.
    const h = historialConSaldo(
      [
        mov('ent', 'REPOSICION', '2026-09-01', 1000),
        g('a', '2026-09-02', 300),
        g('b', '2026-09-03', 200),
        mov('r', 'REPOSICION', '2026-09-04', 500),
      ],
      { esAcumulada: false, montoFondo: 1000 },
    );
    const t = tramoDeReposicion(h, 'r')!;
    expect(ids(t.gastos)).toEqual(['a', 'b']);
    expect(t.saldo_antes).toBe(500);
    expect(t.por_reponer_antes).toBe(500);
    expect(t.saldo_despues).toBe(1000);
    expect(t.diferencia).toBe(0);
    // La primera (entrega del fondo) no tiene anterior ni gastos.
    const t0 = tramoDeReposicion(h, 'ent')!;
    expect(t0.anterior).toBeNull();
    expect(t0.entradas).toEqual([]);
  });

  it('dos reposiciones el MISMO día: la segunda no repone nada (orden de captura)', () => {
    const h = historialConSaldo(
      [
        g('a', '2026-09-10', 100),
        mov('r1', 'REPOSICION', '2026-09-10', 80, '15'),
        mov('r2', 'REPOSICION', '2026-09-10', 20, '16'),
      ],
      { esAcumulada: true, montoFondo: null },
    );
    expect(ids(tramoDeReposicion(h, 'r1')!.gastos)).toEqual(['a']);
    const t2 = tramoDeReposicion(h, 'r2')!;
    expect(t2.gastos).toEqual([]);
    expect(t2.por_reponer_antes).toBe(20);
    expect(t2.diferencia).toBe(0);
    expect(t2.periodo_desde).toBeNull();
  });

  it('un id que no es una REPOSICIÓN del libro ⇒ null', () => {
    const h = acumulada();
    expect(tramoDeReposicion(h, 'aj')).toBeNull();
    expect(tramoDeReposicion(h, 'g1')).toBeNull();
    expect(tramoDeReposicion(h, 'no-existe')).toBeNull();
  });

  it('libro vacío: pendiente en cero', () => {
    const t = tramoDeReposicion(
      historialConSaldo([] as E[], { esAcumulada: true, montoFondo: null }),
      null,
    )!;
    expect(t.entradas).toEqual([]);
    expect(t.total_gastos).toBe(0);
    expect(t.por_reponer_antes).toBe(0);
  });
});
