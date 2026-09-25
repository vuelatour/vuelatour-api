import {
  CLASIFICACION_REVERSO,
  clienteQueEmpata,
  cuadraMontoAbono,
  elegirCandidatoAbono,
  empataNombre,
  patronReverso,
  posibleDuplicado,
  type AbonoCruce,
  type CandidatoAbonoCruce,
} from './abono-cruce.util';

/**
 * Decisión ÚNICA de los abonos (contrato §6.1), con las descripciones REALES
 * de prod del 24-sep-2026.
 */
const CTA = 'cta-paywise';

const abono = (monto: number, extra: Partial<AbonoCruce> = {}): AbonoCruce => ({
  monto,
  monto_bruto: null,
  descripcion: null,
  cuenta_bancaria_id: CTA,
  ...extra,
});

const cand = (
  id: string,
  monto: number,
  extra: Partial<CandidatoAbonoCruce> = {},
): CandidatoAbonoCruce => ({
  tipo: 'COBRO_VUELO',
  id,
  monto,
  comision: null,
  fecha: '2026-09-08',
  cliente: null,
  cuenta_bancaria_id: null,
  ...extra,
});

describe('cuadraMontoAbono — la regla de monto de siempre', () => {
  it('sin comisión compara el BRUTO a centavos (igualdad r2, no ±0.01)', () => {
    expect(cuadraMontoAbono(abono(1500), cand('c', 1500), false)).toBe(true);
    expect(cuadraMontoAbono(abono(1500), cand('c', 1500.01), false)).toBe(
      false,
    );
  });

  it('con comisión compara el NETO: caso real #235 (20,400 − 1,020 = 19,380)', () => {
    const c = cand('c235', 20400, { comision: 1020 });
    expect(cuadraMontoAbono(abono(19380), c, false)).toBe(true);
    expect(cuadraMontoAbono(abono(20400), c, false)).toBe(false);
  });

  it('pasarela: además el bruto del candidato contra el monto_bruto del abono', () => {
    const c = cand('c', 1000, { comision: 88.57 });
    const a = abono(905, { monto_bruto: 1000 });
    expect(cuadraMontoAbono(a, c, true)).toBe(true);
    // Fuera de pasarela el bruto no cuenta.
    expect(cuadraMontoAbono(a, c, false)).toBe(false);
  });
});

describe('elegirCandidatoAbono — un universo: cobro, sobre e ingreso', () => {
  it('0 ⇒ SIN_CANDIDATOS; 1 ⇒ MONTO_EXACTO', () => {
    expect(elegirCandidatoAbono(abono(10), [cand('c', 11)], false)).toEqual({
      elegido: null,
      criterio: null,
      motivo: 'SIN_CANDIDATOS',
      candidatos_n: 0,
    });
    const r = elegirCandidatoAbono(abono(10), [cand('c', 10)], false);
    expect(r.elegido?.id).toBe('c');
    expect(r.criterio).toBe('MONTO_EXACTO');
  });

  it('un INGRESO registrado en OTRA cuenta no entra al auto', () => {
    const ing = cand('i', 500, {
      tipo: 'INGRESO',
      cuenta_bancaria_id: 'otra-cuenta',
    });
    expect(elegirCandidatoAbono(abono(500), [ing], false).motivo).toBe(
      'SIN_CANDIDATOS',
    );
    const mismaCuenta = { ...ing, cuenta_bancaria_id: CTA };
    expect(
      elegirCandidatoAbono(abono(500), [mismaCuenta], false).elegido?.id,
    ).toBe('i');
  });

  it('cobro + ingreso del mismo monto sin nombre ⇒ AMBIGUO', () => {
    const r = elegirCandidatoAbono(
      abono(500),
      [
        cand('c', 500),
        cand('i', 500, { tipo: 'INGRESO', cuenta_bancaria_id: CTA }),
      ],
      false,
    );
    expect(r).toEqual({
      elegido: null,
      criterio: null,
      motivo: 'AMBIGUO',
      candidatos_n: 2,
    });
  });

  it('dos cobros iguales: el NOMBRE del ordenante (Leticia) desempata', () => {
    const r = elegirCandidatoAbono(
      abono(95000, { descripcion: 'LETICIA LEON ALVARADO : PAGO' }),
      [
        cand('c-leticia', 95000, { cliente: 'Leticia León Alvarado' }),
        cand('c-otro', 95000, { cliente: 'Leticia Pérez' }),
      ],
      false,
    );
    expect(r.elegido?.id).toBe('c-leticia');
    expect(r.criterio).toBe('DESCRIPCION');
    expect(r.candidatos_n).toBe(2);
  });

  it('dos homónimos que empatan ⇒ AMBIGUO (nunca adivina)', () => {
    const r = elegirCandidatoAbono(
      abono(95000, { descripcion: 'LETICIA LEON ALVARADO : PAGO' }),
      [
        cand('c1', 95000, { cliente: 'Leticia León Alvarado' }),
        cand('c2', 95000, { cliente: 'Leticia León A.' }),
      ],
      false,
    );
    expect(r.motivo).toBe('AMBIGUO');
    expect(r.elegido).toBeNull();
  });
});

describe('empataNombre / clienteQueEmpata — casos reales', () => {
  const CRISTY = 'MARIA CRISTINA CHAVEZ BADIOLA : vuelo cristy badiola';
  const LETICIA = 'LETICIA LEON ALVARADO : PAGO';

  it('«MARIA CRISTINA CHAVEZ BADIOLA : vuelo cristy badiola» ↔ «Cristy Chavez»', () => {
    expect(empataNombre(CRISTY, 'Cristy Chavez')).toBe(true);
    expect(
      clienteQueEmpata(CRISTY, [
        { id: 'k1', nombre: 'Cristy Chavez' },
        { id: 'k2', nombre: 'Leticia León Alvarado' },
      ]),
    ).toEqual({ id: 'k1', nombre: 'Cristy Chavez' });
  });

  it('«LETICIA LEON ALVARADO : PAGO» ↔ «Leticia León Alvarado» sí; «Leticia Pérez» no', () => {
    expect(empataNombre(LETICIA, 'Leticia León Alvarado')).toBe(true);
    expect(empataNombre(LETICIA, 'Leticia Pérez')).toBe(false);
    expect(
      clienteQueEmpata(LETICIA, [
        { id: 'k2', nombre: 'Leticia León Alvarado' },
        { id: 'k3', nombre: 'Leticia Pérez' },
      ]),
    ).toEqual({ id: 'k2', nombre: 'Leticia León Alvarado' });
  });

  it('homónimos ⇒ null', () => {
    expect(
      clienteQueEmpata(LETICIA, [
        { id: 'k2', nombre: 'Leticia León Alvarado' },
        { id: 'k4', nombre: 'Leticia León A.' },
      ]),
    ).toBeNull();
  });

  it('nombre de un token: solo con ≥ 5 letras', () => {
    expect(empataNombre('SPEI PAGO GONZALEZ', 'Gonzalez')).toBe(true);
    expect(empataNombre('SPEI PAGO LUIS', 'Luis')).toBe(false);
    expect(empataNombre('SPEI PAGO', null)).toBe(false);
    expect(empataNombre(null, 'Cristy Chavez')).toBe(false);
  });
});

describe('patronReverso — los 6 reversos reales de prod', () => {
  it.each([
    'Rev ASUR Merida',
    'Rev ASUR Merida ',
    'Rev ASUR Cancun',
    'REV.ASUR MERIDA',
    'REV.DLO*DIDI PAYIN',
    'REV ADO WEB',
  ])('«%s» ⇒ REV', (d) => {
    expect(patronReverso(d)).toBe('REV');
  });

  it.each(['REVOLVENTE HSBC', 'PREVIO PAGO', null, ''])('«%s» ⇒ null', (d) => {
    expect(patronReverso(d)).toBeNull();
  });

  it('clasificación canónica', () => {
    expect(CLASIFICACION_REVERSO).toBe('Reverso de un cargo');
  });
});

describe('posibleDuplicado — el par REAL del 03-sep (36,456.58)', () => {
  const lineas = [
    {
      id: 'a',
      cuenta_bancaria_id: 'cta-scotia',
      tipo: 'ABONO',
      fecha: '2026-09-03',
      monto: 36456.58,
      conciliado: true,
      referencia: '000125473315',
    },
    {
      id: 'b',
      cuenta_bancaria_id: 'cta-scotia',
      tipo: 'ABONO',
      fecha: '2026-09-03',
      monto: 36456.58,
      conciliado: false,
      referencia: '00000000006247178602',
    },
    {
      id: 'c',
      cuenta_bancaria_id: 'cta-scotia',
      tipo: 'ABONO',
      fecha: '2026-09-04',
      monto: 36456.58,
      conciliado: false,
      referencia: null,
    },
    {
      id: 'd',
      cuenta_bancaria_id: 'otra',
      tipo: 'ABONO',
      fecha: '2026-09-03',
      monto: 36456.58,
      conciliado: false,
      referencia: null,
    },
  ];

  it('la pendiente apunta a la conciliada aunque la referencia venga en otro formato', () => {
    expect(posibleDuplicado(lineas[1], lineas)?.id).toBe('a');
    expect(posibleDuplicado(lineas[0], lineas)?.id).toBe('b');
  });

  it('otra fecha u otra cuenta NO es duplicado', () => {
    expect(posibleDuplicado(lineas[2], lineas)).toBeNull();
    expect(posibleDuplicado(lineas[3], lineas)).toBeNull();
  });
});
