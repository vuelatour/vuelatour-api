import { repartirPorcentajeCents } from './gasto-reparto.util';

describe('repartirPorcentajeCents', () => {
  it('Σ = 100% suma exactamente el monto (tercios clásicos)', () => {
    // $100.00 entre 33.33 / 33.33 / 33.34
    const partes = repartirPorcentajeCents(10000, [33.33, 33.33, 33.34]);
    expect(partes.reduce((a, c) => a + c, 0)).toBe(10000);
    expect(partes).toEqual([3333, 3333, 3334]);
  });

  it('residuo por mayor resto: el centavo extra va a la línea con más resto', () => {
    // $0.10 al 33.33/33.33/33.34: bases 3/3/3 y el objetivo es 10 → el
    // centavo del residuo cae en la TERCERA (resto 3340 > 3330).
    const partes = repartirPorcentajeCents(10, [33.33, 33.33, 33.34]);
    expect(partes).toEqual([3, 3, 4]);
    expect(partes.reduce((a, c) => a + c, 0)).toBe(10);
  });

  it('empate de restos: gana el orden de las líneas', () => {
    // $0.03 entre 50/50: exactos 1.5 y 1.5, objetivo 3 → [2, 1].
    expect(repartirPorcentajeCents(3, [50, 50])).toEqual([2, 1]);
  });

  it('Σ < 100% suma el round del total asignado (el resto es empresa)', () => {
    // $200.00 al 25% + 10.55% = 35.55% → 7110 centavos exactos.
    const partes = repartirPorcentajeCents(20000, [25, 10.55]);
    expect(partes).toEqual([5000, 2110]);
  });

  it('sin floats: 0.01% de montos chicos trunca a 0 centavos', () => {
    // El caller debe rechazar líneas en 0 (CHECK monto>0 de gasto_reparto).
    expect(repartirPorcentajeCents(99, [0.01])).toEqual([0]);
    expect(repartirPorcentajeCents(5000, [0.01])).toEqual([1]);
  });

  it('porcentajes con decimales sucios de float no desvían centavos', () => {
    // 29.03 × 100 = 2902.9999… en float: Math.round lo ancla a 2903.
    const partes = repartirPorcentajeCents(123456, [29.03, 70.97]);
    expect(partes.reduce((a, c) => a + c, 0)).toBe(123456);
    expect(partes).toEqual([35839, 87617]);
  });

  it('monto 0 reparte puros ceros', () => {
    expect(repartirPorcentajeCents(0, [50, 50])).toEqual([0, 0]);
  });
});
