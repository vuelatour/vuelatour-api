import {
  CARGOS_A_GASTO_MAX,
  CARGOS_A_GASTO_MIN,
  conPrefijoNoSeRegistro,
  leerErrorCargosGasto,
  MENSAJE_GASTO_YA_CUBIERTO_OTRA_MONEDA,
  MENSAJE_LOTE_CARGOS_INVALIDO,
  mensajeCargosExcedenGasto,
  mensajeCargosMonedaDistinta,
  mensajeGastoNoBancario,
  mensajeLoteMonedaDistintaGasto,
  mensajeSoloCargos,
  ordenarCandidatosPorSuma,
  PREFIJO_NO_SE_REGISTRO,
  resultadoCargosSobreGasto,
  terminacionComun,
  validarCargosParaGasto,
  type CargoParaGasto,
  type CandidatoPorSuma,
} from './cargos-a-gasto.util';

/**
 * «VARIOS CARGOS → UN GASTO» (14-oct-2026, API 0.0.77, invariante 76): la
 * regla de la suma y el espejo PURO de la RPC. El candado real es la RPC;
 * sus códigos y orden los repite `validarCargosParaGasto`.
 */
describe('resultadoCargosSobreGasto (centavos, tolerancia 1.00)', () => {
  it('CUBRE dentro de ±1.00 del faltante', () => {
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 9591.49,
        vinculado: 0,
        sumaCargos: 9591.49,
      }),
    ).toEqual({
      resultado: 'CUBRE',
      faltante: 9591.49,
      faltante_tras: 0,
      excedente: 0,
    });
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 100,
        vinculado: 0,
        sumaCargos: 99,
      }),
    ).toEqual({
      resultado: 'CUBRE',
      faltante: 100,
      faltante_tras: 1,
      excedente: 0,
    });
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 100,
        vinculado: 0,
        sumaCargos: 101,
      }).resultado,
    ).toBe('CUBRE');
  });

  it('PARCIAL y EXCEDE fuera de la tolerancia (borde 1.00 / 1.01)', () => {
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 100,
        vinculado: 0,
        sumaCargos: 98.99,
      }),
    ).toEqual({
      resultado: 'PARCIAL',
      faltante: 100,
      faltante_tras: 1.01,
      excedente: 0,
    });
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 100,
        vinculado: 0,
        sumaCargos: 101.01,
      }),
    ).toEqual({
      resultado: 'EXCEDE',
      faltante: 100,
      faltante_tras: 0,
      excedente: 1.01,
    });
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 9591.49,
        vinculado: 0,
        sumaCargos: 9700,
      }),
    ).toEqual({
      resultado: 'EXCEDE',
      faltante: 9591.49,
      faltante_tras: 0,
      excedente: 108.51,
    });
  });

  it('con pagos previos mide contra lo que FALTA', () => {
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 300,
        vinculado: 100,
        sumaCargos: 200,
      }),
    ).toEqual({
      resultado: 'CUBRE',
      faltante: 200,
      faltante_tras: 0,
      excedente: 0,
    });
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 300,
        vinculado: 100,
        sumaCargos: 250,
      }).resultado,
    ).toBe('EXCEDE');
    // Ya cubierto de más: faltante 0, cualquier cargo excede.
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 300,
        vinculado: 400,
        sumaCargos: 5,
      }),
    ).toEqual({
      resultado: 'EXCEDE',
      faltante: 0,
      faltante_tras: 0,
      excedente: 5,
    });
  });

  it('suma en centavos (0.1 + 0.2 no se pasa)', () => {
    expect(
      resultadoCargosSobreGasto({
        montoGasto: 0.3,
        vinculado: 0,
        sumaCargos: 0.1 + 0.2,
      }),
    ).toEqual({
      resultado: 'CUBRE',
      faltante: 0.3,
      faltante_tras: 0,
      excedente: 0,
    });
  });
});

describe('ordenarCandidatosPorSuma', () => {
  const c = (
    id: string,
    resultado: CandidatoPorSuma['resultado'],
    faltante: number,
    fecha: string | null,
  ): CandidatoPorSuma => ({ id, monto: faltante, faltante, fecha, resultado });

  it('CUBRE → PARCIAL → EXCEDE; luego cercanía a la suma; luego fecha al rango; luego fecha desc; luego id', () => {
    const lista = [
      c('excede', 'EXCEDE', 50, '2026-09-10'),
      c('parcial', 'PARCIAL', 500, '2026-09-10'),
      c('cubre-lejos', 'CUBRE', 100.9, '2026-09-10'),
      c('cubre-exacto-fuera', 'CUBRE', 100, '2026-08-01'),
      c('cubre-exacto-dentro', 'CUBRE', 100, '2026-09-10'),
      c('cubre-exacto-dentro-b', 'CUBRE', 100, '2026-09-11'),
      c('cubre-exacto-dentro-a', 'CUBRE', 100, '2026-09-11'),
    ];
    const orden = ordenarCandidatosPorSuma(lista, {
      suma: 100,
      fechaMin: '2026-09-09',
      fechaMax: '2026-09-12',
    }).map((x) => x.id);
    expect(orden).toEqual([
      'cubre-exacto-dentro-a',
      'cubre-exacto-dentro-b',
      'cubre-exacto-dentro',
      'cubre-exacto-fuera',
      'cubre-lejos',
      'parcial',
      'excede',
    ]);
    // No muta la entrada.
    expect(lista[0].id).toBe('excede');
  });

  it('sin fecha va al final de su nivel', () => {
    const orden = ordenarCandidatosPorSuma(
      [c('sin', 'CUBRE', 100, null), c('con', 'CUBRE', 100, '2026-12-31')],
      { suma: 100, fechaMin: '2026-09-01', fechaMax: '2026-09-02' },
    ).map((x) => x.id);
    expect(orden).toEqual(['con', 'sin']);
  });
});

describe('terminacionComun', () => {
  it('la misma en todos ⇒ esa; si no ⇒ null', () => {
    expect(terminacionComun(['0577', '0577'])).toBe('0577');
    expect(terminacionComun(['0577', '6256'])).toBeNull();
    expect(terminacionComun(['0577', null])).toBeNull();
    expect(terminacionComun([null, null])).toBeNull();
    expect(terminacionComun([])).toBeNull();
  });
});

describe('validarCargosParaGasto (espejo de la RPC, mismo orden)', () => {
  const cargo = (
    id: string,
    monto: number,
    extra: Partial<CargoParaGasto> = {},
  ): CargoParaGasto => ({
    id,
    tipo: 'CARGO',
    monto,
    moneda: 'MXN',
    estado: 'PENDIENTE',
    fecha: '2026-09-24',
    descripcion: `CARGO ${id}`,
    ...extra,
  });
  const gasto = { moneda: 'MXN', monto: 300, medio_pago: 'TRANSFERENCIA' };

  it('2..50 sin repetir', () => {
    expect(CARGOS_A_GASTO_MIN).toBe(2);
    expect(CARGOS_A_GASTO_MAX).toBe(50);
    expect(validarCargosParaGasto([cargo('a', 1)], gasto)).toMatchObject({
      ok: false,
      codigo: 'LOTE_INVALIDO',
    });
    expect(
      validarCargosParaGasto(
        Array.from({ length: 51 }, (_, i) => cargo(`c${i}`, 1)),
        { ...gasto, monto: 100 },
      ),
    ).toMatchObject({ ok: false, codigo: 'LOTE_INVALIDO' });
    expect(
      validarCargosParaGasto([cargo('a', 1), cargo('a', 1)], gasto),
    ).toMatchObject({
      ok: false,
      codigo: 'LOTE_INVALIDO',
    });
  });

  it('el orden de la RPC: solo cargos antes que pendientes antes que moneda…', () => {
    const abono = cargo('ab', 5, {
      tipo: 'ABONO',
      estado: 'CON_COBRO',
      moneda: 'USD',
    });
    expect(validarCargosParaGasto([cargo('a', 1), abono], gasto)).toMatchObject(
      {
        ok: false,
        codigo: 'SOLO_CARGOS',
        details: { abonos: [{ id: 'ab', monto: 5 }] },
      },
    );
    const ocupado = cargo('o', 5, { estado: 'CON_GASTO', moneda: 'USD' });
    expect(
      validarCargosParaGasto([cargo('a', 1), ocupado], gasto),
    ).toMatchObject({
      ok: false,
      codigo: 'MOVIMIENTO_NO_PENDIENTE',
      details: { movimientos: [{ id: 'o', estado: 'CON_GASTO' }] },
    });
    expect(
      validarCargosParaGasto(
        [cargo('a', 1), cargo('u', 1, { moneda: 'USD' })],
        gasto,
      ),
    ).toMatchObject({
      ok: false,
      codigo: 'CARGOS_MONEDA_DISTINTA',
      details: { monedas: ['MXN', 'USD'] },
    });
    expect(
      validarCargosParaGasto(
        [cargo('a', 1), cargo('b', 1, { moneda: null })],
        gasto,
      ),
    ).toMatchObject({ ok: false, codigo: 'CARGOS_MONEDA_DISTINTA' });
    expect(
      validarCargosParaGasto([cargo('a', 1), cargo('b', 1)], {
        ...gasto,
        moneda: 'USD',
      }),
    ).toMatchObject({
      ok: false,
      codigo: 'LOTE_MONEDA_DISTINTA',
      details: { moneda_gasto: 'USD', moneda_cuenta: 'MXN' },
    });
  });

  it('medio: BODEGA aparte, no bancario, DOMICILIADO sí es bancario', () => {
    const dos = [cargo('a', 100), cargo('b', 200)];
    expect(
      validarCargosParaGasto(dos, { ...gasto, medio_pago: 'BODEGA' }),
    ).toMatchObject({
      ok: false,
      codigo: 'GASTO_BODEGA',
    });
    expect(
      validarCargosParaGasto(dos, { ...gasto, medio_pago: 'EFECTIVO' }),
    ).toMatchObject({
      ok: false,
      codigo: 'GASTO_NO_BANCARIO',
      details: { medio_pago: 'EFECTIVO' },
    });
    expect(
      validarCargosParaGasto(dos, { ...gasto, medio_pago: null }),
    ).toMatchObject({
      ok: false,
      codigo: 'GASTO_NO_BANCARIO',
      details: { medio_pago: null },
    });
    expect(
      validarCargosParaGasto(dos, { ...gasto, medio_pago: 'DOMICILIADO' }),
    ).toEqual({
      ok: true,
      moneda: 'MXN',
      suma: 300,
    });
  });

  it('parte cruzada previa y la suma con tolerancia 1.00', () => {
    const dos = [cargo('a', 100), cargo('b', 200)];
    expect(
      validarCargosParaGasto(dos, { ...gasto, cruzadas: 1 }),
    ).toMatchObject({
      ok: false,
      codigo: 'GASTO_YA_CUBIERTO',
      details: { motivo: 'MONEDA_DISTINTA' },
    });
    expect(validarCargosParaGasto(dos, { ...gasto, monto: 299 })).toEqual({
      ok: true,
      moneda: 'MXN',
      suma: 300,
    });
    expect(validarCargosParaGasto(dos, { ...gasto, monto: 298.99 })).toEqual({
      ok: false,
      codigo: 'CARGOS_EXCEDEN_GASTO',
      details: {
        moneda: 'MXN',
        monto_gasto: 298.99,
        suma_ligada: 0,
        faltante: 298.99,
        suma_cargos: 300,
        excedente: 1.01,
        tolerancia: 1,
      },
    });
    expect(
      validarCargosParaGasto(dos, { ...gasto, monto: 400, vinculado: 101.01 }),
    ).toMatchObject({ ok: false, codigo: 'CARGOS_EXCEDEN_GASTO' });
  });

  it('cargos negativos (el banco los manda con signo) suman su |monto|', () => {
    expect(
      validarCargosParaGasto([cargo('a', -100), cargo('b', -200)], gasto),
    ).toEqual({ ok: true, moneda: 'MXN', suma: 300 });
  });
});

describe('textos (es-MX, exactos del contrato)', () => {
  it('lote, solo cargos y monedas', () => {
    expect(MENSAJE_LOTE_CARGOS_INVALIDO).toBe(
      'Elige de 2 a 50 cargos sin repetir (con uno, usa «Vincular gasto» del menú ⋯).',
    );
    expect(mensajeSoloCargos(2)).toBe(
      'Solo los cargos pagan un gasto: quita los 2 abonos de la selección.',
    );
    expect(mensajeSoloCargos(1)).toBe(
      'Solo los cargos pagan un gasto: quita el abono de la selección.',
    );
    expect(mensajeCargosMonedaDistinta(['USD', 'MXN'])).toBe(
      'Los cargos son de cuentas en MXN y USD: un gasto se paga en una sola moneda.',
    );
    expect(
      mensajeLoteMonedaDistintaGasto({
        monedaGasto: 'USD',
        monedaCuenta: 'MXN',
      }),
    ).toBe(
      'El gasto está en USD y los cargos en MXN: una compra en dólares pagada en pesos se vincula con UN solo cargo (menú ⋯ del cargo → Vincular gasto).',
    );
    expect(
      mensajeLoteMonedaDistintaGasto({
        monedaGasto: 'MXN',
        monedaCuenta: 'USD',
      }),
    ).toBe(
      'El gasto está en MXN y los cargos en USD: un gasto se vincula con cargos de su misma moneda.',
    );
    expect(mensajeGastoNoBancario('EFECTIVO')).toBe(
      'El gasto se pagó con Efectivo, que no pasa por el banco: se vincula cargo por cargo con su justificación (menú ⋯ → Vincular gasto → «Incluir gastos en efectivo y otros medios»).',
    );
    expect(MENSAJE_GASTO_YA_CUBIERTO_OTRA_MONEDA).toBe(
      'Ese gasto ya está conciliado 1 a 1 con un cargo en otra moneda: no admite más cargos.',
    );
  });

  it('CARGOS_EXCEDEN_GASTO sin y con pagos previos', () => {
    expect(
      mensajeCargosExcedenGasto({
        n: 3,
        moneda: 'MXN',
        monto_gasto: 9591.49,
        suma_ligada: 0,
        suma_cargos: 9700,
        tolerancia: 1,
      }),
    ).toBe(
      'Los 3 cargos suman $9,700.00 y al gasto le faltan $9,591.49 (vale $9,591.49): se pasarían por $108.51 (tolerancia $1.00). Revisa la selección o el monto del gasto.',
    );
    expect(
      mensajeCargosExcedenGasto({
        n: 2,
        moneda: 'MXN',
        monto_gasto: 300,
        suma_ligada: 100,
        suma_cargos: 250,
      }),
    ).toBe(
      'Los 2 cargos suman $250.00 y al gasto le faltan $200.00 (ya tiene $100.00 de $300.00): se pasarían por $50.00 (tolerancia $1.00). Revisa la selección o el monto del gasto.',
    );
    expect(
      mensajeCargosExcedenGasto({
        moneda: 'USD',
        monto_gasto: 10,
        suma_ligada: 0,
        suma_cargos: 12,
      }),
    ).toBe(
      'Los cargos suman $12.00 USD y al gasto le faltan $10.00 USD (vale $10.00 USD): se pasarían por $2.00 USD (tolerancia $1.00 USD). Revisa la selección o el monto del gasto.',
    );
  });

  it('prefijo del alta por la suma: idempotente y en minúscula', () => {
    expect(
      conPrefijoNoSeRegistro('Los cargos son de cuentas en MXN y USD.'),
    ).toBe('No se registró el gasto: los cargos son de cuentas en MXN y USD.');
    const ya = `${PREFIJO_NO_SE_REGISTRO}1 de los 3 cargos ya no está pendiente.`;
    expect(conPrefijoNoSeRegistro(ya)).toBe(ya);
    expect(conPrefijoNoSeRegistro('')).toBe('No se registró el gasto:');
  });
});

describe('leerErrorCargosGasto', () => {
  it('códigos de la RPC y de los triggers', () => {
    expect(
      leerErrorCargosGasto({
        code: '23514',
        hint: 'CARGOS_EXCEDEN_GASTO',
        message: 'CARGOS_EXCEDEN_GASTO: se pasan',
        details: '{"excedente":108.51}',
      }),
    ).toEqual({
      codigo: 'CARGOS_EXCEDEN_GASTO',
      texto: 'se pasan',
      details: { excedente: 108.51 },
    });
    expect(
      leerErrorCargosGasto({
        code: '23514',
        hint: 'MOVIMIENTO_OMITIDO',
        message: 'x',
      }).codigo,
    ).toBe('MOVIMIENTO_OMITIDO');
    expect(
      leerErrorCargosGasto({
        code: '23514',
        hint: 'OMISION_INVALIDA',
        message: 'x',
      }).codigo,
    ).toBeNull();
  });
});
