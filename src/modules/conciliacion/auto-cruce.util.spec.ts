import {
  CLASIFICACION_TRASPASO,
  claveBucket,
  descDedupe,
  descripcionesSeContradicen,
  elegirCandidato,
  elegirMovimiento,
  emparejarDuplicados,
  leyendasNombranDistinto,
  mismaDescripcionDedupe,
  montoCasa,
  nivelDescripcionDedupe,
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

  it('misma descripción con referencias DISTINTAS es el MISMO movimiento (la referencia de la IA no es estable)', () => {
    // Antes (≤ 0.0.41) la referencia distinta lo volvía «otro cargo» y cada
    // re-importación lo insertaba otra vez.
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
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(0);
  });

  it('dos cargos reales iguales: entra el segundo SOLO si el archivo trae dos y la base uno', () => {
    const linea = {
      fecha: '2026-09-08',
      tipo: 'CARGO',
      monto: 125.82,
      descripcion: 'AEROPUERTO DE COZUMEL',
    };
    const r = emparejarDuplicados(
      [
        { ...linea, referencia: '00000000000000000001' },
        { ...linea, referencia: '00000000000000000091' },
      ],
      prev,
    );
    expect(r.duplicados).toBe(1);
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

  it('las líneas del MISMO archivo nunca se deduplican entre sí', () => {
    const dos = [
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
      { fecha: '2026-09-08', tipo: 'CARGO', monto: 10, descripcion: 'X' },
    ];
    const r = emparejarDuplicados(dos, []);
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(2);
  });

  it('claveBucket separa por día, tipo y monto', () => {
    expect(
      claveBucket({ fecha: '2026-09-08', tipo: 'CARGO', monto: '125.8' }),
    ).toBe('2026-09-08|CARGO|125.80');
  });
});

/**
 * INCIDENTE 29-sep-2026 («se me están duplicando los gastos»): las lecturas
 * REALES de prod del Scotiabank GASTOS GNRAL / COMBUSTIBLE, en el orden en
 * que se importaron (8, 15, 22 y 29 de septiembre). Cada `importar` simula
 * una subida: dedupe contra lo que ya hay y se inserta el resto.
 */
describe('emparejarDuplicados — re-lecturas REALES de la IA (29-sep-2026)', () => {
  type Linea = {
    fecha: string;
    tipo: string;
    monto: number;
    descripcion: string | null;
    referencia: string | null;
  };
  function importar(base: Linea[], archivo: Linea[]): Linea[] {
    return [...base, ...emparejarDuplicados(archivo, base).aInsertar];
  }
  const cozumel = (referencia: string): Linea => ({
    fecha: '2026-09-07',
    tipo: 'CARGO',
    monto: 125.82,
    descripcion: 'AEROPUERTO DE COZUMEL',
    referencia,
  });

  it('AEROPUERTO DE COZUMEL $125.82: 5 filas en prod ⇒ 2 (los 2 cargos reales)', () => {
    // 8-sep: los DOS cargos reales del día, con la tarjeta de cada uno.
    let base = importar([], [cozumel('0025830585'), cozumel('0025830577')]);
    expect(base).toHaveLength(2);
    // 22-sep: la IA trae un consecutivo por línea.
    base = importar(base, [
      cozumel('00000000000000000001'),
      cozumel('00000000000000000091'),
    ]);
    expect(base).toHaveLength(2);
    // 29-sep: consecutivo + « AUT. 456529» pegado a la referencia.
    base = importar(base, [cozumel('00000000000000000001 AUT. 456529')]);
    expect(base).toHaveLength(2);
  });

  it('REST HOTEL ZOMAY HOLBOX / «HOLBO» truncado: 3 filas en prod ⇒ 1', () => {
    const zomay = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-01',
      tipo: 'CARGO',
      monto: 455,
      descripcion,
      referencia,
    });
    let base = importar([], [zomay('REST HOTEL ZOMAY HOLBOX', '0025830585')]);
    base = importar(base, [zomay('REST HOTEL ZOMAY HOLBO', '955628')]);
    base = importar(base, [
      zomay('REST HOTEL ZOMAY HOLBO', '00000000732130325373'),
    ]);
    expect(base).toHaveLength(1);
  });

  it('SEL TRASPASO ENTRE CUENTAS $14,573.23: 3 filas en prod ⇒ 1', () => {
    const traspaso = (referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'ABONO',
      monto: 14573.23,
      descripcion: 'SEL TRASPASO ENTRE CUENTAS',
      referencia,
    });
    let base = importar([], [traspaso('000136717217')]);
    base = importar(base, [traspaso('00000000006251021753')]);
    base = importar(base, [traspaso('00000000062510217531 000136717217')]);
    expect(base).toHaveLength(1);
  });

  it('COMBUSTIBLE: «ASA CANCUN» vs «ASA CANCUN\\CARR CANCUN» con « REF. … AUT. …» es la misma carga', () => {
    const base: Linea[] = [
      {
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 4920.55,
        descripcion: 'ASA CANCUN',
        referencia: '00000000011305556780',
      },
      {
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 3572.85,
        descripcion: 'ASA CANCUN I',
        referencia: '00000000732144020298',
      },
    ];
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 4920.55,
          descripcion: 'ASA CANCUN\\CARR CANCUN',
          referencia: '00000000011305556780 REF. 9156174929 AUT. 404528',
        },
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 3572.85,
          descripcion: 'ASA CANCUN I\\CARR CANC',
          referencia: '00000000732144020298 REF. 9156174929 AUT. 583248',
        },
      ],
      base,
    );
    expect(r.duplicados).toBe(2);
    expect(r.aInsertar).toHaveLength(0);
  });

  it('tarjeta repetida «0025830577»: la MISMA referencia no junta comercios distintos', () => {
    const base: Linea[] = [
      {
        fecha: '2026-09-07',
        tipo: 'CARGO',
        monto: 150,
        descripcion: 'UBER TRIP',
        referencia: '0025830577',
      },
    ];
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 150,
          descripcion: 'OXXO CISNE',
          referencia: '0025830577',
        },
      ],
      base,
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('UBER vs OXXO por $150 el mismo día (referencias distintas) son dos movimientos', () => {
    const r = emparejarDuplicados(
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 150,
          descripcion: 'OXXO CISNE',
          referencia: '00000000000000000002',
        },
      ],
      [
        {
          fecha: '2026-09-07',
          tipo: 'CARGO',
          monto: 150,
          descripcion: 'MERPAGO*UBER',
          referencia: '00000000000000000001',
        },
      ],
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(1);
  });

  it('los 7 abonos «CARGO INDEBIDO 21 SEP 355xx» con la MISMA referencia: re-subirlos no duplica y el 8.º real sí entra', () => {
    const indebido = (n: number): Linea => ({
      fecha: '2026-09-23',
      tipo: 'ABONO',
      monto: 825.13,
      descripcion: `CARGO INDEBIDO 21 SEP ${n}`,
      referencia: '00000000001303268115',
    });
    const siete = [35555, 35564, 35552, 35578, 35579, 35572, 35554];
    const base = importar([], siete.map(indebido));
    expect(base).toHaveLength(7);
    expect(importar(base, siete.map(indebido))).toHaveLength(7);
    expect(importar(base, [...siete, 35580].map(indebido))).toHaveLength(8);
  });

  it('DIDI: dos viajes de $101 el mismo día en el MISMO archivo entran los dos; re-subirlos no duplica', () => {
    const didi = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-08',
      tipo: 'CARGO',
      monto: 101,
      descripcion,
      referencia,
    });
    const archivo = [
      didi(
        'DLO*DIDI RIDES\\GENERAL',
        '00000000287142887037 REF. 9156174929 AUT. 198976',
      ),
      didi(
        'DLO DIDI RIDES MX\\\\CIU',
        '00000000625115012031 REF. 9156174929 AUT. 085488',
      ),
    ];
    const base = importar([], archivo);
    expect(base).toHaveLength(2);
    expect(importar(base, archivo)).toHaveLength(2);
  });

  it('la pareja EXACTA gana a la tolerante: entra la línea nueva, no la repetida', () => {
    const spei = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-10',
      tipo: 'CARGO',
      monto: 1500,
      descripcion,
      referencia,
    });
    const r = emparejarDuplicados(
      [
        // «TRANSFERENCI…» comparte 12 caracteres con la de Juan, pero la de
        // Juan tiene su pareja EXACTA: la de Pedro es la nueva.
        spei('TRANSFERENCIA A PEDRO LOPEZ', '00000000000000000001'),
        spei('TRANSFERENCIA A JUAN PEREZ', '00000000000000000002'),
      ],
      [spei('TRANSFERENCIA A JUAN PEREZ', '000125473315')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar.map((l) => l.descripcion)).toEqual([
      'TRANSFERENCIA A PEDRO LOPEZ',
    ]);
  });

  it('COMBUSTIBLE: «ASA CANCUN» y «ASA CANCUN I» con el MISMO monto el mismo día — el orden del archivo no deja una carga duplicada', () => {
    // «ASA CANCUN I\CARR CANC» empata por prefijo con las DOS filas previas
    // («ASA CANCUN» ⊂ …) y «ASA CANCUN\CARR CANCUN» solo con «ASA CANCUN».
    // Tomar «el primero que encuentre» le robaba la fila y la segunda carga
    // se insertaba otra vez; el emparejamiento máximo las acomoda a las dos.
    const carga = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: 2995.26,
      descripcion,
      referencia,
    });
    const base = [
      carga('ASA CANCUN', '00000000011300318335'),
      carga('ASA CANCUN I', '00000000732139436897'),
    ];
    const archivo = [
      carga(
        'ASA CANCUN I\\CARR CANC',
        '00000000732139436897 REF. 9156174929 AUT. 543086',
      ),
      carga(
        'ASA CANCUN\\CARR CANCUN',
        '00000000011300318335 REF. 9156174929 AUT. 618872',
      ),
    ];
    expect(emparejarDuplicados(archivo, base).duplicados).toBe(2);
    expect(emparejarDuplicados([...archivo].reverse(), base).duplicados).toBe(
      2,
    );
  });

  it('la pareja por PREFIJO gana a la de «mismo inicio»: entra la línea nueva, no la truncada', () => {
    const hotel = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-01',
      tipo: 'CARGO',
      monto: 455,
      descripcion,
      referencia,
    });
    const r = emparejarDuplicados(
      [
        // Comparte «REST HOTEL Z» con ZOMAY, pero ZOMAY tiene su pareja
        // truncada («HOLBO» ⊂ «HOLBOX»): ZAZIL es el cargo nuevo.
        hotel('REST HOTEL ZAZIL HA', '00000000000000000001'),
        hotel('REST HOTEL ZOMAY HOLBO', '00000000000000000002'),
      ],
      [hotel('REST HOTEL ZOMAY HOLBOX', '0025830585')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar.map((l) => l.descripcion)).toEqual([
      'REST HOTEL ZAZIL HA',
    ]);
  });

  it('plazas distintas por el mismo monto NO se confunden (ni por 12 caracteres ni por la MISMA tarjeta)', () => {
    const tua = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: 125.82,
      descripcion,
      referencia,
    });
    expect(
      emparejarDuplicados(
        [tua('AEROPUERTO DE CANCUN', '00000000000000000002')],
        [tua('AEROPUERTO DE COZUMEL', '00000000000000000001')],
      ).duplicados,
    ).toBe(0);
    expect(
      emparejarDuplicados(
        [tua('ASUR MERIDA', '0025830577')],
        [tua('ASUR CANCUN', '0025830577')],
      ).duplicados,
    ).toBe(0);
  });

  it('«CARGO INDEBIDO 21 SEP 35552» no se absorbe en el 35554 (números distintos)', () => {
    const indebido = (n: number, referencia: string): Linea => ({
      fecha: '2026-09-23',
      tipo: 'ABONO',
      monto: 825.13,
      descripcion: `CARGO INDEBIDO 21 SEP ${n}`,
      referencia,
    });
    expect(
      emparejarDuplicados(
        [indebido(35552, '00000000000000000002')],
        [indebido(35554, '00000000000000000001')],
      ).duplicados,
    ).toBe(0);
    // Con la MISMA referencia tampoco: el número manda sobre la referencia.
    expect(
      emparejarDuplicados(
        [indebido(35552, '00000000001303268115')],
        [indebido(35554, '00000000001303268115')],
      ).duplicados,
    ).toBe(0);
  });

  it('«ASUR» (marca sola) no es prefijo de «ASUR CANCUN»; solo la MISMA referencia los junta', () => {
    const asur = (descripcion: string, referencia: string): Linea => ({
      fecha: '2026-09-07',
      tipo: 'CARGO',
      monto: 212,
      descripcion,
      referencia,
    });
    expect(
      emparejarDuplicados(
        [asur('ASUR CANCUN', '00000000000000000002')],
        [asur('ASUR', '00000000000000000001')],
      ).duplicados,
    ).toBe(0);
    expect(
      emparejarDuplicados(
        [asur('ASUR CANCUN', '0025830577')],
        [asur('ASUR', '0025830577')],
      ).duplicados,
    ).toBe(1);
  });

  it('una fila previa se usa UNA sola vez: tres líneas iguales contra una previa ⇒ entran dos', () => {
    const r = emparejarDuplicados(
      [
        cozumel('00000000000000000001'),
        cozumel('00000000000000000002'),
        cozumel('00000000000000000003'),
      ],
      [cozumel('0025830577')],
    );
    expect(r.duplicados).toBe(1);
    expect(r.aInsertar).toHaveLength(2);
  });

  it('otro día, otro tipo u otro monto nunca es duplicado', () => {
    const base = [cozumel('0025830577')];
    const r = emparejarDuplicados(
      [
        { ...cozumel('0025830577'), fecha: '2026-09-08' },
        { ...cozumel('0025830577'), tipo: 'ABONO' },
        { ...cozumel('0025830577'), monto: 125.83 },
      ],
      base,
    );
    expect(r.duplicados).toBe(0);
    expect(r.aInsertar).toHaveLength(3);
  });
});

describe('mismaDescripcionDedupe / descripcionesSeContradicen', () => {
  it('normaliza acentos, mayúsculas, signos, espacios y prefijos de agregador', () => {
    expect(descDedupe('  Café  del   Aeropuerto. ')).toBe(
      'CAFE DEL AEROPUERTO',
    );
    expect(mismaDescripcionDedupe('MERPAGO*UBER', 'UBER')).toBe(true);
    expect(
      mismaDescripcionDedupe('Aeropuerto de Cozumel', 'AEROPUERTO DE COZUMEL'),
    ).toBe(true);
    expect(mismaDescripcionDedupe(null, '')).toBe(true);
  });

  it('prefijo: el lado corto debe tener ≥ 8 caracteres', () => {
    expect(
      mismaDescripcionDedupe(
        'REST HOTEL ZOMAY HOLBO',
        'REST HOTEL ZOMAY HOLBOX',
      ),
    ).toBe(true);
    expect(mismaDescripcionDedupe('OXXO Cisne', 'OXXO CISNE TLAQUEPAQUE')).toBe(
      true,
    );
    // «UBER» (4) no alcanza: una palabra corta no hace la misma línea.
    expect(mismaDescripcionDedupe('UBER', 'UBER EATS')).toBe(false);
    expect(mismaDescripcionDedupe('', 'ASA CANCUN')).toBe(false);
  });

  it('nivelDescripcionDedupe: 0 iguales, 1 prefijo, 2 mismo inicio, null distintas', () => {
    expect(nivelDescripcionDedupe('ASUR Cancún', 'ASUR CANCUN')).toBe(0);
    expect(
      nivelDescripcionDedupe('ASA CANCUN', 'ASA CANCUN\\CARR CANCUN'),
    ).toBe(1);
    expect(
      nivelDescripcionDedupe(
        'ASUR CANCUN\\\\CANCUN QR',
        'ASUR CANCUN CANCUN Q.ROO',
      ),
    ).toBe(2);
    expect(nivelDescripcionDedupe('UBER TRIP', 'OXXO CISNE')).toBeNull();
  });

  it('leyendasNombranDistinto: plazas o números distintos; truncado y «sin plaza» no cuentan', () => {
    expect(
      leyendasNombranDistinto('AEROPUERTO DE CANCUN', 'AEROPUERTO DE COZUMEL'),
    ).toBe(true);
    expect(leyendasNombranDistinto('ASUR CUN', 'ASUR CANCUN')).toBe(false);
    expect(
      leyendasNombranDistinto(
        'CARGO INDEBIDO 21 SEP 35554',
        'CARGO INDEBIDO 21 SEP 35552',
      ),
    ).toBe(true);
    expect(
      leyendasNombranDistinto(
        'CARGO INDEBIDO 21 SEP 355',
        'CARGO INDEBIDO 21 SEP 35554',
      ),
    ).toBe(false);
    expect(leyendasNombranDistinto('ASA CANCUN', 'ASA COMBUSTIBLE')).toBe(
      false,
    );
    expect(leyendasNombranDistinto(null, 'ASUR MERIDA')).toBe(false);
  });

  it('comparten los primeros 12 caracteres', () => {
    expect(
      mismaDescripcionDedupe(
        'DLO DIDI RIDES MX\\\\CIU',
        'DLO*DIDI RIDES\\GENERAL',
      ),
    ).toBe(true);
    expect(mismaDescripcionDedupe('ASA CANCUN', 'ASA MERIDA')).toBe(false);
    // 12 caracteres en común pero plazas distintas.
    expect(
      mismaDescripcionDedupe('AEROPUERTO DE CANCUN', 'AEROPUERTO DE COZUMEL'),
    ).toBe(false);
    expect(mismaDescripcionDedupe('AUTOZONE 7226', 'AUTOZONE 7227')).toBe(
      false,
    );
    expect(mismaDescripcionDedupe('UBER TRIP', 'OXXO CISNE')).toBe(false);
  });

  it('se contradicen solo si las dos traen texto y no comparten ningún token', () => {
    expect(descripcionesSeContradicen('UBER TRIP', 'OXXO CISNE')).toBe(true);
    // Comparten «ASUR» pero son plazas distintas (la tarjeta no las junta).
    expect(descripcionesSeContradicen('ASUR CANCUN', 'ASUR MERIDA')).toBe(true);
    expect(
      descripcionesSeContradicen(
        'AEROPUERTO DE COZUMEL',
        'Aeropuerto Cozumel (TUA)',
      ),
    ).toBe(false);
    expect(descripcionesSeContradicen(null, 'OXXO')).toBe(false);
    expect(descripcionesSeContradicen('REST HOTEL ZOMAY HOLBO', 'X')).toBe(
      false,
    );
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
