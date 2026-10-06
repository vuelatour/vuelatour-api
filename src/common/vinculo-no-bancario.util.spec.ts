import {
  agregarNotaVinculo,
  esLineaVinculoNoBancario,
  fechaMensaje,
  fechaNota,
  JUSTIFICACION_MAX,
  limpiarJustificacion,
  lineaNotaCargo,
  lineaNotaGasto,
  medioNota,
  mensajeGastoBodega,
  mensajeJustificacionRequerida,
  mensajeNoBancarioOtraMoneda,
  montoNota,
  quitarNotasVinculoNoBancario,
  refGastoNota,
  tieneNotasVinculoNoBancario,
  type CargoDeNota,
  type FirmaVinculo,
  type GastoDeNota,
} from './vinculo-no-bancario.util';

/**
 * Gasto NO bancario ligado a un cargo con justificación (6-oct-2026, API
 * 0.0.63). Caso REAL de prod: cargo de $212.00 del 07-sep (ASUR CANCUN,
 * GASTOS GNRAL) que «ningún piloto subió»; se liga al estacionamiento
 * facturado del 28-sep (EFECTIVO, vuelo #330) SIN cambiar el medio de pago.
 */
const RAZON =
  'Nadie capturó el estacionamiento del 7 de septiembre; se usa el ticket facturado del 28 para no perder la deducción.';

const FIRMA: FirmaVinculo = {
  justificacion: RAZON,
  usuario: 'Mari',
  hoy: '2026-10-06',
};

const GASTO_28: GastoDeNota = {
  id: '3f9a1c2e-5b7d-4e21-9c0a-2d8e6f4b1a30',
  fecha_gasto: '2026-09-28',
  monto: 212,
  moneda: 'MXN',
  medio_pago: 'EFECTIVO',
  categoria: 'TAXI',
  vuelo_folio: 330,
};

const CARGO_07: CargoDeNota = {
  fecha: '2026-09-07',
  monto: 212,
  moneda: 'MXN',
  descripcion: 'ASUR CANCUN',
};

/** El estacionamiento del 27-sep (otro gasto: otra referencia). */
const GASTO_27: GastoDeNota = {
  ...GASTO_28,
  id: 'a1b2c3d4-0e0f-4a1b-8c2d-3e4f5a6b7c8d',
  fecha_gasto: '2026-09-27',
};

const LINEA_CARGO = `Vinculado a gasto en EFECTIVO del 28-sep-2026 (Taxi / estacionamiento · vuelo #330 · $212.00 · gasto 3f9a1c2e): ${RAZON} — Mari, 06-oct-2026`;
const LINEA_GASTO = `⚠ Conciliado con el cargo bancario del 07-sep-2026 ($212.00 · ASUR CANCUN) sin cambiar el medio de pago (EFECTIVO): ${RAZON} — Mari, 06-oct-2026`;

/** La limpieza del desglose del panel (`expense-verify-dialog.tsx`). */
const limpiarDesgloseDelPanel = (notas: string): string =>
  notas.replace(/(^|\n)Desglose:\n(?:[^\n]+\n?)*/g, '$1');

describe('las dos líneas — caso real ($212.00 del 07-sep ↔ estacionamiento del 28-sep)', () => {
  it('línea del CARGO, exacta', () => {
    expect(lineaNotaCargo(GASTO_28, FIRMA)).toBe(LINEA_CARGO);
  });

  it('línea del GASTO, exacta', () => {
    expect(lineaNotaGasto(CARGO_07, 'EFECTIVO', FIRMA)).toBe(LINEA_GASTO);
  });

  it('las dos son reconocibles como del vínculo; un texto de la oficina, no', () => {
    expect(esLineaVinculoNoBancario(LINEA_CARGO)).toBe(true);
    expect(esLineaVinculoNoBancario(`  ${LINEA_GASTO}  `)).toBe(true);
    expect(
      esLineaVinculoNoBancario(
        'Aeropuerto de Cancún S.A de C.V. · Cobro estancia (estacionamiento)',
      ),
    ).toBe(false);
    expect(
      esLineaVinculoNoBancario('⚠ total capturado $212.00 — revisar'),
    ).toBe(false);
  });

  it('sin vuelo, en dólares, PERSONAL_* y sin firmante', () => {
    expect(
      lineaNotaCargo(
        {
          ...GASTO_28,
          vuelo_folio: null,
          moneda: 'USD',
          monto: 1234.5,
          medio_pago: 'PERSONAL_PABLO',
          categoria: 'HOTEL',
        },
        { ...FIRMA, usuario: '  ' },
      ),
    ).toBe(
      `Vinculado a gasto en PERSONAL PABLO del 28-sep-2026 (Hotel · $1,234.50 USD · gasto 3f9a1c2e): ${RAZON} — Oficina, 06-oct-2026`,
    );
    expect(
      lineaNotaGasto(
        { ...CARGO_07, moneda: 'USD', descripcion: null },
        'PERSONAL_ALE',
        FIRMA,
      ),
    ).toBe(
      `⚠ Conciliado con el cargo bancario del 07-sep-2026 ($212.00 USD) sin cambiar el medio de pago (PERSONAL ALE): ${RAZON} — Mari, 06-oct-2026`,
    );
  });

  it('la justificación y la leyenda viajan en UNA línea; la leyenda larga se recorta', () => {
    const l = lineaNotaGasto(
      { ...CARGO_07, descripcion: `ASUR\n  CANCUN ${'X'.repeat(120)}` },
      'EFECTIVO',
      {
        ...FIRMA,
        justificacion: 'Primera línea\n\nsegunda   línea de la razón',
      },
    );
    expect(l).not.toContain('\n');
    expect(l).toContain(': Primera línea segunda línea de la razón — Mari');
    expect(l).toContain('($212.00 · ASUR CANCUN XXX');
    expect(l).toContain('…) sin cambiar el medio de pago');
    expect(esLineaVinculoNoBancario(l)).toBe(true);
  });
});

describe('formatos', () => {
  it('fechaNota dd-mmm-aaaa cortando el texto; fechaMensaje dd mmm', () => {
    expect(fechaNota('2026-09-07')).toBe('07-sep-2026');
    expect(fechaNota('2026-10-06T23:30:00-05:00')).toBe('06-oct-2026');
    expect(fechaNota(null)).toBe('sin fecha');
    expect(fechaNota('2026-13-01')).toBe('sin fecha');
    expect(fechaMensaje('2026-09-28')).toBe('28 sep');
    expect(fechaMensaje(undefined)).toBe('sin fecha');
  });

  it('montoNota: 2 decimales, miles, |monto| y sufijo fuera de pesos', () => {
    expect(montoNota(212)).toBe('$212.00');
    expect(montoNota(-8404.2, 'MXN')).toBe('$8,404.20');
    expect(montoNota(1234567.891, 'USD')).toBe('$1,234,567.89 USD');
  });

  it('medioNota con la etiqueta de siempre, en mayúsculas', () => {
    expect(medioNota('EFECTIVO')).toBe('EFECTIVO');
    expect(medioNota('PERSONAL_PABLO')).toBe('PERSONAL PABLO');
    expect(medioNota('TARJETA_CORP')).toBe('TARJETA CORPORATIVA');
    expect(medioNota(null)).toBe('SIN MEDIO');
  });

  it(`limpiarJustificacion: una línea y ≤ ${JUSTIFICACION_MAX}`, () => {
    expect(limpiarJustificacion('  hola\n\tmundo  ')).toBe('hola mundo');
    expect(limpiarJustificacion(null)).toBe('');
    expect(limpiarJustificacion('a'.repeat(400))).toHaveLength(
      JUSTIFICACION_MAX,
    );
  });
});

describe('agregarNotaVinculo — idempotente y sin pisar nada', () => {
  it('sin notas ⇒ la línea sola', () => {
    expect(agregarNotaVinculo(null, LINEA_GASTO)).toBe(LINEA_GASTO);
    expect(agregarNotaVinculo('   \n', LINEA_GASTO)).toBe(LINEA_GASTO);
  });

  it('con notas ⇒ al FINAL, tras un renglón en blanco (lo de la oficina intacto)', () => {
    const previas =
      'Aeropuerto de Cancún S.A de C.V. · Cobro estancia (estacionamiento)';
    expect(agregarNotaVinculo(previas, LINEA_GASTO)).toBe(
      `${previas}\n\n${LINEA_GASTO}`,
    );
  });

  it('la misma línea dos veces NO se duplica', () => {
    const una = agregarNotaVinculo('Nota de la oficina', LINEA_CARGO);
    expect(agregarNotaVinculo(una, LINEA_CARGO)).toBe(una);
  });

  it('el MISMO par con otra razón (o del día siguiente) se reemplaza en su lugar', () => {
    const una = agregarNotaVinculo('Nota de la oficina', LINEA_CARGO);
    const otra = lineaNotaCargo(GASTO_28, {
      ...FIRMA,
      justificacion: 'Otra razón más precisa para ligarlo',
      hoy: '2026-10-07',
    });
    const r = agregarNotaVinculo(`${una}\nY algo que escribió después`, otra);
    expect(r).toBe(
      `Nota de la oficina\n\n${otra}\nY algo que escribió después`,
    );
    // Aunque la oficina haya corregido el medio después, es el mismo par.
    const conOtroMedio = lineaNotaCargo(
      { ...GASTO_28, medio_pago: 'PERSONAL_PABLO' },
      FIRMA,
    );
    expect(agregarNotaVinculo(una, conOtroMedio)).toBe(
      `Nota de la oficina\n\n${conOtroMedio}`,
    );
  });

  it('dos pares distintos: renglón seguido entre ellos', () => {
    const otroGasto = lineaNotaCargo(GASTO_27, FIRMA);
    const r = agregarNotaVinculo(
      agregarNotaVinculo('Nota de la oficina', LINEA_CARGO),
      otroGasto,
    );
    expect(r).toBe(`Nota de la oficina\n\n${LINEA_CARGO}\n${otroGasto}`);
  });

  it('pegada al bloque «Desglose:» la limpieza del panel NO se la lleva', () => {
    const notas =
      'Aeropuerto de Cancún S.A de C.V. (ASUR) · Cobro estancia (estacionamiento de aeronave)\n\nDesglose:\nCobro estancia (base) - $182.76 MXN\nIVA 16% - $29.24 MXN';
    const con = agregarNotaVinculo(notas, LINEA_GASTO);
    expect(limpiarDesgloseDelPanel(con)).toContain(LINEA_GASTO);
  });

  it('dos gastos IGUALES en un lote (mismo día, categoría, vuelo y monto): UNA línea POR GASTO', () => {
    // Revisión 6-oct-2026: con fecha · detalle como llave compartían línea.
    const gemelo: GastoDeNota = {
      ...GASTO_28,
      id: '0c4d5e6f-1a2b-4c3d-8e9f-a0b1c2d3e4f5',
    };
    const r = agregarNotaVinculo(
      agregarNotaVinculo(null, LINEA_CARGO),
      lineaNotaCargo(gemelo, FIRMA),
    );
    expect(r).toBe(`${LINEA_CARGO}\n${lineaNotaCargo(gemelo, FIRMA)}`);
    expect(r).toContain('· gasto 3f9a1c2e)');
    expect(r).toContain('· gasto 0c4d5e6f)');
  });

  it('el MISMO gasto con categoría, vuelo, fecha o monto corregidos después: es el mismo par (se reemplaza)', () => {
    const una = agregarNotaVinculo('Nota de la oficina', LINEA_CARGO);
    const corregido = lineaNotaCargo(
      {
        ...GASTO_28,
        categoria: 'OPERACIONES',
        vuelo_folio: 338,
        fecha_gasto: '2026-09-29',
        monto: 211.5,
      },
      FIRMA,
    );
    expect(agregarNotaVinculo(una, corregido)).toBe(
      `Nota de la oficina\n\n${corregido}`,
    );
  });

  it('respeta lo de la oficina: blancos del final después de la línea y su fin de línea (\\r\\n)', () => {
    expect(
      agregarNotaVinculo('Línea 1\n\n\n\nLínea 2  \n\n', LINEA_GASTO),
    ).toBe(`Línea 1\n\n\n\nLínea 2  \n\n${LINEA_GASTO}\n\n`);
    expect(agregarNotaVinculo('A\r\nB', LINEA_GASTO)).toBe(
      `A\r\nB\r\n\r\n${LINEA_GASTO}`,
    );
    // Reemplazar la razón en su lugar no toca los \r\n de alrededor.
    const otra = lineaNotaCargo(GASTO_28, {
      ...FIRMA,
      justificacion: 'Otra razón más precisa para ligarlo',
    });
    expect(agregarNotaVinculo(`A\r\n\r\n${LINEA_CARGO}\r\nB`, otra)).toBe(
      `A\r\n\r\n${otra}\r\nB`,
    );
  });
});

describe('quitarNotasVinculoNoBancario — al desvincular, en los dos lados', () => {
  it('sin filtro: fuera TODAS las líneas del vínculo; lo de la oficina intacto', () => {
    const otroGasto = lineaNotaCargo(GASTO_27, FIRMA);
    const notas = `Nota de la oficina\n\n${LINEA_CARGO}\n${otroGasto}`;
    expect(quitarNotasVinculoNoBancario(notas)).toBe('Nota de la oficina');
  });

  it('solo la línea ⇒ null; sin líneas del vínculo ⇒ IDÉNTICAS (ni el espaciado cambia)', () => {
    expect(quitarNotasVinculoNoBancario(LINEA_GASTO)).toBeNull();
    const raras = 'Línea 1\n\n\n\nLínea 2  \n';
    expect(quitarNotasVinculoNoBancario(raras)).toBe(raras);
    expect(quitarNotasVinculoNoBancario(null)).toBeNull();
    expect(quitarNotasVinculoNoBancario(undefined)).toBeNull();
  });

  it('agregar y luego quitar devuelve las notas de antes', () => {
    const previas =
      'Aeropuerto de Cancún S.A de C.V. · Cobro estancia (estacionamiento)';
    expect(
      quitarNotasVinculoNoBancario(agregarNotaVinculo(previas, LINEA_GASTO)),
    ).toBe(previas);
  });

  it('agregar y quitar es exacto byte a byte: renglones en blanco, espacios finales y \\r\\n de la oficina', () => {
    // Revisión 6-oct-2026: antes quedaba «Línea 1\\n\\nLínea 2» (regex global + trim).
    for (const previas of [
      'Línea 1\n\n\n\nLínea 2  \n\n',
      'A\r\nB',
      'A\r\n\r\n\r\nB\r\n',
      '  sangría\n\tcon tab\n',
      'Desglose:\nCobro estancia (base) - $182.76 MXN\nIVA 16% - $29.24 MXN',
    ]) {
      const con = agregarNotaVinculo(previas, LINEA_GASTO);
      expect(quitarNotasVinculoNoBancario(con)).toBe(previas);
      expect(quitarNotasVinculoNoBancario(con, { cargo: CARGO_07 })).toBe(
        previas,
      );
      const enCargo = agregarNotaVinculo(
        agregarNotaVinculo(previas, LINEA_CARGO),
        lineaNotaCargo(GASTO_27, FIRMA),
      );
      expect(quitarNotasVinculoNoBancario(enCargo)).toBe(previas);
      // Soltar uno y luego el otro también regresa a lo de antes.
      const sinUno = quitarNotasVinculoNoBancario(enCargo, {
        gastoId: GASTO_28.id,
      });
      expect(sinUno).toBe(
        agregarNotaVinculo(previas, lineaNotaCargo(GASTO_27, FIRMA)),
      );
      expect(
        quitarNotasVinculoNoBancario(sinUno, { gastoId: GASTO_27.id }),
      ).toBe(previas);
    }
  });

  it('los renglones en blanco de la oficina FUERA del bloque no se tocan', () => {
    const notas = `Arriba\n\n\n\nMedio\n\n${LINEA_CARGO}\n\nAbajo  `;
    expect(quitarNotasVinculoNoBancario(notas)).toBe(
      'Arriba\n\n\n\nMedio\n\nAbajo  ',
    );
  });

  it('soltar UNO de dos gastos iguales deja la línea del que sigue ligado', () => {
    const gemelo: GastoDeNota = {
      ...GASTO_28,
      id: '0c4d5e6f-1a2b-4c3d-8e9f-a0b1c2d3e4f5',
    };
    const notas = `${LINEA_CARGO}\n${lineaNotaCargo(gemelo, FIRMA)}`;
    expect(quitarNotasVinculoNoBancario(notas, { gastoId: GASTO_28.id })).toBe(
      lineaNotaCargo(gemelo, FIRMA),
    );
  });

  it('con `gastoId`: la línea se reconoce aunque al gasto le hayan corregido categoría, vuelo, fecha o monto', () => {
    // La línea se escribió con los datos de entonces; hoy el gasto dice otra cosa.
    expect(
      quitarNotasVinculoNoBancario(`Nota\n\n${LINEA_CARGO}`, {
        gastoId: GASTO_28.id,
      }),
    ).toBe('Nota');
    // Un uuid en MAYÚSCULAS es el mismo gasto.
    expect(
      quitarNotasVinculoNoBancario(`Nota\n\n${LINEA_CARGO}`, {
        gastoId: GASTO_28.id.toUpperCase(),
      }),
    ).toBe('Nota');
    expect(refGastoNota(GASTO_28.id)).toBe('3f9a1c2e');
    expect(refGastoNota('  g-28 ')).toBe('g-28');
    expect(refGastoNota(null)).toBe('');
  });

  it('en el GASTO, con `cargo`: solo la línea de ESE cargo (pago en dos cargos)', () => {
    const otroCargo = lineaNotaGasto(
      { ...CARGO_07, fecha: '2026-09-09', monto: 100 },
      'EFECTIVO',
      FIRMA,
    );
    const notas = `Ticket ASUR\n\n${LINEA_GASTO}\n${otroCargo}`;
    expect(quitarNotasVinculoNoBancario(notas, { cargo: CARGO_07 })).toBe(
      `Ticket ASUR\n\n${otroCargo}`,
    );
    // Otro cargo que no está anotado: nada cambia.
    expect(
      quitarNotasVinculoNoBancario(notas, {
        cargo: { ...CARGO_07, descripcion: 'OTRA LEYENDA' },
      }),
    ).toBe(notas);
  });

  it('en el CARGO, con `gasto`: solo la línea de ESE gasto (lote)', () => {
    const otroGasto = lineaNotaCargo(GASTO_27, FIRMA);
    const notas = `${LINEA_CARGO}\n${otroGasto}`;
    expect(quitarNotasVinculoNoBancario(notas, { gastoId: GASTO_28.id })).toBe(
      otroGasto,
    );
    // Un id que no está anotado: nada cambia.
    expect(
      quitarNotasVinculoNoBancario(notas, { gastoId: 'ffffffff-0000' }),
    ).toBe(notas);
    // Un id VACÍO es un filtro que no nombra a nadie: jamás «borra todo».
    expect(quitarNotasVinculoNoBancario(notas, { gastoId: '' })).toBe(notas);
    expect(quitarNotasVinculoNoBancario(notas, { gastoId: '   ' })).toBe(notas);
  });

  it('regex de la forma EXACTA: razones con «—», «): » o paréntesis; categorías con paréntesis', () => {
    const rara = lineaNotaCargo(
      { ...GASTO_28, categoria: 'PILOTO_EXTERNO' },
      {
        ...FIRMA,
        justificacion: 'Pago (ver ticket): el piloto — Juan — lo dejó así',
      },
    );
    expect(rara).toContain('(Piloto externo (honorario) · vuelo #330');
    expect(esLineaVinculoNoBancario(rara)).toBe(true);
    expect(
      quitarNotasVinculoNoBancario(`Nota\n\n${rara}`, {
        gastoId: GASTO_28.id,
      }),
    ).toBe('Nota');
    const leyenda = lineaNotaGasto(
      { ...CARGO_07, descripcion: 'PAGO (SPEI) ASUR' },
      'EFECTIVO',
      FIRMA,
    );
    expect(
      quitarNotasVinculoNoBancario(leyenda, {
        cargo: { ...CARGO_07, descripcion: 'PAGO (SPEI) ASUR' },
      }),
    ).toBeNull();
  });

  it('tieneNotasVinculoNoBancario: solo con una línea del vínculo', () => {
    expect(tieneNotasVinculoNoBancario(`Nota\n\n${LINEA_GASTO}`)).toBe(true);
    expect(tieneNotasVinculoNoBancario(LINEA_CARGO)).toBe(true);
    expect(tieneNotasVinculoNoBancario('⚠ total capturado — revisar')).toBe(
      false,
    );
    expect(tieneNotasVinculoNoBancario(null)).toBe(false);
  });

  it('compacta SOLO los renglones en blanco que dejó el retiro', () => {
    const notas = `Arriba\n\n${LINEA_CARGO}\n\nAbajo`;
    expect(quitarNotasVinculoNoBancario(notas)).toBe('Arriba\n\nAbajo');
  });
});

describe('mensajes de error', () => {
  it('400 JUSTIFICACION_REQUERIDA: uno, varios del mismo medio, mezcla y muchos', () => {
    expect(
      mensajeJustificacionRequerida([
        { fecha_gasto: '2026-09-28', medio_pago: 'EFECTIVO' },
      ]),
    ).toBe(
      'El gasto del 28 sep está en efectivo: para vincularlo a un cargo del banco escribe por qué (no cambia el medio de pago).',
    );
    expect(
      mensajeJustificacionRequerida([
        { fecha_gasto: '2026-09-27', medio_pago: 'EFECTIVO' },
        { fecha_gasto: '2026-09-28', medio_pago: 'EFECTIVO' },
      ]),
    ).toBe(
      'Los gastos del 27 sep y 28 sep están en efectivo: para vincularlos a un cargo del banco escribe por qué (no cambia el medio de pago).',
    );
    expect(
      mensajeJustificacionRequerida([
        { fecha_gasto: '2026-09-07', medio_pago: 'EFECTIVO' },
        { fecha_gasto: '2026-09-20', medio_pago: 'PERSONAL_PABLO' },
      ]),
    ).toBe(
      'Los gastos del 07 sep (en efectivo) y 20 sep (en «Personal Pablo») no se pagaron con el banco: para vincularlos a un cargo del banco escribe por qué (no cambia el medio de pago).',
    );
    expect(
      mensajeJustificacionRequerida(
        ['01', '02', '03', '04', '05'].map((d) => ({
          fecha_gasto: `2026-09-${d}`,
          medio_pago: 'EFECTIVO',
        })),
      ),
    ).toContain(
      'Los gastos del 01 sep, 02 sep, 03 sep y 2 más están en efectivo',
    );
    expect(mensajeJustificacionRequerida([])).toContain('escribe por qué');
  });

  it('409 GASTO_BODEGA: uno y varios', () => {
    expect(mensajeGastoBodega([{ fecha_gasto: '2026-09-15' }])).toBe(
      'El gasto del 15 sep es una salida de inventario (Bodega): no se pagó con el banco y no se puede vincular a un cargo.',
    );
    expect(
      mensajeGastoBodega([
        { fecha_gasto: '2026-09-15' },
        { fecha_gasto: '2026-09-16' },
      ]),
    ).toBe(
      'Los gastos del 15 sep y 16 sep son salidas de inventario (Bodega): no se pagaron con el banco y no se pueden vincular a un cargo.',
    );
  });

  it('409 NO_BANCARIO_OTRA_MONEDA: uno y varios', () => {
    expect(
      mensajeNoBancarioOtraMoneda(
        [{ fecha_gasto: '2026-09-21', moneda: 'USD' }],
        'MXN',
      ),
    ).toBe(
      'El gasto del 21 sep está en USD y no se pagó con el banco: solo se puede vincular a un cargo de su misma moneda (este cargo es de una cuenta en MXN), para no cambiarle el tipo de cambio.',
    );
    expect(
      mensajeNoBancarioOtraMoneda(
        [
          { fecha_gasto: '2026-09-21', moneda: 'USD' },
          { fecha_gasto: '2026-09-22', moneda: null },
        ],
        null,
      ),
    ).toBe(
      'Los gastos del 21 sep y 22 sep están en otra moneda y no se pagaron con el banco: solo se pueden vincular a un cargo de su misma moneda, para no cambiarles el tipo de cambio.',
    );
  });
});
