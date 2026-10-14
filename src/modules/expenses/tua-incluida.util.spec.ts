import {
  CODIGO_TUA_INCLUIDA,
  MENSAJE_TUA_INCLUIDA_NO_DISPONIBLE,
  celdasTuaExcel,
  decidirTuaIncluidaEnUpdate,
  errorTuaIncluidaAlta,
  mensajeTuaMayorQueTicket,
  mensajeTuaNoAplica,
  mensajeTuaVigenteMayorQueTicket,
} from './tua-incluida.util';

/**
 * «TUA incluida en este gasto» (13-oct-2026, TUA sistémica, invariante 66):
 * textos EXACTOS (el panel los copia), la regla del alta y la tabla de
 * decisiones del PATCH.
 */
describe('textos exactos', () => {
  it('MAYOR_QUE_TICKET, vigente, NO_APLICA y NO_DISPONIBLE', () => {
    expect(mensajeTuaMayorQueTicket(600, 559.63, 'MXN')).toBe(
      'La TUA incluida ($600 MXN) no puede ser mayor que el monto del ticket ($559.63 MXN, sin propina).',
    );
    expect(mensajeTuaVigenteMayorQueTicket(559.63, 500, 'MXN')).toBe(
      'Este gasto tiene una TUA incluida de $559.63 MXN fijada por la oficina y el nuevo monto del ticket ($500 MXN, sin propina) es menor: corrige o vacía «TUA incluida en este gasto» en el mismo guardado.',
    );
    expect(mensajeTuaNoAplica('COMIDA')).toBe(
      'La categoría «Comida» no lleva TUA incluida: solo las facturas de aeropuerto (Operaciones, Aterrizaje o FBO). Déjala vacía o cambia la categoría.',
    );
    expect(MENSAJE_TUA_INCLUIDA_NO_DISPONIBLE).toBe(
      'La TUA incluida todavía no se puede guardar: falta aplicar la migración 20261013000008. Mientras tanto la TUA se separa solo con la lectura de la IA.',
    );
    expect(CODIGO_TUA_INCLUIDA).toEqual({
      MAYOR_QUE_TICKET: 'TUA_INCLUIDA_MAYOR_QUE_TICKET',
      NO_APLICA: 'TUA_INCLUIDA_NO_APLICA',
      NO_DISPONIBLE: 'TUA_INCLUIDA_NO_DISPONIBLE',
    });
  });
});

describe('errorTuaIncluidaAlta', () => {
  const base = { propina: 0, moneda: 'MXN' };

  it('null, undefined y 0 nunca son error (0 = «sin TUA»)', () => {
    for (const tua of [null, undefined, 0]) {
      expect(
        errorTuaIncluidaAlta({
          ...base,
          tua,
          monto: 100,
          categoria: 'COMIDA',
        }),
      ).toBeNull();
    }
  });

  it('COMIDA con 10 ⇒ NO_APLICA con la categoría', () => {
    expect(
      errorTuaIncluidaAlta({
        ...base,
        tua: 10,
        monto: 500,
        categoria: 'COMIDA',
      }),
    ).toEqual({
      message: mensajeTuaNoAplica('COMIDA'),
      error: 'TUA_INCLUIDA_NO_APLICA',
      details: { categoria: 'COMIDA' },
    });
  });

  it('OPERACIONES 600 sobre un ticket de 559.63 ⇒ MAYOR_QUE_TICKET (vigente false)', () => {
    expect(
      errorTuaIncluidaAlta({
        ...base,
        tua: 600,
        monto: 559.63,
        categoria: 'OPERACIONES',
      }),
    ).toEqual({
      message:
        'La TUA incluida ($600 MXN) no puede ser mayor que el monto del ticket ($559.63 MXN, sin propina).',
      error: 'TUA_INCLUIDA_MAYOR_QUE_TICKET',
      details: {
        tua_incluida: 600,
        base: 559.63,
        moneda: 'MXN',
        vigente: false,
      },
    });
  });

  it('la propina sale de la base: 559.63 con monto 600 y propina 50 ⇒ MAYOR (base 550)', () => {
    const e = errorTuaIncluidaAlta({
      tua: 559.63,
      monto: 600,
      propina: 50,
      categoria: 'OPERACIONES',
      moneda: 'MXN',
    });
    expect(e?.error).toBe('TUA_INCLUIDA_MAYOR_QUE_TICKET');
    expect(e?.details.base).toBe(550);
  });

  it('igual a la base ⇒ sin error (ATERRIZAJE y FBO también la admiten)', () => {
    for (const categoria of ['OPERACIONES', 'ATERRIZAJE', 'FBO']) {
      expect(
        errorTuaIncluidaAlta({ ...base, tua: 500, monto: 500, categoria }),
      ).toBeNull();
    }
  });

  it('la categoría se revisa ANTES que el importe: COMIDA 600 sobre 500 ⇒ NO_APLICA', () => {
    expect(
      errorTuaIncluidaAlta({
        ...base,
        tua: 600,
        monto: 500,
        categoria: 'COMIDA',
      })?.error,
    ).toBe('TUA_INCLUIDA_NO_APLICA');
  });
});

describe('decidirTuaIncluidaEnUpdate — tabla de decisiones', () => {
  const op = {
    categoria: 'OPERACIONES',
    monto: 500,
    propina: 0,
    moneda: 'MXN',
    monedaCambio: false,
    esCampo: false,
  };

  it.each([
    ['sin llave y sin vigente', { enviado: undefined, vigente: null }],
    [
      'sin llave, vigente 100 cabe en 500',
      { enviado: undefined, vigente: 100 },
    ],
    [
      'sin llave, vigente 0 en COMIDA (un 0 nunca se limpia)',
      { enviado: undefined, vigente: 0, categoria: 'COMIDA' },
    ],
    ['null (volver a la IA)', { enviado: null, vigente: 100 }],
    ['0 en COMIDA', { enviado: 0, vigente: null, categoria: 'COMIDA' }],
  ])('%s ⇒ NADA', (_n, caso) => {
    expect(decidirTuaIncluidaEnUpdate({ ...op, ...caso })).toEqual({
      accion: 'NADA',
    });
  });

  it('reclasificar fuera de la lista con vigente 100 ⇒ LIMPIAR CATEGORIA (campo y oficina)', () => {
    for (const esCampo of [false, true]) {
      expect(
        decidirTuaIncluidaEnUpdate({
          ...op,
          enviado: undefined,
          vigente: 100,
          categoria: 'COMIDA',
          esCampo,
        }),
      ).toEqual({ accion: 'LIMPIAR', motivo: 'CATEGORIA' });
    }
  });

  it('cambiar la moneda con vigente 100 ⇒ LIMPIAR MONEDA', () => {
    expect(
      decidirTuaIncluidaEnUpdate({
        ...op,
        enviado: undefined,
        vigente: 100,
        monedaCambio: true,
      }),
    ).toEqual({ accion: 'LIMPIAR', motivo: 'MONEDA' });
  });

  it('vigente 600 sobre base 500: campo ⇒ LIMPIAR MONTO; oficina ⇒ ERROR con vigente true', () => {
    expect(
      decidirTuaIncluidaEnUpdate({
        ...op,
        enviado: undefined,
        vigente: 600,
        esCampo: true,
      }),
    ).toEqual({ accion: 'LIMPIAR', motivo: 'MONTO' });
    const d = decidirTuaIncluidaEnUpdate({
      ...op,
      enviado: undefined,
      vigente: 600,
    });
    expect(d).toEqual({
      accion: 'ERROR',
      error: {
        message: mensajeTuaVigenteMayorQueTicket(600, 500, 'MXN'),
        error: 'TUA_INCLUIDA_MAYOR_QUE_TICKET',
        details: { tua_incluida: 600, base: 500, moneda: 'MXN', vigente: true },
      },
    });
  });

  it('con la llave: las MISMAS reglas que el alta', () => {
    const noAplica = decidirTuaIncluidaEnUpdate({
      ...op,
      enviado: 50,
      vigente: null,
      categoria: 'COMIDA',
    });
    expect(noAplica.accion).toBe('ERROR');
    expect(noAplica.accion === 'ERROR' ? noAplica.error.error : null).toBe(
      'TUA_INCLUIDA_NO_APLICA',
    );
    const mayor = decidirTuaIncluidaEnUpdate({
      ...op,
      enviado: 600,
      vigente: null,
    });
    expect(mayor.accion === 'ERROR' ? mayor.error.error : null).toBe(
      'TUA_INCLUIDA_MAYOR_QUE_TICKET',
    );
    expect(mayor.accion === 'ERROR' ? mayor.error.details.vigente : null).toBe(
      false,
    );
  });
});

describe('celdasTuaExcel', () => {
  const g = {
    vuelo_id: 'v-1',
    categoria: 'OPERACIONES',
    monto: '1925.27',
    propina: '0.00',
    valor_ia_extraido: {
      conceptos: [
        { concepto: 'Operaciones', monto: 1365.64 },
        { concepto: 'Tarifa TUA', monto: 559.63 },
      ],
    },
  };

  it('override 700 ⇒ [700, Oficina]; override 0 ⇒ [0, Oficina]', () => {
    expect(celdasTuaExcel({ ...g, tua_incluida: '700.00' })).toEqual([
      700,
      'Oficina',
    ]);
    expect(celdasTuaExcel({ ...g, tua_incluida: 0 })).toEqual([0, 'Oficina']);
  });

  it('lectura de la IA ⇒ [559.63, IA]', () => {
    expect(celdasTuaExcel(g)).toEqual([559.63, 'IA']);
  });

  it('nada que separar ⇒ [null, ""]; COMIDA tampoco separa', () => {
    expect(celdasTuaExcel({ ...g, valor_ia_extraido: null })).toEqual([
      null,
      '',
    ]);
    expect(celdasTuaExcel({ ...g, categoria: 'COMIDA' })).toEqual([null, '']);
  });
});
