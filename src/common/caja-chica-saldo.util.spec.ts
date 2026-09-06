import {
  CONCEPTO_CAJA,
  compararEntradasCaja,
  efectoMovimientoCaja,
  historialConSaldo,
  lecturaFondo,
  porReponerCaja,
  round2,
  saldoCaja,
  type EntradaHistorialCaja,
} from './caja-chica-saldo.util';

/**
 * Fuente única del saldo de caja chica: la misma función alimenta el detalle
 * del panel, `/caja-chica/me` y el historial del piloto
 * (`/me/caja-chica/movimientos`). Aquí se fija la secuencia que pidió el
 * cliente (5-sep-2026): gasto, gasto, reposición → el acumulado POR REPONER
 * regresa a $0.00 y vuelve a subir después.
 */

let seq = 0;
function gasto(
  fecha: string,
  monto: number,
  created_at = `${fecha}T${String(10 + (seq++ % 10)).padStart(2, '0')}:00:00+00:00`,
): EntradaHistorialCaja {
  return { fecha, origen: 'gasto', monto: -monto, created_at };
}
function caja(
  fecha: string,
  monto: number,
  created_at = `${fecha}T${String(10 + (seq++ % 10)).padStart(2, '0')}:00:00+00:00`,
): EntradaHistorialCaja {
  return { fecha, origen: 'caja', monto, created_at };
}

const ACUMULADA = { esAcumulada: true, montoFondo: null };

describe('efectoMovimientoCaja / saldoCaja', () => {
  it('REPOSICION suma, REINTEGRO resta, AJUSTE conserva su signo (montos string incluidos)', () => {
    expect(efectoMovimientoCaja({ tipo: 'REPOSICION', monto: '100.50' })).toBe(
      100.5,
    );
    expect(efectoMovimientoCaja({ tipo: 'REINTEGRO', monto: 40 })).toBe(-40);
    expect(efectoMovimientoCaja({ tipo: 'AJUSTE', monto: -12.25 })).toBe(
      -12.25,
    );
    expect(efectoMovimientoCaja({ tipo: 'AJUSTE', monto: 5 })).toBe(5);
  });

  it('caja clásica: entregado − gastado; acumulada: el mismo número invertido', () => {
    const movs = [
      { tipo: 'REPOSICION', monto: 1000 },
      { tipo: 'REINTEGRO', monto: '200' },
      { tipo: 'AJUSTE', monto: -50 },
    ];
    const efectivo = [{ monto: '300' }];
    expect(saldoCaja(movs, efectivo)).toBe(450);
    expect(saldoCaja(movs, efectivo, true)).toBe(-450);
    expect(saldoCaja([], [], true)).toBe(0);
  });

  it('redondea a centavos (0.1 + 0.2 no deja basura binaria)', () => {
    expect(saldoCaja([], [{ monto: 0.1 }, { monto: 0.2 }])).toBe(-0.3);
    expect(round2(1.005)).toBe(1.01);
    expect(round2(-0.3)).toBe(-0.3);
  });
});

describe('historialConSaldo — caja ACUMULADA (la del piloto)', () => {
  it('gasto, gasto, reposición → por reponer regresa a 0 y vuelve a acumular', () => {
    const h = historialConSaldo(
      [
        gasto('2026-09-01', 100),
        gasto('2026-09-02', 250.5),
        caja('2026-09-05', 350.5),
        gasto('2026-09-06', 80),
      ],
      ACUMULADA,
    );
    expect(h.map((e) => e.saldo)).toEqual([-100, -350.5, 0, -80]);
    expect(h.map((e) => e.por_reponer)).toEqual([100, 350.5, 0, 80]);
  });

  it('reposición PARCIAL: queda lo que falta', () => {
    const h = historialConSaldo(
      [
        gasto('2026-09-01', 200),
        gasto('2026-09-02', 300),
        caja('2026-09-03', 300),
      ],
      ACUMULADA,
    );
    expect(h[2].saldo).toBe(-200);
    expect(h[2].por_reponer).toBe(200);
  });

  it('AJUSTE positivo salda como una reposición; negativo aumenta lo por reponer', () => {
    const h = historialConSaldo(
      [
        gasto('2026-09-01', 100),
        caja('2026-09-02', 100),
        caja('2026-09-03', -30),
      ],
      ACUMULADA,
    );
    expect(h.map((e) => e.saldo)).toEqual([-100, 0, -30]);
    expect(h.map((e) => e.por_reponer)).toEqual([100, 0, 30]);
  });

  it('reposición que SOBRA: por reponer 0 (nunca negativo), el saldo del libro sí queda positivo', () => {
    const h = historialConSaldo(
      [gasto('2026-09-01', 100), caja('2026-09-02', 150)],
      ACUMULADA,
    );
    expect(h[1].saldo).toBe(50);
    expect(h[1].por_reponer).toBe(0);
  });

  it('mismo día: el gasto va ANTES que la reposición aunque se haya capturado después (la reposición del día D salda los gastos de D)', () => {
    const h = historialConSaldo(
      [
        caja('2026-09-05', 300, '2026-09-05T13:00:00+00:00'),
        gasto('2026-09-05', 300, '2026-09-05T20:00:00+00:00'),
      ],
      ACUMULADA,
    );
    expect(h.map((e) => e.origen)).toEqual(['gasto', 'caja']);
    expect(h[1].saldo).toBe(0);
    expect(h[1].por_reponer).toBe(0);
  });

  it('orden: fecha asc y dentro del día created_at asc; no muta el arreglo de entrada', () => {
    const entrada = [
      caja('2026-09-03', 10, '2026-09-03T12:00:00+00:00'),
      gasto('2026-09-01', 5, '2026-09-01T23:00:00+00:00'),
      gasto('2026-09-01', 7, '2026-09-01T08:00:00+00:00'),
      caja('2026-09-03', 20, '2026-09-03T09:00:00+00:00'),
    ];
    const copia = [...entrada];
    const h = historialConSaldo(entrada, ACUMULADA);
    expect(entrada).toEqual(copia);
    expect(h.map((e) => e.monto)).toEqual([-7, -5, 20, 10]);
    expect(h.map((e) => e.saldo)).toEqual([-7, -12, 8, 18]);
    expect(compararEntradasCaja(entrada[0], entrada[0])).toBe(0);
  });

  it('libro vacío → []', () => {
    expect(historialConSaldo([], ACUMULADA)).toEqual([]);
  });
});

describe('historialConSaldo — caja CLÁSICA', () => {
  it('con monto nominal: por reponer = nominal − saldo una vez entregado el fondo; antes solo el sobregiro', () => {
    const h = historialConSaldo(
      [
        gasto('2026-08-01', 500),
        caja('2026-08-02', 6000),
        gasto('2026-08-03', 1000),
        caja('2026-08-10', 1500),
      ],
      { esAcumulada: false, montoFondo: '6000.00' },
    );
    expect(h.map((e) => e.saldo)).toEqual([-500, 5500, 4500, 6000]);
    // Antes de la primera entrega NO dice "6,500": solo lo que puso de su bolsa.
    expect(h.map((e) => e.por_reponer)).toEqual([500, 500, 1500, 0]);
  });

  it('sin nominal: solo el sobregiro cuenta como por reponer', () => {
    const h = historialConSaldo(
      [
        caja('2026-08-01', 1000),
        gasto('2026-08-02', 300),
        gasto('2026-08-03', 900),
      ],
      { esAcumulada: false, montoFondo: null },
    );
    expect(h.map((e) => e.saldo)).toEqual([1000, 700, -200]);
    expect(h.map((e) => e.por_reponer)).toEqual([0, 0, 200]);
  });
});

describe('porReponerCaja', () => {
  it('acumulada: −saldo, nunca negativo', () => {
    expect(porReponerCaja(-13341.12, 0, ACUMULADA)).toBe(13341.12);
    expect(porReponerCaja(0, 13341.12, ACUMULADA)).toBe(0);
    expect(porReponerCaja(25, 100, ACUMULADA)).toBe(0);
  });

  it('clásica con nominal y entregas: nominal − saldo (la card del panel)', () => {
    const opts = { esAcumulada: false, montoFondo: 6000 };
    expect(porReponerCaja(4500, 6000, opts)).toBe(1500);
    expect(porReponerCaja(6000, 6000, opts)).toBe(0);
    expect(porReponerCaja(6200, 6000, opts)).toBe(0);
  });

  it('clásica sin entregas (nominal que la oficina no capturó) o nominal inválido: solo el sobregiro', () => {
    expect(
      porReponerCaja(-1200, 0, { esAcumulada: false, montoFondo: 5000 }),
    ).toBe(1200);
    expect(
      porReponerCaja(-1200, 0, { esAcumulada: false, montoFondo: 'x' }),
    ).toBe(1200);
    expect(porReponerCaja(300, 0, { esAcumulada: false, montoFondo: 0 })).toBe(
      0,
    );
  });
});

describe('lecturaFondo (usado / disponible de /caja-chica/me)', () => {
  it('acumulada: usado = por reponer; disponible = asignado − usado (0 sin nominal)', () => {
    expect(
      lecturaFondo({
        saldo: 13341.12,
        asignado: 0,
        entregadoTotal: 0,
        gastadoTotal: 13341.12,
        esAcumulada: true,
      }),
    ).toEqual({ usado: 13341.12, disponible: 0 });
    expect(
      lecturaFondo({
        saldo: 13341.12,
        asignado: 20000,
        entregadoTotal: 0,
        gastadoTotal: 13341.12,
        esAcumulada: true,
      }),
    ).toEqual({ usado: 13341.12, disponible: 6658.88 });
    // Saldo negativo en acumulada (repusieron de más): usado 0.
    expect(
      lecturaFondo({
        saldo: -50,
        asignado: 0,
        entregadoTotal: 150,
        gastadoTotal: 100,
        esAcumulada: true,
      }).usado,
    ).toBe(0);
  });

  it('clásica con entregas: disponible = saldo; usado = asignado − saldo (o lo gastado sin nominal)', () => {
    expect(
      lecturaFondo({
        saldo: 4500,
        asignado: 6000,
        entregadoTotal: 6000,
        gastadoTotal: 1500,
        esAcumulada: false,
      }),
    ).toEqual({ usado: 1500, disponible: 4500 });
    expect(
      lecturaFondo({
        saldo: 700,
        asignado: 0,
        entregadoTotal: 1000,
        gastadoTotal: 300,
        esAcumulada: false,
      }),
    ).toEqual({ usado: 300, disponible: 700 });
  });

  it('clásica sin entregas registradas (VISITANTE): usado = gastado; disponible = asignado − gastado', () => {
    expect(
      lecturaFondo({
        saldo: -1200,
        asignado: 5000,
        entregadoTotal: 0,
        gastadoTotal: 1200,
        esAcumulada: false,
      }),
    ).toEqual({ usado: 1200, disponible: 3800 });
    expect(
      lecturaFondo({
        saldo: -1200,
        asignado: 0,
        entregadoTotal: 0,
        gastadoTotal: 1200,
        esAcumulada: false,
      }),
    ).toEqual({ usado: 1200, disponible: -1200 });
  });
});

describe('CONCEPTO_CAJA', () => {
  it('etiquetas es-MX iguales a las del panel', () => {
    expect(CONCEPTO_CAJA.REPOSICION).toBe('Reposición');
    expect(CONCEPTO_CAJA.REINTEGRO).toBe('Reintegro a dirección');
    expect(CONCEPTO_CAJA.AJUSTE).toBe('Ajuste');
    expect(CONCEPTO_CAJA.GASTO).toBe('Gasto en efectivo');
  });
});
