import {
  cruzarPaywise,
  difDias,
  normalizarReferencia,
  type CobroPaywise,
  type MovimientoPaywise,
} from './paywise-cruce.util';

function mov(over: Partial<MovimientoPaywise> = {}): MovimientoPaywise {
  return {
    id: over.id ?? 'm1',
    fecha: '2026-09-03',
    monto: 911.43,
    monto_bruto: 1000,
    comision_monto: 88.57,
    referencia: 'PW-12345',
    moneda: 'MXN',
    ...over,
  };
}

function cobro(over: Partial<CobroPaywise> = {}): CobroPaywise {
  return {
    tipo: 'COBRO_VUELO',
    id: over.id ?? 'c1',
    fecha_cobro: '2026-09-01T15:00:00Z',
    monto: 1000,
    moneda: 'MXN',
    comision_banco_monto: 88.57,
    referencia: 'PW-12345',
    folio: 131,
    ...over,
  };
}

describe('cruzarPaywise (cotejo puro Paywise ↔ sistema)', () => {
  it('cuadra por NETO exacto (bruto − comisión del cobro) dentro de la ventana', () => {
    const r = cruzarPaywise([mov()], [cobro()]);
    expect(r.coinciden).toHaveLength(1);
    expect(r.coinciden[0].criterio).toBe('NETO');
    expect(r.coinciden[0].dif_neto).toBe(0);
    expect(r.coinciden[0].comision_distinta).toBe(false);
    expect(r.solo_paywise).toHaveLength(0);
    expect(r.solo_sistema).toHaveLength(0);
  });

  it('cobro sin comisión registrada: NETO = bruto; la comisión real del archivo queda como distinta', () => {
    const r = cruzarPaywise(
      [mov({ monto: 1000, monto_bruto: 1088.57, comision_monto: 88.57 })],
      [cobro({ comision_banco_monto: null })],
    );
    expect(r.coinciden[0].criterio).toBe('NETO');
    expect(r.coinciden[0].comision_paywise).toBe(88.57);
    expect(r.coinciden[0].comision_sistema).toBe(0);
    expect(r.coinciden[0].dif_comision).toBe(88.57);
    expect(r.comision_distinta).toHaveLength(1);
  });

  it('cuadra por BRUTO cuando el neto difiere (comisión provisionada ≠ real)', () => {
    // Sistema provisionó 8.857 % (88.57); Paywise retuvo 3 % (30) → neto 970.
    const r = cruzarPaywise(
      [mov({ monto: 970, monto_bruto: 1000, comision_monto: 30 })],
      [cobro()],
    );
    expect(r.coinciden).toHaveLength(1);
    expect(r.coinciden[0].criterio).toBe('BRUTO');
    expect(r.coinciden[0].dif_comision).toBe(-58.57);
    expect(r.coinciden[0].comision_distinta).toBe(true);
  });

  it('sin bruto en el archivo: abono == bruto de un cobro CON comisión cuadra por BRUTO', () => {
    const r = cruzarPaywise(
      [mov({ monto: 1000, monto_bruto: null, comision_monto: null })],
      [cobro()],
    );
    expect(r.coinciden[0].criterio).toBe('BRUTO');
    // Sin datos de comisión en el archivo no se puede afirmar diferencia.
    expect(r.coinciden[0].comision_paywise).toBeNull();
    expect(r.coinciden[0].comision_distinta).toBe(false);
  });

  it('misma referencia con montos distintos: se reporta, no se liga', () => {
    const r = cruzarPaywise(
      [mov({ monto: 500, monto_bruto: 550, comision_monto: 50 })],
      [cobro()],
    );
    expect(r.coinciden).toHaveLength(0);
    expect(r.referencia_monto_distinto).toHaveLength(1);
    expect(r.referencia_monto_distinto[0].criterio).toBe('REFERENCIA');
    // El cobro NO se consume: sigue "sin Paywise" para la oficina.
    expect(r.solo_sistema).toHaveLength(0);
    expect(r.solo_paywise).toHaveLength(0);
  });

  it('fuera de la ventana de días → solo_paywise y solo_sistema', () => {
    const r = cruzarPaywise(
      [mov({ fecha: '2026-09-20', referencia: null })],
      [cobro({ referencia: null })],
      { dias: 5 },
    );
    expect(r.coinciden).toHaveLength(0);
    expect(r.solo_paywise).toHaveLength(1);
    expect(r.solo_sistema).toHaveLength(1);
  });

  it('moneda distinta nunca cruza', () => {
    const r = cruzarPaywise([mov({ moneda: 'USD' })], [cobro()]);
    expect(r.coinciden).toHaveLength(0);
    expect(r.solo_paywise).toHaveLength(1);
  });

  it('dos cobros idénticos a la misma distancia = AMBIGUO (no se cruza)', () => {
    const r = cruzarPaywise(
      [mov({ referencia: null })],
      [
        cobro({
          id: 'a',
          fecha_cobro: '2026-09-02T12:00:00Z',
          referencia: null,
        }),
        cobro({
          id: 'b',
          fecha_cobro: '2026-09-04T12:00:00Z',
          referencia: null,
        }),
      ],
    );
    expect(r.coinciden).toHaveLength(0);
    expect(r.ambiguos).toHaveLength(1);
    expect(r.ambiguos[0].candidatos.map((c) => c.id).sort()).toEqual([
      'a',
      'b',
    ]);
    expect(r.solo_sistema).toHaveLength(2);
  });

  it('con varios candidatos gana el más cercano en fecha', () => {
    const r = cruzarPaywise(
      [mov({ referencia: null })],
      [
        cobro({
          id: 'lejos',
          fecha_cobro: '2026-08-30T12:00:00Z',
          referencia: null,
        }),
        cobro({
          id: 'cerca',
          fecha_cobro: '2026-09-03T12:00:00Z',
          referencia: null,
        }),
      ],
    );
    expect(r.coinciden[0].cobro.id).toBe('cerca');
    expect(r.solo_sistema.map((c) => c.id)).toEqual(['lejos']);
  });

  it('un cobro se liga a lo más a UN movimiento (greedy por fecha)', () => {
    const r = cruzarPaywise(
      [
        mov({ id: 'm1', fecha: '2026-09-02' }),
        mov({ id: 'm2', fecha: '2026-09-03' }),
      ],
      [cobro()],
    );
    expect(r.coinciden).toHaveLength(1);
    expect(r.coinciden[0].movimiento.id).toBe('m1');
    expect(r.solo_paywise.map((m) => m.id)).toEqual(['m2']);
  });

  it('movimiento YA ligado al cobro del universo → YA_CONCILIADO con cotejo de comisión', () => {
    const r = cruzarPaywise(
      [mov({ cobro_id: 'c1', comision_monto: 90 })],
      [cobro()],
    );
    expect(r.coinciden[0].criterio).toBe('YA_CONCILIADO');
    expect(r.coinciden[0].dif_comision).toBe(1.43);
    expect(r.comision_distinta).toHaveLength(1);
    expect(r.solo_sistema).toHaveLength(0);
  });

  it('movimiento ligado a un cobro FUERA del universo no se cruza ni cuenta como solo_paywise', () => {
    const r = cruzarPaywise([mov({ cobro_id: 'otro' })], [cobro()]);
    expect(r.ya_conciliados_fuera).toBe(1);
    expect(r.solo_paywise).toHaveLength(0);
    // El cobro sigue libre y sin abono.
    expect(r.solo_sistema).toHaveLength(1);
  });

  it('sobres de grupo cruzan por cobro_grupo_id y por neto igual que los cobros', () => {
    const sobre = cobro({
      tipo: 'SOBRE_GRUPO',
      id: 's1',
      grupo_folio: 12,
      monto: 5000,
      comision_banco_monto: 442.85,
    });
    const r = cruzarPaywise(
      [
        mov({
          id: 'm1',
          monto: 4557.15,
          monto_bruto: 5000,
          comision_monto: 442.85,
          referencia: null,
        }),
      ],
      [sobre],
    );
    expect(r.coinciden[0].cobro.tipo).toBe('SOBRE_GRUPO');
    expect(r.coinciden[0].criterio).toBe('NETO');
    const r2 = cruzarPaywise([mov({ cobro_grupo_id: 's1' })], [sobre]);
    expect(r2.coinciden[0].criterio).toBe('YA_CONCILIADO');
  });

  it('tolerancia de 1 centavo por redondeo', () => {
    const r = cruzarPaywise([mov({ monto: 911.44 })], [cobro()]);
    expect(r.coinciden[0].criterio).toBe('NETO');
  });
});

describe('helpers', () => {
  it('normalizarReferencia ignora signos/mayúsculas y descarta refs cortas', () => {
    expect(normalizarReferencia(' PW-12 345 ')).toBe('pw12345');
    expect(normalizarReferencia('ok')).toBeNull();
    expect(normalizarReferencia(null)).toBeNull();
  });

  it('difDias trunca a día Cancún (UTC−5)', () => {
    // 03:00Z del día 4 = 22:00 Cancún del día 3.
    expect(difDias('2026-09-03', '2026-09-04T03:00:00Z')).toBe(0);
    expect(difDias('2026-09-03', '2026-09-08T12:00:00Z')).toBe(5);
    expect(difDias('2026-09-03', 'no-fecha')).toBe(Number.POSITIVE_INFINITY);
  });
});
