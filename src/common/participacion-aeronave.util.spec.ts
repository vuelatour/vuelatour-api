import {
  avionDelGasto,
  factorDe,
  parteFilaDeCobro,
  participacionPorAeronave,
  repartirUsd,
} from './participacion-aeronave.util';

const A = 'aaaaaaaa-0000-0000-0000-000000000001'; // N990GG (principal)
const B = 'bbbbbbbb-0000-0000-0000-000000000002'; // N4142R
const C = 'cccccccc-0000-0000-0000-000000000003';

describe('participacionPorAeronave', () => {
  it('vuelo de un solo avión: factor 1 al principal, sin multi-avión', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: null, taco_salida: 100, taco_llegada: 101.5 },
      { orden: 2, aeronave_id: A, taco_salida: 101.5, taco_llegada: 103 },
    ]);
    expect(p.multi_avion).toBe(false);
    expect(p.fuente).toBe('unico');
    expect(factorDe(p, A)).toBe(1);
    expect(factorDe(p, B)).toBe(0);
    expect(p.tramos_activos).toBe(2);
  });

  it('vuelo #105 real (snapshot 1.2033/1.1967 h cotizadas, tacos 0.9/1.3 h): mitad y mitad por tramo', () => {
    const p = participacionPorAeronave(
      {
        aeronave_id: A,
        calculo_snapshot: {
          tramos: [
            { orden: 1, tiempo_hr: 1.2033 },
            { orden: 2, tiempo_hr: 1.1967 },
          ],
        },
      },
      [
        { orden: 1, aeronave_id: A, taco_salida: 5544.6, taco_llegada: 5545.5 },
        { orden: 2, aeronave_id: B, taco_salida: 4410.1, taco_llegada: 4411.4 },
      ],
    );
    expect(p.multi_avion).toBe(true);
    expect(p.fuente).toBe('tramos');
    expect(factorDe(p, A)).toBe(0.5);
    expect(factorDe(p, B)).toBe(0.5);
    expect(p.tramos_por_avion.get(A)).toBe(1);
    expect(p.tramos_por_avion.get(B)).toBe(1);
    expect(repartirUsd(2175, p).get(A)).toBe(1087.5);
    expect(repartirUsd(2175, p).get(B)).toBe(1087.5);
    expect(repartirUsd(2171.43, p).get(A)).toBe(1085.72);
    expect(repartirUsd(2171.43, p).get(B)).toBe(1085.71);
  });

  it('ni las horas cotizadas ni los tacos reparten: 1 h vs 3 h → 50/50 por tramo', () => {
    const p = participacionPorAeronave(
      {
        aeronave_id: A,
        calculo_snapshot: {
          tramos: [
            { orden: 1, tiempo_hr: 1 },
            { orden: 2, tiempo_hr: 3 },
          ],
        },
      },
      [
        { orden: 1, aeronave_id: A, taco_salida: 10, taco_llegada: 11 },
        { orden: 2, aeronave_id: B, taco_salida: 20, taco_llegada: 23 },
      ],
    );
    expect(p.fuente).toBe('tramos');
    expect(factorDe(p, A)).toBe(0.5);
    expect(factorDe(p, B)).toBe(0.5);
  });

  it('con más tramos: tantas partes como tramos vendidos voló cada avión (1 de 3 / 2 de 3)', () => {
    const p = participacionPorAeronave(
      {
        aeronave_id: A,
        calculo_snapshot: {
          tramos: [
            { orden: 1, tiempo_hr: 1.2 },
            { orden: 2, tiempo_hr: 1.2 },
            { orden: 3, tiempo_hr: 2.4 },
          ],
        },
      },
      [
        { orden: 1, aeronave_id: A },
        { orden: 2, aeronave_id: B },
        { orden: 3, aeronave_id: B },
      ],
    );
    expect(p.fuente).toBe('tramos');
    expect(factorDe(p, A)).toBe(0.3333);
    expect(factorDe(p, B)).toBe(0.6667);
    expect(p.tramos_activos).toBe(3);
  });

  it('tramo operativo/ferry (orden 100, solo_operativa) de otro avión NO reparte la venta', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A },
      { orden: 2, aeronave_id: B },
      { orden: 100, aeronave_id: B, solo_operativa: true, es_ferry: true },
    ]);
    expect(factorDe(p, A)).toBe(0.5);
    expect(factorDe(p, B)).toBe(0.5);
    expect(p.tramos_activos).toBe(2);
    expect(p.tramos_por_avion.get(B)).toBe(1);
    // Ferry en un TERCER avión: ni aparece.
    const q = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A },
      { orden: 2, aeronave_id: A },
      { orden: 100, aeronave_id: C, solo_operativa: true },
    ]);
    expect(q.multi_avion).toBe(false);
    expect(factorDe(q, A)).toBe(1);
    expect(factorDe(q, C)).toBe(0);
  });

  it('vuelo #138 (solo tramos operativos, servicio $0): participan todos a partes iguales', () => {
    const p = participacionPorAeronave({ aeronave_id: B }, [
      { orden: 1, aeronave_id: B, solo_operativa: true, es_ferry: true },
      { orden: 100, aeronave_id: A, solo_operativa: true, es_ferry: true },
    ]);
    expect(p.multi_avion).toBe(true);
    expect(factorDe(p, A)).toBe(0.5);
    expect(factorDe(p, B)).toBe(0.5);
    expect(repartirUsd(0, p).get(A)).toBe(0);
  });

  it('sin horas de ninguna fuente: partes iguales por tramo', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A },
      { orden: 2, aeronave_id: B },
      { orden: 3, aeronave_id: B },
    ]);
    expect(p.fuente).toBe('tramos');
    expect(factorDe(p, A)).toBe(0.3333);
    expect(factorDe(p, B)).toBe(0.6667);
    const suma = [...p.factores.values()].reduce((a, b) => a + b, 0);
    expect(suma).toBeCloseTo(1, 10);
  });

  it('tres aviones a partes iguales: el residuo del redondeo cierra en el principal (Σ == 1)', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A },
      { orden: 2, aeronave_id: B },
      { orden: 3, aeronave_id: C },
    ]);
    expect(factorDe(p, A)).toBe(0.3334);
    expect(factorDe(p, B)).toBe(0.3333);
    expect(factorDe(p, C)).toBe(0.3333);
  });

  it('un tramo cancelado no participa; si solo queda un avión, deja de ser multi-avión', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A, taco_salida: 10, taco_llegada: 11 },
      {
        orden: 2,
        aeronave_id: B,
        cancelada_at: '2026-08-11T20:00:00Z',
        taco_salida: 20,
        taco_llegada: 21,
      },
    ]);
    expect(p.multi_avion).toBe(false);
    expect(factorDe(p, A)).toBe(1);
    expect(factorDe(p, B)).toBe(0);
  });

  it('vuelo externo sin avión de referencia: nadie participa', () => {
    const p = participacionPorAeronave({ aeronave_id: null }, [
      { orden: 1, aeronave_id: null },
    ]);
    expect(p.multi_avion).toBe(false);
    expect(p.factores.size).toBe(0);
    expect(factorDe(p, A)).toBe(0);
  });

  it('sin escalas: factor 1 al principal', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, []);
    expect(factorDe(p, A)).toBe(1);
    expect(p.multi_avion).toBe(false);
  });
});

describe('repartirUsd', () => {
  it('reparte al centavo: la suma de las partes es el monto exacto', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A },
      { orden: 2, aeronave_id: B },
      { orden: 3, aeronave_id: C },
    ]);
    const partes = repartirUsd(100.01, p);
    const suma = [...partes.values()].reduce((a, b) => a + b, 0);
    expect(Math.round(suma * 100) / 100).toBe(100.01);
    expect(partes.get(A)).toBe(33.35); // residuo mayor + principal primero
    expect(partes.get(B)).toBe(33.33);
    expect(partes.get(C)).toBe(33.33);
  });

  it('mitad y mitad de un monto impar en centavos: el centavo sobrante va al principal', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A, taco_salida: 0, taco_llegada: 1 },
      { orden: 2, aeronave_id: B, taco_salida: 0, taco_llegada: 1 },
    ]);
    const partes = repartirUsd(2175.01, p);
    expect(partes.get(A)).toBe(1087.51);
    expect(partes.get(B)).toBe(1087.5);
  });

  it('montos negativos y cero', () => {
    const p = participacionPorAeronave({ aeronave_id: A }, [
      { orden: 1, aeronave_id: A, taco_salida: 0, taco_llegada: 1 },
      { orden: 2, aeronave_id: B, taco_salida: 0, taco_llegada: 1 },
    ]);
    expect(repartirUsd(0, p).get(B)).toBe(0);
    const neg = repartirUsd(-10, p);
    expect(neg.get(A)).toBe(-5);
    expect(neg.get(B)).toBe(-5);
  });
});

describe('avionDelGasto', () => {
  const escalas = new Map<string, { aeronave_id?: string | null }>([
    ['e1', { aeronave_id: null }],
    ['e2', { aeronave_id: B }],
  ]);
  it('la escala manda (con herencia del principal cuando no tiene avión)', () => {
    expect(avionDelGasto({ escala_id: 'e2', aeronave_id: A }, escalas, A)).toBe(
      B,
    );
    expect(avionDelGasto({ escala_id: 'e1', aeronave_id: B }, escalas, A)).toBe(
      A,
    );
  });
  it('sin escala: avión sellado en el gasto, luego el del vuelo', () => {
    expect(avionDelGasto({ escala_id: null, aeronave_id: B }, escalas, A)).toBe(
      B,
    );
    expect(
      avionDelGasto({ escala_id: null, aeronave_id: null }, escalas, A),
    ).toBe(A);
    expect(avionDelGasto({}, escalas, null)).toBeNull();
  });
});

describe('parteFilaDeCobro', () => {
  // Vuelo #105-like: ida en A (principal, reporta), regreso en B (50/50).
  const multi = participacionPorAeronave({ aeronave_id: A }, [
    { orden: 1, aeronave_id: A },
    { orden: 2, aeronave_id: B },
  ]);
  const unico = participacionPorAeronave({ aeronave_id: A }, [
    { orden: 1, aeronave_id: A },
    { orden: 2, aeronave_id: null },
  ]);
  // Partición con parte VuelaTour: total 2,000, venta del avión 1,500.
  const p = { total_usd: 2000, factor_avion: 0.75 };

  it('un solo avión: el monto tal cual (cero cambio numérico), sin redondear', () => {
    expect(parteFilaDeCobro(1234.567, p, unico, A, true, false)).toBe(1234.567);
    expect(parteFilaDeCobro(1234.567, null, null, A, true, false)).toBe(
      1234.567,
    );
    expect(parteFilaDeCobro(500, p, unico, A, true, true)).toBe(500);
    // Un avión que NO participa no lleva nada.
    expect(parteFilaDeCobro(500, p, unico, B, false, false)).toBe(0);
  });

  it('multi-avión con parte VuelaTour: la fila que reporta lleva su parte del avión + toda la parte VuelaTour; Σ == cobro', () => {
    const a = parteFilaDeCobro(1000, p, multi, A, true, false);
    const b = parteFilaDeCobro(1000, p, multi, B, false, false);
    expect(a).toBe(625); // 375 (50 % de 750) + 250 (VuelaTour)
    expect(b).toBe(375);
    expect(Math.round((a + b) * 100) / 100).toBe(1000);
  });

  it('centavos impares: el residuo cae en el principal y las partes suman el cobro exacto', () => {
    const a = parteFilaDeCobro(1000.01, p, multi, A, true, false);
    const b = parteFilaDeCobro(1000.01, p, multi, B, false, false);
    expect(a).toBe(625.01);
    expect(b).toBe(375);
    expect(Math.round((a + b) * 100) / 100).toBe(1000.01);
  });

  it('si el que reporta es el otro avión, la parte VuelaTour viaja con él', () => {
    expect(parteFilaDeCobro(1000, p, multi, A, false, false)).toBe(375);
    expect(parteFilaDeCobro(1000, p, multi, B, true, false)).toBe(625);
  });

  it('cancelado, sin precio o sin partición: el cobro entero es del avión y se reparte por tramo', () => {
    expect(parteFilaDeCobro(1000, p, multi, A, true, true)).toBe(500);
    expect(parteFilaDeCobro(1000, p, multi, B, false, true)).toBe(500);
    expect(parteFilaDeCobro(1000, null, multi, A, true, false)).toBe(500);
    expect(
      parteFilaDeCobro(
        1000,
        { total_usd: 0, factor_avion: 1 },
        multi,
        B,
        false,
        false,
      ),
    ).toBe(500);
  });

  it('sin parte VuelaTour (factor 1): reparto puro por tramo', () => {
    const sinVt = { total_usd: 2000, factor_avion: 1 };
    expect(parteFilaDeCobro(2000, sinVt, multi, A, true, false)).toBe(1000);
    expect(parteFilaDeCobro(2000, sinVt, multi, B, false, false)).toBe(1000);
  });

  it('un avión ajeno al vuelo multi-avión recibe 0 (o solo la parte VuelaTour si reporta)', () => {
    expect(parteFilaDeCobro(1000, p, multi, C, false, false)).toBe(0);
    expect(parteFilaDeCobro(1000, p, multi, null, false, false)).toBe(0);
  });
});
