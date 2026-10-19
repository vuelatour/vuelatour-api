import {
  COLS_CANDIDATO_POR_PAGAR,
  cargoPuedePagarGasto,
  colsCandidatoPorPagar,
  diaCapturaDeGasto,
  sinPorPagarPosterioresAlCargo,
  textoPorPagarPosteriorAlCargo,
} from './por-pagar-cruce.util';

/**
 * AUTO-CRUCE DESDE EL BANCO y gastos «por pagar» (19-oct-2026, invariante
 * 93; revisión P14 (b)): un por pagar VIGENTE capturado después del día del
 * cargo no puede tener ese cargo como pago.
 */
const HOY = '2026-10-19';
const porPagar = {
  id: 'g-pp',
  por_pagar: true,
  conciliado: false,
  fecha_gasto: '2026-10-21',
  capturado_en: '2026-10-19T15:00:00Z',
  created_at: '2026-10-19T15:00:01Z',
};

describe('por-pagar-cruce.util', () => {
  it('columnas extra SOLO con la sonda', () => {
    expect(colsCandidatoPorPagar(true)).toBe(COLS_CANDIDATO_POR_PAGAR);
    expect(COLS_CANDIDATO_POR_PAGAR).toBe(
      ', por_pagar, conciliado, capturado_en, created_at',
    );
    expect(colsCandidatoPorPagar(false)).toBe('');
  });

  it('día de la captura: `capturado_en` (día Cancún) y, sin él, `created_at`', () => {
    expect(diaCapturaDeGasto(porPagar)).toBe('2026-10-19');
    expect(diaCapturaDeGasto({ capturado_en: '2026-10-19T04:30:00Z' })).toBe(
      '2026-10-18',
    );
    expect(
      diaCapturaDeGasto({
        capturado_en: null,
        created_at: '2026-10-20T16:00:00Z',
      }),
    ).toBe('2026-10-20');
    expect(diaCapturaDeGasto({})).toBeNull();
    expect(diaCapturaDeGasto({ capturado_en: 'no es fecha' })).toBeNull();
  });

  it.each([
    [
      'cargo ANTERIOR a la captura ⇒ no es su pago',
      porPagar,
      '2026-10-18',
      false,
    ],
    ['cargo del MISMO día ⇒ candidato', porPagar, '2026-10-19', true],
    ['cargo POSTERIOR ⇒ candidato', porPagar, '2026-10-21', true],
    [
      'VENCIDO (fecha pasada) sigue vigente ⇒ la misma regla',
      { ...porPagar, fecha_gasto: '2026-10-10' },
      '2026-10-18',
      false,
    ],
    [
      'pagado ⇒ siempre candidato',
      { ...porPagar, por_pagar: false },
      '2026-10-18',
      true,
    ],
    [
      'conciliado (PAGADO) ⇒ siempre candidato',
      { ...porPagar, conciliado: true },
      '2026-10-18',
      true,
    ],
    [
      'sin la llave `por_pagar` (fila sin la migración) ⇒ candidato',
      { id: 'g-viejo', capturado_en: '2026-10-19T15:00:00Z' },
      '2026-10-18',
      true,
    ],
    [
      'captura ilegible ⇒ candidato (jamás se descarta sin decidir)',
      { ...porPagar, capturado_en: null, created_at: null },
      '2026-10-18',
      true,
    ],
    ['fecha del cargo ilegible ⇒ candidato', porPagar, 'ayer', true],
  ] as const)('%s', (_n, g, fecha, esperado) => {
    expect(cargoPuedePagarGasto(g, fecha, HOY)).toBe(esperado);
  });

  it('filtro de una lista: quita los posteriores, cuenta los descartados y conserva el orden; sin filtro, igual', () => {
    const pagado = { id: 'g-ok', por_pagar: false };
    const filas = [porPagar, pagado];
    expect(
      sinPorPagarPosterioresAlCargo(filas, {
        fechaCargo: '2026-10-18',
        hoy: HOY,
      }),
    ).toEqual({ filas: [pagado], descartados: 1 });
    const sin = sinPorPagarPosterioresAlCargo(filas, null);
    expect(sin).toEqual({ filas, descartados: 0 });
    expect(sin.filas).not.toBe(filas);
  });

  it('texto del motivo: singular y plural', () => {
    expect(textoPorPagarPosteriorAlCargo(1)).toBe(
      '1 gasto «por pagar» del mismo monto se capturó después de este cargo: no puede ser su pago.',
    );
    expect(textoPorPagarPosteriorAlCargo(2)).toBe(
      '2 gastos «por pagar» del mismo monto se capturaron después de este cargo: ninguno puede ser su pago.',
    );
  });
});
