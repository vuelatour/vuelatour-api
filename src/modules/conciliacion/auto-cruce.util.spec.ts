import {
  CLASIFICACION_TRASPASO,
  claveBucket,
  elegirCandidato,
  elegirMovimiento,
  emparejarDuplicados,
  montoCasa,
  normalizarTextoBanco,
  patronTraspaso,
  primeraLinea,
  puntuarDescripcion,
  terminacionDeMovimiento,
  tokensTexto,
  ventanaDias,
  type GastoCandidatoCruce,
} from './auto-cruce.util';

/**
 * Casos REALES del Scotiabank MXN «GASTOS GNRAL» (semana 7-13 sep 2026),
 * que es donde 44 de 67 movimientos quedaron pendientes. Aquí se congela la
 * regla: el auto-cruce liga solo lo INEQUÍVOCO; lo demás queda pendiente
 * con motivo, nunca ligado a la brava.
 */

// Catálogo real de tarjeta_corporativa (terminaciones activas).
const TARJETAS = ['0577', '0585', '6256', '0572', '0505', '6231', '2865'];

describe('terminacionDeMovimiento — la tarjeta solo cuenta si existe', () => {
  it('toma los últimos 4 dígitos de una referencia numérica del banco', () => {
    expect(terminacionDeMovimiento('0025830577', null, TARJETAS)).toBe('0577');
    expect(terminacionDeMovimiento('9155656256', null, TARJETAS)).toBe('6256');
  });

  it('NO inventa tarjeta con la referencia de 6 dígitos del 15-sep', () => {
    expect(terminacionDeMovimiento('174465', null, TARJETAS)).toBeNull();
    // Corta pero terminada como una tarjeta real: sigue sin contar (azar).
    expect(terminacionDeMovimiento('830577', null, TARJETAS)).toBeNull();
    // Ocho dígitos ya es una referencia de tarjeta.
    expect(terminacionDeMovimiento('12340577', null, TARJETAS)).toBe('0577');
  });

  it('ignora referencias que no son puramente numéricas o muy cortas', () => {
    expect(terminacionDeMovimiento('ABC0577', null, TARJETAS)).toBeNull();
    expect(terminacionDeMovimiento('577', null, TARJETAS)).toBeNull();
    expect(terminacionDeMovimiento(null, null, TARJETAS)).toBeNull();
  });

  it('lee la tarjeta marcada en la descripción (*0585 / TDC 0585)', () => {
    expect(terminacionDeMovimiento(null, 'COMPRA *0585', TARJETAS)).toBe(
      '0585',
    );
    expect(terminacionDeMovimiento(null, 'TDC 0585 ASUR', TARJETAS)).toBe(
      '0585',
    );
  });

  it('un número suelto en la leyenda NO es una tarjeta', () => {
    expect(terminacionDeMovimiento(null, 'ASUR CANCUN 0585', TARJETAS)).toBe(
      null,
    );
  });

  it('dos terminaciones distintas en el mismo movimiento = ambiguo', () => {
    expect(terminacionDeMovimiento('0025830577', '*6256', TARJETAS)).toBeNull();
  });

  it('sin catálogo de tarjetas no hay desempate posible', () => {
    expect(terminacionDeMovimiento('0025830577', null, [])).toBeNull();
  });
});

describe('normalización de la leyenda del banco', () => {
  it('quita acentos, mayúsculas y prefijos de agregador', () => {
    expect(normalizarTextoBanco('MERPAGO*AGREGADOR')).toBe('AGREGADOR');
    expect(normalizarTextoBanco('PINPE*MONOLOTIK TPV')).toBe('MONOLOTIK TPV');
    expect(normalizarTextoBanco('EC DE CHETUMAL')).toBe('DE CHETUMAL');
    expect(normalizarTextoBanco('Aeropuerto de Cozumel')).toBe(
      'AEROPUERTO DE COZUMEL',
    );
  });

  it('los tokens tiran muletillas y números sueltos', () => {
    expect(tokensTexto('A I DE CHETUMAL 1234')).toEqual(['CHETUMAL']);
    expect(tokensTexto('GOB EDO DE QROO')).toEqual(['GOB', 'EDO', 'QROO']);
  });

  it('primeraLinea toma solo el renglón que describe el gasto', () => {
    expect(primeraLinea('Aeropuerto de Cozumel\nOperación: 125.82')).toBe(
      'Aeropuerto de Cozumel',
    );
  });
});

describe('puntuarDescripcion — sinónimos del giro', () => {
  it('ASUR CANCUN empata con «Aeropuerto de Cancún»', () => {
    expect(
      puntuarDescripcion('ASUR CANCUN', { lugar: 'Aeropuerto de Cancún' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('ASUR MERIDA NO empata con «Aeropuerto de Cancún» (veto por ciudad)', () => {
    expect(
      puntuarDescripcion('ASUR MERIDA', { lugar: 'Aeropuerto de Cancún' }),
    ).toBe(0);
    expect(
      puntuarDescripcion('ASUR MERIDA', { lugar: 'Aeropuerto de Mérida' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('AEROPUERTO DE COZUMEL empata con la primera línea de las notas', () => {
    expect(
      puntuarDescripcion('AEROPUERTO DE COZUMEL', {
        notas: 'Aeropuerto de Cozumel\nTUA y operación',
      }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('un solo token en común (PISTA) nunca alcanza el umbral', () => {
    expect(
      puntuarDescripcion('PISTA MONTERREY', { notas: 'Pista' }),
    ).toBeLessThan(0.6);
  });

  it('VETO por ciudad: ASA MERIDA no es la carga de ASA Cancún', () => {
    expect(puntuarDescripcion('ASA MERIDA', { lugar: 'ASA Cancún' })).toBe(0);
    expect(
      puntuarDescripcion('ASA MERIDA', { lugar: 'ASA Mérida' }),
    ).toBeGreaterThanOrEqual(0.6);
  });

  it('textos que no se parecen valen 0', () => {
    expect(
      puntuarDescripcion('GOB EDO DE QROO', { lugar: 'Aeropuerto de Cozumel' }),
    ).toBe(0);
  });
});

describe('elegirCandidato — liga solo lo inequívoco', () => {
  const cozumelA: GastoCandidatoCruce = {
    id: 'g-cozumel-a',
    monto: 125.82,
    tarjeta_terminacion: '0577',
    lugar: 'Aeropuerto de Cozumel',
  };
  const cozumelB: GastoCandidatoCruce = {
    id: 'g-cozumel-b',
    monto: 125.82,
    tarjeta_terminacion: '6256',
    lugar: 'Aeropuerto de Cozumel',
  };

  it('candidato único = se liga por monto', () => {
    const r = elegirCandidato({ monto: 125.82 }, [cozumelA], TARJETAS);
    expect(r.gasto_id).toBe('g-cozumel-a');
    expect(r.criterio).toBe('MONTO_EXACTO');
    expect(r.motivo).toBeNull();
  });

  it('sin candidatos = SIN_CANDIDATOS', () => {
    const r = elegirCandidato({ monto: 125.82 }, [], TARJETAS);
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('SIN_CANDIDATOS');
  });

  it('los DOS cargos de $125.82 del 4-sep los desempata la tarjeta', () => {
    const r = elegirCandidato(
      {
        monto: 125.82,
        descripcion: 'AEROPUERTO DE COZUMEL',
        referencia: '9155656256',
      },
      [cozumelA, cozumelB],
      TARJETAS,
    );
    expect(r.gasto_id).toBe('g-cozumel-b');
    expect(r.criterio).toBe('TARJETA');
    expect(r.terminacion).toBe('6256');
  });

  it('sin tarjeta y con la MISMA descripción queda AMBIGUO (no se liga)', () => {
    const r = elegirCandidato(
      {
        monto: 125.82,
        descripcion: 'AEROPUERTO DE COZUMEL',
        referencia: '174465',
      },
      [cozumelA, cozumelB],
      TARJETAS,
    );
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('AMBIGUO');
    expect(r.candidatos_n).toBe(2);
  });

  it('la descripción desempata cuando solo uno se parece de verdad', () => {
    const r = elegirCandidato(
      { monto: 480, descripcion: 'ASUR CANCUN' },
      [
        { id: 'g-cun', monto: 480, lugar: 'Aeropuerto de Cancún' },
        { id: 'g-taco', monto: 480, lugar: 'Restaurante El Taco Loco' },
      ],
      TARJETAS,
    );
    expect(r.gasto_id).toBe('g-cun');
    expect(r.criterio).toBe('DESCRIPCION');
  });

  it('dos gastos igual de parecidos NO se desempatan por descripción', () => {
    const r = elegirCandidato(
      { monto: 480, descripcion: 'ASUR CANCUN' },
      [
        { id: 'g-1', monto: 480, lugar: 'Aeropuerto de Cancún' },
        { id: 'g-2', monto: 480, lugar: 'Aeropuerto de Cancún' },
      ],
      TARJETAS,
    );
    expect(r.gasto_id).toBeNull();
    expect(r.motivo).toBe('AMBIGUO');
  });

  it('conserva el criterio base cuando el cruce viene del FALTANTE', () => {
    const r = elegirCandidato({ monto: 100 }, [{ id: 'g', monto: 300 }], [], {
      criterioBase: 'FALTANTE',
    });
    expect(r.criterio).toBe('FALTANTE');
  });
});

describe('elegirMovimiento — camino inverso (gasto capturado después)', () => {
  const gasto: GastoCandidatoCruce = {
    id: 'g-1',
    monto: 125.82,
    tarjeta_terminacion: '0577',
    lugar: 'Aeropuerto de Cozumel',
  };

  it('un solo cargo pendiente = se liga', () => {
    const r = elegirMovimiento(gasto, [{ id: 'm-1', monto: 125.82 }], TARJETAS);
    expect(r.movimiento_id).toBe('m-1');
  });

  it('dos cargos iguales: gana el de la tarjeta del gasto', () => {
    const r = elegirMovimiento(
      gasto,
      [
        { id: 'm-1', monto: 125.82, referencia: '0025830577' },
        { id: 'm-2', monto: 125.82, referencia: '9155656256' },
      ],
      TARJETAS,
    );
    expect(r.movimiento_id).toBe('m-1');
    expect(r.criterio).toBe('TARJETA');
  });

  it('dos cargos sin nada que los distinga = ninguno', () => {
    const r = elegirMovimiento(
      gasto,
      [
        { id: 'm-1', monto: 125.82 },
        { id: 'm-2', monto: 125.82 },
      ],
      TARJETAS,
    );
    expect(r.movimiento_id).toBeNull();
  });
});

describe('patronTraspaso — los traspasos internos ya no son pendientes eternos', () => {
  it('reconoce la leyenda real del Scotiabank', () => {
    expect(patronTraspaso('SEL TRASPASO ENTRE CUENTAS')).toBe(
      'TRASPASO ENTRE CUENTAS',
    );
    expect(patronTraspaso('Traspaso entre cuentas propias')).toBe(
      'TRASPASO ENTRE CUENTAS',
    );
  });

  it('no clasifica de más', () => {
    expect(patronTraspaso('ASUR CANCUN')).toBeNull();
    expect(patronTraspaso(null)).toBeNull();
    expect(CLASIFICACION_TRASPASO).toBe('Traspaso entre cuentas');
  });
});

describe('montoCasa — tolerancia de centavos', () => {
  it('acepta un centavo de diferencia y rechaza más', () => {
    expect(montoCasa(125.82, 125.81)).toBe(true);
    expect(montoCasa(125.82, 125.83)).toBe(true);
    expect(montoCasa(125.82, 125.72)).toBe(false);
  });
});

describe('emparejarDuplicados — re-subir el mismo estado de cuenta', () => {
  const prev = [
    {
      fecha: '2026-09-08',
      tipo: 'CARGO',
      monto: 125.82,
      descripcion: 'AEROPUERTO DE COZUMEL',
      referencia: '9155656256',
    },
  ];

  it('el MISMO PDF con la descripción redactada distinta ya no se duplica', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'Aeropuerto Cozumel (TUA)',
          referencia: '9155656256',
        },
      ],
      prev,
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(0);
  });

  it('dos cargos idénticos con referencias DISTINTAS son dos movimientos', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'AEROPUERTO DE COZUMEL',
          referencia: '0025830577',
        },
      ],
      prev,
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('sin referencia sigue valiendo la descripción (comportamiento viejo)', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'ASA CANCUN',
          referencia: null,
        },
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'ASA CANCUN',
          referencia: null,
        },
      ],
      [
        {
          fecha: '2026-09-08',
          tipo: 'CARGO',
          monto: 125.82,
          descripcion: 'ASA CANCUN',
          referencia: null,
        },
      ],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('el multiconjunto cuenta repeticiones, no presencia', () => {
    const dos = [
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
    ];
    const r = emparejarDuplicados(dos, [dos[0]]);
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('claveBucket separa por día, tipo y monto', () => {
    expect(
      claveBucket({ fecha: '2026-09-08', tipo: 'CARGO', monto: '125.8' }),
    ).toBe('2026-09-08|CARGO|125.80');
  });
});

describe('ventanaDias', () => {
  it('±3 días alrededor de un DATE del banco', () => {
    expect(ventanaDias('2026-09-08', 3)).toEqual({
      desde: '2026-09-05',
      hasta: '2026-09-11',
    });
  });
});
